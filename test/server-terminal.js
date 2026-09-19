/**
 * server-terminal.js -- access control (B9), attach, and the PTY WebSocket.
 *
 *   node test/server-terminal.js
 *
 * Never launches real Claude: GCS_TERM_CMD swaps in a short command. Attach
 * writes go to bridge\attached-test-<pid>\ (removed after), so the real
 * bridge\attached\ is never pruned by a test run.
 */
import './_isolate.js'; // must be first: keeps the tests out of the live bridge\ folder
import http from 'node:http';
import path from 'node:path';
import { readdir, rm, readFile, stat } from 'node:fs/promises';
import WebSocket from 'ws';
import { start, stop, getToken, tokenFile } from '../server/index.js';
import { ARCHIVE_ROOT, PROJECT_ROOT } from '../server/api/files.js';
import { BRIDGE_DIR } from '../server/api/bridge.js';
import { ok, eq, section, row, run, PORT, BASE, get, post, auth } from './server-helpers.js';

const ATTACH_TEST_DIR = path.join(PROJECT_ROOT, 'bridge', `attached-test-${process.pid}`);
process.env.GCS_ATTACH_DIR = ATTACH_TEST_DIR;

// The server only honours GCS_ATTACH_DIR while it points INSIDE the Archive --
// otherwise an attachment would land somewhere it could never be named from.
// When the app is not itself inside the archive (a clone pointed at demo\),
// that is the case, and attachments go to the isolated bridge folder instead.
// The test follows the same rule rather than assuming one layout.
const insideArchive = (() => {
  const rel = path.relative(ARCHIVE_ROOT, ATTACH_TEST_DIR);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
})();
const ATTACH_DIR_USED = insideArchive ? ATTACH_TEST_DIR : path.join(BRIDGE_DIR, 'attached');
process.env.GCS_TERM_CMD = JSON.stringify(['cmd.exe', '/d', '/c', 'echo hello-pty']);

/** Raw request, so Host and Origin can be set freely. */
function raw(method, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open a ws; resolves { ws, msgs, waitFor } or { status } when refused. */
function openWs(query, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/term${query}`, { headers });
    const msgs = [];
    const waiters = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      msgs.push(m);
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
    });
    const waitFor = (pred, ms = 8000) => {
      const hit = msgs.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((res2) => {
        const w = { pred, resolve: res2 };
        waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); res2(null); } }, ms);
      });
    };
    ws.on('open', () => resolve({ ws, msgs, waitFor }));
    ws.on('unexpected-response', (_req, res) => { resolve({ status: res.statusCode }); res.resume(); });
    ws.on('error', (e) => resolve({ status: -1, error: e.message }));
  });
}

const allOut = (msgs) => msgs.filter((m) => m.t === 'out').map((m) => m.d).join('');

await run(async () => {
  await start(PORT, '127.0.0.1');
  const T = getToken();

  section('token (B9)');
  ok(T.length >= 32, `token is ${T.length} chars`);
  ok(tokenFile() !== path.join(PROJECT_ROOT, '.gcs-token'), 'test run writes its token outside the project');
  eq((await readFile(tokenFile(), 'utf8')).trim(), T, 'token file holds the token');
  eq((await fetch(BASE + '/api/health')).status, 401, 'no token -> 401');
  eq((await fetch(BASE + '/api/health', { headers: { 'X-GCS-Token': 'nope' } })).status, 401, 'wrong token -> 401');
  eq((await fetch(BASE + '/api/health', { headers: { 'X-GCS-Token': T + 'x' } })).status, 401, 'token + 1 char -> 401');
  eq((await fetch(BASE + '/api/health?token=' + T)).status, 200, '?token= -> 200');
  eq((await fetch(BASE + '/api/health', { headers: auth() })).status, 200, 'X-GCS-Token header -> 200');
  eq((await fetch(BASE + '/api/bridge/chat', { method: 'POST', body: '{"text":"x"}' })).status, 401, 'POST without token -> 401');
  eq((await fetch(BASE + '/api/nope')).status, 401, 'unknown /api route without token -> 401 (no route list leaked)');

  section('Host / Origin');
  eq((await raw('GET', '/api/health', { Host: 'evil.example:5199', 'X-GCS-Token': T })).status, 403, 'bad Host on /api -> 403');
  eq((await raw('GET', '/', { Host: 'evil.example' })).status, 403, 'bad Host on / -> 403 (DNS rebinding cannot read the token)');
  eq((await raw('GET', '/api/health', { Host: 'localhost:5199', 'X-GCS-Token': T })).status, 200, 'Host localhost -> 200');
  eq((await raw('GET', '/api/health', { Host: '[::1]:5199', 'X-GCS-Token': T })).status, 200, 'Host [::1] -> 200');
  eq((await raw('GET', '/api/health', { Host: 'localhost.evil.example', 'X-GCS-Token': T })).status, 403, 'Host localhost.evil.example -> 403');
  eq((await raw('GET', '/api/health', { Origin: 'http://evil.example', 'X-GCS-Token': T })).status, 403, 'bad Origin -> 403');
  eq((await raw('GET', '/api/health', { Origin: 'http://localhost.evil.example:5173', 'X-GCS-Token': T })).status, 403, 'Origin localhost.evil.example -> 403');
  eq((await raw('GET', '/api/health', { Origin: 'null', 'X-GCS-Token': T })).status, 403, 'Origin null -> 403');
  eq((await raw('GET', '/api/health', { Origin: 'https://localhost:5173', 'X-GCS-Token': T })).status, 403, 'https Origin -> 403');
  eq((await raw('GET', '/api/health', { Origin: 'http://localhost:5173', 'X-GCS-Token': T })).status, 200, 'Origin localhost:5173 -> 200');
  eq((await raw('GET', '/api/health', { Origin: 'http://127.0.0.1:5174', 'X-GCS-Token': T })).status, 200, 'Origin 127.0.0.1:5174 -> 200');

  section('no CORS');
  const pre = await raw('OPTIONS', '/api/bridge/chat', {
    Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-gcs-token',
  });
  eq(pre.status, 204, 'OPTIONS -> 204');
  const corsKeys = (h) => Object.keys(h).filter((k) => k.startsWith('access-control-'));
  eq(corsKeys(pre.headers).length, 0, 'preflight carries no Access-Control-* header');
  const hh = await raw('GET', '/api/health', { 'X-GCS-Token': T });
  eq(hh.headers['access-control-allow-origin'], undefined, 'GET /api/health has no ACAO');
  eq(corsKeys((await raw('GET', '/')).headers).length, 0, 'GET / has no Access-Control-* header');
  eq((await raw('OPTIONS', '/api/health', { Origin: 'http://evil.example' })).status, 403, 'OPTIONS from a bad Origin -> 403');

  section('index.html token meta');
  for (const p of ['/', '/index.html']) {
    const r = await raw('GET', p);
    eq(r.status, 200, `GET ${p}`);
    const m = /<head[^>]*>\s*<meta name="gcs-token" content="([0-9a-f]+|[^"]+)">/i.exec(r.body);
    ok(!!m && m[1] === T, `${p}: meta gcs-token right after <head> carries the token`);
    eq(r.headers['cache-control'], 'no-store', `${p}: Cache-Control`);
    eq((r.body.match(/name="gcs-token"/g) || []).length, 1, `${p}: exactly one meta tag`);
  }

  section('dot paths are not served');
  for (const p of ['/.gcs-token', '/%2egcs-token', '/.app-profile/Local%20State', '/src/../.gcs-token', '/bridge/%2e%2e/.gcs-token', '/.git/config']) {
    const r = await raw('GET', p);
    ok(r.status === 403 || r.status === 404, `GET ${p} -> ${r.status}`);
    ok(!r.body.includes(T), `  ${p}: body does not contain the token`);
  }

  section('POST /api/bridge/attach');
  const PNG = 'data:image/png;base64,' + Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('not really an image, magic only'),
  ]).toString('base64');
  try {
    const a = await post('/api/bridge/attach', {
      kind: 'area', id: 'sel-1789-test', file: 'phonecase-17pro/x.gcode', data: { hello: 'world', n: [1, 2, 3] }, png: PNG,
    });
    eq(a.__status, 200, 'attach with png -> 200');
    ok(a.ok === true && a.id === 'sel-1789-test', 'answers ok + id');
    const relDir = path.relative(ARCHIVE_ROOT, ATTACH_DIR_USED).split(path.sep).join('/');
    eq(a.json, `${relDir}/sel-1789-test.json`, 'json path is Archive-relative with /');
    eq(a.png, `${relDir}/sel-1789-test.png`, 'png path is Archive-relative with /');
    ok(!/[\\]/.test(a.json), 'forward slashes only, whatever the OS uses');
    // What the path has to be good for: Claude runs in the Archive root and
    // opens it exactly as written.
    eq(path.resolve(ARCHIVE_ROOT, a.json), path.join(ATTACH_DIR_USED, 'sel-1789-test.json'),
      'and it resolves from the Archive root to the file that was written');
    const back = JSON.parse(await readFile(path.join(ARCHIVE_ROOT, a.json), 'utf8'));
    eq(back.hello, 'world', 'json file holds data');
    const pngBack = await readFile(path.join(ARCHIVE_ROOT, a.png));
    eq(pngBack[0], 0x89, 'png file holds the decoded bytes');

    const a2 = await post('/api/bridge/attach', { kind: 'move', id: 'sel-1789-test', data: { again: true } });
    eq(a2.png, null, 're-attach without png -> png: null');
    let gone = false;
    try { await stat(path.join(ATTACH_DIR_USED, 'sel-1789-test.png')); } catch { gone = true; }
    ok(gone, 'and the stale png is removed');

    for (const [label, body, want] of [
      ['bad kind', { kind: 'file', id: 'sel-1', data: {} }, 400],
      ['id with ..', { kind: 'area', id: 'sel-../../x', data: {} }, 400],
      ['id with slash', { kind: 'area', id: 'sel-a/b', data: {} }, 400],
      ['id without prefix', { kind: 'area', id: '12345', data: {} }, 400],
      ['id too long', { kind: 'area', id: 'sel-' + 'a'.repeat(61), data: {} }, 400],
      ['missing data', { kind: 'area', id: 'sel-1' }, 400],
      ['png not a data URL', { kind: 'area', id: 'sel-1', data: {}, png: 'http://x/y.png' }, 400],
      ['png jpeg type', { kind: 'area', id: 'sel-1', data: {}, png: 'data:image/jpeg;base64,AAAA' }, 400],
      ['png wrong magic', { kind: 'area', id: 'sel-1', data: {}, png: 'data:image/png;base64,' + Buffer.from('GIF89a-nope').toString('base64') }, 400],
      ['png bad base64', { kind: 'area', id: 'sel-1', data: {}, png: 'data:image/png;base64,@@@@' }, 400],
      ['data > 2 MB', { kind: 'area', id: 'sel-1', data: { s: 'x'.repeat(2.1 * 1024 * 1024) } }, 413],
    ]) {
      eq((await post('/api/bridge/attach', body)).__status, want, `rejects ${label}`);
    }
    const big = 'data:image/png;base64,' + Buffer.alloc(6.2 * 1024 * 1024, 0x89).toString('base64');
    eq((await post('/api/bridge/attach', { kind: 'area', id: 'sel-big', data: {}, png: big })).__status, 413, 'rejects png > 6 MB');

    // prune: 42 more ids -> only the newest 40 survive
    for (let i = 0; i < 42; i++) {
      await post('/api/bridge/attach', { kind: 'selection', id: `sel-p${String(i).padStart(2, '0')}`, data: { i } });
      await sleep(3);
    }
    const left = (await readdir(ATTACH_DIR_USED)).filter((f) => f.endsWith('.json'));
    eq(left.length, 40, 'keeps the newest 40 ids');
    ok(!left.includes('sel-1789-test.json') && !left.includes('sel-p00.json') && !left.includes('sel-p01.json'), 'the oldest ones are deleted');
    ok(left.includes('sel-p41.json') && left.includes('sel-p02.json'), 'the newest ones are kept');
    ok(!(await readdir(ATTACH_DIR_USED)).some((f) => f.includes('.tmp-')), 'no temp files left behind');
  } finally {
    if (insideArchive) await rm(ATTACH_TEST_DIR, { recursive: true, force: true });
  }

  section('WebSocket /api/term: access');
  eq((await openWs('')).status, 401, 'ws without token -> 401');
  eq((await openWs('?token=bad')).status, 401, 'ws with a wrong token -> 401');
  eq((await openWs('?token=' + T, { Origin: 'http://evil.example' })).status, 403, 'ws from a bad Origin -> 403');
  eq((await openWs('?token=' + T, { Host: 'evil.example' })).status, 403, 'ws with a bad Host -> 403');
  eq((await raw('GET', '/api/term/state')).status, 401, 'GET /api/term/state without token -> 401');

  section('WebSocket /api/term: round trip');
  const st0 = await get('/api/term/state');
  eq(st0.running, false, 'state before start: not running');
  row('state', JSON.stringify(st0));
  eq(st0.error, undefined, 'node-pty loads (no error in state)');

  const c1 = await openWs('?token=' + T, { Origin: 'http://localhost:5173' });
  ok(!!c1.ws, 'ws connects with token and a localhost Origin');
  const hello = await c1.waitFor((m) => m.t === 'hello');
  ok(!!hello && hello.running === false, 'receives hello with running:false');
  ok(hello && hello.cwd === ARCHIVE_ROOT, `hello.cwd is the Archive root (${hello && hello.cwd})`);

  c1.ws.send(JSON.stringify({ t: 'resize', cols: 100, rows: 28 }));
  c1.ws.send(JSON.stringify({ t: 'start', mode: 'new' }));
  const reset = await c1.waitFor((m) => m.t === 'reset');
  ok(!!reset, 'start sends reset first');
  const up = await c1.waitFor((m) => m.t === 'state' && m.running === true);
  ok(!!up && up.pid > 0, `state running:true with a pid (${up && up.pid})`);
  ok(up && /cmd\.exe/.test(up.cmd) && up.cols === 100 && up.rows === 28, `state carries cmd and the resize (${up && up.cmd}, ${up && up.cols}x${up && up.rows})`);
  const down = await c1.waitFor((m) => m.t === 'state' && m.running === false);
  ok(!!down, 'state running:false after the process exits');
  eq(down && down.exitCode, 0, 'exitCode');
  ok(allOut(c1.msgs).includes('hello-pty'), 'output contains hello-pty');
  const iOut = c1.msgs.findIndex((m) => m.t === 'out' && m.d.includes('hello-pty'));
  ok(iOut >= 0 && iOut < c1.msgs.indexOf(down), 'the output arrives before the exit state');

  const c2 = await openWs('?token=' + T);
  await c2.waitFor((m) => m.t === 'hello');
  await sleep(100);
  eq(c2.msgs[0].t, 'hello', 'a second window gets hello first');
  ok(allOut(c2.msgs).includes('hello-pty'), 'and the scrollback replayed');
  c2.ws.close();

  c1.ws.send(JSON.stringify({ t: 'start', mode: 'sideways' }));
  ok(!!(await c1.waitFor((m) => m.t === 'error' && /mode/.test(m.message))), 'bad mode -> error message');
  c1.ws.send('not json');
  ok(!!(await c1.waitFor((m) => m.t === 'error' && /JSON/.test(m.message))), 'non-JSON -> error message');

  section('WebSocket /api/term: env, restart, stop');
  process.env.CLAUDECODE = '1';
  process.env.CLAUDE_CODE_SESSION_ID = 'leak';
  const probe = "const e=process.env;console.log('ENV', e.CLAUDECODE||'-', e.CLAUDE_CODE_SESSION_ID||'-', e.TERM, e.GCS_TOKEN===" + JSON.stringify(T) + "?'tok':'notok', e.GCS_API||'-', process.cwd());setInterval(()=>{},1000)";
  process.env.GCS_TERM_CMD = JSON.stringify([process.execPath, '-e', probe]);
  const nBefore = c1.msgs.length;
  c1.ws.send(JSON.stringify({ t: 'restart', mode: 'new' }));
  const up2 = await c1.waitFor((m) => m.t === 'state' && m.running === true && c1.msgs.indexOf(m) >= nBefore);
  ok(!!up2, 'restart starts the new command');
  const envLine = await c1.waitFor((m) => m.t === 'out' && /ENV .*\r?\n/.test(allOut(c1.msgs.slice(nBefore))), 8000);
  const outEnv = allOut(c1.msgs.slice(nBefore));
  row('child env', (/ENV [^\r\n]*/.exec(outEnv) || ['(none)'])[0]);
  ok(!!envLine && /ENV - - xterm-256color tok http:\/\/127\.0\.0\.1:\d+ /.test(outEnv), 'CLAUDECODE / CLAUDE_CODE_SESSION_ID stripped; TERM, GCS_TOKEN, GCS_API set');
  ok(outEnv.includes(ARCHIVE_ROOT), 'child cwd is the Archive root');
  delete process.env.CLAUDECODE;
  delete process.env.CLAUDE_CODE_SESSION_ID;

  c1.ws.send(JSON.stringify({ t: 'start', mode: 'new' }));
  await sleep(300);
  eq(c1.msgs.slice(nBefore).filter((m) => m.t === 'reset').length, 1, 'start while running is a no-op (no second reset)');
  eq((await get('/api/term/state')).running, true, '/api/term/state: running');

  c1.ws.send(JSON.stringify({ t: 'stop' }));
  const down2 = await c1.waitFor((m) => m.t === 'state' && m.running === false && c1.msgs.indexOf(m) >= nBefore, 5000);
  ok(!!down2, 'stop -> state running:false');
  eq((await get('/api/term/state')).running, false, '/api/term/state: stopped');

  // stop() must kill a live PTY
  const nStop = c1.msgs.length;
  c1.ws.send(JSON.stringify({ t: 'start', mode: 'new' }));
  const up3 = await c1.waitFor((m) => m.t === 'state' && m.running === true && c1.msgs.indexOf(m) >= nStop, 5000);
  ok(!!up3, 'started again for the shutdown check');
  c1.ws.close();
  await stop();
  await sleep(1500);
  let alive = true;
  try { process.kill(up3.pid, 0); } catch { alive = false; }
  ok(!alive, `server stop() killed the PTY process (pid ${up3 && up3.pid})`);
});
