/**
 * bridge.js -- the files the app and Claude talk through.
 *
 *   bridge\selection.json   the current 3D selection, written by the app
 *   bridge\requests.jsonl   append-only log of what the app asked for
 *   bridge\chat.jsonl       append-only chat transcript, BOTH directions
 *   bridge\attached\        <id>.json / <id>.png attached to Claude's prompt (newest 40 kept)
 *
 * There is no model, no API key and no outbound network call anywhere in this
 * file. The chat is a file-backed mailbox: the UI appends a user message, a
 * Claude session running in a terminal reads it, does the work, and appends a
 * reply. The server's only jobs are to make the append safe and to tell
 * listeners that the file moved.
 *
 * Concurrency rules, because an external writer is the normal case:
 *   - APPEND ONLY. The whole file is never rewritten, so a concurrent appender
 *     can never lose a line. `fs.appendFile` opens with O_APPEND, which on both
 *     Windows and POSIX makes a single small write atomic against other
 *     appenders.
 *   - One in-process serialising queue, so this server never interleaves two of
 *     its own writes.
 *   - Reads skip malformed lines instead of throwing. A half-written line from
 *     an external writer, or a truncated file, must not take an endpoint down.
 *   - `answered` is DERIVED, never stored back. Marking a message answered by
 *     rewriting its line would break the append-only rule, so a user message
 *     counts as answered when some claude message carries replyTo = its id.
 */
import { readFile, writeFile, appendFile, mkdir, rename, stat, readdir, rm } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { HttpError, PROJECT_ROOT, ARCHIVE_ROOT } from './files.js';

// GCS_BRIDGE_DIR lets the tests use their own folder (test/_isolate.js); the
// live app watches this one and reacts to every write.
export const BRIDGE_DIR = process.env.GCS_BRIDGE_DIR
  ? path.resolve(process.env.GCS_BRIDGE_DIR)
  : path.join(PROJECT_ROOT, 'bridge');
export const SELECTION_FILE = path.join(BRIDGE_DIR, 'selection.json');
export const REQUESTS_FILE = path.join(BRIDGE_DIR, 'requests.jsonl');
export const CHAT_FILE = path.join(BRIDGE_DIR, 'chat.jsonl');

const MAX_TEXT = 32 * 1024;
const DEFAULT_TAIL = 200;

/** Emits 'chat' with an array of newly seen messages. */
export const bridgeEvents = new EventEmitter();

// ---------------------------------------------------------------------------
// append discipline
// ---------------------------------------------------------------------------

let chain = Promise.resolve();

/** Serialise our own writes. External writers are handled by O_APPEND. */
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

async function appendLine(file, obj) {
  // JSON.stringify never emits a raw newline, so one record is always one line.
  const line = JSON.stringify(obj) + '\n';
  await serial(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, line, 'utf8'); // O_APPEND: atomic for a line-sized write
  });
  return obj;
}

/** Read a .jsonl file, skipping anything that does not parse. */
async function readJsonl(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { rows: [], skipped: 0, bytes: 0 };
    throw new HttpError(500, 'cannot read ' + path.basename(file) + ': ' + e.message);
  }
  const rows = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') rows.push(o); else skipped++;
    } catch {
      skipped++; // half-written tail line, or something hand-edited badly
    }
  }
  return { rows, skipped, bytes: Buffer.byteLength(text) };
}

let idCounter = 0;
function newId(prefix) {
  idCounter = (idCounter + 1) % 1000;
  return `${prefix}-${Date.now()}-${idCounter.toString(36)}${Math.random().toString(36).slice(2, 4)}`;
}

// ---------------------------------------------------------------------------
// selection.json
// ---------------------------------------------------------------------------

/** GET /api/bridge/selection -> the selection object, or null when unset. */
export async function readSelection() {
  try {
    const text = await readFile(SELECTION_FILE, 'utf8');
    return JSON.parse(text);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e instanceof SyntaxError) throw new HttpError(500, 'bridge/selection.json is not valid JSON');
    throw new HttpError(500, e.message);
  }
}

/**
 * POST /api/bridge/selection -- write via temp + rename so a reader in the
 * terminal never sees a half-written selection.
 */
export async function writeSelection(sel) {
  if (!sel || typeof sel !== 'object') throw new HttpError(400, 'a selection object is required');
  const out = { ...sel };
  if (!out.id) out.id = newId('sel');
  if (!out.ts) out.ts = new Date().toISOString();
  const text = JSON.stringify(out, null, 2) + '\n';
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new HttpError(413, 'selection is too large');

  await serial(async () => {
    await mkdir(BRIDGE_DIR, { recursive: true });
    const tmp = SELECTION_FILE + '.tmp-' + process.pid;
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, SELECTION_FILE);
  });
  return out;
}

// ---------------------------------------------------------------------------
// requests.jsonl
// ---------------------------------------------------------------------------

/** POST /api/bridge/request -- append one request record. */
export async function appendRequest(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'a request object is required');
  const rec = {
    id: newId('req'),
    ts: new Date().toISOString(),
    ...body,
  };
  const size = Buffer.byteLength(JSON.stringify(rec));
  if (size > 256 * 1024) throw new HttpError(413, 'request record is too large');
  await appendLine(REQUESTS_FILE, rec);
  return rec;
}

export async function readRequests(limit = 200) {
  const { rows, skipped } = await readJsonl(REQUESTS_FILE);
  return { requests: rows.slice(-limit), total: rows.length, skipped };
}

// ---------------------------------------------------------------------------
// chat.jsonl
// ---------------------------------------------------------------------------

/**
 * Read the transcript and derive each user message's effective status.
 * Shared by every chat endpoint and by server/chat-cli.js.
 */
export async function readChat() {
  const { rows, skipped, bytes } = await readJsonl(CHAT_FILE);
  const answered = new Set();
  for (const m of rows) {
    if (m.role !== 'user' && m.replyTo) answered.add(m.replyTo);
  }
  const messages = rows.map((m) => (
    m.role === 'user'
      ? { ...m, status: answered.has(m.id) ? 'answered' : (m.status || 'pending') }
      : m
  ));
  return { messages, skipped, bytes };
}

/**
 * GET /api/bridge/chat?since=<id>
 * An unknown `since` returns the tail rather than erroring -- the client may
 * have been looking at a transcript that was moved aside.
 */
export async function getChat(since, limit = DEFAULT_TAIL) {
  const { messages, skipped } = await readChat();
  if (since) {
    const i = messages.findIndex((m) => m.id === since);
    if (i >= 0) return { messages: messages.slice(i + 1), since, total: messages.length, skipped };
    return { messages: messages.slice(-limit), since, sinceUnknown: true, total: messages.length, skipped };
  }
  return { messages: messages.slice(-limit), total: messages.length, skipped };
}

function checkText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'text is required and must not be empty');
  if (Buffer.byteLength(text) > MAX_TEXT) throw new HttpError(413, `text exceeds ${MAX_TEXT} bytes`);
  return text;
}

/** POST /api/bridge/chat -- a message from the UI. */
export async function postChatUser({ text, selectionId = null }) {
  checkText(text);
  const msg = {
    id: newId('msg'),
    ts: new Date().toISOString(),
    role: 'user',
    text,
    selectionId: selectionId || null,
    status: 'pending',
  };
  await appendLine(CHAT_FILE, msg);
  await notifyChatChanged();
  return msg;
}

/**
 * POST /api/bridge/chat/reply -- a message from Claude.
 * `replyTo` defaults to the oldest unanswered user message, so a terminal
 * session can just post text.
 */
export async function postChatReply({ text, replyTo, actions }) {
  checkText(text);
  if (actions !== undefined && !Array.isArray(actions)) throw new HttpError(400, 'actions must be an array');
  let to = replyTo || null;
  if (!to) {
    const { messages } = await readChat();
    const pending = messages.filter((m) => m.role === 'user' && m.status === 'pending');
    to = pending.length ? pending[pending.length - 1].id : null;
  }
  const msg = {
    id: newId('msg'),
    ts: new Date().toISOString(),
    role: 'claude',
    text,
    replyTo: to,
    ...(actions ? { actions: actions.slice(0, 20) } : {}),
  };
  await appendLine(CHAT_FILE, msg);
  await notifyChatChanged();
  return msg;
}

/**
 * GET /api/bridge/chat/pending -- what Claude polls.
 * Self-contained on purpose: the referenced selection is inlined so a terminal
 * session can act without a second call.
 */
export async function getChatPending() {
  const [{ messages, skipped }, selection] = await Promise.all([readChat(), readSelection()]);
  const pending = messages.filter((m) => m.role === 'user' && m.status === 'pending');
  const withSel = pending.map((m) => ({
    ...m,
    selection: selection && m.selectionId && selection.id === m.selectionId ? selection : null,
  }));
  return {
    pending: withSel,
    count: withSel.length,
    currentSelection: selection,
    chatFile: path.relative(PROJECT_ROOT, CHAT_FILE).split(path.sep).join('/'),
    skipped,
  };
}

// ---------------------------------------------------------------------------
// change notification
// ---------------------------------------------------------------------------
// Both our own appends and Claude's external appends funnel through here, so
// the SSE stream sees every message exactly once.

const emitted = new Set();
let emittedOrder = [];
let primed = false;

/** Re-read the transcript and emit anything not seen yet. */
export async function notifyChatChanged() {
  let messages;
  try {
    ({ messages } = await readChat());
  } catch {
    return; // a transient read failure is not worth killing the watcher over
  }
  const fresh = [];
  for (const m of messages) {
    if (!m.id || emitted.has(m.id)) continue;
    emitted.add(m.id);
    emittedOrder.push(m.id);
    fresh.push(m);
  }
  while (emittedOrder.length > 5000) emitted.delete(emittedOrder.shift());
  if (!primed) { primed = true; return; } // the transcript that existed at boot is not "new"
  if (fresh.length) bridgeEvents.emit('chat', fresh);
}

let watcher = null;
let debounce = null;

/**
 * Watch bridge\ for external appends to chat.jsonl (the normal case for
 * replies) and for selection.json being rewritten from the terminal.
 * fs.watch on a directory survives the file being created later.
 */
export async function startBridgeWatch() {
  await mkdir(BRIDGE_DIR, { recursive: true });
  await notifyChatChanged(); // prime `emitted` with whatever is already there
  if (watcher) return watcher;
  try {
    watcher = watch(BRIDGE_DIR, { persistent: false }, (_type, filename) => {
      if (!filename) return;
      const f = String(filename);
      if (f !== 'chat.jsonl' && f !== 'selection.json') return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (f === 'selection.json') bridgeEvents.emit('selection', { path: 'bridge/selection.json' });
        notifyChatChanged();
      }, 120);
    });
    watcher.on('error', () => { watcher = null; });
  } catch {
    watcher = null; // watching is a convenience; polling /api/bridge/chat still works
  }
  return watcher;
}

export function stopBridgeWatch() {
  clearTimeout(debounce);
  if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
}

// ---------------------------------------------------------------------------
// bridge/attached/ -- POST /api/bridge/attach
// ---------------------------------------------------------------------------
// The app attaches a selection / area / move to Claude's prompt by typing a
// one-line reference; the bulky data (and an optional screenshot) lives here
// and the reference names the files by Archive-relative path, because Claude
// runs with cwd = the Archive root.

export const ATTACH_DIR = path.join(BRIDGE_DIR, 'attached');
const ATTACH_KINDS = new Set(['selection', 'area', 'move']);
const ATTACH_ID = /^[a-z]+-[0-9a-z-]{1,60}$/i;
const ATTACH_MAX_JSON = 2 * 1024 * 1024;
const ATTACH_MAX_PNG = 6 * 1024 * 1024;
const PNG_PREFIX = 'data:image/png;base64,';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** GCS_ATTACH_DIR (tests) must still be inside the Archive; else the default. */
function attachDir() {
  const o = process.env.GCS_ATTACH_DIR;
  if (o) {
    const abs = path.resolve(o);
    const rel = path.relative(ARCHIVE_ROOT, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return abs;
  }
  return ATTACH_DIR;
}

const archiveRel = (abs) => path.relative(ARCHIVE_ROOT, abs).split(path.sep).join('/');

/** Keep the newest `keep` ids (by newest file mtime per id); delete the rest. */
async function pruneAttached(dir, keep, current) {
  const byId = new Map();
  for (const name of await readdir(dir)) {
    const m = /^(.+)\.(json|png)$/.exec(name);
    if (!m) continue;
    let st;
    try { st = await stat(path.join(dir, name)); } catch { continue; }
    const e = byId.get(m[1]) || { mtime: 0, files: [] };
    e.mtime = Math.max(e.mtime, st.mtimeMs);
    e.files.push(name);
    byId.set(m[1], e);
  }
  const cur = byId.get(current);
  byId.delete(current); // always kept, even when mtimes tie within a millisecond
  const old = [...byId.values()].sort((a, b) => b.mtime - a.mtime).slice(cur ? keep - 1 : keep);
  for (const e of old) {
    for (const f of e.files) await rm(path.join(dir, f), { force: true });
  }
}

export async function attachFile(body, { keep = 40 } = {}) {
  const { kind, id, file, data, png } = body || {};
  if (!ATTACH_KINDS.has(kind)) throw new HttpError(400, 'kind must be selection, area or move');
  if (typeof id !== 'string' || !ATTACH_ID.test(id)) throw new HttpError(400, 'id must match ' + ATTACH_ID);
  if (file != null && typeof file !== 'string') throw new HttpError(400, 'file must be a string');
  if (!data || typeof data !== 'object') throw new HttpError(400, 'data must be a JSON object');
  const json = JSON.stringify(data, null, 1) + '\n';
  if (Buffer.byteLength(json) > ATTACH_MAX_JSON) throw new HttpError(413, 'data exceeds 2 MB');

  let pngBuf = null;
  if (png != null) {
    if (typeof png !== 'string' || !png.startsWith(PNG_PREFIX)) {
      throw new HttpError(400, 'png must be a data:image/png;base64, URL');
    }
    const b64 = png.slice(PNG_PREFIX.length);
    if (b64.length > Math.ceil(ATTACH_MAX_PNG / 3) * 4 + 4) throw new HttpError(413, 'png exceeds 6 MB');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new HttpError(400, 'png is not valid base64');
    pngBuf = Buffer.from(b64, 'base64');
    if (pngBuf.length > ATTACH_MAX_PNG) throw new HttpError(413, 'png exceeds 6 MB');
    if (pngBuf.length < 8 || !pngBuf.subarray(0, 8).equals(PNG_MAGIC)) {
      throw new HttpError(400, 'png is not a PNG image');
    }
  }

  const dir = attachDir();
  const jsonAbs = path.join(dir, id + '.json');
  const pngAbs = path.join(dir, id + '.png');
  await serial(async () => {
    await mkdir(dir, { recursive: true });
    const tmp = `.tmp-${process.pid}-${Date.now()}`;
    await writeFile(jsonAbs + tmp, json, 'utf8');
    await rename(jsonAbs + tmp, jsonAbs);
    if (pngBuf) {
      await writeFile(pngAbs + tmp, pngBuf);
      await rename(pngAbs + tmp, pngAbs);
    } else {
      await rm(pngAbs, { force: true }); // a stale screenshot from an earlier attach of this id
    }
    await pruneAttached(dir, keep, id);
  });
  return { ok: true, id, json: archiveRel(jsonAbs), png: pngBuf ? archiveRel(pngAbs) : null };
}

/** Small helper for the CLI and for tests. */
export async function chatStats() {
  const { messages, skipped, bytes } = await readChat();
  let st = null;
  try { st = await stat(CHAT_FILE); } catch { /* no file yet */ }
  return {
    file: CHAT_FILE,
    exists: !!st,
    bytes,
    messages: messages.length,
    pending: messages.filter((m) => m.role === 'user' && m.status === 'pending').length,
    skipped,
  };
}
