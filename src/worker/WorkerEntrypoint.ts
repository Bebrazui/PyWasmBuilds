import { WorkerRequest, WorkerResponse, PythonError } from '../types.js';
import { PythonRuntime } from './PythonRuntime.js';
import { ConfigParser } from '../config/ConfigParser.js';

// ─── Worker state ─────────────────────────────────────────────────────────────

let runtime: PythonRuntime | null = null;
const configParser = new ConfigParser();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function post(msg: WorkerResponse): void {
  self.postMessage(msg);
}

function errorResponse(id: string, e: unknown): WorkerResponse {
  const err: PythonError = e instanceof Error
    ? { type: e.name ?? 'RuntimeError', message: e.message, traceback: e.stack ?? '' }
    : { type: 'RuntimeError', message: String(e), traceback: '' };
  return { type: 'error', id, error: err };
}

// ─── Message handler ──────────────────────────────────────────────────────────

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;

  // Special case: init creates the runtime
  if (req.type === 'init' as string) {
    try {
      // req carries config as extra field (not in WorkerRequest union, but sent by proxy)
      const rawConfig = (req as unknown as { config?: unknown }).config;
      const config = configParser.parse(rawConfig ?? {});
      runtime = new PythonRuntime(config);

      // Wire stdout/stderr to postMessage
      runtime.onStdout = (data: string) => post({ type: 'stdout', data });
      runtime.onStderr = (data: string) => post({ type: 'stderr', data });

      await runtime.init();
      post({ type: 'ready' });
    } catch (e) {
      post(errorResponse('init', e));
    }
    return;
  }

  // All other requests require an id
  const id = (req as { id: string }).id;

  try {
    switch (req.type) {
      case 'run': {
        if (!runtime) throw new Error('Runtime not initialized');
        const result = await runtime.run(req.code, req.globals);
        if (result.error) {
          post({ type: 'error', id, error: result.error });
        } else {
          post({ type: 'result', id, value: result.value });
        }
        break;
      }

      case 'restart': {
        if (!runtime) throw new Error('Runtime not initialized');
        await runtime.restart();
        post({ type: 'result', id, value: 'null' });
        break;
      }

      case 'destroy': {
        if (!runtime) throw new Error('Runtime not initialized');
        runtime.destroy();
        runtime = null;
        post({ type: 'result', id, value: 'null' });
        break;
      }

      case 'fs.write': {
        if (!runtime) throw new Error('Runtime not initialized');
        runtime.vfs.writeFile(req.path, req.content);
        post({ type: 'fs.result', id, value: null });
        break;
      }

      case 'fs.read': {
        if (!runtime) throw new Error('Runtime not initialized');
        const bytes = runtime.vfs.readFile(req.path);
        post({ type: 'fs.result', id, value: bytes });
        break;
      }

      case 'fs.list': {
        if (!runtime) throw new Error('Runtime not initialized');
        const listing = runtime.vfs.listDir(req.path);
        post({ type: 'fs.result', id, value: listing });
        break;
      }

      case 'fs.sync': {
        if (!runtime) throw new Error('Runtime not initialized');
        await runtime.vfs.sync();
        post({ type: 'fs.result', id, value: null });
        break;
      }

      case 'fs.clear': {
        if (!runtime) throw new Error('Runtime not initialized');
        await runtime.vfs.clearPersistent();
        post({ type: 'fs.result', id, value: null });
        break;
      }

      case 'pip.install': {
        if (!runtime) throw new Error('Runtime not initialized');
        const results = await runtime.pipManager.install(req.packages);
        post({ type: 'pip.result', id, value: results });
        break;
      }

      case 'pip.list': {
        if (!runtime) throw new Error('Runtime not initialized');
        const list = await runtime.pipManager.list();
        post({ type: 'pip.result', id, value: list });
        break;
      }

      case 'memory': {
        if (!runtime) throw new Error('Runtime not initialized');
        const usage = runtime.getMemoryUsage();
        post({ type: 'memory.result', id, value: usage });
        break;
      }

      default: {
        post(errorResponse(id, new Error(`Unknown request type: ${(req as WorkerRequest).type}`)));
        break;
      }
    }
  } catch (e) {
    post(errorResponse(id, e));
  }
};

// ─── Error handlers ───────────────────────────────────────────────────────────

self.onerror = (error: string | Event) => {
  const message = typeof error === 'string' ? error : 'Unhandled worker error';
  post({
    type: 'error',
    id: 'unhandled',
    error: { type: 'WorkerError', message, traceback: '' },
  });
};

self.onunhandledrejection = (event: PromiseRejectionEvent) => {
  const reason = event.reason;
  const message = reason instanceof Error ? reason.message : String(reason);
  const traceback = reason instanceof Error ? (reason.stack ?? '') : '';
  post({
    type: 'error',
    id: 'unhandled',
    error: { type: 'UnhandledRejection', message, traceback },
  });
};
