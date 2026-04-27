import { PersistenceBackend } from './index.js';

// ─── OPFSBackend ──────────────────────────────────────────────────────────────
//
// Uses the Origin Private File System (OPFS) via FileSystemSyncAccessHandle,
// which is only available inside a Web Worker. All operations are async at the
// JS level but use the synchronous OPFS handle internally.

export class OPFSBackend implements PersistenceBackend {
  readonly type = 'opfs' as const;

  constructor(private readonly root: FileSystemDirectoryHandle) {}

  // ─── save ──────────────────────────────────────────────────────────────────

  async save(path: string, content: Uint8Array): Promise<void> {
    const { dir, name } = this._splitPath(path);
    const dirHandle = await this._ensureDir(dir);
    const fileHandle = await dirHandle.getFileHandle(name, { create: true });
    const syncHandle = await (fileHandle as any).createSyncAccessHandle();
    try {
      syncHandle.truncate(0);
      syncHandle.write(content, { at: 0 });
      syncHandle.flush();
    } finally {
      syncHandle.close();
    }
  }

  // ─── load ──────────────────────────────────────────────────────────────────

  async load(path: string): Promise<Uint8Array | null> {
    try {
      const { dir, name } = this._splitPath(path);
      const dirHandle = await this._getDir(dir);
      if (!dirHandle) return null;
      const fileHandle = await dirHandle.getFileHandle(name);
      const syncHandle = await (fileHandle as any).createSyncAccessHandle();
      try {
        const size = syncHandle.getSize();
        const buf = new Uint8Array(size);
        syncHandle.read(buf, { at: 0 });
        return buf;
      } finally {
        syncHandle.close();
      }
    } catch {
      return null;
    }
  }

  // ─── delete ────────────────────────────────────────────────────────────────

  async delete(path: string): Promise<void> {
    try {
      const { dir, name } = this._splitPath(path);
      const dirHandle = await this._getDir(dir);
      if (!dirHandle) return;
      await dirHandle.removeEntry(name);
    } catch {
      // Ignore — file may not exist
    }
  }

  // ─── listAll ───────────────────────────────────────────────────────────────

  async listAll(): Promise<string[]> {
    const results: string[] = [];
    await this._collectFiles(this.root, '', results);
    return results;
  }

  // ─── clear ─────────────────────────────────────────────────────────────────

  async clear(): Promise<void> {
    const entries: string[] = [];
    for await (const [name] of (this.root as any).entries()) {
      entries.push(name);
    }
    for (const name of entries) {
      await this.root.removeEntry(name, { recursive: true });
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private _splitPath(path: string): { dir: string; name: string } {
    // Strip leading slash, then split into dir segments and filename
    const clean = path.replace(/^\//, '');
    const idx = clean.lastIndexOf('/');
    if (idx === -1) {
      return { dir: '', name: clean };
    }
    return { dir: clean.slice(0, idx), name: clean.slice(idx + 1) };
  }

  private async _ensureDir(dirPath: string): Promise<FileSystemDirectoryHandle> {
    if (!dirPath) return this.root;
    const parts = dirPath.split('/').filter(Boolean);
    let current: FileSystemDirectoryHandle = this.root;
    for (const part of parts) {
      current = await current.getDirectoryHandle(part, { create: true });
    }
    return current;
  }

  private async _getDir(dirPath: string): Promise<FileSystemDirectoryHandle | null> {
    if (!dirPath) return this.root;
    const parts = dirPath.split('/').filter(Boolean);
    let current: FileSystemDirectoryHandle = this.root;
    try {
      for (const part of parts) {
        current = await current.getDirectoryHandle(part);
      }
      return current;
    } catch {
      return null;
    }
  }

  private async _collectFiles(
    dir: FileSystemDirectoryHandle,
    prefix: string,
    results: string[],
  ): Promise<void> {
    for await (const [name, handle] of (dir as any).entries()) {
      const fullPath = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'file') {
        results.push('/' + fullPath);
      } else if (handle.kind === 'directory') {
        await this._collectFiles(handle as FileSystemDirectoryHandle, fullPath, results);
      }
    }
  }
}
