import { PersistenceBackend } from './index.js';

// ─── IndexedDBBackend ─────────────────────────────────────────────────────────
//
// Stores VFS files in an IndexedDB object store named "vfs-files".
// Key: file path (string), Value: Uint8Array content.

const DB_NAME = 'python-wasm-vfs';
const STORE_NAME = 'vfs-files';
const DB_VERSION = 1;

export class IndexedDBBackend implements PersistenceBackend {
  readonly type = 'indexeddb' as const;

  private db: IDBDatabase | null = null;

  // ─── open ──────────────────────────────────────────────────────────────────

  private _open(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => {
        this.db = req.result;
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
  }

  // ─── save ──────────────────────────────────────────────────────────────────

  async save(path: string, content: Uint8Array): Promise<void> {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(content, path);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // ─── load ──────────────────────────────────────────────────────────────────

  async load(path: string): Promise<Uint8Array | null> {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(path);
      req.onsuccess = () => resolve((req.result as Uint8Array) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  // ─── delete ────────────────────────────────────────────────────────────────

  async delete(path: string): Promise<void> {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(path);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // ─── listAll ───────────────────────────────────────────────────────────────

  async listAll(): Promise<string[]> {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAllKeys();
      req.onsuccess = () => resolve(req.result as string[]);
      req.onerror = () => reject(req.error);
    });
  }

  // ─── clear ─────────────────────────────────────────────────────────────────

  async clear(): Promise<void> {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}
