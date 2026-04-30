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

// ── Step 1: Find or download compiler toolchain ───────────────────────────────
//
// Strategy by platform:
//   Linux/macOS: download wasi-sdk (clang + wasm-ld bundled)
//   Windows:     download LLVM (has clang.exe + wasm-ld.exe) + WASI sysroot separately
//
// wasi-sdk on Windows is not officially supported, but LLVM's clang.exe
// supports --target=wasm32-wasi natively. We just need the WASI sysroot
// (headers + libc) which is a separate download.

const LLVM_VERSION   = '18.1.8';
const LLVM_WIN_URL   = `https://github.com/llvm/llvm-project/releases/download/llvmorg-${LLVM_VERSION}/LLVM-${LLVM_VERSION}-win64.exe`;
// WASI sysroot from wasi-sdk (just the sysroot, not the full SDK)
const WASI_SYSROOT_URL = `https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION}/wasi-sysroot-${WASI_SDK_VERSION}.0.tar.gz`;

async function findWasiSdk() {
  const isWin = platform() === 'win32';

  if (isWin) {
    return findOrDownloadWindows();
  }

  // Linux / macOS: use wasi-sdk bundle
  if (wasiSdkPath) {
    if (!existsSync(join(wasiSdkPath, 'bin', 'clang'))) {
      throw new Error(`wasi-sdk not found at ${wasiSdkPath}`);
    }
    return { clang: join(wasiSdkPath, 'bin', 'clang'), wasmLd: join(wasiSdkPath, 'bin', 'wasm-ld'), sysroot: join(wasiSdkPath, 'share', 'wasi-sysroot') };
  }

  const candidates = [
    '/opt/wasi-sdk',
    '/usr/local/wasi-sdk',
    join(CACHE_DIR, 'wasi-sdk'),
    join(process.env.HOME || '', '.wasi-sdk'),
  ];
  for (const p of candidates) {
    if (existsSync(join(p, 'bin', 'clang'))) {
      ok(`Found wasi-sdk at ${p}`);
      return { clang: join(p, 'bin', 'clang'), wasmLd: join(p, 'bin', 'wasm-ld'), sysroot: join(p, 'share', 'wasi-sysroot') };
    }
  }

  if (noDownload) throw new Error('wasi-sdk not found. Install it or remove --no-download.');

  const sdkDir = join(CACHE_DIR, 'wasi-sdk');
  if (existsSync(join(sdkDir, 'bin', 'clang'))) {
    ok(`Using cached wasi-sdk`);
    return { clang: join(sdkDir, 'bin', 'clang'), wasmLd: join(sdkDir, 'bin', 'wasm-ld'), sysroot: join(sdkDir, 'share', 'wasi-sysroot') };
  }

  log(`Downloading wasi-sdk v${WASI_SDK_VERSION}...`);
  const os = platform();
  const sdkPlatform = os === 'darwin' ? (arch() === 'arm64' ? 'arm64-macos' : 'x86_64-macos') : 'x86_64-linux';
  const url = `https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION}/wasi-sdk-${WASI_SDK_VERSION}.0-${sdkPlatform}.tar.gz`;
  mkdirSync(CACHE_DIR, { recursive: true });
  await downloadAndExtractTar(url, sdkDir);
  ok(`wasi-sdk ready`);
  return { clang: join(sdkDir, 'bin', 'clang'), wasmLd: join(sdkDir, 'bin', 'wasm-ld'), sysroot: join(sdkDir, 'share', 'wasi-sysroot') };
}

async function findOrDownloadWindows() {
  const llvmDir    = join(CACHE_DIR, 'llvm');
  const sysrootDir = join(CACHE_DIR, 'wasi-sysroot');

  const clangExe  = join(llvmDir, 'bin', 'clang.exe');
  const wasmLdExe = join(llvmDir, 'bin', 'wasm-ld.exe');

  // Check if LLVM already installed system-wide (PATH or common locations)
  const systemClang = spawnSync('clang', ['--version'], { encoding: 'utf8', shell: true });
  if (systemClang.status === 0) {
    const systemWasmLd = spawnSync('wasm-ld', ['--version'], { encoding: 'utf8', shell: true });
    if (systemWasmLd.status === 0) {
      ok('Found system LLVM (clang + wasm-ld) in PATH');
      const sysroot = await ensureWasiSysroot(sysrootDir);
      return { clang: 'clang', wasmLd: 'wasm-ld', sysroot };
    }
  }

  // Check common Windows install locations (LLVM installer default)
  const winCandidates = [
    'C:\\Program Files\\LLVM',
    'C:\\Program Files (x86)\\LLVM',
    join(process.env.LOCALAPPDATA || '', 'Programs', 'LLVM'),
    llvmDir,
  ];
  for (const p of winCandidates) {
    const c = join(p, 'bin', 'clang.exe');
    const w = join(p, 'bin', 'wasm-ld.exe');
    if (existsSync(c) && existsSync(w)) {
      ok(`Found LLVM at ${p}`);
      const sysroot = await ensureWasiSysroot(sysrootDir);
      return { clang: c, wasmLd: w, sysroot };
    }
  }

  if (noDownload) throw new Error('LLVM not found. Install LLVM from https://releases.llvm.org/ or remove --no-download.');

  // LLVM provides a .zip for Windows — no installer, no admin rights, no xz needed
  // The zip contains clang.exe, wasm-ld.exe and all needed tools
  const llvmZipUrl = `https://github.com/llvm/llvm-project/releases/download/llvmorg-${LLVM_VERSION}/clang+llvm-${LLVM_VERSION}-x86_64-pc-windows-msvc.zip`;

  log(`Downloading LLVM ${LLVM_VERSION} for Windows (~300MB, one-time)...`);
  log('Cached in .wasm-build-cache/ for future use.');

  const tmpZip = join(tmpdir(), `llvm-${Date.now()}.zip`);
  mkdirSync(llvmDir, { recursive: true });

  await download(llvmZipUrl, tmpZip);
  log('Extracting LLVM via PowerShell...');

  // Use PowerShell Expand-Archive — available on all Windows 10+, no xz needed
  const psCmd = `Expand-Archive -Path "${tmpZip}" -DestinationPath "${join(CACHE_DIR, '_llvm_tmp')}" -Force`;
  const ps = spawnSync('powershell', ['-NoProfile', '-Command', psCmd], { encoding: 'utf8' });
  if (ps.status !== 0) {
    throw new Error(`PowerShell extraction failed: ${ps.stderr}`);
  }

  // The zip has a top-level directory — move its contents to llvmDir
  const { readdirSync, renameSync } = await import('fs');
  const tmpExtract = join(CACHE_DIR, '_llvm_tmp');
  const entries = readdirSync(tmpExtract);
  if (entries.length === 1) {
    // Single top-level dir — move its contents
    const innerDir = join(tmpExtract, entries[0]);
    const { cpSync, rmSync } = await import('fs');
    cpSync(innerDir, llvmDir, { recursive: true });
    rmSync(tmpExtract, { recursive: true, force: true });
  }

  if (!existsSync(clangExe)) {
    throw new Error(`LLVM extraction failed — clang.exe not found at ${clangExe}`);
  }

  ok(`LLVM ready at ${llvmDir}`);
  const sysroot = await ensureWasiSysroot(sysrootDir);
  return { clang: clangExe, wasmLd: wasmLdExe, sysroot };
}

async function ensureWasiSysroot(sysrootDir) {
  // Check multiple possible structures
  const isReady = existsSync(join(sysrootDir, 'include', 'wasi')) ||
                  existsSync(join(sysrootDir, 'include', 'wasm32-wasi')) ||
                  existsSync(join(sysrootDir, 'lib', 'wasm32-wasi'));
  if (isReady) {
    ok(`Using cached WASI sysroot`);
    return sysrootDir;
  }

  if (noDownload) throw new Error('WASI sysroot not found. Remove --no-download to auto-download.');

  log(`Downloading WASI sysroot (~15MB)...`);
  mkdirSync(CACHE_DIR, { recursive: true });

  const isWin = platform() === 'win32';
  const tmpFile = join(tmpdir(), `wasi-sysroot-${Date.now()}.tar.gz`);
  await download(WASI_SYSROOT_URL, tmpFile);

  mkdirSync(sysrootDir, { recursive: true });

  if (isWin) {
    // Windows tar supports .tar.gz (gzip) but not .tar.xz
    // Use tar directly — Windows 10+ has BSD tar which handles .tar.gz fine
    const result = spawnSync('tar', ['-xzf', tmpFile, '-C', sysrootDir, '--strip-components=1'], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`Failed to extract WASI sysroot: ${result.stderr}`);
    }
  } else {
    run(`tar -xzf "${tmpFile}" -C "${sysrootDir}" --strip-components=1`);
  }

  ok(`WASI sysroot ready at ${sysrootDir}`);
  return sysrootDir;
}

// ── Step 2: Get CPython headers ───────────────────────────────────────────────

async function getCPythonHeaders() {
  const headersDir = join(CACHE_DIR, 'cpython-headers');
  const includeDir = join(headersDir, 'Include');
  const pyconfigPath = join(headersDir, 'pyconfig-wasm32-wasi.h');

  if (existsSync(includeDir) && existsSync(pyconfigPath)) {
    ok(`Using cached CPython headers at ${headersDir}`);
    return { includeDir, pyconfigDir: headersDir, pyconfigPath };
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

  // Python.h does #include "pyconfig.h" — copy it into Include/ so clang finds it
  const { copyFileSync } = await import('fs');
  copyFileSync(pyconfigPath, join(includeDir, 'pyconfig.h'));

  ok(`CPython headers ready at ${headersDir}`);
  return { includeDir, pyconfigDir: headersDir, pyconfigPath };
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

async function compile(srcPath, toolchain, headers) {
  const name = basename(srcPath, '.c');
  const buildDir = join(CACHE_DIR, 'build');
  mkdirSync(buildDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const objPath  = join(buildDir, `${name}.o`);
  const wasmPath = join(outDir, `${name}.wasm`);

  log(`Compiling ${basename(srcPath)}...`);

  const exports = findWasmExports(srcPath);
  if (exports.length === 0) {
    warn(`No wasm_* or PyInit_* functions found in ${basename(srcPath)}`);
    warn('Add public functions like: __attribute__((visibility("default"))) int wasm_myfunc(int x) { ... }');
  } else {
    log(`Found exports: ${exports.join(', ')}`);
  }

  const { clang, wasmLd, sysroot } = toolchain;

  const compileCmd = [
    `"${clang}"`,
    '--target=wasm32-wasi',
    `--sysroot="${sysroot}"`,
    `-I"${headers.includeDir}"`,
    `-I"${join(headers.includeDir, 'cpython')}"`,
    '-DPy_BUILD_CORE_BUILTIN=1',
    '-O2',
    '-c',
    `"${srcPath}"`,
    `-o "${objPath}"`,
  ].join(' ');

  run(compileCmd);

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
  await verifyWasm(wasmPath, exports);
  return wasmPath;
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

  log('Finding compiler toolchain...');
  const toolchain = await findWasiSdk();

  log('Getting CPython headers...');
  const headers = await getCPythonHeaders();

  const results = [];
  for (const src of sourceFiles) {
    if (!existsSync(src)) {
      err(`File not found: ${src}`);
      process.exit(1);
    }
    try {
      const wasmPath = await compile(src, toolchain, headers);
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
