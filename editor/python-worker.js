/**
 * Python WASM Worker — clean rewrite
 * Runs CPython wasm32-wasi by re-instantiating per run with correct memory closure.
 */

console.log('[worker] script loaded');
self.postMessage({ type: 'status', text: 'Worker loaded...' });

// ── VFS ───────────────────────────────────────────────────────────────────────

const vfsNodes = new Map();

function norm(path) {
  let p = path.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  const out = [];
  for (const s of p.split('/').filter(Boolean)) {
    if (s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return '/' + out.join('/');
}

function mkdir(path) {
  const p = norm(path);
  if (vfsNodes.has(p)) return;
  vfsNodes.set(p, { type: 'dir', children: new Set(), mtime: Date.now() });
  if (p !== '/') {
    const par = p.slice(0, p.lastIndexOf('/')) || '/';
    mkdir(par);
    vfsNodes.get(par)?.children.add(p.slice(p.lastIndexOf('/') + 1));
  }
}

function writeFile(path, content) {
  const p = norm(path);
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const par = p.slice(0, p.lastIndexOf('/')) || '/';
  mkdir(par);
  vfsNodes.set(p, { type: 'file', content: bytes, mtime: Date.now() });
  vfsNodes.get(par)?.children.add(p.slice(p.lastIndexOf('/') + 1));
}

function readFile(path) {
  const n = vfsNodes.get(norm(path));
  return n?.type === 'file' ? n.content : null;
}

// Pre-create dirs
for (const d of ['/', '/home', '/home/user', '/tmp', '/usr', '/usr/lib',
  '/usr/lib/python3.13', '/usr/lib/python3.13/lib-dynload',
  '/usr/lib/python3.13/site-packages',
  '/usr/local', '/usr/local/lib', '/usr/local/lib/python3.13',
  '/usr/local/lib/python3.13/site-packages']) mkdir(d);

// ── FDs ───────────────────────────────────────────────────────────────────────

const fds = new Map();
let nextFd = 5;

function fdOpen(path, oflags) {
  const p = norm(path);
  const CREAT = 0x1, TRUNC = 0x8;
  let node = vfsNodes.get(p);
  if (!node) {
    if (oflags & CREAT) { writeFile(p, new Uint8Array(0)); node = vfsNodes.get(p); }
    else return -1;
  }
  if ((oflags & TRUNC) && node.type === 'file') node.content = new Uint8Array(0);
  const fd = nextFd++;
  fds.set(fd, { path: p, node, pos: 0n });
  return fd;
}

// ── WASI constants ────────────────────────────────────────────────────────────

const ESUCCESS = 0, EBADF = 8, ENOENT = 44, ENOSYS = 52;

// ── Build WASI imports for a given memory getter ──────────────────────────────

function buildWasi(getMem, args, envVars, onStdout, onStderr, checkInt) {
  const dv  = () => new DataView(getMem().buffer);
  const m8  = () => new Uint8Array(getMem().buffer);
  const str = (ptr, len) => new TextDecoder().decode(new Uint8Array(getMem().buffer, ptr, len));

  let stdoutBuf = '', stderrBuf = '';

  function flushLine(buf, cb) {
    const lines = buf.split('\n');
    for (let i = 0; i < lines.length - 1; i++) cb(lines[i] + '\n');
    return lines[lines.length - 1];
  }

  const impl = {
    args_sizes_get(argcPtr, bufSizePtr) {
      const total = args.reduce((s, a) => s + new TextEncoder().encode(a + '\0').length, 0);
      dv().setUint32(argcPtr, args.length, true);
      dv().setUint32(bufSizePtr, total, true);
      return ESUCCESS;
    },
    args_get(argvPtr, argvBufPtr) {
      const enc = new TextEncoder(); let off = argvBufPtr;
      for (let i = 0; i < args.length; i++) {
        dv().setUint32(argvPtr + i * 4, off, true);
        const b = enc.encode(args[i] + '\0'); m8().set(b, off); off += b.length;
      }
      return ESUCCESS;
    },
    environ_sizes_get(countPtr, bufSizePtr) {
      const total = envVars.reduce((s, e) => s + new TextEncoder().encode(e + '\0').length, 0);
      dv().setUint32(countPtr, envVars.length, true);
      dv().setUint32(bufSizePtr, total, true);
      return ESUCCESS;
    },
    environ_get(envPtr, envBufPtr) {
      console.log('[environ_get] setting', envVars);
      const enc = new TextEncoder(); let off = envBufPtr;
      for (let i = 0; i < envVars.length; i++) {
        dv().setUint32(envPtr + i * 4, off, true);
        const b = enc.encode(envVars[i] + '\0'); m8().set(b, off); off += b.length;
      }
      return ESUCCESS;
    },

    fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
      if (checkInt) checkInt();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const base = dv().getUint32(iovsPtr + i * 8, true);
        const len  = dv().getUint32(iovsPtr + i * 8 + 4, true);
        if (!len) continue;
        const chunk = new Uint8Array(getMem().buffer, base, len).slice();
        const text = new TextDecoder().decode(chunk);
        console.log(`[fd_write] fd=${fd} len=${len} text="${text.slice(0,50)}"`);
        if (fd === 1) { stdoutBuf += text; stdoutBuf = flushLine(stdoutBuf, onStdout); }
        else if (fd === 2) { stderrBuf += text; stderrBuf = flushLine(stderrBuf, onStderr); }
        else {
          const desc = fds.get(fd); if (!desc) return EBADF;
          const pos = Number(desc.pos); const cur = desc.node.content || new Uint8Array(0);
          const nc = new Uint8Array(Math.max(cur.length, pos + chunk.length));
          nc.set(cur); nc.set(chunk, pos); desc.node.content = nc;
          desc.pos += BigInt(chunk.length);
        }
        total += len;
      }
      dv().setUint32(nwrittenPtr, total, true);
      return ESUCCESS;
    },

    fd_read(fd, iovsPtr, iovsLen, nreadPtr) {
      if (fd === 0) { dv().setUint32(nreadPtr, 0, true); return ESUCCESS; }
      const desc = fds.get(fd); if (!desc) return EBADF;
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const base = dv().getUint32(iovsPtr + i * 8, true);
        const len  = dv().getUint32(iovsPtr + i * 8 + 4, true);
        if (!len) continue;
        const content = desc.node.content || new Uint8Array(0);
        const pos = Number(desc.pos); const avail = content.length - pos;
        if (avail <= 0) break;
        const n = Math.min(len, avail);
        m8().set(content.subarray(pos, pos + n), base);
        desc.pos += BigInt(n); total += n;
      }
      dv().setUint32(nreadPtr, total, true);
      return ESUCCESS;
    },

    fd_seek(fd, offLo, offHi, whence, newoffPtr) {
      const desc = fds.get(fd); if (!desc) return EBADF;
      const off = BigInt(offLo) | (BigInt(offHi) << 32n);
      const size = BigInt(desc.node.content?.length ?? 0);
      let p = whence === 0 ? off : whence === 1 ? desc.pos + off : size + off;
      if (p < 0n) p = 0n; desc.pos = p;
      dv().setBigUint64(newoffPtr, p, true); return ESUCCESS;
    },

    fd_close(fd) { fds.delete(fd); return ESUCCESS; },

    fd_fdstat_get(fd, statPtr) {
      const node = fds.get(fd)?.node;
      const ft = fd <= 2 ? 2 : (node?.type === 'dir' ? 3 : 4);
      dv().setUint8(statPtr, ft);
      dv().setUint16(statPtr + 2, 0, true);
      dv().setBigUint64(statPtr + 8, 0xffffffffffffffffn, true);
      dv().setBigUint64(statPtr + 16, 0xffffffffffffffffn, true);
      return ESUCCESS;
    },

    // fd_filestat_get — return file metadata for an open fd
    fd_filestat_get(fd, statPtr) {
      const desc = fds.get(fd);
      if (!desc && fd > 2) return EBADF;
      const node = desc?.node;
      const d = dv();
      const isDir = node?.type === 'dir';
      const ft = fd <= 2 ? 2 : (isDir ? 3 : 4);
      const size = BigInt(node?.content?.length ?? 0);
      const t = BigInt(node?.mtime ?? Date.now()) * 1_000_000n;
      d.setBigUint64(statPtr,      1n,   true); // dev
      d.setBigUint64(statPtr + 8,  1n,   true); // ino
      d.setUint8(statPtr + 16,     ft);          // filetype
      d.setBigUint64(statPtr + 24, 1n,   true); // nlink
      d.setBigUint64(statPtr + 32, size, true); // size
      d.setBigUint64(statPtr + 40, t,    true); // atim
      d.setBigUint64(statPtr + 48, t,    true); // mtim
      d.setBigUint64(statPtr + 56, t,    true); // ctim
      return ESUCCESS;
    },

    // fd_tell — return current position
    fd_tell(fd, offsetPtr) {
      const desc = fds.get(fd);
      if (!desc) return EBADF;
      dv().setBigUint64(offsetPtr, desc.pos, true);
      return ESUCCESS;
    },

    // path_readlink — we don't have symlinks, return ENOENT
    path_readlink(dirfd, pathPtr, pathLen, buf, bufLen, bufusedPtr) {
      dv().setUint32(bufusedPtr, 0, true);
      return ENOENT;
    },

    fd_prestat_get(fd, prestatPtr) {
      if (fd === 3) { dv().setUint8(prestatPtr, 0); dv().setUint32(prestatPtr + 4, 1, true); return ESUCCESS; }
      if (fd === 4) { dv().setUint8(prestatPtr, 0); dv().setUint32(prestatPtr + 4, 10, true); return ESUCCESS; }
      return EBADF;
    },

    fd_prestat_dir_name(fd, pathPtr, pathLen) {
      const enc = new TextEncoder();
      if (fd === 3) { m8().set(enc.encode('/').subarray(0, pathLen), pathPtr); return ESUCCESS; }
      if (fd === 4) { m8().set(enc.encode('/home/user').subarray(0, pathLen), pathPtr); return ESUCCESS; }
      return EBADF;
    },

    path_open(dirfd, _df, pathPtr, pathLen, oflags, _rb, _ri, _ff, openedFdPtr) {
      const rel = str(pathPtr, pathLen);
      let base;
      if (dirfd === 3) base = '/';
      else if (dirfd === 4) base = '/home/user';
      else {
        const desc = fds.get(dirfd);
        base = desc ? desc.path : '/';
      }
      const p = norm(rel.startsWith('/') ? rel : base + '/' + rel);
      const exists = vfsNodes.has(p);
      console.log(`[path_open] dirfd=${dirfd} base="${base}" rel="${rel}" -> "${p}" exists=${exists} oflags=${oflags}`);
      const fd = fdOpen(p, oflags);
      if (fd < 0) return ENOENT;
      dv().setUint32(openedFdPtr, fd, true); return ESUCCESS;
    },

    path_create_directory(dirfd, pathPtr, pathLen) {
      const rel = str(pathPtr, pathLen);
      const base = dirfd === 3 ? '/' : dirfd === 4 ? '/home/user' : (fds.get(dirfd)?.path ?? '/');
      mkdir(norm(rel.startsWith('/') ? rel : base + '/' + rel));
      return ESUCCESS;
    },

    path_unlink_file(dirfd, pathPtr, pathLen) {
      const rel = str(pathPtr, pathLen);
      const base = dirfd === 3 ? '/' : dirfd === 4 ? '/home/user' : (fds.get(dirfd)?.path ?? '/');
      vfsNodes.delete(norm(rel.startsWith('/') ? rel : base + '/' + rel));
      return ESUCCESS;
    },

    path_filestat_get(dirfd, _flags, pathPtr, pathLen, statPtr) {
      const rel = str(pathPtr, pathLen);
      const base = dirfd === 3 ? '/' : dirfd === 4 ? '/home/user' : (fds.get(dirfd)?.path ?? '/');
      const p = norm(rel.startsWith('/') ? rel : base + '/' + rel);
      const node = vfsNodes.get(p); if (!node) return ENOENT;
      const d = dv(); const t = BigInt(node.mtime) * 1_000_000n;
      d.setBigUint64(statPtr, 1n, true);
      d.setBigUint64(statPtr + 8, 1n, true);
      d.setUint8(statPtr + 16, node.type === 'dir' ? 3 : 4);
      d.setBigUint64(statPtr + 24, 1n, true);
      d.setBigUint64(statPtr + 32, BigInt(node.content?.length ?? 0), true);
      d.setBigUint64(statPtr + 40, t, true);
      d.setBigUint64(statPtr + 48, t, true);
      d.setBigUint64(statPtr + 56, t, true);
      return ESUCCESS;
    },

    fd_readdir(fd, bufPtr, bufLen, _cookie, bufusedPtr) {
      const desc = fds.get(fd);
      if (!desc || desc.node.type !== 'dir') { dv().setUint32(bufusedPtr, 0, true); return ESUCCESS; }
      const enc = new TextEncoder();
      let written = 0;
      const cookie = Number(_cookie);
      const entries = [...desc.node.children];
      for (let idx = cookie; idx < entries.length; idx++) {
        const name = entries[idx];
        const nameBytes = enc.encode(name);
        const entrySize = 24 + nameBytes.length;
        if (written + entrySize > bufLen) {
          // Buffer full — signal to caller that there's more by filling buffer completely
          dv().setUint32(bufusedPtr, bufLen, true);
          return ESUCCESS;
        }
        const base = bufPtr + written;
        const childPath = desc.path === '/' ? '/' + name : desc.path + '/' + name;
        const childNode = vfsNodes.get(norm(childPath));
        const ft = childNode?.type === 'dir' ? 3 : 4;
        dv().setBigUint64(base,      BigInt(idx + 1), true);
        dv().setBigUint64(base + 8,  BigInt(idx + 1), true);
        dv().setUint32(base + 16,    nameBytes.length, true);
        dv().setUint8(base + 20,     ft);
        m8().set(nameBytes, base + 24);
        written += entrySize;
      }
      dv().setUint32(bufusedPtr, written, true);
      return ESUCCESS;
    },

    clock_time_get(clockId, _prec, timePtr) {
      if (checkInt) checkInt();
      const ms = clockId === 1 ? performance.now() : Date.now();
      dv().setBigUint64(timePtr, BigInt(Math.floor(ms * 1_000_000)), true);
      return ESUCCESS;
    },

    clock_res_get(_id, resPtr) {
      dv().setBigUint64(resPtr, 1n, true); return ESUCCESS;
    },

    random_get(bufPtr, bufLen) {
      crypto.getRandomValues(new Uint8Array(getMem().buffer, bufPtr, bufLen));
      return ESUCCESS;
    },

    proc_exit(code) {
      // Don't throw immediately — let Python finish flushing buffers
      // The throw will unwind the WASM stack which is what we want
      throw new Error('proc_exit:' + code);
    },
    sched_yield: () => ESUCCESS,
    path_rename: () => ENOSYS,
    path_remove_directory: () => ENOSYS,
  };

  // Auto-stub anything else
  const proxy = new Proxy(impl, {
    get(t, p) {
      if (p in t) return t[p];
      return () => { console.warn('[WASI stub]', p); return ENOSYS; };
    }
  });

  return {
    wasi: proxy,
    flush() {
      if (stdoutBuf) { onStdout(stdoutBuf); stdoutBuf = ''; }
      if (stderrBuf) { onStderr(stderrBuf); stderrBuf = ''; }
    }
  };
}

// ── ZIP extractor ─────────────────────────────────────────────────────────────

function parseZip(bytes) {
  const files = new Map();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  while (i + 4 <= bytes.length) {
    if (dv.getUint32(i, true) !== 0x04034b50) break;
    const comp     = dv.getUint16(i + 8, true);
    const compSize = dv.getUint32(i + 18, true);
    const uncSize  = dv.getUint32(i + 22, true);
    const nameLen  = dv.getUint16(i + 26, true);
    const extraLen = dv.getUint16(i + 28, true);
    const name     = new TextDecoder().decode(bytes.subarray(i + 30, i + 30 + nameLen));
    const dataOff  = i + 30 + nameLen + extraLen;
    const data     = bytes.subarray(dataOff, dataOff + compSize);
    if (!name.endsWith('/')) {
      files.set(name, comp === 0 ? data.slice() : { compressed: data.slice(), uncSize });
    }
    i = dataOff + compSize;
  }
  return files;
}

async function inflate(data) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter(); w.write(data); w.close();
  const r = ds.readable.getReader();
  const chunks = []; let total = 0;
  for (;;) { const { done, value } = await r.read(); if (done) break; chunks.push(value); total += value.length; }
  const out = new Uint8Array(total); let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function loadStdlib() {
  const resp = await fetch('./python313-stdlib.zip');
  if (!resp.ok) { self.postMessage({ type: 'stdout', data: 'Warning: stdlib not found\n' }); return; }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  self.postMessage({ type: 'status', text: 'Extracting stdlib...' });
  const files = parseZip(bytes);
  let count = 0, skipped = 0;
  let firstError = null;
  for (const [name, data] of files) {
    const dest = '/usr/lib/python3.13/' + (name.startsWith('Lib/') ? name.slice(4) : name);
    try {
      const content = data instanceof Uint8Array ? data : await inflate(data.compressed);
      writeFile(dest, content);
      count++;
    } catch(e) {
      skipped++;
      if (!firstError) firstError = `${name}: ${e.message}`;
    }
  }
  // Create empty python313.zip placeholder so Python doesn't complain
  const emptyZip = new Uint8Array([0x50,0x4B,0x05,0x06,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]);
  writeFile('/usr/lib/python313.zip', emptyZip);
  self.postMessage({ type: 'stdout', data: `stdlib: ${count} extracted, ${skipped} skipped${firstError ? ' | first error: ' + firstError : ''}\n` });
}

// ── pip ───────────────────────────────────────────────────────────────────────

const SITE_PACKAGES = '/usr/local/lib/python3.13/site-packages';
const installedPackages = new Set();

async function pipInstall(packageName) {
  const pkg = packageName.toLowerCase().trim();
  if (installedPackages.has(pkg)) return null;
  installedPackages.add(pkg);

  self.postMessage({ type: 'pip.status', data: `Installing ${pkg}...` });

  const resp = await fetch(`https://pypi.org/pypi/${pkg}/json`);
  if (!resp.ok) throw new Error(`Package not found: ${pkg}`);
  const meta = await resp.json();

  const version = meta.info.version;
  const name = meta.info.name;

  // Install dependencies first
  const requires = meta.info.requires_dist || [];
  for (const req of requires) {
    if (req.includes('; extra ==')) continue;
    if (req.includes('; sys_platform')) continue;
    if (req.includes('; python_version')) continue;
    const depName = req.split(/[>=<!;\s\[]/)[0].trim().toLowerCase();
    if (depName && !installedPackages.has(depName)) {
      try { await pipInstall(depName); } catch { /* skip optional deps */ }
    }
  }

  // Find pure-Python wheel
  const urls = meta.urls || [];
  let wheelUrl = null;
  for (const u of urls) {
    if (u.packagetype === 'bdist_wheel' && u.filename.endsWith('-none-any.whl')) {
      wheelUrl = u.url; break;
    }
  }
  if (!wheelUrl) {
    for (const u of urls) {
      if (u.packagetype === 'bdist_wheel') { wheelUrl = u.url; break; }
    }
  }
  if (!wheelUrl) {
    self.postMessage({ type: 'pip.status', data: `Skipped ${pkg} (no wheel)` });
    return null;
  }

  // Download and extract
  const wheelResp = await fetch(wheelUrl);
  if (!wheelResp.ok) throw new Error(`Download failed: ${wheelResp.status}`);
  const wheelBytes = new Uint8Array(await wheelResp.arrayBuffer());

  const files = parseZip(wheelBytes);
  let count = 0;
  for (const [fname, data] of files) {
    const dest = `${SITE_PACKAGES}/${fname}`;
    try {
      const content = data instanceof Uint8Array ? data : await inflate(data.compressed);
      writeFile(dest, content);
      count++;
    } catch { }
  }

  self.postMessage({ type: 'pip.status', data: `Installed ${name} ${version} (${count} files)` });
  return { name, version };
}

// ── Main ──────────────────────────────────────────────────────────────────────

let wasmModule = null;

async function init() {
  self.postMessage({ type: 'status', text: 'Loading stdlib...' });
  await loadStdlib();

  self.postMessage({ type: 'status', text: 'Loading python.wasm...' });
  let bytes;
  try {
    const r = await fetch('./python.wasm');
    bytes = await r.arrayBuffer();
  } catch (e) { throw new Error('Failed to fetch python.wasm: ' + e.message); }

  self.postMessage({ type: 'status', text: 'Compiling WASM...' });
  wasmModule = await WebAssembly.compile(bytes);

  self.postMessage({ type: 'ready' });
}

function runCode(code, id) {
  if (!wasmModule) {
    self.postMessage({ type: 'error', id, error: { type: 'RuntimeError', message: 'Not initialized', traceback: '' } });
    return;
  }

  // Reset file descriptors for each run — new WASM instance gets fresh fds
  fds.clear();
  nextFd = 5;

  // Debug: check random.py in VFS
  const randomPath = '/usr/lib/python3.13/random.py';
  const dirNode = vfsNodes.get('/usr/lib/python3.13');
  console.log(`[runCode] VFS has random.py: ${vfsNodes.has(randomPath)}, total nodes: ${vfsNodes.size}`);
  console.log(`[runCode] /usr/lib/python3.13 children has random.py: ${dirNode?.children?.has('random.py')}, children count: ${dirNode?.children?.size}`);

  const codeWithFlush = code + '\nimport sys as _sys\n_sys.stdout.flush()\n_sys.stderr.flush()\n';
  writeFile('/tmp/run.py', codeWithFlush);
  const runArgs = ['python3', '-c', "exec(open('/tmp/run.py').read()); import sys; sys.stdout.flush(); sys.stderr.flush()"];  // Memory holder — will be set once instance is created
  let mem = null;
  const getMem = () => mem;

  const envVars = ['PYTHONPATH=/usr/lib/python3.13:/usr/local/lib/python3.13/site-packages', 'PYTHONHOME=/usr', 'PYTHONUNBUFFERED=1'];
  const onStdout = (s) => self.postMessage({ type: 'stdout', data: s });
  const onStderr = (s) => self.postMessage({ type: 'stderr', data: s });
  const checkInt = () => {};

  const { wasi, flush } = buildWasi(getMem, runArgs, envVars, onStdout, onStderr, checkInt);

  WebAssembly.instantiate(wasmModule, { wasi_snapshot_preview1: wasi })
    .then(inst => {
      mem = inst.exports.memory;
      try {
        inst.exports._start();
      } catch (e) {
        if (!e.message?.startsWith('proc_exit:')) throw e;
      }
      flush(); // flush any remaining buffered output
      self.postMessage({ type: 'result', id, value: 'null' });
    })
    .catch(e => {
      flush();
      self.postMessage({ type: 'error', id, error: { type: e.name, message: e.message, traceback: e.stack || '' } });
    });
}

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = async (e) => {
  const { type, id, code, path, content } = e.data;
  if (type === 'run') runCode(code, id);
  else if (type === 'pip.install') {
    try {
      const result = await pipInstall(e.data.package);
      self.postMessage({ type: 'pip.result', id, value: result });
    } catch(err) {
      self.postMessage({ type: 'error', id, error: { type: err.name, message: err.message, traceback: '' } });
    }
  }
  else if (type === 'fs.write') { writeFile(path, content); self.postMessage({ type: 'fs.result', id, value: null }); }
  else if (type === 'fs.read')  { self.postMessage({ type: 'fs.result', id, value: readFile(path) }); }
};

self.postMessage({ type: 'status', text: 'Starting...' });
init().catch(err => {
  self.postMessage({ type: 'error', id: 'init', error: { type: err.name, message: err.message, traceback: err.stack || '' } });
});
