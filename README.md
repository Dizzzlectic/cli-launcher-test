# CLI Launcher and Auto-Patcher

A small CLI launcher and auto‑patcher. It verifies a signed manifest, self‑updates the launcher and its config, and then patches the file content with progress reporting.

## CLI Usage

```bash
Usage: node launcher.js [options]

Options:
  --verify-integrity    Perform full integrity check (reports extra files)
  --verbose             Show error stacks
  --help, -h            Show this help message
```

Typical run:

```bash
node launcher.js --verify-integrity
```

Alternatively, set integrity verification and other configuration options in a `config.ini` and run the application only:

```bash
node launcher.js
```

During a self‑update, the launcher relaunches itself:

```bash
node launcher.js --restarted
```

(You never call this yourself; it’s passed internally when needed.)

---

## Configuration (`config.ini`)

The launcher reads `config.ini` at startup. Keys are accessed through a whitelist (no dynamic indexing). Common keys used across the code in this conversation:

```ini
; Launcher Configuration Example
; Manifest download URL
manifest_url=https://example.com/manifest.json

; Public key location (file path or URL)
; Examples:
;   key=public-key.pem                              # Local file in launcher directory
;   key=keys/public-key.pem                         # Relative path
;   key=C:\path\to\public-key.pem                   # Absolute path
;   key=https://example.com/public-key.pem          # From URL
key=https://example.com/public-key.pem

; Download timeout in milliseconds
download_timeout=30000

; Number of concurrent downloads
concurrent_downloads=4

; Verify client integrity by default
verify_integrity=true
```

> Your project may include additional keys (e.g., CDN base, etc.). The manifest’s `cdn`/`baseUrl` field is respected when downloading files.