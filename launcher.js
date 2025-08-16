/* eslint-disable no-console, n/no-process-exit */
import minimist from 'minimist';

import LauncherCore from './lib/launcher-core.js';
import ProgressDisplay from './lib/progress-display.js';

/** Application script name and companion paths used during self-update. */
const APP_NAME = 'launcher.js';
const APP_STAGED = `${APP_NAME}.new`;
const APP_BACKUP = `${APP_NAME}.bak`;

/**
 * @typedef {Object} CliArgs
 * @property {boolean} 'verify-integrity' - When true, performs a full verification scan before patching.
 * @property {boolean} verbose - When true, prints error stacks for debugging.
 * @property {boolean} help - Print usage and exit (alias: -h).
 * @property {boolean} h - Short alias for --help.
 */

/**
 * Parse command line arguments and handle --help.
 * @returns {CliArgs} Parsed arguments.
 */
const parseArgs = () => {
  const argv = minimist(process.argv.slice(2), {
    boolean: ['verify-integrity', 'help', 'h', 'verbose'],
    alias: { h: 'help' },
  });

  if (argv.help) {
    console.log(`
Lineage 2 Launcher

Usage: node ${APP_NAME} [options]

Options:
  --verify-integrity    Perform full integrity check (reports extra files)
  --verbose             Show error stacks
  --help, -h            Show this help message
    `);
    process.exit(0);
  }

  return argv;
};

/**
 * Promote a staged launcher file into place after a restart.
 *
 * This routine is only invoked when the process is started with "--restarted".
 * It atomically clears stale backups and replaces the launcher.
 *
 * Errors are logged but not fatal; the caller proceeds regardless.
 * @returns {Promise<void>} Resolves after promotion attempts complete.
 */
async function promoteStagedLauncher() {
  const { rename, unlink } = await import('node:fs/promises');

  try {
    // Clear any stale backup; ignore if absent
    try {
      await unlink(APP_BACKUP);
    } catch {}

    // Move original to backup; ignore if not present
    try {
      await rename(APP_NAME, APP_BACKUP);
    } catch {}

    // Promote staged file into place
    await rename(APP_STAGED, APP_NAME);

    console.log('✓ Promoted staged launcher to launcher.js');

    // Optionally; remove the backup if possible
    try {
      await unlink(APP_BACKUP);
    } catch {}
  } catch (e) {
    console.log(`⚠ Could not promote staged launcher: ${e.message}`);
    // Intentionally do not delete the staged file when promotion fails.
  }
}

/**
 * Main program: initialize, self-update, then patch content.
 * @returns {Promise<void>} Resolves on normal completion; sets process exit code on error.
 */
const main = async () => {
  const argv = parseArgs();
  const progress = new ProgressDisplay();
  const launcher = new LauncherCore(progress);

  try {
    console.log('🚀 Lineage 2 Launcher starting...\n');

    // Initialize configuration and manifest
    await launcher.initialize();

    // Check for launcher/config updates (may trigger restart)
    await launcher.checkSelfUpdates();

    // Handle content updates with proper progress bars
    await launcher.updateContent({
      verifyIntegrity: argv['verify-integrity'],
    });

    console.log('\n✅ Launcher completed successfully!');
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    if (argv.verbose) console.error(error.stack);
    process.exitCode = 1;
  } finally {
    progress.cleanup();
  }
};

// If we were relaunched for a staged update, promote the new binary first.
if (process.argv.includes('--restarted')) {
  await promoteStagedLauncher();
}

main();
