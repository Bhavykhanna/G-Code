/**
 * server-diff.js -- A/B compare two real versions of the same job.
 *
 *   node test/server-diff.js
 *
 * Two halves:
 *
 *   - **anywhere**: the settings diff on its own (pure, so it is driven with
 *     made-up config blocks), then /api/diff over two real versions of whatever
 *     job the server finds -- the demo job on a clone, a real job on the
 *     archive machine. Every figure is checked against a parse the test does
 *     itself, and against the arithmetic the answer has to satisfy: the deltas
 *     are b - a, every move lands in exactly one feature bucket, the layer
 *     table is the union of both files' layers, the "biggest changes" list is
 *     the sorted head of it.
 *   - **the archive story**: v3-slowtop vs v4-ironed is the interesting pair --
 *     same geometry, one setting group changed, so the settings diff should
 *     name exactly the ironing keys and Ironing should appear as a feature out
 *     of nowhere. Those files are private, so that half is gated behind
 *     `fx.diffPair` and skipped where there is no archive.
 *
 * Reads only. Writes nothing.
 */
import './_isolate.js'; // must be first: keeps the tests out of the live bridge\ folder
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { start, stop } from '../server/index.js';
import { ARCHIVE_ROOT } from '../server/api/files.js';
import { settingsDiff } from '../server/api/diff.js';
import { parseGcode, formatDuration } from '../src/parser/parse.js';
import { fx } from './fixtures.js';
import { ok, eq, section, row, run, get, code, PORT } from './server-helpers.js';

/** diff.js rounds every number it reports to 2 dp; compare on the same grid. */
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);

await run(async () => {
  await start(PORT, '127.0.0.1');

  section('settings diff (pure)');
  {
    // Driven with made-up config blocks so the rules are checked without
    // needing any particular file: only differing keys are reported, the
    // one-sided keys are kept apart, and numeric pairs carry their delta.
    const a = { ironing_type: 'no ironing', ironing_flow: '10', layer_height: '0.2', speed: '100', gone: '1' };
    const b = { ironing_type: 'top surfaces', ironing_flow: '10', layer_height: '0.2', speed: '80', added: '2' };
    const s = settingsDiff(a, b);
    eq(s.counts.a, 5, 'counts.a is the whole block, not the diff');
    eq(s.counts.b, 5, 'counts.b likewise');
    eq(s.changed.map((c) => c.key).join(','), 'ironing_type,speed', 'only the keys that differ, sorted');
    eq(s.counts.changed, 2, 'counts.changed matches the list');
    eq(s.onlyInA.map((c) => c.key).join(','), 'gone', 'a key only in a');
    eq(s.onlyInB.map((c) => c.key).join(','), 'added', 'a key only in b');
    const speed = s.changed.find((c) => c.key === 'speed');
    eq(speed.a, '100', 'values kept verbatim (a)');
    eq(speed.b, '80', 'values kept verbatim (b)');
    eq(speed.numeric.delta, -20, 'numeric delta');
    eq(speed.numeric.pct, -20, 'and the percentage');
    eq(s.changed.find((c) => c.key === 'ironing_type').numeric, null, 'no numeric delta for text');
    eq(settingsDiff(a, a).counts.changed, 0, 'a block against itself: nothing differs');
  }

  // The subject pair: two versions of the same real job, discovered rather than
  // named, so this runs on a clone with only demo\ as well as on the archive.
  const jobs = (await get('/api/jobs')).jobs;
  const job = jobs.find((x) => x.gcode.length && x.old.length) || jobs[0];
  ok(job && job.gcode.length && job.old.length, 'a job with a current version and an archived one');
  const A = [...job.old].sort((x, y) => (x.version ?? 0) - (y.version ?? 0))[0];
  const B = job.gcode[0];

  section(`${A.name}  ->  ${B.name}`);
  const abs = (p) => path.join(ARCHIVE_ROOT, ...p.split('/'));
  const [pa, pb] = await Promise.all([
    readFile(abs(A.path), 'utf8').then(parseGcode),
    readFile(abs(B.path), 'utf8').then(parseGcode),
  ]);
  const [sa, sb] = await Promise.all([stat(abs(A.path)), stat(abs(B.path))]);

  const t0 = Date.now();
  const d = await get(`/api/diff?a=${encodeURIComponent(A.path)}&b=${encodeURIComponent(B.path)}`);
  row('diff time', (Date.now() - t0) + ' ms (both files parsed cold)');
  row('a', `${d.a.name}  ${d.a.moves.toLocaleString()} moves, ${d.a.configKeys} config keys`);
  row('b', `${d.b.name}  ${d.b.moves.toLocaleString()} moves, ${d.b.configKeys} config keys`);

  for (const [side, info, parsed, st] of [['a', d.a, pa, sa], ['b', d.b, pb, sb]]) {
    eq(info.bytes, st.size, `${side}: bytes is the size on disk`);
    eq(info.moves, parsed.count, `${side}: move count matches a local parse`);
    eq(info.layers, parsed.layers.length, `${side}: layer records match`);
    eq(info.configKeys, Object.keys(parsed.config).length, `${side}: CONFIG_BLOCK key count matches`);
    eq(info.generator, parsed.meta.generator, `${side}: generator line`);
    ok(info.configKeys > 100, `${side}: the CONFIG_BLOCK really was read (${info.configKeys} keys)`);
  }

  section('settings diff');
  row('keys differing', `${d.settings.counts.changed} of ${d.settings.counts.a}`);
  for (const c of d.settings.changed) row(c.key, `${JSON.stringify(c.a)}  ->  ${JSON.stringify(c.b)}`);
  {
    // Recomputed here from the two parses, so the route is measured against the
    // files rather than against a number someone wrote down.
    const want = Object.keys(pa.config)
      .filter((k) => k in pb.config && pa.config[k] !== pb.config[k]).sort();
    eq(d.settings.counts.a, Object.keys(pa.config).length, 'counts.a is the whole block');
    eq(d.settings.counts.b, Object.keys(pb.config).length, 'counts.b is the whole block');
    eq(d.settings.changed.map((c) => c.key).join(','), want.join(','), 'exactly the keys whose values differ');
    eq(d.settings.counts.changed, want.length, 'counts.changed matches the list');
    ok(d.settings.changed.every((c) => c.a !== c.b), 'no key is reported as changed with equal values');
  }

  section('totals');
  row('time', d.totals.delta.timeText);
  row('filament', `${d.totals.a.filamentG} g -> ${d.totals.b.filamentG} g  (${d.totals.delta.filamentG >= 0 ? '+' : ''}${d.totals.delta.filamentG} g)`);
  row('layers', `${d.totals.a.layerCount} -> ${d.totals.b.layerCount}`);
  row('max Z', `${d.totals.a.maxZ} -> ${d.totals.b.maxZ}`);
  row('extruded path', `${(d.totals.a.extrudedPathMm / 1000).toFixed(2)} m -> ${(d.totals.b.extrudedPathMm / 1000).toFixed(2)} m`);
  for (const [side, tot, parsed] of [['a', d.totals.a, pa], ['b', d.totals.b, pb]]) {
    eq(tot.timeSec, parsed.meta.estimatedTimeSec, `${side}: print time from the file's own footer`);
    eq(tot.timeText, parsed.meta.estimatedTimeText, `${side}: and its text`);
    eq(tot.filamentG, parsed.meta.filamentUsedG, `${side}: weight`);
    eq(tot.filamentMm, parsed.meta.filamentUsedMm, `${side}: filament length`);
    eq(tot.layerCount, parsed.layers.length, `${side}: layer count`);
    eq(tot.maxZ, parsed.meta.maxZ, `${side}: max Z`);
    eq(tot.moves, parsed.count, `${side}: moves`);
    ok(tot.extrudedPathMm > 0 && tot.travelMm > 0, `${side}: extruded and travel length measured`);
  }
  let deltas = 0;
  for (const k of Object.keys(d.totals.a)) {
    if (typeof d.totals.a[k] !== 'number' || typeof d.totals.b[k] !== 'number') continue;
    deltas++;
    eq(d.totals.delta[k], r2(d.totals.b[k] - d.totals.a[k]), `delta.${k} is b - a`);
  }
  ok(deltas >= 8, `every numeric total carries a delta (${deltas})`);
  ok(d.totals.delta.timeText.includes(formatDuration(d.totals.a.timeSec))
    && d.totals.delta.timeText.includes(formatDuration(d.totals.b.timeSec)),
  'delta.timeText spells out both times: ' + d.totals.delta.timeText);

  section('per-feature time delta');
  for (const f of d.features.slice(0, 8)) {
    row(f.name, `${formatDuration(f.timeA).padStart(9)} -> ${formatDuration(f.timeB).padStart(9)}   ${f.dTime >= 0 ? '+' : ''}${formatDuration(Math.abs(f.dTime))}   ${(f.dLength / 1000).toFixed(2)} m`);
  }
  {
    // Every move belongs to exactly one bucket -- the features plus the
    // travel row -- so the buckets have to add back up to the file.
    const movesA = d.features.reduce((n, f) => n + f.movesA, 0);
    const movesB = d.features.reduce((n, f) => n + f.movesB, 0);
    eq(movesA, pa.count, 'the feature buckets account for every move in a');
    eq(movesB, pb.count, 'and every move in b');
    ok(d.features.some((f) => f.name === '(travel & retract)'), 'travel is reported too: it is where time hides');
    const timeA = d.features.reduce((t, f) => t + f.timeA, 0);
    ok(Math.abs(timeA - d.totals.a.timeSec) < 1, `the per-feature times add up to the total (${timeA.toFixed(1)}s vs ${d.totals.a.timeSec}s)`);
    ok(d.features.every((f) => (f.onlyIn === 'a') === (f.movesB === 0 && f.movesA > 0)), 'onlyIn "a" means no moves in b');
    ok(d.features.every((f) => (f.onlyIn === 'b') === (f.movesA === 0 && f.movesB > 0)), 'onlyIn "b" means no moves in a');
    ok(d.features.every((f) => f.dTime === r2(f.timeB - f.timeA)), 'each feature dTime is b - a');
    const sorted = d.features.every((f, i) => i === 0 || Math.abs(d.features[i - 1].dTime) >= Math.abs(f.dTime));
    ok(sorted, 'features are ordered by how much time moved');
  }

  section('per-layer time delta (top 6)');
  for (const L of d.layers.biggestTimeChanges.slice(0, 6)) {
    row('layer ' + L.index, `${L.timeA.toFixed(1)}s -> ${L.timeB.toFixed(1)}s   ${L.dTime >= 0 ? '+' : ''}${L.dTime.toFixed(1)}s`);
  }
  {
    const idxA = new Set(pa.layers.map((L) => L.index));
    const idxB = new Set(pb.layers.map((L) => L.index));
    const union = [...new Set([...idxA, ...idxB])].sort((x, y) => x - y);
    eq(d.layers.rows.length, union.length, 'every layer of either file is in the table');
    eq(d.layers.rows.map((x) => x.index).join(','), union.join(','), 'and they are in layer order');
    ok(d.layers.rows.every((x) => x.onlyIn === (idxA.has(x.index) && idxB.has(x.index) ? null : (idxA.has(x.index) ? 'a' : 'b'))),
      'a layer present on one side only is marked onlyIn');
    ok(d.layers.rows.every((x) => x.dTime == null || x.dTime === r2(x.timeB - x.timeA)), 'each row dTime is b - a');
    const byIndex = new Map(pa.layers.map((L) => [L.index, L]));
    ok(d.layers.rows.every((x) => !byIndex.has(x.index) || x.timeA === r2(byIndex.get(x.index).time)),
      'timeA is the layer time from the parse');
    ok(d.layers.rows.every((x) => !byIndex.has(x.index) || x.zA === r2(byIndex.get(x.index).z)), 'and zA its Z');

    const big = d.layers.biggestTimeChanges;
    ok(big.length <= 10, `biggestTimeChanges defaults to at most 10 (got ${big.length})`);
    ok(big.every((x, i) => i === 0 || Math.abs(big[i - 1].dTime) >= Math.abs(x.dTime)), 'biggest first');
    const rowsBy = new Map(d.layers.rows.map((x) => [x.index, x]));
    ok(big.every((x) => rowsBy.get(x.index) && rowsBy.get(x.index).dTime === x.dTime), 'and each entry is a row of the table');
    const top3 = await get(`/api/diff?a=${encodeURIComponent(A.path)}&b=${encodeURIComponent(B.path)}&topLayers=3`);
    eq(top3.layers.biggestTimeChanges.length, Math.min(3, big.length), 'topLayers= is honoured');
    eq(top3.layers.rows.length, d.layers.rows.length, 'and it does not shorten the full table');
  }

  section('the v3-slowtop -> v4-ironed pair (needs test/fixtures.local.js)');
  if (!fx || !fx.diffPair) {
    console.log('  skip  no test/fixtures.local.js (or no `diffPair` in it): the private print archive is not on this machine');
  } else {
    const P = fx.diffPair;
    const dp = await get(`/api/diff?a=${encodeURIComponent(P.a)}&b=${encodeURIComponent(P.b)}`);
    row('a', `${dp.a.name}  ${dp.a.moves.toLocaleString()} moves, ${dp.a.configKeys} config keys`);
    row('b', `${dp.b.name}  ${dp.b.moves.toLocaleString()} moves, ${dp.b.configKeys} config keys`);
    eq(dp.a.configKeys, dp.b.configKeys, 'same slicer version, so the same CONFIG_BLOCK size');
    row('keys differing', `${dp.settings.counts.changed} of ${dp.settings.counts.a}`);
    for (const c of dp.settings.changed) row(c.key, `${JSON.stringify(c.a)}  ->  ${JSON.stringify(c.b)}`);
    ok(dp.settings.counts.changed > 0, 'some settings differ');
    ok(dp.settings.counts.changed < 40, 'and it is a short, readable list, not the whole file');
    const keys = dp.settings.changed.map((c) => c.key);
    ok(keys.some((k) => k.startsWith(P.settingPrefix || 'ironing')),
      `the ${P.settingPrefix || 'ironing'} settings show up (this is the change between these two)`);

    row('time', dp.totals.delta.timeText);
    eq(dp.totals.a.timeText, P.aTimeText, 'a print time');
    eq(dp.totals.b.timeText, P.bTimeText, 'b print time');
    eq(Math.round(dp.totals.delta.timeSec), P.deltaTimeSec, `b is ${formatDuration(P.deltaTimeSec)} slower`);

    const f = dp.features.find((x) => x.name === (P.feature || 'Ironing'));
    ok(f, `${P.feature || 'Ironing'} appears as a feature`);
    eq(f.onlyIn, P.featureOnlyIn || 'b', 'and only on one side');
    row(P.feature || 'Ironing', `${f.movesB.toLocaleString()} moves, ${(f.lengthB / 1000).toFixed(2)} m, ${formatDuration(f.timeB)}`);
    ok(f.timeB > 60, 'it costs real time');

    for (const L of dp.layers.biggestTimeChanges.slice(0, 6)) {
      row('layer ' + L.index, `${L.timeA.toFixed(1)}s -> ${L.timeB.toFixed(1)}s   ${L.dTime >= 0 ? '+' : ''}${L.dTime.toFixed(1)}s`);
    }
    ok(dp.layers.rows.length >= (P.minLayerRows || 53), 'every layer is in the table');
    const biggest = dp.layers.biggestTimeChanges[0];
    ok(Math.abs(biggest.dTime) > 5, `the biggest single-layer change is ${biggest.dTime.toFixed(1)}s on layer ${biggest.index}`);
  }

  section('a diff across layer heights (needs test/fixtures.local.js)');
  if (!fx || !fx.diffRetune) {
    console.log('  skip  no test/fixtures.local.js (or no `diffRetune` in it): the private print archive is not on this machine');
  } else {
    const d2 = await get(`/api/diff?a=${encodeURIComponent(fx.diffRetune.a)}&b=${encodeURIComponent(fx.diffRetune.b)}`);
    row('layers', `${d2.totals.a.layerCount} -> ${d2.totals.b.layerCount}`);
    row('layer height', `${d2.totals.a.layerHeight} -> ${d2.totals.b.layerHeight}`);
    row('time', d2.totals.delta.timeText);
    row('settings differing', d2.settings.counts.changed);
    ok(d2.totals.a.layerHeight !== d2.totals.b.layerHeight, 'the two really are different layer heights');
    ok(d2.settings.counts.changed > 20, 'a real re-tune shows many changed settings');
    ok(d2.layers.rows.some((x) => x.onlyIn === 'a'), 'layers that exist only in the finer file are marked onlyIn: "a"');
  }

  section('errors');
  const same = await get(`/api/diff?a=${encodeURIComponent(B.path)}&b=${encodeURIComponent(B.path)}`);
  ok(!!same.error, 'diffing a file against itself is refused: ' + same.error);
  ok(!!(await get(`/api/diff?a=${encodeURIComponent(A.path)}`)).error, 'both a and b are required');
  eq(await code(`/api/diff?a=${encodeURIComponent(A.path)}&b=${encodeURIComponent('../../../Windows/win.ini')}`),
    403, 'a diff cannot reach outside the Archive tree');

  await stop();
});
