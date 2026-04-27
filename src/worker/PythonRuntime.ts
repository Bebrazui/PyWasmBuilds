import { RuntimeConfig, MemoryUsage, PythonError } from '../types.js';
import { VirtualFileSystem } from '../vfs/VirtualFileSystem.js';
import { WASIShim } from '../wasi/WASIShim.js';
import { WASMExtensionLoader } from './WASMExtensionLoader.js';
import { PipManager } from '../pip/PipManager.js';
import { Serializer } from '../serializer/Serializer.js';
import { detectBackend } from '../persistence/index.js';
import { InitializationError, WASMLoadError } from '../errors/index.js';

// ─── PythonRuntime ────────────────────────────────────────────────────────────

export class PythonRuntime {
  private config: RuntimeConfig;
  private wasmInstance: WebAssembly.Instance | null = null;
  private wasmMemory: WebAssembly.Memory | null = null;
  public vfs: VirtualFileSystem;
  private wasi: WASIShim;
  private extensionLoader: WASMExtensionLoader;
  public pipManager: PipManager;
  private serializer: Serializer;
  private initialized: boolean = false;
  private destroyed: boolean = false;
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;

  // Stdout/stderr callbacks — set by WorkerEntrypoint
  onStdout: (data: string) => void = () => {};
  onStderr: (data: string) => void = () => {};

  constructor(config: RuntimeConfig) {
    this.config = config;
    this.vfs = new VirtualFileSystem();
    this.wasi = new WASIShim();
    this.extensionLoader = new WASMExtensionLoader();
    this.serializer = new Serializer();
    this.pipManager = new PipManager(this.vfs, this.extensionLoader.registry);
  }

  // ─── init ──────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    if (this.initialized) return;

    const wasmUrl =
      this.config.wasmUrl ??
      'https://cdn.jsdelivr.net/gh/python/cpython@v3.13.0/wasm/python.wasm';

    // Build WASI callbacks
    const callbacks = {
      onStdout: (data: Uint8Array) => {
        const text = new TextDecoder().decode(data);
        this.onStdout(text);
      },
      onStderr: (data: Uint8Array) => {
        const text = new TextDecoder().decode(data);
        this.onStderr(text);
      },
      onUnknownSyscall: (name: string) => {
        console.warn(`[PythonRuntime] Unknown syscall: ${name}`);
      },
    };

    const wasiImports = this.wasi.buildImports(this.vfs, callbacks, {
      allowedSyscalls: this.config.allowedSyscalls,
    });

    // Load CPython WASM
    let instance: WebAssembly.Instance;
    try {
      const result = await WebAssembly.instantiateStreaming(fetch(wasmUrl), wasiImports);
      instance = result.instance;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new WASMLoadError(wasmUrl, null, `Failed to load CPython WASM: ${message}`);
    }

    this.wasmInstance = instance;
    const memory = instance.exports['memory'];
    if (memory instanceof WebAssembly.Memory) {
      this.wasmMemory = memory;
      this.wasi.setMemory(memory);
    }

    // Register main module with extension loader
    this.extensionLoader.setMainModule(instance);

    // Call _Py_InitializeMain if available
    const initMain = instance.exports['_Py_InitializeMain'];
    if (typeof initMain === 'function') {
      try {
        (initMain as () => void)();
      } catch (e) {
        // Ignore proc_exit and similar startup errors in mock/stub mode
        if (!(e instanceof Error && e.message.startsWith('proc_exit:'))) {
          throw new InitializationError(`CPython initialization failed: ${String(e)}`);
        }
      }
    }

    // Restore VFS from persistence backend
    const backend = await detectBackend();
    await this.vfs.restoreFromBackend(backend);

    // Start auto-sync if configured
    if (this.config.autoSyncInterval > 0) {
      this.vfs.startAutoSync(this.config.autoSyncInterval);
    }

    this.initialized = true;
  }

  // ─── run ───────────────────────────────────────────────────────────────────

  async run(
    code: string,
    globalsJson?: string,
  ): Promise<{ value: string; error?: PythonError }> {
    if (!this.initialized) {
      throw new InitializationError('PythonRuntime is not initialized. Call init() first.');
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    try {
      // Set up execution timeout
      if (this.config.executionTimeout > 0) {
        timeoutHandle = setTimeout(() => {
          this._interrupt();
        }, this.config.executionTimeout);
      }

      // If globals provided, inject them into Python namespace
      if (globalsJson) {
        const setGlobalsCode = `
import json as _json
_globals_data = _json.loads(${JSON.stringify(globalsJson)})
for _k, _v in _globals_data.items():
    globals()[_k] = _v
del _json, _globals_data, _k, _v
`;
        this._pyRunString(setGlobalsCode);
      }

      // Execute the user code
      const result = this._pyRunString(code);

      return { value: result };
    } catch (e) {
      const error = this._toPythonError(e);
      return { value: 'null', error };
    } finally {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  // ─── restart ───────────────────────────────────────────────────────────────

  async restart(): Promise<void> {
    if (!this.initialized) return;

    // Try to call Py_Finalize + Py_Initialize if available
    if (this.wasmInstance) {
      const pyFinalize = this.wasmInstance.exports['Py_Finalize'];
      const pyInitialize = this.wasmInstance.exports['Py_Initialize'];

      if (typeof pyFinalize === 'function') {
        try { (pyFinalize as () => void)(); } catch { /* ignore */ }
      }
      if (typeof pyInitialize === 'function') {
        try { (pyInitialize as () => void)(); } catch { /* ignore */ }
      }
    }

    // VFS is preserved — no action needed
  }

  // ─── getMemoryUsage ────────────────────────────────────────────────────────

  getMemoryUsage(): MemoryUsage {
    return {
      wasmHeap: this.wasmMemory ? this.wasmMemory.buffer.byteLength : 0,
      vfsSize: this.vfs.totalSize,
    };
  }

  // ─── destroy ───────────────────────────────────────────────────────────────

  destroy(): void {
    this.destroyed = true;
    this.vfs.stopAutoSync();
    if (this.autoSyncTimer !== null) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    this.wasmInstance = null;
    this.wasmMemory = null;
    this.initialized = false;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /** Send interrupt signal (sets interrupt buffer if available). */
  private _interrupt(): void {
    // The WASIShim checks the interrupt buffer on each fd_write / clock_time_get.
    // We signal via a shared buffer if one was set; otherwise we rely on the
    // timeout mechanism in the WASI shim.
    // For now, this is a best-effort interrupt.
  }

  /**
   * Execute Python code via WASM exports.
   * Falls back to mock mode if PyRun_String is not available.
   */
  private _pyRunString(code: string): string {
    if (!this.wasmInstance) {
      return '"mock result"';
    }

    const pyRunString = this.wasmInstance.exports['PyRun_String'];

    if (typeof pyRunString !== 'function') {
      // Mock mode: real CPython WASM not available
      return '"mock result"';
    }

    // Real CPython path: encode code as C string in WASM memory and call PyRun_String
    // This requires allocating memory in WASM linear memory.
    // For now, use mock mode as the real binary is not available at this stage.
    return '"mock result"';
  }

  private _toPythonError(e: unknown): PythonError {
    if (e instanceof Error) {
      return {
        type: e.name ?? 'RuntimeError',
        message: e.message,
        traceback: e.stack ?? '',
      };
    }
    return {
      type: 'RuntimeError',
      message: String(e),
      traceback: '',
    };
  }

  /** Whether the runtime has been destroyed */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Whether the runtime has been initialized */
  get isInitialized(): boolean {
    return this.initialized;
  }
}
