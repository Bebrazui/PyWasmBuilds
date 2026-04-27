import { describe, it, expect, vi } from 'vitest';
import { VirtualFileSystem } from './vfs/VirtualFileSystem.js';
import { FileNotFoundError } from './errors/index.js';
import { ConfigParser } from './config/ConfigParser.js';
import { ConfigValidationError } from './errors/index.js';
import { Serializer } from './serializer/Serializer.js';
import { SerializationDepthError } from './errors/index.js';
import { NoPersistenceBackend } from './persistence/index.js';
import { PythonRuntime } from './worker/PythonRuntime.js';

// ─── 1. VFS предустановленная структура директорий (Requirement 3.5) ──────────

describe('VFS pre-installed directory structure', () => {
  it('should have /home/user, /tmp, /usr/lib/python3.13, /usr/local/lib/python3.13/site-packages', () => {
    const vfs = new VirtualFileSystem();
    const root = vfs.listDir('/');
    const names = root.map((e) => e.name);

    expect(names).toContain('home');
    expect(names).toContain('tmp');
    expect(names).toContain('usr');

    const home = vfs.listDir('/home');
    expect(home.map((e) => e.name)).toContain('user');

    const usrLib = vfs.listDir('/usr/lib');
    expect(usrLib.map((e) => e.name)).toContain('python3.13');

    const sitePackages = vfs.listDir('/usr/local/lib/python3.13');
    expect(sitePackages.map((e) => e.name)).toContain('site-packages');
  });
});

// ─── 2. VFS round-trip writeFile/readFile (Requirements 3.2, 3.3) ────────────

describe('VFS writeFile/readFile round-trip', () => {
  it('should read back the same content that was written', () => {
    const vfs = new VirtualFileSystem();
    const content = 'hello, world!';
    vfs.writeFile('/home/user/test.txt', content);
    const result = vfs.readFile('/home/user/test.txt');
    expect(new TextDecoder().decode(result)).toBe(content);
  });

  it('should handle binary content', () => {
    const vfs = new VirtualFileSystem();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    vfs.writeFile('/tmp/binary.bin', bytes);
    const result = vfs.readFile('/tmp/binary.bin');
    expect(result).toEqual(bytes);
  });
});

// ─── 3. VFS FileNotFoundError (Requirement 3.8) ───────────────────────────────

describe('VFS FileNotFoundError', () => {
  it('should throw FileNotFoundError for nonexistent path', () => {
    const vfs = new VirtualFileSystem();
    expect(() => vfs.readFile('/nonexistent/path')).toThrow(FileNotFoundError);
  });
});

// ─── 4. ConfigParser defaults (Requirement 11.1) ─────────────────────────────

describe('ConfigParser defaults', () => {
  it('should return correct defaults for empty config', () => {
    const parser = new ConfigParser();
    const config = parser.parse({});
    expect(config.pythonVersion).toBe('3.13');
    expect(config.persistenceBackend).toBe('opfs');
    expect(config.autoSyncInterval).toBe(5000);
    expect(config.executionTimeout).toBe(30000);
  });
});

// ─── 5. ConfigParser ConfigValidationError (Requirement 11.3) ────────────────

describe('ConfigParser ConfigValidationError', () => {
  it('should throw ConfigValidationError with field executionTimeout for invalid type', () => {
    const parser = new ConfigParser();
    expect(() => parser.parse({ executionTimeout: 'fast' })).toThrow(ConfigValidationError);
    try {
      parser.parse({ executionTimeout: 'fast' });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      expect((e as ConfigValidationError).field).toBe('executionTimeout');
    }
  });
});

// ─── 6. ConfigParser ignores unknown fields (Requirement 11.2) ───────────────

describe('ConfigParser unknown fields', () => {
  it('should not throw for unknown fields', () => {
    const parser = new ConfigParser();
    expect(() => parser.parse({ unknownField: 'value' })).not.toThrow();
  });
});

// ─── 7. Serializer round-trip (Requirements 8.1-8.4) ─────────────────────────

describe('Serializer round-trip', () => {
  const s = new Serializer();

  it('should round-trip primitives', () => {
    expect(s.jsonToJs(s.jsToJson(42))).toBe(42);
    expect(s.jsonToJs(s.jsToJson('hello'))).toBe('hello');
    expect(s.jsonToJs(s.jsToJson(true))).toBe(true);
    expect(s.jsonToJs(s.jsToJson(null))).toBe(null);
  });

  it('should round-trip arrays', () => {
    const arr = [1, 'two', false, null];
    expect(s.jsonToJs(s.jsToJson(arr))).toEqual(arr);
  });

  it('should round-trip objects', () => {
    const obj = { a: 1, b: 'hello', c: [1, 2, 3] };
    expect(s.jsonToJs(s.jsToJson(obj))).toEqual(obj);
  });
});

// ─── 8. Serializer SerializationDepthError (Requirement 8.4) ─────────────────

describe('Serializer SerializationDepthError', () => {
  it('should throw SerializationDepthError for depth > 100', () => {
    const s = new Serializer();
    // Build object 101 levels deep
    let deep: Record<string, unknown> = {};
    let current = deep;
    for (let i = 0; i < 101; i++) {
      current['child'] = {};
      current = current['child'] as Record<string, unknown>;
    }
    expect(() => s.jsToJson(deep)).toThrow(SerializationDepthError);
  });
});

// ─── 9. NoPersistenceBackend (Requirement 4.6) ───────────────────────────────

describe('NoPersistenceBackend', () => {
  it('save/load/listAll/clear work without errors and load returns null', async () => {
    const backend = new NoPersistenceBackend();
    await expect(backend.save('/some/path', new Uint8Array([1, 2]))).resolves.toBeUndefined();
    await expect(backend.load('/some/path')).resolves.toBeNull();
    await expect(backend.listAll()).resolves.toEqual([]);
    await expect(backend.clear()).resolves.toBeUndefined();
  });
});

// ─── 10. PythonRuntime mock mode ──────────────────────────────────────────────

describe('PythonRuntime mock mode', () => {
  it('should initialize with mock WASM and return zero memory usage', async () => {
    // Keep real WebAssembly.Memory so instanceof checks still work
    const RealMemory = WebAssembly.Memory;
    const RealInstance = WebAssembly.Instance;

    // Mock instantiateStreaming — instance has no 'memory' export so wasmMemory stays null
    const mockInstance = { exports: {} } as unknown as WebAssembly.Instance;

    vi.spyOn(WebAssembly, 'instantiateStreaming').mockResolvedValue({
      instance: mockInstance,
      module: {} as WebAssembly.Module,
    });

    // Mock fetch and navigator.storage so init() doesn't fail
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockRejectedValue(new Error('OPFS not available')),
      },
    });
    vi.stubGlobal('indexedDB', undefined);

    const parser = new ConfigParser();
    const config = parser.parse({ wasmUrl: 'mock://python.wasm' });
    const runtime = new PythonRuntime(config);

    await runtime.init();

    const usage = runtime.getMemoryUsage();
    expect(usage.wasmHeap).toBe(0);
    expect(usage.vfsSize).toBe(0);

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});
