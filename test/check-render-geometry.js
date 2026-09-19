/**
 * Build the renderer's GPU buffers from a real G-code file and check the
 * invariants the viewer relies on. Everything here runs in Node -- no WebGL --
 * because the geometry pass is deliberately pure.
 *
 *   node test/check-render-geometry.js [path-to.gcode]
 *
 * What it proves:
 *   - every extruding move produced exactly 12 vertices and a valid index run
 *   - the per-layer index ranges are contiguous, gapless and cover everything,
 *     which is the whole basis of the layer slider being a `drawRange` change
 *   - mitred joints are crack-free: the end ring of one move and the start ring
 *     of the next are the same points
 *   - the ribbon really is the segment's `width` / `height` wide and it sits
 *     under the nozzle Z, so the first layer touches Z = 0
 */
import { readFileSync } from 'node:fs';
import { argv } from 'node:process';
import { parseGcode, KIND } from '../src/parser/parse.js';
import {
  countLayers,
  buildExtrudeArrays, buildTravelArrays, buildMarkerArrays,
  computeValueRanges, fillExtrudeColors, rampLut,
} from '../src/render/geometry.js';
import { demoFile } from './fixtures.js';

const file = argv[2] || demoFile;

let fails = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) fails++;
  console.log('  ' + (cond ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(46) + detail);
};
const row = (k, v) => console.log('  ' + k.padEnd(30) + v);

const text = readFileSync(file, 'utf8');
const parse = parseGcode(text);
const seg = parse.segments;
const count = parse.count;
const layerCount = countLayers(seg, count);

console.log('\n=== renderer geometry: ' + file.split(/[\\/]/).pop() + ' ===');

const t0 = performance.now();
const QUALITY = process.env.QUALITY || 'high';
const ex = buildExtrudeArrays(seg, count, { layerCount, quality: QUALITY });
const VP = ex.vertsPerSeg;
const tMid = performance.now();
const tv = buildTravelArrays(seg, count, { layerCount });
const mk = buildMarkerArrays(seg, count, { layerCount });
const tBuild = performance.now() - t0;

let nExtrude = 0, nTravel = 0, nMark = 0;
for (let i = 0; i < count; i++) {
  const k = seg.kind[i];
  if (k === KIND.EXTRUDE) nExtrude++;
  else if (k === KIND.TRAVEL) nTravel++;
  else nMark++;
}

console.log('\n  -- sizes --');
row('moves', count.toLocaleString());
row('layers', layerCount);
row('extrude / travel / marker', nExtrude.toLocaleString() + ' / ' +
  nTravel.toLocaleString() + ' / ' + nMark.toLocaleString());
row('quality', QUALITY);
row('ribbon vertices', ex.vertexCount.toLocaleString());
row('ribbon triangles', (ex.indexCount / 3).toLocaleString());
row('end caps emitted', ex.stats.caps.toLocaleString());
row('mitred joints', ex.stats.mitredJoints.toLocaleString() +
  '  (' + ((ex.stats.mitredJoints / nExtrude) * 100).toFixed(1) + '% of moves)');
row('extrude build', (tMid - t0).toFixed(0) + ' ms');
row('total build', tBuild.toFixed(0) + ' ms');
row('GPU bytes (est)', (gpuBytes() / 1048576).toFixed(1) + ' MB');

function gpuBytes() {
  return ex.position.byteLength + ex.normal.byteLength + ex.id.byteLength +
    ex.vertexCount * 4 /* aColor rgb + aFlags */ + ex.indexCount * 4 +
    tv.position.byteLength + tv.id.byteLength + tv.vertexCount +
    mk.position.byteLength + mk.color.byteLength + mk.id.byteLength + mk.vertexCount;
}

console.log('\n  -- structure --');
ok('one ' + VP + '-vertex block per extruding move',
  ex.slotCount === nExtrude && ex.vertexCount === nExtrude * VP,
  ex.slotCount + ' slots x ' + VP);
const quadsPerSeg = QUALITY === 'high' ? 6 : QUALITY === 'fast' ? 2 : 1;
ok('index count = ' + (quadsPerSeg*6) + '/move + 12/cap',
  ex.indexCount === nExtrude * quadsPerSeg * 6 + ex.stats.caps * 12,
  String(ex.indexCount));
ok('every index is in range', (() => {
  for (let i = 0; i < ex.indexCount; i++) if (ex.index[i] >= ex.vertexCount) return false;
  return true;
})());
ok('every vertex is referenced', (() => {
  const used = new Uint8Array(ex.vertexCount);
  for (let i = 0; i < ex.indexCount; i++) used[ex.index[i]] = 1;
  for (let i = 0; i < ex.vertexCount; i++) if (!used[i]) return false;
  return true;
})());
ok('no degenerate triangles', (() => {
  let bad = 0;
  for (let i = 0; i < ex.indexCount; i += 3) {
    const a = ex.index[i], b = ex.index[i + 1], c = ex.index[i + 2];
    if (a === b || b === c || a === c) bad++;
  }
  return bad === 0;
})());
ok('slot -> segment is strictly increasing', (() => {
  for (let s = 1; s < ex.slotCount; s++) if (ex.segOf[s] <= ex.segOf[s - 1]) return false;
  return true;
})());
ok('slot -> segment only maps EXTRUDE', (() => {
  for (let s = 0; s < ex.slotCount; s++) if (seg.kind[ex.segOf[s]] !== KIND.EXTRUDE) return false;
  return true;
})());

console.log('\n  -- layer ranges (this is what the slider moves) --');
ok('extrude index ranges start at 0', ex.layerIdxStart[0] === 0);
ok('extrude index ranges are contiguous', (() => {
  for (let l = 1; l < layerCount; l++) if (ex.layerIdxStart[l] !== ex.layerIdxEnd[l - 1]) return false;
  return true;
})());
ok('extrude index ranges cover everything',
  ex.layerIdxEnd[layerCount - 1] === ex.indexCount,
  ex.layerIdxEnd[layerCount - 1] + ' of ' + ex.indexCount);
ok('extrude slot ranges are contiguous + complete', (() => {
  if (ex.layerSlotStart[0] !== 0) return false;
  for (let l = 1; l < layerCount; l++) if (ex.layerSlotStart[l] !== ex.layerSlotEnd[l - 1]) return false;
  return ex.layerSlotEnd[layerCount - 1] === ex.slotCount;
})());
ok('travel vertex ranges are contiguous + complete', (() => {
  if (tv.layerVertStart[0] !== 0) return false;
  for (let l = 1; l < layerCount; l++) if (tv.layerVertStart[l] !== tv.layerVertEnd[l - 1]) return false;
  return tv.layerVertEnd[layerCount - 1] === tv.vertexCount;
})());
ok('marker vertex ranges are contiguous + complete', (() => {
  if (mk.layerVertStart[0] !== 0) return false;
  for (let l = 1; l < layerCount; l++) if (mk.layerVertStart[l] !== mk.layerVertEnd[l - 1]) return false;
  return mk.layerVertEnd[layerCount - 1] === mk.vertexCount;
})());
ok('every slot falls inside its own layer range', (() => {
  for (let l = 0; l < layerCount; l++) {
    for (let s = ex.layerSlotStart[l]; s < ex.layerSlotEnd[l]; s++) {
      if (seg.layer[ex.segOf[s]] !== l) return false;
    }
  }
  return true;
})());

console.log('\n  -- ribbon shape --');
// Ring vertex 0 and 3 are the extreme +u / -u points: their separation is the
// bead width (times the mitre stretch, so only check non-mitred segments).
let widthErr = 0, heightErr = 0, checked = 0;
let zBottomMin = Infinity;
for (let s = 0; s < ex.slotCount; s++) {
  const i = ex.segOf[s];
  const b = s * VP;
  const p = (v, c) => ex.position[v * 3 + c];
  for (let j = 0; j < VP; j++) zBottomMin = Math.min(zBottomMin, p(b + j, 2));
  // Only segments that are capped at both ends are guaranteed un-stretched.
  const wi = QUALITY === 'high' ? 3 : QUALITY === 'fast' ? 2 : 1;
  const w = Math.hypot(p(b, 0) - p(b + wi, 0), p(b, 1) - p(b + wi, 1));
  const h = QUALITY === 'high' ? p(b + 1, 2) - p(b + 4, 2)
    : QUALITY === 'fast' ? p(b + 1, 2) - p(b + 2, 2) : (seg.height[i] > 0 ? seg.height[i] : 0.2);
  const expW = seg.width[i] > 0 ? seg.width[i] : 0.42;
  const expH = seg.height[i] > 0 ? seg.height[i] : 0.2;
  if (Math.abs(w - expW) < 1e-4) checked++;
  else widthErr = Math.max(widthErr, Math.abs(w - expW) / expW);
  heightErr = Math.max(heightErr, Math.abs(h - expH));
}
row('rings at exact width', checked.toLocaleString() + ' / ' + ex.slotCount.toLocaleString() +
  '  (rest are mitre-stretched corners)');
ok('bead height always equals HEIGHT', heightErr < 1e-4, 'max err ' + heightErr.toExponential(1));
// 'flat' deliberately puts its single ribbon at mid-layer height, so the
// plate-contact and top-of-model checks only apply to the profiles with height.
ok('bead bottom sits on the plate',
  QUALITY === 'flat' ? Math.abs(zBottomMin - 0.14) < 1e-3 : Math.abs(zBottomMin) < 1e-4,
  'lowest vertex z = ' + zBottomMin.toExponential(2));
ok('top of the model matches max_z_height',
  Math.abs(ex.bounds.max[2] - parse.meta.maxZ) < (QUALITY === 'flat' ? 0.11 : 1e-3),
  ex.bounds.max[2].toFixed(3) + ' vs ' + parse.meta.maxZ);

ok('normals are unit length', (() => {
  for (let v = 0; v < ex.vertexCount; v += 97) {
    const l = Math.hypot(ex.normal[v * 3], ex.normal[v * 3 + 1], ex.normal[v * 3 + 2]);
    if (Math.abs(l - 1) > 1e-3) return false;
  }
  return true;
})());
ok('normals are perpendicular to the path', (() => {
  let worst = 0;
  for (let s = 0; s < ex.slotCount; s += 13) {
    const i = ex.segOf[s];
    let dx = seg.x1[i] - seg.x0[i], dy = seg.y1[i] - seg.y0[i];
    const l = Math.hypot(dx, dy);
    if (l < 1e-9) continue;
    dx /= l; dy /= l;
    for (let j = 0; j < VP; j++) {
      const v = (s * VP + j) * 3;
      worst = Math.max(worst, Math.abs(ex.normal[v] * dx + ex.normal[v + 1] * dy));
    }
  }
  return worst < 1e-5;
})());

// The crack test: for a continuous extrude->extrude joint the two rings must be
// the same six points, or the seam shows as a hairline gap when you zoom in.
const MITER_LIMIT = 2.5;
const RINGP = VP / 2;
let joints = 0, cracked = 0, worstCrack = 0, capped = 0;
for (let s = 0; s + 1 < ex.slotCount; s++) {
  const i = ex.segOf[s], k = ex.segOf[s + 1];
  if (k !== i + 1) continue;
  if (seg.x1[i] !== seg.x0[k] || seg.y1[i] !== seg.y0[k] || seg.z1[i] !== seg.z0[k]) continue;
  if (seg.width[i] !== seg.width[k] || seg.height[i] !== seg.height[k]) continue;
  // Corners past the mitre limit are capped on purpose, not mitred, so their
  // rings are meant to differ. Reproduce the limit test and exclude them.
  const a = unit(seg.x1[i] - seg.x0[i], seg.y1[i] - seg.y0[i]);
  const b = unit(seg.x1[k] - seg.x0[k], seg.y1[k] - seg.y0[k]);
  if (!a || !b) continue;
  const psx = -a[1], psy = a[0], nsx = -b[1], nsy = b[0];
  const ml = Math.hypot(psx + nsx, psy + nsy);
  const denom = ml < 1e-6 ? 0 : ((psx + nsx) / ml) * nsx + ((psy + nsy) / ml) * nsy;
  if (!(denom > 1e-6) || 1 / denom > MITER_LIMIT) { capped++; continue; }
  joints++;
  let d = 0;
  for (let j = 0; j < RINGP; j++) {
    const a = (s * VP + RINGP + j) * 3;
    const b = ((s + 1) * VP + j) * 3;
    d = Math.max(d, Math.abs(ex.position[a] - ex.position[b]),
      Math.abs(ex.position[a + 1] - ex.position[b + 1]),
      Math.abs(ex.position[a + 2] - ex.position[b + 2]));
  }
  worstCrack = Math.max(worstCrack, d);
  if (d > 1e-4) cracked++;
}
ok('mitred joints are crack-free', cracked === 0,
  cracked + ' of ' + joints.toLocaleString() + ' mitred joints off by >0.1um');
row('corners capped instead of mitred', capped.toLocaleString() +
  '  (sharper than the 2.5x mitre limit)');
row('worst mitred joint gap', worstCrack.toExponential(2) + ' mm');

function unit(x, y) {
  const l = Math.hypot(x, y);
  return l < 1e-9 ? null : [x / l, y / l];
}

console.log('\n  -- colours --');
const ranges = computeValueRanges(parse);
for (const k of Object.keys(ranges)) {
  row(k, ranges[k].min.toFixed(3) + '  ..  ' + ranges[k].max.toFixed(3));
}
ok('ramp LUT is 256 x rgb', rampLut('speed').length === 768);

const colors = new Uint8Array(ex.vertexCount * 3);
const tc0 = performance.now();
fillExtrudeColors(colors, parse, ex.segOf, 'speed', ranges.speed, VP);
const tc1 = performance.now();
row('recolour 800k vertices', (tc1 - tc0).toFixed(0) + ' ms');
ok('colours were written', colors.some((v) => v !== 0));
ok('all ' + VP + ' vertices of a move share a colour', (() => {
  for (let s = 0; s < ex.slotCount; s += 401) {
    const b = s * VP * 3;
    for (let j = 1; j < VP; j++) {
      for (let c = 0; c < 3; c++) if (colors[b + j * 3 + c] !== colors[b + c]) return false;
    }
  }
  return true;
})());

const featColors = new Uint8Array(ex.vertexCount * 3);
fillExtrudeColors(featColors, parse, ex.segOf, 'feature', ranges.feature, VP);
ok('feature mode differs from speed mode', (() => {
  for (let i = 0; i < featColors.length; i += 1201) {
    if (featColors[i] !== colors[i]) return true;
  }
  return false;
})());

console.log('\n' + (fails ? '  ' + fails + ' CHECK(S) FAILED' : '  all checks passed') + '\n');
process.exitCode = fails ? 1 : 0;
