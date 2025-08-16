/* eslint-disable n/no-unsupported-features/node-builtins, security/detect-non-literal-fs-filename */
import fg from 'fast-glob';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

/**
 * File patterns to ignore when scanning for files.
 * >> Modify here to change ignore rules globally. <<
 */
const IGNORE_PATTERNS = ['node_modules/**', '.git/**', '*.log', '*.tmp', '*.bak', '*.new', 'private-key.pem'];

/**
 * Handles file scanning, hashing, comparison, and downloading
 * within a fixed root directory, with safety checks to prevent path traversal.
 */
export default class FileManager {
  /**
   * @param {object} progressDisplay - Logger with a `.log(message)` method for status messages.
   * @param {object} [options] - Optional settings.
   * @param {string} [options.rootDir=process.cwd()] - Base directory for all file operations.
   * @param {number} [options.concurrency=4] - Number of parallel download chunks.
   */
  constructor(progressDisplay, { rootDir = process.cwd(), concurrency = 4 } = {}) {
    this.progress = progressDisplay;
    this.rootDir = resolve(rootDir);
    this.concurrency = Math.max(1, concurrency);
  }

  /**
   * Converts a relative path to an absolute path under rootDir and validates it.
   * @param {string} relPath - Path relative to the root directory.
   * @returns {string} Absolute path inside rootDir.
   * @throws {Error} If the path attempts to escape rootDir.
   */
  toSafeAbsPath(relPath) {
    const abs = resolve(this.rootDir, relPath);
    const prefix = this.rootDir.endsWith(sep) ? this.rootDir : this.rootDir + sep;
    if (abs !== this.rootDir && !abs.startsWith(prefix)) {
      throw new Error(`Unsafe path: ${relPath}`);
    }
    return abs;
  }

  /**
   * Scans all files in rootDir and returns their hashes.
   * @param {"sha256"|"sha1"|"md5"} [hashAlgorithm="sha256"] - Hash algorithm to use.
   * @returns {Promise<Array<{path:string, hash:string}>>} List of relative paths with computed hashes.
   */
  async scanFiles(hashAlgorithm = 'sha256') {
    const entries = await this.getFileEntries();
    const results = await Promise.all(
      entries.map(async (relPath) => {
        try {
          const abs = this.toSafeAbsPath(relPath);
          const hash = await this.computeFileHash(abs, hashAlgorithm);
          return { path: relPath.replace(/\\/g, '/'), hash };
        } catch {
          return null;
        }
      })
    );
    return results.filter(Boolean);
  }

  /**
   * Scans files sequentially and reports progress after each file.
   * @param {"sha256"|"sha1"|"md5"} [hashAlgorithm="sha256"] - Hash algorithm to use.
   * @param {(completed:number)=>void} onProgress - Called with number of files processed so far.
   * @returns {Promise<Array<{path:string, hash:string}>>} List of relative paths with computed hashes.
   */
  async scanWithProgress(hashAlgorithm = 'sha256', onProgress) {
    const entries = await this.getFileEntries();
    const start = { results: [], completed: 0 };
    const { results } = await entries.reduce(async (prevPromise, relPath) => {
      const state = await prevPromise;
      try {
        const abs = this.toSafeAbsPath(relPath);
        const hash = await this.computeFileHash(abs, hashAlgorithm);
        state.results.push({ path: relPath.replace(/\\/g, '/'), hash });
      } catch {
        // ignore unreadable files
      }
      state.completed += 1;
      if (onProgress) onProgress(state.completed);
      return state;
    }, Promise.resolve(start));
    return results;
  }

  /**
   * Lists all files under rootDir (relative paths only).
   * @returns {Promise<string[]>} Array of relative file paths.
   */
  getFileEntries() {
    return fg('**/*', {
      cwd: this.rootDir,
      onlyFiles: true,
      absolute: false,
      dot: false,
      ignore: IGNORE_PATTERNS,
    });
  }

  /**
   * Calculates the cryptographic hash of a file.
   * @param {string} absPath - Absolute path to the file.
   * @param {"sha256"|"sha1"|"md5"} algorithm - Hash algorithm to use.
   * @returns {Promise<string>} Hexadecimal hash of the file contents.
   */
  computeFileHash(absPath, algorithm) {
    return new Promise((resolvePromise, reject) => {
      const hash = createHash(algorithm);
      const stream = createReadStream(absPath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolvePromise(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Compares manifest files with local files to find missing or outdated ones.
   * @param {Array<{path:string, hash:string}>} manifestFiles - File list from manifest.
   * @param {Array<{path:string, hash:string}>} localFiles - Locally scanned files.
   * @returns {Array<{path:string, hash:string, status:"missing"|"outdated"}>} Files that require download/update.
   */
  findUpdates(manifestFiles, localFiles) {
    const localMap = new Map(localFiles.map((f) => [f.path, f.hash]));
    const out = [];
    for (const mf of manifestFiles) {
      const localHash = localMap.get(mf.path);
      if (!localHash) out.push({ ...mf, status: 'missing' });
      else if (localHash !== mf.hash) out.push({ ...mf, status: 'outdated' });
    }
    return out;
  }

  /**
   * Downloads multiple files in parallel chunks with optional progress callbacks.
   * @param {Array<{path:string, hash:string}>} updates - Files to download.
   * @param {string} baseUrl - Base URL for all files.
   * @param {number} timeoutMs - Timeout for each file in milliseconds.
   * @param {object} callbacks - Progress and event callbacks.
   * @param {(count:number)=>void} [callbacks.onOverallProgress] - Called after each file completes.
   * @param {(path:string)=>void} [callbacks.onFileStart] - Called when a file download begins.
   * @param {(pct:number, path:string)=>void} [callbacks.onFileProgress] - Called with download percentage.
   * @param {()=>void} [callbacks.onFileComplete] - Called when a file finishes downloading.
   * @returns {Promise<void>} Resolves when all downloads complete.
   */
  async downloadUpdates(updates, baseUrl, timeoutMs, callbacks) {
    let completed = 0;
    const { onOverallProgress, onFileStart, onFileProgress, onFileComplete } = callbacks;

    const chunkSize = Math.ceil(updates.length / this.concurrency) || 1;
    const chunks = this.chunkArray(updates, chunkSize);

    await Promise.all(
      chunks.map((chunk) =>
        this.processChunk(chunk, baseUrl, timeoutMs, {
          onFileStart,
          onFileProgress,
          onFileComplete: () => {
            onFileComplete?.();
            completed += 1;
            onOverallProgress?.(completed);
          },
        })
      )
    );
  }

  /**
   * Processes a chunk of files sequentially, downloading each.
   * @param {Array<{path:string, hash:string}>} chunk - Files to download in this chunk.
   * @param {string} baseUrl - Base URL for files.
   * @param {number} timeoutMs - Timeout for each file in milliseconds.
   * @param {object} callbacks - Event callbacks.
   * @param {(path:string)=>void} [callbacks.onFileStart] - Called when a file starts downloading.
   * @param {(pct:number, path:string)=>void} [callbacks.onFileProgress] - Download progress callback.
   * @param {()=>void} [callbacks.onFileComplete] - Called when a file finishes downloading.
   * @returns {Promise<void>} Resolves when all files in the chunk have been processed.
   */
  async processChunk(chunk, baseUrl, timeoutMs, callbacks) {
    const { onFileStart, onFileProgress, onFileComplete } = callbacks;
    await chunk.reduce(async (prev, file) => {
      await prev;
      const url = `${baseUrl}${file.path}`;
      const absOut = this.toSafeAbsPath(file.path);
      try {
        onFileStart?.(file.path);
        await this.downloadFile(url, absOut, {
          expectedHash: file.hash,
          timeoutMs,
          onProgress: (pct) => onFileProgress?.(pct, file.path),
        });
        onFileComplete?.();
      } catch (err) {
        this.progress?.log?.(`❌ Failed to update ${file.path}: ${err.message}`);
        onFileComplete?.();
      }
    }, Promise.resolve());
  }

  /**
   * Downloads a single file and verifies its hash if provided.
   * @param {string} url - Full URL to the file.
   * @param {string} absOutputPath - Absolute local path to save the file to.
   * @param {object} options - Download options.
   * @param {string} [options.expectedHash] - Expected SHA-256 hash to verify.
   * @param {number} options.timeoutMs - Timeout in milliseconds.
   * @param {(pct:number)=>void} [options.onProgress] - Called with download percentage.
   * @returns {Promise<void>} Resolves when the file is downloaded and verified.
   */
  async downloadFile(url, absOutputPath, { expectedHash, timeoutMs, onProgress }) {
    await mkdir(dirname(absOutputPath), { recursive: true });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      const total = parseInt(res.headers.get('content-length') || '0', 10);
      const readable = this.normalizeStream(res.body);
      if (!readable) throw new Error('No readable response body');

      if (total > 0 && onProgress) this.attachProgressTracking(readable, total, onProgress);

      const ws = createWriteStream(absOutputPath);
      readable.pipe(ws);
      await finished(ws);

      if (expectedHash) {
        const got = await this.computeFileHash(absOutputPath, 'sha256');
        if (got !== expectedHash) throw new Error(`Hash mismatch: expected ${expectedHash}, got ${got}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Converts a web or Node.js stream into a Node.js Readable stream.
   * @param {any} body - Stream-like object (e.g., fetch Response body).
   * @returns {import('node:stream').Readable|null} Readable stream or null if unsupported.
   */
  normalizeStream(body) {
    if (!body) return null;

    if (typeof body.getReader === 'function') {
      if (typeof Readable.fromWeb === 'function') return Readable.fromWeb(body);
      const reader = body.getReader();
      const iterator = {
        next: () => reader.read(),
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      return Readable.from(iterator);
    }

    if (typeof body.on === 'function') return body;

    return null;
  }

  /**
   * Attaches a progress callback to a readable stream based on bytes read.
   * @param {import('node:stream').Readable} readable - The stream being read.
   * @param {number} total - Total bytes expected.
   * @param {(pct:number)=>void} onProgress - Called with percentage complete (0–100).
   * @returns {void}
   */
  attachProgressTracking(readable, total, onProgress) {
    let downloaded = 0;
    readable.on('data', (chunk) => {
      downloaded += chunk.length;
      const pct = Math.round((downloaded / total) * 100);
      onProgress(Math.min(100, Math.max(0, pct)));
    });
  }

  /**
   * Splits an array into evenly sized chunks.
   * @param {Array} array - Array to split.
   * @param {number} size - Items per chunk.
   * @returns {Array[]} Array of chunk arrays.
   */
  chunkArray(array, size) {
    const out = [];
    for (let i = 0; i < array.length; i += size) {
      out.push(array.slice(i, i + size));
    }
    return out;
  }
}
