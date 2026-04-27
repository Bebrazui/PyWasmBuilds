import { OPFSBackend } from './OPFSBackend.js';
import { IndexedDBBackend } from './IndexedDBBackend.js';

// ─── PersistenceBackend interface ─────────────────────────────────────────────

export interface PersistenceBackend {
  type: 'opfs' | 'indexeddb' | 'none';
  save(path: string, content: Uint8Array): Promise<void>;
  load(path: string): Promise<Uint8Array | null>;
  delete(path: string): Promise<void>;
  listAll(): Promise<string[]>;
  clear(): Promise<void>;
}

// ─── NoPersistenceBackend ─────────────────────────────────────────────────────
//
// No-op backend used when neither OPFS nor IndexedDB is available.

export class NoPersistenceBackend implements PersistenceBackend {
  readonly type = 'none' as const;

  async save(_path: string, _content: Uint8Array): Promise<void> {}
  async load(_path: string): Promise<Uint8Array | null> { return null; }
  async delete(_path: string): Promise<void> {}
  async listAll(): Promise<string[]> { return []; }
  async clear(): Promise<void> {}
}

// ─── detectBackend ────────────────────────────────────────────────────────────
//
// Automatically selects the best available persistence backend:
//   OPFS → IndexedDB → none

async function _testIndexedDB(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('__idb_test__', 1);
    req.onsuccess = () => {
      req.result.close();
      indexedDB.deleteDatabase('__idb_test__');
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function detectBackend(): Promise<PersistenceBackend> {
  // Try OPFS first (preferred — synchronous access in Worker)
  try {
    const root = await navigator.storage.getDirectory();
    return new OPFSBackend(root);
  } catch {
    // OPFS not available
  }

  // Fall back to IndexedDB
  try {
    await _testIndexedDB();
    return new IndexedDBBackend();
  } catch {
    // IndexedDB not available
  }

  // No persistence available
  return new NoPersistenceBackend();
}

// Re-export concrete backends for direct use
export { OPFSBackend } from './OPFSBackend.js';
export { IndexedDBBackend } from './IndexedDBBackend.js';
