/**
 * index.js -- the G-code Studio API server.
 *
 * node:http only, no framework. A dozen routes and file access is the whole
 * job; express would be 60 packages for a switch statement.
 *
 *   node server/index.js            # API on 5174, static from dist\ or the project root
 *   PORT=5555 node server/index.js
 *
 * Things this file owns that the api\ modules do not:
 *   - access control (BUGS B9). Every /api request needs the per-start token
 *     (header X-GCS-Token or ?token=), the Host must be a loopback name and any
 *     Origin must be a localhost page. No CORS headers at all: in dev, Vite
 *     proxies /api, so the browser never makes a cross-origin call.
 *   - static/dev handling. With no Vite running, this server serves dist\ (or
 *     the project root), injecting the token into index.html as a meta tag.
 *   - GET /api/watch, the Server-Sent Events stream. Claude writes new G-code
 *     versions from the terminal; the UI needs to notice without polling.
 *   - the /api/term WebSocket upgrade (the PTY itself lives in terminal.js).
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HttpError, PROJECT_ROOT, ARCHIVE_ROOT, relPath, contains,
  listJobs, getJob, parseFile, slimParse, safeResolveReal, readText,
} from './api/files.js';
import { handleEdit } from './api/edit.js';
import { handleSlice } from './api/slice.js';
import { handleThumbnail } from './api/thumbnail.js';
import { handleDiff } from './api/diff.js';
import { listVersions, baseOf, finalizeDraft } from './api/version.js';
import {
  readSelection, writeSelection, appendRequest, readRequests,
  getChat, postChatUser, postChatReply, getChatPending, chatStats,
  bridgeEvents, startBridgeWatch, attachFile,
} from './api/bridge.js';
import * as terminal from './terminal.js';

const PORT = Number(process.env.PORT || process.env.GCS_PORT || 5174);
const HOST = process.env.GCS_HOST || '127.0.0.1';
const MAX_BODY = 8 * 1024 * 1024;
const MAX_ATTACH_BODY = 12 * 1024 * 1024; // 6 MB PNG as base64 (8 MB) + 2 MB JSON

// ---------------------------------------------------------------------------
// access control (BUGS B9)
// ---------------------------------------------------------------------------
// A terminal endpoint is a shell, and before this any page open in any browser
// on this PC could call the API. Three checks:
//   token  -- random per start; only a same-origin page can read it (meta tag)
//   Host   -- must be a loopback name, which defeats DNS rebinding
//   Origin -- when present, must be a localhost page

const TOKEN = process.env.GCS_TOKEN || crypto.randomBytes(24).toString('hex');
const TOKEN_BUF = Buffer.from(TOKEN);

/** The token every /api request must carry. */
export function getToken() { return TOKEN; }

/**
 * Where the token is written for the Vite dev plugin and CLI tools. Tests set
 * GCS_TOKEN_FILE elsewhere so a test run never overwrites the live app's token.
 */
export function tokenFile() {
  return process.env.GCS_TOKEN_FILE || path.join(PROJECT_ROOT, '.gcs-token');
}

const HOST_OK = new Set(['localhost', '127.0.0.1', '[::1]']);
const ORIGIN_OK = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/i;

function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

function tokenMatches(given) {
  if (typeof given !== 'string' || !given) return false;
  const b = Buffer.from(given);
  return b.length === TOKEN_BUF.length && crypto.timingSafeEqual(b, TOKEN_BUF);
}

/**
 * Host + Origin, plus the token when `needToken`. Returns null when allowed,
 * else `{ status, error }`. Shared by HTTP routing and the WebSocket upgrade.
 */
export function checkAccess(req, url, needToken) {
  if (!HOST_OK.has(hostnameOf(req.headers.host))) {
    return { status: 403, error: 'forbidden host' };
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !ORIGIN_OK.test(String(origin))) {
    return { status: 403, error: 'forbidden origin' };
  }
  if (needToken) {
    const given = req.headers['x-gcs-token'] || (url && url.searchParams.get('token'));
    if (!tokenMatches(Array.isArray(given) ? given[0] : given)) {
      return { status: 401, error: 'missing or wrong token (X-GCS-Token header or ?token=)' };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, e) {
  const status = e instanceof HttpError ? e.status : 500;
  if (status >= 500) console.error('[api]', e);
  sendJson(res, status, {
    error: e.message || 'internal error',
    ...(e.detail ? { detail: e.detail } : {}),
    ...(status >= 500 ? { stack: String(e.stack || '').split('\n').slice(0, 5) } : {}),
  });
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new HttpError(400, 'body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// SSE: GET /api/watch
// ---------------------------------------------------------------------------

const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

function handleWatch(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({
    archiveRoot: ARCHIVE_ROOT, projectRoot: PROJECT_ROOT, port: PORT, ts: Date.now(),
  })}\n\n`);
  clients.add(res);

  const ping = setInterval(() => {
    try { res.write(`event: ping\ndata: ${Date.now()}\n\n`); } catch { /* closing */ }
  }, 20000);

  const close = () => { clearInterval(ping); clients.delete(res); };
  req.on('close', close);
  req.on('error', close);
}

// --- watching G-code on disk ------------------------------------------------
// Claude writes a new version from the terminal; the UI must hot-reload. One
// recursive watch over the Archive root catches new job folders as well as new
// versions inside existing ones. Anything under the app's own directory is
// ignored (node_modules alone would drown the stream).

let gcodeWatcher = null;
const pending = new Map();

function startGcodeWatch() {
  try {
    gcodeWatcher = watch(ARCHIVE_ROOT, { recursive: true, persistent: false }, (type, filename) => {
      if (!filename) return;
      const rel = String(filename).split(path.sep).join('/');
      if (!rel.toLowerCase().endsWith('.gcode')) return;
      if (rel.startsWith('gcode-studio/')) return;
      if (rel.includes('/node_modules/')) return;
      if (/\.tmp-\d+/.test(rel)) return; // our own atomic-write temp files

      clearTimeout(pending.get(rel));
      pending.set(rel, setTimeout(async () => {
        pending.delete(rel);
        const abs = path.join(ARCHIVE_ROOT, rel.split('/').join(path.sep));
        let st = null;
        try { st = await stat(abs); } catch { /* deleted or moved */ }
        const parts = rel.split('/');
        broadcast('gcode', {
          path: rel,
          name: parts[parts.length - 1],
          job: parts.length > 1 ? parts[0] : null,
          archived: parts.includes('old'),
          event: st ? type : 'removed',
          exists: !!st,
          size: st ? st.size : 0,
          mtime: st ? st.mtimeMs : 0,
        });
      }, 300));
    });
    gcodeWatcher.on('error', (e) => {
      console.warn('[watch] G-code watcher stopped:', e.message);
      gcodeWatcher = null;
    });
  } catch (e) {
    console.warn('[watch] could not watch the Archive tree:', e.message);
  }
}

// ---------------------------------------------------------------------------
// static files
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.stl': 'model/stl',
  '.gcode': 'text/plain; charset=utf-8',
};

let distRoot = null; // resolved once at boot

/** index.html with `<meta name="gcs-token">` straight after `<head>`. */
function injectToken(buf) {
  const meta = `<meta name="gcs-token" content="${TOKEN}">`;
  const html = buf.toString('utf8');
  const m = /<head(\s[^>]*)?>/i.exec(html);
  if (!m) return Buffer.from(meta + html, 'utf8');
  const at = m.index + m[0].length;
  return Buffer.from(html.slice(0, at) + meta + html.slice(at), 'utf8');
}

async function serveStatic(req, res, urlPath) {
  const roots = distRoot ? [distRoot, PROJECT_ROOT] : [PROJECT_ROOT];
  let clean;
  try { clean = decodeURIComponent(urlPath.split('?')[0]); } catch {
    return sendError(res, new HttpError(400, 'bad path'));
  }
  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  if (rel.includes('\0')) return sendError(res, new HttpError(400, 'bad path'));
  // .gcs-token, .app-profile\ and every other dot path are never served.
  if (rel.split(/[\\/]+/).some((seg) => seg.startsWith('.'))) {
    return sendError(res, new HttpError(403, 'dot paths are not served'));
  }

  for (const root of roots) {
    const abs = path.resolve(root, rel);
    if (!contains(root, abs)) continue; // traversal out of the static root
    let st;
    try { st = await stat(abs); } catch { continue; }
    if (st.isDirectory()) continue;
    let body = await readFile(abs);
    let cache = 'no-cache';
    if (path.relative(root, abs).toLowerCase() === 'index.html') {
      // The token rides in the page; other origins cannot read this response.
      body = injectToken(body);
      cache = 'no-store';
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': cache,
    });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  sendJson(res, 404, {
    error: 'not found: ' + rel,
    hint: 'the API lives under /api/. The app shell (index.html) is built by the UI part; '
      + 'in dev, Vite serves it on 5173 and proxies /api to this server on ' + PORT + '.',
  });
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

async function route(req, res, url) {
  const q = url.searchParams;
  const p = url.pathname;
  const isGet = req.method === 'GET' || req.method === 'HEAD';
  const isPost = req.method === 'POST';

  // -- health ---------------------------------------------------------------
  if (p === '/api/health' && isGet) {
    return sendJson(res, 200, {
      ok: true,
      port: PORT,
      projectRoot: PROJECT_ROOT,
      archiveRoot: ARCHIVE_ROOT,
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      sseClients: clients.size,
      watching: !!gcodeWatcher,
      chat: await chatStats(),
      term: terminal.getState(),
    });
  }

  // -- jobs / files ---------------------------------------------------------
  if (p === '/api/jobs' && isGet) {
    return sendJson(res, 200, { archiveRoot: ARCHIVE_ROOT, jobs: await listJobs() });
  }

  if (p === '/api/file' && isGet) {
    const { abs, text } = await readText(q.get('path'));
    const from = q.get('from'), to = q.get('to');
    let body = text;
    if (from != null || to != null) {
      const lines = text.split('\n');
      const a = Math.max(0, Number(from) || 0);
      const b = to != null ? Math.min(lines.length - 1, Number(to)) : lines.length - 1;
      body = lines.slice(a, b + 1).join('\n');
    }
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': buf.length,
      'X-Gcode-Path': relPath(abs),
      'Cache-Control': 'no-store',
    });
    return res.end(req.method === 'HEAD' ? undefined : buf);
  }

  if (p === '/api/meta' && isGet) {
    const entry = await parseFile(q.get('path'));
    return sendJson(res, 200, {
      path: relPath(entry.abs),
      bytes: entry.size,
      mtime: entry.mtimeMs,
      ...slimParse(entry.parsed),
    });
  }

  // -- drafts and compare -----------------------------------------------------
  if (p === '/api/base' && isGet) {
    const abs = await safeResolveReal(q.get('path'));
    return sendJson(res, 200, { path: relPath(abs), base: await baseOf(abs) });
  }

  if (p === '/api/finalize' && isPost) {
    const body = await readBody(req);
    const entry = await parseFile(body.path);
    const result = await finalizeDraft({ path: body.path, note: body.note, timeSec: entry.parsed.meta.estimatedTimeSec });
    broadcast('gcode', { path: result.path, name: result.name, event: 'written', exists: true });
    return sendJson(res, 200, result);
  }

  // Claude (or any script) asks the open app to show a file, optionally diffed
  // against another: `node gcode-studio/server/app-cli.js open <file> [--diff <base>]`.
  if (p === '/api/app/open' && isPost) {
    const body = await readBody(req);
    const abs = await safeResolveReal(body.path);
    let diff = null;
    if (body.diff === true) diff = await baseOf(abs);
    else if (body.diff) diff = relPath(await safeResolveReal(body.diff));
    const msg = { path: relPath(abs), diff };
    broadcast('open', msg);
    return sendJson(res, 200, { ok: true, ...msg, windows: clients.size });
  }

  // Claude reloads the app window(s): `node gcode-studio/server/app-cli.js reload`.
  if (p === '/api/app/reload' && isPost) {
    broadcast('reload', {});
    return sendJson(res, 200, { ok: true, windows: clients.size });
  }

  // Claude points at areas of the model: coloured, labelled boxes in the app.
  // regions: [{x:[a,b], y?:[a,b], z?:[a,b], layers?:[a,b], label?}] in bed (G-code) mm.
  if (p === '/api/app/highlight' && isPost) {
    const body = await readBody(req);
    const regions = Array.isArray(body.regions) ? body.regions : [];
    if (!body.clear && !regions.length) throw new HttpError(400, 'regions[] is required (or clear:true)');
    if (regions.length > 20) throw new HttpError(400, 'at most 20 regions');
    const pair = (v, what) => {
      if (v == null) return null;
      if (!Array.isArray(v) || v.length !== 2 || !v.every(Number.isFinite)) throw new HttpError(400, `${what} must be [from, to]`);
      return [Math.min(v[0], v[1]), Math.max(v[0], v[1])];
    };
    const clean = regions.map((r, i) => ({
      x: pair(r.x, `regions[${i}].x`), y: pair(r.y, `regions[${i}].y`),
      z: pair(r.z, `regions[${i}].z`), layers: pair(r.layers, `regions[${i}].layers`),
      label: String(r.label || `area ${i + 1}`).slice(0, 80),
      // the planned change: a shift, and/or the new x / y range
      move: r.move == null ? null : (() => {
        const m = Array.isArray(r.move) ? r.move : [r.move, 0];
        if (m.length !== 2 || !m.every(Number.isFinite)) throw new HttpError(400, `regions[${i}].move must be dx or [dx, dy]`);
        return m;
      })(),
      toX: pair(r.toX, `regions[${i}].toX`),
      toY: pair(r.toY, `regions[${i}].toY`),
    }));
    for (const [i, r] of clean.entries()) if (!r.x && !r.y && !r.layers) throw new HttpError(400, `regions[${i}] needs x, y or layers`);
    const msg = {
      path: body.path ? relPath(await safeResolveReal(body.path)) : null,
      regions: body.clear ? [] : clean,
      select: body.select !== false,
    };
    broadcast('highlight', msg);
    return sendJson(res, 200, { ok: true, ...msg, windows: clients.size });
  }

  if (p === '/api/versions' && isGet) {
    const job = await getJob(q.get('job'));
    return sendJson(res, 200, {
      job: job.name,
      path: job.path,
      current: job.current,
      versions: await listVersions(job.absPath),
    });
  }

  if (p === '/api/diff' && isGet) {
    return sendJson(res, 200, await handleDiff(q.get('a'), q.get('b'), {
      topLayers: Number(q.get('topLayers')) || 10,
    }));
  }

  // -- edit / slice ---------------------------------------------------------
  if (p === '/api/edit' && isPost) {
    const body = await readBody(req);
    const result = await handleEdit(body);
    if (result.written) broadcast('gcode', { path: result.outPath, name: path.basename(result.outPath), event: 'written', exists: true });
    return sendJson(res, result.ok ? 200 : 422, result);
  }

  if (p === '/api/thumbnail' && isPost) {
    const body = await readBody(req);
    const result = await handleThumbnail(body);
    if (result.written) broadcast('gcode', { path: result.outPath, name: path.basename(result.outPath), event: 'written', exists: true });
    return sendJson(res, 200, result);
  }

  if (p === '/api/slice' && isPost) {
    const body = await readBody(req);
    const result = await handleSlice(body);
    return sendJson(res, result.ok ? 200 : 422, result);
  }

  // -- bridge ---------------------------------------------------------------
  if (p === '/api/bridge/selection') {
    if (isGet) return sendJson(res, 200, { selection: await readSelection() });
    if (isPost) {
      const body = await readBody(req);
      const sel = await writeSelection(body.selection || body);
      broadcast('selection', { id: sel.id, file: sel.file || null });
      return sendJson(res, 200, { ok: true, selection: sel });
    }
  }

  if (p === '/api/bridge/request' && isPost) {
    return sendJson(res, 200, { ok: true, request: await appendRequest(await readBody(req)) });
  }
  if (p === '/api/bridge/requests' && isGet) {
    return sendJson(res, 200, await readRequests(Number(q.get('limit')) || 200));
  }

  if (p === '/api/bridge/attach' && isPost) {
    return sendJson(res, 200, await attachFile(await readBody(req, MAX_ATTACH_BODY)));
  }

  if (p === '/api/bridge/chat') {
    if (isGet) return sendJson(res, 200, await getChat(q.get('since'), Number(q.get('limit')) || 200));
    if (isPost) {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: true, message: await postChatUser(body) });
    }
  }
  if (p === '/api/bridge/chat/reply' && isPost) {
    const body = await readBody(req);
    return sendJson(res, 200, { ok: true, message: await postChatReply(body) });
  }
  if (p === '/api/bridge/chat/pending' && isGet) {
    return sendJson(res, 200, await getChatPending());
  }

  // -- events ---------------------------------------------------------------
  if (p === '/api/watch' && isGet) return handleWatch(req, res);

  // -- terminal (the WebSocket itself is handled by the 'upgrade' listener) --
  if (p === '/api/term/state' && isGet) return sendJson(res, 200, terminal.getState());
  if (p === '/api/term' && isGet) return sendJson(res, 426, { error: 'WebSocket upgrade required' });

  if (p.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'no such route: ' + req.method + ' ' + p, routes: ROUTES });
  }

  if (!isGet) return sendJson(res, 405, { error: 'method not allowed' });
  return serveStatic(req, res, p);
}

const ROUTES = [
  '(every /api route needs header X-GCS-Token or ?token=; the token is in .gcs-token)',
  'GET  /api/health',
  'GET  /api/jobs',
  'GET  /api/file?path=[&from=&to=]',
  'GET  /api/meta?path=',
  'GET  /api/versions?job=',
  'GET  /api/diff?a=&b=[&topLayers=]',
  'POST /api/edit            {path, ops[], dryRun=true, note}',
  'POST /api/slice           {job, stl?, profiles?, commit?, note?}',
  'POST /api/thumbnail       {path, png?, dryRun?}  -> printer preview written into the job\'s draft',
  'GET  /api/bridge/selection',
  'POST /api/bridge/selection',
  'POST /api/bridge/request',
  'GET  /api/bridge/requests[?limit=]',
  'POST /api/bridge/attach   {kind, id, file, data, png?} -> {ok, id, json, png} (Archive-relative)',
  'GET  /api/bridge/chat[?since=&limit=]      (legacy mailbox, unused by the app)',
  'POST /api/bridge/chat     {text, selectionId?}',
  'POST /api/bridge/chat/reply {text, replyTo?, actions?}',
  'GET  /api/bridge/chat/pending',
  'GET  /api/base?path=      -> {base}: the final this draft/version is compared with',
  'POST /api/finalize        {path, note}  draft -> ..._vN-<note>_<time>.gcode',
  'POST /api/app/open        {path, diff?: true|<path>}  tell the open app to show a file',
  'POST /api/app/highlight   {path?, regions:[{x,y?,z?,layers?,label,move?,toX?,toY?}], clear?}  boxes on the model',
  'POST /api/app/reload      {}  reload the open app window(s); Claude keeps running',
  'GET  /api/watch           (SSE: hello, gcode, open, reload, highlight, selection, chat (legacy), ping)',
  'GET  /api/term            WebSocket: the shared Claude Code PTY',
  'GET  /api/term/state',
];

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

function parseUrl(req) {
  // The Host header is checked separately; never build the URL from it.
  try { return new URL(req.url, 'http://localhost'); } catch { return null; }
}

export const server = http.createServer((req, res) => {
  const url = parseUrl(req);
  if (!url) return sendError(res, new HttpError(400, 'bad request URL'));
  let denied = checkAccess(req, url, false);
  // No CORS headers anywhere: a cross-origin preflight gets a bare 204 and fails.
  if (!denied && req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (!denied && url.pathname.startsWith('/api/')) denied = checkAccess(req, url, true);
  if (denied) return sendJson(res, denied.status, { error: denied.error });
  route(req, res, url).catch((e) => sendError(res, e));
});

server.on('upgrade', (req, socket, head) => {
  const url = parseUrl(req);
  const refuse = (status, error) => {
    const body = JSON.stringify({ error });
    socket.on('error', () => {});
    socket.once('finish', () => socket.destroy());
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\n`
      + 'Connection: close\r\nContent-Type: application/json; charset=utf-8\r\n'
      + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  if (!url || url.pathname !== '/api/term') return refuse(404, 'no such WebSocket endpoint');
  const denied = checkAccess(req, url, true);
  if (denied) return refuse(denied.status, denied.error);
  terminal.handleUpgrade(req, socket, head);
});

export async function start(port = PORT, host = HOST) {
  try {
    if ((await stat(path.join(PROJECT_ROOT, 'dist', 'index.html'))).isFile()) {
      distRoot = path.join(PROJECT_ROOT, 'dist');
    }
  } catch { /* no build; serve the sources directly */ }

  await startBridgeWatch();
  bridgeEvents.on('chat', (messages) => broadcast('chat', { messages }));
  bridgeEvents.on('selection', (d) => broadcast('selection', d));
  startGcodeWatch();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  try {
    await writeFile(tokenFile(), TOKEN + '\n', 'utf8');
  } catch (e) {
    console.warn('[token] could not write ' + tokenFile() + ': ' + e.message);
  }
  terminal.configure({ port: server.address().port, token: TOKEN, cwd: ARCHIVE_ROOT });
  return server;
}

export function stop() {
  for (const res of clients) { try { res.end(); } catch { /* ignore */ } }
  clients.clear();
  if (gcodeWatcher) { try { gcodeWatcher.close(); } catch { /* ignore */ } gcodeWatcher = null; }
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  terminal.shutdown();
  return new Promise((resolve) => server.close(resolve));
}

// Started directly (`node server/index.js`) rather than imported by a test.
const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  start().then(() => {
    console.log(`G-code Studio API  http://${HOST}:${PORT}`);
    console.log(`  project root  ${PROJECT_ROOT}`);
    console.log(`  archive root  ${ARCHIVE_ROOT}   (nothing outside this is reachable)`);
    console.log(`  static        ${distRoot || PROJECT_ROOT}`);
    console.log(`  token         ${tokenFile()}`);
    for (const r of ROUTES) console.log('  ' + r);
  }).catch((e) => {
    console.error('failed to start:', e.message);
    process.exit(1);
  });
  const quit = () => { terminal.shutdown(); process.exit(0); };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}
