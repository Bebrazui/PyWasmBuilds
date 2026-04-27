import type { WorkerRequest, InstallResult, PackageInfo } from '../types.js';

// ─── PipProxy ─────────────────────────────────────────────────────────────────

export class PipProxy {
  constructor(private send: (req: WorkerRequest) => Promise<unknown>) {}

  async install(packages: string | string[]): Promise<InstallResult[]> {
    const pkgArray = Array.isArray(packages) ? packages : [packages];

    const result = await this.send({
      type: 'pip.install',
      id: this._id(),
      packages: pkgArray,
    });

    return result as InstallResult[];
  }

  async list(): Promise<PackageInfo[]> {
    const result = await this.send({
      type: 'pip.list',
      id: this._id(),
    });

    return result as PackageInfo[];
  }

  private _id(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return Math.random().toString(36).substring(2);
  }
}
