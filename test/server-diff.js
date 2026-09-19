/**
 * server-diff.js -- A/B compare two real 16 Pro versions.
 *
 *   node test/server-diff.js
 *
 * v3-slowtop vs v4-ironed are the interesting pair: same layer height, same
 * geometry, one setting group changed. The settings diff should name exactly
 * the ironing settings, and the per-feature diff should show the Ironing
 * feature appearing out of nowhere.
 *
 * Reads only. Writes nothing.
 */
import './_isolate.js'; // must be first: keeps the tests out of the live bridge\ folder
import { start, stop } from '../server/index.js';
import { formatDuration } from '../src/parser/parse.js';
import { ok, eq, section, row, run, get, PORT } from './server-helpers.js';

const J = 'phonecase-16pro/';
const V3 = J + 'old/EN4Max_0.4_Iphone16Pro_HexCover_HSPLA+_0.20_v3-slowtop_50m.gcode';
const V4 = J + 'old/EN4Max_0.4_Iphone16Pro_HexCover_HSPLA+_0.20_v4-ironed_57m.gcode'; // archived: frozen
const V1 = J + 'old/EN4Max_0.4_Iphone16Pro_HexCover_HSPLA+_0.12_v1-honeycomb-nobrim_1h11m.gcode';

await run(async () => {
  await start(PORT, '127.0.0.1');

  section('v3-slowtop  ->  v4-ironed');
  const t0 = Date.now();
  const d = await get(`/api/diff?a=${encodeURIComponent(V3)}&b=${encodeURIComponent(V4)}`);
  row('diff time', (Date.now() - t0) + ' ms (both files parsed cold)');
  row('a', `${d.a.name}  ${d.a.moves.toLocaleString()} moves, ${d.a.configKeys} config keys`);
  row('b', `${d.b.name}  ${d.b.moves.toLocaleString()} moves, ${d.b.configKeys} config keys`);

  eq(d.a.configKeys, 624, 'v3 CONFIG_BLOCK has 624 keys');
  eq(d.b.configKeys, 624, 'v4 CONFIG_BLOCK has 624 keys');

  section('settings diff');
  row('keys differing', `${d.settings.counts.changed} of ${d.settings.counts.a}`);
  ok(d.settings.counts.changed > 0, 'some settings differ');
  ok(d.settings.counts.changed < 40, 'and it is a short, readable list, not the whole file');
  for (const c of d.settings.changed) {
    row(c.key, `${JSON.stringify(c.a)}  ->  ${JSON.stringify(c.b)}`);
  }
  const keys = d.settings.changed.map((c) => c.key);
  ok(keys.some((k) => k.startsWith('ironing')), 'the ironing settings show up (this is the v3->v4 change)');

  section('totals');
  row('time', d.totals.delta.timeText);
  row('filament', `${d.totals.a.filamentG} g -> ${d.totals.b.filamentG} g  (${d.totals.delta.filamentG >= 0 ? '+' : ''}${d.totals.delta.filamentG} g)`);
  row('layers', `${d.totals.a.layerCount} -> ${d.totals.b.layerCount}`);
  row('max Z', `${d.totals.a.maxZ} -> ${d.totals.b.maxZ}`);
  row('extruded path', `${(d.totals.a.extrudedPathMm / 1000).toFixed(2)} m -> ${(d.totals.b.extrudedPathMm / 1000).toFixed(2)} m`);
  eq(d.totals.a.timeText, '50m 4s', 'v3 print time');
  eq(d.totals.b.timeText, '57m 13s', 'v4 print time');
  eq(Math.round(d.totals.delta.timeSec), 429, 'v4 is 7m 9s slower');

  section('per-feature time delta');
  for (const f of d.features.slice(0, 8)) {
    row(f.name, `${formatDuration(f.timeA).padStart(9)} -> ${formatDuration(f.timeB).padStart(9)}   ${f.dTime >= 0 ? '+' : ''}${formatDuration(Math.abs(f.dTime))}   ${(f.dLength / 1000).toFixed(2)} m`);
  }
  const iron = d.features.find((f) => f.name === 'Ironing');
  ok(iron, 'Ironing appears as a feature');
  eq(iron.onlyIn, 'b', 'and only in v4');
  row('ironing', `${iron.movesB.toLocaleString()} moves, ${(iron.lengthB / 1000).toFixed(2)} m, ${formatDuration(iron.timeB)}`);
  ok(iron.timeB > 60, 'ironing costs real time');

  section('per-layer time delta (top 6)');
  for (const L of d.layers.biggestTimeChanges.slice(0, 6)) {
    row('layer ' + L.index, `${L.timeA.toFixed(1)}s -> ${L.timeB.toFixed(1)}s   ${L.dTime >= 0 ? '+' : ''}${L.dTime.toFixed(1)}s`);
  }
  ok(d.layers.rows.length >= 53, 'every layer is in the table');
  const biggest = d.layers.biggestTimeChanges[0];
  ok(Math.abs(biggest.dTime) > 5, `the biggest single-layer change is ${biggest.dTime.toFixed(1)}s on layer ${biggest.index}`);

  section('v1 (0.12 mm) -> v4 (0.20 mm) -- a diff across layer heights');
  const d2 = await get(`/api/diff?a=${encodeURIComponent(V1)}&b=${encodeURIComponent(V4)}`);
  row('layers', `${d2.totals.a.layerCount} -> ${d2.totals.b.layerCount}`);
  row('layer height', `${d2.totals.a.layerHeight} -> ${d2.totals.b.layerHeight}`);
  row('time', d2.totals.delta.timeText);
  row('settings differing', d2.settings.counts.changed);
  ok(d2.settings.counts.changed > 20, 'a real re-tune shows many changed settings');
  ok(d2.layers.rows.some((r) => r.onlyIn === 'a'), 'layers that exist only in the 0.12 mm file are marked onlyIn: "a"');

  section('errors');
  const same = await get(`/api/diff?a=${encodeURIComponent(V4)}&b=${encodeURIComponent(V4)}`);
  ok(!!same.error, 'diffing a file against itself is refused: ' + same.error);

  await stop();
});
