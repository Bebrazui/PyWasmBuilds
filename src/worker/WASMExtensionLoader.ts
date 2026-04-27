import { WASMWheelEntry } from '../types';
import { WASMLoadError } from '../errors';

// ─── WASMWheelRegistry ────────────────────────────────────────────────────────

export class WASMWheelRegistry {
  packages: Map<string, WASMWheelEntry> = new Map();

  constructor() {
    this._loadPreinstalled();
  }

  private _loadPreinstalled(): void {
    const preinstalled: WASMWheelEntry[] = [
      {
        name: 'numpy',
        version: '1.26.4',
        url: 'https://cdn.jsdelivr.net/pyodide/v0.26.0/full/numpy-1.26.4-cp313-cp313-wasm32_wasi.whl',
        sha256: '',
        pythonVersion: 'cp313',
        platform: 'wasm32_wasi',
        dependencies: [],
        soFiles: ['numpy/core/_multiarray_umath.so'],
      },
      {
        name: 'pandas',
        version: '2.2.2',
        url: 'https://cdn.jsdelivr.net/pyodide/v0.26.0/full/pandas-2.2.2-cp313-cp313-wasm32_wasi.whl',
        sha256: '',
        pythonVersion: 'cp313',
        platform: 'wasm32_wasi',
        dependencies: ['numpy'],
        soFiles: ['pandas/_libs/lib.so', 'pandas/_libs/hashtable.so'],
      },
      {
        name: 'scipy',
        version: '1.13.0',
        url: 'https://cdn.jsdelivr.net/pyodide/v0.26.0/full/scipy-1.13.0-cp313-cp313-wasm32_wasi.whl',
        sha256: '',
        pythonVersion: 'cp313',
        platform: 'wasm32_wasi',
        dependencies: ['numpy'],
        soFiles: ['scipy/linalg/_fblas.so'],
      },
      {
        name: 'pillow',
        version: '10.3.0',
        url: 'https://cdn.jsdelivr.net/pyodide/v0.26.0/full/Pillow-10.3.0-cp313-cp313-wasm32_wasi.whl',
        sha256: '',
        pythonVersion: 'cp313',
        platform: 'wasm32_wasi',
        dependencies: [],
        soFiles: ['PIL/_imaging.so'],
      },
      {
        name: 'cryptography',
        version: '42.0.8',
        url: 'https://cdn.jsdelivr.net/pyodide/v0.26.0/full/cryptography-42.0.8-cp313-cp313-wasm32_wasi.whl',
        sha256: '',
        pythonVersion: 'cp313',
        platform: 'wasm32_wasi',
        dependencies: ['cffi'],
        soFiles: ['cryptography/hazmat/bindings/_rust.so'],
      },
    ];

    for (const entry of preinstalled) {
      this.packages.set(entry.name.toLowerCase(), entry);
    }
  }

  resolve(name: string, version?: string): WASMWheelEntry | null {
    const entry = this.packages.get(name.toLowerCase()) ?? null;
    if (!entry) return null;
    if (version && entry.version !== version) return null;
    return entry;
  }
}

// ─── WASMExtensionLoader ──────────────────────────────────────────────────────

export class WASMExtensionLoader {
  /** Registry of pre-compiled WASM wheels */
  readonly registry: WASMWheelRegistry = new WASMWheelRegistry();

  /** Registered .so path → raw WASM bytes */
  private _soRegistry: Map<string, Uint8Array> = new Map();

  /** The main CPython WASM instance used as import source for C-extensions */
  private _mainModule: WebAssembly.Instance | null = null;

  /**
   * Register a .so file as a WASM module (stores bytes in the internal map).
   */
  register(soPath: string, wasmBytes: Uint8Array): void {
    this._soRegistry.set(soPath, wasmBytes);
  }

  /**
   * Check whether a .so path has been registered.
   */
  isRegistered(soPath: string): boolean {
    return this._soRegistry.has(soPath);
  }

  /**
   * Save the main CPython WASM instance for use as the import object
   * when linking C-extension modules.
   */
  setMainModule(instance: WebAssembly.Instance): void {
    this._mainModule = instance;
  }

  /**
   * Load and link a C-extension WASM module with CPython.
   *
   * The module is looked up by moduleName (matching the registered soPath
   * suffix, e.g. "numpy.core._multiarray_umath" → ends with that name).
   * The CPython exports are passed as the importObject so the extension can
   * call back into the interpreter.
   */
  async load(moduleName: string): Promise<WebAssembly.Instance> {
    // Find the registered .so that corresponds to this module name
    const soPath = this._resolveSoPath(moduleName);
    if (!soPath) {
      throw new WASMLoadError(
        moduleName,
        null,
        `No registered .so file found for module: ${moduleName}`,
      );
    }

    const wasmBytes = this._soRegistry.get(soPath)!;

    // Build the import object from CPython exports so the extension can
    // call back into the interpreter (dynamic linking).
    const importObject = this._buildImportObject();

    try {
      // WebAssembly.instantiate(BufferSource, imports) → WebAssemblyInstantiatedSource
      // We pass an ArrayBuffer explicitly to get the .instance property back.
      const buffer: ArrayBuffer =
        wasmBytes.buffer instanceof ArrayBuffer
          ? wasmBytes.buffer
          : new Uint8Array(wasmBytes).buffer;
      const source = await (WebAssembly.instantiate as (
        bytes: ArrayBuffer,
        imports?: WebAssembly.Imports,
      ) => Promise<WebAssembly.WebAssemblyInstantiatedSource>)(buffer, importObject);
      return source.instance;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new WASMLoadError(soPath, null, `Failed to instantiate WASM module for ${moduleName}: ${message}`);
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Find the registered soPath whose basename matches the module name.
   * e.g. moduleName "numpy.core._multiarray_umath" matches
   *      soPath "numpy/core/_multiarray_umath.so"
   */
  private _resolveSoPath(moduleName: string): string | null {
    // Convert dotted module name to path fragment
    const pathFragment = moduleName.replace(/\./g, '/');

    for (const soPath of this._soRegistry.keys()) {
      const withoutExt = soPath.replace(/\.so$/, '');
      if (withoutExt === pathFragment || withoutExt.endsWith('/' + pathFragment)) {
        return soPath;
      }
    }

    // Also try direct match (soPath itself equals moduleName)
    if (this._soRegistry.has(moduleName)) {
      return moduleName;
    }

    return null;
  }

  /**
   * Build the WebAssembly importObject from the main CPython module exports.
   * C-extensions import CPython C API symbols from the "env" namespace.
   */
  private _buildImportObject(): WebAssembly.Imports {
    if (!this._mainModule) {
      // No main module set yet — provide an empty env so instantiation can
      // still proceed (useful in tests / early-stage loading).
      return { env: {}, wasi_snapshot_preview1: {} };
    }

    // Expose all CPython exports under the "env" namespace so C-extensions
    // can resolve their imports against the interpreter's function table.
    const env: Record<string, WebAssembly.ExportValue> = {};
    for (const [name, value] of Object.entries(this._mainModule.exports)) {
      env[name] = value;
    }

    return { env, wasi_snapshot_preview1: {} };
  }
}
