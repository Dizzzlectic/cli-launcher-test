/* eslint-disable n/no-process-exit */
import { spawn } from 'node:child_process';

import ConfigManager from './config-manager.js';
import FileManager from './file-manager.js';
import ManifestHandler from './manifest-handler.js';
import SelfUpdater from './self-updater.js';

const MAX_PREVIEW = 5;
const INTEGRITY_WHITELIST = new Set([
  'launcher.js',
  'launcher.js.new',
  'launcher.js.bak',
  'config.ini',
  'public-key.pem',
  'private-key.pem',
  'version.txt',
  'generate.log',
  '.patcherignore',
]);

/**
 * Orchestrates configuration, manifest verification, self-updates, and content patching.
 */
export default class LauncherCore {
  /**
   * @param {object} progressDisplay
   * Display hooks used to report progress and status.
   * Expected methods:
   * - log(message: string): void
   * - startVerification(total: number): void
   * - updateVerification(done: number): void
   * - finishVerification(): void
   * - startPatching(total: number): void
   * - updatePatching(done: number): void
   * - startFileDownload(filename: string): void
   * - updateFileProgress(percentage: number, filename: string): void
   * - finishFileDownload(): void
   * - finishPatching(): void
   * - cleanup(): void
   */
  constructor(progressDisplay) {
    this.progress = progressDisplay;
    this.config = new ConfigManager();
    this.manifest = new ManifestHandler();
    this.fileManager = new FileManager(progressDisplay);
    this.selfUpdater = new SelfUpdater(this.progress);
    this.needsRestart = false;
  }

  /**
   * Loads configuration and fetches + verifies the manifest.
   * Logs basic manifest stats for visibility.
   * @returns {Promise<void>} Resolves when config and manifest are ready for use.
   */
  async initialize() {
    await this.config.load();
    this.progress.log('✓ Configuration loaded');

    const manifestUrl = this.config.get('manifest_url');
    const publicKey = this.config.get('key');
    const timeoutMs = this.config.get('download_timeout');

    const manifestData = await this.manifest.fetchAndVerify(manifestUrl, publicKey, timeoutMs);

    this.progress.log(`✓ Manifest verified (version: ${manifestData.version ?? 'unknown'})`);
    this.progress.log(`  Files tracked: ${manifestData.files.length}`);
  }

  /**
   * Checks for launcher/config updates described by the manifest and applies them as needed.
   * Triggers a restart if the updater indicates it is required.
   * @returns {Promise<void>} Resolves when done, may trigger a restart.
   */
  async checkSelfUpdates() {
    const { baseUrl } = this.manifest.getData();
    const hashAlgorithm = this.config.get('hash_algorithm', 'sha256');
    const timeoutMs = this.config.get('download_timeout');

    const updates = await this.selfUpdater.checkForUpdates(this.manifest.getData(), hashAlgorithm);

    if (updates.length === 0) {
      this.progress.log('✓ Launcher and config are up to date');
      return;
    }

    this.progress.log(`⚠ Found ${updates.length} system file update(s)`);
    await this.selfUpdater.performUpdates(updates, baseUrl, timeoutMs);

    if (this.selfUpdater.needsRestart()) {
      this.restart();
    }
  }

  /**
   * Syncs local content with the manifest.
   * Optionally performs a full integrity verification pass before and after patching.
   * @param {object} [options={}] - Options object.
   * @param {boolean} [options.verifyIntegrity=false] - When true, computes and displays verification progress.
   * @returns {Promise<void>} Number of files updated.
   */
  async updateContent({ verifyIntegrity = false } = {}) {
    const { baseUrl, files: manifestFiles } = this.manifest.getData();
    const hashAlgorithm = this.config.get('hash_algorithm', 'sha256');
    const timeoutMs = this.config.get('download_timeout');

    let localFiles;

    if (verifyIntegrity) {
      this.progress.startVerification(manifestFiles.length);
      localFiles = await this.fileManager.scanWithProgress(hashAlgorithm, (completed) => this.progress.updateVerification(completed));
      this.progress.finishVerification();
    } else {
      localFiles = await this.fileManager.scanFiles(hashAlgorithm);
    }

    const updates = this.fileManager.findUpdates(manifestFiles, localFiles);

    if (updates.length === 0) {
      this.progress.log('✓ No content updates needed');
      return;
    }

    this.progress.log(`Found ${updates.length} file(s) that need updates:`);
    updates.slice(0, MAX_PREVIEW).forEach((file) => {
      const prefix = file.status === 'missing' ? '+ ' : '~ ';
      this.progress.log(`  ${prefix}${file.path}`);
    });
    if (updates.length > MAX_PREVIEW) {
      this.progress.log(`  ... and ${updates.length - MAX_PREVIEW} more`);
    }

    this.progress.startPatching(updates.length);

    await this.fileManager.downloadUpdates(updates, baseUrl, timeoutMs, {
      onOverallProgress: (completed) => this.progress.updatePatching(completed),
      onFileStart: (filename) => this.progress.startFileDownload(filename),
      onFileProgress: (percentage, filename) => this.progress.updateFileProgress(percentage, filename),
      onFileComplete: () => this.progress.finishFileDownload(),
    });

    this.progress.finishPatching();

    if (verifyIntegrity) {
      this.performIntegrityCheck(localFiles);
    }
  }

  /**
   * Compares the scanned local file list against the manifest and a small allowlist.
   * Logs any extras discovered. Deletion is intentionally not performed here.
   * @param {{ path: string }[]} localFiles - The previously scanned local file entries.
   * @returns {void} Array of extra file paths found.
   */
  performIntegrityCheck(localFiles) {
    this.progress.log('\n🔍 Performing integrity check...');

    const manifestFiles = this.manifest.getData().files;
    const manifestPaths = new Set(manifestFiles.map((f) => f.path));

    const extraFiles = localFiles.filter((f) => !manifestPaths.has(f.path) && !INTEGRITY_WHITELIST.has(f.path));

    if (extraFiles.length === 0) {
      this.progress.log('✓ No extra files found');
      return;
    }

    this.progress.log(`Found ${extraFiles.length} extra file(s):`);
    extraFiles.slice(0, MAX_PREVIEW).forEach((file) => {
      this.progress.log(`  - ${file.path}`);
    });
    if (extraFiles.length > MAX_PREVIEW) {
      this.progress.log(`  ... and ${extraFiles.length - MAX_PREVIEW} more`);
    }

    this.progress.log('⚠ Extra file removal not implemented');
  }

  /**
   * Relaunches the app using the staged file, then exits the current process.
   * @returns {void} Exit process.
   */
  restart() {
    this.progress.log('\n🔄 Restarting launcher with updates...');
    this.progress.cleanup();

    const stagedPath = 'launcher.js.new';
    const args = [stagedPath, '--restarted', ...process.argv.slice(2)];

    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'inherit',
    });

    child.unref();
    process.exit(0);
  }
}
