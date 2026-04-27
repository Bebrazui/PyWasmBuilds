import type { WorkerRequest, DirListing } from '../types.js';

// ─── FSProxy ──────────────────────────────────────────────────────────────────

export class FSProxy {
  constructor(private send: (req: WorkerRequest) => Promise<unknown>) {}

  async writeFile(path: string, content: Uint8Array | string): Promise<void> {
    const bytes =
      typeof content === 'string'
        ? new TextEncoder().encode(content)
        : content;

    await this.send({
      type: 'fs.write',
      id: this._id(),
      path,
      content: bytes,
    });
  }

  async readFile(path: string): Promise<Uint8Array> {
    const result = await this.send({
      type: 'fs.read',
      id: this._id(),
      path,
    });
    return result as Uint8Array;
  }

  async listDir(path: string): Promise<DirListing[]> {
    const result = await this.send({
      type: 'fs.list',
      id: this._id(),
      path,
    });
    return result as DirListing[];
  }

  async sync(): Promise<void> {
    await this.send({
      type: 'fs.sync',
      id: this._id(),
    });
  }

  async clearPersistent(): Promise<void> {
    await this.send({
      type: 'fs.clear',
      id: this._id(),
    });
  }

  private _id(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return Math.random().toString(36).substring(2);
  }
}
