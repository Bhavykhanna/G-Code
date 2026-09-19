/**
 * client.js -- the frontend's fetch layer. The only place in the app that
 * knows a server exists.
 *
 * Everything here talks to the app's own origin: in a built bundle the API
 * server serves the page itself, and in dev Vite proxies `/api` to it
 * (vite.config.js). So the URLs are relative, there is no CORS, and the same
 * code runs in both modes.
 *
 * Three things this layer owns, because getting any of them wrong has cost
 * time before (docs/CONTEXT-server.md, and CONTEXT.md "Traps"):
 *
 *   1. **The token.** Every `/api/*` call needs the per-start token (BUGS B9).
 *      The server (or the Vite plugin) puts it in `<meta name="gcs-token">`;
 *      it goes in the `X-GCS-Token` header, and in `?token=` for EventSource
 *      and WebSocket, which cannot send headers.
 *   2. **Encoding every path.** Job filenames contain `HSPLA+`, and a raw `+`
 *      in a query string decodes as a space -- a 404 on a file that exists.
 *      `URLSearchParams` does this for us; building a query by hand does not.
 *   3. **The SSE event names.** The server calls a file change `gcode`; the app
 *      listens for `file`. That mismatch once swallowed every live update, so
 *      the rename happens here, in one table, rather than at either end.
 *
 * Errors: the API answers `{ error, detail? }` with a real status code, and
 * those become a thrown `Error` carrying `.status` and `.detail`. The one
 * exception is `/api/edit`, which answers **422 with a full result body** when
 * the safety validator refuses the write. That is not a transport failure, it
 * is the answer -- main.js reads `ok` / `written` / `validation.errors` out of
 * it -- so 422 is passed through instead of thrown.
 */

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

/** The per-start API token, from the meta tag the server injects into the page. */
function token() {
  const el = document.querySelector('meta[name="gcs-token"]');
  return (el && el.content) || '';
}

/** `/api/file?path=...`, with every value encoded. */
function url(route, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  const s = q.toString();
  return s ? route + '?' + s : route;
}

/** An Error that still carries what the server said. */
function apiError(status, body) {
  const err = new Error((body && (body.error || body.message)) || ('HTTP ' + status));
  err.status = status;
  if (body && body.detail) err.detail = body.detail;
  return err;
}

/** Parse a JSON body, tolerating an empty or non-JSON one (a proxy error page). */
async function readJson(res) {
  const raw = await res.text();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return { error: raw.slice(0, 300) }; }
}

async function request(route, { method = 'GET', body, params, text = false, allow = [] } = {}) {
  const init = {
    method,
    headers: { 'X-GCS-Token': token() },
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url(route, params), init);
  } catch (err) {
    // fetch only rejects when the server cannot be reached at all.
    throw new Error('server not reachable (' + err.message + ')');
  }

  if (text) {
    if (!res.ok) throw apiError(res.status, await readJson(res));
    return res.text();
  }

  const data = await readJson(res);
  if (!res.ok && !allow.includes(res.status)) throw apiError(res.status, data);
  return data;
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

/**
 * Raw G-code, byte for byte. `from`/`to` are 0-based inclusive source lines,
 * for fetching just the region a selection covers instead of 3 MB.
 */
export function readFile(path, { from, to } = {}) {
  return request('/api/file', { params: { path, from, to }, text: true });
}

/** The parse result minus `segments` -- the browser parses in its own worker. */
export function getMeta(path) {
  return request('/api/meta', { params: { path } });
}

/** `{ archiveRoot, jobs: [...] }` -- every job folder and the files in it. */
export function listJobs() {
  return request('/api/jobs');
}

/** Every version of one job, with each one's footer stats. */
export function listVersions(job) {
  return request('/api/versions', { params: { job } });
}

/**
 * The file a draft was derived from, or null when there is none. This is what
 * the diff opens against by default.
 */
export async function getBase(path) {
  const res = await request('/api/base', { params: { path } });
  return (res && res.base) || null;
}

// ---------------------------------------------------------------------------
// Lane A edits
// ---------------------------------------------------------------------------

/**
 * Dry run: what the edit would change, with the diff and the validation, and
 * `planError` when the file's name does not follow the convention so no new
 * version can be derived from it. Writes nothing.
 */
export function previewEdit(path, ops, note) {
  return request('/api/edit', {
    method: 'POST',
    body: { path, ops, note, dryRun: true },
    allow: [422],
  });
}

/**
 * The real write. `dryRun:false` *and* a non-empty note are both required by
 * the server -- the note becomes the `<what-changed>` field of the new file
 * name. A refused write comes back as 422 with the validation inside it.
 */
export function applyEdit(path, ops, note) {
  return request('/api/edit', {
    method: 'POST',
    body: { path, ops, note, dryRun: false },
    allow: [422],
  });
}

/** Name a draft, centre it on the bed, move the previous final into `old\`. */
export function finalize(path, note) {
  return request('/api/finalize', { method: 'POST', body: { path, note } });
}

/** Embed the printer-screen preview. `dryRun` decides plan vs write. */
export function addThumbnail(path, { dryRun = true } = {}) {
  return request('/api/thumbnail', { method: 'POST', body: { path, dryRun } });
}

// ---------------------------------------------------------------------------
// the bridge to Claude
// ---------------------------------------------------------------------------

/** Publish the current 3D selection to `bridge/selection.json`. */
export function putSelection(selection) {
  return request('/api/bridge/selection', { method: 'POST', body: selection });
}

/** Whatever is in `bridge/selection.json` right now, or null. */
export async function getSelection() {
  const res = await request('/api/bridge/selection');
  return (res && res.selection) || null;
}

/**
 * Save a selection / area / move (and optionally a PNG of the view) under
 * `bridge/attached/`. The answer names the files Archive-relative, which is
 * exactly what gets typed into Claude's prompt.
 */
export function attach(payload) {
  return request('/api/bridge/attach', { method: 'POST', body: payload });
}

/**
 * The in-app Claude terminal's WebSocket. A function, not a string: the
 * terminal reconnects, and the token is read at that moment.
 */
export const terminalUrl = () => {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return scheme + '//' + location.host + url('/api/term', { token: token() });
};

// ---------------------------------------------------------------------------
// live updates
// ---------------------------------------------------------------------------

/**
 * Subscribe to the server's SSE stream. The callback gets `{ type, data }`,
 * plus `connected` / `disconnected` as the stream comes and goes -- EventSource
 * reconnects on its own (the server sends `retry: 2000`), so a restarted server
 * heals without a page reload.
 *
 * Returns a function that closes the stream.
 */
export function watch(onEvent) {
  const src = new EventSource(url('/api/watch', { token: token() }));
  let up = false;

  const connected = () => { if (!up) { up = true; onEvent({ type: 'connected', data: null }); } };

  src.addEventListener('open', connected);
  src.addEventListener('error', () => {
    // CLOSED, or CONNECTING again after a drop -- either way it is not live now.
    if (up) { up = false; onEvent({ type: 'disconnected', data: null }); }
  });

  // One `addEventListener('<server name>', …)` per event the server
  // broadcasts, spelled out: test/integration-check.js greps both ends for
  // these literals, so an event the app would be deaf to fails the build
  // instead of failing silently. `gcode` is renamed to `file` here -- that
  // mismatch once swallowed every live file update.
  const relay = (type) => (ev) => {
    connected(); // `hello` can arrive before 'open' has been dispatched
    let data = null;
    try { data = ev.data ? JSON.parse(ev.data) : null; } catch { data = null; }
    onEvent({ type, data });
  };
  src.addEventListener('hello', relay('hello'));
  src.addEventListener('gcode', relay('file'));
  src.addEventListener('open', relay('open'));
  src.addEventListener('reload', relay('reload'));
  src.addEventListener('highlight', relay('highlight'));
  src.addEventListener('selection', relay('selection'));
  src.addEventListener('chat', relay('chat'));

  return () => { up = false; src.close(); };
}
