import ini from 'ini';
import { access, readFile } from 'node:fs/promises';

/**
 * @typedef {Object} ConfigShape
 * @property {string} manifest_url Base URL of the manifest.json
 * @property {string} key Path to the PEM public key
 * @property {number} download_timeout Download timeout in milliseconds
 * @property {number} concurrent_downloads Max concurrent file downloads
 * @property {boolean} verify_integrity Verify file integrity after download
 * @property {string} hash_algorithm Hash algorithm for integrity checks
 */

const DEFAULT_CONFIG = {
  manifest_url: 'http://localhost:3000/manifest.json',
  key: 'public-key.pem',
  download_timeout: 30000,
  concurrent_downloads: 4,
  verify_integrity: true,
  hash_algorithm: 'sha256',
};

/** @type {Map<keyof ConfigShape, { get:(cfg: ConfigShape, d: unknown)=>unknown, set:(cfg: ConfigShape, v: unknown)=>void }>} */
const FIELD_ACCESSORS = new Map([
  [
    'manifest_url',
    {
      get: (cfg, d) => cfg.manifest_url ?? d,
      set: (cfg, v) => {
        cfg.manifest_url = String(v);
      },
    },
  ],
  [
    'key',
    {
      get: (cfg, d) => cfg.key ?? d,
      set: (cfg, v) => {
        cfg.key = String(v);
      },
    },
  ],
  [
    'download_timeout',
    {
      get: (cfg, d) => cfg.download_timeout ?? d,
      set: (cfg, v) => {
        cfg.download_timeout = Number(v);
      },
    },
  ],
  [
    'concurrent_downloads',
    {
      get: (cfg, d) => cfg.concurrent_downloads ?? d,
      set: (cfg, v) => {
        cfg.concurrent_downloads = Number(v);
      },
    },
  ],
  [
    'verify_integrity',
    {
      get: (cfg, d) => cfg.verify_integrity ?? d,
      set: (cfg, v) => {
        cfg.verify_integrity = Boolean(v);
      },
    },
  ],
  [
    'hash_algorithm',
    {
      get: (cfg, d) => cfg.hash_algorithm ?? d,
      set: (cfg, v) => {
        cfg.hash_algorithm = String(v);
      },
    },
  ],
]);

/** @typedef {keyof ConfigShape} ConfigKey */

/**
 * Loads and manages application configuration.
 */
export default class ConfigManager {
  /** @type {ConfigShape} */
  config;

  /** Creates a manager with default values. */
  constructor() {
    this.config = { ...DEFAULT_CONFIG };
  }

  /**
   * Loads config from `config.ini` if it exists.
   * Only known keys are applied.
   * @returns {Promise<boolean>} True if loaded, false if not found/unreadable.
   */
  async load() {
    try {
      await access('config.ini');
      const next = { ...DEFAULT_CONFIG };
      const content = await readFile('config.ini', 'utf8');

      /** @type {Partial<ConfigShape>} */
      const parsed = ini.parse(content);

      if (parsed.manifest_url !== undefined) next.manifest_url = String(parsed.manifest_url);
      if (parsed.key !== undefined) next.key = String(parsed.key);
      if (parsed.download_timeout !== undefined) next.download_timeout = Number(parsed.download_timeout);
      if (parsed.concurrent_downloads !== undefined) next.concurrent_downloads = Number(parsed.concurrent_downloads);
      if (parsed.verify_integrity !== undefined) next.verify_integrity = Boolean(parsed.verify_integrity);
      if (parsed.hash_algorithm !== undefined) next.hash_algorithm = String(parsed.hash_algorithm);

      this.config = next;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Gets a config value.
   * @param {ConfigKey} key - Key to retrieve.
   * @param {unknown} [defaultValue=null] - Value if key is unset.
   * @returns {unknown} Current or default value.
   */
  get(key, defaultValue = null) {
    const accessor = FIELD_ACCESSORS.get(key);
    if (!accessor) throw new Error(`Invalid config key: ${key}`);
    return accessor.get(this.config, defaultValue);
  }

  /**
   * Sets a config value.
   * @param {ConfigKey} key - Key to update.
   * @param {unknown} value - New value.
   */
  set(key, value) {
    const accessor = FIELD_ACCESSORS.get(key);
    if (!accessor) throw new Error(`Invalid config key: ${key}`);
    accessor.set(this.config, value);
  }

  /**
   * Returns all config values.
   * @returns {ConfigShape} Copy of the config.
   */
  getAll() {
    return { ...this.config };
  }
}
