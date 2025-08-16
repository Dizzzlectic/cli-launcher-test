/* eslint-disable security/detect-non-literal-fs-filename */
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

/**
 * Loads, verifies, and normalizes a signed manifest.
 */
export default class ManifestHandler {
  /**
   * Creates a new manifest handler.
   * @param {{log?: (msg: string) => void}} [logger] - Optional logger with a `log` method for progress output.
   */
  constructor(logger) {
    this.data = null;
    this.logger = logger;
  }

  /**
   * Downloads, verifies, and normalizes a manifest file.
   * @param {string} manifestUrl - Fully qualified URL to the manifest JSON.
   * @param {string} keyConfig - Path or URL to the public key, may include `{keyId}` placeholder.
   * @param {number} [timeoutMs=30000] - Timeout in milliseconds for all network operations.
   * @returns {Promise<object>} Normalized manifest object ready for use in file verification.
   */
  async fetchAndVerify(manifestUrl, keyConfig, timeoutMs = 30000) {
    const manifestText = await this.fetchText(manifestUrl, timeoutMs);

    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch (e) {
      throw new Error(`Manifest is not valid JSON: ${e.message}`);
    }

    const sig = manifest && manifest.signature;
    const keyId = sig && sig.keyId;
    if (!keyId) {
      throw new Error('Manifest is missing signature.keyId');
    }

    const publicKeyPem = await this.loadPublicKey(keyConfig, keyId, timeoutMs);
    this.verifySignature(manifest, publicKeyPem);

    this.data = this.normalizeManifest(manifest);
    return this.data;
  }

  /**
   * Retrieves text content from a URL.
   * @param {string} url - Fully qualified URL to fetch.
   * @param {number} [timeoutMs=30000] - Timeout in milliseconds before aborting.
   * @returns {Promise<string>} Response body as text.
   */
  async fetchText(url, timeoutMs = 30000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      return await res.text();
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Attempts to load a PEM-encoded public key from one of the possible candidates.
   * @param {string} keyConfig - Path or URL to the key, may include `{keyId}` placeholder.
   * @param {string} keyId - The key identifier from the manifest.
   * @param {number} timeoutMs - Timeout in milliseconds for network requests.
   * @returns {Promise<string>} The PEM-encoded public key string.
   */
  async loadPublicKey(keyConfig, keyId, timeoutMs) {
    const candidates = this.getKeyCandidates(keyConfig, keyId);

    const tasks = candidates.map((cand) => () => this.loadKeyCandidate(cand, timeoutMs));

    try {
      const race = tasks.map((t) => t());
      return await Promise.any(race);
    } catch {
      const tagged = candidates.map((cand) =>
        this.loadKeyCandidate(cand, timeoutMs)
          .then((pem) => ({ ok: true, candidate: cand, pem }))
          .catch((err) => ({ ok: false, candidate: cand, error: err }))
      );
      const results = await Promise.all(tagged);
      const errors = results
        .filter((r) => !r.ok)
        .map((r) => {
          const msg = r.error && r.error.message ? r.error.message : String(r.error);
          return `${r.candidate}: ${msg}`;
        });

      throw new Error(`Public key not found. Tried: ${candidates.join(', ')}\nErrors: ${errors.join('; ')}`);
    }
  }

  /**
   * Loads a single PEM-encoded public key candidate.
   * @param {string} candidate - Path or URL to the key file.
   * @param {number} timeoutMs - Timeout in milliseconds for network requests.
   * @returns {Promise<string>} Trimmed PEM key contents.
   */
  loadKeyCandidate(candidate, timeoutMs) {
    if (this.isUrl(candidate)) {
      return this.fetchText(candidate, timeoutMs).then((pem) => pem.trim());
    }

    const path = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
    return readFile(path, 'utf8').then((pem) => pem.trim());
  }

  /**
   * Builds a list of possible public key locations to try.
   * @param {string} keyConfig - Path or URL to the key, may include `{keyId}` placeholder.
   * @param {string} keyId - The key identifier from the manifest.
   * @returns {string[]} Unique list of candidate paths or URLs.
   */
  getKeyCandidates(keyConfig, keyId) {
    const out = [];

    if (keyConfig) {
      if (keyConfig.indexOf('{keyId}') !== -1 && keyId) {
        out.push(keyConfig.replaceAll('{keyId}', keyId));
      } else {
        out.push(keyConfig);
      }
    }

    if (keyId) {
      out.push(`keys/${keyId}.pem`);
      out.push(`${keyId}.pem`);
    }

    out.push('public-key.pem');

    const seen = new Set();
    const deduped = [];
    out.forEach((val) => {
      if (!seen.has(val)) {
        seen.add(val);
        deduped.push(val);
      }
    });
    return deduped;
  }

  /**
   * Verifies the Ed25519 signature on the manifest's file list.
   * @param {object} manifest - Manifest object to verify.
   * @param {string} publicKeyPem - PEM-encoded public key string.
   * @returns {void}
   */
  verifySignature(manifest, publicKeyPem) {
    const sig = manifest && manifest.signature;
    if (!sig) {
      throw new Error('Manifest is missing signature');
    }

    const rawAlg = sig.algorithm;
    const algorithm = typeof rawAlg === 'string' ? rawAlg.toLowerCase() : '';
    if (algorithm !== 'ed25519') {
      throw new Error(`Unsupported signature algorithm: ${rawAlg}`);
    }

    if (!sig.value) {
      throw new Error('Manifest is missing signature value');
    }

    const files = Array.isArray(manifest.files) ? manifest.files : [];
    const canonical = JSON.stringify(files);
    const canonicalBuf = Buffer.from(canonical, 'utf8');
    const sigBuf = Buffer.from(sig.value, 'base64');
    const publicKey = createPublicKey(publicKeyPem);

    const ok = edVerify(null, canonicalBuf, publicKey, sigBuf);
    if (!ok) {
      throw new Error('Invalid manifest signature');
    }

    const canonicalHash = createHash('sha256').update(canonicalBuf).digest('hex');
    const keyHash = createHash('sha256').update(Buffer.from(publicKeyPem, 'utf8')).digest('hex');
    const fp = `${keyHash.slice(0, 8)}…${keyHash.slice(-8)}`;

    const log = (msg) => {
      if (this.logger && typeof this.logger.log === 'function') {
        this.logger.log(msg);
      } else {
        // eslint-disable-next-line no-console
        console.log(msg);
      }
    };

    log(`Verifying manifest with ${algorithm} signature...`);
    log(`  files: ${files.length} entries`);
    log(`  canonical sha256: ${canonicalHash}`);
    log(`  signature bytes: ${sigBuf.length}`);
    log(`  public key fingerprint: ${fp}`);
    log('✓ Manifest signature verified successfully');
  }

  /**
   * Returns the normalized base URL from the manifest.
   * @param {object} manifest - Manifest object containing `cdn` or `baseUrl`.
   * @returns {string} Base URL with trailing slash if present, or empty string if not defined.
   */
  getBaseUrl(manifest) {
    let raw = '';
    if (manifest && typeof manifest.cdn === 'string' && manifest.cdn.length > 0) {
      raw = manifest.cdn;
    } else if (manifest && typeof manifest.baseUrl === 'string' && manifest.baseUrl.length > 0) {
      raw = manifest.baseUrl;
    }

    if (!raw) return '';
    if (raw.charAt(raw.length - 1) === '/') return raw;
    return `${raw}/`;
  }

  /**
   * Returns the hashing algorithm from the manifest.
   * @param {object} manifest - Manifest object containing the algorithm.
   * @returns {string} Algorithm name, defaults to "sha256".
   */
  getAlgorithm(manifest) {
    if (manifest && typeof manifest.algorithm === 'string' && manifest.algorithm.length > 0) {
      return manifest.algorithm;
    }
    return 'sha256';
  }

  /**
   * Returns the manifest's file list.
   * @param {object} manifest - Manifest object containing the files.
   * @returns {any[]} Array of file entries, empty if not present.
   */
  getFiles(manifest) {
    if (manifest && Array.isArray(manifest.files)) {
      return manifest.files;
    }
    return [];
  }

  /**
   * Returns the manifest's version.
   * @param {object} manifest - Manifest object containing the version.
   * @returns {string|number} Version value, defaults to "unknown".
   */
  getVersion(manifest) {
    if (manifest && Object.prototype.hasOwnProperty.call(manifest, 'version')) {
      return manifest.version;
    }
    return 'unknown';
  }

  /**
   * Builds a normalized manifest object.
   * @param {object} manifest - Raw manifest object.
   * @returns {{version: string|number, baseUrl: string, algorithm: string, files: any[], signature: any}} Normalized manifest data.
   */
  normalizeManifest(manifest) {
    return {
      version: this.getVersion(manifest),
      baseUrl: this.getBaseUrl(manifest),
      algorithm: this.getAlgorithm(manifest),
      files: this.getFiles(manifest),
      signature: manifest ? manifest.signature : undefined,
    };
  }

  /**
   * Checks if a string is a valid HTTP/HTTPS URL.
   * @param {string} str - String to check.
   * @returns {boolean} True if the string is a URL, false otherwise.
   */
  isUrl(str) {
    return typeof str === 'string' && /^https?:\/\//i.test(str);
  }

  /**
   * Returns the last verified and normalized manifest.
   * @returns {object|null} Manifest data, or null if not loaded.
   */
  getData() {
    return this.data;
  }
}
