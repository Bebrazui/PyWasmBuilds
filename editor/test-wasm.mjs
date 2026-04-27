import { readFileSync, existsSync } from 'fs';
import { createRequire } from 'module';

// Minimal WASI shim for Node.js test
const ESUCCESS = 0, EBADF = 8, ENOENT = 44, ENOSYS = 52;

// VFS
const vfsNodes = new Map();
function norm(p) {
  if (!p.startsWith('/')) p = '/' + p;
  const out = [];
  for (const s of p.split('/').filter(Boolean)) {
    if (s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return '/' + out.join('/');
}
function mkdir(p) {
  p = norm(p);
  if (vfsNodes.has(p)) return;
  vfsNodes.set(p, { type: 'dir', children: new Set(), mtime: Date.now() });
  if (p !== '/') {
    const par = p.slice(0, p.lastIndexOf('/')) || '/';
    mkdir(par);
    vfsNodes.get(par)?.children.add(p.slice(p.lastIndexOf('/') + 1));
  }
}
function writeVfs(path, content) {
  const p = norm(path);
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  const par = p.slice(0, p.lastIndexOf('/')) || '/';
  mkdir(par);
  vfsNodes.set(p, { type: 'file', content: bytes, mtime: Date.now() });
  vfsNodes.get(par)?.children.add(p.slice(p.lastIndexOf('/') + 1));
}

for (const d of ['/', '/home', '/home/user', '/tmp', '/usr', '/usr/lib',
  '/usr/local', '/usr/local/lib', '/usr/local/lib/python3.13',
  '/usr/local/lib/python3.13/site-packages']) mkdir(d);

// Load stdlib
console.log('Loading stdlib...');
const AdmZip = await import('adm-zip').catch(() => null);
if (AdmZip) {
  // use adm-zip if available
} else {
  // Manual zip parse with deflate support
  const zipBytes = readFileSync('./python313-stdlib.zip');
  const { inflateRawSync } = await import('zlib');
  let i = 0;
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let count = 0;
  while (i + 4 <= zipBytes.length) {
    if (dv.getUint32(i, true) !== 0x04034b50) break;
    const comp = dv.getUint16(i + 8, true);
    const compSize = dv.getUint32(i + 18, true);
    const nameLen = dv.getUint16(i + 26, true);
    const extraLen = dv.getUint16(i + 28, true);
    const name = new TextDecoder().decode(zipBytes.subarray(i + 30, i + 30 + nameLen));
    const dataOff = i + 30 + nameLen + extraLen;
    const data = zipBytes.subarray(dataOff, dataOff + compSize);
    if (!name.endsWith('/')) {
      const dest = '/usr/lib/python3.13/' + (name.startsWith('Lib/') ? name.slice(4) : name);
      try {
        const content = comp === 0 ? data.slice() : inflateRawSync(data);
        writeVfs(dest, content);
        count++;
      } catch { /* skip */ }
    }
    i = dataOff + compSize;
  }
  console.log(`Stdlib: ${count} files extracted`);
}

writeVfs('/tmp/run.py', 'import sys\nprint("Hello from Python WASM!")\nprint(1+1)\nsys.stdout.flush()\nsys.stderr.flush()\n');

// FDs
const fds = new Map();
let nextFd = 5;
function fdOpen(path, oflags) {
  const p = norm(path);
  const CREAT = 0x1, TRUNC = 0x8;
  let node = vfsNodes.get(p);
  if (!node) {
    if (oflags & CREAT) { writeVfs(p, Buffer.alloc(0)); node = vfsNodes.get(p); }
    else return -1;
  }
  if ((oflags & TRUNC) && node.type === 'file') node.content = Buffer.alloc(0);
  const fd = nextFd++;
  fds.set(fd, { path: p, node, pos: 0n });
  return fd;
}

// Memory holder
let mem = null;
const getMem = () => mem;
const dv = () => new DataView(mem.buffer);
const m8 = () => new Uint8Array(mem.buffer);
const str = (ptr, len) => new TextDecoder().decode(new Uint8Array(mem.buffer, ptr, len));

const runArgs = ['python3', '-c', "exec(open('/tmp/run.py').read()); import sys; sys.stdout.flush(); sys.stderr.flush()"];
const envVars = ['PYTHONPATH=/usr/lib/python3.13', 'PYTHONHOME=/usr', 'PYTHONUNBUFFERED=1'];

const wasi = {
  args_sizes_get(argcPtr, bufSizePtr) {
    const total = runArgs.reduce((s, a) => s + Buffer.from(a + '\0').length, 0);
    dv().setUint32(argcPtr, runArgs.length, true);
    dv().setUint32(bufSizePtr, total, true);
    return ESUCCESS;
  },
  args_get(argvPtr, argvBufPtr) {
    let off = argvBufPtr;
    for (let i = 0; i < runArgs.length; i++) {
      dv().setUint32(argvPtr + i * 4, off, true);
      const b = Buffer.from(runArgs[i] + '\0');
      m8().set(b, off); off += b.length;
    }
    return ESUCCESS;
  },
  environ_sizes_get(countPtr, bufSizePtr) {
    const total = envVars.reduce((s, e) => s + Buffer.from(e + '\0').length, 0);
    dv().setUint32(countPtr, envVars.length, true);
    dv().setUint32(bufSizePtr, total, true);
    return ESUCCESS;
  },
  environ_get(envPtr, envBufPtr) {
    let off = envBufPtr;
    for (let i = 0; i < envVars.length; i++) {
      dv().setUint32(envPtr + i * 4, off, true);
      const b = Buffer.from(envVars[i] + '\0');
      m8().set(b, off); off += b.length;
    }
    return ESUCCESS;
  },
  fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
    let total = 0;
    for (let i = 0; i < iovsLen; i++) {
      const base = dv().getUint32(iovsPtr + i * 8, true);
      const len  = dv().getUint32(iovsPtr + i * 8 + 4, true);
      if (!len) continue;
      const chunk = Buffer.from(mem.buffer, base, len);
      if (fd === 1) { process.stdout.write(chunk); }
      else if (fd === 2) { process.stderr.write(chunk); }
      else {
        console.log(`  fd_write fd=${fd} len=${len}`);
        const desc = fds.get(fd);
        if (desc) {
          const pos = Number(desc.pos);
          const cur = desc.node.content || Buffer.alloc(0);
          const nc = Buffer.alloc(Math.max(cur.length, pos + chunk.length));
          cur.copy(nc); chunk.copy(nc, pos);
          desc.node.content = nc; desc.pos += BigInt(chunk.length);
        }
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
      const content = desc.node.content || Buffer.alloc(0);
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
    d.setBigUint64(statPtr, 1n, true);
    d.setBigUint64(statPtr + 8, 1n, true);
    d.setUint8(statPtr + 16, ft);
    d.setBigUint64(statPtr + 24, 1n, true);
    d.setBigUint64(statPtr + 32, size, true);
    d.setBigUint64(statPtr + 40, t, true);
    d.setBigUint64(statPtr + 48, t, true);
    d.setBigUint64(statPtr + 56, t, true);
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
    if (fd === 3) { m8().set(Buffer.from('/').subarray(0, pathLen), pathPtr); return ESUCCESS; }
    if (fd === 4) { m8().set(Buffer.from('/home/user').subarray(0, pathLen), pathPtr); return ESUCCESS; }
    return EBADF;
  },
  path_open(dirfd, _df, pathPtr, pathLen, oflags, _rb, _ri, _ff, openedFdPtr) {
    const rel = str(pathPtr, pathLen);
    const base = dirfd === 4 ? '/home/user' : '/';
    const p = norm(rel.startsWith('/') ? rel : base + '/' + rel);
    const fd = fdOpen(p, oflags);
    if (fd < 0) return ENOENT;
    dv().setUint32(openedFdPtr, fd, true); return ESUCCESS;
  },
  path_create_directory(dirfd, pathPtr, pathLen) {
    const rel = str(pathPtr, pathLen);
    const base = dirfd === 4 ? '/home/user' : '/';
    mkdir(norm(rel.startsWith('/') ? rel : base + '/' + rel));
    return ESUCCESS;
  },
  path_unlink_file(dirfd, pathPtr, pathLen) {
    const rel = str(pathPtr, pathLen);
    const base = dirfd === 4 ? '/home/user' : '/';
    vfsNodes.delete(norm(rel.startsWith('/') ? rel : base + '/' + rel));
    return ESUCCESS;
  },
  path_filestat_get(dirfd, _flags, pathPtr, pathLen, statPtr) {
    const rel = str(pathPtr, pathLen);
    const base = dirfd === 4 ? '/home/user' : '/';
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
  path_readlink(_d, _pp, _pl, _b, _bl, bufusedPtr) { dv().setUint32(bufusedPtr, 0, true); return ENOENT; },
  path_rename: () => ENOSYS,
  path_remove_directory: () => ENOSYS,
  fd_readdir(fd, bufPtr, bufLen, _cookie, bufusedPtr) {
    const desc = fds.get(fd);
    if (!desc || desc.node.type !== 'dir') { dv().setUint32(bufusedPtr, 0, true); return ESUCCESS; }
    const enc = new TextEncoder();
    let written = 0;
    let next = 1n;
    const cookie = Number(_cookie);
    const entries = [...desc.node.children];
    for (let idx = cookie; idx < entries.length; idx++) {
      const name = entries[idx];
      const nameBytes = enc.encode(name);
      const entrySize = 24 + nameBytes.length;
      if (written + entrySize > bufLen) break;
      const base = bufPtr + written;
      const childPath = desc.path === '/' ? '/' + name : desc.path + '/' + name;
      const childNode = vfsNodes.get(norm(childPath));
      const ft = childNode?.type === 'dir' ? 3 : 4;
      // d_next(u64) d_ino(u64) d_namlen(u32) d_type(u8) [3 pad] name
      dv().setBigUint64(base, BigInt(idx + 1), true);      // d_next = next cookie
      dv().setBigUint64(base + 8, BigInt(idx + 1), true);  // d_ino
      dv().setUint32(base + 16, nameBytes.length, true);   // d_namlen
      dv().setUint8(base + 20, ft);                        // d_type
      m8().set(nameBytes, base + 24);
      written += entrySize;
    }
    dv().setUint32(bufusedPtr, written, true);
    return ESUCCESS;
  },
  clock_time_get(clockId, _p, timePtr) {
    const ms = clockId === 1 ? performance.now() : Date.now();
    dv().setBigUint64(timePtr, BigInt(Math.floor(ms * 1_000_000)), true); return ESUCCESS;
  },
  clock_res_get(_id, resPtr) { dv().setBigUint64(resPtr, 1n, true); return ESUCCESS; },
  random_get(bufPtr, bufLen) {
    const buf = new Uint8Array(mem.buffer, bufPtr, bufLen);
    for (let i = 0; i < bufLen; i++) buf[i] = Math.random() * 256;
    return ESUCCESS;
  },
  proc_exit(code) { throw new Error('proc_exit:' + code); },
  sched_yield: () => ESUCCESS,
};

const wasiProxy = new Proxy(wasi, {
  get(t, p) {
    if (p in t) return t[p];
    return (...args) => {
      if (p !== 'fd_filestat_get' && p !== 'fd_tell' && p !== 'path_readlink') {
        console.warn('[WASI stub]', p, 'args[0]=', args[0]);
      }
      return ENOSYS;
    };
  }
});

console.log('Loading python.wasm...');
const wasmBytes = readFileSync('./python.wasm');
console.log(`WASM size: ${(wasmBytes.length / 1024 / 1024).toFixed(1)} MB`);

const mod = await WebAssembly.compile(wasmBytes);
console.log('Compiled. Instantiating...');

const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasiProxy });
mem = inst.exports.memory;
console.log('Running python3 -u /tmp/run.py ...');
// Debug: check VFS
console.log('VFS check:');
console.log('  /usr/lib/python3.13:', vfsNodes.has('/usr/lib/python3.13') ? 'EXISTS' : 'MISSING');
console.log('  /usr/lib/python3.13/encodings:', vfsNodes.has('/usr/lib/python3.13/encodings') ? 'EXISTS' : 'MISSING');
const sample = [...vfsNodes.keys()].filter(k => k.includes('python3.13')).slice(0, 5);
console.log('  Sample paths:', sample);
console.log('--- OUTPUT ---');

try {
  inst.exports._start();
} catch (e) {
  if (!e.message?.startsWith('proc_exit:')) {
    console.error('Error:', e.message);
  } else {
    console.log('--- EXIT:', e.message, '---');
  }
}
