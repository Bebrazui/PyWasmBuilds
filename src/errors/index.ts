// ─── Base ─────────────────────────────────────────────────────────────────────

export class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Initialization ──────────────────────────────────────────────────────────

export class InitializationError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = 'InitializationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WASMLoadError extends InitializationError {
  constructor(
    public readonly url: string,
    public readonly httpStatus: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'WASMLoadError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ConfigValidationError extends InitializationError {
  constructor(
    public readonly field: string,
    public readonly expectedType: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConfigValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Execution ───────────────────────────────────────────────────────────────

export class ExecutionError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PythonException extends ExecutionError {
  constructor(
    public readonly pythonType: string,
    public readonly pythonMessage: string,
    public readonly traceback: string,
  ) {
    super(`${pythonType}: ${pythonMessage}`);
    this.name = 'PythonException';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ExecutionTimeoutError extends ExecutionError {
  constructor(public readonly timeoutMs: number) {
    super(`Execution timed out after ${timeoutMs}ms`);
    this.name = 'ExecutionTimeoutError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── File System ─────────────────────────────────────────────────────────────

export class FSError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = 'FSError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class FileNotFoundError extends FSError {
  constructor(public readonly path: string) {
    super(`File not found: ${path}`);
    this.name = 'FileNotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class FSOperationError extends FSError {
  constructor(
    public readonly operation: string,
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'FSOperationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Package ─────────────────────────────────────────────────────────────────

export class PackageError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = 'PackageError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PackageNotFoundError extends PackageError {
  constructor(public readonly packageName: string) {
    super(`Package not found: ${packageName}`);
    this.name = 'PackageNotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NoWASMWheelError extends PackageError {
  constructor(
    public readonly packageName: string,
    public readonly registryUrl?: string,
  ) {
    super(
      `No WASM wheel available for package: ${packageName}` +
        (registryUrl ? `. See registry: ${registryUrl}` : ''),
    );
    this.name = 'NoWASMWheelError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class IncompatiblePackageError extends PackageError {
  constructor(
    public readonly packageName: string,
    public readonly reason: string,
  ) {
    super(`Incompatible package ${packageName}: ${reason}`);
    this.name = 'IncompatiblePackageError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Serialization ───────────────────────────────────────────────────────────

export class SerializationError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = 'SerializationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SerializationDepthError extends SerializationError {
  constructor(public readonly maxDepth: number) {
    super(`Serialization depth exceeded maximum of ${maxDepth} levels`);
    this.name = 'SerializationDepthError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export class RuntimeDestroyedError extends RuntimeError {
  constructor() {
    super('Runtime has been destroyed');
    this.name = 'RuntimeDestroyedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
