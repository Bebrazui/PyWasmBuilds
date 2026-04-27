import type {
  RuntimeConfig,
  RunOptions,
  RunResult,
  MemoryUsage,
  RuntimeWarning,
  WorkerRequest,
  WorkerResponse,
} from '../types.js';
import {
  RuntimeDestroyedError,
  PythonException,
  ExecutionTimeoutError,
} from '../errors/index.js';
import { ConfigParser } from '../config/ConfigParser.js';
import { FSProxy } from './FSProxy.js';
import { PipProxy } from './PipProxy.js';

// ─── RuntimeProxy ─────────────────────────────────────────────────────────────

export class RuntimeProxy {
  private worker: Worker | null = null;
  private config: RuntimeConfig;
  private destroyed: boolean = false;
  private pendingRequests: Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  > = new Map();
  private interruptBuffer: SharedArrayBuffer | null = null;
  private configParser = new ConfigParser();

  // Callbacks
  onStdout: (data: string) => void = () => {};
  onStderr: (data: string) => void = () => {};
  onWarning: (warning: RuntimeWarning) => void = () => {};
  onMemoryWarning: (usage: MemoryUsage) => void = () => {};

  // Proxies
  fs: FSProxy;
  pip: PipProxy;

  constructor() {
    this.config = this.configParser.parse({});
    this.fs = new FSProxy(this._sendRequest.bind(this));
    this.pip = new PipProxy(this._sendRequest.bind(this));
  }

  // ─── Initialization ─────────────────────────────────────────────────────────

  async init(config?: Partial<RuntimeConfig>): Promise<void> {
    if (this.destroyed) {
      throw new RuntimeDestroyedError();
    }

    // Parse and merge config
    const parsedConfig = this.configParser.parse(config ?? {});
    this.config = parsedConfig;

    // Create Worker
    const workerUrl = new URL('../worker/WorkerEntrypoint.js', import.meta.url);
    this.worker = new Worker(workerUrl, { type: 'module' });

    // Create interrupt buffer if SharedArrayBuffer is available
    if (typeof SharedArrayBuffer !== 'undefined') {
      this.interruptBuffer = new SharedArrayBuffer(4);
    }

    // Setup message handler
    this.worker.onmessage = this._handleWorkerMessage.bind(this);

    // Send init message and wait for ready
    return new Promise<void>((resolve, reject) => {
      // Use fixed key 'init' so the 'ready' handler can find it
      this.pendingRequests.set('init', {
        resolve: () => resolve(),
        reject,
      });

      this.worker!.postMessage({
        type: 'init',
        config: this.configParser.serialize(parsedConfig),
      } as unknown as WorkerRequest);
    });
  }

  // ─── Worker Message Handler ─────────────────────────────────────────────────

  private _handleWorkerMessage(event: MessageEvent<WorkerResponse>): void {
    const msg = event.data;

    switch (msg.type) {
      case 'ready': {
        // Resolve init promise
        const pending = this.pendingRequests.get('init');
        if (pending) {
          pending.resolve(undefined);
          this.pendingRequests.delete('init');
        }
        break;
      }

      case 'result': {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          pending.resolve(msg.value);
          this.pendingRequests.delete(msg.id);
        }
        break;
      }

      case 'error': {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          const error = new PythonException(
            msg.error.type,
            msg.error.message,
            msg.error.traceback
          );
          pending.reject(error);
          this.pendingRequests.delete(msg.id);
        }
        break;
      }

      case 'stdout': {
        this.onStdout(msg.data);
        break;
      }

      case 'stderr': {
        this.onStderr(msg.data);
        break;
      }

      case 'warning': {
        this.onWarning({ code: msg.code, message: msg.message });
        break;
      }

      case 'fs.result': {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          pending.resolve(msg.value);
          this.pendingRequests.delete(msg.id);
        }
        break;
      }

      case 'pip.result': {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          pending.resolve(msg.value);
          this.pendingRequests.delete(msg.id);
        }
        break;
      }

      case 'memory.result': {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          pending.resolve(msg.value);
          this.pendingRequests.delete(msg.id);
        }
        break;
      }
    }
  }

  // ─── Run ────────────────────────────────────────────────────────────────────

  async run(code: string, options?: RunOptions): Promise<RunResult> {
    if (this.destroyed) {
      throw new RuntimeDestroyedError();
    }

    const id = this._generateId();
    const timeout = options?.timeout ?? this.config.executionTimeout;

    // Serialize globals if provided
    const globalsJson = options?.globals
      ? JSON.stringify(options.globals)
      : undefined;

    // Setup timeout
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (timeout > 0) {
      timeoutHandle = setTimeout(() => {
        this.interrupt();
        const pending = this.pendingRequests.get(id);
        if (pending) {
          pending.reject(new ExecutionTimeoutError(timeout));
          this.pendingRequests.delete(id);
        }
      }, timeout);
    }

    try {
      const req: WorkerRequest = globalsJson !== undefined
        ? { type: 'run', id, code, globals: globalsJson }
        : { type: 'run', id, code };

      const result = await this._sendRequest(req);

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      return { value: result };
    } catch (error) {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      throw error;
    }
  }

  // ─── Interrupt ──────────────────────────────────────────────────────────────

  interrupt(): void {
    if (this.interruptBuffer) {
      Atomics.store(new Int32Array(this.interruptBuffer), 0, 1);
    }
  }

  // ─── Restart ────────────────────────────────────────────────────────────────

  async restart(): Promise<void> {
    if (this.destroyed) {
      throw new RuntimeDestroyedError();
    }

    await this._sendRequest({
      type: 'restart',
      id: this._generateId(),
    });
  }

  // ─── Destroy ────────────────────────────────────────────────────────────────

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    const id = this._generateId();

    try {
      await this._sendRequest({
        type: 'destroy',
        id,
      });
    } finally {
      // Terminate worker
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
      }

      // Mark as destroyed
      this.destroyed = true;

      // Reject all pending requests
      for (const [reqId, pending] of this.pendingRequests.entries()) {
        pending.reject(new RuntimeDestroyedError());
      }
      this.pendingRequests.clear();
    }
  }

  // ─── Memory Usage ───────────────────────────────────────────────────────────

  async getMemoryUsage(): Promise<MemoryUsage> {
    if (this.destroyed) {
      throw new RuntimeDestroyedError();
    }

    const result = await this._sendRequest({
      type: 'memory',
      id: this._generateId(),
    });

    return result as MemoryUsage;
  }

  // ─── Config ─────────────────────────────────────────────────────────────────

  getConfig(): RuntimeConfig {
    return { ...this.config };
  }

  // ─── Internal Helpers ───────────────────────────────────────────────────────

  private _generateId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return Math.random().toString(36).substring(2);
  }

  private _sendRequest(req: WorkerRequest): Promise<unknown> {
    if (this.destroyed) {
      return Promise.reject(new RuntimeDestroyedError());
    }

    if (!this.worker) {
      return Promise.reject(new Error('Worker not initialized'));
    }

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(req.id, { resolve, reject });
      this.worker!.postMessage(req);
    });
  }
}
