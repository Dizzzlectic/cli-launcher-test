/* eslint-disable no-console, n/no-unsupported-features/node-builtins, security/detect-non-literal-fs-filename */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

/**
 * Known self-managed files the launcher may update.
 */
const APP_NAME = 'launcher.js';
const CONFIG_NAME = 'config.ini';
const TARGETS = [
  { type: 'launcher', filename: APP_NAME },
  { type: 'config', filename: CONFIG_NAME },
];

/**
 * @typedef {Object} ManifestFile
 * @property {string} path - File path in the manifest.
 * @property {string} hash - Expected hex digest for the file contents.
 *
 * @typedef {Object} Manifest
 * @property {ManifestFile[]} files - All tracked files.
 *
 * @typedef {Object} UpdateItem
 * @property {ManifestFile} entry - Matched manifest entry.
 * @property {string} path - Local filesystem path to update.
 * @property {('launcher'|'config')} type - Update target type.
 */

/**
 * Handles updating the launcher binary and its config using entries from the manifest.
 * - Detects whether the local copy differs by comparing content hashes.
 * - Downloads replacements atomically (config) or stages them for restart (launcher).
 */
export default class SelfUpdater {
  /**
   * @param {object} [progressDisplay] - Optional progress logger.
   * Supported methods used if present: `log(message)`, `startFileDownload(filename)`,
   * `updateFileProgress(percent, filename)`, and `finishFileDownload()`.
   */
  constructor(progressDisplay) {
    /** @private */
    this.needsRestartFlag = false;
    /** @private */
    this.progress = progressDisplay || null;
  }

  // ------------------------
  // Logging helpers
  // ------------------------
  /**
   * Write a standard log line via ProgressDisplay if available, else console.
   * @param {string} message - Text to output on its own line.
   */
  report(message) {
    if (this.progress && typeof this.progress.log === 'function') {
      this.progress.log(message);
    } else {
      console.log(message);
    }
  }

  /**
   * Write an inline update using stdout when a richer progress API is unavailable.
   * @param {string} text - Text to write without a trailing newline.
   */
  reportInline(text) {
    if (typeof process !== 'undefined' && process.stdout && typeof process.stdout.write === 'function') {
      process.stdout.write(text);
    } else {
      console.log(text);
    }
  }

  /**
   * Write an error line. Falls back to standard logging if a dedicated error channel is missing.
   * @param {string} message - Error text to output.
   */
  reportError(message) {
    if (this.progress && typeof this.progress.log === 'function') {
      this.progress.log(message);
    } else {
      console.error(message);
    }
  }

  /**
   * Determine which self-managed files need an update by comparing hashes.
   * @param {Manifest} manifest - Parsed manifest with file list.
   * @param {NodeJS.HashAlgorithm} hashAlgorithm - Algorithm used to hash local files (e.g. 'sha256').
   * @returns {Promise<UpdateItem[]>} Items that require download or replacement.
   */
  async checkForUpdates(manifest, hashAlgorithm) {
    const files = manifest?.files ?? [];

    const planned = await Promise.all(
      TARGETS.map(async ({ type, filename }) => {
        const entry = files.find((f) => f.path === filename);
        if (!entry) return null; // Not present in manifest

        const localPath = filename; // literal path, no dynamic indexing
        const needsUpdate = await this.fileNeedsUpdate(localPath, entry.hash, hashAlgorithm);
        return needsUpdate ? { entry, path: localPath, type } : null;
      })
    );

    return planned.filter(Boolean);
  }

  /**
   * Check if a local file is missing or has a mismatching content hash.
   * @param {string} filePath - Path to the local file.
   * @param {string} expectedHash - Expected hex digest from the manifest.
   * @param {NodeJS.HashAlgorithm} hashAlgorithm - Hash algorithm for computing the local digest.
   * @returns {Promise<boolean>} True if the file must be updated.
   */
  async fileNeedsUpdate(filePath, expectedHash, hashAlgorithm) {
    if (!existsSync(filePath)) {
      return true; // Missing file needs update
    }

    try {
      const currentHash = await this.computeFileHash(filePath, hashAlgorithm);
      return currentHash !== expectedHash;
    } catch {
      // If the file can't be read or hashed, treat it as out of date.
      return true;
    }
  }

  /**
   * Compute a hex digest of a file using the given algorithm.
   * @param {string} filePath - Path to the file to hash.
   * @param {NodeJS.HashAlgorithm} algorithm - Hash algorithm (e.g. 'sha256').
   * @returns {Promise<string>} Lowercase hex digest.
   */
  computeFileHash(filePath, algorithm) {
    return new Promise((resolve, reject) => {
      const hash = createHash(algorithm);
      const stream = createReadStream(filePath);

      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Download and apply updates for the given targets.
   * - Launcher is staged to <file>.new and requires a restart to take effect.
   * - Config is replaced atomically with a backup.
   * @param {UpdateItem[]} updates - Planned updates from {@link checkForUpdates}.
   * @param {string} baseUrl - CDN base URL from the manifest (must include trailing slash if required).
   * @param {number} timeoutMs - Per-download timeout in milliseconds.
   * @param {NodeJS.HashAlgorithm} [hashAlgorithm='sha256'] - Algorithm used to verify downloaded content.
   * @returns {Promise<void>} Resolves when all downloads have either succeeded or failed.
   */
  async performUpdates(updates, baseUrl, timeoutMs, hashAlgorithm = 'sha256') {
    if (!updates.length) return;

    this.report(`Updating ${updates.length} system file(s)...`);

    await Promise.all(
      updates.map(async ({ entry, path, type }) => {
        const fileUrl = `${baseUrl}${entry.path}`;
        const tempPath = `${path}.new`;

        const hasFileProgress = Boolean(
          this.progress &&
            typeof this.progress.startFileDownload === 'function' &&
            typeof this.progress.updateFileProgress === 'function' &&
            typeof this.progress.finishFileDownload === 'function'
        );

        if (hasFileProgress) {
          this.progress.startFileDownload(entry.path);
        } else {
          this.report(`Downloading ${type}: ${entry.path}`);
        }

        try {
          await this.downloadFile(fileUrl, tempPath, {
            expectedHash: entry.hash,
            timeoutMs,
            hashAlgorithm,
            onProgress: (percentage) => {
              if (hasFileProgress) {
                this.progress.updateFileProgress(percentage, entry.path);
                return;
              }
              if (percentage % 25 === 0) {
                this.reportInline(`
  Progress: ${percentage}%`);
              }
            },
          });

          if (hasFileProgress) {
            this.progress.finishFileDownload();
          } else {
            this.report(''); // New line after inline progress
          }

          if (type === 'launcher') {
            this.needsRestartFlag = true;
            this.report(`✓ Staged launcher update -> ${tempPath}`);
          } else {
            await this.atomicReplace(path, tempPath);
            this.report(`✓ Updated ${type}: ${entry.path}`);
          }
        } catch (error) {
          this.reportError(`❌ Failed to update ${type}: ${error.message}`);
          // Best-effort cleanup of any partial file.
          try {
            await unlink(tempPath);
          } catch {}
        }
      })
    );
  }

  /**
   * Download a file to disk with optional hash verification and basic progress reporting.
   * @param {string} url - Absolute URL to download.
   * @param {string} outputPath - Destination path on disk.
   * @param {Object} options - Extra download options.
   * @param {string} [options.expectedHash] - Optional expected hex digest to verify.
   * @param {number} options.timeoutMs - Abort the request after this many milliseconds.
   * @param {(percent:number)=>void} [options.onProgress] - Called with 0–100 as bytes stream in.
   * @param {NodeJS.HashAlgorithm} [options.hashAlgorithm='sha256'] - Algorithm used for verification.
   * @returns {Promise<void>} Resolves when the file is fully written and verified.
   */
  async downloadFile(url, outputPath, { expectedHash, timeoutMs, onProgress, hashAlgorithm = 'sha256' }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const total = parseInt(response.headers.get('content-length') || '0', 10);
      const readable = this.normalizeStream(response.body);
      if (!readable) throw new Error('Response body is not readable');

      // Track progress when total length is known.
      if (total > 0 && onProgress) {
        let downloaded = 0;
        readable.on('data', (chunk) => {
          downloaded += chunk.length;
          const percentage = Math.round((downloaded / total) * 100);
          onProgress(Math.max(0, Math.min(100, percentage)));
        });
      }

      // Pipe to disk and wait for completion.
      const writeStream = createWriteStream(outputPath);
      readable.pipe(writeStream);
      await finished(writeStream);

      // Optional integrity check.
      if (expectedHash) {
        const actualHash = await this.computeFileHash(outputPath, hashAlgorithm);
        if (actualHash !== expectedHash) {
          throw new Error(`Hash mismatch. Expected ${expectedHash}, got ${actualHash}`);
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Normalize a Web/Fetch stream or Node stream into a Node Readable.
   * @param {unknown} body - Response body from fetch.
   * @returns {Readable|null} A readable stream, or null if not supported.
   */
  normalizeStream(body) {
    if (!body) return null;

    // Web Streams API
    if (typeof body.getReader === 'function') {
      if (typeof Readable.fromWeb === 'function') {
        return Readable.fromWeb(body);
      }

      // Fallback for older Node.js versions: wrap an async iterator.
      const reader = body.getReader();
      const iterator = {
        next() {
          return reader.read();
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      return Readable.from(iterator);
    }

    // Node.js streams
    if (typeof body.on === 'function') {
      return body;
    }

    return null;
  }

  /**
   * Replace a file atomically by renaming a staged copy into place.
   * Creates/refreshes a <file>.bak backup of the previous version.
   * @param {string} originalPath - Path to replace.
   * @param {string} newPath - Staged file to promote.
   * @returns {Promise<void>} Resolves after the swap completes.
   */
  async atomicReplace(originalPath, newPath) {
    const backupPath = `${originalPath}.bak`;

    // Remove old backup if present (ignore errors).
    try {
      await unlink(backupPath);
    } catch {}

    // Move original to backup if present (ignore errors on missing file).
    try {
      await rename(originalPath, backupPath);
    } catch {}

    // Promote new file into place.
    await rename(newPath, originalPath);
  }

  /**
   * Whether a restart is required to apply a staged launcher update.
   * @returns {boolean} True if the launcher binary was updated.
   */
  needsRestart() {
    return this.needsRestartFlag;
  }
}
