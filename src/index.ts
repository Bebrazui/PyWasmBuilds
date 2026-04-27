// ─── Main entry point ─────────────────────────────────────────────────────────

export { RuntimeProxy as PythonRuntime } from './proxy/RuntimeProxy.js';
export { RuntimeProxy } from './proxy/RuntimeProxy.js';

import { RuntimeProxy } from './proxy/RuntimeProxy.js';
export default RuntimeProxy;

// ─── Public types ─────────────────────────────────────────────────────────────

export type {
  RuntimeConfig,
  RunOptions,
  RunResult,
  PythonError,
  MemoryUsage,
  DirListing,
  InstallResult,
  PackageInfo,
  RuntimeWarning,
} from './types.js';

// ─── Error classes ────────────────────────────────────────────────────────────

export {
  RuntimeError,
  InitializationError,
  WASMLoadError,
  ConfigValidationError,
  ExecutionError,
  PythonException,
  ExecutionTimeoutError,
  FSError,
  FileNotFoundError,
  FSOperationError,
  PackageError,
  PackageNotFoundError,
  NoWASMWheelError,
  IncompatiblePackageError,
  SerializationError,
  SerializationDepthError,
  RuntimeDestroyedError,
} from './errors/index.js';

// ─── Proxies ──────────────────────────────────────────────────────────────────

export { FSProxy } from './proxy/FSProxy.js';
export { PipProxy } from './proxy/PipProxy.js';

// ─── Config ───────────────────────────────────────────────────────────────────

export { ConfigParser } from './config/ConfigParser.js';

// ─── Persistence ──────────────────────────────────────────────────────────────

export { detectBackend } from './persistence/index.js';
