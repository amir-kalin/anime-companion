// Tiny static file handler. No dependencies; the harness needs to serve the operator UI and the
// demo target over http so the browser treats them as a normal origin (iframes, storage, and
// CORS-influenced behavior only behave normally on http, not file://).
//
// The handler is exported separately from the server so the harness can mount it inside its own
// http server instead of juggling two listeners on two sockets.

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Build a (req, res) handler that serves files under `rootDir`.
 * Returns true when it handled the request, so a caller can fall through to its own routes.
 */
export function createStaticHandler(rootDir) {
  const root = resolve(rootDir);

  return function serveStatic(req, res) {
    const url = new URL(req.url, 'http://localhost');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end('bad path');
      return true;
    }
    if (pathname === '/') pathname = '/index.html';

    // Contain path traversal: resolve first, then confirm the result is still under root.
    const candidate = resolve(join(root, normalize(pathname)));
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
      return true;
    }
    if (!existsSync(candidate) || !statSync(candidate).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return true;
    }

    res.writeHead(200, {
      'content-type': MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(candidate).pipe(res);
    return true;
  };
}

/** Standalone static server, used by the probes and tests. */
export function createStaticServer(rootDir) {
  const server = createServer(createStaticHandler(rootDir));
  return {
    server,
    listen(port = 0) {
      return new Promise((done) => {
        server.listen(port, '127.0.0.1', () => {
          done({ port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` });
        });
      });
    },
    close() {
      return new Promise((done) => server.close(done));
    },
  };
}