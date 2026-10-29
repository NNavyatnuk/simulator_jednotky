import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

export function createServer() {
  return http.createServer(async (req, res) => {
    const headers = {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...headers, Allow: 'GET, HEAD' }).end();
      return;
    }
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400, headers).end('Invalid URL'); return; }
    if (path === '/health') {
      res.writeHead(200, { ...headers, 'Content-Type': TYPES['.json'] }).end(req.method === 'HEAD' ? undefined : JSON.stringify({ status: 'ok', application: 'simulator-jednotky' }));
      return;
    }
    if (path === '/favicon.ico') { res.writeHead(204, headers).end(); return; }
    // Serve only the application, never the checkout, Git metadata or user files.
    const allowed = path === '/' || path === '/index.html' || /^\/src\/[a-zA-Z0-9_-]+\.(js|css)$/.test(path);
    const file = resolve(ROOT, '.' + (path === '/' ? '/index.html' : path));
    if (!allowed || !file.startsWith(ROOT + sep)) {
      res.writeHead(404, headers).end('Not found'); return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500, headers).end('Not found');
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT musí být celé číslo 1–65535.');
  createServer().listen(port, host, () => console.log(`Simulátor spuštěn na portu ${port}.`));
}
