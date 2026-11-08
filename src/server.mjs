import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { ApiError } from './manager.mjs';
import { StandaloneService } from './standalone-service.mjs';
import { FWR_CAP } from './standalone-firmware.mjs';

function secureEqual(a, b) {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function authorized(req, user, password) {
  if (!password) return true;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  let value;
  try { value = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const split = value.indexOf(':');
  return split > -1 && secureEqual(value.slice(0, split), user) &&
    secureEqual(value.slice(split + 1), password);
}
async function readJson(req) {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new ApiError('Expected JSON body');
  const chunks = []; let n = 0;
  for await (const chunk of req) {
    n += chunk.length;
    if (n > 65536) throw new ApiError('Body too large', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError('Invalid JSON'); }
}
function send(res, code, content, type = 'application/json; charset=utf-8') {
  const data = typeof content === 'string' ? content : JSON.stringify(content);
  res.writeHead(code, {
    'Content-Type': type, 'Content-Length': Buffer.byteLength(data),
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  });
  res.end(data);
}

async function readFwr(req) {
  if (req.headers['content-type'] !== 'application/x-mttl-fwr') {
    throw new ApiError('Expected .fwr image content type', 415);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > FWR_CAP) throw new ApiError('FWR exceeds firmware slot capacity', 413);
    chunks.push(chunk);
  }
  if (size < 44) throw new ApiError('FWR is too small', 400);
  return Buffer.concat(chunks);
}
function id(value, max = 64) {
  if (value.length > max || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new ApiError('Invalid identifier');
  return value;
}
function checkOrigin(req) {
  if (!req.headers.origin) return;
  let host;
  try { host = new URL(req.headers.origin).host; } catch { throw new ApiError('Invalid Origin', 403); }
  if (host !== req.headers.host) throw new ApiError('Cross-origin request denied', 403);
}
export function createHttpServer({ manager, user = 'admin', password = '', publicDir }) {
  const standalone = new StandaloneService(manager);
  return createServer(async (req, res) => {
    try {
      if (!authorized(req, user, password)) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Voltra Standalone", charset="UTF-8"');
        return send(res, 401, { error: 'Authentication required' });
      }
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      const method = req.method ?? 'GET';
      if (method !== 'GET') checkOrigin(req);
      if (method === 'GET' && path === '/health') return send(res, 200, { ok: true });
      if (method === 'GET' && path === '/api/status') return send(res, 200, await manager.status());
      if (method === 'GET' && path === '/api/bridges') return send(res, 200, manager.list());
      if (method === 'POST' && path === '/api/bridges') return send(res, 201, await manager.add(await readJson(req)));
      let m = path.match(/^\/api\/bridges\/([^/]+)$/);
      if (method === 'DELETE' && m) {
        await manager.remove(id(m[1])); return send(res, 200, { ok: true });
      }
      m = path.match(/^\/api\/bridges\/([^/]+)\/qr\.svg$/);
      if (method === 'GET' && m) return send(res, 200,
        await manager.request(id(m[1]), '/commissioning/qr.svg', { svg: true }), 'image/svg+xml; charset=utf-8');
      m = path.match(/^\/api\/bridges\/([^/]+)\/matter\/reconnect$/);
      if (method === 'POST' && m) {
        if ((await readJson(req)).confirm !== true) throw new ApiError('Confirmation required');
        return send(res, 200, await manager.request(id(m[1]), '/matter/reconnect', {
          method: 'POST', body: { confirm: true }
        }));
      }
      m = path.match(/^\/api\/bridges\/([^/]+)\/devices\/([^/]+)\/outlets\/(\d+)\/state$/);
      if (method === 'POST' && m) {
        const index = Number(m[3]);
        if (!Number.isInteger(index) || index < 1 || index > 4) throw new ApiError('Invalid outlet index');
        const body = await readJson(req);
        if (typeof body.on !== 'boolean') throw new ApiError('on must be boolean');
        return send(res, 200, await manager.setOutlet(id(m[1]), id(m[2], 40), index, body.on));
      }
      m = path.match(/^\/api\/bridges\/([^/]+)\/devices\/([^/]+)\/refresh$/);
      if (method === 'POST' && m) return send(res, 200, await manager.refreshDevice(id(m[1]), id(m[2], 40)));
      m = path.match(/^\/api\/bridges\/([^/]+)\/devices\/([^/]+)$/);
      if (method === 'DELETE' && m) return send(res, 200, await manager.removeDevice(id(m[1]), id(m[2], 40)));

      // Explicit Standalone firmware endpoints scoped to the registered device.
      m = path.match(/^\/api\/bridges\/([^/]+)\/devices\/([^/]+)\/standalone\/settings$/);
      if (m && method === 'GET') return send(res, 200,
        await standalone.info(id(m[1]), id(m[2], 40)));
      if (m && method === 'POST') return send(res, 200,
        await standalone.update(id(m[1]), id(m[2], 40), await readJson(req)));

      m = path.match(/^\/api\/bridges\/([^/]+)\/devices\/([^/]+)\/standalone\/wifi\/scan$/);
      if (m && method === 'POST') {
        await readJson(req);
        return send(res, 200, await standalone.scan(id(m[1]), id(m[2], 40)));
      }
      m = path.match(/^\/api\/bridges\/([^/]+)\/devices\/([^/]+)\/standalone\/wifi\/connect$/);
      if (m && method === 'POST') return send(res, 200,
        await standalone.wifi(id(m[1]), id(m[2], 40), await readJson(req)));

      m = path.match(/^\/api\/bridges\/([^/]+)\/devices\/([^/]+)\/standalone\/firmware\/upload$/);
      if (m && method === 'POST') {
        if (req.headers['x-voltra-confirm'] !== 'FLASH') {
          throw new ApiError('Firmware upload requires explicit FLASH confirmation', 400);
        }
        const hash = req.headers['x-voltra-fwr-sha256'];
        if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) {
          throw new ApiError('Valid FWR SHA-256 checksum required', 400);
        }
        return send(res, 200, await standalone.firmwareUpload(id(m[1]), id(m[2], 40),
          await readFwr(req), hash));
      }
      const staticFiles = {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
        '/style.css': ['style.css', 'text/css; charset=utf-8']
      };
      if (method === 'GET' && staticFiles[path]) {
        const [file, type] = staticFiles[path];
        return send(res, 200, await readFile(join(publicDir, file), 'utf8'), type);
      }
      throw new ApiError('Not found', 404);
    } catch (e) {
      return send(res, e instanceof ApiError ? e.status : 502, { error: e.message ?? 'Unexpected error' });
    }
  });
}
