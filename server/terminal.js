/**
 * terminal.js -- real interactive Claude Code in a PTY, shared over a WebSocket.
 *
 * Contract: docs/CONTEXT-terminal.md section 2.
 *
 *   - ONE PTY per server, shared by every connected window. Reloading the page
 *     must not kill the conversation, so output is kept in a 256 KB scrollback
 *     and replayed to each new connection after `hello`.
 *   - The server never starts Claude by itself; the client sends `start`.
 *   - node-pty is a native module, so it is imported lazily. If it fails to
 *     load, `start` answers with an error and `state.error` says why; the rest
 *     of the server is unaffected.
 *   - Output is coalesced for FLUSH_MS so a burst of redraws is one frame, not
 *     hundreds.
 *
 * Access control (token / Host / Origin) is done by index.js before
 * handleUpgrade is called.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const SCROLLBACK_MAX = 256 * 1024;
const FLUSH_MS = 8;
const MAX_MESSAGE = 4 * 1024 * 1024; // a large paste

/**
 * Session markers a Claude process leaves in its children's environment. A
 * child `claude` that inherits them runs with transcript saving off (measured).
 */
const STRIP_ENV = new Set([
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'AI_AGENT',
  ...['CHILD_SESSION', 'SESSION_ID', 'MESSAGING_SOCKET', 'MESSAGING_TOKEN',
    'SESSION_ATTENDED', 'ENTRYPOINT', 'EXECPATH', 'SSE_PORT'].map((k) => 'CLAUDE_CODE_' + k),
]);

const config = { port: 0, token: '', cwd: process.cwd() };

let pty = null;            // the node-pty module, once loaded
let ptyLoad = null;        // the load promise (loaded once)
let ptyError = null;       // why node-pty could not be loaded

let proc = null;           // the live IPty, or null
let generation = 0;        // bumps on every spawn; stale exit events are ignored
let scrollback = '';
let outBuf = '';
let flushTimer = null;
let lastError = null;

const state = {
  running: false,
  pid: null,
  mode: null,
  startedAt: null,
  exitCode: null,
  cmd: null,
  cwd: null,
  cols: 120,
  rows: 30,
};

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });

/** Set by index.js once the server is listening. */
export function configure({ port, token, cwd }) {
  if (port != null) config.port = port;
  if (token != null) config.token = token;
  if (cwd) config.cwd = cwd;
}

export function getState() {
  return {
    ...state,
    cwd: state.cwd || config.cwd,
    clients: wss.clients.size,
    ...(ptyError ? { error: 'node-pty unavailable: ' + ptyError } : lastError ? { error: lastError } : {}),
  };
}

function loadPty() {
  if (!ptyLoad) {
    ptyLoad = import('node-pty')
      .then((m) => { pty = m.default && m.default.spawn ? m.default : m; })
      .catch((e) => { ptyError = e.message; });
  }
  return ptyLoad;
}

// ---------------------------------------------------------------------------
// fan-out
// ---------------------------------------------------------------------------

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  const text = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(text);
}

function flush() {
  flushTimer = null;
  if (!outBuf) return;
  const d = outBuf;
  outBuf = '';
  broadcast({ t: 'out', d });
}

function onOutput(d) {
  scrollback += d;
  if (scrollback.length > SCROLLBACK_MAX) {
    // Cut at a line boundary where possible so the replay starts cleanly.
    let cut = scrollback.length - SCROLLBACK_MAX;
    const nl = scrollback.indexOf('\n', cut);
    if (nl >= 0 && nl - cut < 4096) cut = nl + 1;
    scrollback = scrollback.slice(cut);
  }
  outBuf += d;
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

function clearOutput() {
  clearTimeout(flushTimer);
  flushTimer = null;
  outBuf = '';
  scrollback = '';
}

// ---------------------------------------------------------------------------
// spawning
// ---------------------------------------------------------------------------

/**
 * What to run for `mode`. Resolved on every start because Claude updates move
 * the binary. GCS_TERM_CMD (a JSON array) overrides it, for tests.
 */
export function resolveCommand(mode) {
  const extra = mode === 'continue' ? ['--continue'] : [];
  if (process.env.GCS_TERM_CMD) {
    const arr = JSON.parse(process.env.GCS_TERM_CMD);
    if (!Array.isArray(arr) || !arr.length || !arr.every((x) => typeof x === 'string')) {
      throw new Error('GCS_TERM_CMD must be a JSON array of strings');
    }
    return { file: arr[0], args: arr.slice(1) };
  }
  if (process.platform !== 'win32') return { file: 'claude', args: extra };

  // Walk PATH in order; in each directory .exe beats .cmd (PATHEXT order).
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const exe = path.join(dir, 'claude.exe');
    if (existsSync(exe)) return { file: exe, args: extra };
    if (existsSync(path.join(dir, 'claude.cmd'))) {
      // The npm shim is a batch file; Ctrl+C through cmd.exe can leave
      // "Terminate batch job (Y/N)?" behind, so run the real exe when it is there.
      const real = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (existsSync(real)) return { file: real, args: extra };
      break;
    }
  }
  return { file: 'cmd.exe', args: ['/d', '/c', 'claude', ...extra] };
}

function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || STRIP_ENV.has(k.toUpperCase())) continue;
    env[k] = v;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  if (config.port) env.GCS_API = `http://127.0.0.1:${config.port}`;
  if (config.token) env.GCS_TOKEN = config.token;
  return env;
}

function quote(a) { return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a; }

async function start(mode) {
  if (mode !== 'new' && mode !== 'continue') throw new Error(`unknown mode: ${mode}`);
  if (proc) return; // no-op if already running
  await loadPty();
  if (proc) return; // another start won the race while node-pty loaded
  if (!pty) throw new Error('node-pty unavailable: ' + ptyError);

  const { file, args } = resolveCommand(mode);
  broadcast({ t: 'reset' });
  clearOutput();

  const gen = ++generation;
  let p;
  try {
    p = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: state.cols,
      rows: state.rows,
      cwd: config.cwd,
      env: childEnv(),
      // The bundled conpty.dll/OpenConsole.exe. With the inbox ConPTY, node-pty's
      // kill() forks a helper that dies with 'AttachConsole failed' when this
      // server has a console, and only kills the shell after a 5 s timeout.
      // Measured: both modes take a grandchild process down on kill.
      useConptyDll: process.platform === 'win32' && process.env.GCS_CONPTY !== 'inbox',
    });
  } catch (e) {
    lastError = 'spawn failed: ' + e.message;
    Object.assign(state, { running: false, pid: null, mode, exitCode: null, cmd: [file, ...args].map(quote).join(' '), cwd: config.cwd });
    broadcast({ t: 'state', ...getState() });
    throw new Error(lastError);
  }
  proc = p;
  lastError = null;
  Object.assign(state, {
    running: true,
    pid: p.pid,
    mode,
    startedAt: Date.now(),
    exitCode: null,
    cmd: [file, ...args].map(quote).join(' '),
    cwd: config.cwd,
  });

  p.onData((d) => { if (gen === generation) onOutput(d); });
  p.onExit(({ exitCode }) => {
    if (gen !== generation) return; // replaced by a restart
    proc = null;
    clearTimeout(flushTimer);
    flush(); // last output before the state change
    Object.assign(state, { running: false, pid: null, exitCode });
    broadcast({ t: 'state', ...getState() });
  });
  broadcast({ t: 'state', ...getState() });
}

function kill() {
  const p = proc;
  if (!p) return;
  proc = null;
  try { p.kill(); } catch { /* already gone */ }
}

async function restart(mode) {
  if (proc) {
    generation++; // the old process's exit must not touch the new state
    kill();
    Object.assign(state, { running: false, pid: null, exitCode: null });
  }
  await start(mode);
}

function stopProc() {
  if (!proc) return;
  const gen = generation;
  const p = proc;
  try { p.kill(); } catch { /* already gone */ }
  // onExit normally reports the exit; make sure state is right even if it does not fire.
  setTimeout(() => {
    if (gen === generation && proc === p) {
      proc = null;
      Object.assign(state, { running: false, pid: null });
      broadcast({ t: 'state', ...getState() });
    }
  }, 3000).unref();
}

// ---------------------------------------------------------------------------
// the socket
// ---------------------------------------------------------------------------

async function onMessage(ws, raw, isBinary) {
  let m;
  try {
    m = JSON.parse(isBinary ? Buffer.from(raw).toString('utf8') : raw.toString());
  } catch {
    return send(ws, { t: 'error', message: 'message is not JSON' });
  }
  try {
    switch (m && m.t) {
      case 'in':
        if (typeof m.d !== 'string') throw new Error('in: d must be a string');
        if (proc) proc.write(m.d);
        return;
      case 'resize': {
        const cols = Math.trunc(Number(m.cols)), rows = Math.trunc(Number(m.rows));
        if (!(cols >= 2 && cols <= 1000 && rows >= 1 && rows <= 500)) throw new Error('resize: bad cols/rows');
        state.cols = cols; state.rows = rows;
        if (proc) { try { proc.resize(cols, rows); } catch { /* exiting */ } }
        return;
      }
      case 'start': return await start(m.mode || 'new');
      case 'restart': return await restart(m.mode || 'new');
      case 'stop': return stopProc();
      default: throw new Error('unknown message type: ' + (m && m.t));
    }
  } catch (e) {
    send(ws, { t: 'error', message: e.message });
  }
}

/** Called by index.js after the token/Host/Origin checks passed. */
export function handleUpgrade(req, socket, head) {
  loadPty(); // warm up so hello can report a load failure
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('error', () => {});
    ws.on('message', (raw, isBinary) => { onMessage(ws, raw, isBinary); });
    ptyLoad.then(() => {
      send(ws, { t: 'hello', ...getState() });
      // The unflushed tail is already in scrollback and will reach this socket
      // with the next flush, so leave it out of the replay.
      const replay = scrollback.slice(0, Math.max(0, scrollback.length - outBuf.length));
      if (replay) send(ws, { t: 'out', d: replay });
    });
  });
}

/** Kill the PTY and drop every socket. Called from index.js stop(). */
export function shutdown() {
  generation++;
  kill();
  Object.assign(state, { running: false, pid: null });
  clearTimeout(flushTimer);
  flushTimer = null;
  for (const ws of wss.clients) { try { ws.terminate(); } catch { /* ignore */ } }
}
