# cpython-wasm

CPython 3.13 compiled to WebAssembly (wasm32-wasi). Run Python in the browser with a real CPython interpreter — no server required.

## Install

```bash
npm install cpython-wasm
```

## Usage

```js
import { PythonRuntime } from 'cpython-wasm';

// Zero config — automatically downloads python.wasm and stdlib from GitHub Releases
const py = new PythonRuntime();

py.onStdout = (line) => console.log(line);
py.onStderr = (line) => console.error(line);

await py.init(); // downloads ~33 MB on first run

await py.run('print("Hello from Python!")');
await py.run('import sys; print(sys.version)');
await py.run(`
result = sum(i**2 for i in range(10))
print(f"Sum of squares: {result}")
`);

py.destroy();
```

## Custom URLs (optional)

Serve files locally for faster load times:

```js
const py = new PythonRuntime({
  wasmUrl: '/assets/python.wasm',
  stdlibUrl: '/assets/python313-stdlib.zip',
});
```

Download from [GitHub Releases](https://github.com/Bebrazui/PyWasmBuilds/releases/tag/cpython-wasm-v3.13.0).

## API

### `new PythonRuntime(opts?)`

| Option | Type | Default |
|--------|------|---------|
| `wasmUrl` | `string` | GitHub Releases |
| `stdlibUrl` | `string` | GitHub Releases |
| `workerUrl` | `string?` | auto |

### `py.init(): Promise<void>`

Load stdlib, compile WASM, initialize runtime. Must be called before `run()`.

### `py.run(code: string): Promise<RunResult>`

Execute Python code. Returns when execution completes.

### `py.writeFile(path, content)`

Write a file into the virtual filesystem.

### `py.destroy()`

Terminate the worker and free resources.

### `py.onStdout = (line: string) => void`
### `py.onStderr = (line: string) => void`

## Requirements

- Browser with WebAssembly + Web Workers support
- Internet access for first load (or self-host the files)

## How it works

CPython 3.13 is compiled to `wasm32-wasi` using wasi-sdk. A custom WASI shim implements the system interface (file I/O, clocks, random) using browser APIs. The stdlib is extracted from a zip into an in-memory virtual filesystem on startup.

## License

MIT
