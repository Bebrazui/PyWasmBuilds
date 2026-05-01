/**
 * Basic test for cpython-wasm package
 * Runs in Node.js (simulates browser environment with Worker polyfill)
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { inflateRawSync } from 'zlib';

const __dir = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dir, '../../../editor/python.wasm');
const STDLIB_PATH = join(__dir, '../../../editor/python313-stdlib.zip');

// ── Minimal Worker polyfill for Node.js ───────────────────────────────────────
// We run the worker logic directly in the same process for testing

const { createRequire } = await import('module');

// Load worker source
const workerSrc = readFileSync(join(__dir, '../dist/worker.js'), 'utf8');

// Polyfill browser globals needed by worker
const vfsNodes = new Map();
let wasmModule = null;

// Run worker inline using a simple message-passing simulation
class NodeWorker {
  constructor() {
    this._handlers = [];
    this._outHandlers = [];
    this._ready = false;
  }

  // Called by test to send message to worker
  postMessage(msg) {
    this._dispatch(msg);
  }

  // Called by worker to send message to test
  _emit(msg) {
    for (const h of this._outHandlers) h({ data: msg });
  }

  set onmessage(fn) {
    this._outHandlers = [fn];
  }

  terminate() {}
}

// Since we can't easily run the worker JS in Node without a full Worker API,
// let's test the core logic directly using the same approach as test-wasm.mjs

console.log('=== cpython-wasm package test ===\n');

// ── Direct test using worker logic ────────────────────────────────────────────

// VFS
function norm(path) {
  let p = path.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  const out = [];
  for (const s of p.split('/').filter(Boolean)) {
    if (s === '.') continue; if (s === '..') out.pop(); else out.push(s);
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
process.stdout.write('Loading stdlib... ');
const zipBytes = readFileSync(STDLIB_PATH);
let i = 0, count = 0;
const zdv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
while (i + 4 <= zipBytes.length) {
  if (zdv.getUint32(i, true) !== 0x04034b50) break;
  const comp = zdv.getUint16(i + 8, true);
  const compSize = zdv.getUint32(i + 18, true);
  const nameLen = zdv.getUint16(i + 26, true);
  const extraLen = zdv.getUint16(i + 28, true);
  const name = new TextDecoder().decode(zipBytes.subarray(i + 30, i + 30 + nameLen));
  const dataOff = i + 30 + nameLen + extraLen;
  const data = zipBytes.subarray(dataOff, dataOff + compSize);
  if (!name.endsWith('/')) {
    const dest = '/usr/lib/python3.13/' + (name.startsWith('Lib/') ? name.slice(4) : name);
    try {
      writeVfs(dest, comp === 0 ? data.slice() : inflateRawSync(data));
      count++;
    } catch {}
  }
  i = dataOff + compSize;
}
console.log(`${count} files`);

// Compile WASM
process.stdout.write('Compiling python.wasm... ');
const wasmBytes = readFileSync(WASM_PATH);
wasmModule = await WebAssembly.compile(wasmBytes);
console.log('done');

// WASI shim (same as worker)
const fds = new Map();
let nextFd = 5;
function fdOpen(path, oflags) {
  const p = norm(path);
  let node = vfsNodes.get(p);
  if (!node) {
    if (oflags & 0x1) { writeVfs(p, Buffer.alloc(0)); node = vfsNodes.get(p); }
    else return -1;
  }
  if ((oflags & 0x8) && node.type === 'file') node.content = Buffer.alloc(0);
  const fd = nextFd++;
  fds.set(fd, { path: p, node, pos: 0n });
  return fd;
}

const ESUCCESS = 0, EBADF = 8, ENOENT = 44, ENOSYS = 52;

function runPython(code) {
  return new Promise((resolve, reject) => {
    writeVfs('/tmp/run.py', code);
    let mem = null;
    const getMem = () => mem;
    const dv = () => new DataView(mem.buffer);
    const m8 = () => new Uint8Array(mem.buffer);
    const str = (ptr, len) => new TextDecoder().decode(new Uint8Array(mem.buffer, ptr, len));
    const runArgs = ['python3', '-c', "exec(open('/tmp/run.py').read()); import sys; sys.stdout.flush(); sys.stderr.flush()"];
    const envVars = ['PYTHONPATH=/usr/lib/python3.13', 'PYTHONHOME=/usr', 'PYTHONUNBUFFERED=1'];
    let stdout = '', stderr = '';

    const wasi = new Proxy({
      args_sizes_get(a, b) { const t = runArgs.reduce((s,x)=>s+Buffer.from(x+'\0').length,0); dv().setUint32(a,runArgs.length,true); dv().setUint32(b,t,true); return ESUCCESS; },
      args_get(a, b) { let off=b; for(let i=0;i<runArgs.length;i++){dv().setUint32(a+i*4,off,true);const x=Buffer.from(runArgs[i]+'\0');m8().set(x,off);off+=x.length;} return ESUCCESS; },
      environ_sizes_get(a,b){const t=envVars.reduce((s,e)=>s+Buffer.from(e+'\0').length,0);dv().setUint32(a,envVars.length,true);dv().setUint32(b,t,true);return ESUCCESS;},
      environ_get(a,b){let off=b;for(let i=0;i<envVars.length;i++){dv().setUint32(a+i*4,off,true);const x=Buffer.from(envVars[i]+'\0');m8().set(x,off);off+=x.length;}return ESUCCESS;},
      fd_write(fd,iovsPtr,iovsLen,nwPtr){let t=0;for(let i=0;i<iovsLen;i++){const base=dv().getUint32(iovsPtr+i*8,true),len=dv().getUint32(iovsPtr+i*8+4,true);if(!len)continue;const chunk=Buffer.from(mem.buffer,base,len);if(fd===1)stdout+=chunk.toString();else if(fd===2)stderr+=chunk.toString();else{const d=fds.get(fd);if(d){const pos=Number(d.pos),cur=d.node.content||Buffer.alloc(0),nc=Buffer.alloc(Math.max(cur.length,pos+chunk.length));cur.copy(nc);chunk.copy(nc,pos);d.node.content=nc;d.pos+=BigInt(chunk.length);}}t+=len;}dv().setUint32(nwPtr,t,true);return ESUCCESS;},
      fd_read(fd,iovsPtr,iovsLen,nrPtr){if(fd===0){dv().setUint32(nrPtr,0,true);return ESUCCESS;}const d=fds.get(fd);if(!d)return EBADF;let t=0;for(let i=0;i<iovsLen;i++){const base=dv().getUint32(iovsPtr+i*8,true),len=dv().getUint32(iovsPtr+i*8+4,true);if(!len)continue;const c=d.node.content||Buffer.alloc(0),pos=Number(d.pos),av=c.length-pos;if(av<=0)break;const n=Math.min(len,av);m8().set(c.subarray(pos,pos+n),base);d.pos+=BigInt(n);t+=n;}dv().setUint32(nrPtr,t,true);return ESUCCESS;},
      fd_seek(fd,lo,hi,w,p){const d=fds.get(fd);if(!d)return EBADF;const off=BigInt(lo)|(BigInt(hi)<<32n),sz=BigInt(d.node.content?.length??0);let np=w===0?off:w===1?d.pos+off:sz+off;if(np<0n)np=0n;d.pos=np;dv().setBigUint64(p,np,true);return ESUCCESS;},
      fd_close(fd){fds.delete(fd);return ESUCCESS;},
      fd_fdstat_get(fd,p){const n=fds.get(fd)?.node,ft=fd<=2?2:(n?.type==='dir'?3:4);dv().setUint8(p,ft);dv().setUint16(p+2,0,true);dv().setBigUint64(p+8,0xffffffffffffffffn,true);dv().setBigUint64(p+16,0xffffffffffffffffn,true);return ESUCCESS;},
      fd_filestat_get(fd,p){const d=fds.get(fd),n=d?.node,ft=fd<=2?2:(n?.type==='dir'?3:4),sz=BigInt(n?.content?.length??0),t=BigInt(n?.mtime??Date.now())*1_000_000n,dv2=dv();dv2.setBigUint64(p,1n,true);dv2.setBigUint64(p+8,1n,true);dv2.setUint8(p+16,ft);dv2.setBigUint64(p+24,1n,true);dv2.setBigUint64(p+32,sz,true);dv2.setBigUint64(p+40,t,true);dv2.setBigUint64(p+48,t,true);dv2.setBigUint64(p+56,t,true);return ESUCCESS;},
      fd_tell(fd,p){const d=fds.get(fd);if(!d)return EBADF;dv().setBigUint64(p,d.pos,true);return ESUCCESS;},
      fd_prestat_get(fd,p){if(fd===3){dv().setUint8(p,0);dv().setUint32(p+4,1,true);return ESUCCESS;}if(fd===4){dv().setUint8(p,0);dv().setUint32(p+4,10,true);return ESUCCESS;}return EBADF;},
      fd_prestat_dir_name(fd,p,l){if(fd===3){m8().set(Buffer.from('/').subarray(0,l),p);return ESUCCESS;}if(fd===4){m8().set(Buffer.from('/home/user').subarray(0,l),p);return ESUCCESS;}return EBADF;},
      path_open(dirfd,_,pp,pl,of,_r,_i,_f,op){const rel=str(pp,pl),base=dirfd===4?'/home/user':'/',p=norm(rel.startsWith('/')?rel:base+'/'+rel),fd=fdOpen(p,of);if(fd<0)return ENOENT;dv().setUint32(op,fd,true);return ESUCCESS;},
      path_create_directory(d,pp,pl){const rel=str(pp,pl),base=d===4?'/home/user':'/';mkdir(norm(rel.startsWith('/')?rel:base+'/'+rel));return ESUCCESS;},
      path_unlink_file(d,pp,pl){const rel=str(pp,pl),base=d===4?'/home/user':'/';vfsNodes.delete(norm(rel.startsWith('/')?rel:base+'/'+rel));return ESUCCESS;},
      path_filestat_get(d,_,pp,pl,sp){const rel=str(pp,pl),base=d===4?'/home/user':'/',p=norm(rel.startsWith('/')?rel:base+'/'+rel),n=vfsNodes.get(p);if(!n)return ENOENT;const dv2=dv(),t=BigInt(n.mtime)*1_000_000n;dv2.setBigUint64(sp,1n,true);dv2.setBigUint64(sp+8,1n,true);dv2.setUint8(sp+16,n.type==='dir'?3:4);dv2.setBigUint64(sp+24,1n,true);dv2.setBigUint64(sp+32,BigInt(n.content?.length??0),true);dv2.setBigUint64(sp+40,t,true);dv2.setBigUint64(sp+48,t,true);dv2.setBigUint64(sp+56,t,true);return ESUCCESS;},
      path_readlink(_,__,___,____,_____,p){dv().setUint32(p,0,true);return ENOENT;},
      fd_readdir(fd,bp,bl,ck,bup){const d=fds.get(fd);if(!d||d.node.type!=='dir'){dv().setUint32(bup,0,true);return ESUCCESS;}const enc=new TextEncoder();let w=0;const cookie=Number(ck),entries=[...d.node.children];for(let idx=cookie;idx<entries.length;idx++){const name=entries[idx],nb=enc.encode(name),es=24+nb.length;if(w+es>bl)break;const base=bp+w,cp=d.path==='/'?'/'+name:d.path+'/'+name,cn=vfsNodes.get(norm(cp));dv().setBigUint64(base,BigInt(idx+1),true);dv().setBigUint64(base+8,BigInt(idx+1),true);dv().setUint32(base+16,nb.length,true);dv().setUint8(base+20,cn?.type==='dir'?3:4);m8().set(nb,base+24);w+=es;}dv().setUint32(bup,w,true);return ESUCCESS;},
      clock_time_get(id,_,p){dv().setBigUint64(p,BigInt(Math.floor((id===1?performance.now():Date.now())*1_000_000)),true);return ESUCCESS;},
      clock_res_get(_,p){dv().setBigUint64(p,1n,true);return ESUCCESS;},
      random_get(p,l){const b=new Uint8Array(mem.buffer,p,l);for(let i=0;i<l;i++)b[i]=Math.random()*256;return ESUCCESS;},
      proc_exit(c){throw new Error('proc_exit:'+c);},
      sched_yield:()=>ESUCCESS, path_rename:()=>ENOSYS, path_remove_directory:()=>ENOSYS,
    }, { get(t,p){ if(p in t)return t[p]; return ()=>ENOSYS; } });

    WebAssembly.instantiate(wasmModule, { wasi_snapshot_preview1: wasi })
      .then(inst => {
        mem = inst.exports.memory;
        try { inst.exports._start(); } catch(e) { if(!e.message?.startsWith('proc_exit:'))throw e; }
        resolve({ stdout, stderr });
      })
      .catch(reject);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

async function test(name, fn) {
  process.stdout.write(`  ${name}... `);
  try {
    await fn();
    console.log('✓');
    passed++;
  } catch (e) {
    console.log('✗ ' + e.message);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

console.log('\nRunning tests:\n');

await test('print hello world', async () => {
  const { stdout } = await runPython('print("Hello, World!")');
  assert(stdout.includes('Hello, World!'), `Expected "Hello, World!" in stdout, got: "${stdout}"`);
});

await test('arithmetic', async () => {
  const { stdout } = await runPython('print(2 + 2)');
  assert(stdout.trim() === '4', `Expected "4", got: "${stdout.trim()}"`);
});

await test('list comprehension', async () => {
  const { stdout } = await runPython('print([x**2 for x in range(5)])');
  assert(stdout.includes('[0, 1, 4, 9, 16]'), `Got: "${stdout}"`);
});

await test('import sys', async () => {
  const { stdout } = await runPython('import sys; print(sys.version[:6])');
  assert(stdout.includes('3.13'), `Expected Python 3.13, got: "${stdout}"`);
});

await test('string formatting', async () => {
  const { stdout } = await runPython('name = "WASM"; print(f"Hello from {name}!")');
  assert(stdout.includes('Hello from WASM!'), `Got: "${stdout}"`);
});

await test('file I/O', async () => {
  const { stdout } = await runPython(`
with open('/home/user/test.txt', 'w') as f:
    f.write('hello file')
with open('/home/user/test.txt') as f:
    print(f.read())
`);
  assert(stdout.includes('hello file'), `Got: "${stdout}"`);
});

await test('exception handling', async () => {
  const { stdout } = await runPython(`
try:
    x = 1 / 0
except ZeroDivisionError as e:
    print(f"caught: {e}")
`);
  assert(stdout.includes('caught:'), `Got: "${stdout}"`);
});

await test('recursion (fibonacci)', async () => {
  const { stdout } = await runPython(`
def fib(n):
    return n if n <= 1 else fib(n-1) + fib(n-2)
print(fib(10))
`);
  assert(stdout.trim() === '55', `Expected 55, got: "${stdout.trim()}"`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
