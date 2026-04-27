import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { WASIShim } from './WASIShim.js';
import { VirtualFileSystem } from '../vfs/VirtualFileSystem.js';
import { WASICallbacks } from '../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Allocate a simple WebAssembly.Memory with 1 page (64 KiB) */
function makeMemory(pages = 1): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: pages });
}

/** Build a minimal WASICallbacks stub */
function makeCallbacks(): WASICallbacks & {
  stdoutChunks: Uint8Array[];
  stderrChunks: Uint8Array[];
  unknownCalls: string[];
} {
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  const unknownCalls: string[] = [];
  return {
    onStdout: (d) => stdoutChunks.push(d),
    onStderr: (d) => stderrChunks.push(d),
    onUnknownSyscall: (n) => unknownCalls.push(n),
    stdoutChunks,
    stderrChunks,
    unknownCalls,
  };
}

/** Write bytes into memory at ptr and return a DataView */
function writeToMemory(mem: WebAssembly.Memory, ptr: number, data: Uint8Array): void {
  new Uint8Array(mem.buffer, ptr, data.length).set(data);
}

/** Build a single iovec at iovPtr pointing to dataPtr with dataLen */
function buildIovec(mem: WebAssembly.Memory, iovPtr: number, dataPtr: number, dataLen: number): void {
  const dv = new DataView(mem.buffer);
  dv.setUint32(iovPtr, dataPtr, true);
  dv.setUint32(iovPtr + 4, dataLen, true);
}

// ─── Unit tests ───────────────────────────────────────────────────────────────

describe('WASIShim', () => {
  let shim: WASIShim;
  let vfs: VirtualFileSystem;
  let callbacks: ReturnType<typeof makeCallbacks>;
  let mem: WebAssembly.Memory;

  beforeEach(() => {
    shim = new WASIShim();
    vfs = new VirtualFileSystem();
    callbacks = makeCallbacks();
    mem = makeMemory(2);
    shim.setMemory(mem);
  });

  it('buildImports returns wasi_snapshot_preview1 namespace', () => {
    const imports = shim.buildImports(vfs, callbacks);
    expect(imports).toHaveProperty('wasi_snapshot_preview1');
    expect(typeof imports.wasi_snapshot_preview1.fd_write).toBe('function');
    expect(typeof imports.wasi_snapshot_preview1.fd_read).toBe('function');
    expect(typeof imports.wasi_snapshot_preview1.clock_time_get).toBe('function');
  });

  it('fd_write fd=1 calls onStdout', () => {
    const imports = shim.buildImports(vfs, callbacks);
    const { fd_write } = imports.wasi_snapshot_preview1;

    const data = new TextEncoder().encode('hello');
    // Layout: iovec at 0, data at 64
    writeToMemory(mem, 64, data);
    buildIovec(mem, 0, 64, data.length);
    // nwritten at 128
    fd_write(1, 0, 1, 128);

    expect(callbacks.stdoutChunks.length).toBe(1);
    expect(new TextDecoder().decode(callbacks.stdoutChunks[0])).toBe('hello');
  });

  it('fd_write fd=2 calls onStderr', () => {
    const imports = shim.buildImports(vfs, callbacks);
    const { fd_write } = imports.wasi_snapshot_preview1;

    const data = new TextEncoder().encode('err');
    writeToMemory(mem, 64, data);
    buildIovec(mem, 0, 64, data.length);
    fd_write(2, 0, 1, 128);

    expect(callbacks.stderrChunks.length).toBe(1);
    expect(new TextDecoder().decode(callbacks.stderrChunks[0])).toBe('err');
  });

  it('proc_exit throws with exit code', () => {
    const imports = shim.buildImports(vfs, callbacks);
    expect(() => imports.wasi_snapshot_preview1.proc_exit(42)).toThrow('proc_exit:42');
  });

  it('random_get fills buffer with bytes', () => {
    const imports = shim.buildImports(vfs, callbacks);
    const { random_get } = imports.wasi_snapshot_preview1;
    // Zero out 16 bytes at offset 100
    new Uint8Array(mem.buffer, 100, 16).fill(0);
    const result = random_get(100, 16);
    expect(result).toBe(0); // ESUCCESS
    // Very unlikely all bytes remain zero after crypto.getRandomValues
    const filled = new Uint8Array(mem.buffer, 100, 16);
    const allZero = filled.every((b) => b === 0);
    expect(allZero).toBe(false);
  });

  it('clock_time_get returns ESUCCESS and writes non-zero time', () => {
    const imports = shim.buildImports(vfs, callbacks);
    const { clock_time_get } = imports.wasi_snapshot_preview1;
    const result = clock_time_get(0, 0n, 200);
    expect(result).toBe(0);
    const dv = new DataView(mem.buffer);
    const timeNs = dv.getBigUint64(200, true);
    expect(timeNs).toBeGreaterThan(0n);
  });

  it('setInterruptBuffer causes fd_write to throw KeyboardInterrupt', () => {
    const sab = new SharedArrayBuffer(4);
    shim.setInterruptBuffer(sab);
    const interruptBuf = new Int32Array(sab);
    Atomics.store(interruptBuf, 0, 1);

    const imports = shim.buildImports(vfs, callbacks);
    const data = new TextEncoder().encode('x');
    writeToMemory(mem, 64, data);
    buildIovec(mem, 0, 64, data.length);

    expect(() => imports.wasi_snapshot_preview1.fd_write(1, 0, 1, 128)).toThrow('KeyboardInterrupt');
  });

  it('allowedSyscalls whitelist returns EPERM for denied syscalls', () => {
    const imports = shim.buildImports(vfs, callbacks, { allowedSyscalls: ['fd_write'] });
    // fd_read is not in whitelist
    const result = imports.wasi_snapshot_preview1.fd_read(0, 0, 0, 0);
    expect(result).toBe(63); // EPERM
  });

  it('allowedSyscalls whitelist allows listed syscalls', () => {
    const imports = shim.buildImports(vfs, callbacks, { allowedSyscalls: ['fd_write', 'environ_sizes_get'] });
    const dv = new DataView(mem.buffer);
    const result = imports.wasi_snapshot_preview1.environ_sizes_get(0, 4);
    expect(result).toBe(0); // ESUCCESS
    expect(dv.getUint32(0, true)).toBe(0);
  });

  it('null allowedSyscalls allows all syscalls', () => {
    const imports = shim.buildImports(vfs, callbacks, { allowedSyscalls: null });
    const result = imports.wasi_snapshot_preview1.environ_sizes_get(0, 4);
    expect(result).toBe(0); // ESUCCESS
  });

  it('unimplemented syscall returns ENOSYS and calls onUnknownSyscall', () => {
    const imports = shim.buildImports(vfs, callbacks);
    const result = imports.wasi_snapshot_preview1.poll_oneoff(0, 0, 0, 0);
    expect(result).toBe(52); // ENOSYS
    expect(callbacks.unknownCalls).toContain('poll_oneoff');
  });
});

// ─── Property-based tests ─────────────────────────────────────────────────────

/**
 * Property 2: Маршрутизация fd_write по файловому дескриптору
 * Validates: Requirements 2.2, 2.3
 */
describe('Property 2: fd_write routing by file descriptor', () => {
  it('routes data to correct callback for fd=1 and fd=2', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 256 }),
        fc.constantFrom(1, 2),
        (data, fd) => {
          const shim = new WASIShim();
          const vfs = new VirtualFileSystem();
          const callbacks = makeCallbacks();
          const mem = makeMemory(2);
          shim.setMemory(mem);

          const imports = shim.buildImports(vfs, callbacks);
          const { fd_write } = imports.wasi_snapshot_preview1;

          // Write data at offset 512, iovec at offset 256, nwritten at offset 768
          writeToMemory(mem, 512, data);
          buildIovec(mem, 256, 512, data.length);
          const result = fd_write(fd, 256, 1, 768);

          expect(result).toBe(0); // ESUCCESS

          if (fd === 1) {
            expect(callbacks.stdoutChunks.length).toBeGreaterThan(0);
            expect(callbacks.stderrChunks.length).toBe(0);
            // Verify data integrity
            const received = callbacks.stdoutChunks[0];
            expect(received).toEqual(data);
          } else {
            expect(callbacks.stderrChunks.length).toBeGreaterThan(0);
            expect(callbacks.stdoutChunks.length).toBe(0);
            const received = callbacks.stderrChunks[0];
            expect(received).toEqual(data);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 3: Монотонность clock_time_get
 * Validates: Requirements 2.4
 */
describe('Property 3: clock_time_get monotonicity', () => {
  it('returns monotonically non-decreasing values', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 50 }),
        (callCount) => {
          const shim = new WASIShim();
          const vfs = new VirtualFileSystem();
          const callbacks = makeCallbacks();
          const mem = makeMemory(2);
          shim.setMemory(mem);

          const imports = shim.buildImports(vfs, callbacks);
          const { clock_time_get } = imports.wasi_snapshot_preview1;

          const times: bigint[] = [];
          const dv = new DataView(mem.buffer);

          for (let i = 0; i < callCount; i++) {
            const result = clock_time_get(1, 0n, 0); // CLOCK_MONOTONIC at ptr=0
            expect(result).toBe(0);
            times.push(dv.getBigUint64(0, true));
          }

          // Verify monotonically non-decreasing
          for (let i = 1; i < times.length; i++) {
            expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 4: ENOSYS для неизвестных syscalls
 * Validates: Requirements 2.6
 */
describe('Property 4: ENOSYS for unknown syscalls', () => {
  it('returns ENOSYS for any syscall name not in the implemented set', () => {
    // The set of implemented syscalls
    const implemented = new Set([
      'fd_read', 'fd_write', 'fd_seek', 'fd_close', 'fd_fdstat_get', 'fd_readdir',
      'path_open', 'path_create_directory', 'path_remove_directory', 'path_unlink_file',
      'path_rename', 'path_filestat_get', 'clock_time_get', 'random_get', 'proc_exit',
      'args_get', 'args_sizes_get', 'environ_get', 'environ_sizes_get',
    ]);

    // Stubs that are in the import object but return ENOSYS
    const stubs = [
      'fd_prestat_get', 'fd_prestat_dir_name', 'fd_sync', 'fd_tell', 'fd_advise',
      'fd_allocate', 'fd_datasync', 'fd_filestat_get', 'fd_filestat_set_size',
      'fd_filestat_set_times', 'fd_pread', 'fd_pwrite', 'fd_renumber',
      'path_filestat_set_times', 'path_link', 'path_readlink', 'path_symlink',
      'poll_oneoff', 'proc_raise', 'sched_yield',
      'sock_accept', 'sock_recv', 'sock_send', 'sock_shutdown',
    ];

    fc.assert(
      fc.property(
        fc.constantFrom(...stubs),
        (syscallName) => {
          const shim = new WASIShim();
          const vfs = new VirtualFileSystem();
          const callbacks = makeCallbacks();
          const mem = makeMemory(1);
          shim.setMemory(mem);

          const imports = shim.buildImports(vfs, callbacks);
          const fn = imports.wasi_snapshot_preview1[syscallName];
          expect(typeof fn).toBe('function');

          const result = fn(0, 0, 0, 0);
          expect(result).toBe(52); // ENOSYS
          expect(callbacks.unknownCalls).toContain(syscallName);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 22: EPERM для запрещённых syscalls
 * Validates: Requirements 9.4
 */
describe('Property 22: EPERM for disallowed syscalls', () => {
  it('returns EPERM for any syscall not in the allowedSyscalls whitelist', () => {
    const allSyscalls = [
      'fd_read', 'fd_write', 'fd_seek', 'fd_close', 'fd_fdstat_get', 'fd_readdir',
      'path_open', 'path_create_directory', 'path_remove_directory', 'path_unlink_file',
      'path_rename', 'path_filestat_get', 'clock_time_get', 'random_get',
      'args_get', 'args_sizes_get', 'environ_get', 'environ_sizes_get',
      'fd_prestat_get', 'fd_prestat_dir_name', 'fd_sync', 'fd_tell',
      'poll_oneoff', 'sched_yield',
    ];

    fc.assert(
      fc.property(
        // Pick a random subset as the whitelist
        fc.array(fc.constantFrom(...allSyscalls), { minLength: 0, maxLength: 10 }),
        // Pick a syscall that is NOT in the whitelist
        fc.constantFrom(...allSyscalls),
        (whitelist, target) => {
          // Ensure target is NOT in whitelist
          const filteredWhitelist = whitelist.filter((s) => s !== target);

          const shim = new WASIShim();
          const vfs = new VirtualFileSystem();
          const callbacks = makeCallbacks();
          const mem = makeMemory(1);
          shim.setMemory(mem);

          const imports = shim.buildImports(vfs, callbacks, { allowedSyscalls: filteredWhitelist });
          const fn = imports.wasi_snapshot_preview1[target];

          if (typeof fn !== 'function') return; // skip if not in import object

          const result = fn(0, 0, 0, 0);
          expect(result).toBe(63); // EPERM
        },
      ),
      { numRuns: 100 },
    );
  });

  it('allows syscalls that are in the whitelist', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('environ_sizes_get', 'args_sizes_get', 'environ_get'),
        (syscallName) => {
          const shim = new WASIShim();
          const vfs = new VirtualFileSystem();
          const callbacks = makeCallbacks();
          const mem = makeMemory(1);
          shim.setMemory(mem);

          const imports = shim.buildImports(vfs, callbacks, { allowedSyscalls: [syscallName] });
          const fn = imports.wasi_snapshot_preview1[syscallName];
          const result = fn(0, 4);
          expect(result).toBe(0); // ESUCCESS — not EPERM
        },
      ),
      { numRuns: 100 },
    );
  });
});
