/* eslint-disable no-console */
import cliProgress from 'cli-progress';

const BAR_FORMAT = '{label} {bar} {percentage}% | {value}/{total}';
const BAR_COMPLETE = '█';
const BAR_INCOMPLETE = '░';
const MAX_LABEL_WIDTH = 25;
const FILEBAR_TOTAL = 100;

const LABELS = {
  verifying: 'Verifying files...     ',
  verificationDone: 'Verification complete  ',
  patching: 'Patching progress...     ',
  patchingDone: 'Patching complete        ',
  preparing: 'Preparing download...  ',
  currentFile: 'Current file...        ',
};

/**
 * Formats filenames to fit a fixed label width. Left-truncates if too long.
 * @param {string} filename - Original filename.
 * @returns {string} Display-ready filename.
 */
const formatFilenameLabel = (filename) => {
  if (typeof filename !== 'string' || filename.length === 0) return ''.padEnd(MAX_LABEL_WIDTH);
  const needsTruncate = filename.length > MAX_LABEL_WIDTH;
  const display = needsTruncate ? `...${filename.slice(-(MAX_LABEL_WIDTH - 3))}` : filename;
  return display.padEnd(MAX_LABEL_WIDTH);
};

export default class ProgressDisplay {
  /**
   * Displays progress for verification and patching phases in TTY and non-TTY environments.
   * Creates progress bars only when needed to avoid spacing side effects.
   */
  constructor() {
    /** @type {boolean} */
    this.isTTY = Boolean(process.stdout && process.stdout.isTTY);

    /** @type {cliProgress.MultiBar|null} */
    this.multibar = null; // lazily created

    /** @type {cliProgress.SingleBar|null} */
    this.overallBar = null;

    /** @type {cliProgress.SingleBar|null} */
    this.fileBar = null;

    /** @type {'verification'|'patching'|null} */
    this.currentPhase = null;

    /** @type {number} */
    this.lastPrintedPct = -1;
  }

  /**
   * Lazily create the MultiBar instance when needed (TTY only).
   * @returns {void}
   */
  multiBar() {
    if (!this.isTTY || this.multibar) return;
    this.multibar = new cliProgress.MultiBar(
      {
        clearOnComplete: false,
        hideCursor: true,
        format: BAR_FORMAT,
        barCompleteChar: BAR_COMPLETE,
        barIncompleteChar: BAR_INCOMPLETE,
      },
      cliProgress.Presets.shades_grey
    );
  }

  /**
   * Begin the verification phase.
   * @param {number} totalFiles - Total number of files to verify.
   * @returns {void}
   */
  startVerification(totalFiles) {
    this.currentPhase = 'verification';
    this.lastPrintedPct = -1;

    if (this.isTTY) {
      this.multiBar();
      this.overallBar = this.multibar.create(totalFiles, 0, { label: LABELS.verifying });
    } else {
      console.log(`Verifying ${totalFiles} files...`);
    }
  }

  /**
   * Update the verification progress.
   * @param {number} completed - Number of files verified so far.
   * @returns {void}
   */
  updateVerification(completed) {
    if (this.isTTY && this.overallBar) {
      this.overallBar.update(completed, { label: LABELS.verifying });
    }
  }

  /**
   * Complete the verification phase.
   * @returns {void}
   */
  finishVerification() {
    if (this.isTTY && this.overallBar) {
      this.overallBar.update(this.overallBar.getTotal(), { label: LABELS.verificationDone });
    } else {
      console.log('✓ File verification complete');
    }
  }

  /**
   * Begin the patching phase and prepare per-file progress tracking.
   * @param {number} totalFiles - Total number of files to patch.
   * @returns {void}
   */
  startPatching(totalFiles) {
    this.currentPhase = 'patching';
    this.lastPrintedPct = -1;

    if (this.isTTY) {
      this.multiBar();

      if (this.overallBar) this.multibar.remove(this.overallBar);
      this.overallBar = this.multibar.create(totalFiles, 0, { label: LABELS.patching });

      if (this.fileBar) this.multibar.remove(this.fileBar);
      this.fileBar = this.multibar.create(FILEBAR_TOTAL, 0, { label: LABELS.preparing });
    } else {
      console.log(`Patching ${totalFiles} files...`);
    }
  }

  /**
   * Update the patching overall progress.
   * @param {number} completed - Number of files patched so far.
   * @returns {void}
   */
  updatePatching(completed) {
    if (this.isTTY && this.overallBar) {
      this.overallBar.update(completed, { label: LABELS.patching });
    }
  }

  /**
   * Start tracking a specific file download in the patching phase.
   * @param {string} filename - Name of the file being downloaded.
   * @returns {void}
   */
  startFileDownload(filename) {
    const label = formatFilenameLabel(filename);

    if (this.isTTY && this.fileBar) {
      this.fileBar.update(0, { label });
    } else {
      process.stdout.write(`Downloading ${filename}...`);
    }
  }

  /**
   * Update the current file's download percentage.
   * In non-TTY mode, prints at 25% increments to avoid spam.
   * @param {number} percentage - Download progress percentage (0–100).
   * @param {string} filename - Name of the file being downloaded.
   * @returns {void}
   */
  updateFileProgress(percentage, filename) {
    if (this.isTTY && this.fileBar) {
      const label = formatFilenameLabel(filename);
      this.fileBar.update(Math.max(0, Math.min(100, percentage)), { label });
      return;
    }

    const step = 25;
    const bucket = Math.floor(percentage / step) * step;
    if (bucket !== this.lastPrintedPct && bucket % step === 0) {
      process.stdout.write(` ${bucket}%`);
      this.lastPrintedPct = bucket;
    }
  }

  /**
   * Mark the current file download as complete.
   * @returns {void}
   */
  finishFileDownload() {
    if (this.isTTY && this.fileBar) {
      this.fileBar.update(100);
    } else {
      process.stdout.write(' ✓\n');
    }
  }

  /**
   * Complete the patching phase.
   * @returns {void}
   */
  finishPatching() {
    if (this.isTTY && this.overallBar) {
      this.overallBar.update(this.overallBar.getTotal(), { label: LABELS.patchingDone });
    } else {
      console.log('✓ Patching complete');
    }
  }

  /**
   * Log a message without corrupting progress bars or adding blank lines.
   * In TTY mode: only stop/rebuild if bars are active; otherwise write directly.
   * @param {string} message - Message to log.
   * @returns {void}
   */
  log(message) {
    if (!this.isTTY) {
      console.log(message);
      return;
    }

    const hasActiveBars = Boolean(this.overallBar || this.fileBar);

    if (hasActiveBars && this.multibar) {
      this.multibar.stop();
      process.stdout.write(`${message}\n`);
      this.rebuildBars();
      return;
    }

    process.stdout.write(`${message}\n`);
  }

  /**
   * Recreate active bars after a log to maintain a clean TTY.
   * Only runs when bars actually exist.
   * @returns {void}
   */
  rebuildBars() {
    if (!this.isTTY) return;

    const hadOverall = Boolean(this.overallBar);
    const hadFile = Boolean(this.fileBar);
    if (!hadOverall && !hadFile) return;

    this.multibar = new cliProgress.MultiBar(
      {
        clearOnComplete: false,
        hideCursor: true,
        format: BAR_FORMAT,
        barCompleteChar: BAR_COMPLETE,
        barIncompleteChar: BAR_INCOMPLETE,
      },
      cliProgress.Presets.shades_grey
    );

    if (hadOverall) {
      const total = this.overallBar.getTotal();
      const value = this.overallBar.value || 0;
      const label = this.currentPhase === 'verification' ? LABELS.verifying : LABELS.patching;
      this.overallBar = this.multibar.create(total, value, { label });
    } else {
      this.overallBar = null;
    }

    if (hadFile) {
      const value = this.fileBar.value || 0;
      this.fileBar = this.multibar.create(FILEBAR_TOTAL, value, { label: LABELS.currentFile });
    } else {
      this.fileBar = null;
    }
  }

  /**
   * Stop and dispose progress bars.
   * @returns {void}
   */
  cleanup() {
    if (this.multibar) {
      this.multibar.stop();
      this.multibar = null;
    }
    this.overallBar = null;
    this.fileBar = null;
  }
}
