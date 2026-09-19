/**
 * Compare layer of the renderer -- the pure half (src/render/geometry.js).
 * Node only, no WebGL: the ghost look, the mode switches on the GPU and
 * captureView cannot be checked here.
 *
 *   node test/check-compare-render.js [current.gcode] [other.gcode]
 *
 * What it proves:
 *   - layerRangeByZ / zSpanOfLayers / layerZTable on synthetic tables:
 *     tolerance, empty layers, open ends, no match
 *   - fillSolidColor writes every vertex
 *   - on a real pair (a version vs the one before it): the Z mapping is sane
 *     for every single layer, and the cost of building the second mesh and
 *     of the colour/flag rewrites a mode switch does
 */
import { readFileSync, existsSync } from 'node:fs';
import { argv } from 'node:process';
import { parseGcode, KIND } from '../src/parser/parse.js';
import {
  countLayers, buildExtrudeArrays, fillExtrudeColors, computeValueRanges,
  fillSolidColor, layerZTable, zSpanOfLayers, layerRangeByZ,
} from '../src/render/geometry.js';
import { fx, arc } from './fixtures.js';

const curFile = argv[2] || (fx ? arc(fx.jobRel + fx.beforeCentre) : null);
const oldFile = argv[3] || (fx ? arc(fx.v1BaseRel) : null);

let fails = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) fails++;
  console.log('  ' + (cond ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(56) + detail);
};
const same = (a, b) => (a === null || b === null) ? a === b : a[0] === b[0] && a[1] === b[1];
const now = () => performance.now();

/* ------------------------------------------------------------ synthetic */

console.log('\n=== compare render: synthetic ===');
{
  const zs = Float64Array.from([NaN, 0.2, 0.4, 0.6, NaN, 0.8, 1.0]);
  ok('exact span', same(layerRangeByZ(zs, 0.4, 0.6), [2, 3]));
  ok('tolerance +-0.001 included', same(layerRangeByZ(zs, 0.4009, 0.5991), [2, 3]));
  ok('outside tolerance excluded', layerRangeByZ(zs, 0.4011, 0.5989) === null);
  ok('NaN layers never match', same(layerRangeByZ(zs, -Infinity, Infinity), [1, 6]));
  ok('no match -> null', layerRangeByZ(zs, 5, 6) === null);
  ok('single layer', same(layerRangeByZ(zs, 0.8, 0.8), [5, 5]));
  ok('custom eps', same(layerRangeByZ(zs, 0.45, 0.45, 0.06), [2, 2]));

  ok('span of middle layers', same(zSpanOfLayers(zs, 2, 3), [0.4, 0.6]));
  ok('span skips empty layers', same(zSpanOfLayers(zs, 4, 5), [0.8, 0.8]));
  ok('span of only-empty layers -> null', zSpanOfLayers(zs, 4, 4) === null);
  ok('first layer opens downwards', same(zSpanOfLayers(zs, 0, 2), [-Infinity, 0.4]));
  ok('last layer opens upwards', same(zSpanOfLayers(zs, 5, 6), [0.8, Infinity]));
  ok('full range = everything', same(zSpanOfLayers(zs, 0, 6), [-Infinity, Infinity]));

  // Stretched file: other has an extra layer on top and a different first Z.
  const other = Float64Array.from([0.25, 0.4, 0.6, 0.8, 1.0, 1.2]);
  const sp = zSpanOfLayers(zs, 6, 6);
  ok('top layer of current reaches taller other file', same(layerRangeByZ(other, sp[0], sp[1]), [4, 5]));
  ok('non-matching Z (0.2 vs 0.25) is not shown',
    layerRangeByZ(other, ...zSpanOfLayers(zs, 1, 1)) === null);

  // layerZTable: min nozzle Z of extrusions, travels ignored, empty = NaN.
  const seg = {
    kind: Uint8Array.from([KIND.TRAVEL, KIND.EXTRUDE, KIND.EXTRUDE, KIND.TRAVEL, KIND.EXTRUDE]),
    layer: Uint32Array.from([0, 1, 1, 2, 3]),
    z0: Float32Array.from([5, 0.4, 0.3, 0.6, 0.8]),
    z1: Float32Array.from([5, 0.4, 0.35, 0.6, 0.8]),
  };
  const t = layerZTable(seg, 5, 4);
  ok('layerZTable: travel-only layers are NaN', Number.isNaN(t[0]) && Number.isNaN(t[2]));
  ok('layerZTable: min extrusion Z', Math.abs(t[1] - 0.3) < 1e-6 && Math.abs(t[3] - 0.8) < 1e-6,
    `[${Array.from(t).map((v) => v.toFixed(2)).join(', ')}]`);

  const c = new Uint8Array(30).fill(7);
  fillSolidColor(c, [1, 2, 3]);
  ok('fillSolidColor writes every vertex', c.every((v, i) => v === (i % 3) + 1));
}

/* ------------------------------------------------------------ real pair */

if (!existsSync(curFile) || !existsSync(oldFile)) {
  console.log('\n(real-file part skipped: ' + (curFile && oldFile ? (existsSync(curFile) ? oldFile : curFile) + ' not found' : 'no test/fixtures.local.js') + ')');
} else {
  console.log('\n=== compare render: real pair ===');
  console.log('  current: ' + curFile);
  console.log('  other:   ' + oldFile);
  const cur = parseGcode(readFileSync(curFile, 'utf8'));
  const old = parseGcode(readFileSync(oldFile, 'utf8'));
  const cLC = countLayers(cur.segments, cur.count);
  const oLC = countLayers(old.segments, old.count);

  let t0 = now();
  const cEx = buildExtrudeArrays(cur.segments, cur.count, { layerCount: cLC });
  const curBuild = now() - t0;
  t0 = now();
  const oEx = buildExtrudeArrays(old.segments, old.count, { layerCount: oLC, quality: cEx.quality });
  const oZ = layerZTable(old.segments, old.count, oLC);
  const oldBuild = now() - t0;
  t0 = now();
  const cZ = layerZTable(cur.segments, cur.count, cLC);
  const zMs = now() - t0;
  console.log(`  moves ${cur.count} / ${old.count}, layers ${cLC} / ${oLC}, quality ${cEx.quality}`);
  console.log(`  build: current extrude ${curBuild.toFixed(1)} ms, other extrude + Z table ${oldBuild.toFixed(1)} ms, Z table ${zMs.toFixed(2)} ms`);

  // Every single current layer maps to other layers within tolerance.
  let bad = 0, empty = 0, mapped = 0;
  for (let l = 1; l < cLC - 1; l++) {
    const sp = zSpanOfLayers(cZ, l, l);
    if (!sp) { empty++; continue; }
    const r = layerRangeByZ(oZ, sp[0], sp[1]);
    if (!r) continue;
    mapped++;
    for (let k = r[0]; k <= r[1]; k++) {
      if (!Number.isNaN(oZ[k]) && Math.abs(oZ[k] - sp[0]) > 0.001) bad++;
    }
  }
  ok('single-layer mapping stays within 0.001 mm', bad === 0,
    `${mapped} of ${cLC - 2} inner layers matched, ${empty} empty, ${bad} off`);
  const full = zSpanOfLayers(cZ, 0, cLC - 1);
  ok('full current range shows the whole other file',
    same(layerRangeByZ(oZ, full[0], full[1]), [firstFinite(oZ), lastFinite(oZ)]));
  const half = zSpanOfLayers(cZ, 0, cLC >> 1);
  const hr = layerRangeByZ(oZ, half[0], half[1]);
  ok('lower half maps to a prefix of the other file', hr && hr[0] === firstFinite(oZ) && hr[1] < oLC - 1,
    hr ? `-> layers ${hr[0]}..${hr[1]}` : '');

  // Mode-switch cost: what setCompareMode rewrites.
  const oColor = new Uint8Array(oEx.vertexCount * 3);
  const oFlags = new Uint8Array(oEx.vertexCount);
  const ranges = computeValueRanges(cur);
  const ms = (fn, n = 5) => {
    const t = [];
    for (let k = 0; k < n; k++) { const a = now(); fn(); t.push(now() - a); }
    return Math.max(...t.slice(1));
  };
  const ghost = ms(() => fillSolidColor(oColor, [210, 91, 255]));
  const oldColors = ms(() => fillExtrudeColors(oColor, old, oEx.segOf, 'speed', ranges.speed, oEx.vertsPerSeg));
  const oldClass = new Uint8Array(old.count);
  for (let i = 0; i < old.count; i += 3) oldClass[i] = 2;
  const vis = new Set([1, 2, 4]);
  const flags = ms(() => {
    let v = 0;
    for (let s = 0; s < oEx.segOf.length; s++) {
      const i = oEx.segOf[s];
      const b = (oldClass[i] !== 2 || !vis.has(old.segments.feature[i])) ? 1 : 0;
      for (let j = 0; j < oEx.vertsPerSeg; j++) oFlags[v++] = b;
    }
  });
  const curColors = ms(() => fillExtrudeColors(new Uint8Array(cEx.vertexCount * 3), cur, cEx.segOf, 'feature', ranges.feature, cEx.vertsPerSeg));
  const worst = ghost + oldColors + flags + curColors;
  console.log(`  worst of 4: ghost fill ${ghost.toFixed(2)} ms, other recolour ${oldColors.toFixed(2)} ms, ` +
    `other flags ${flags.toFixed(2)} ms, current recolour ${curColors.toFixed(2)} ms`);
  ok('a mode switch rewrites well under 100 ms', worst < 50, `${worst.toFixed(1)} ms CPU (upload not included)`);
}

function firstFinite(a) { for (let i = 0; i < a.length; i++) if (!Number.isNaN(a[i])) return i; return -1; }
function lastFinite(a) { for (let i = a.length - 1; i >= 0; i--) if (!Number.isNaN(a[i])) return i; return -1; }

console.log(fails ? `\n${fails} FAILED` : '\nall ok');
process.exit(fails ? 1 : 0);
