/**
 * cpython-wasm worker
 * Receives { type: 'init', wasmUrl, stdlibUrl } then { type: 'run', id, code }
 */

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

// ── WASI ──────────────────────────────────────────────────────────────────────

const ESUCCESS = 0, EBADF = 8, ENOENT = 44, ENOSYS = 52;

function buildWasi(getMem, args, envVars, onStdout, onStderr) {
  const dv  = () => new DataView(getMem().buffer);
  const m8  = () => new Uint8Array(getMem().buffer);
  const str = (ptr, len) => new TextDecoder().decode(new Uint8Array(getMem().buffer, ptr, len));
  let stdoutBuf = '', stderrBuf = '';

  function flushLines(buf, cb) {
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
      const enc = new TextEncoder(); let off = envBufPtr;
      for (let i = 0; i < envVars.length; i++) {
        dv().setUint32(envPtr + i * 4, off, true);
        const b = enc.encode(envVars[i] + '\0'); m8().set(b, off); off += b.length;
      }
      return ESUCCESS;
    },
    fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const base = dv().getUint32(iovsPtr + i * 8, true);
        const len  = dv().getUint32(iovsPtr + i * 8 + 4, true);
        if (!len) continue;
        const chunk = new Uint8Array(getMem().buffer, base, len).slice();
        const text = new TextDecoder().decode(chunk);
        if (fd === 1) { stdoutBuf += text; stdoutBuf = flushLines(stdoutBuf, onStdout); }
        else if (fd === 2) { stderrBuf += text; stderrBuf = flushLines(stderrBuf, onStderr); }
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
    fd_filestat_get(fd, statPtr) {
      const desc = fds.get(fd);
      const node = desc?.node;
      const ft = fd <= 2 ? 2 : (node?.type === 'dir' ? 3 : 4);
      const size = BigInt(node?.content?.length ?? 0);
      const t = BigInt(node?.mtime ?? Date.now()) * 1_000_000n;
      const d = dv();
      d.setBigUint64(statPtr,      1n,   true);
      d.setBigUint64(statPtr + 8,  1n,   true);
      d.setUint8(statPtr + 16,     ft);
      d.setBigUint64(statPtr + 24, 1n,   true);
      d.setBigUint64(statPtr + 32, size, true);
      d.setBigUint64(statPtr + 40, t,    true);
      d.setBigUint64(statPtr + 48, t,    true);
      d.setBigUint64(statPtr + 56, t,    true);
      return ESUCCESS;
    },
    fd_tell(fd, offsetPtr) {
      const desc = fds.get(fd); if (!desc) return EBADF;
      dv().setBigUint64(offsetPtr, desc.pos, true); return ESUCCESS;
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
      const base = dirfd === 3 ? '/' : dirfd === 4 ? '/home/user' : (fds.get(dirfd)?.path ?? '/');
      const p = norm(rel.startsWith('/') ? rel : base + '/' + rel);
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
      d.setBigUint64(statPtr, 1n, true); d.setBigUint64(statPtr + 8, 1n, true);
      d.setUint8(statPtr + 16, node.type === 'dir' ? 3 : 4);
      d.setBigUint64(statPtr + 24, 1n, true);
      d.setBigUint64(statPtr + 32, BigInt(node.content?.length ?? 0), true);
      d.setBigUint64(statPtr + 40, t, true); d.setBigUint64(statPtr + 48, t, true); d.setBigUint64(statPtr + 56, t, true);
      return ESUCCESS;
    },
    path_readlink(_d, _pp, _pl, _b, _bl, bufusedPtr) {
      dv().setUint32(bufusedPtr, 0, true); return ENOENT;
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
          dv().setUint32(bufusedPtr, bufLen, true);
          return ESUCCESS;
        }
        const base = bufPtr + written;
        const childPath = desc.path === '/' ? '/' + name : desc.path + '/' + name;
        const childNode = vfsNodes.get(norm(childPath));
        dv().setBigUint64(base,      BigInt(idx + 1), true);
        dv().setBigUint64(base + 8,  BigInt(idx + 1), true);
        dv().setUint32(base + 16,    nameBytes.length, true);
        dv().setUint8(base + 20,     childNode?.type === 'dir' ? 3 : 4);
        m8().set(nameBytes, base + 24);
        written += entrySize;
      }
      dv().setUint32(bufusedPtr, written, true);
      return ESUCCESS;
    },
    clock_time_get(clockId, _prec, timePtr) {
      const ms = clockId === 1 ? performance.now() : Date.now();
      dv().setBigUint64(timePtr, BigInt(Math.floor(ms * 1_000_000)), true);
      return ESUCCESS;
    },
    clock_res_get(_id, resPtr) { dv().setBigUint64(resPtr, 1n, true); return ESUCCESS; },
    random_get(bufPtr, bufLen) {
      crypto.getRandomValues(new Uint8Array(getMem().buffer, bufPtr, bufLen));
      return ESUCCESS;
    },
    proc_exit(code) { throw new Error('proc_exit:' + code); },
    sched_yield: () => ESUCCESS,
    path_rename: () => ENOSYS,
    path_remove_directory: () => ENOSYS,
  };

  const proxy = new Proxy(impl, {
    get(t, p) {
      if (p in t) return t[p];
      return () => ENOSYS;
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

// ── ZIP / stdlib ──────────────────────────────────────────────────────────────

function parseZip(bytes) {
  const files = new Map();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  while (i + 4 <= bytes.length) {
    if (dv.getUint32(i, true) !== 0x04034b50) break;
    const comp = dv.getUint16(i + 8, true);
    const compSize = dv.getUint32(i + 18, true);
    const nameLen = dv.getUint16(i + 26, true);
    const extraLen = dv.getUint16(i + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(i + 30, i + 30 + nameLen));
    const dataOff = i + 30 + nameLen + extraLen;
    const data = bytes.subarray(dataOff, dataOff + compSize);
    if (!name.endsWith('/')) {
      files.set(name, comp === 0 ? data.slice() : { compressed: data.slice() });
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

async function loadStdlib(stdlibUrl) {
  const resp = await fetch(stdlibUrl);
  if (!resp.ok) return;
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const files = parseZip(bytes);
  let count = 0;
  for (const [name, data] of files) {
    const dest = '/usr/lib/python3.13/' + (name.startsWith('Lib/') ? name.slice(4) : name);
    try {
      const content = data instanceof Uint8Array ? data : await inflate(data.compressed);
      writeFile(dest, content);
      count++;
    } catch { /* skip */ }
  }
  // Create empty python313.zip placeholder so Python doesn't complain
  const emptyZip = new Uint8Array([0x50,0x4B,0x05,0x06,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]);
  writeFile('/usr/lib/python313.zip', emptyZip);
}

// ── pip ───────────────────────────────────────────────────────────────────────

const SITE_PACKAGES = '/usr/local/lib/python3.13/site-packages';
const installedPkgs = new Set();

async function pipInstall(packageName) {
  const pkg = packageName.toLowerCase().trim();
  if (installedPkgs.has(pkg)) return null;
  installedPkgs.add(pkg);

  self.postMessage({ type: 'pip.status', data: `Installing ${pkg}...` });

  const resp = await fetch(`https://pypi.org/pypi/${pkg}/json`);
  if (!resp.ok) throw new Error(`Package not found: ${pkg}`);
  const meta = await resp.json();
  const { version, name, requires_dist } = meta.info;

  // Install dependencies first
  for (const req of (requires_dist || [])) {
    if (req.includes('; extra ==') || req.includes('; sys_platform') || req.includes('; python_version')) continue;
    const dep = req.split(/[>=<!;\s\[]/)[0].trim().toLowerCase();
    if (dep && !installedPkgs.has(dep)) {
      try { await pipInstall(dep); } catch { }
    }
  }

  // Find pure-Python wheel
  const urls = meta.urls || [];
  let wheelUrl = null;
  for (const u of urls) {
    if (u.packagetype === 'bdist_wheel' && u.filename.endsWith('-none-any.whl')) { wheelUrl = u.url; break; }
  }
  if (!wheelUrl) {
    for (const u of urls) {
      if (u.packagetype === 'bdist_wheel') { wheelUrl = u.url; break; }
    }
  }
  if (!wheelUrl) { self.postMessage({ type: 'pip.status', data: `Skipped ${pkg} (no wheel)` }); return null; }

  const wheelResp = await fetch(wheelUrl);
  if (!wheelResp.ok) throw new Error(`Download failed: ${wheelResp.status}`);
  const wheelBytes = new Uint8Array(await wheelResp.arrayBuffer());

  const files = parseZip(wheelBytes);
  let count = 0;
  for (const [fname, data] of files) {
    try {
      const content = data instanceof Uint8Array ? data : await inflate(data.compressed);
      writeFile(`${SITE_PACKAGES}/${fname}`, content);
      count++;
    } catch { }
  }

  self.postMessage({ type: 'pip.status', data: `Installed ${name} ${version} (${count} files)` });
  return { name, version };
}

// ── Runtime ───────────────────────────────────────────────────────────────────
let wasmModule = null;

async function init(wasmUrl, stdlibUrl) {
  self.postMessage({ type: 'status', text: 'Loading stdlib...' });
  await loadStdlib(stdlibUrl);

  self.postMessage({ type: 'status', text: 'Loading python.wasm...' });
  const bytes = await fetch(wasmUrl).then(r => r.arrayBuffer());

  self.postMessage({ type: 'status', text: 'Compiling WASM...' });
  wasmModule = await WebAssembly.compile(bytes);

  self.postMessage({ type: 'ready' });
}

function runCode(code, id) {
  if (!wasmModule) {
    self.postMessage({ type: 'error', id, error: { message: 'Not initialized' } });
    return;
  }

  // Reset file descriptors for each run
  fds.clear();
  nextFd = 5;

  writeFile('/tmp/run.py', code);

  let mem = null;
  const getMem = () => mem;
  const runArgs = ['python3', '-c', "exec(open('/tmp/run.py').read()); import sys; sys.stdout.flush(); sys.stderr.flush()"];
  const envVars = ['PYTHONPATH=/usr/lib/python3.13:/usr/local/lib/python3.13/site-packages', 'PYTHONHOME=/usr', 'PYTHONUNBUFFERED=1'];
  const onStdout = (s) => self.postMessage({ type: 'stdout', data: s });
  const onStderr = (s) => self.postMessage({ type: 'stderr', data: s });

  const { wasi, flush } = buildWasi(getMem, runArgs, envVars, onStdout, onStderr);

  WebAssembly.instantiate(wasmModule, { wasi_snapshot_preview1: wasi })
    .then(inst => {
      mem = inst.exports.memory;
      try { inst.exports._start(); } catch (e) {
        if (!e.message?.startsWith('proc_exit:')) throw e;
      }
      flush();
      self.postMessage({ type: 'result', id });
    })
    .catch(e => {
      flush();
      self.postMessage({ type: 'error', id, error: { message: e.message } });
    });
}

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try { await init(msg.wasmUrl, msg.stdlibUrl); }
    catch (err) { self.postMessage({ type: 'error', id: 'init', error: { message: err.message } }); }
  } else if (msg.type === 'run') {
    runCode(msg.code, msg.id);
  } else if (msg.type === 'pip.install') {
    try {
      const result = await pipInstall(msg.package);
      self.postMessage({ type: 'pip.result', id: msg.id, value: result });
    } catch(err) {
      self.postMessage({ type: 'error', id: msg.id, error: { message: err.message } });
    }
  } else if (msg.type === 'fs.write') {
    writeFile(msg.path, msg.content);
  }
};
