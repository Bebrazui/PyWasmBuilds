import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { extname, join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.wasm': 'application/wasm',
  '.zip':  'application/zip',
  '.py':   'text/plain',
  '.txt':  'text/plain',
};

createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  const file = join(__dir, url);

  if (!existsSync(file)) {
    res.writeHead(404); res.end('Not found');
    return;
  }

  const ext = extname(file);
  const mime = MIME[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': mime,
    // Required for SharedArrayBuffer (interrupt mechanism)
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });

  res.end(readFileSync(file));
}).listen(8787, () => {
  console.log('Python WASM server: http://localhost:8787');
});
