/**
 * sync-worker.mjs
 * Copies editor/python-worker.js → dist/worker.js
 * and patches it for npm package use:
 *   - Replaces local ./python.wasm and ./python313-stdlib.zip
 *     with GitHub Release CDN URLs (passed via init message)
 *   - Removes editor-specific debug console.log calls
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..', '..', '..');

const srcPath  = join(ROOT, 'editor', 'python-worker.js');
const distDir  = join(__dir, '..', 'dist');
const destPath = join(distDir, 'worker.js');

mkdirSync(distDir, { recursive: true });

let src = readFileSync(srcPath, 'utf8');

// ── Patch 1: Replace hardcoded local fetch URLs with init-message URLs ────────
// The npm worker receives wasmUrl and stdlibUrl via the 'init' message.
// We need to replace the hardcoded './python.wasm' and './python313-stdlib.zip'
// with variables that come from the init message.

// Replace the init function to accept URLs from message
src = src.replace(
  /async function init\(\) \{[\s\S]*?self\.postMessage\(\{ type: 'ready' \}\);\s*\}/,
  `async function init(wasmUrl, stdlibUrl) {
  self.postMessage({ type: 'status', text: 'Loading stdlib...' });

  // Load stdlib from provided URL
  const stdlibResp = await fetch(stdlibUrl);
  if (stdlibResp.ok) {
    const bytes = new Uint8Array(await stdlibResp.arrayBuffer());
    self.postMessage({ type: 'status', text: 'Extracting stdlib...' });
    const files = parseZip(bytes);
    let count = 0, skipped = 0;
    for (const [name, data] of files) {
      const dest = '/usr/lib/python3.13/' + (name.startsWith('Lib/') ? name.slice(4) : name);
      try {
        const content = data instanceof Uint8Array ? data : await inflate(data.compressed);
        writeFile(dest, content);
        count++;
      } catch(e) { skipped++; }
    }
    const emptyZip = new Uint8Array([0x50,0x4B,0x05,0x06,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]);
    writeFile('/usr/lib/python313.zip', emptyZip);
    self.postMessage({ type: 'stdout', data: \`stdlib: \${count} extracted, \${skipped} skipped\\n\` });
  } else {
    self.postMessage({ type: 'stdout', data: 'Warning: stdlib not found\\n' });
  }

  // Init OPFS and restore persisted files
  await opfsInit();
  await opfsRestore();

  self.postMessage({ type: 'status', text: 'Loading python.wasm...' });
  let bytes;
  try {
    const r = await fetch(wasmUrl);
    bytes = await r.arrayBuffer();
  } catch (e) { throw new Error('Failed to fetch python.wasm: ' + e.message); }

  self.postMessage({ type: 'status', text: 'Compiling WASM...' });
  wasmModule = await WebAssembly.compile(bytes);

  self.postMessage({ type: 'ready' });
}`
);

// ── Patch 2: Update message handler to pass URLs to init ──────────────────────
src = src.replace(
  /self\.postMessage\(\{ type: 'status', text: 'Starting\.\.\.' \}\);\s*init\(\)\.catch/,
  `// npm package: init is triggered by 'init' message with wasmUrl/stdlibUrl
// (no auto-start — wait for message)
const _noop = () => {};
_noop(); // placeholder
const _unused_catch`
);

// Remove the auto-start at the bottom
src = src.replace(
  /self\.postMessage\(\{ type: 'status', text: 'Starting\.\.\.' \}\);\s*init\(\)\.catch\(err => \{[\s\S]*?\}\);/,
  `// npm package mode: wait for 'init' message`
);

// ── Patch 3: Update onmessage to handle init with URLs ────────────────────────
// The editor worker handles 'init' as a special case inside onmessage
// We need to ensure it passes wasmUrl/stdlibUrl from the message
src = src.replace(
  /if \(req\.type === 'init' as string\)/,
  `if (req.type === 'init')`
);

// ── Patch 4: Remove verbose console.log calls (keep console.warn/error) ───────
src = src.replace(/\s*console\.log\(`\[path_open\][^`]*`\);\s*/g, '\n');
src = src.replace(/\s*console\.log\(`\[runCode\][^`]*`\);\s*/g, '\n');
src = src.replace(/\s*console\.log\('\[environ_get\][^']*'[^)]*\);\s*/g, '\n');

// ── Patch 5: Add npm package header ──────────────────────────────────────────
const GITHUB_RELEASE = 'https://github.com/Bebrazui/PyWasmBuilds/releases/download/cpython-wasm-v3.13.0';
const header = `/**
 * cpython-wasm worker v0.4.0
 * Auto-generated from editor/python-worker.js — do not edit directly.
 * Source: https://github.com/Bebrazui/PyWasmBuilds
 *
 * Default asset URLs (can be overridden via init message):
 *   wasmUrl:   ${GITHUB_RELEASE}/python.wasm
 *   stdlibUrl: ${GITHUB_RELEASE}/python313-stdlib.zip
 */

const GITHUB_RELEASE = '${GITHUB_RELEASE}';
const DEFAULT_WASM_URL   = GITHUB_RELEASE + '/python.wasm';
const DEFAULT_STDLIB_URL = GITHUB_RELEASE + '/python313-stdlib.zip';

`;

// Remove the original first comment block
src = src.replace(/^\/\*\*[\s\S]*?\*\/\s*/, '');
src = header + src;

writeFileSync(destPath, src, 'utf8');

const lines = src.split('\n').length;
console.log(`✓ dist/worker.js synced from editor/python-worker.js (${lines} lines)`);
