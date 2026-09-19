/**
 * geometry.js -- parse output (struct-of-arrays) -> GPU buffers.
 *
 * Three kinds of move get three kinds of geometry, because they want three
 * different things from the GPU:
 *
 *   EXTRUDE          -> an indexed triangle mesh: a real extruded ribbon with
 *                       the segment's true `width` and `height`, mitred into
 *                       its neighbours so a continuous path has no seams.
 *   TRAVEL           -> LineSegments, 2 vertices per move, thin and translucent.
 *   RETRACT / PRIME  -> Points, 1 vertex per move, drawn as a round dot.
 *
 * Everything is built ONCE. After that:
 *   - the layer slider only changes `drawRange` (indices are laid out in
 *     segment order and segment order is monotonic in layer, so a layer range
 *     is always one contiguous index range),
 *   - the view mode only rewrites the colour attribute,
 *   - feature toggles and selection only rewrite a 1-byte flags attribute.
 *
 * Nothing in the build path touches the DOM, so the pure `build*Arrays`
 * functions run in Node and are what `test/check-render-geometry.js` checks.
 */

import * as THREE from 'three';
import { KIND, flowRate } from '../parser/parse.js';
import { FEATURE_COLORS, RETRACT_COLOR, PRIME_COLOR, hexToRgb, sampleRamp } from './colors.js';

/**
 * The bead cross-section, in the segment's local frame:
 *   u = across the path, in XY;  v = up, along +Z.
 * Coordinates are in units of half-width / half-height.
 *
 * Three profiles, because the cost difference is large and the visual
 * difference is not. Ordering always runs +u -> -u over the TOP of the bead;
 * that is what makes the face winding come out front-facing and the averaged
 * edge normals point outwards.
 *
 * | quality | ring | verts/move | tris/move | what you lose |
 * |---|---|---|---|---|
 * | `high` | closed hexagon | 12 | 12 (+8 with caps) | nothing |
 * | `fast` | open 3-point tent | 6 | 4 | the underside and the vertical side walls; from above, near-identical |
 * | `flat` | open 2-point ribbon | 4 | 2 | all height: edge-on views show hairlines |
 *
 * `fast` keeps a real top ridge and real height, so a front view still shows
 * solid layers -- which is why it, not `flat`, is the automatic choice for big
 * files. `flat` exists for the genuinely enormous ones.
 */
export const PROFILES = {
  high: {
    u: [1.0, 0.58, -0.58, -1.0, -0.58, 0.58],
    v: [0.0, 1.0, 1.0, 0.0, -1.0, -1.0],
    closed: true,
  },
  fast: { u: [1.0, 0.0, -1.0], v: [-1.0, 1.0, -1.0], closed: false },
  // A truly flat ribbon has one normal (straight up) for both of its vertices,
  // which shades every bead identically and loses the seam between neighbours --
  // the exact "flat unlit" look this renderer is supposed to avoid. So `flat`
  // overrides its normals with a slight outward tilt: the shading then ramps
  // across each ribbon and adjacent beads still separate.
  flat: {
    u: [1.0, -1.0], v: [0.0, 0.0], closed: false,
    nu: [0.44, -0.44], nv: [0.898, 0.898],
  },
};

/** Vertices in one `high` cross-section ring. Kept for callers that assume it. */
export const RING = PROFILES.high.u.length;
/** Vertices per extruding segment at `high`. Builders report their own. */
export const SEG_VERTS = RING * 2;

/**
 * Pick a quality for a segment count. The thresholds are where a mid-range
 * integrated GPU stops holding 60 fps in practice; `high` is roughly 12
 * triangles per move, `fast` 4.
 */
export function autoQuality(extrudeCount) {
  if (extrudeCount <= 60000) return 'high';
  if (extrudeCount <= 500000) return 'fast';
  return 'flat';
}

/** Highest layer index present, so every builder agrees on the layer table size. */
export function countLayers(seg, count) {
  let maxLayer = 0;
  for (let i = 0; i < count; i++) if (seg.layer[i] > maxLayer) maxLayer = seg.layer[i];
  return maxLayer + 1;
}

/** Fill start/end tables for layers that produced nothing, so lookups never gap. */
function sealLayerTable(start, end, layerCount, total) {
  let run = 0;
  for (let l = 0; l < layerCount; l++) {
    if (end[l] === 0xffffffff) {
      start[l] = run;
      end[l] = run;
    } else {
      run = end[l];
    }
  }
  void total;
}

/* ------------------------------------------------------------------ extrude */

/**
 * Build the ribbon mesh arrays.
 *
 * @param {object} seg    parseResult.segments
 * @param {number} count  parseResult.count
 * @param {{layerCount?:number, quality?:'high'|'fast'|'flat'|'auto', caps?:boolean,
 *          defaultWidth?:number, defaultHeight?:number, miterLimit?:number}} [opts]
 */
export function buildExtrudeArrays(seg, count, opts = {}) {
  const defW = opts.defaultWidth ?? 0.42;
  const defH = opts.defaultHeight ?? 0.2;
  const miterLimit = opts.miterLimit ?? 2.5;
  const layerCount = opts.layerCount ?? countLayers(seg, count);

  const { kind, x0, y0, z0, x1, y1, z1, width, height, layer } = seg;

  let n = 0;
  for (let i = 0; i < count; i++) if (kind[i] === KIND.EXTRUDE) n++;

  let quality = opts.quality || 'auto';
  if (quality === 'auto') quality = autoQuality(n);
  const prof = PROFILES[quality] || PROFILES.high;
  const P = prof.u.length;                       // points per ring
  const ringVerts = P;
  const segVerts = P * 2;
  const quads = prof.closed ? P : P - 1;
  // Caps close the open ends of a `high` tube. They are pointless on the open
  // profiles, which have no tube to close.
  const wantCaps = (opts.caps ?? (quality === 'high')) && prof.closed && P >= 3;
  const maxIdxPerSeg = quads * 6 + (wantCaps ? (P - 2) * 3 * 2 : 0);

  const vertexCount = n * segVerts;
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const id = new Float32Array(vertexCount);
  const segOf = new Uint32Array(n);
  const index = new Uint32Array(n * maxIdxPerSeg);

  const layerIdxStart = new Uint32Array(layerCount).fill(0xffffffff);
  const layerIdxEnd = new Uint32Array(layerCount).fill(0xffffffff);
  const layerSlotStart = new Uint32Array(layerCount).fill(0xffffffff);
  const layerSlotEnd = new Uint32Array(layerCount).fill(0xffffffff);

  // Per-vertex outward normals of the cross-section, recomputed whenever the
  // width/height pair changes (it changes rarely, so this memo is nearly free).
  const csNU = new Float64Array(P);
  const csNV = new Float64Array(P);
  let memoW = -1, memoH = -1;
  const CS_U = prof.u, CS_V = prof.v;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  let slot = 0;
  let idx = 0;
  let caps = 0;
  let mitred = 0;

  for (let i = 0; i < count; i++) {
    if (kind[i] !== KIND.EXTRUDE) continue;

    const ax = x0[i], ay = y0[i], bx = x1[i], by = y1[i];
    let dx = bx - ax, dy = by - ay;
    let len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-9) { dx = 1; dy = 0; len = 0; } else { dx /= len; dy /= len; }

    // Left-hand perpendicular. (side, +Z, dir) is right-handed, which is what
    // the triangle winding below assumes.
    const sx = -dy, sy = dx;

    let hw = (width[i] > 0 ? width[i] : defW) * 0.5;
    let hh = (height[i] > 0 ? height[i] : defH) * 0.5;
    if (hw < 1e-4) hw = defW * 0.5;
    if (hh < 1e-4) hh = defH * 0.5;

    if (hw !== memoW || hh !== memoH) {
      crossSectionNormals(prof, hw, hh, csNU, csNV);
      memoW = hw; memoH = hh;
    }

    // --- joints ----------------------------------------------------------
    // A joint is mitred when the neighbouring move is also extruding and its
    // endpoint is exactly ours. 96% of this file's extrusions qualify, which
    // is why mitring beats per-segment caps: same vertex count, no seams.
    let sox = sx, soy = sy, sms = 1;
    let eox = sx, eoy = sy, ems = 1;
    let capStart = true, capEnd = true;

    if (i > 0 && kind[i - 1] === KIND.EXTRUDE &&
        x1[i - 1] === ax && y1[i - 1] === ay && z1[i - 1] === z0[i]) {
      const px = x1[i - 1] - x0[i - 1], py = y1[i - 1] - y0[i - 1];
      const pl = Math.sqrt(px * px + py * py);
      if (pl > 1e-9) {
        const m = miterAt(px / pl, py / pl, dx, dy, miterLimit);
        if (m) { sox = m[0]; soy = m[1]; sms = m[2]; capStart = false; mitred++; }
      }
    }
    if (i + 1 < count && kind[i + 1] === KIND.EXTRUDE &&
        x0[i + 1] === bx && y0[i + 1] === by && z0[i + 1] === z1[i]) {
      const nx = x1[i + 1] - x0[i + 1], ny = y1[i + 1] - y0[i + 1];
      const nl = Math.sqrt(nx * nx + ny * ny);
      if (nl > 1e-9) {
        const m = miterAt(dx, dy, nx / nl, ny / nl, miterLimit);
        if (m) { eox = m[0]; eoy = m[1]; ems = m[2]; capEnd = false; }
      }
    }

    // --- vertices --------------------------------------------------------
    const base = slot * segVerts;
    const azc = z0[i] - hh;   // z0/z1 is the nozzle height = TOP of the bead
    const bzc = z1[i] - hh;

    for (let j = 0; j < P; j++) {
      const u = CS_U[j], v = CS_V[j];
      const nu = csNU[j], nv = csNV[j];

      const av = (base + j) * 3;
      const px = ax + sox * (u * hw * sms);
      const py = ay + soy * (u * hw * sms);
      const pz = azc + v * hh;
      position[av] = px; position[av + 1] = py; position[av + 2] = pz;
      normal[av] = sx * nu; normal[av + 1] = sy * nu; normal[av + 2] = nv;

      const bv = (base + ringVerts + j) * 3;
      const qx = bx + eox * (u * hw * ems);
      const qy = by + eoy * (u * hw * ems);
      const qz = bzc + v * hh;
      position[bv] = qx; position[bv + 1] = qy; position[bv + 2] = qz;
      normal[bv] = sx * nu; normal[bv + 1] = sy * nu; normal[bv + 2] = nv;

      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (qx < minX) minX = qx; if (qx > maxX) maxX = qx;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (qy < minY) minY = qy; if (qy > maxY) maxY = qy;
      if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
      if (qz < minZ) minZ = qz; if (qz > maxZ) maxZ = qz;
    }
    for (let j = 0; j < segVerts; j++) id[base + j] = i;
    segOf[slot] = i;

    // --- indices ---------------------------------------------------------
    const l = layer[i];
    if (layerIdxStart[l] === 0xffffffff) {
      layerIdxStart[l] = idx;
      layerSlotStart[l] = slot;
    }

    for (let j = 0; j < quads; j++) {
      const k = (j + 1) % P;
      const a0 = base + j, a1 = base + k;
      const b0 = base + ringVerts + j, b1 = base + ringVerts + k;
      index[idx++] = a0; index[idx++] = a1; index[idx++] = b1;
      index[idx++] = a0; index[idx++] = b1; index[idx++] = b0;
    }
    if (wantCaps && capStart) {
      const a = base;
      for (let j = 1; j < P - 1; j++) {
        index[idx++] = a; index[idx++] = a + j + 1; index[idx++] = a + j;
      }
      caps++;
    }
    if (wantCaps && capEnd) {
      const b = base + ringVerts;
      for (let j = 1; j < P - 1; j++) {
        index[idx++] = b; index[idx++] = b + j; index[idx++] = b + j + 1;
      }
      caps++;
    }

    slot++;
    layerIdxEnd[l] = idx;
    layerSlotEnd[l] = slot;
  }

  sealLayerTable(layerIdxStart, layerIdxEnd, layerCount, idx);
  sealLayerTable(layerSlotStart, layerSlotEnd, layerCount, slot);

  if (!n) { minX = minY = minZ = 0; maxX = maxY = maxZ = 0; }

  return {
    quality,
    vertsPerSeg: segVerts,
    slotCount: n,
    vertexCount,
    indexCount: idx,
    position, normal, id, segOf,
    index: index.length === idx ? index : index.subarray(0, idx),
    layerIdxStart, layerIdxEnd, layerSlotStart, layerSlotEnd,
    bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    stats: { caps, mitredJoints: mitred, triangles: idx / 3 },
  };
}

/**
 * Mitre offset at a joint between two *unit* directions, incoming then
 * outgoing. Returns [ox, oy, scale] -- the bisector of the two side vectors
 * and how far the width has to stretch along it to keep the outer edge
 * straight through the corner -- or null when the corner is too sharp (the
 * stretch would blow up) or doubles back on itself, in which case the caller
 * falls back to a flat cap.
 *
 * Both segments at a joint derive the same bisector from the same two
 * directions, so the two rings land on identical points. That is what makes
 * the seam invisible, and `test/check-render-geometry.js` asserts it.
 */
function miterAt(pdx, pdy, ndx, ndy, limit) {
  const psx = -pdy, psy = pdx;
  const nsx = -ndy, nsy = ndx;
  let mx = psx + nsx, my = psy + nsy;
  const ml = Math.sqrt(mx * mx + my * my);
  if (ml < 1e-6) return null;            // doubles straight back on itself
  mx /= ml; my /= ml;
  const denom = mx * nsx + my * nsy;     // cos(half turn angle)
  if (!(denom > 1e-6)) return null;
  const scale = 1 / denom;
  if (scale > limit) return null;
  return [mx, my, scale];
}

/**
 * Outward unit normals of the scaled cross-section, averaged from the two
 * edges meeting at each vertex. Doing this in *scaled* space matters: a bead
 * is roughly 0.5 x 0.2 mm, so a normal computed on the unit hexagon would be
 * badly wrong and the top faces would shade like the sides.
 */
function crossSectionNormals(prof, hw, hh, outU, outV) {
  const U = prof.u, V = prof.v, P = U.length;
  if (prof.nu) {
    for (let j = 0; j < P; j++) { outU[j] = prof.nu[j]; outV[j] = prof.nv[j]; }
    return;
  }
  const edges = prof.closed ? P : P - 1;
  const eu = new Array(edges), ev = new Array(edges);
  for (let j = 0; j < edges; j++) {
    const k = (j + 1) % P;
    const du = (U[k] - U[j]) * hw;
    const dv = (V[k] - V[j]) * hh;
    const l = Math.sqrt(du * du + dv * dv) || 1;
    eu[j] = dv / l; ev[j] = -du / l;     // ordered +u -> -u -> (dy, -dx) points out
  }
  for (let j = 0; j < P; j++) {
    // On an open strip the two end vertices have only one adjoining edge.
    const a = prof.closed ? (j + P - 1) % P : (j === 0 ? 0 : j - 1);
    const b = prof.closed ? j : Math.min(j, edges - 1);
    let u = eu[a] + eu[b], v = ev[a] + ev[b];
    const l = Math.sqrt(u * u + v * v) || 1;
    outU[j] = u / l; outV[j] = v / l;
  }
}

/* ------------------------------------------------------------- travel/marks */

/** Travel moves -> LineSegments arrays. 2 vertices per move. */
export function buildTravelArrays(seg, count, opts = {}) {
  const layerCount = opts.layerCount ?? countLayers(seg, count);
  const { kind, x0, y0, z0, x1, y1, z1, layer } = seg;

  let n = 0;
  for (let i = 0; i < count; i++) if (kind[i] === KIND.TRAVEL) n++;

  const position = new Float32Array(n * 6);
  const id = new Float32Array(n * 2);
  const segOf = new Uint32Array(n);
  const layerVertStart = new Uint32Array(layerCount).fill(0xffffffff);
  const layerVertEnd = new Uint32Array(layerCount).fill(0xffffffff);

  let slot = 0;
  for (let i = 0; i < count; i++) {
    if (kind[i] !== KIND.TRAVEL) continue;
    const l = layer[i];
    if (layerVertStart[l] === 0xffffffff) layerVertStart[l] = slot * 2;
    const p = slot * 6;
    position[p] = x0[i]; position[p + 1] = y0[i]; position[p + 2] = z0[i];
    position[p + 3] = x1[i]; position[p + 4] = y1[i]; position[p + 5] = z1[i];
    id[slot * 2] = i; id[slot * 2 + 1] = i;
    segOf[slot] = i;
    slot++;
    layerVertEnd[l] = slot * 2;
  }
  sealLayerTable(layerVertStart, layerVertEnd, layerCount, slot * 2);
  return { slotCount: n, vertexCount: n * 2, position, id, segOf, layerVertStart, layerVertEnd };
}

/** Retractions and primes -> Points arrays. 1 vertex per move. */
export function buildMarkerArrays(seg, count, opts = {}) {
  const layerCount = opts.layerCount ?? countLayers(seg, count);
  const { kind, x0, y0, z0, layer } = seg;

  let n = 0;
  for (let i = 0; i < count; i++) {
    const k = kind[i];
    if (k === KIND.RETRACT || k === KIND.PRIME) n++;
  }

  const position = new Float32Array(n * 3);
  const color = new Uint8Array(n * 3);
  const id = new Float32Array(n);
  const segOf = new Uint32Array(n);
  const layerVertStart = new Uint32Array(layerCount).fill(0xffffffff);
  const layerVertEnd = new Uint32Array(layerCount).fill(0xffffffff);

  const rc = hexToRgb(RETRACT_COLOR).map((v) => Math.round(v * 255));
  const pc = hexToRgb(PRIME_COLOR).map((v) => Math.round(v * 255));

  let slot = 0;
  for (let i = 0; i < count; i++) {
    const k = kind[i];
    if (k !== KIND.RETRACT && k !== KIND.PRIME) continue;
    const l = layer[i];
    if (layerVertStart[l] === 0xffffffff) layerVertStart[l] = slot;
    position[slot * 3] = x0[i];
    position[slot * 3 + 1] = y0[i];
    position[slot * 3 + 2] = z0[i];
    const c = k === KIND.RETRACT ? rc : pc;
    color[slot * 3] = c[0]; color[slot * 3 + 1] = c[1]; color[slot * 3 + 2] = c[2];
    id[slot] = i;
    segOf[slot] = i;
    slot++;
    layerVertEnd[l] = slot;
  }
  sealLayerTable(layerVertStart, layerVertEnd, layerCount, slot);
  return { slotCount: n, vertexCount: n, position, color, id, segOf, layerVertStart, layerVertEnd };
}

/* ------------------------------------------------------------------ colours */

const LUT_SIZE = 256;
const lutCache = new Map();

/** 256-entry RGB lookup for a ramp, so colouring 800k vertices is table reads. */
export function rampLut(mode) {
  let lut = lutCache.get(mode);
  if (lut) return lut;
  lut = new Uint8Array(LUT_SIZE * 3);
  for (let i = 0; i < LUT_SIZE; i++) {
    const c = sampleRamp(mode, i / (LUT_SIZE - 1));
    lut[i * 3] = Math.round(c[0] * 255);
    lut[i * 3 + 1] = Math.round(c[1] * 255);
    lut[i * 3 + 2] = Math.round(c[2] * 255);
  }
  lutCache.set(mode, lut);
  return lut;
}

const FEATURE_RGB = (() => {
  const a = new Uint8Array(FEATURE_COLORS.length * 3);
  FEATURE_COLORS.forEach((hex, i) => {
    const c = hexToRgb(hex);
    a[i * 3] = Math.round(c[0] * 255);
    a[i * 3 + 1] = Math.round(c[1] * 255);
    a[i * 3 + 2] = Math.round(c[2] * 255);
  });
  return a;
})();

/**
 * Min/max of every numeric view mode, over EXTRUDING moves only -- travels have
 * no width and would drag every range to zero.
 *
 * `fan` is returned in percent (0..100) rather than the parser's 0..1, because
 * VIEW_MODES declares its unit as '%' and the UI legend formats what it is
 * given. The colour ramp uses the same scale, so the two always agree.
 */
export function computeValueRanges(parse) {
  const seg = parse.segments;
  const count = parse.count;
  const dia = parse.meta?.filamentDiameter || 1.75;
  // Plastic (mm of extrusion path) per rounded value, for the colour scale below.
  const hist = { speed: new Map(), flow: new Map(), fan: new Map(), temp: new Map(), width: new Map(), height: new Map() };
  const out = {
    feature: { min: 0, max: Math.max(1, FEATURE_COLORS.length - 1) },
    speed: { min: Infinity, max: -Infinity },
    flow: { min: Infinity, max: -Infinity },
    fan: { min: Infinity, max: -Infinity },
    temp: { min: Infinity, max: -Infinity },
    width: { min: Infinity, max: -Infinity },
    height: { min: Infinity, max: -Infinity },
  };
  for (let i = 0; i < count; i++) {
    if (seg.kind[i] !== KIND.EXTRUDE) continue;
    const len = Math.hypot(seg.x1[i] - seg.x0[i], seg.y1[i] - seg.y0[i]) || 1e-3;
    const fl = flowRate(seg, i, dia);
    acc(out.speed, seg.speed[i]); tally(hist.speed, seg.speed[i], len);
    acc(out.flow, fl); tally(hist.flow, fl, len);
    acc(out.fan, seg.fan[i] * 100); tally(hist.fan, seg.fan[i] * 100, len);
    acc(out.temp, seg.temp[i]); tally(hist.temp, seg.temp[i], len);
    if (seg.width[i] > 0) tally(hist.width, seg.width[i], len);
    if (seg.height[i] > 0) tally(hist.height, seg.height[i], len);
    // A zero width/height means the move ran before the slicer emitted its
    // first ;WIDTH: / ;HEIGHT: annotation -- that is "unknown", not "zero", and
    // letting it into the range would flatten the whole ramp against one
    // outlier. The geometry pass substitutes a nozzle-sized default instead.
    if (seg.width[i] > 0) acc(out.width, seg.width[i]);
    if (seg.height[i] > 0) acc(out.height, seg.height[i]);
  }
  for (const k of Object.keys(out)) {
    const r = out[k];
    if (!Number.isFinite(r.min) || !Number.isFinite(r.max)) { r.min = 0; r.max = 1; }
    if (r.max - r.min < 1e-9) r.max = r.min + 1;
    if (hist[k]) colourScale(r, hist[k], VALUE_STEP[k]);
  }
  return out;
}

/** Values within this much of each other count as the same value. */
const VALUE_STEP = { speed: 1, flow: 0.05, fan: 0.5, temp: 1, width: 0.01, height: 0.01 };
function tally(map, v, len) {
  if (!Number.isFinite(v)) return;
  const k = Math.round(v * 1000) / 1000;
  map.set(k, (map.get(k) || 0) + len);
}

/** A value "is used" when at least this share of the plastic is laid at it. */
const MAJOR_SHARE = 0.005;
const MAX_MAJOR = 10;

/**
 * Pick how a numeric view mode spreads its colours, from what the file uses.
 * Adds to `r`:
 *   kind     'single'   one value only (e.g. one nozzle temperature)
 *            'discrete' a few values carry the plastic: each gets its own,
 *                       evenly spaced colour; in-between values (slowdowns)
 *                       blend between their neighbours
 *            'quantile' values are spread out: colours follow the plastic, so
 *                       each colour band holds the same share of the print
 *   anchors  [{v, t}] sorted by v -- value -> ramp position, piecewise linear
 *   values   [{v, share}] the used values (discrete / single), for the legend
 *   min/max  the used range (outliers under MAJOR_SHARE don't stretch it)
 */
function colourScale(r, map, step) {
  let total = 0;
  for (const len of map.values()) total += len;
  if (!total) { Object.assign(r, { kind: 'single', anchors: [{ v: r.min, t: 0.6 }], values: [] }); return; }
  // values within one step are one value (63.1 and 63.15 mm/s)
  const merged = new Map();
  for (const [v, len] of map) {
    const key = Math.round(v / step);
    const cur = merged.get(key);
    if (cur) { cur.len += len; cur.sum += v * len; } else merged.set(key, { len, sum: v * len });
  }
  const groups = [...merged.values()].map((g) => ({ v: g.sum / g.len, share: g.len / total }))
    .sort((a, b) => a.v - b.v);

  let majors = groups.filter((g) => g.share >= MAJOR_SHARE);
  if (majors.length > MAX_MAJOR) majors = majors.slice().sort((a, b) => b.share - a.share).slice(0, MAX_MAJOR).sort((a, b) => a.v - b.v);
  const covered = majors.reduce((s, g) => s + g.share, 0);

  if (majors.length <= 1 && covered > 0.9) {
    const v = majors.length ? majors[0].v : groups[0].v;
    Object.assign(r, { kind: 'single', anchors: [{ v, t: 0.6 }], values: majors.length ? majors : [groups[0]] });
    return;
  }
  if (majors.length >= 2 && covered >= 0.8) {
    const K = majors.length;
    Object.assign(r, {
      kind: 'discrete',
      anchors: majors.map((g, k) => ({ v: g.v, t: k / (K - 1) })),
      values: majors,
      otherShare: Math.max(0, 1 - covered),
      otherCount: groups.length - K,
      min: majors[0].v, max: majors[K - 1].v,
    });
    return;
  }
  // quantiles of the plastic: t = share of the print at or below the value
  const anchors = [];
  let cum = 0;
  const Q = 24;
  let next = 0;
  for (const g of groups) {
    const mid = cum + g.share / 2;
    while (next <= Q && next / Q <= mid + 1e-12) {
      if (!anchors.length || anchors[anchors.length - 1].v < g.v) anchors.push({ v: g.v, t: mid });
      next++;
    }
    cum += g.share;
  }
  // stretch the used part over the whole ramp
  const t0 = anchors[0].t, t1 = anchors[anchors.length - 1].t;
  for (const a of anchors) a.t = t1 > t0 ? (a.t - t0) / (t1 - t0) : 0.5;
  Object.assign(r, {
    kind: 'quantile', anchors, values: [],
    min: anchors[0].v, max: anchors[anchors.length - 1].v,
  });
}

/** Ramp position (0..1) of a value on a scale from colourScale(). */
export function scaleT(range, value) {
  const A = range.anchors;
  if (!A || !A.length) {
    const t = (value - range.min) / ((range.max - range.min) || 1);
    return t < 0 ? 0 : t > 1 ? 1 : t;
  }
  if (A.length === 1 || value <= A[0].v) return A[0].t;
  const last = A[A.length - 1];
  if (value >= last.v) return last.t;
  let lo = 0, hi = A.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (A[m].v <= value) lo = m; else hi = m; }
  const a = A[lo], b = A[hi];
  return a.t + (b.t - a.t) * ((value - a.v) / (b.v - a.v));
}

function acc(r, v) {
  if (!Number.isFinite(v)) return;
  if (v < r.min) r.min = v;
  if (v > r.max) r.max = v;
}

/**
 * Write per-vertex colours for the extrude mesh, in place.
 *
 * @param {Uint8Array} out    length vertexCount*3
 * @param {object} parse      parse result
 * @param {Uint32Array} segOf slot -> source segment index
 * @param {string} mode       a VIEW_MODES id
 * @param {{min:number,max:number}} range
 * @param {number} vertsPerSeg from the builder -- varies with quality
 */
export function fillExtrudeColors(out, parse, segOf, mode, range, vertsPerSeg = SEG_VERTS) {
  const seg = parse.segments;
  const n = segOf.length;
  const dia = parse.meta?.filamentDiameter || 1.75;
  const VP = vertsPerSeg;

  if (mode === 'feature') {
    for (let s = 0; s < n; s++) {
      const f = seg.feature[segOf[s]] * 3;
      const r = FEATURE_RGB[f], g = FEATURE_RGB[f + 1], b = FEATURE_RGB[f + 2];
      let v = s * VP * 3;
      for (let j = 0; j < VP; j++) { out[v++] = r; out[v++] = g; out[v++] = b; }
    }
    return;
  }

  const lut = rampLut(mode);
  const field = mode === 'speed' ? seg.speed
    : mode === 'temp' ? seg.temp
      : mode === 'width' ? seg.width
        : mode === 'height' ? seg.height
          : null;

  for (let s = 0; s < n; s++) {
    const i = segOf[s];
    let value;
    if (field) value = field[i];
    else if (mode === 'fan') value = seg.fan[i] * 100;
    else value = flowRate(seg, i, dia);

    const t = scaleT(range, value);
    const q = (t * (LUT_SIZE - 1) + 0.5) | 0;
    const k = q * 3;
    const r = lut[k], g = lut[k + 1], b = lut[k + 2];
    let v = s * VP * 3;
    for (let j = 0; j < VP; j++) { out[v++] = r; out[v++] = g; out[v++] = b; }
  }
}

/**
 * Write one colour into every vertex of an aColor array, in place.
 * @param {Uint8Array} out  length vertexCount*3
 * @param {number[]} rgb    0..255 bytes
 */
export function fillSolidColor(out, rgb) {
  const r = rgb[0], g = rgb[1], b = rgb[2];
  for (let v = 0; v < out.length; v += 3) { out[v] = r; out[v + 1] = g; out[v + 2] = b; }
}

/* ------------------------------------------------------ compare: Z mapping */

/**
 * One Z per layer index: the lowest nozzle Z of that layer's extrusions, NaN
 * for a layer with none. Taken from the segments rather than `parse.layers[]`
 * because `segments.layer` is the ;LAYER: number, not an index into that
 * array, and a stub layer has no real Z.
 */
export function layerZTable(seg, count, layerCount) {
  const z = new Float64Array(layerCount).fill(NaN);
  const { kind, layer, z0, z1 } = seg;
  for (let i = 0; i < count; i++) {
    if (kind[i] !== KIND.EXTRUDE) continue;
    const l = layer[i];
    const v = z0[i] < z1[i] ? z0[i] : z1[i];
    if (!(z[l] <= v)) z[l] = v;          // NaN compares false -> first value wins
  }
  return z;
}

/**
 * Z span [zLo, zHi] of layers lo..hi (inclusive) in a table from layerZTable,
 * or null when none of them has extrusions. The first layer opens the span
 * downwards and the last one upwards, so the full range always means "all".
 */
export function zSpanOfLayers(zs, lo, hi) {
  let zLo = Infinity, zHi = -Infinity;
  for (let l = Math.max(0, lo); l <= hi && l < zs.length; l++) {
    const v = zs[l];
    if (v !== v) continue;
    if (v < zLo) zLo = v;
    if (v > zHi) zHi = v;
  }
  if (zLo > zHi) return null;
  if (lo <= 0) zLo = -Infinity;
  if (hi >= zs.length - 1) zHi = Infinity;
  return [zLo, zHi];
}

/**
 * The other file's layers whose Z lies in [zLo - eps, zHi + eps], as one
 * inclusive index range [lo, hi] (first to last match), or null for none.
 * Layers without a Z (NaN) never match.
 */
export function layerRangeByZ(otherZs, zLo, zHi, eps = 0.001) {
  const a = zLo - eps, b = zHi + eps;
  let lo = -1, hi = -1;
  for (let l = 0; l < otherZs.length; l++) {
    const v = otherZs[l];
    if (v >= a && v <= b) { if (lo < 0) lo = l; hi = l; }
  }
  return lo < 0 ? null : [lo, hi];
}

/* -------------------------------------------------------- THREE wrapping */

function attr(array, itemSize, normalized = false) {
  const a = new THREE.BufferAttribute(array, itemSize, normalized);
  a.setUsage(THREE.StaticDrawUsage);
  return a;
}

/** Wrap the extrude arrays into a BufferGeometry ready to draw. */
export function makeExtrudeGeometry(built) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', attr(built.position, 3));
  g.setAttribute('normal', attr(built.normal, 3));
  g.setAttribute('aColor', attr(new Uint8Array(built.vertexCount * 3), 3, true));
  g.setAttribute('aFlags', attr(new Uint8Array(built.vertexCount), 1, false));
  g.setAttribute('aId', attr(built.id, 1));
  g.setIndex(attr(built.index, 1));
  g.getAttribute('aColor').setUsage(THREE.DynamicDrawUsage);
  g.getAttribute('aFlags').setUsage(THREE.DynamicDrawUsage);
  g.setDrawRange(0, built.indexCount);
  const b = built.bounds;
  g.boundingBox = new THREE.Box3(
    new THREE.Vector3(b.min[0], b.min[1], b.min[2]),
    new THREE.Vector3(b.max[0], b.max[1], b.max[2]),
  );
  g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
  return g;
}

/** Wrap the travel arrays into a non-indexed LineSegments geometry. */
export function makeTravelGeometry(built) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', attr(built.position, 3));
  g.setAttribute('aFlags', attr(new Uint8Array(built.vertexCount), 1, false));
  g.setAttribute('aId', attr(built.id, 1));
  g.getAttribute('aFlags').setUsage(THREE.DynamicDrawUsage);
  g.setDrawRange(0, built.vertexCount);
  g.computeBoundingSphere();
  return g;
}

/** Wrap the marker arrays into a Points geometry. */
export function makeMarkerGeometry(built) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', attr(built.position, 3));
  g.setAttribute('aColor', attr(built.color, 3, true));
  g.setAttribute('aFlags', attr(new Uint8Array(built.vertexCount), 1, false));
  g.setAttribute('aId', attr(built.id, 1));
  g.getAttribute('aFlags').setUsage(THREE.DynamicDrawUsage);
  g.setDrawRange(0, built.vertexCount);
  g.computeBoundingSphere();
  return g;
}
