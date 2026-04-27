import {
  VFSNode,
  FileDescriptor,
  FileStat,
  DirEntry,
  DirListing,
  FileType,
} from '../types.js';
import { FileNotFoundError, FSOperationError } from '../errors/index.js';
import { PersistenceBackend, NoPersistenceBackend } from '../persistence/index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const OFLAGS_CREAT = 0x0001;
const OFLAGS_DIRECTORY = 0x0002;
const OFLAGS_EXCL = 0x0004;
const OFLAGS_TRUNC = 0x0008;

const WHENCE_SET = 0;
const WHENCE_CUR = 1;
const WHENCE_END = 2;

// ─── VirtualFileSystem ────────────────────────────────────────────────────────

export class VirtualFileSystem {
  private nodes: Map<string, VFSNode> = new Map();
  private descriptors: Map<number, FileDescriptor> = new Map();
  private nextFd: number = 5; // 0-4 reserved (stdin/stdout/stderr + 2 preopen dirs)
  private nextIno: bigint = 1n;

  private backend: PersistenceBackend = new NoPersistenceBackend();
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this._initDirectories();
  }

  // ─── Initialization ─────────────────────────────────────────────────────────

  private _initDirectories(): void {
    const dirs = [
      '/',
      '/home',
      '/home/user',
      '/tmp',
      '/usr',
      '/usr/lib',
      '/usr/lib/python3.13',
      '/usr/local',
      '/usr/local/lib',
      '/usr/local/lib/python3.13',
      '/usr/local/lib/python3.13/site-packages',
    ];
    for (const dir of dirs) {
      this._mkdirNode(dir);
    }
  }

  private _mkdirNode(path: string): void {
    const normalized = this._normalize(path);
    if (!this.nodes.has(normalized)) {
      this.nodes.set(normalized, {
        type: 'directory',
        children: new Set(),
        mtime: Date.now(),
        size: 0,
      });
      // Register as child of parent
      if (normalized !== '/') {
        const parent = this._parentPath(normalized);
        const parentNode = this.nodes.get(parent);
        if (parentNode && parentNode.type === 'directory') {
          parentNode.children!.add(this._basename(normalized));
        }
      }
    }
  }

  // ─── Path Utilities ──────────────────────────────────────────────────────────

  private _normalize(path: string): string {
    // Ensure POSIX-style absolute path
    let p = path.replace(/\\/g, '/');
    if (!p.startsWith('/')) p = '/' + p;
    // Collapse multiple slashes and resolve . and ..
    const parts = p.split('/').filter(Boolean);
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === '.') continue;
      if (part === '..') { resolved.pop(); continue; }
      resolved.push(part);
    }
    return '/' + resolved.join('/');
  }

  private _parentPath(normalized: string): string {
    if (normalized === '/') return '/';
    const idx = normalized.lastIndexOf('/');
    return idx === 0 ? '/' : normalized.slice(0, idx);
  }

  private _basename(normalized: string): string {
    return normalized.slice(normalized.lastIndexOf('/') + 1);
  }

  // ─── WASI-level operations ───────────────────────────────────────────────────

  pathOpen(path: string, flags: number): FileDescriptor {
    const normalized = this._normalize(path);
    const createIfMissing = (flags & OFLAGS_CREAT) !== 0;
    const truncate = (flags & OFLAGS_TRUNC) !== 0;
    const exclusive = (flags & OFLAGS_EXCL) !== 0;
    const openDir = (flags & OFLAGS_DIRECTORY) !== 0;

    let node = this.nodes.get(normalized);

    if (!node) {
      if (createIfMissing) {
        if (openDir) {
          this.pathCreateDirectory(normalized);
          node = this.nodes.get(normalized)!;
        } else {
          // Create parent dirs if needed
          const parent = this._parentPath(normalized);
          if (!this.nodes.has(parent)) {
            throw new FSOperationError('pathOpen', normalized, `Parent directory does not exist: ${parent}`);
          }
          const parentNode = this.nodes.get(parent)!;
          if (parentNode.type !== 'directory') {
            throw new FSOperationError('pathOpen', normalized, `Parent is not a directory: ${parent}`);
          }
          node = { type: 'file', content: new Uint8Array(0), mtime: Date.now(), size: 0 };
          this.nodes.set(normalized, node);
          parentNode.children!.add(this._basename(normalized));
        }
      } else {
        throw new FileNotFoundError(normalized);
      }
    } else if (exclusive) {
      throw new FSOperationError('pathOpen', normalized, `File already exists: ${normalized}`);
    } else if (truncate && node.type === 'file') {
      node.content = new Uint8Array(0);
      node.size = 0;
      node.mtime = Date.now();
    }

    const fd: FileDescriptor = {
      fd: this.nextFd++,
      path: normalized,
      flags,
      position: 0n,
      node,
    };
    this.descriptors.set(fd.fd, fd);
    return fd;
  }

  fdRead(fd: number, buf: Uint8Array): number {
    const descriptor = this._getDescriptor(fd);
    if (descriptor.node.type !== 'file') {
      throw new FSOperationError('fdRead', descriptor.path, 'Not a file');
    }
    const content = descriptor.node.content!;
    const pos = Number(descriptor.position);
    const available = content.length - pos;
    if (available <= 0) return 0;
    const toRead = Math.min(buf.length, available);
    buf.set(content.subarray(pos, pos + toRead));
    descriptor.position += BigInt(toRead);
    return toRead;
  }

  fdWrite(fd: number, data: Uint8Array): number {
    const descriptor = this._getDescriptor(fd);
    if (descriptor.node.type !== 'file') {
      throw new FSOperationError('fdWrite', descriptor.path, 'Not a file');
    }
    const node = descriptor.node;
    const pos = Number(descriptor.position);
    const current = node.content!;
    const newSize = Math.max(current.length, pos + data.length);
    const newContent = new Uint8Array(newSize);
    newContent.set(current);
    newContent.set(data, pos);
    node.content = newContent;
    node.size = newSize;
    node.mtime = Date.now();
    descriptor.position += BigInt(data.length);
    return data.length;
  }

  fdSeek(fd: number, offset: bigint, whence: number): bigint {
    const descriptor = this._getDescriptor(fd);
    const size = BigInt(descriptor.node.size);
    let newPos: bigint;
    switch (whence) {
      case WHENCE_SET:
        newPos = offset;
        break;
      case WHENCE_CUR:
        newPos = descriptor.position + offset;
        break;
      case WHENCE_END:
        newPos = size + offset;
        break;
      default:
        throw new FSOperationError('fdSeek', descriptor.path, `Invalid whence: ${whence}`);
    }
    if (newPos < 0n) newPos = 0n;
    descriptor.position = newPos;
    return newPos;
  }

  fdClose(fd: number): void {
    if (!this.descriptors.has(fd)) {
      throw new FSOperationError('fdClose', String(fd), `Invalid file descriptor: ${fd}`);
    }
    this.descriptors.delete(fd);
  }

  pathStat(path: string): FileStat {
    const normalized = this._normalize(path);
    const node = this.nodes.get(normalized);
    if (!node) throw new FileNotFoundError(normalized);
    const mtimNs = BigInt(node.mtime) * 1_000_000n;
    return {
      dev: 1n,
      ino: this.nextIno++,
      filetype: node.type === 'directory' ? FileType.DIRECTORY : FileType.REGULAR_FILE,
      nlink: 1n,
      size: BigInt(node.size),
      atim: mtimNs,
      mtim: mtimNs,
      ctim: mtimNs,
    };
  }

  pathCreateDirectory(path: string): void {
    const normalized = this._normalize(path);
    if (this.nodes.has(normalized)) return; // already exists

    // Recursively ensure parent exists
    const parent = this._parentPath(normalized);
    if (parent !== normalized) {
      if (!this.nodes.has(parent)) {
        this.pathCreateDirectory(parent);
      }
      const parentNode = this.nodes.get(parent)!;
      if (parentNode.type !== 'directory') {
        throw new FSOperationError('pathCreateDirectory', normalized, `Parent is not a directory: ${parent}`);
      }
      parentNode.children!.add(this._basename(normalized));
    }

    this.nodes.set(normalized, {
      type: 'directory',
      children: new Set(),
      mtime: Date.now(),
      size: 0,
    });
  }

  pathRemoveDirectory(path: string): void {
    const normalized = this._normalize(path);
    const node = this.nodes.get(normalized);
    if (!node) throw new FileNotFoundError(normalized);
    if (node.type !== 'directory') {
      throw new FSOperationError('pathRemoveDirectory', normalized, 'Not a directory');
    }
    if (node.children && node.children.size > 0) {
      throw new FSOperationError('pathRemoveDirectory', normalized, 'Directory not empty');
    }
    this.nodes.delete(normalized);
    const parent = this._parentPath(normalized);
    const parentNode = this.nodes.get(parent);
    if (parentNode && parentNode.type === 'directory') {
      parentNode.children!.delete(this._basename(normalized));
    }
  }

  pathUnlinkFile(path: string): void {
    const normalized = this._normalize(path);
    const node = this.nodes.get(normalized);
    if (!node) throw new FileNotFoundError(normalized);
    if (node.type !== 'file') {
      throw new FSOperationError('pathUnlinkFile', normalized, 'Not a file');
    }
    this.nodes.delete(normalized);
    const parent = this._parentPath(normalized);
    const parentNode = this.nodes.get(parent);
    if (parentNode && parentNode.type === 'directory') {
      parentNode.children!.delete(this._basename(normalized));
    }
  }

  pathRename(oldPath: string, newPath: string): void {
    const oldNorm = this._normalize(oldPath);
    const newNorm = this._normalize(newPath);
    const node = this.nodes.get(oldNorm);
    if (!node) throw new FileNotFoundError(oldNorm);

    // Ensure new parent exists
    const newParent = this._parentPath(newNorm);
    const newParentNode = this.nodes.get(newParent);
    if (!newParentNode || newParentNode.type !== 'directory') {
      throw new FSOperationError('pathRename', newNorm, `Parent directory does not exist: ${newParent}`);
    }

    // Remove from old parent
    const oldParent = this._parentPath(oldNorm);
    const oldParentNode = this.nodes.get(oldParent);
    if (oldParentNode && oldParentNode.type === 'directory') {
      oldParentNode.children!.delete(this._basename(oldNorm));
    }

    // Move node
    this.nodes.delete(oldNorm);
    this.nodes.set(newNorm, node);
    newParentNode.children!.add(this._basename(newNorm));
  }

  pathReaddir(path: string): DirEntry[] {
    const normalized = this._normalize(path);
    const node = this.nodes.get(normalized);
    if (!node) throw new FileNotFoundError(normalized);
    if (node.type !== 'directory') {
      throw new FSOperationError('pathReaddir', normalized, 'Not a directory');
    }
    const entries: DirEntry[] = [];
    let next = 1n;
    for (const name of node.children!) {
      const childPath = normalized === '/' ? `/${name}` : `${normalized}/${name}`;
      const childNode = this.nodes.get(childPath);
      entries.push({
        next: next++,
        ino: this.nextIno++,
        namelen: name.length,
        type: childNode?.type === 'directory' ? FileType.DIRECTORY : FileType.REGULAR_FILE,
        name,
      });
    }
    return entries;
  }

  // ─── Host-level operations ───────────────────────────────────────────────────

  writeFile(path: string, content: Uint8Array | string): void {
    const normalized = this._normalize(path);
    const bytes = typeof content === 'string'
      ? new TextEncoder().encode(content)
      : content;

    // Ensure parent directory exists
    const parent = this._parentPath(normalized);
    if (!this.nodes.has(parent)) {
      this.pathCreateDirectory(parent);
    }
    const parentNode = this.nodes.get(parent)!;
    if (parentNode.type !== 'directory') {
      throw new FSOperationError('writeFile', normalized, `Parent is not a directory: ${parent}`);
    }

    const existing = this.nodes.get(normalized);
    if (existing) {
      existing.content = bytes;
      existing.size = bytes.length;
      existing.mtime = Date.now();
    } else {
      this.nodes.set(normalized, {
        type: 'file',
        content: bytes,
        mtime: Date.now(),
        size: bytes.length,
      });
      parentNode.children!.add(this._basename(normalized));
    }
  }

  readFile(path: string): Uint8Array {
    const normalized = this._normalize(path);
    const node = this.nodes.get(normalized);
    if (!node) throw new FileNotFoundError(normalized);
    if (node.type !== 'file') {
      throw new FSOperationError('readFile', normalized, 'Not a file');
    }
    return node.content!;
  }

  listDir(path: string): DirListing[] {
    const normalized = this._normalize(path);
    const node = this.nodes.get(normalized);
    if (!node) throw new FileNotFoundError(normalized);
    if (node.type !== 'directory') {
      throw new FSOperationError('listDir', normalized, 'Not a directory');
    }
    const result: DirListing[] = [];
    for (const name of node.children!) {
      const childPath = normalized === '/' ? `/${name}` : `${normalized}/${name}`;
      const childNode = this.nodes.get(childPath);
      if (childNode) {
        result.push({
          name,
          isDirectory: childNode.type === 'directory',
          size: childNode.size,
        });
      }
    }
    return result;
  }

  async sync(): Promise<void> {
    const prefix = '/home/user/';
    for (const [path, node] of this.nodes.entries()) {
      if (node.type === 'file' && path.startsWith(prefix)) {
        await this.backend.save(path, node.content!);
      }
    }
  }

  async clearPersistent(): Promise<void> {
    await this.backend.clear();
    // Remove all in-memory files under /home/user/
    const toDelete: string[] = [];
    for (const [path, node] of this.nodes.entries()) {
      if (node.type === 'file' && path.startsWith('/home/user/')) {
        toDelete.push(path);
      }
    }
    for (const path of toDelete) {
      try { this.pathUnlinkFile(path); } catch { /* ignore */ }
    }
  }

  // ─── Persistence integration ─────────────────────────────────────────────

  /** Set the persistence backend. Does not automatically restore files. */
  setPersistenceBackend(backend: PersistenceBackend): void {
    this.backend = backend;
  }

  /** Restore files from the backend into the in-memory VFS. */
  async restoreFromBackend(backend: PersistenceBackend): Promise<void> {
    this.backend = backend;
    const paths = await backend.listAll();
    for (const path of paths) {
      const content = await backend.load(path);
      if (content !== null) {
        this.writeFile(path, content);
      }
    }
  }

  /** Start periodic auto-sync to the persistence backend. */
  startAutoSync(intervalMs: number): void {
    this.stopAutoSync();
    if (intervalMs > 0) {
      this.autoSyncTimer = setInterval(() => {
        this.sync().catch(() => { /* swallow errors in background sync */ });
      }, intervalMs);
    }
  }

  /** Stop periodic auto-sync. */
  stopAutoSync(): void {
    if (this.autoSyncTimer !== null) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  // ─── Internal helpers ────────────────────────────────────────────────────────

  private _getDescriptor(fd: number): FileDescriptor {
    const descriptor = this.descriptors.get(fd);
    if (!descriptor) {
      throw new FSOperationError('fd operation', String(fd), `Invalid file descriptor: ${fd}`);
    }
    return descriptor;
  }

  /** Expose node map size for memory usage reporting */
  get totalSize(): number {
    let total = 0;
    for (const node of this.nodes.values()) {
      total += node.size;
    }
    return total;
  }
}
