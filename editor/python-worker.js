/**
 * Python WASM Worker — clean rewrite
 * Runs CPython wasm32-wasi by re-instantiating per run with correct memory closure.
 */

console.log('[worker] script loaded');
self.postMessage({ type: 'status', text: 'Worker loaded...' });

// ── VFS ───────────────────────────────────────────────────────────────────────

const vfsNodes = new Map();

// ── Persistence (OPFS) ────────────────────────────────────────────────────────
// Files under /home/user/ are automatically persisted to OPFS.
// On init: restored from OPFS → vfsNodes.
// On every fd_close of a /home/user/ file: saved to OPFS asynchronously.
// Fallback: if OPFS unavailable, files live only in memory for the session.

let opfsRoot = null; // FileSystemDirectoryHandle or null

async function opfsInit() {
  try {
    opfsRoot = await navigator.storage.getDirectory();
    // Ensure our subdirectory exists
    opfsRoot = await opfsRoot.getDirectoryHandle('python-wasm-home', { create: true });
    console.log('[opfs] OPFS available');
  } catch (e) {
    opfsRoot = null;
    console.warn('[opfs] OPFS not available, files will not persist:', e.message);
  }
}

// Convert /home/user/foo/bar.txt → opfs key "foo/bar.txt"
function opfsKey(vfsPath) {
  const prefix = '/home/user/';
  if (!vfsPath.startsWith(prefix)) return null;
  return vfsPath.slice(prefix.length);
}

// Save a single file to OPFS (fire-and-forget, errors are logged not thrown)
async function opfsSave(vfsPath) {
  if (!opfsRoot) return;
  const key = opfsKey(vfsPath);
  if (!key) return;
  const node = vfsNodes.get(norm(vfsPath));
  if (!node || node.type !== 'file') return;

  try {
    // Recreate directory structure in OPFS
    const parts = key.split('/');
    const filename = parts.pop();
    let dir = opfsRoot;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: true });
    }
    const fileHandle = await dir.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(node.content);
    await writable.close();
  } catch (e) {
    console.warn('[opfs] save failed for', vfsPath, e.message);
  }
}

// Delete a file from OPFS
async function opfsDelete(vfsPath) {
  if (!opfsRoot) return;
  const key = opfsKey(vfsPath);
  if (!key) return;
  try {
    const parts = key.split('/');
    const filename = parts.pop();
    let dir = opfsRoot;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: false });
    }
    await dir.removeEntry(filename);
  } catch { /* file may not exist */ }
}

// Restore all files from OPFS into vfsNodes on startup
async function opfsRestore() {
  if (!opfsRoot) return;
  let count = 0;
  async function walk(dirHandle, vfsPrefix) {
    for await (const [name, handle] of dirHandle.entries()) {
      const vfsPath = vfsPrefix + '/' + name;
      if (handle.kind === 'directory') {
        mkdir(vfsPath);
        await walk(handle, vfsPath);
      } else {
        const file = await handle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        writeFile(vfsPath, bytes);
        count++;
      }
    }
  }
  try {
    await walk(opfsRoot, '/home/user');
    if (count > 0) console.log(`[opfs] Restored ${count} files from OPFS`);
  } catch (e) {
    console.warn('[opfs] restore failed:', e.message);
  }
}

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

// Shared encoder for VFS string operations
const _vfsEnc = new TextEncoder();

function writeFile(path, content) {
  const p = norm(path);
  const bytes = typeof content === 'string' ? _vfsEnc.encode(content) : content;
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
  '/usr/local/lib/python3.13/site-packages',
  // Linux-like system directories
  '/etc', '/var', '/var/tmp', '/proc', '/dev',
  '/bin', '/usr/bin', '/usr/local/bin',
  '/root', '/opt',
]) mkdir(d);

// Populate /etc with minimal Linux-like files
writeFile('/etc/hostname', 'python-wasm\n');
writeFile('/etc/os-release', 'NAME="Python WASM"\nID=python-wasm\nVERSION="3.13"\n');
writeFile('/etc/passwd', 'root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:user:/home/user:/bin/sh\n');
writeFile('/etc/group', 'root:x:0:\nuser:x:1000:\n');
writeFile('/etc/timezone', 'UTC\n');
writeFile('/proc/version', 'Linux version 5.15.0 (Python WASM Runtime)\n');
writeFile('/dev/null', '');

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

// ── C-extension callback channel buffers (fd=100 write, fd=101 read) ─────────
// These are module-level so they persist across buildWasi calls within a run.
let fd101ReadBuf = new Uint8Array(0);
let fd101ReadPos = 0;

// Registry for pending C-extension initializations (populated by runCode)
const pendingCExtInits = new Map(); // moduleName -> { initFn, extInst }

// ── Build WASI imports for a given memory getter ──────────────────────────────

function buildWasi(getMem, args, envVars, onStdout, onStderr, checkInt) {
  // ── Cached DataView/Uint8Array — invalidated when WASM memory grows ──────
  // WASM memory can grow (new ArrayBuffer), so we must re-wrap on each call.
  // But we avoid creating new objects when the buffer hasn't changed.
  let _dvBuf = null, _dvObj = null;
  let _m8Buf = null, _m8Obj = null;

  const dv = () => {
    const buf = getMem().buffer;
    if (buf !== _dvBuf) { _dvBuf = buf; _dvObj = new DataView(buf); }
    return _dvObj;
  };
  const m8 = () => {
    const buf = getMem().buffer;
    if (buf !== _m8Buf) { _m8Buf = buf; _m8Obj = new Uint8Array(buf); }
    return _m8Obj;
  };

  // Shared TextDecoder/TextEncoder instances — reuse across calls
  const _dec = new TextDecoder();
  const _enc = new TextEncoder();
  const str = (ptr, len) => _dec.decode(new Uint8Array(getMem().buffer, ptr, len));

  let stdoutBuf = '', stderrBuf = '';
  let stdoutTimer = null, stderrTimer = null;

  // Smart buffering:
  // - Flush immediately on \n (line-buffered output like print())
  // - For partial lines (print(..., end="")), flush after a short delay
  //   so rapid writes are batched into one postMessage instead of many
  const FLUSH_DELAY_MS = 8; // ~1 frame at 120fps

  function scheduleFlush(getBuf, setBuf, cb, getTimer, setTimer) {
    if (getTimer()) return; // already scheduled
    setTimer(setTimeout(() => {
      setTimer(null);
      const remaining = getBuf();
      if (remaining) { cb(remaining); setBuf(''); }
    }, FLUSH_DELAY_MS));
  }

  function writeToStream(text, getBuf, setBuf, cb, getTimer, setTimer) {
    setBuf(getBuf() + text);
    const buf = getBuf();

    // Flush all complete lines immediately
    const lastNl = buf.lastIndexOf('\n');
    if (lastNl !== -1) {
      const toSend = buf.slice(0, lastNl + 1);
      setBuf(buf.slice(lastNl + 1));
      cb(toSend);
      // Cancel pending timer since we just flushed
      if (getTimer()) { clearTimeout(getTimer()); setTimer(null); }
    }

    // If there's still a partial line, schedule a delayed flush
    if (getBuf()) {
      scheduleFlush(getBuf, setBuf, cb, getTimer, setTimer);
    }
  }

  // Closure helpers for stdout/stderr state
  const getStdoutBuf = () => stdoutBuf;
  const setStdoutBuf = (v) => { stdoutBuf = v; };
  const getStdoutTimer = () => stdoutTimer;
  const setStdoutTimer = (v) => { stdoutTimer = v; };

  const getStderrBuf = () => stderrBuf;
  const setStderrBuf = (v) => { stderrBuf = v; };
  const getStderrTimer = () => stderrTimer;
  const setStderrTimer = (v) => { stderrTimer = v; };

  const impl = {
    args_sizes_get(argcPtr, bufSizePtr) {
      const total = args.reduce((s, a) => s + _enc.encode(a + '\0').length, 0);
      dv().setUint32(argcPtr, args.length, true);
      dv().setUint32(bufSizePtr, total, true);
      return ESUCCESS;
    },
    args_get(argvPtr, argvBufPtr) {
      let off = argvBufPtr;
      for (let i = 0; i < args.length; i++) {
        dv().setUint32(argvPtr + i * 4, off, true);
        const b = _enc.encode(args[i] + '\0'); m8().set(b, off); off += b.length;
      }
      return ESUCCESS;
    },
    environ_sizes_get(countPtr, bufSizePtr) {
      const total = envVars.reduce((s, e) => s + _enc.encode(e + '\0').length, 0);
      dv().setUint32(countPtr, envVars.length, true);
      dv().setUint32(bufSizePtr, total, true);
      return ESUCCESS;
    },
    environ_get(envPtr, envBufPtr) {
      let off = envBufPtr;
      for (let i = 0; i < envVars.length; i++) {
        dv().setUint32(envPtr + i * 4, off, true);
        const b = _enc.encode(envVars[i] + '\0'); m8().set(b, off); off += b.length;
      }
      return ESUCCESS;
    },

    fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
      if (checkInt) checkInt();
      let total = 0;
      const dvv = dv(); // cache for this call
      for (let i = 0; i < iovsLen; i++) {
        const base = dvv.getUint32(iovsPtr + i * 8, true);
        const len  = dvv.getUint32(iovsPtr + i * 8 + 4, true);
        if (!len) continue;
        if (fd === 1 || fd === 2) {
          // Decode directly from WASM memory — no copy needed
          const text = _dec.decode(new Uint8Array(getMem().buffer, base, len));
          if (fd === 1) writeToStream(text, getStdoutBuf, setStdoutBuf, onStdout, getStdoutTimer, setStdoutTimer);
          else          writeToStream(text, getStderrBuf, setStderrBuf, onStderr, getStderrTimer, setStderrTimer);
        } else if (fd === 100) {
          const text = _dec.decode(new Uint8Array(getMem().buffer, base, len));
          const cmd = text.trim();
          let response;

          if (cmd.startsWith('CEXT_INIT:')) {
            const moduleName = cmd.slice('CEXT_INIT:'.length);
            const entry = pendingCExtInits.get(moduleName);
            if (entry) {
              try {
                const modulePtr = entry.initFn();
                response = modulePtr ? `OK:${modulePtr.toString(16)}\n` : `ERR:null_ptr\n`;
                console.log(`[cext] PyInit_${moduleName}() = ${modulePtr}`);
              } catch (e) {
                response = `ERR:${e.message}\n`;
              }
            } else {
              response = `ERR:not_registered\n`;
            }

          } else if (cmd.startsWith('CALL:')) {
            // Format: "CALL:{module}:{func}:{json_args}"
            const parts = cmd.slice('CALL:'.length).split(':');
            const moduleName = parts[0];
            const funcName = parts[1];
            const argsJson = parts.slice(2).join(':');
            const entry = pendingCExtInits.get(moduleName);
            if (entry) {
              try {
                const callArgs = JSON.parse(argsJson || '[]');
                const extExports = entry.extInst.exports;
                const wasmFn = extExports[`wasm_${funcName}`];
                if (typeof wasmFn !== 'function') {
                  throw new Error(`wasm_${funcName} not exported by ${moduleName}.wasm`);
                }
                const result = wasmFn(...callArgs);
                // Determine return type: if result is a number and the C function
                // returns const char*, read it as a null-terminated string from
                // the shared CPython memory (extension uses --import-memory).
                let jsResult;
                if (typeof result === 'number') {
                  // Heuristic: if result looks like a pointer (> 0 and < memory size),
                  // try to read it as a C string. Otherwise treat as integer.
                  const mem = getMem();
                  if (result > 0 && result < mem.buffer.byteLength) {
                    const bytes = new Uint8Array(mem.buffer, result);
                    let end = 0;
                    // Read until null terminator or 4096 bytes max
                    while (end < 4096 && bytes[end] !== 0) end++;
                    if (end > 0 && end < 4096) {
                      jsResult = _dec.decode(bytes.subarray(0, end));
                    } else {
                      jsResult = result; // plain integer
                    }
                  } else {
                    jsResult = result;
                  }
                } else {
                  jsResult = result;
                }
                response = `OK:${JSON.stringify(jsResult)}\n`;
              } catch (e) {
                response = `ERR:${e.message}\n`;
              }
            } else {
              response = `ERR:module_not_found:${moduleName}\n`;
            }
          } else {
            response = `ERR:unknown_command\n`;
          }

          fd101ReadBuf = _enc.encode(response);
          fd101ReadPos = 0;
        }
        else {
          const desc = fds.get(fd); if (!desc) return EBADF;
          const chunk = m8().subarray(base, base + len); // view, no copy
          const pos = Number(desc.pos); const cur = desc.node.content || new Uint8Array(0);
          const nc = new Uint8Array(Math.max(cur.length, pos + len));
          nc.set(cur); nc.set(chunk, pos); desc.node.content = nc;
          desc.pos += BigInt(len);
        }
        total += len;
      }
      dv().setUint32(nwrittenPtr, total, true);
      return ESUCCESS;
    },

    fd_read(fd, iovsPtr, iovsLen, nreadPtr) {
      const dvv = dv();
      if (fd === 0) { dvv.setUint32(nreadPtr, 0, true); return ESUCCESS; }
      if (fd === 101) {
        let total = 0;
        for (let i = 0; i < iovsLen; i++) {
          const base = dvv.getUint32(iovsPtr + i * 8, true);
          const len  = dvv.getUint32(iovsPtr + i * 8 + 4, true);
          if (!len) continue;
          const avail = fd101ReadBuf.length - fd101ReadPos;
          if (avail <= 0) break;
          const n = Math.min(len, avail);
          m8().set(fd101ReadBuf.subarray(fd101ReadPos, fd101ReadPos + n), base);
          fd101ReadPos += n;
          total += n;
        }
        dvv.setUint32(nreadPtr, total, true);
        return ESUCCESS;
      }
      const desc = fds.get(fd); if (!desc) return EBADF;
      const content = desc.node.content;
      if (!content || content.length === 0) { dvv.setUint32(nreadPtr, 0, true); return ESUCCESS; }
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const base = dvv.getUint32(iovsPtr + i * 8, true);
        const len  = dvv.getUint32(iovsPtr + i * 8 + 4, true);
        if (!len) continue;
        const pos = Number(desc.pos); const avail = content.length - pos;
        if (avail <= 0) break;
        const n = Math.min(len, avail);
        m8().set(content.subarray(pos, pos + n), base);
        desc.pos += BigInt(n); total += n;
      }
      dvv.setUint32(nreadPtr, total, true);
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

    fd_close(fd) {
      const desc = fds.get(fd);
      if (desc) {
        // Auto-save /home/user/ files to OPFS when closed
        if (desc.path.startsWith('/home/user/') && desc.node.type === 'file') {
          opfsSave(desc.path); // fire-and-forget
        }
      }
      fds.delete(fd);
      return ESUCCESS;
    },

    fd_fdstat_get(fd, statPtr) {
      const node = fds.get(fd)?.node;
      // fd=100 (cext write) and fd=101 (cext read) are character devices
      const ft = (fd <= 2 || fd === 100 || fd === 101) ? 2 : (node?.type === 'dir' ? 3 : 4);
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
      if (fd === 3) { m8().set(_enc.encode('/').subarray(0, pathLen), pathPtr); return ESUCCESS; }
      if (fd === 4) { m8().set(_enc.encode('/home/user').subarray(0, pathLen), pathPtr); return ESUCCESS; }
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
      const p = norm(rel.startsWith('/') ? rel : base + '/' + rel);
      vfsNodes.delete(p);
      // Remove from OPFS if it was a persisted file
      if (p.startsWith('/home/user/')) opfsDelete(p);
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
      let written = 0;
      const cookie = Number(_cookie);
      const entries = [...desc.node.children];
      const dvv = dv();
      for (let idx = cookie; idx < entries.length; idx++) {
        const name = entries[idx];
        const nameBytes = _enc.encode(name);
        const entrySize = 24 + nameBytes.length;
        if (written + entrySize > bufLen) {
          dvv.setUint32(bufusedPtr, bufLen, true);
          return ESUCCESS;
        }
        const base = bufPtr + written;
        const childPath = desc.path === '/' ? '/' + name : desc.path + '/' + name;
        const childNode = vfsNodes.get(norm(childPath));
        const ft = childNode?.type === 'dir' ? 3 : 4;
        dvv.setBigUint64(base,      BigInt(idx + 1), true);
        dvv.setBigUint64(base + 8,  BigInt(idx + 1), true);
        dvv.setUint32(base + 16,    nameBytes.length, true);
        dvv.setUint8(base + 20,     ft);
        m8().set(nameBytes, base + 24);
        written += entrySize;
      }
      dvv.setUint32(bufusedPtr, written, true);
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
      // Cancel pending timers and flush remaining buffers immediately
      if (stdoutTimer) { clearTimeout(stdoutTimer); stdoutTimer = null; }
      if (stderrTimer) { clearTimeout(stderrTimer); stderrTimer = null; }
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

// ── Dynamic C-extension loader ────────────────────────────────────────────────

// Registry: moduleName -> { wasmBytes, module (compiled) }
// We store compiled WebAssembly.Module so we can re-instantiate per CPython run
const cExtRegistry = new Map(); // moduleName -> { wasmBytes: Uint8Array, wasmModule: WebAssembly.Module }

/**
 * Register a C-extension by compiling its WASM bytes.
 * Actual linking with CPython happens inside runCode() per-run.
 */
async function registerCExtension(moduleName, wasmBytes) {
  try {
    const wasmModule = await WebAssembly.compile(wasmBytes);
    cExtRegistry.set(moduleName, { wasmBytes, wasmModule });
    self.postMessage({ type: 'stdout', data: `[cext] Registered C-extension: ${moduleName}\n` });
    return true;
  } catch (e) {
    self.postMessage({ type: 'stderr', data: `[cext] Failed to compile ${moduleName}: ${e.message}\n` });
    return false;
  }
}

/**
 * Instantiate all registered C-extensions against a live CPython instance.
 * Returns a Map<moduleName, PyObject_ptr> — the pointer returned by PyInit_*.
 *
 * Called from runCode() after the CPython WASM instance is created but
 * BEFORE _start() runs, so we can call PyImport_AppendInittab.
 *
 * Actually we call it AFTER _start() via PyImport_AddModule +
 * PyDict_SetItemString to inject into sys.modules directly.
 */
async function instantiateCExtensions(cpythonInst) {
  const results = new Map(); // moduleName -> instance
  for (const [moduleName, entry] of cExtRegistry) {
    try {
      // Build env from CPython exports — pass all functions + shared memory
      const env = { memory: cpythonInst.exports.memory };
      for (const [name, val] of Object.entries(cpythonInst.exports)) {
        if (typeof val === 'function') env[name] = val;
      }
      const extInst = await WebAssembly.instantiate(entry.wasmModule, {
        env,
        wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 }),
      });
      results.set(moduleName, extInst);
      console.log(`[cext] Instantiated ${moduleName}, exports:`, Object.keys(extInst.exports).join(', '));
    } catch (e) {
      console.error(`[cext] Failed to instantiate ${moduleName}:`, e.message);
      self.postMessage({ type: 'stderr', data: `[cext] Failed to link ${moduleName}: ${e.message}\n` });
    }
  }
  return results;
}

/**
 * After Python is initialized (_start ran), inject C-extension modules
 * into sys.modules using the Python C API exported by CPython WASM.
 *
 * Flow:
 *   1. Call extInst.exports.PyInit_{moduleName}() → returns PyObject* (module ptr)
 *   2. Call cpython.PyImport_AddModule("moduleName") to create entry in sys.modules
 *   3. Call cpython.PySys_GetObject("modules") → sys.modules dict ptr
 *   4. Call cpython.PyDict_SetItemString(modules_ptr, "moduleName", module_ptr)
 */
function injectCExtensionsIntoSysModules(cpythonInst, extInstances) {
  const exp = cpythonInst.exports;
  const mem = exp.memory;

  // Helper: write a null-terminated UTF-8 string into WASM memory at a scratch area.
  // We use a fixed scratch buffer at offset 64 (well below Python's heap which starts ~1MB).
  // This is safe because Python hasn't started yet when we first call this,
  // but we call it AFTER _start, so we need a safe area.
  // Use a high-but-safe address: 4096 (page 1, before Python's typical heap start).
  const SCRATCH = 4096;
  const enc = new TextEncoder();

  function writeStr(str) {
    const bytes = enc.encode(str + '\0');
    new Uint8Array(mem.buffer, SCRATCH, bytes.length).set(bytes);
    return SCRATCH;
  }

  const PySys_GetObject       = exp.PySys_GetObject;
  const PyDict_SetItemString  = exp.PyDict_SetItemString;
  const PyImport_AddModule    = exp.PyImport_AddModule;

  if (!PySys_GetObject || !PyDict_SetItemString) {
    console.warn('[cext] CPython C API not available (PySys_GetObject / PyDict_SetItemString missing)');
    return;
  }

  // Get sys.modules dict pointer
  const modulesNamePtr = writeStr('modules');
  const sysModulesPtr = PySys_GetObject(modulesNamePtr);
  if (!sysModulesPtr) {
    console.warn('[cext] PySys_GetObject("modules") returned null');
    return;
  }

  for (const [moduleName, extInst] of extInstances) {
    const initFnName = `PyInit_${moduleName}`;
    const initFn = extInst.exports[initFnName];
    if (typeof initFn !== 'function') {
      console.warn(`[cext] ${initFnName} not found in extension exports`);
      self.postMessage({ type: 'stderr', data: `[cext] ${initFnName} not exported by ${moduleName}.wasm\n` });
      continue;
    }

    try {
      // Call PyInit_testmodule() — returns PyObject* pointing to the module
      const modulePtr = initFn();
      if (!modulePtr) {
        console.warn(`[cext] ${initFnName}() returned null`);
        continue;
      }

      // Register in sys.modules: sys.modules["moduleName"] = modulePtr
      const namePtr = writeStr(moduleName);
      const rc = PyDict_SetItemString(sysModulesPtr, namePtr, modulePtr);
      if (rc === 0) {
        console.log(`[cext] ✓ ${moduleName} injected into sys.modules`);
        self.postMessage({ type: 'stdout', data: `[cext] ✓ ${moduleName} ready\n` });
      } else {
        console.warn(`[cext] PyDict_SetItemString failed for ${moduleName}, rc=${rc}`);
      }
    } catch (e) {
      console.error(`[cext] Error injecting ${moduleName}:`, e.message);
      self.postMessage({ type: 'stderr', data: `[cext] Error injecting ${moduleName}: ${e.message}\n` });
    }
  }
}

/**
 * Build Python bootstrap code that registers C-extensions via a custom loader.
 * Runs BEFORE user code (prepended to /tmp/run.py).
 * Only active when C-extensions are registered — no-op otherwise.
 * Uses a private namespace to avoid polluting user's globals.
 */
function buildCExtBootstrapCode() {
  if (cExtRegistry.size === 0) return '';
  const names = JSON.stringify([...cExtRegistry.keys()]);
  // Wrapped in a function to avoid leaking names into user namespace
  return `
def __wasm_register_cext_finders():
    import sys
    import importlib.abc
    import importlib.machinery
    import types

    class _Loader(importlib.abc.Loader):
        def __init__(self, name): self._name = name
        def create_module(self, spec): return types.ModuleType(self._name)
        def exec_module(self, mod): pass  # real module already in sys.modules via sitecustomize

    class _Finder(importlib.abc.MetaPathFinder):
        _MODS = set(${names})
        def find_spec(self, name, path, target=None):
            if name in self._MODS and name not in sys.modules:
                return importlib.machinery.ModuleSpec(name, _Loader(name))
            return None

    sys.meta_path.insert(0, _Finder())

__wasm_register_cext_finders()
del __wasm_register_cext_finders
`;
}

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
  return { name, version };}

// ── Main ──────────────────────────────────────────────────────────────────────

let wasmModule = null;

async function init() {
  self.postMessage({ type: 'status', text: 'Loading stdlib...' });
  await loadStdlib();

  // Init OPFS and restore persisted /home/user/ files
  await opfsInit();
  await opfsRestore();

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

async function runCode(code, id) {
  if (!wasmModule) {
    self.postMessage({ type: 'error', id, error: { type: 'RuntimeError', message: 'Not initialized', traceback: '' } });
    return;
  }

  // Reset file descriptors for each run — new WASM instance gets fresh fds
  fds.clear();
  nextFd = 5;

  // Reset C-extension callback channel buffers
  fd101ReadBuf = new Uint8Array(0);
  fd101ReadPos = 0;

  // ── Build the script to run ───────────────────────────────────────────────
  // Do NOT prepend bootstrap code — testmodule.py is already in site-packages
  // and Python will find it via the standard import machinery.
  // The bootstrap finder is only needed as a last-resort fallback and
  // must NOT run before site-packages is searched.
  const codeWithFlush = code + '\nimport sys as _sys\n_sys.stdout.flush()\n_sys.stderr.flush()\n';

  writeFile('/tmp/run.py', codeWithFlush);
  const runArgs = ['python3', '-c', "exec(open('/tmp/run.py').read()); import sys; sys.stdout.flush(); sys.stderr.flush()"];

  // Memory holder — will be set once instance is created
  let mem = null;
  const getMem = () => mem;

  const envVars = ['PYTHONPATH=/usr/lib/python3.13:/usr/local/lib/python3.13/site-packages', 'PYTHONHOME=/usr', 'PYTHONUNBUFFERED=1'];
  const onStdout = (s) => self.postMessage({ type: 'stdout', data: s });
  const onStderr = (s) => self.postMessage({ type: 'stderr', data: s });
  const checkInt = () => {};

  const { wasi, flush } = buildWasi(getMem, runArgs, envVars, onStdout, onStderr, checkInt);

  try {
    const inst = await WebAssembly.instantiate(wasmModule, { wasi_snapshot_preview1: wasi });
    mem = inst.exports.memory;

    // ── Link C-extensions with this CPython instance ──────────────────────
    // Instantiate all registered C-extension WASM modules against this
    // CPython instance (shared memory). Then write sitecustomize.py which
    // Python auto-imports at startup. sitecustomize.py uses fd=100/101
    // to call PyInit_* synchronously and inject the result into sys.modules.
    const extInstances = await instantiateCExtensions(inst);
    if (extInstances.size > 0) {
      writeSitecustomize(extInstances);
    }

    try {
      inst.exports._start();
    } catch (e) {
      if (!e.message?.startsWith('proc_exit:')) throw e;
    }

    flush();
    self.postMessage({ type: 'result', id, value: 'null' });
  } catch (e) {
    flush();
    self.postMessage({ type: 'error', id, error: { type: e.name, message: e.message, traceback: e.stack || '' } });
  }
}

/**
 * Write sitecustomize.py into the VFS.
 * Python auto-imports this at startup (via site.py), BEFORE user code runs.
 *
 * Since ctypes._ctypes is not available in WASM, we use a different approach:
 * JS sends Python-executable code via fd=101 that creates the module using
 * types.ModuleType and populates it with functions that call back into JS
 * via os.write/os.read on fd=100/101.
 *
 * For testmodule specifically: we know the API (hello, add).
 * JS generates Python wrapper code for each exported function.
 */
function writeSitecustomize(extInstances) {
  const moduleData = {};

  for (const [moduleName, extInst] of extInstances) {
    const initFnName = `PyInit_${moduleName}`;
    const initFn = extInst.exports[initFnName];
    if (typeof initFn !== 'function') {
      console.warn(`[cext] ${initFnName} not found in extension exports`);
      continue;
    }
    moduleData[moduleName] = { initFn, extInst };
  }

  if (Object.keys(moduleData).length === 0) return;

  // Register init functions so fd=100 handler can call them
  for (const [moduleName, data] of Object.entries(moduleData)) {
    pendingCExtInits.set(moduleName, data);
  }

  const moduleNames = Object.keys(moduleData);

  // sitecustomize.py uses fd=100/101 protocol:
  // Write: "CEXT_INIT:{name}\n"  → JS calls PyInit_{name}()
  // Read:  "OK:{hexptr}\n"       → but ctypes unavailable in WASM
  //
  // Alternative protocol:
  // Write: "CEXT_CODE:{name}\n"  → JS returns Python code to exec
  // Read:  Python source code ending with "\0"
  //
  // The Python code JS returns creates a types.ModuleType and populates
  // it with wrapper functions that use the fd=100/101 channel for calls.
  //
  // Even simpler: JS pre-generates the Python module code and writes it
  // directly to a .py file in VFS. sitecustomize.py just imports it.
  // This avoids any fd protocol complexity.

  for (const [moduleName, data] of Object.entries(moduleData)) {
    const pyCode = generatePythonModuleCode(moduleName, data.extInst);
    if (pyCode) {
      // Write as a .py file that Python can import normally
      writeFile(`/usr/local/lib/python3.13/site-packages/${moduleName}.py`, pyCode);
      console.log(`[cext] Wrote Python wrapper for ${moduleName}`);
    }
  }

  // sitecustomize.py is now minimal — just a marker comment
  const sitecustomize = `# sitecustomize.py — WASM C-extensions loaded as Python wrappers in site-packages\n`;

  writeFile('/usr/lib/python3.13/sitecustomize.py', sitecustomize);
}

/**
 * Generate Python wrapper code for a C-extension.
 * Discovers wasm_{funcName} exports and creates Python wrapper functions
 * that call them via the fd=100/101 RPC channel.
 * Falls back to hardcoded wrappers for known modules if wasm_* not exported.
 */
function generatePythonModuleCode(moduleName, extInst) {
  // Find all wasm_* exports (public C functions with raw C types)
  const wasmFuncs = Object.keys(extInst.exports)
    .filter(name => name.startsWith('wasm_') && typeof extInst.exports[name] === 'function')
    .map(name => name.slice('wasm_'.length));

  if (wasmFuncs.length === 0) {
    console.warn(`[cext] No wasm_* exports found in ${moduleName} — module will be empty stub. Rebuild with --export=wasm_{funcName}`);
  }

  const effectiveFuncs = wasmFuncs;

  const funcDefs = effectiveFuncs.map(fn => `
def ${fn}(*args):
    return _wasm_call("${moduleName}", "${fn}", *args)
`).join('\n');

  // Functions defined at module level automatically become module attributes.
  // No need for _mod.hello = hello or sys.modules manipulation.
  return `
# ${moduleName}.py — auto-generated WASM C-extension wrapper
# Uses fd=100/101 RPC channel to call real WASM functions
import os as _os
import json as _json

def _wasm_call(module, func, *args):
    """Call a WASM C-extension function via fd=100/101 RPC."""
    cmd = ("CALL:" + module + ":" + func + ":" + _json.dumps(list(args)) + "\\n").encode()
    _os.write(100, cmd)
    result = b""
    while not result.endswith(b"\\n"):
        chunk = _os.read(101, 256)
        if not chunk:
            break
        result += chunk
    resp = result.strip().decode()
    if resp.startswith("OK:"):
        return _json.loads(resp[3:])
    raise RuntimeError("WASM call failed: " + resp)

${funcDefs}
`;
}

// Registry for pending C-extension initializations (used by WASI fd=100 handler)
// (declared above near WASI constants)

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
  else if (type === 'cext.register') {
    // Register a C-extension WASM module by name + bytes.
    // It will be linked with CPython on the next runCode() call.
    try {
      const ok = await registerCExtension(e.data.moduleName, e.data.wasmBytes);
      self.postMessage({ type: 'result', id, value: ok ? 'registered' : 'failed' });
    } catch(err) {
      self.postMessage({ type: 'error', id, error: { type: err.name, message: err.message, traceback: '' } });
    }
  }
  else if (type === 'load.extension') {
    // Legacy handler — redirect to cext.register
    try {
      const ok = await registerCExtension(e.data.moduleName, e.data.wasmBytes);
      self.postMessage({ type: 'result', id, value: ok ? 'registered' : 'failed' });
    } catch(err) {
      self.postMessage({ type: 'error', id, error: { type: err.name, message: err.message, traceback: '' } });
    }
  }
  else if (type === 'fs.write') {
    writeFile(path, content);
    // Also persist to OPFS if under /home/user/
    if (path && norm(path).startsWith('/home/user/')) opfsSave(path);
    self.postMessage({ type: 'fs.result', id, value: null });
  }
  else if (type === 'fs.read')  { self.postMessage({ type: 'fs.result', id, value: readFile(path) }); }
  else if (type === 'fs.list') {
    // List all files under /home/user/ with their sizes
    const files = [];
    for (const [p, node] of vfsNodes.entries()) {
      if (p.startsWith('/home/user/') && node.type === 'file') {
        files.push({ path: p, size: node.content?.length ?? 0, mtime: node.mtime });
      }
    }
    self.postMessage({ type: 'fs.result', id, value: files });
  }
  else if (type === 'fs.delete') {
    const p = norm(path);
    vfsNodes.delete(p);
    opfsDelete(p);
    self.postMessage({ type: 'fs.result', id, value: null });
  }
};

self.postMessage({ type: 'status', text: 'Starting...' });
init().catch(err => {
  self.postMessage({ type: 'error', id: 'init', error: { type: err.name, message: err.message, traceback: err.stack || '' } });
});
