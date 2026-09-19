/**
 * server-smoke.js -- the server starts, the routes answer, the sandbox holds.
 *
 *   node test/server-smoke.js
 *
 * Starts the API on a throwaway port, hits every read-only route against the
 * REAL job folders under the Archive root, and checks that nothing outside that
 * tree is reachable. Writes nothing except bridge\chat.jsonl and
 * bridge\selection.json.
 *
 * Nothing here is pinned to one private print. The subject file is whatever
 * job the server actually finds -- on a clone with no archive that is the demo
 * job, on the archive machine it is the first real job -- and every figure it
 * is measured against comes from the same file on disk, read and parsed by the
 * test itself. The archive-only history checks are gated behind `fx` and
 * skipped (loudly) when test/fixtures.local.js is not there.
 */
import './_isolate.js'; // must be first: keeps the tests out of the live bridge\ folder
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { start, stop } from '../server/index.js';
import { ARCHIVE_ROOT } from '../server/api/files.js';
import { parseGcode } from '../src/parser/parse.js';
import { fx } from './fixtures.js';
import { ok, eq, section, row, run, PORT, BASE, get, getText, post, code, auth } from './server-helpers.js';

/**
 * Read the naming convention straight from the filename, without going through
 * server/api/version.js -- otherwise the check would only be asking the parser
 * whether it agrees with itself. Returns null for anything it cannot split,
 * which is a normal outcome and not a failure.
 */
function fieldsFromName(name) {
  const m = /^(.+)\.gcode$/i.exec(name);
  if (!m) return null;
  const parts = m[1].split('_');
  if (parts.length < 6) return null;
  // A draft (`..._v3-draft.gcode`) has no time field.
  const time = /^v\d+-/.test(parts[parts.length - 1]) ? null : parts.pop();
  const v = /^v(\d+)-(.+)$/.exec(parts.pop());
  if (!v) return null;
  const layerHeight = parts.pop();
  const filament = parts.pop();
  const printer = parts.shift();
  const nozzle = parts.shift();
  if (!parts.length || !/^\d+\.\d+$/.test(layerHeight)) return null;
  return {
    printer, nozzle, model: parts.join('_'), filament, layerHeight,
    version: Number(v[1]), changed: v[2], time,
  };
}

await run(async () => {
  await start(PORT, '127.0.0.1');

  section('health');
  const h = await get('/api/health');
  ok(h.ok === true, 'health.ok');
  row('node', h.node);
  row('archive root', h.archiveRoot);
  row('watching', String(h.watching));
  eq(h.archiveRoot, ARCHIVE_ROOT, 'health reports the sandbox root the module resolved');

  section('/api/jobs');
  const j = await get('/api/jobs');
  const names = j.jobs.map((x) => x.name);
  row('jobs found', names.join(', '));
  ok(j.jobs.length > 0, `the Archive root holds at least one job (${ARCHIVE_ROOT})`);
  eq(j.archiveRoot, ARCHIVE_ROOT, '/api/jobs names the same root');

  // The versioning rules, not today's numbers: a job is listed because it has
  // G-code, old\ is what `archived` means, and the current file is the newest.
  let conventional = 0;
  for (const job of j.jobs) {
    const all = [...job.gcode, ...job.old];
    ok(all.length > 0, `${job.name}: listed because it has G-code (${job.gcode.length} current, ${job.old.length} archived)`);
    ok(job.gcode.every((f) => f.archived === false), `${job.name}: files in the job folder are not archived`);
    ok(job.old.every((f) => f.archived === true), `${job.name}: files in old\\ are archived`);
    // More than one current file only ever means more than one model or
    // filament in the folder: two current versions of the SAME thing is the
    // state the archive rules exist to prevent.
    const stems = job.gcode.filter((f) => f.convention).map((f) => f.model + '|' + f.filament);
    eq(new Set(stems).size, stems.length, `${job.name}: no two current files are versions of the same thing`);
    if (job.gcode.length === 1 && job.old.length) {
      const cur = job.gcode[0].version;
      const oldMax = Math.max(...job.old.map((f) => f.version ?? -1));
      ok(cur > oldMax, `${job.name}: current v${cur} is newer than every archived version (max v${oldMax})`);
    }
    ok(!job.current || all.some((f) => f.path === job.current), `${job.name}: current points at a listed file`);
    for (const f of all) {
      const want = fieldsFromName(f.name);
      if (!want || !f.convention) continue; // unversioned exports are allowed to exist
      conventional++;
      eq(f.version, want.version, `${f.name}: version`);
      eq(f.model, want.model, `${f.name}: model`);
      eq(f.filament, want.filament, `${f.name}: filament`);
      eq(f.layerHeight, want.layerHeight, `${f.name}: layer height`);
      eq(f.changed, want.changed, `${f.name}: what changed`);
      eq(f.time, want.time, `${f.name}: time`);
    }
  }
  ok(conventional > 0, `${conventional} listed file(s) follow the naming convention`);

  // The subject for every file-level check below: the OLDEST archived version of
  // the first job that has one. Archived files never change once they are in
  // old\, so what the test reads off disk is what the route must return
  // tomorrow too.
  const job = j.jobs.find((x) => x.old.length) || j.jobs[0];
  const subject = [...job.old].sort((a, b) => (a.version ?? 0) - (b.version ?? 0))[0] || job.gcode[0];
  const SUBJ = subject.path;
  const SUBJ_ABS = path.join(ARCHIVE_ROOT, ...SUBJ.split('/'));
  row('subject', SUBJ);
  const diskText = await readFile(SUBJ_ABS, 'utf8');
  const diskSize = (await stat(SUBJ_ABS)).size;
  const local = parseGcode(diskText);
  row('on disk', `${diskSize.toLocaleString()} bytes, ${local.count.toLocaleString()} moves`);

  section('archive history (needs test/fixtures.local.js)');
  if (!fx || !fx.smoke) {
    console.log('  skip  no test/fixtures.local.js (or no `smoke` in it): the private print archive is not on this machine');
  } else {
    const v = await get('/api/versions?job=' + encodeURIComponent(fx.smoke.job));
    row(fx.smoke.job, `${v.versions.length} versions`);
    ok(v.versions.length >= fx.smoke.minVersions,
      `${fx.smoke.job} has at least ${fx.smoke.minVersions} versions (got ${v.versions.length})`);
    const jf = j.jobs.find((x) => x.name === fx.smoke.job);
    ok(jf, `/api/jobs finds ${fx.smoke.job}`);
    if (jf) {
      eq(jf.gcode.length, 1, `${fx.smoke.job} current G-code count`);
      eq(jf.stl.length, fx.smoke.stlCount ?? 1, `${fx.smoke.job} STL count`);
      ok(jf.profiles.allPresent, `${fx.smoke.job} has machine/process/filament`);
      const oldVers = jf.old.map((f) => f.version);
      for (const n of fx.smoke.oldVersions || []) {
        ok(oldVers.includes(n), `${fx.smoke.job} old\\ still holds v${n} (has ${oldVers.join(',')})`);
      }
    }
  }

  section('path traversal guard');
  // Climb out of the job folder AND out of the Archive root. A job path is one or two
  // levels deep (a model folder can hold version folders), so the number of `..` is
  // computed: with too few, the path stays inside the root and the honest answer is a
  // 404, not the 403 this section is about.
  const out = '../'.repeat(job.path.split('/').length + 1);
  for (const bad of [
    '../../../Windows/win.ini',
    '..\\..\\..\\Windows\\win.ini',
    'C:/Windows/win.ini',
    job.path + '/' + out + 'Windows/win.ini',
    job.path + '/' + out + 'etc/passwd',
  ]) {
    const st = await code('/api/file?path=' + encodeURIComponent(bad));
    ok(st === 403, `403 for ${bad}  (got ${st})`);
  }
  ok(await code('/api/file?path=') === 400, '400 for an empty path');

  section('/api/file');
  {
    const r = await fetch(BASE + '/api/file?path=' + encodeURIComponent(SUBJ), { headers: auth() });
    const body = await r.text();
    eq(Number(r.headers.get('content-length')), diskSize, 'Content-Length is the file size on disk');
    eq(r.headers.get('x-gcode-path'), SUBJ, 'X-Gcode-Path echoes the Archive-relative path');
    ok(body === diskText, `raw text is byte-for-byte the file (${body.length.toLocaleString()} chars)`);
  }
  const slice = await getText('/api/file?path=' + encodeURIComponent(SUBJ) + '&from=3&to=5');
  eq(slice.split('\n').length, 3, 'from/to returns the requested line range');
  eq(slice, diskText.split('\n').slice(3, 6).join('\n'), 'and it is lines 3..5 of the file itself');

  section('/api/meta');
  const t0 = Date.now();
  const m = await get('/api/meta?path=' + encodeURIComponent(SUBJ));
  row('first parse', (Date.now() - t0) + ' ms');
  // Everything here is checked against a parse the test did itself, so the
  // route is measured against the file rather than against a remembered number.
  eq(m.bytes, diskSize, 'meta.bytes is the size on disk');
  eq(m.count, local.count, 'move count');
  eq(m.layers.length, local.layers.length, 'parsed layer records');
  eq(m.meta.layerCount, local.meta.layerCount, 'meta.layerCount from the header');
  eq(m.meta.estimatedTimeText, local.meta.estimatedTimeText, 'print time from the footer');
  eq(m.meta.estimatedTimeSec, local.meta.estimatedTimeSec, 'print time in seconds');
  eq(m.meta.filamentUsedG, local.meta.filamentUsedG, 'weight from the footer');
  eq(m.meta.maxZ, local.meta.maxZ, 'max Z');
  eq(m.meta.eol, local.meta.eol, 'line ending preserved');
  eq(Object.keys(m.config).length, Object.keys(local.config).length, 'CONFIG_BLOCK key count');
  ok(Object.keys(local.config).length > 100, `the CONFIG_BLOCK really was read (${Object.keys(local.config).length} keys)`);
  eq(m.relativeE, local.relativeE, 'extrusion mode');
  ok(m.segments === undefined, '/api/meta omits the typed arrays');
  // The machine profile's layer_change_gcode emits `;LAYER:n` for the layer it
  // is ABOUT to start, so a file carries at most one extra (empty) trailing
  // marker: 58 parsed layer records for a 57-layer print. meta.layerCount is
  // the header's own figure and is the one to show the user.
  const extra = m.layers.length - m.meta.layerCount;
  ok(extra === 0 || extra === 1,
    `parsed layer records are the header count or one more (${m.layers.length} vs ${m.meta.layerCount})`);
  if (extra === 1) {
    const last = local.layers[local.layers.length - 1];
    ok(!last.moves || last.moves === 0 || last.time === 0, 'and the extra trailing marker is empty');
  }
  const t1 = Date.now();
  await get('/api/meta?path=' + encodeURIComponent(SUBJ));
  row('cached parse', (Date.now() - t1) + ' ms');

  section('/api/versions');
  const v = await get('/api/versions?job=' + encodeURIComponent(job.path));
  eq(v.versions.length, job.gcode.length + job.old.length, 'every file in the job is a version');
  eq(v.current, job.current, 'current matches the job listing');
  eq(v.versions.filter((x) => !x.archived).length, job.gcode.length, 'exactly the job-folder files are unarchived');
  let prev = -Infinity;
  for (const x of v.versions) {
    row(`v${x.version} ${x.archived ? 'old' : 'cur'}`, `${x.footer.timeText}  ${x.footer.filamentG} g  ${x.fields ? x.fields.changed : '-'}`);
    ok(x.version == null || x.version >= prev, `v${x.version} is listed in version order`);
    if (x.version != null) prev = x.version;
    const want = fieldsFromName(x.name);
    if (!want) continue;
    ok(x.convention, `${x.name} follows the convention`);
    eq(x.version, want.version, `${x.name}: version`);
    ok(x.footer.timeSec > 0, `v${x.version} footer time read`);
    ok(x.footer.filamentG > 0, `v${x.version} footer weight read`);
    ok(x.size > 0, `v${x.version} size read`);
  }
  // The subject was parsed above: the tail read and the full parse must agree.
  const vs = v.versions.find((x) => x.path === SUBJ);
  ok(vs, 'the subject file is one of the versions');
  eq(vs.footer.timeText, local.meta.estimatedTimeText, 'the footer tail read agrees with a full parse');
  eq(vs.footer.filamentG, local.meta.filamentUsedG, 'and on the weight');
  eq(vs.footer.layerCount, local.meta.layerCount, 'and on the layer count');
  ok((await get('/api/versions?job=' + encodeURIComponent(job.path + '/nope'))).error != null,
    'an unknown job is an error, not an empty list');

  section('bridge');
  const sel = {
    id: 'sel-smoke-' + Date.now(),
    file: SUBJ,
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
    const hl = await post('/api/app/highlight', {
      path: SUBJ,
      regions: [{ x: [200, 190], label: 'gap' }, { y: [184, 186], layers: [3, 1] }],
    });
    eq(hl.__status, 200, 'highlight accepted');
    eq(JSON.stringify(hl.regions[0].x), '[190,200]', 'ranges are put in order');
    eq(hl.regions[1].label, 'area 2', 'a missing label gets a number');
    eq(JSON.stringify(hl.regions[1].layers), '[1,3]', 'layers ordered too');
    eq(hl.path, SUBJ, 'the file is resolved');
    eq((await post('/api/app/highlight', { regions: [{ label: 'nothing' }] })).__status, 400, 'a box needs x, y or layers');
    eq((await post('/api/app/highlight', { regions: [{ x: [1] }] })).__status, 400, 'x must be [from, to]');
    eq((await post('/api/app/highlight', { regions: [] })).__status, 400, 'empty regions without clear is refused');
    eq((await post('/api/app/highlight', { clear: true })).regions.length, 0, 'clear sends no regions');

    // `diff: true` means "the version before this one": the highest version of
    // the same model and filament below it, or null when there is none.
    const all = [...job.gcode, ...job.old].filter((f) => f.convention);
    const baseFor = (f) => {
      const lower = all.filter((x) => x.version < f.version && x.model === f.model && x.filament === f.filament);
      lower.sort((a, b) => a.version - b.version || (a.archived === b.archived ? 0 : a.archived ? -1 : 1));
      return lower.length ? lower[lower.length - 1].path : null;
    };
    const op = await post('/api/app/open', { path: SUBJ, diff: true });
    eq(op.__status, 200, 'open accepted');
    eq(op.diff, baseFor(subject), `the oldest version has no base to diff against`);
    if (job.gcode.length === 1 && job.gcode[0].convention) {
      const cur = job.gcode[0];
      const opc = await post('/api/app/open', { path: cur.path, diff: true });
      eq(opc.diff, baseFor(cur), 'the current version diffs against the version below it');
    }
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
