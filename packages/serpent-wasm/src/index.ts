/**
 * serpent-wasm — CPython 3.13 in WebAssembly (wasm32-wasi)
 * Run Python natively in the browser without Emscripten.
 *
 * Usage:
 *   import { PythonRuntime } from 'serpent-wasm';
 *
 *   const py = new PythonRuntime();
 *   py.onStdout = (line) => console.log(line);
 *   await py.init();
 *   await py.run('print("Hello from Python!")');
 *   await py.pip('requests');
 *   await py.fs.writeFile('/home/user/data.txt', 'hello');
 */

const GITHUB_RELEASE = 'https://github.com/Bebrazui/PyWasmBuilds/releases/download/cpython-wasm-v3.13.0';

const DEFAULT_WASM_URL   = `${GITHUB_RELEASE}/python.wasm`;
const DEFAULT_STDLIB_URL = `${GITHUB_RELEASE}/python313-stdlib.zip`;

// ── Public types ──────────────────────────────────────────────────────────────

export interface PythonRuntimeOptions {
  /** URL to python.wasm binary. Defaults to GitHub Releases. */
  wasmUrl?: string;
  /** URL to python313-stdlib.zip. Defaults to GitHub Releases. */
  stdlibUrl?: string;
  /** URL to the worker script. Defaults to bundled worker.js */
  workerUrl?: string;
}

export interface RunResult {
  exitCode: number;
}

export interface FileEntry {
  path: string;
  size: number;
  mtime: number;
}

export interface InstallResult {
  name: string;
  version: string;
}

// ── FSProxy ───────────────────────────────────────────────────────────────────

export class FSProxy {
  constructor(private _send: (msg: object) => Promise<unknown>) {}

  /** Write a file into the virtual filesystem (persisted to OPFS if under /home/user/) */
  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    await this._send({ type: 'fs.write', path, content: bytes });
  }

  /** Read a file from the virtual filesystem */
  async readFile(path: string): Promise<Uint8Array> {
    const result = await this._send({ type: 'fs.read', path });
    return result as Uint8Array;
  }

  /** List all persisted files under /home/user/ */
  async list(): Promise<FileEntry[]> {
    const result = await this._send({ type: 'fs.list' });
    return result as FileEntry[];
  }

  /** Delete a file from VFS and OPFS */
  async delete(path: string): Promise<void> {
    await this._send({ type: 'fs.delete', path });
  }
}

// ── PythonRuntime ─────────────────────────────────────────────────────────────

export class PythonRuntime {
  private worker: Worker | null = null;
  private opts: Required<PythonRuntimeOptions>;
  private ready = false;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private counter = 0;

  /** Called for each chunk written to stdout */
  onStdout: (data: string) => void = () => {};
  /** Called for each chunk written to stderr */
  onStderr: (data: string) => void = () => {};
  /** Called for status updates during init */
  onStatus: (text: string) => void = () => {};

  /** Virtual filesystem proxy */
  readonly fs: FSProxy;

  constructor(opts?: PythonRuntimeOptions) {
    this.opts = {
      wasmUrl:   opts?.wasmUrl   ?? DEFAULT_WASM_URL,
      stdlibUrl: opts?.stdlibUrl ?? DEFAULT_STDLIB_URL,
      workerUrl: opts?.workerUrl ?? '',
    };
    this.fs = new FSProxy(this._send.bind(this));
  }

  // ── init ───────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    let workerUrl: string;

    if (this.opts.workerUrl) {
      workerUrl = this.opts.workerUrl;
    } else {
      try {
        workerUrl = new URL('./worker.js', import.meta.url).href;
      } catch {
        workerUrl = `${GITHUB_RELEASE}/worker.js`;
      }
    }

    this.worker = new Worker(workerUrl, { type: 'module' });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('PythonRuntime init timeout (120s)')), 120_000);

      this.worker!.onmessage = (e: MessageEvent) => {
        const msg = e.data as WorkerMessage;
        if (msg.type === 'ready') {
          clearTimeout(timeout);
          this.ready = true;
          this.worker!.onmessage = this._handleMessage.bind(this);
          resolve();
        } else if (msg.type === 'status') {
          this.onStatus(msg.text);
        } else if (msg.type === 'error' && msg.id === 'init') {
          clearTimeout(timeout);
          reject(new Error(msg.error.message));
        }
      };

      this.worker!.onerror = (e) => {
        clearTimeout(timeout);
        reject(new Error('Worker error: ' + e.message));
      };

      this.worker!.postMessage({
        type: 'init',
        wasmUrl: this.opts.wasmUrl,
        stdlibUrl: this.opts.stdlibUrl,
      });
    });
  }

  // ── run ────────────────────────────────────────────────────────────────────

  run(code: string): Promise<RunResult> {
    return this._send({ type: 'run', code }) as Promise<RunResult>;
  }

  // ── pip ────────────────────────────────────────────────────────────────────

  pip(packageName: string): Promise<InstallResult | null> {
    return this._send({ type: 'pip.install', package: packageName }) as Promise<InstallResult | null>;
  }

  // ── C-extensions ───────────────────────────────────────────────────────────

  /**
   * Register a compiled C-extension WASM module.
   * After registration, `import <moduleName>` will work in Python.
   *
   * @param moduleName - Python module name (e.g. "testmodule")
   * @param wasmBytes  - Compiled .wasm bytes
   */
  async loadExtension(moduleName: string, wasmBytes: Uint8Array): Promise<void> {
    await this._send({ type: 'cext.register', moduleName, wasmBytes });
  }

  // ── destroy ────────────────────────────────────────────────────────────────

  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    for (const { reject } of this.pending.values()) {
      reject(new Error('Runtime destroyed'));
    }
    this.pending.clear();
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private _send(msg: object): Promise<unknown> {
    if (!this.ready || !this.worker) {
      return Promise.reject(new Error('PythonRuntime not initialized. Call init() first.'));
    }
    const id = String(++this.counter);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ ...msg, id });
    });
  }

  private _handleMessage(e: MessageEvent): void {
    const msg = e.data as WorkerMessage;
    switch (msg.type) {
      case 'stdout':      this.onStdout(msg.data); break;
      case 'stderr':      this.onStderr(msg.data); break;
      case 'status':      this.onStatus(msg.text); break;
      case 'pip.status':  this.onStderr('[pip] ' + msg.data + '\n'); break;
      case 'result': {
        const p = this.pending.get(msg.id);
        if (p) { p.resolve({ exitCode: 0 }); this.pending.delete(msg.id); }
        break;
      }
      case 'pip.result':
      case 'fs.result': {
        const p = this.pending.get(msg.id);
        if (p) { p.resolve(msg.value); this.pending.delete(msg.id); }
        break;
      }
      case 'error': {
        const p = this.pending.get(msg.id);
        if (p) { p.reject(new Error(msg.error.message)); this.pending.delete(msg.id); }
        break;
      }
    }
  }
}

// ── Internal worker message types ─────────────────────────────────────────────

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'status'; text: string }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'result'; id: string }
  | { type: 'pip.result'; id: string; value: unknown }
  | { type: 'pip.status'; data: string }
  | { type: 'fs.result'; id: string; value: unknown }
  | { type: 'error'; id: string; error: { message: string } };
