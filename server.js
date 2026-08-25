// HTTP-сервер акции «Рука волка». Один Node-процесс, без фреймворков.
// Слушает 127.0.0.1 — наружу только через nginx (см. deploy-scripts/nginx-wolfhand.conf).
//
// Локально:  node server.js   →  http://localhost:3000
// На сервере: systemd unit wolfhand.service

import http from 'node:http';
import { URL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const routes = {
  // Публичный контур
  'GET /api/config':          () => import('./api/config.js'),
  'POST /api/scan':           () => import('./api/scan.js'),
  'POST /api/entry':          () => import('./api/entry.js'),
  'GET /api/invite-status':   () => import('./api/invite-status.js'),
  'POST /api/registration':   () => import('./api/registration.js'),
  'POST /api/deal':           () => import('./api/deal.js'),
  'GET /api/session-status':  () => import('./api/session-status.js'),

  // Служебный контур
  'POST /api/session':          () => import('./api/session.js'),
  'POST /api/activate-invite':  () => import('./api/activate-invite.js'),
  'GET /api/redeem':            () => import('./api/redeem.js'),
  'POST /api/redeem':           () => import('./api/redeem.js'),

  'POST /api/admin/login':       () => import('./api/admin/login.js'),
  'POST /api/admin/logout':      () => import('./api/admin/logout.js'),
  'GET /api/admin/me':           () => import('./api/admin/me.js'),
  'GET /api/admin/stats':        () => import('./api/admin/stats.js'),
  'GET /api/admin/partners':     () => import('./api/admin/partners.js'),
  'GET /api/admin/leads':        () => import('./api/admin/leads.js'),
  'GET /api/admin/audit':        () => import('./api/admin/audit.js'),
  'GET /api/admin/fulfillment':  () => import('./api/admin/fulfillment.js'),
  'POST /api/admin/fulfillment': () => import('./api/admin/fulfillment.js'),
  'GET /api/admin/guest':        () => import('./api/admin/guest.js'),
  'GET /api/admin/qr':           () => import('./api/admin/qr.js'),
  'POST /api/admin/guest':       () => import('./api/admin/guest.js'),
};

const handlerCache = new Map();
async function getHandler(routeKey) {
  if (handlerCache.has(routeKey)) return handlerCache.get(routeKey);
  const loader = routes[routeKey];
  if (!loader) return null;
  const mod = await loader();
  const h = mod.default || mod.handler;
  handlerCache.set(routeKey, h);
  return h;
}

const STATIC_DIR = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml; charset=utf-8',
  '.ico':  'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Белый список статики: корневая игра, /admin/*, /docs/*, /img/*. */
function safePath(reqPath) {
  if (reqPath === '/' || reqPath === '/index.html') return path.join(STATIC_DIR, 'index.html');
  if (reqPath === '/admin' || reqPath === '/admin/') return path.join(STATIC_DIR, 'admin', 'index.html');
  for (const dir of ['admin', 'docs', 'img']) {
    if (reqPath.startsWith(`/${dir}/`) && !reqPath.includes('..')) {
      const file = path.normalize(path.join(STATIC_DIR, reqPath));
      if (file.startsWith(path.join(STATIC_DIR, dir) + path.sep)) return file;
    }
  }
  return null;
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const filePath = safePath(url.pathname);

  let stat = null;
  if (filePath) {
    try { stat = fs.statSync(filePath); } catch { stat = null; }
  }
  if (!stat || !stat.isFile()) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('404 Not Found');
  }

  const ext = path.extname(filePath).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  // Админки и игру не кэшируем: правки правил и призов должны доезжать сразу.
  res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=300');

  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    console.error(`[static] ${filePath}:`, err.code || err.message);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('500 Internal Server Error');
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const routeKey = `${req.method} ${url.pathname}`;

  if (url.pathname.startsWith('/api/')) {
    const handler = await getHandler(routeKey);
    if (!handler) {
      if (req.method === 'OPTIONS' && (routes[`POST ${url.pathname}`] || routes[`GET ${url.pathname}`])) {
        res.setHeader('Access-Control-Allow-Origin', process.env.PUBLIC_ORIGIN || '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Id, X-Device-Token');
        res.statusCode = 204;
        return res.end();
      }
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'NOT_FOUND' }));
    }
    try {
      await handler(req, res);
    } catch (e) {
      console.error(`[${routeKey}]`, e);
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'INTERNAL' }));
      }
    }
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);

  res.statusCode = 405;
  res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`«Рука волка» → http://${HOST}:${PORT}`);
  console.log(`KV_DRIVER=${process.env.KV_DRIVER || 'sqlite'}${process.env.DEV_MODE === '1' ? ' · DEV_MODE' : ''}`);
});

// Периодическая чистка протухших ключей
const drv = (process.env.KV_DRIVER || 'sqlite').toLowerCase();
if (drv === 'sqlite' || drv === 'memory') {
  import(drv === 'memory' ? './api/_lib/memory.js' : './api/_lib/sqlite.js').then(({ vacuum }) => {
    if (typeof vacuum !== 'function') return;
    setInterval(() => {
      try {
        const removed = vacuum();
        if (removed > 0) console.log(`[vacuum] удалено ${removed} протухших записей`);
      } catch (e) { console.warn('[vacuum]', e.message); }
    }, 30 * 60 * 1000).unref();
  }).catch(() => {});
}

function shutdown(sig) {
  console.log(`${sig} — останавливаюсь`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
