/**
 * cpython-wasm — CPython 3.13 in WebAssembly
 *
 * Usage:
 *   import { PythonRuntime } from 'cpython-wasm';
 *
 *   const py = new PythonRuntime();
 *   py.onStdout = (line) => console.log(line);
 *   await py.init();
 *   await py.run('print("Hello from Python!")');
 */

const GITHUB_RELEASE = 'https://github.com/Bebrazui/PyWasmBuilds/releases/download/cpython-wasm-v3.13.0';

const DEFAULT_WASM_URL   = `${GITHUB_RELEASE}/python.wasm`;
const DEFAULT_STDLIB_URL = `${GITHUB_RELEASE}/python313-stdlib.zip`;

export interface PythonRuntimeOptions {
  /** URL to python.wasm binary. Defaults to GitHub Releases. */
  wasmUrl?: string;
  /** URL to python313-stdlib.zip. Defaults to GitHub Releases. */
  stdlibUrl?: string;
  /** URL to the worker script. Defaults to auto-resolved worker.js */
  workerUrl?: string;
}

export interface RunResult {
  /** Exit code from Python process (0 = success) */
  exitCode: number;
}

export class PythonRuntime {
  private worker: Worker | null = null;
  private opts: PythonRuntimeOptions;
  private ready = false;
  private pendingRuns = new Map<string, { resolve: (r: RunResult) => void; reject: (e: Error) => void }>();
  private runCounter = 0;

  /** Called for each line written to stdout */
  onStdout: (line: string) => void = () => {};
  /** Called for each line written to stderr */
  onStderr: (line: string) => void = () => {};

  constructor(opts?: PythonRuntimeOptions) {
    this.opts = {
      wasmUrl:   opts?.wasmUrl   ?? DEFAULT_WASM_URL,
      stdlibUrl: opts?.stdlibUrl ?? DEFAULT_STDLIB_URL,
      workerUrl: opts?.workerUrl,
    };
  }

  /**
   * Initialize the runtime — loads stdlib and compiles WASM.
   * Must be called before run().
   */
  async init(): Promise<void> {
    const workerUrl = this.opts.workerUrl ?? new URL('./worker.js', import.meta.url).href;

    this.worker = new Worker(workerUrl, { type: 'module' });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('PythonRuntime init timeout')), 120_000);

      this.worker!.onmessage = (e: MessageEvent) => {
        const msg = e.data as WorkerMessage;

        if (msg.type === 'ready') {
          clearTimeout(timeout);
          this.ready = true;
          resolve();
          // Switch to normal message handler
          this.worker!.onmessage = this._handleMessage.bind(this);
        } else if (msg.type === 'error' && msg.id === 'init') {
          clearTimeout(timeout);
          reject(new Error(msg.error.message));
        } else if (msg.type === 'status') {
          // ignore status during init
        }
      };

      this.worker!.onerror = (e) => {
        clearTimeout(timeout);
        reject(new Error('Worker error: ' + e.message));
      };

      // Send init message
      this.worker!.postMessage({
        type: 'init',
        wasmUrl: this.opts.wasmUrl,
        stdlibUrl: this.opts.stdlibUrl,
      });
    });
  }

  /**
   * Run Python code. Returns when execution completes.
   */
  run(code: string): Promise<RunResult> {
    if (!this.ready || !this.worker) {
      return Promise.reject(new Error('PythonRuntime not initialized. Call init() first.'));
    }

    const id = String(++this.runCounter);

    return new Promise((resolve, reject) => {
      this.pendingRuns.set(id, { resolve, reject });
      this.worker!.postMessage({ type: 'run', id, code });
    });
  }

  /**
   * Write a file into the virtual filesystem.
   */
  writeFile(path: string, content: string | Uint8Array): void {
    if (!this.worker) throw new Error('Not initialized');
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    this.worker.postMessage({ type: 'fs.write', path, content: bytes });
  }

  /**
   * Destroy the runtime and free resources.
   */
  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    for (const { reject } of this.pendingRuns.values()) {
      reject(new Error('Runtime destroyed'));
    }
    this.pendingRuns.clear();
  }

  private _handleMessage(e: MessageEvent): void {
    const msg = e.data as WorkerMessage;

    switch (msg.type) {
      case 'stdout':
        this.onStdout(msg.data);
        break;
      case 'stderr':
        this.onStderr(msg.data);
        break;
      case 'result': {
        const pending = this.pendingRuns.get(msg.id);
        if (pending) {
          pending.resolve({ exitCode: 0 });
          this.pendingRuns.delete(msg.id);
        }
        break;
      }
      case 'error': {
        const pending = this.pendingRuns.get(msg.id);
        if (pending) {
          pending.reject(new Error(msg.error.message));
          this.pendingRuns.delete(msg.id);
        }
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
  | { type: 'error'; id: string; error: { message: string } };
