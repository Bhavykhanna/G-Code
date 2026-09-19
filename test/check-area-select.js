/**
 * Area select -- the pure projection/inside test in src/render/area.js.
 * Node only, no WebGL: the GPU half of the feature (rubber band, captureView)
 * cannot be checked here.
 *
 *   node test/check-area-select.js [path-to.gcode]
 *
 * What it proves:
 *   - exact count on a synthetic grid under an orthographic top view
 *   - feature filter and slot (layer) range are honoured
 *   - agrees with THREE's own Vector3.project on random points under a
 *     perspective camera, including points behind the camera and past far
 *   - the real 92k-move file: agrees with THREE, and the timing
 */
import { readFileSync } from 'node:fs';
import { argv } from 'node:process';
import * as THREE from 'three';
import { parseGcode } from '../src/parser/parse.js';
import { countLayers, buildExtrudeArrays } from '../src/render/geometry.js';
import { selectInRect, viewProjection, normRect } from '../src/render/area.js';

const file = argv[2] ||
  '../phonecase-17pro/old/EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v1-ironed_49m.gcode';

let fails = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) fails++;
  console.log('  ' + (cond ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(52) + detail);
};

function vpOf(cam) {
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  return viewProjection(cam.projectionMatrix.elements, cam.matrixWorldInverse.elements);
}

/** Reference answer with THREE objects, one segment at a time. */
function reference(seg, segOf, s0, s1, features, cam, rect, W, H) {
  const out = [];
  const v = new THREE.Vector4();
  const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  for (let k = s0; k < s1; k++) {
    const i = segOf[k];
    if (features && !features.has(seg.feature[i])) continue;
    v.set((seg.x0[i] + seg.x1[i]) / 2, (seg.y0[i] + seg.y1[i]) / 2, (seg.z0[i] + seg.z1[i]) / 2, 1)
      .applyMatrix4(m);
    if (!(v.w > 0)) continue;
    const nx = v.x / v.w, ny = v.y / v.w, nz = v.z / v.w;
    if (nz < -1 || nz > 1) continue;
    const sx = (nx + 1) / 2 * W, sy = (1 - ny) / 2 * H;
    if (sx >= rect.x0 && sx <= rect.x1 && sy >= rect.y0 && sy <= rect.y1) out.push(i);
  }
  return out;
}

const sameList = (a, b) => a.length === b.length && a.every((x, k) => x === b[k]);

/* ------------------------------------------------------------ synthetic */

console.log('\n=== area select: synthetic ===');
{
  // 20 x 15 grid of 4 mm moves along +X; midpoints at (5..195, 5..145, 0.2).
  const N = 300;
  const seg = {
    x0: new Float32Array(N), y0: new Float32Array(N), z0: new Float32Array(N),
    x1: new Float32Array(N), y1: new Float32Array(N), z1: new Float32Array(N),
    feature: new Uint8Array(N),
  };
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 20; c++) {
      const i = r * 20 + c;
      seg.x0[i] = c * 10 + 3; seg.x1[i] = c * 10 + 7;
      seg.y0[i] = seg.y1[i] = r * 10 + 5;
      seg.z0[i] = seg.z1[i] = 0.2;
      seg.feature[i] = c % 2 ? 2 : 1;
    }
  }
  const segOf = Uint32Array.from({ length: N }, (_, k) => k);
  const W = 800, H = 600;
  // Top view, 4 px per mm, world (0,0) at the bottom-left of the canvas.
  const cam = new THREE.OrthographicCamera(0, 200, 150, 0, 1, 1000);
  cam.position.set(0, 0, 100);
  cam.lookAt(0, 0, 0);
  const vp = vpOf(cam);
  const base = { seg, segOf, slotStart: 0, slotEnd: N, features: null, viewProj: vp, width: W, height: H };

  // Screen x 0..400 = world x 0..100 -> 10 columns.
  // Screen y 0..290 = world y 150..77.5 -> rows at y 85..145 -> 7 rows.
  let r = selectInRect({ ...base, rect: normRect(400, 290, 0, 0) });
  ok('grid: 10 cols x 7 rows = 70', r.indices.length === 70, 'got ' + r.indices.length);
  ok('grid: bounds are endpoint bbox',
    r.bounds && r.bounds.min[0] === 3 && r.bounds.max[0] === 97 &&
    r.bounds.min[1] === 85 && r.bounds.max[1] === 145 && r.bounds.min[2] === Math.fround(0.2),
    JSON.stringify(r.bounds));
  ok('grid: indices ascending', r.indices.every((v, k, a) => !k || a[k - 1] < v));

  r = selectInRect({ ...base, rect: normRect(0, 0, 400, 290), features: new Set([2]) });
  ok('grid: feature filter halves it (35)', r.indices.length === 35, 'got ' + r.indices.length);

  r = selectInRect({ ...base, rect: normRect(0, 0, 800, 600), slotStart: 20, slotEnd: 60 });
  ok('grid: slot range 20..60 = 40', r.indices.length === 40 && r.indices[0] === 20, 'got ' + r.indices.length);

  r = selectInRect({ ...base, rect: normRect(1, 1, 2, 2) });
  ok('grid: empty rect -> no indices, bounds null', r.indices.length === 0 && r.bounds === null);

  // Camera below the plate looking down: everything is behind it.
  const under = new THREE.OrthographicCamera(0, 200, 150, 0, 1, 1000);
  under.position.set(0, 0, -50);
  under.lookAt(0, 0, -100);
  r = selectInRect({ ...base, viewProj: vpOf(under), rect: normRect(0, 0, 800, 600) });
  ok('grid: all behind the camera -> 0', r.indices.length === 0, 'got ' + r.indices.length);

  // Match modes, on the case from the user's screenshot: a long skirt-like
  // line that crosses the rectangle, with its midpoint inside it.
  {
    const L = {
      x0: Float32Array.of(-50, 20, 70, 150), x1: Float32Array.of(250, 30, 170, 190),
      y0: Float32Array.of(100, 100, 100, 100), y1: Float32Array.of(100, 100, 100, 100),
      z0: new Float32Array(4).fill(0.2), z1: new Float32Array(4).fill(0.2),
      feature: Uint8Array.of(12, 2, 2, 2),   // 12 = Skirt
    };
    // rect = world x 0..100, y 75..125
    const lb = { ...base, seg: L, segOf: Uint32Array.of(0, 1, 2, 3), slotEnd: 4, rect: normRect(0, 100, 400, 300) };
    const ids = (o) => Array.from(selectInRect({ ...lb, ...o }).indices).join(',');
    ok("match 'inside' (default): only the short move", ids({}) === '1', ids({}));
    ok("match 'center': the long line too (the bug)", ids({ match: 'center' }) === '0,1', ids({ match: 'center' }));
    ok("match 'touch': anything crossing", ids({ match: 'touch' }) === '0,1,2', ids({ match: 'touch' }));
    ok('exclude drops the skirt even when touching', ids({ match: 'touch', exclude: new Set([12]) }) === '1,2',
      ids({ match: 'touch', exclude: new Set([12]) }));
    // Crossing moves that are not taken come back as `partial` (drawn clipped).
    const part = (o) => Array.from(selectInRect({ ...lb, ...o }).partial).join(',');
    ok("partial 'inside': the two crossing lines", part({}) === '0,2', part({}));
    ok("partial 'center': only the one whose middle is out", part({ match: 'center' }) === '2', part({ match: 'center' }));
    ok("partial 'touch': none", part({ match: 'touch' }) === '', part({ match: 'touch' }));
    ok('partial honours exclude', part({ exclude: new Set([12]) }) === '2', part({ exclude: new Set([12]) }));
    const nd = selectInRect(lb).ndc;
    ok('ndc rect is x0,y0,x1,y1 in NDC', nd[0] < nd[2] && nd[1] < nd[3] && nd.every((v) => v >= -1 && v <= 1),
      nd.map((v) => v.toFixed(2)).join(','));
  }

  // Perspective, random points around and behind the camera, vs THREE.
  const M = 20000;
  const rs = {
    x0: new Float32Array(M), y0: new Float32Array(M), z0: new Float32Array(M),
    x1: new Float32Array(M), y1: new Float32Array(M), z1: new Float32Array(M),
    feature: new Uint8Array(M),
  };
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < M; i++) {
    const x = rnd() * 600 - 300, y = rnd() * 600 - 300, z = rnd() * 600 - 300;
    rs.x0[i] = x - 1; rs.x1[i] = x + 1; rs.y0[i] = y; rs.y1[i] = y; rs.z0[i] = z; rs.z1[i] = z;
    rs.feature[i] = i % 5;
  }
  const pc = new THREE.PerspectiveCamera(42, W / H, 5, 250);
  pc.up.set(0, 0, 1);
  pc.position.set(40, -60, 30);
  pc.lookAt(0, 0, 0);
  vpOf(pc);
  const pOf = Uint32Array.from({ length: M }, (_, k) => k);
  const rect = normRect(120, 80, 610, 470);
  const feats = new Set([0, 2, 3]);
  const got = selectInRect({
    seg: rs, segOf: pOf, slotStart: 0, slotEnd: M, features: feats, match: 'center',
    viewProj: vpOf(pc), rect, width: W, height: H,
  });
  const want = reference(rs, pOf, 0, M, feats, pc, rect, W, H);
  ok('perspective: matches THREE Vector4 reference', sameList(Array.from(got.indices), want),
    got.indices.length + ' vs ' + want.length);
  ok('perspective: non-trivial (some in, some out)', want.length > 50 && want.length < M / 2);
}

/* ------------------------------------------------------------ real file */

let text = null;
try { text = readFileSync(file, 'utf8'); } catch { /* optional */ }
if (!text) {
  console.log('\n  (real file not found, skipped: ' + file + ')');
} else {
  console.log('\n=== area select: ' + file.split(/[\\/]/).pop() + ' ===');
  const parse = parseGcode(text);
  const seg = parse.segments;
  const layerCount = countLayers(seg, parse.count);
  const ex = buildExtrudeArrays(seg, parse.count, { layerCount, quality: 'high' });
  const W = 1600, H = 900;

  // Iso camera framing the model, the way the viewer would.
  const b = ex.bounds;
  const c = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
  const cam = new THREE.PerspectiveCamera(42, W / H, 1, 5000);
  cam.up.set(0, 0, 1);
  cam.position.set(c.x + 150, c.y - 150, c.z + 140);
  cam.lookAt(c);
  cam.near = 0.8; cam.far = 5000;
  const vp = vpOf(cam);
  const s0 = ex.layerSlotStart[0], s1 = ex.layerSlotEnd[layerCount - 1];

  const full = normRect(0, 0, W, H);
  // The reference is a midpoint test, so compare in 'center' mode; the
  // default 'inside' mode is timed separately below.
  const args = { seg, segOf: ex.segOf, slotStart: s0, slotEnd: s1, features: null, viewProj: vp, width: W, height: H, match: 'center' };
  // Warm up, then take the median of 30 runs, recomputing the matrix each
  // time as the viewer does.
  for (let k = 0; k < 10; k++) selectInRect({ ...args, rect: full });
  const times = [];
  let res = null;
  for (let k = 0; k < 30; k++) {
    const t = performance.now();
    const m = vpOf(cam);
    res = selectInRect({ ...args, viewProj: m, rect: full });
    times.push(performance.now() - t);
  }
  times.sort((a, b2) => a - b2);
  const med = times[15], worst = times[29];
  console.log('  extrude slots                 ' + ex.segOf.length.toLocaleString() +
    ' of ' + parse.count.toLocaleString() + ' moves');
  console.log('  full-canvas select            ' + res.indices.length.toLocaleString() + ' segments');
  console.log('  time median / worst           ' + med.toFixed(2) + ' ms / ' + worst.toFixed(2) + ' ms');
  ok('real: full canvas selects every extrusion in view', res.indices.length === ex.segOf.length,
    res.indices.length + ' / ' + ex.segOf.length);
  ok('real: median under 15 ms', med < 15, med.toFixed(2) + ' ms');
  for (const mode of ['inside', 'touch']) {
    const tt = [];
    let rr = null;
    for (let k = 0; k < 20; k++) {
      const t = performance.now();
      rr = selectInRect({ ...args, match: mode, viewProj: vpOf(cam), rect: full });
      tt.push(performance.now() - t);
    }
    tt.sort((a, b2) => a - b2);
    ok(`real: '${mode}' median under 15 ms`, tt[10] < 15, tt[10].toFixed(2) + ' ms, ' + rr.indices.length + ' moves');
  }

  const part = normRect(500, 250, 1100, 650);
  const feats = new Set([1, 2, 5]);
  const layers = [10, 40];
  const ps0 = ex.layerSlotStart[layers[0]], ps1 = ex.layerSlotEnd[layers[1]];
  const got = selectInRect({ ...args, slotStart: ps0, slotEnd: ps1, features: feats, rect: part });
  const want = reference(seg, ex.segOf, ps0, ps1, feats, cam, part, W, H);
  ok('real: partial rect + layers + features == THREE', sameList(Array.from(got.indices), want),
    got.indices.length + ' vs ' + want.length);
  ok('real: partial selection non-empty', want.length > 0);
  let inLayer = true;
  for (const i of got.indices) if (seg.layer[i] < layers[0] || seg.layer[i] > layers[1]) inLayer = false;
  ok('real: every index inside layer range', inLayer);
}

console.log('\n' + (fails ? '  ' + fails + ' CHECK(S) FAILED' : '  all checks passed') + '\n');
process.exitCode = fails ? 1 : 0;
