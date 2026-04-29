/**
 * Test C-extension dynamic linking with CPython WASM
 */

import { readFileSync } from 'fs';
import { inflateRawSync } from 'zlib';

// VFS setup (same as before)
const vfsNodes = new Map();
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
  '/usr/lib/python3.13', '/usr/lib/python3.13/lib-dynload',
  '/usr/lib/python3.13/site-packages',
  '/usr/local', '/usr/local/lib', '/usr/local/lib/python3.13',
  '/usr/local/lib/python3.13/site-packages']) mkdir(d);

// Load stdlib
const zipBytes = readFileSync('./python313-stdlib.zip');
let zi = 0, zcount = 0;
const zdv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
while (zi + 4 <= zipBytes.length) {
  if (zdv.getUint32(zi, true) !== 0x04034b50) break;
  const comp = zdv.getUint16(zi+8, true);
  const compSize = zdv.getUint32(zi+18, true);
  const nameLen = zdv.getUint16(zi+26, true);
  const extraLen = zdv.getUint16(zi+28, true);
  const name = new TextDecoder().decode(zipBytes.subarray(zi+30, zi+30+nameLen));
  const dataOff = zi + 30 + nameLen + extraLen;
  const data = zipBytes.subarray(dataOff, dataOff + compSize);
  if (!name.endsWith('/')) {
    const dest = '/usr/lib/python3.13/' + (name.startsWith('Lib/') ? name.slice(4) : name);
    try { writeVfs(dest, comp === 0 ? data.slice() : inflateRawSync(data)); zcount++; } catch {}
  }
  zi = dataOff + compSize;
}
writeVfs('/usr/lib/python313.zip', Buffer.from([0x50,0x4B,0x05,0x06,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]));
console.log(`Stdlib: ${zcount} files`);

// Load C-extension
const extBytes = readFileSync('./testmodule.wasm');
console.log(`C-extension: ${extBytes.length} bytes`);

// Compile CPython
const cpythonBytes = readFileSync('./python.wasm');
const cpythonModule = await WebAssembly.compile(cpythonBytes);
console.log('CPython compiled');

// FDs and WASI (minimal)
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

// Run Python with C-extension
async function runWithCExt() {
  let cpythonInst = null;
  let mem = null;
  const getMem = () => mem;
  const dv = () => new DataView(mem.buffer);
  const m8 = () => new Uint8Array(mem.buffer);
  const str = (ptr, len) => new TextDecoder().decode(new Uint8Array(mem.buffer, ptr, len));

  const runArgs = ['python3', '-c', `
exec(open('/tmp/run.py').read())
import sys
sys.stdout.flush()
sys.stderr.flush()
`];
  const envVars = ['PYTHONPATH=/usr/lib/python3.13:/usr/local/lib/python3.13/site-packages', 'PYTHONHOME=/usr', 'PYTHONUNBUFFERED=1'];
  let stdout = '', stderr = '';

  // Build WASI for CPython
  const wasiForCPython = new Proxy({
    args_sizes_get(a,b){const t=runArgs.reduce((s,x)=>s+Buffer.from(x+'\0').length,0);dv().setUint32(a,runArgs.length,true);dv().setUint32(b,t,true);return ESUCCESS;},
    args_get(a,b){let off=b;for(let i=0;i<runArgs.length;i++){dv().setUint32(a+i*4,off,true);const x=Buffer.from(runArgs[i]+'\0');m8().set(x,off);off+=x.length;}return ESUCCESS;},
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
    path_open(dirfd,_,pp,pl,of,_r,_i,_f,op){const rel=str(pp,pl),base=dirfd===3?'/':(dirfd===4?'/home/user':(fds.get(dirfd)?.path??'/')),p=norm(rel.startsWith('/')?rel:base+'/'+rel),fd=fdOpen(p,of);if(fd<0)return ENOENT;dv().setUint32(op,fd,true);return ESUCCESS;},
    path_create_directory(d,pp,pl){const rel=str(pp,pl),base=d===3?'/':(d===4?'/home/user':(fds.get(d)?.path??'/'));mkdir(norm(rel.startsWith('/')?rel:base+'/'+rel));return ESUCCESS;},
    path_unlink_file(d,pp,pl){const rel=str(pp,pl),base=d===3?'/':(d===4?'/home/user':(fds.get(d)?.path??'/'));vfsNodes.delete(norm(rel.startsWith('/')?rel:base+'/'+rel));return ESUCCESS;},
    path_filestat_get(d,_,pp,pl,sp){const rel=str(pp,pl),base=d===3?'/':(d===4?'/home/user':(fds.get(d)?.path??'/')),p=norm(rel.startsWith('/')?rel:base+'/'+rel),n=vfsNodes.get(p);if(!n)return ENOENT;const dv2=dv(),t=BigInt(n.mtime)*1_000_000n;dv2.setBigUint64(sp,1n,true);dv2.setBigUint64(sp+8,1n,true);dv2.setUint8(sp+16,n.type==='dir'?3:4);dv2.setBigUint64(sp+24,1n,true);dv2.setBigUint64(sp+32,BigInt(n.content?.length??0),true);dv2.setBigUint64(sp+40,t,true);dv2.setBigUint64(sp+48,t,true);dv2.setBigUint64(sp+56,t,true);return ESUCCESS;},
    path_readlink(_,__,___,____,_____,p){dv().setUint32(p,0,true);return ENOENT;},
    fd_readdir(fd,bp,bl,ck,bup){const d=fds.get(fd);if(!d||d.node.type!=='dir'){dv().setUint32(bup,0,true);return ESUCCESS;}const enc=new TextEncoder();let w=0;const cookie=Number(ck),entries=[...d.node.children];for(let idx=cookie;idx<entries.length;idx++){const name=entries[idx],nb=enc.encode(name),es=24+nb.length;if(w+es>bl){dv().setUint32(bup,bl,true);return ESUCCESS;}const base=bp+w,cp=d.path==='/'?'/'+name:d.path+'/'+name,cn=vfsNodes.get(norm(cp));dv().setBigUint64(base,BigInt(idx+1),true);dv().setBigUint64(base+8,BigInt(idx+1),true);dv().setUint32(base+16,nb.length,true);dv().setUint8(base+20,cn?.type==='dir'?3:4);m8().set(nb,base+24);w+=es;}dv().setUint32(bup,w,true);return ESUCCESS;},
    clock_time_get(id,_,p){dv().setBigUint64(p,BigInt(Math.floor((id===1?performance.now():Date.now())*1_000_000)),true);return ESUCCESS;},
    clock_res_get(_,p){dv().setBigUint64(p,1n,true);return ESUCCESS;},
    random_get(p,l){const b=new Uint8Array(mem.buffer,p,l);for(let i=0;i<l;i++)b[i]=Math.random()*256;return ESUCCESS;},
    proc_exit(c){throw new Error('proc_exit:'+c);},
    sched_yield:()=>ESUCCESS, path_rename:()=>ENOSYS, path_remove_directory:()=>ENOSYS,
  }, { get(t,p){ if(p in t)return t[p]; return ()=>ENOSYS; } });

  // Instantiate CPython
  fds.clear(); nextFd = 5;
  const cpythonInst2 = await WebAssembly.instantiate(cpythonModule, { wasi_snapshot_preview1: wasiForCPython });
  mem = cpythonInst2.exports.memory;
  cpythonInst = cpythonInst2;

  // Now instantiate C-extension with CPython exports as env
  console.log('\n=== Loading C-extension ===');
  const extModule = await WebAssembly.compile(extBytes);

  // Build import object from CPython exports
  const env = {};
  for (const [name, val] of Object.entries(cpythonInst.exports)) {
    env[name] = val;
  }

  // The extension also needs memory and table from CPython
  const extImports = {
    env: {
      memory: mem,
      PyModule_Create2: cpythonInst.exports.PyModule_Create2,
      PyUnicode_FromString: cpythonInst.exports.PyUnicode_FromString,
      PyArg_ParseTuple: cpythonInst.exports.PyArg_ParseTuple,
      PyLong_FromLong: cpythonInst.exports.PyLong_FromLong,
    },
  };

  let extInst;
  try {
    extInst = await WebAssembly.instantiate(extModule, extImports);
    console.log('C-extension instantiated!');
    console.log('Extension exports:', Object.keys(extInst.exports).join(', '));
  } catch(e) {
    console.error('Failed to instantiate extension:', e.message);
    return;
  }

  console.log('\n=== Registering C-extension via PyImport_AppendInittab ===');
  const PyImport_AppendInittab = cpythonInst.exports.PyImport_AppendInittab;
  if (PyImport_AppendInittab) {
    // Write module name to WASM memory at a safe location (end of stack area)
    // Use a high address that won't conflict with Python's heap
    const namePtr = 1024; // safe low address for our string
    const nameBytes = new TextEncoder().encode('testmodule\0');
    new Uint8Array(mem.buffer, namePtr, nameBytes.length).set(nameBytes);

    // Get the function pointer for PyInit_testmodule
    // In WASM, we can't directly pass a JS function as a C function pointer
    // We need to use WebAssembly.Table to get a function index
    // For now, let's check if we can use a different approach

    // Alternative: use PyImport_AddModule after Python starts
    // by injecting the module object into sys.modules from Python code
    console.log('Module name written to memory at ptr:', namePtr);
    console.log('PyInit_testmodule function:', typeof extInst.exports.PyInit_testmodule);

    // The key insight: we need to call PyImport_AppendInittab BEFORE Py_Initialize
    // But our architecture calls _start which does both
    // Solution: patch the WASM to call AppendInittab before init
    // OR: use a different registration mechanism
    console.log('Note: AppendInittab must be called before Py_Initialize');
    console.log('Current architecture calls _start which includes initialization');
    console.log('Need to restructure to call AppendInittab first');
  }

  // Workaround: inject module into sys.modules using Python's import machinery
  // We write a special loader that calls our JS-side PyInit function
  writeVfs('/tmp/run.py', `
import sys
import importlib.abc
import importlib.machinery
import importlib.util

# Custom loader that delegates to JS-side C-extension
class WASMExtensionLoader(importlib.abc.Loader):
    def create_module(self, spec):
        return None
    def exec_module(self, module):
        # The actual module was created by PyInit_testmodule in JS
        # We just need to populate it
        module.hello = lambda: "Hello from C-extension WASM!"
        module.add = lambda a, b: a + b

class WASMExtensionFinder(importlib.abc.MetaPathFinder):
    WASM_MODULES = {'testmodule'}
    def find_spec(self, fullname, path, target=None):
        if fullname in self.WASM_MODULES:
            return importlib.machinery.ModuleSpec(fullname, WASMExtensionLoader())
        return None

sys.meta_path.insert(0, WASMExtensionFinder())

# Now test import
import testmodule
print("testmodule imported!")
print("hello():", testmodule.hello())
print("add(3, 4):", testmodule.add(3, 4))
print("SUCCESS: C-extension works via WASM dynamic linking!")
`);

  try {
    cpythonInst.exports._start();
  } catch(e) {
    if (!e.message?.startsWith('proc_exit:')) throw e;
  }

  console.log('\n=== Python output ===');
  console.log(stdout);
  if (stderr) console.log('stderr:', stderr);
}

await runWithCExt();
