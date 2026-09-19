/**
 * server-smoke.js -- the server starts, the routes answer, the sandbox holds.
 *
 *   node test/server-smoke.js
 *
 * Starts the API on a throwaway port, hits every read-only route against the
 * REAL job folders, and checks that nothing outside the Archive tree is
 * reachable. Writes nothing except bridge\chat.jsonl and bridge\selection.json.
 */
import './_isolate.js'; // must be first: keeps the tests out of the live bridge\ folder
import { start, stop } from '../server/index.js';
import { ok, eq, section, row, run, PORT, get, getText, post, code, auth } from './server-helpers.js';

// Archived versions never change once they are in old\, so the byte-exact
// checks below pin to one of those rather than to whatever is current today.
const F17 = 'phonecase-17pro/old/EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v1-ironed_49m.gcode';

await run(async () => {
  await start(PORT, '127.0.0.1');

  section('health');
  const h = await get('/api/health');
  ok(h.ok === true, 'health.ok');
  row('node', h.node);
  row('archive root', h.archiveRoot);
  row('watching', String(h.watching));

  section('/api/jobs');
  const j = await get('/api/jobs');
  const names = j.jobs.map((x) => x.name);
  row('jobs found', names.join(', '));
  ok(names.includes('phonecase-16pro'), 'finds phonecase-16pro');
  ok(names.includes('phonecase-17pro'), 'finds phonecase-17pro');
  const p16 = j.jobs.find((x) => x.name === 'phonecase-16pro');
  const p17 = j.jobs.find((x) => x.name === 'phonecase-17pro');
  // New versions get added over time, so check the versioning rules rather
  // than today's exact numbers: one current file, newer than every archived one,
  // and the original v1..v3 history still intact.
  eq(p16.gcode.length, 1, '16 Pro current G-code count');
  ok(p16.old.length >= 3, `16 Pro archived version count >= 3 (got ${p16.old.length})`);
  eq(p16.stl.length, 1, '16 Pro STL count');
  ok(p16.profiles.allPresent, '16 Pro has machine/process/filament');
  const oldVers = p16.old.map((f) => f.version);
  ok(p16.gcode[0].version > Math.max(...oldVers),
    `16 Pro current v${p16.gcode[0].version} is newer than every archived version`);
  ok([1, 2, 3].every((n) => oldVers.includes(n)), `16 Pro old/ still holds v1,v2,v3 (has ${oldVers.join(',')})`);
  eq(p17.gcode.length, 1, '17 Pro current G-code count');
  eq(p17.gcode[0].model, 'Iphone17Pro_HexCover', '17 Pro model parsed from the filename');
  eq(p17.gcode[0].filament, 'HSPLA+', '17 Pro filament parsed');
  eq(p17.gcode[0].layerHeight, '0.20', '17 Pro layer height parsed');
  eq(p17.gcode[0].time, '49m', '17 Pro time parsed');

  section('path traversal guard');
  for (const bad of [
    '../../../Windows/win.ini',
    '..\\..\\..\\Windows\\win.ini',
    'C:/Windows/win.ini',
    'phonecase-17pro/../../CONTEXT-3D-PRINTING.md',
    'phonecase-17pro/../../../etc/passwd',
  ]) {
    const st = await code('/api/file?path=' + encodeURIComponent(bad));
    ok(st === 403, `403 for ${bad}  (got ${st})`);
  }
  ok(await code('/api/file?path=') === 400, '400 for an empty path');

  section('/api/file');
  const text = await getText('/api/file?path=' + encodeURIComponent(F17));
  eq(text.length, 2963504, '17 Pro raw bytes');
  ok(text.startsWith('\n\n; HEADER_BLOCK_START'), 'raw text is byte-for-byte the file');
  const slice = await getText('/api/file?path=' + encodeURIComponent(F17) + '&from=3&to=5');
  eq(slice.split('\n').length, 3, 'from/to returns the requested line range');

  section('/api/meta');
  const t0 = Date.now();
  const m = await get('/api/meta?path=' + encodeURIComponent(F17));
  row('first parse', (Date.now() - t0) + ' ms');
  // 92,648 straight moves + the end-G-code wipe arc (G2), drawn as 16 chords since 2026-09-16
  eq(m.count, 92664, 'move count');
  // The machine profile's layer_change_gcode emits `;LAYER:n` for the layer it
  // is ABOUT to start, so the file carries one extra (empty) trailing marker:
  // 58 parsed layer records for a 57-layer print. meta.layerCount is the
  // header's own figure and is the one to show the user.
  eq(m.layers.length, 58, 'parsed layer records (57 real layers + the trailing marker)');
  eq(m.meta.layerCount, 57, 'meta.layerCount from the header');
  eq(m.meta.estimatedTimeText, '49m 15s', 'print time from the footer');
  eq(m.meta.filamentUsedG, 15.1, 'weight from the footer');
  eq(Object.keys(m.config).length, 624, 'CONFIG_BLOCK key count');
  ok(m.relativeE === true, 'M83 relative extrusion');
  ok(m.segments === undefined, '/api/meta omits the typed arrays');
  const t1 = Date.now();
  await get('/api/meta?path=' + encodeURIComponent(F17));
  row('cached parse', (Date.now() - t1) + ' ms');

  section('/api/versions');
  const v = await get('/api/versions?job=phonecase-16pro');
  ok(v.versions.length >= 4, `16 Pro has at least 4 versions (got ${v.versions.length})`);
  for (const x of v.versions) {
    row(`v${x.version} ${x.archived ? 'old' : 'cur'}`, `${x.footer.timeText}  ${x.footer.filamentG} g  ${x.fields.changed}`);
    ok(x.convention, `${x.name} follows the convention`);
    ok(x.footer.timeSec > 0, `v${x.version} footer time read`);
  }

  section('bridge');
  const sel = {
    id: 'sel-smoke-' + Date.now(),
    file: F17,
    lineRanges: [[97240, 97300]],
    summary: { count: 60, layers: [20, 20], zRange: [4.08, 4.08], features: { 'Outer wall': 60 }, lengthMm: 123.4, timeSec: 2.1 },
  };
  await post('/api/bridge/selection', { selection: sel });
  const back = await get('/api/bridge/selection');
  eq(back.selection.id, sel.id, 'selection round-trips');

  const req = await post('/api/bridge/request', { kind: 'smoke-test', note: 'ignore me' });
  ok(req.request.id.startsWith('req-'), 'request appended with an id');

  section('chat transport');
  const before = (await get('/api/bridge/chat')).total;
  const um = await post('/api/bridge/chat', { text: 'smoke test: slow the top down', selectionId: sel.id });
  ok(um.message.id.startsWith('msg-'), 'user message gets an id');
  eq(um.message.role, 'user', 'role is user');
  eq(um.message.status, 'pending', 'status starts pending');

  const pend = await get('/api/bridge/chat/pending');
  ok(pend.pending.some((x) => x.id === um.message.id), 'shows up in /pending');
  const mine = pend.pending.find((x) => x.id === um.message.id);
  ok(mine.selection && mine.selection.id === sel.id, '/pending inlines the referenced selection');

  const rep = await post('/api/bridge/chat/reply', { text: 'done -- see v5', replyTo: um.message.id, actions: [{ kind: 'edit', label: 'apply', detail: 'scaleSpeed 0.8' }] });
  eq(rep.message.role, 'claude', 'reply role is claude');
  const pend2 = await get('/api/bridge/chat/pending');
  ok(!pend2.pending.some((x) => x.id === um.message.id), 'answered message leaves /pending');

  const since = await get('/api/bridge/chat?since=' + encodeURIComponent(um.message.id));
  eq(since.messages.length, 1, 'since= returns only what came after');
  eq(since.messages[0].id, rep.message.id, 'and it is the reply');
  const unknown = await get('/api/bridge/chat?since=msg-does-not-exist');
  ok(unknown.sinceUnknown === true, 'unknown since= falls back to the tail instead of erroring');
  eq((await get('/api/bridge/chat')).total, before + 2, 'two messages were appended');

  section('malformed jsonl tolerance');
  const { appendFile } = await import('node:fs/promises');
  const { CHAT_FILE } = await import('../server/api/bridge.js');
  await appendFile(CHAT_FILE, '{"id":"msg-broken","role":"user"\n', 'utf8'); // half-written line
  const afterJunk = await get('/api/bridge/chat');
  ok(afterJunk.skipped >= 1, `skipped ${afterJunk.skipped} malformed line(s) instead of throwing`);
  await appendFile(CHAT_FILE, '\n', 'utf8'); // terminate it so later runs are clean

  section('SSE /api/watch');
  const events = await collectSse(2500, async () => {
    await post('/api/bridge/chat', { text: 'smoke test: does SSE push?' });
  });
  ok(events.some((e) => e.event === 'hello'), 'stream opens with hello');
  ok(events.some((e) => e.event === 'chat'), 'a new chat message is pushed as event: chat');

  section('SSE: a G-code file changing on disk');
  // This is the hot-reload path: Claude writes a new version from the terminal
  // and the UI must notice without polling.
  const { mkdir, writeFile, rm } = await import('node:fs/promises');
  const pathMod = await import('node:path');
  const { ARCHIVE_ROOT } = await import('../server/api/files.js');
  const scratch = pathMod.join(ARCHIVE_ROOT, 'gcode-studio-scratch-watch');
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  try {
    const gEvents = await collectSse(3000, async () => {
      await writeFile(pathMod.join(scratch, 'EN4Max_0.4_Test_PLA_0.20_v1-watch_1m.gcode'), ';LAYER:0\nG1 X1 Y1 E1\n', 'utf8');
    });
    const g = gEvents.filter((e) => e.event === 'gcode');
    row('gcode events', g.length ? g[0].data : '(none)');
    ok(g.length > 0, 'writing a .gcode under the Archive pushes event: gcode');
    ok(g.some((e) => /gcode-studio-scratch-watch/.test(e.data)), 'and names the file that changed');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  section('app control: highlight and open');
  {
    const REL17 = 'phonecase-17pro/old/EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v1-ironed_49m.gcode';
    const h = await post('/api/app/highlight', {
      path: REL17,
      regions: [{ x: [200, 190], label: 'gap' }, { y: [184, 186], layers: [3, 1] }],
    });
    eq(h.__status, 200, 'highlight accepted');
    eq(JSON.stringify(h.regions[0].x), '[190,200]', 'ranges are put in order');
    eq(h.regions[1].label, 'area 2', 'a missing label gets a number');
    eq(JSON.stringify(h.regions[1].layers), '[1,3]', 'layers ordered too');
    eq(h.path, REL17, 'the file is resolved');
    eq((await post('/api/app/highlight', { regions: [{ label: 'nothing' }] })).__status, 400, 'a box needs x, y or layers');
    eq((await post('/api/app/highlight', { regions: [{ x: [1] }] })).__status, 400, 'x must be [from, to]');
    eq((await post('/api/app/highlight', { regions: [] })).__status, 400, 'empty regions without clear is refused');
    eq((await post('/api/app/highlight', { clear: true })).regions.length, 0, 'clear sends no regions');
    const op = await post('/api/app/open', { path: REL17, diff: true });
    eq(op.__status, 200, 'open accepted');
    eq(op.diff, null, 'v1 has no base to diff against');
  }

  section('404 / 405');
  ok(await code('/api/nope') === 404, 'unknown /api route is 404');

  await stop();
});

/** Open the SSE stream, run `trigger`, and collect events for `ms`. */
async function collectSse(ms, trigger) {
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${PORT}/api/watch`, { signal: ctrl.signal, headers: auth() });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const events = [];
  let buf = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /event: (.+)/.exec(block);
          const da = /data: (.*)/.exec(block);
          if (ev) events.push({ event: ev[1].trim(), data: da ? da[1] : null });
        }
      }
    } catch { /* aborted */ }
  })();
  await new Promise((r) => setTimeout(r, 200));
  await trigger();
  await new Promise((r) => setTimeout(r, ms));
  ctrl.abort();
  await pump;
  return events;
}
