import { WASICallbacks, WASIImports, FileType } from '../types.js';
import { VirtualFileSystem } from '../vfs/VirtualFileSystem.js';
import { FileNotFoundError, FSOperationError } from '../errors/index.js';

// ─── WASI Error Codes ─────────────────────────────────────────────────────────

const ESUCCESS = 0;
const EBADF    = 8;
const ENOENT   = 44;
const ENOSYS   = 52;
const EPERM    = 63;
const ENOTDIR  = 54;

// ─── WASI Filetype constants ──────────────────────────────────────────────────

const WASI_FILETYPE_UNKNOWN          = 0;
const WASI_FILETYPE_BLOCK_DEVICE     = 1;
const WASI_FILETYPE_CHARACTER_DEVICE = 2;
const WASI_FILETYPE_DIRECTORY        = 3;
const WASI_FILETYPE_REGULAR_FILE     = 4;
const WASI_FILETYPE_SOCKET_DGRAM     = 5;
const WASI_FILETYPE_SOCKET_STREAM    = 6;
const WASI_FILETYPE_SYMBOLIC_LINK    = 7;

// ─── WASI Whence ──────────────────────────────────────────────────────────────

const WHENCE_SET = 0;
const WHENCE_CUR = 1;
const WHENCE_END = 2;

// ─── Open flags ───────────────────────────────────────────────────────────────

const OFLAGS_CREAT     = 0x0001;
const OFLAGS_DIRECTORY = 0x0002;
const OFLAGS_EXCL      = 0x0004;
const OFLAGS_TRUNC     = 0x0008;

// ─── Pre-opened file descriptors ─────────────────────────────────────────────

// fd 0 = stdin, 1 = stdout, 2 = stderr, 3 = / (root preopen), 4 = /home/user preopen
const PREOPEN_FD_ROOT = 3;
const PREOPEN_FD_HOME = 4;

// ─── WASIShim ─────────────────────────────────────────────────────────────────

export class WASIShim {
  private memory: WebAssembly.Memory | null = null;
  private interruptBuffer: Int32Array | null = null;

  /** Set the WASM linear memory (called after instantiation). */
  setMemory(memory: WebAssembly.Memory): void {
    this.memory = memory;
  }

  /** Set a SharedArrayBuffer for interrupt signalling. */
  setInterruptBuffer(sab: SharedArrayBuffer): void {
    this.interruptBuffer = new Int32Array(sab);
  }

  /**
   * Build the wasi_snapshot_preview1 import object.
   * @param vfs - VirtualFileSystem instance
   * @param callbacks - stdout/stderr/unknown-syscall callbacks
   * @param config - optional config with allowedSyscalls whitelist
   */
  buildImports(
    vfs: VirtualFileSystem,
    callbacks: WASICallbacks,
    config?: { allowedSyscalls?: string[] | null },
  ): WASIImports {
    const allowedSyscalls = config?.allowedSyscalls ?? null;

    // Helper: check interrupt buffer and throw if interrupted
    const checkInterrupt = (): void => {
      if (this.interruptBuffer !== null) {
        if (Atomics.load(this.interruptBuffer, 0) !== 0) {
          throw new Error('KeyboardInterrupt');
        }
      }
    };

    // Helper: check whitelist; returns EPERM if denied
    const checkAllowed = (name: string): number | null => {
      if (allowedSyscalls !== null && !allowedSyscalls.includes(name)) {
        return EPERM;
      }
      return null;
    };

    // Helper: get DataView over current memory buffer
    const view = (): DataView => {
      if (!this.memory) throw new Error('WASIShim: memory not set');
      return new DataView(this.memory.buffer);
    };

    // Helper: read UTF-8 string from memory
    const readString = (ptr: number, len: number): string => {
      if (!this.memory) throw new Error('WASIShim: memory not set');
      const bytes = new Uint8Array(this.memory.buffer, ptr, len);
      return new TextDecoder().decode(bytes);
    };

    // Helper: write UTF-8 string into memory, returns bytes written
    const writeString = (ptr: number, str: string): number => {
      if (!this.memory) throw new Error('WASIShim: memory not set');
      const encoded = new TextEncoder().encode(str + '\0');
      new Uint8Array(this.memory.buffer, ptr, encoded.length).set(encoded);
      return encoded.length;
    };

    // Helper: resolve path relative to a dirfd preopen
    const resolvePath = (dirfd: number, pathPtr: number, pathLen: number): string => {
      const rel = readString(pathPtr, pathLen);
      if (rel.startsWith('/')) return rel;
      const base = dirfd === PREOPEN_FD_HOME ? '/home/user' : '/';
      return base + '/' + rel;
    };

    // Helper: map VFS FileType to WASI filetype byte
    const mapFiletype = (ft: FileType): number => {
      switch (ft) {
        case FileType.DIRECTORY:    return WASI_FILETYPE_DIRECTORY;
        case FileType.REGULAR_FILE: return WASI_FILETYPE_REGULAR_FILE;
        case FileType.SYMBOLIC_LINK: return WASI_FILETYPE_SYMBOLIC_LINK;
        default: return WASI_FILETYPE_UNKNOWN;
      }
    };

    // Wrap a syscall with whitelist check
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrap = <T extends (...args: any[]) => number>(name: string, fn: T): T => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ((...args: any[]): number => {
        const denied = checkAllowed(name);
        if (denied !== null) return denied;
        try {
          return fn(...args);
        } catch (e) {
          // Re-throw interrupt and proc_exit
          if (e instanceof Error && (e.message === 'KeyboardInterrupt' || e.message.startsWith('proc_exit:'))) {
            throw e;
          }
          return ENOSYS;
        }
      }) as T;
    };

    // ── fd_read ───────────────────────────────────────────────────────────────
    const fd_read = wrap('fd_read', (fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number): number => {
      // stdin (fd=0) — not supported, return 0 bytes
      if (fd === 0) {
        view().setUint32(nreadPtr, 0, true);
        return ESUCCESS;
      }
      let totalRead = 0;
      try {
        for (let i = 0; i < iovsLen; i++) {
          const iovBase = view().getUint32(iovsPtr + i * 8, true);
          const iovLen  = view().getUint32(iovsPtr + i * 8 + 4, true);
          if (iovLen === 0) continue;
          const buf = new Uint8Array(this.memory!.buffer, iovBase, iovLen);
          const n = vfs.fdRead(fd, buf);
          totalRead += n;
          if (n < iovLen) break; // EOF
        }
        view().setUint32(nreadPtr, totalRead, true);
        return ESUCCESS;
      } catch (e) {
        if (e instanceof FSOperationError) return EBADF;
        if (e instanceof FileNotFoundError) return ENOENT;
        return EBADF;
      }
    });

    // ── fd_write ──────────────────────────────────────────────────────────────
    const fd_write = wrap('fd_write', (fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number => {
      checkInterrupt();

      let totalWritten = 0;

      if (fd === 1 || fd === 2) {
        // stdout / stderr — collect all iovecs and send to callback
        const chunks: Uint8Array[] = [];
        for (let i = 0; i < iovsLen; i++) {
          const iovBase = view().getUint32(iovsPtr + i * 8, true);
          const iovLen  = view().getUint32(iovsPtr + i * 8 + 4, true);
          if (iovLen === 0) continue;
          const chunk = new Uint8Array(this.memory!.buffer, iovBase, iovLen).slice();
          chunks.push(chunk);
          totalWritten += iovLen;
        }
        if (chunks.length > 0) {
          // Merge all chunks into one Uint8Array
          const merged = new Uint8Array(totalWritten);
          let offset = 0;
          for (const c of chunks) {
            merged.set(c, offset);
            offset += c.length;
          }
          if (fd === 1) callbacks.onStdout(merged);
          else          callbacks.onStderr(merged);
        }
        view().setUint32(nwrittenPtr, totalWritten, true);
        return ESUCCESS;
      }

      // Regular file write
      try {
        for (let i = 0; i < iovsLen; i++) {
          const iovBase = view().getUint32(iovsPtr + i * 8, true);
          const iovLen  = view().getUint32(iovsPtr + i * 8 + 4, true);
          if (iovLen === 0) continue;
          const data = new Uint8Array(this.memory!.buffer, iovBase, iovLen).slice();
          totalWritten += vfs.fdWrite(fd, data);
        }
        view().setUint32(nwrittenPtr, totalWritten, true);
        return ESUCCESS;
      } catch (e) {
        if (e instanceof FSOperationError) return EBADF;
        return EBADF;
      }
    });

    // ── fd_seek ───────────────────────────────────────────────────────────────
    const fd_seek = wrap('fd_seek', (fd: number, offsetLo: number, offsetHi: number, whence: number, newoffsetPtr: number): number => {
      const offset = BigInt(offsetLo) | (BigInt(offsetHi) << 32n);
      try {
        const newPos = vfs.fdSeek(fd, offset, whence);
        view().setBigUint64(newoffsetPtr, newPos, true);
        return ESUCCESS;
      } catch (e) {
        if (e instanceof FSOperationError) return EBADF;
        return EBADF;
      }
    });

    // ── fd_close ──────────────────────────────────────────────────────────────
    const fd_close = wrap('fd_close', (fd: number): number => {
      try {
        vfs.fdClose(fd);
        return ESUCCESS;
      } catch (e) {
        return EBADF;
      }
    });

    // ── fd_fdstat_get ─────────────────────────────────────────────────────────
    // struct __wasi_fdstat_t: fs_filetype(u8), fs_flags(u16), fs_rights_base(u64), fs_rights_inheriting(u64)
    const fd_fdstat_get = wrap('fd_fdstat_get', (fd: number, statPtr: number): number => {
      // Handle pre-opened fds
      if (fd === 0 || fd === 1 || fd === 2) {
        const dv = view();
        dv.setUint8(statPtr, WASI_FILETYPE_CHARACTER_DEVICE); // fs_filetype
        dv.setUint16(statPtr + 2, 0, true);                   // fs_flags
        dv.setBigUint64(statPtr + 8, 0xffffffffffffffffn, true);  // fs_rights_base
        dv.setBigUint64(statPtr + 16, 0xffffffffffffffffn, true); // fs_rights_inheriting
        return ESUCCESS;
      }
      if (fd === PREOPEN_FD_ROOT || fd === PREOPEN_FD_HOME) {
        const dv = view();
        dv.setUint8(statPtr, WASI_FILETYPE_DIRECTORY);
        dv.setUint16(statPtr + 2, 0, true);
        dv.setBigUint64(statPtr + 8, 0xffffffffffffffffn, true);
        dv.setBigUint64(statPtr + 16, 0xffffffffffffffffn, true);
        return ESUCCESS;
      }
      // Try to get from VFS — we need to look up the fd
      // VFS doesn't expose a direct fdstat, so we return a generic file stat
      try {
        // Attempt a zero-byte seek to validate fd exists
        vfs.fdSeek(fd, 0n, WHENCE_CUR);
        const dv = view();
        dv.setUint8(statPtr, WASI_FILETYPE_REGULAR_FILE);
        dv.setUint16(statPtr + 2, 0, true);
        dv.setBigUint64(statPtr + 8, 0xffffffffffffffffn, true);
        dv.setBigUint64(statPtr + 16, 0xffffffffffffffffn, true);
        return ESUCCESS;
      } catch {
        return EBADF;
      }
    });

    // ── path_open ─────────────────────────────────────────────────────────────
    const path_open = wrap('path_open', (
      dirfd: number,
      _dirflags: number,
      pathPtr: number,
      pathLen: number,
      oflags: number,
      _fsRightsBase: number,
      _fsRightsInheriting: number,
      _fdflags: number,
      openedFdPtr: number,
    ): number => {
      const path = resolvePath(dirfd, pathPtr, pathLen);
      try {
        const descriptor = vfs.pathOpen(path, oflags);
        view().setUint32(openedFdPtr, descriptor.fd, true);
        return ESUCCESS;
      } catch (e) {
        if (e instanceof FileNotFoundError) return ENOENT;
        if (e instanceof FSOperationError) return EBADF;
        return ENOENT;
      }
    });

    // ── path_create_directory ─────────────────────────────────────────────────
    const path_create_directory = wrap('path_create_directory', (dirfd: number, pathPtr: number, pathLen: number): number => {
      const path = resolvePath(dirfd, pathPtr, pathLen);
      try {
        vfs.pathCreateDirectory(path);
        return ESUCCESS;
      } catch (e) {
        if (e instanceof FSOperationError) return EBADF;
        return ENOENT;
      }
    });

    // ── path_remove_directory ─────────────────────────────────────────────────
    const path_remove_directory = wrap('path_remove_directory', (dirfd: number, pathPtr: number, pathLen: number): number => {
      const path = resolvePath(dirfd, pathPtr, pathLen);
      try {
        vfs.pathRemoveDirectory(path);
        return ESUCCESS;
      } catch (e) {
        if (e instanceof FileNotFoundError) return ENOENT;
        if (e instanceof FSOperationError) return EBADF;
        return ENOENT;
      }
    });

    // ── path_unlink_file ──────────────────────────────────────────────────────
    const path_unlink_file = wrap('path_unlink_file', (dirfd: number, pathPtr: number, pathLen: number): number => {
      const path = resolvePath(dirfd, pathPtr, pathLen);
      try {
        vfs.pathUnlinkFile(path);
        return ESUCCESS;
      } catch (e) {
        if (e instanceof FileNotFoundError) return ENOENT;
        if (e instanceof FSOperationError) return EBADF;
        return ENOENT;
      }
    });

    // ── path_rename ───────────────────────────────────────────────────────────
    const path_rename = wrap('path_rename', (
      oldDirfd: number,
      oldPathPtr: number,
      oldPathLen: number,
      newDirfd: number,
      newPathPtr: number,
      newPathLen: number,
    ): number => {
      const oldPath = resolvePath(oldDirfd, oldPathPtr, oldPathLen);
      const newPath = resolvePath(newDirfd, newPathPtr, newPathLen);
      try {
        vfs.pathRename(oldPath, newPath);
        return ESUCCESS;
      } catch (e) {
        if (e instanceof FileNotFoundError) return ENOENT;
        if (e instanceof FSOperationError) return EBADF;
        return ENOENT;
      }
    });

    // ── path_filestat_get ─────────────────────────────────────────────────────
    // struct __wasi_filestat_t: dev(u64), ino(u64), filetype(u8), nlink(u64), size(u64), atim(u64), mtim(u64), ctim(u64)
    const path_filestat_get = wrap('path_filestat_get', (
      dirfd: number,
      _flags: number,
      pathPtr: number,
      pathLen: number,
      statPtr: number,
    ): number => {
      const path = resolvePath(dirfd, pathPtr, pathLen);
      try {
        const stat = vfs.pathStat(path);
        const dv = view();
        dv.setBigUint64(statPtr,      stat.dev,                    true); // dev
        dv.setBigUint64(statPtr + 8,  stat.ino,                    true); // ino
        dv.setUint8(statPtr + 16,     mapFiletype(stat.filetype));        // filetype
        // 7 bytes padding
        dv.setBigUint64(statPtr + 24, stat.nlink,                  true); // nlink
        dv.setBigUint64(statPtr + 32, stat.size,                   true); // size
        dv.setBigUint64(statPtr + 40, stat.atim,                   true); // atim
        dv.setBigUint64(statPtr + 48, stat.mtim,                   true); // mtim
        dv.setBigUint64(statPtr + 56, stat.ctim,                   true); // ctim
        return ESUCCESS;
      } catch (e) {
        if (e instanceof FileNotFoundError) return ENOENT;
        if (e instanceof FSOperationError) return EBADF;
        return ENOENT;
      }
    });

    // ── path_readdir (fd_readdir in WASI Preview 1) ───────────────────────────
    // WASI Preview 1 uses fd_readdir, not path_readdir — expose both names
    // struct __wasi_dirent_t: d_next(u64), d_ino(u64), d_namlen(u32), d_type(u8)
    const fd_readdir = wrap('fd_readdir', (
      fd: number,
      bufPtr: number,
      bufLen: number,
      cookie: bigint,
      bufusedPtr: number,
    ): number => {
      // Resolve path from fd — for preopen dirs use known paths
      let path: string;
      if (fd === PREOPEN_FD_ROOT) path = '/';
      else if (fd === PREOPEN_FD_HOME) path = '/home/user';
      else {
        // We can't easily look up path from fd in current VFS API
        // Return empty directory
        view().setUint32(bufusedPtr, 0, true);
        return ESUCCESS;
      }

      try {
        const entries = vfs.pathReaddir(path);
        const cookieNum = Number(cookie);
        const relevant = entries.slice(cookieNum);

        let written = 0;
        const dv = view();
        const encoder = new TextEncoder();

        for (const entry of relevant) {
          const nameBytes = encoder.encode(entry.name);
          const entrySize = 24 + nameBytes.length; // dirent header = 24 bytes
          if (written + entrySize > bufLen) break;

          const base = bufPtr + written;
          dv.setBigUint64(base,      entry.next,                  true); // d_next
          dv.setBigUint64(base + 8,  entry.ino,                   true); // d_ino
          dv.setUint32(base + 16,    nameBytes.length,             true); // d_namlen
          dv.setUint8(base + 20,     mapFiletype(entry.type));            // d_type
          // 3 bytes padding at 21-23
          new Uint8Array(this.memory!.buffer, base + 24, nameBytes.length).set(nameBytes);
          written += entrySize;
        }

        dv.setUint32(bufusedPtr, written, true);
        return ESUCCESS;
      } catch (e) {
        if (e instanceof FileNotFoundError) return ENOENT;
        return EBADF;
      }
    });

    // ── clock_time_get ────────────────────────────────────────────────────────
    const clock_time_get = wrap('clock_time_get', (clockId: number, _precision: bigint, timePtr: number): number => {
      checkInterrupt();
      // clock_id 0 = CLOCK_REALTIME, 1 = CLOCK_MONOTONIC
      let timeNs: bigint;
      if (clockId === 1) {
        // Monotonic: use performance.now() in ms → ns
        const ms = typeof performance !== 'undefined' ? performance.now() : Date.now();
        timeNs = BigInt(Math.floor(ms * 1_000_000));
      } else {
        // Realtime: Date.now() in ms → ns
        timeNs = BigInt(Date.now()) * 1_000_000n;
      }
      view().setBigUint64(timePtr, timeNs, true);
      return ESUCCESS;
    });

    // ── random_get ────────────────────────────────────────────────────────────
    const random_get = wrap('random_get', (bufPtr: number, bufLen: number): number => {
      if (!this.memory) return ENOSYS;
      const buf = new Uint8Array(this.memory.buffer, bufPtr, bufLen);
      crypto.getRandomValues(buf);
      return ESUCCESS;
    });

    // ── proc_exit ─────────────────────────────────────────────────────────────
    const proc_exit = (code: number): never => {
      throw new Error(`proc_exit:${code}`);
    };

    // ── args_get ──────────────────────────────────────────────────────────────
    const args_get = wrap('args_get', (argvPtr: number, argvBufPtr: number): number => {
      // Provide minimal argv: ["python"]
      const args = ['python'];
      const encoder = new TextEncoder();
      let bufOffset = argvBufPtr;
      const dv = view();
      for (let i = 0; i < args.length; i++) {
        dv.setUint32(argvPtr + i * 4, bufOffset, true);
        const encoded = encoder.encode(args[i] + '\0');
        new Uint8Array(this.memory!.buffer, bufOffset, encoded.length).set(encoded);
        bufOffset += encoded.length;
      }
      return ESUCCESS;
    });

    // ── args_sizes_get ────────────────────────────────────────────────────────
    const args_sizes_get = wrap('args_sizes_get', (argcPtr: number, argvBufSizePtr: number): number => {
      const args = ['python'];
      const totalSize = args.reduce((s, a) => s + new TextEncoder().encode(a + '\0').length, 0);
      const dv = view();
      dv.setUint32(argcPtr, args.length, true);
      dv.setUint32(argvBufSizePtr, totalSize, true);
      return ESUCCESS;
    });

    // ── environ_get ───────────────────────────────────────────────────────────
    const environ_get = wrap('environ_get', (_environPtr: number, _environBufPtr: number): number => {
      // No environment variables
      return ESUCCESS;
    });

    // ── environ_sizes_get ─────────────────────────────────────────────────────
    const environ_sizes_get = wrap('environ_sizes_get', (environCountPtr: number, environBufSizePtr: number): number => {
      const dv = view();
      dv.setUint32(environCountPtr, 0, true);
      dv.setUint32(environBufSizePtr, 0, true);
      return ESUCCESS;
    });

    // ── Stub for unimplemented syscalls ───────────────────────────────────────
    const unimplemented = (name: string) => (..._args: unknown[]): number => {
      const denied = checkAllowed(name);
      if (denied !== null) return denied;
      callbacks.onUnknownSyscall(name);
      console.warn(`WASIShim: unimplemented syscall '${name}', returning ENOSYS`);
      return ENOSYS;
    };

    return {
      wasi_snapshot_preview1: {
        fd_read,
        fd_write,
        fd_seek,
        fd_close,
        fd_fdstat_get,
        fd_readdir,
        path_open,
        path_create_directory,
        path_remove_directory,
        path_unlink_file,
        path_rename,
        path_filestat_get,
        clock_time_get,
        random_get,
        proc_exit,
        args_get,
        args_sizes_get,
        environ_get,
        environ_sizes_get,
        // Stubs for other common WASI syscalls
        fd_prestat_get:        unimplemented('fd_prestat_get'),
        fd_prestat_dir_name:   unimplemented('fd_prestat_dir_name'),
        fd_sync:               unimplemented('fd_sync'),
        fd_tell:               unimplemented('fd_tell'),
        fd_advise:             unimplemented('fd_advise'),
        fd_allocate:           unimplemented('fd_allocate'),
        fd_datasync:           unimplemented('fd_datasync'),
        fd_filestat_get:       unimplemented('fd_filestat_get'),
        fd_filestat_set_size:  unimplemented('fd_filestat_set_size'),
        fd_filestat_set_times: unimplemented('fd_filestat_set_times'),
        fd_pread:              unimplemented('fd_pread'),
        fd_pwrite:             unimplemented('fd_pwrite'),
        fd_renumber:           unimplemented('fd_renumber'),
        path_filestat_set_times: unimplemented('path_filestat_set_times'),
        path_link:             unimplemented('path_link'),
        path_readlink:         unimplemented('path_readlink'),
        path_symlink:          unimplemented('path_symlink'),
        poll_oneoff:           unimplemented('poll_oneoff'),
        proc_raise:            unimplemented('proc_raise'),
        sched_yield:           unimplemented('sched_yield'),
        sock_accept:           unimplemented('sock_accept'),
        sock_recv:             unimplemented('sock_recv'),
        sock_send:             unimplemented('sock_send'),
        sock_shutdown:         unimplemented('sock_shutdown'),
      },
    };
  }
}
