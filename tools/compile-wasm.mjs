#!/usr/bin/env node
/**
 * compile-wasm.mjs — Local CLI compiler for Python C-extensions → WASM
 *
 * Usage:
 *   node tools/compile-wasm.mjs <file.c> [file2.c ...] [options]
 *
 * Options:
 *   --out <dir>        Output directory (default: ./editor)
 *   --wasi-sdk <path>  Path to wasi-sdk (default: auto-detect or download)
 *   --cpython <path>   Path to CPython source (default: auto-download headers)
 *   --no-download      Fail instead of auto-downloading dependencies
 *
 * Examples:
 *   node tools/compile-wasm.mjs c-extensions/testmodule.c
 *   node tools/compile-wasm.mjs c-extensions/mylib.c --out ./editor
 *
 * What it does:
 *   1. Finds or downloads wasi-sdk (clang + wasm-ld for wasm32-wasi)
 *   2. Downloads CPython 3.13 headers + WASI pyconfig.h if needed
 *   3. Parses the .c file to find wasm_* function declarations
 *   4. Compiles: clang --target=wasm32-wasi → .o
 *   5. Links: wasm-ld --no-entry --allow-undefined --import-memory → .wasm
 *   6. Writes .wasm to output directory
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'fs';
import { join, basename, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir, platform, arch } from 'os';
import { createHash } from 'crypto';
import https from 'https';
import { createGunzip } from 'zlib';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = resolve(__dir, '..');

// ── Config ────────────────────────────────────────────────────────────────────

const WASI_SDK_VERSION  = '24';
const CPYTHON_VERSION   = 'v3.13.0';
const CPYTHON_REPO      = 'https://github.com/python/cpython';

// Pre-built pyconfig.h for wasm32-wasi — from our own GitHub Release
// This avoids having to build CPython locally just to get the header
const PYCONFIG_URL = 'https://github.com/Bebrazui/PyWasmBuilds/releases/download/cpython-wasm-v3.13.0/pyconfig-wasm32-wasi.h';

const CACHE_DIR = join(ROOT, '.wasm-build-cache');

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
Usage: node tools/compile-wasm.mjs <file.c> [file2.c ...] [options]

Options:
  --out <dir>        Output directory (default: ./editor)
  --wasi-sdk <path>  Path to wasi-sdk installation
  --no-download      Don't auto-download dependencies, fail instead
  --verbose          Show full compiler output

Examples:
  node tools/compile-wasm.mjs c-extensions/testmodule.c
  node tools/compile-wasm.mjs c-extensions/mylib.c --out ./dist
`);
  process.exit(0);
}

const sourceFiles = [];
let outDir = join(ROOT, 'editor');
let wasiSdkPath = null;
let noDownload = false;
let verbose = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out')       { outDir = resolve(args[++i]); }
  else if (args[i] === '--wasi-sdk') { wasiSdkPath = resolve(args[++i]); }
  else if (args[i] === '--no-download') { noDownload = true; }
  else if (args[i] === '--verbose')     { verbose = true; }
  else if (args[i].endsWith('.c'))      { sourceFiles.push(resolve(args[i])); }
  else { console.error(`Unknown argument: ${args[i]}`); process.exit(1); }
}

if (sourceFiles.length === 0) {
  console.error('Error: no .c files specified');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg)  { console.log(`\x1b[36m[wasm]\x1b[0m ${msg}`); }
function ok(msg)   { console.log(`\x1b[32m[ok]\x1b[0m  ${msg}`); }
function warn(msg) { console.log(`\x1b[33m[warn]\x1b[0m ${msg}`); }
function err(msg)  { console.error(`\x1b[31m[err]\x1b[0m  ${msg}`); }

function run(cmd, opts = {}) {
  if (verbose) log(`$ ${cmd}`);
  const result = spawnSync(cmd, { shell: true, encoding: 'utf8', ...opts });
  if (result.status !== 0) {
    if (!verbose) err(`Command failed: ${cmd}`);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`Exit code ${result.status}`);
  }
  return result.stdout;
}

async function download(url, destPath) {
  log(`Downloading ${url}`);
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);
    const get = (u) => https.get(u, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return get(res.headers.location);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
    get(url);
  });
}

async function downloadAndExtractTar(url, destDir) {
  const tmpFile = join(tmpdir(), `wasm-build-${Date.now()}.tar.gz`);
  await download(url, tmpFile);
  log(`Extracting to ${destDir}...`);
  mkdirSync(destDir, { recursive: true });
  run(`tar -xzf "${tmpFile}" -C "${destDir}" --strip-components=1`);
}

// ── Step 1: Find or download wasi-sdk ─────────────────────────────────────────

async function findWasiSdk() {
  // 1. User-specified path
  if (wasiSdkPath) {
    if (!existsSync(join(wasiSdkPath, 'bin', 'clang'))) {
      throw new Error(`wasi-sdk not found at ${wasiSdkPath}`);
    }
    return wasiSdkPath;
  }

  // 2. Common install locations
  const candidates = [
    '/opt/wasi-sdk',
    '/usr/local/wasi-sdk',
    join(ROOT, '.wasm-build-cache', 'wasi-sdk'),
    join(process.env.HOME || '', '.wasi-sdk'),
  ];
  for (const p of candidates) {
    const clang = join(p, 'bin', 'clang');
    if (existsSync(clang)) {
      ok(`Found wasi-sdk at ${p}`);
      return p;
    }
  }

  // 3. Auto-download
  if (noDownload) {
    throw new Error('wasi-sdk not found. Install it or remove --no-download to auto-download.');
  }

  const sdkDir = join(CACHE_DIR, 'wasi-sdk');
  if (existsSync(join(sdkDir, 'bin', 'clang'))) {
    ok(`Using cached wasi-sdk at ${sdkDir}`);
    return sdkDir;
  }

  log(`wasi-sdk not found, downloading v${WASI_SDK_VERSION}...`);

  const os = platform();
  let sdkPlatform;
  if (os === 'linux')  sdkPlatform = 'x86_64-linux';
  else if (os === 'darwin') sdkPlatform = arch() === 'arm64' ? 'arm64-macos' : 'x86_64-macos';
  else if (os === 'win32') {
    // Windows: use WSL or mingw build
    warn('Windows detected. Trying to use WSL for compilation...');
    return 'WSL';
  }
  else throw new Error(`Unsupported platform: ${os}`);

  const url = `https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION}/wasi-sdk-${WASI_SDK_VERSION}.0-${sdkPlatform}.tar.gz`;
  mkdirSync(CACHE_DIR, { recursive: true });
  await downloadAndExtractTar(url, sdkDir);
  ok(`wasi-sdk downloaded to ${sdkDir}`);
  return sdkDir;
}

// ── Step 2: Get CPython headers ───────────────────────────────────────────────

async function getCPythonHeaders() {
  const headersDir = join(CACHE_DIR, 'cpython-headers');
  const includeDir = join(headersDir, 'Include');
  const pyconfigPath = join(headersDir, 'pyconfig-wasm32-wasi.h');

  if (existsSync(includeDir) && existsSync(pyconfigPath)) {
    ok(`Using cached CPython headers at ${headersDir}`);
    return { includeDir, pyconfigDir: headersDir };
  }

  if (noDownload) {
    throw new Error('CPython headers not found. Remove --no-download to auto-download.');
  }

  mkdirSync(headersDir, { recursive: true });

  // Download just the Include/ directory from CPython via GitHub API (sparse)
  log(`Downloading CPython ${CPYTHON_VERSION} headers...`);

  // Use GitHub's tarball API to get just the Include directory
  const tarUrl = `https://github.com/python/cpython/archive/refs/tags/${CPYTHON_VERSION}.tar.gz`;
  const tmpTar = join(tmpdir(), `cpython-${Date.now()}.tar.gz`);
  await download(tarUrl, tmpTar);

  log('Extracting CPython headers...');
  // Extract only Include/ and Include/cpython/
  run(`tar -xzf "${tmpTar}" -C "${headersDir}" --strip-components=1 --wildcards "*/Include/*" 2>/dev/null || tar -xzf "${tmpTar}" -C "${headersDir}" --strip-components=1`);

  // Download WASI-specific pyconfig.h
  log('Downloading WASI pyconfig.h...');
  try {
    await download(PYCONFIG_URL, pyconfigPath);
    ok('Downloaded WASI pyconfig.h');
  } catch (e) {
    warn(`Could not download pyconfig.h from release: ${e.message}`);
    warn('Using generic pyconfig.h — some features may not work');
    // Write a minimal pyconfig.h that works for basic extensions
    writeFileSync(pyconfigPath, generateMinimalPyconfig());
  }

  ok(`CPython headers ready at ${headersDir}`);
  return { includeDir, pyconfigDir: headersDir };
}

function generateMinimalPyconfig() {
  return `
/* Minimal pyconfig.h for wasm32-wasi */
#ifndef Py_PYCONFIG_H
#define Py_PYCONFIG_H

#define SIZEOF_LONG 4
#define SIZEOF_VOID_P 4
#define SIZEOF_SIZE_T 4
#define SIZEOF_INT 4
#define SIZEOF_SHORT 2
#define SIZEOF_FLOAT 4
#define SIZEOF_DOUBLE 8
#define SIZEOF_LONG_LONG 8

#define PY_FORMAT_SIZE_T "z"
#define Py_UNICODE_SIZE 4
#define PY_UNICODE_TYPE unsigned int

#define HAVE_STDARG_PROTOTYPES 1
#define HAVE_LONG_LONG 1
#define PY_LONG_LONG long long

#define Py_ENABLE_SHARED 0
#define Py_BUILD_CORE 0

#endif /* Py_PYCONFIG_H */
`;
}

// ── Step 3: Parse .c file for wasm_* exports ──────────────────────────────────

function findWasmExports(srcPath) {
  const src = readFileSync(srcPath, 'utf8');
  const exports = [];

  // Match: wasm_* function definitions
  // Patterns: "const char* wasm_hello(", "long wasm_add(", "int wasm_foo("
  const re = /(?:__attribute__\s*\(\s*\(visibility\s*\([^)]+\)\s*\)\s*\)\s*)?(?:const\s+)?(?:char\s*\*|int|long|double|float|void)\s+(wasm_\w+)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    exports.push(m[1]);
  }

  // Also find PyInit_* (always exported)
  const pyInitRe = /PyMODINIT_FUNC\s+(PyInit_\w+)\s*\(/g;
  while ((m = pyInitRe.exec(src)) !== null) {
    exports.push(m[1]);
  }

  return [...new Set(exports)];
}

// ── Step 4: Compile ───────────────────────────────────────────────────────────

async function compile(srcPath, sdkPath, headers) {
  const name = basename(srcPath, '.c');
  const buildDir = join(CACHE_DIR, 'build');
  mkdirSync(buildDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const objPath  = join(buildDir, `${name}.o`);
  const wasmPath = join(outDir, `${name}.wasm`);

  log(`Compiling ${basename(srcPath)}...`);

  // Find all wasm_* and PyInit_* exports
  const exports = findWasmExports(srcPath);
  if (exports.length === 0) {
    warn(`No wasm_* or PyInit_* functions found in ${basename(srcPath)}`);
    warn('Add public functions like: __attribute__((visibility("default"))) int wasm_myfunc(int x) { ... }');
  } else {
    log(`Found exports: ${exports.join(', ')}`);
  }

  const isWindows = platform() === 'win32';

  if (sdkPath === 'WSL') {
    // Windows: run via WSL
    await compileViaWSL(srcPath, name, exports, headers, wasmPath);
    return wasmPath;
  }

  const clang   = join(sdkPath, 'bin', 'clang');
  const wasmLd  = join(sdkPath, 'bin', 'wasm-ld');
  const sysroot = join(sdkPath, 'share', 'wasi-sysroot');

  // Compile to object file
  const compileCmd = [
    `"${clang}"`,
    '--target=wasm32-wasi',
    `--sysroot="${sysroot}"`,
    `-I"${headers.includeDir}"`,
    `-I"${join(headers.includeDir, 'cpython')}"`,
    `-I"${headers.pyconfigDir}"`,
    '-DPy_BUILD_CORE_BUILTIN=1',
    '-O2',
    '-c',
    `"${srcPath}"`,
    `-o "${objPath}"`,
  ].join(' ');

  run(compileCmd);

  // Link to WASM module
  const exportFlags = exports.map(e => `--export=${e}`).join(' ');
  const linkCmd = [
    `"${wasmLd}"`,
    '--no-entry',
    '--allow-undefined',
    exportFlags,
    '--import-memory',
    `"${objPath}"`,
    `-o "${wasmPath}"`,
  ].join(' ');

  run(linkCmd);

  const size = readFileSync(wasmPath).length;
  ok(`${name}.wasm → ${wasmPath} (${size} bytes)`);

  // Verify exports
  await verifyWasm(wasmPath, exports);

  return wasmPath;
}

async function compileViaWSL(srcPath, name, exports, headers, wasmPath) {
  // Check WSL is available
  try { run('wsl --version', { stdio: 'pipe' }); } catch {
    throw new Error('WSL not available. Install WSL2 or use Linux/macOS to compile.');
  }

  log('Using WSL for compilation...');

  // Convert Windows paths to WSL paths
  const toWsl = (p) => p.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);

  const wslSrc     = toWsl(srcPath);
  const wslOut     = toWsl(wasmPath);
  const wslHeaders = toWsl(headers.includeDir);
  const wslPyconf  = toWsl(headers.pyconfigDir);
  const wslBuild   = toWsl(join(CACHE_DIR, 'build'));
  const wslObj     = `${wslBuild}/${name}.o`;

  // Install wasi-sdk in WSL if needed
  const wslSdkCheck = spawnSync('wsl', ['test', '-f', '/opt/wasi-sdk/bin/clang'], { encoding: 'utf8' });
  if (wslSdkCheck.status !== 0) {
    log('Installing wasi-sdk in WSL...');
    const installScript = `
      set -e
      URL="https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-24/wasi-sdk-24.0-x86_64-linux.tar.gz"
      wget -q "$URL" -O /tmp/wasi-sdk.tar.gz
      sudo tar -xzf /tmp/wasi-sdk.tar.gz -C /opt
      sudo mv /opt/wasi-sdk-24.0-x86_64-linux /opt/wasi-sdk
    `;
    run(`wsl bash -c "${installScript.replace(/\n/g, '; ')}"`);
  }

  const exportFlags = exports.map(e => `--export=${e}`).join(' ');

  const compileScript = `
    /opt/wasi-sdk/bin/clang --target=wasm32-wasi --sysroot=/opt/wasi-sdk/share/wasi-sysroot \
      -I"${wslHeaders}" -I"${wslHeaders}/cpython" -I"${wslPyconf}" \
      -DPy_BUILD_CORE_BUILTIN=1 -O2 -c "${wslSrc}" -o "${wslObj}" && \
    /opt/wasi-sdk/bin/wasm-ld --no-entry --allow-undefined ${exportFlags} --import-memory \
      "${wslObj}" -o "${wslOut}"
  `.trim().replace(/\n\s+/g, ' ');

  run(`wsl bash -c "${compileScript}"`);

  const size = readFileSync(wasmPath).length;
  ok(`${name}.wasm → ${wasmPath} (${size} bytes)`);
}

async function verifyWasm(wasmPath, expectedExports) {
  try {
    const bytes = readFileSync(wasmPath);
    const mod = await WebAssembly.compile(bytes);
    const actualExports = WebAssembly.Module.exports(mod).map(e => e.name);
    const missing = expectedExports.filter(e => !actualExports.includes(e));
    if (missing.length > 0) {
      warn(`Missing exports in compiled WASM: ${missing.join(', ')}`);
    } else {
      ok(`Verified exports: ${actualExports.join(', ')}`);
    }
  } catch (e) {
    warn(`Could not verify WASM: ${e.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n\x1b[1m🔧 Python WASM C-Extension Compiler\x1b[0m\n');

  mkdirSync(CACHE_DIR, { recursive: true });

  log('Finding wasi-sdk...');
  const sdkPath = await findWasiSdk();

  log('Getting CPython headers...');
  const headers = await getCPythonHeaders();

  const results = [];
  for (const src of sourceFiles) {
    if (!existsSync(src)) {
      err(`File not found: ${src}`);
      process.exit(1);
    }
    try {
      const wasmPath = await compile(src, sdkPath, headers);
      results.push({ src, wasmPath, ok: true });
    } catch (e) {
      err(`Failed to compile ${basename(src)}: ${e.message}`);
      results.push({ src, ok: false, error: e.message });
    }
  }

  console.log('\n\x1b[1mResults:\x1b[0m');
  for (const r of results) {
    if (r.ok) {
      console.log(`  ✓ ${basename(r.src)} → ${r.wasmPath}`);
    } else {
      console.log(`  ✗ ${basename(r.src)}: ${r.error}`);
    }
  }

  const failed = results.filter(r => !r.ok).length;
  if (failed > 0) {
    console.log(`\n${failed} file(s) failed to compile.`);
    process.exit(1);
  }

  console.log(`\n\x1b[32mDone! ${results.length} file(s) compiled.\x1b[0m`);
  console.log(`\nTo use in the editor:`);
  console.log(`  1. Open http://localhost:8787`);
  console.log(`  2. Click "🔌 Load C-ext" and select the .wasm file`);
  console.log(`  3. Run: import <modulename>`);
}

main().catch(e => {
  err(e.message);
  if (verbose) console.error(e.stack);
  process.exit(1);
});
