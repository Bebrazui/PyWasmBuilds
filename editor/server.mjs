import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { extname, join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.wasm': 'application/wasm',
  '.zip':  'application/zip',
  '.py':   'text/plain',
  '.txt':  'text/plain',
  '.ts':   'text/plain',
};

createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';

  // Serve test-lib and packages from root, everything else from editor/
  let file;
  if (url.startsWith('/test-lib/') || url.startsWith('/packages/')) {
    file = join(ROOT, url);
  } else {
    file = join(__dir, url);
  }

  if (!existsSync(file)) {
    res.writeHead(404); res.end('Not found: ' + url);
    return;
  }

  const ext = extname(file);
  const mime = MIME[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': mime,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });

  res.end(readFileSync(file));
}).listen(8787, () => {
  console.log('Server: http://localhost:8787');
  console.log('Editor: http://localhost:8787/index.html');
  console.log('Lib test: http://localhost:8787/test-lib/index.html');
});
