// ─── Runtime Configuration ───────────────────────────────────────────────────

export interface RuntimeConfig {
  pythonVersion: string;
  wasmUrl: string | null;
  persistenceBackend: 'opfs' | 'indexeddb' | 'none';
  autoSyncInterval: number;
  executionTimeout: number;
  allowedSyscalls: string[] | null;
}

// ─── Run API ─────────────────────────────────────────────────────────────────

export interface RunOptions {
  globals?: Record<string, unknown>;
  timeout?: number;
}

export interface RunResult {
  value: unknown;
  error?: PythonError;
}

export interface PythonError {
  type: string;
  message: string;
  traceback: string;
}

// ─── Memory ──────────────────────────────────────────────────────────────────

export interface MemoryUsage {
  wasmHeap: number;
  vfsSize: number;
}

// ─── Worker Message Protocol ─────────────────────────────────────────────────

export type WorkerRequest =
  | { type: 'run';         id: string; code: string; globals?: string }
  | { type: 'restart';     id: string }
  | { type: 'destroy';     id: string }
  | { type: 'fs.write';    id: string; path: string; content: Uint8Array }
  | { type: 'fs.read';     id: string; path: string }
  | { type: 'fs.list';     id: string; path: string }
  | { type: 'fs.sync';     id: string }
  | { type: 'fs.clear';    id: string }
  | { type: 'pip.install'; id: string; packages: string[] }
  | { type: 'pip.list';    id: string }
  | { type: 'memory';      id: string };

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'result';       id: string; value: string }
  | { type: 'error';        id: string; error: PythonError }
  | { type: 'stdout';       data: string }
  | { type: 'stderr';       data: string }
  | { type: 'warning';      code: string; message: string }
  | { type: 'fs.result';    id: string; value: unknown }
  | { type: 'pip.result';   id: string; value: unknown }
  | { type: 'memory.result'; id: string; value: MemoryUsage };

// ─── VFS ─────────────────────────────────────────────────────────────────────

export interface VFSNode {
  type: 'file' | 'directory';
  content?: Uint8Array;
  children?: Set<string>;
  mtime: number;
  size: number;
}

export type OpenFlags = number;

export const enum FileType {
  UNKNOWN = 0,
  BLOCK_DEVICE = 1,
  CHARACTER_DEVICE = 2,
  DIRECTORY = 3,
  REGULAR_FILE = 4,
  SOCKET_DGRAM = 5,
  SOCKET_STREAM = 6,
  SYMBOLIC_LINK = 7,
}

export interface FileDescriptor {
  fd: number;
  path: string;
  flags: OpenFlags;
  position: bigint;
  node: VFSNode;
}

export interface FileStat {
  dev: bigint;
  ino: bigint;
  filetype: FileType;
  nlink: bigint;
  size: bigint;
  atim: bigint;
  mtim: bigint;
  ctim: bigint;
}

export interface DirEntry {
  next: bigint;
  ino: bigint;
  namelen: number;
  type: FileType;
  name: string;
}

export interface DirListing {
  name: string;
  isDirectory: boolean;
  size: number;
}

// ─── WASM Wheels & Packages ──────────────────────────────────────────────────

export interface WASMWheelEntry {
  name: string;
  version: string;
  url: string;
  sha256: string;
  pythonVersion: string;
  platform: string;
  dependencies: string[];
  soFiles: string[];
}

export interface InstallResult {
  name: string;
  version: string;
  source: 'wasm-registry' | 'pypi';
}

export interface PackageInfo {
  name: string;
  version: string;
}

// ─── Warnings ────────────────────────────────────────────────────────────────

export interface RuntimeWarning {
  code: string;
  message: string;
}

// ─── WASI ────────────────────────────────────────────────────────────────────

export interface WASICallbacks {
  onStdout: (data: Uint8Array) => void;
  onStderr: (data: Uint8Array) => void;
  onUnknownSyscall: (name: string) => void;
}

export type WASIImports = Record<string, Record<string, CallableFunction>>;

// ─── Config Validation ───────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: Array<{ field: string; expectedType: string; actualType: string }>;
}
