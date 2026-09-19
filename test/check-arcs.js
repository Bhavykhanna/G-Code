/**
 * G2/G3 arcs -- the parser draws them, and edits treat them as moves.
 *
 *   node test/check-arcs.js
 *
 * What it proves:
 *   - arcGeometry: centre and sweep for I/J and R forms, both directions,
 *     R < 0 (the long way round), full circles, and the "no centre" case
 *   - parseGcode: chords stay within ARC_TOLERANCE of the circle, the last
 *     chord lands exactly on the commanded end, E and Z are shared out, every
 *     chord keeps the arc's source line, the next move starts at the arc end
 *   - a real file: every G2/G3 line is drawn, and the extrusion total still
 *     matches what it was before arcs were drawn (the only arc is a wipe)
 *   - edits: scaleFlow on an arc line scales E ONCE, not once per chord;
 *     scaleSpeed rewrites F on it; the speed restore lands on the next line
 */
import { readFileSync, existsSync } from 'node:fs';
import { parseGcode, arcGeometry, ARC_TOLERANCE, KIND } from '../src/parser/parse.js';
import { LineDoc, applyOp, getParam } from '../server/api/edit.js';
import { demoFile } from './fixtures.js';

let fails = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) fails++;
  console.log('  ' + (cond ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(60) + detail);
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const TAU = 2 * Math.PI;

console.log('\n=== arcGeometry ===');
{
  // quarter circle, centre (0,0), from (1,0) to (0,1)
  let g = arcGeometry(1, 0, 0, 1, false, -1, 0, NaN);
  ok('G3 I/J quarter: centre (0,0)', near(g.ox, 0) && near(g.oy, 0));
  ok('G3 I/J quarter: sweep +90 deg', near(g.sweep, Math.PI / 2), g.sweep.toFixed(4));
  g = arcGeometry(1, 0, 0, 1, true, -1, 0, NaN);
  ok('G2 same points: sweep -270 deg', near(g.sweep, -1.5 * Math.PI), g.sweep.toFixed(4));

  g = arcGeometry(1, 0, 0, 1, false, NaN, NaN, 1);
  ok('G3 R+1: short way, centre (0,0)', near(g.ox, 0) && near(g.oy, 0) && near(g.sweep, Math.PI / 2),
    `(${g.ox.toFixed(3)}, ${g.oy.toFixed(3)}) ${g.sweep.toFixed(3)}`);
  g = arcGeometry(1, 0, 0, 1, true, NaN, NaN, 1);
  ok('G2 R+1: short way, centre (1,1)', near(g.ox, 1) && near(g.oy, 1) && near(g.sweep, -Math.PI / 2),
    `(${g.ox.toFixed(3)}, ${g.oy.toFixed(3)}) ${g.sweep.toFixed(3)}`);
  g = arcGeometry(1, 0, 0, 1, false, NaN, NaN, -1);
  ok('G3 R-1: long way, centre (1,1), sweep +270', near(g.ox, 1) && near(g.oy, 1) && near(g.sweep, 1.5 * Math.PI),
    `(${g.ox.toFixed(3)}, ${g.oy.toFixed(3)}) ${g.sweep.toFixed(3)}`);

  g = arcGeometry(5, 5, 5, 5, true, 2, 0, NaN);
  ok('G2 start = end with I/J: full circle, -360', near(g.sweep, -TAU) && near(g.r, 2));
  g = arcGeometry(5, 5, 5, 5, false, 0, -3, NaN);
  ok('G3 start = end with I/J: full circle, +360', near(g.sweep, TAU) && near(g.r, 3));

  ok('no I, J or R -> null', arcGeometry(0, 0, 1, 1, true, NaN, NaN, NaN) === null);
  ok('R too small for the chord -> null', arcGeometry(0, 0, 10, 0, true, NaN, NaN, 2) === null);
  ok('zero radius -> null', arcGeometry(0, 0, 1, 0, true, 0, 0, NaN) === null);
}

console.log('\n=== parseGcode with arcs ===');
{
  const text = [
    'M83',
    ';LAYER:1', ';Z:0.2', ';TYPE:Outer wall', ';WIDTH:0.45', ';HEIGHT:0.2',
    'G1 X110 Y100 Z0.2 F3000',
    'G3 X100 Y110 I-10 J0 E1.6 F1200',  // quarter, r = 10, ccw
    'G1 X90 Y110 E0.5',
    'G2 X90 Y110 I0 J-5 Z0.6 E3',       // full helical circle, r = 5, cw
    'G2 X1 Y1',                          // no centre -> straight, warned
  ].join('\n');
  const p = parseGcode(text);
  const s = p.segments;
  const on = (li) => [...Array(p.count).keys()].filter((i) => s.line[i] === li);

  ok('2 arcs drawn as arcs (the third has no centre)', p.arcCount === 2, 'arcCount ' + p.arcCount);
  ok('fallback arc is warned about', p.warnings.some((w) => /no usable centre/.test(w)), JSON.stringify(p.warnings));

  const q = on(7);
  ok('quarter arc -> several chords, all on line 7', q.length > 4, q.length + ' chords');
  let worst = 0;
  for (const i of q) {
    for (const t of [0, 0.5, 1]) {
      const x = s.x0[i] + (s.x1[i] - s.x0[i]) * t, y = s.y0[i] + (s.y1[i] - s.y0[i]) * t;
      worst = Math.max(worst, Math.abs(Math.hypot(x - 100, y - 100) - 10));
    }
  }
  ok(`chords within ${ARC_TOLERANCE} mm of the circle`, worst <= ARC_TOLERANCE + 1e-3, worst.toFixed(4) + ' mm');
  const lastQ = q[q.length - 1];
  ok('last chord ends exactly on X100 Y110', s.x1[lastQ] === 100 && s.y1[lastQ] === 110);
  ok('first chord starts at the previous position', s.x0[q[0]] === 110 && s.y0[q[0]] === 100);
  const eq = q.reduce((a, i) => a + s.e[i], 0);
  ok('E shared out: chords sum to 1.6', near(eq, 1.6, 1e-5), eq.toFixed(6));
  ok('all chords extrude, with the feature and width', q.every((i) => s.kind[i] === KIND.EXTRUDE && s.width[i] > 0.44));
  ok('arc length ~ quarter of 2*pi*10', near(q.reduce((a, i) => a + Math.hypot(s.x1[i] - s.x0[i], s.y1[i] - s.y0[i]), 0), Math.PI * 5, 0.05));
  ok('feedrate from the arc line (F1200 = 20 mm/s)', q.every((i) => near(s.speed[i], 20)));

  const nextLine = on(8);
  ok('next G1 starts at the arc end', s.x0[nextLine[0]] === 100 && s.y0[nextLine[0]] === 110);

  const c = on(9);
  const zs = c.map((i) => s.z1[i]);
  ok('helical circle: Z climbs 0.2 -> 0.6', near(zs[zs.length - 1], 0.6, 1e-6) && zs.every((z, k) => !k || z >= zs[k - 1]));
  ok('full circle closes on its start', near(s.x1[c[c.length - 1]], 90) && near(s.y1[c[c.length - 1]], 110));
  const minY = Math.min(...c.map((i) => s.y1[i]));
  ok('full circle reaches the far side (y ~ 100)', near(minY, 100, 0.05), minY.toFixed(3));

  const f = on(10);
  ok('no-centre arc drawn as one straight travel to X1 Y1', f.length === 1 && s.x1[f[0]] === 1 && s.kind[f[0]] === KIND.TRAVEL);
  ok('layer time counts the arcs', p.layers[0].time > 0);
}

console.log('\n=== edits on arc lines ===');
{
  const text = [
    'M83',
    ';LAYER:1', ';Z:0.2', ';TYPE:Outer wall', ';WIDTH:0.45', ';HEIGHT:0.2',
    'G1 X110 Y100 Z0.2 F3000',
    'G3 X100 Y110 I-10 J0 E1.6 F1200',
    'G1 X90 Y110 E0.5',
  ].join('\n');
  const parsed = parseGcode(text);

  let doc = new LineDoc(text, '\n');
  applyOp(doc, parsed, { op: 'scaleFlow', factor: 1.1, lineRanges: [[7, 7]] });
  const e = getParam(doc.body(7), 'E');
  ok('scaleFlow 1.1 on an arc: E 1.6 -> 1.76 (once, not per chord)', near(e, 1.76, 1e-4), doc.body(7));

  doc = new LineDoc(text, '\n');
  applyOp(doc, parsed, { op: 'scaleSpeed', factor: 0.5, lineRanges: [[7, 7]] });
  ok('scaleSpeed 0.5 on an arc: F1200 -> F600', getParam(doc.body(7), 'F') === 600, doc.body(7));
  ok('the arc keeps its I/J', /I-10 J0/.test(doc.body(7)));
  ok('previous feedrate restored on the next line, not on the arc', getParam(doc.body(8), 'F') === 1200, doc.body(8));

  doc = new LineDoc(text, '\n');
  applyOp(doc, parsed, { op: 'deleteRegion', lineRanges: [[7, 7]] });
  ok('deleteRegion removes the arc line', doc.isRemoved(7));
}

console.log('\n=== real file ===');
{
  const file = demoFile;
  if (!file || !existsSync(file)) {
    console.log('  skip  ' + file + ' not found');
  } else {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const arcLines = [];
    lines.forEach((l, i) => { if (/^G[23][ ;]/.test(l)) arcLines.push(i); });
    const p = parseGcode(text);
    const drawn = new Set();
    for (let i = 0; i < p.count; i++) if (/^G[23][ ;]/.test(lines[p.segments.line[i]])) drawn.add(p.segments.line[i]);
    ok('every G2/G3 line is drawn', arcLines.every((li) => drawn.has(li)), `${drawn.size} of ${arcLines.length}`);
    ok('no arc warnings', !p.warnings.some((w) => /arc/i.test(w)), JSON.stringify(p.warnings));
    let ext = 0;
    for (let i = 0; i < p.count; i++) if (p.segments.kind[i] === KIND.EXTRUDE) ext += p.segments.e[i];
    ok('extrusion total still matches the slicer footer (0.01 %)',
      Math.abs(ext - p.meta.filamentUsedMm) / p.meta.filamentUsedMm < 1e-4,
      `${ext.toFixed(2)} vs ${p.meta.filamentUsedMm}`);
  }
}

console.log(fails ? `\n  ${fails} CHECK(S) FAILED` : '\n  all checks passed');
process.exit(fails ? 1 : 0);
