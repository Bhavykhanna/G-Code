/**
 * compare.js -- what changed between two G-code files, as plastic on the bed.
 *
 * Pure, no DOM; runs in src/compare-worker.js and in Node tests.
 * See docs/CONTEXT-compare.md.
 *
 * Two slices of similar models never share moves one-for-one: the slicer
 * splits paths, moves seams and re-lays infill differently every time. So the
 * question is not "does the old file have this move" but "does the old file
 * put the same kind of plastic here". Layer by layer (matched by Z):
 *
 *   1. both files are drawn into a 0.1 mm grid at their real line width;
 *      wall pixels also remember every direction a wall crosses them in
 *   2. a WALL move is unchanged when >= 80 % of its centreline lies on an
 *      old wall running the same way (within 22.5 deg). Direction is what
 *      tells a moved ring (a screw hole) from the old ring where they cross.
 *      A wall is a continuous object, so each move's score is averaged with
 *      its neighbours along the same path (+/- 2 mm): a moved ring that runs
 *      parallel to an old wall for a moment still reads as moved.
 *   3. a FILL move (solid infill, top / bottom surface, bridges, ironing) is
 *      unchanged when >= 80 % of it lies on old plastic of any kind -- a floor
 *      that is still a floor must not light up because its lines moved.
 *   4. sparse infill, skirt, brim and start/end G-code are NEUTRAL: the
 *      pattern is regenerated on every slice and says nothing about the design.
 *
 * Tolerance comes from the line width itself (a centreline point is "on" a
 * line within half its width), so there are no neighbour-cell fudges.
 * Bed coordinates, no alignment: that is where the printer puts the plastic.
 */

const EXTRUDE = 0;
const RES = 0.1;                 // mm per grid cell
const STEP = 0.25;               // mm between centreline samples when classifying
const SHARE = 0.8;               // fraction of a move that must match
const DIR_BINS = 16;             // wall direction, over 180 deg
const DIR_TOL = 2;               // bins either side (2 x 11.25 = 22.5 deg)
const SMOOTH = 2;                // mm of path either side a wall move's score is averaged over
const JOIN = 0.01;               // mm: moves this close end-to-start are one path

// Feature ids -- must match FEATURE_NAMES in src/parser/parse.js.
const F = {
  unknown: 0, innerWall: 1, outerWall: 2, overhangWall: 3, sparse: 4, solid: 5,
  top: 6, bottom: 7, ironing: 8, bridge: 9, internalBridge: 10, gap: 11,
  skirt: 12, brim: 13, support: 14, supportIf: 15, primeTower: 16, custom: 17,
};
const ROLE_NEUTRAL = 0, ROLE_WALL = 1, ROLE_FILL = 2;
const ROLE = new Uint8Array(256);                       // default neutral
for (const f of [F.innerWall, F.outerWall, F.overhangWall, F.gap]) ROLE[f] = ROLE_WALL;
for (const f of [F.solid, F.top, F.bottom, F.ironing, F.bridge, F.internalBridge, F.support, F.supportIf]) ROLE[f] = ROLE_FILL;

export const CLASS = { SAME: 0, ADDED: 1, REMOVED: 2, NEUTRAL: 255 };

function dirBin(dx, dy) {
  let a = Math.atan2(dy, dx);
  if (a < 0) a += Math.PI;
  return Math.min(DIR_BINS - 1, Math.floor((a / Math.PI) * DIR_BINS));
}

/** Moves that take part, grouped by Z (0.01 mm), plus their bounding box. */
function index(p) {
  const s = p.segments;
  const byZ = new Map();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.count; i++) {
    if (s.kind[i] !== EXTRUDE || ROLE[s.feature[i]] === ROLE_NEUTRAL) continue;
    const z = Math.round(s.z1[i] * 100);
    let list = byZ.get(z);
    if (!list) byZ.set(z, (list = []));
    list.push(i);
    x0 = Math.min(x0, s.x0[i], s.x1[i]); x1 = Math.max(x1, s.x0[i], s.x1[i]);
    y0 = Math.min(y0, s.y0[i], s.y1[i]); y1 = Math.max(y1, s.y0[i], s.y1[i]);
  }
  return { byZ, x0, y0, x1, y1 };
}

/**
 * The grid for one layer of one file, reused for every layer:
 *   fill[c] = 1 where the file puts any plastic
 *   wall[c] = bit set of the directions walls cross this cell in (bit d for
 *             bin d). A set, not the last one drawn: neighbouring wall loops
 *             overlap by a few hundredths of a mm and would overwrite each
 *             other's direction on curves.
 */
function makeGrid(gx0, gy0, w, h) {
  return { gx0, gy0, w, h, fill: new Uint8Array(w * h), wall: new Uint16Array(w * h), used: [] };
}

/** Bit set of the direction bins within DIR_TOL of bin d, wrapping at 180 deg. */
const NEAR = Array.from({ length: DIR_BINS }, (_, d) => {
  let m = 0;
  for (let k = -DIR_TOL; k <= DIR_TOL; k++) m |= 1 << ((d + k + DIR_BINS) % DIR_BINS);
  return m;
});

function clearGrid(g) {
  // only the cells written last time -- far cheaper than clearing the whole bed
  for (const c of g.used) { g.fill[c] = 0; g.wall[c] = 0; }
  g.used.length = 0;
}

/**
 * Draw a line with its width: perpendicular strokes every RES/2 along it,
 * each sampled every RES/2 across. Half-cell spacing is what guarantees no
 * cell is skipped: at exactly one cell per step, float rounding
 * (12.999... -> 12) leaves holes in the drawn line.
 */
function stamp(g, ax, ay, bx, by, width, wallDir) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  const half = Math.max(width, 0.3) / 2;
  const ux = len > 0 ? dx / len : 1, uy = len > 0 ? dy / len : 0;
  const px = -uy, py = ux;                      // unit normal
  const n = Math.max(1, Math.ceil(len / (RES / 2)));
  const m = Math.max(1, Math.ceil(half / (RES / 2)));
  for (let k = 0; k <= n; k++) {
    const cx = ax + (dx * k) / n, cy = ay + (dy * k) / n;
    for (let j = -m; j <= m; j++) {
      const off = (j / m) * half;
      const xi = Math.floor((cx + px * off - g.gx0) / RES);
      const yi = Math.floor((cy + py * off - g.gy0) / RES);
      if (xi < 0 || yi < 0 || xi >= g.w || yi >= g.h) continue;
      const c = yi * g.w + xi;
      if (!g.fill[c]) { g.fill[c] = 1; g.used.push(c); }
      if (wallDir >= 0) g.wall[c] |= 1 << wallDir;
    }
  }
}

function drawLayer(g, p, list) {
  const s = p.segments;
  for (const i of list) {
    const wall = ROLE[s.feature[i]] === ROLE_WALL;
    const d = wall ? dirBin(s.x1[i] - s.x0[i], s.y1[i] - s.y0[i]) : -1;
    stamp(g, s.x0[i], s.y0[i], s.x1[i], s.y1[i], s.width[i], d);
  }
}

/** Fraction of a move's centreline that the other file covers the same way. */
function matched(g, s, i) {
  const ax = s.x0[i], ay = s.y0[i], dx = s.x1[i] - ax, dy = s.y1[i] - ay;
  const wall = ROLE[s.feature[i]] === ROLE_WALL;
  const d = wall ? dirBin(dx, dy) : 0;
  const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / STEP));
  let hit = 0;
  for (let k = 0; k <= n; k++) {
    const xi = Math.floor((ax + (dx * k) / n - g.gx0) / RES);
    const yi = Math.floor((ay + (dy * k) / n - g.gy0) / RES);
    if (xi < 0 || yi < 0 || xi >= g.w || yi >= g.h) continue;
    const c = yi * g.w + xi;
    if (wall ? g.wall[c] & NEAR[d] : g.fill[c]) hit++;
  }
  return hit / (n + 1);
}

/**
 * Match scores for one layer's moves (in file order, which is path order).
 * Fill moves keep their own score. Wall moves are grouped into paths --
 * consecutive wall moves where one ends where the next starts -- and each
 * score becomes the length-weighted mean over SMOOTH mm of path either side.
 */
function pathScores(g, s, list) {
  const n = list.length;
  const raw = new Float64Array(n);
  const len = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const i = list[k];
    raw[k] = matched(g, s, i);
    len[k] = Math.max(1e-3, Math.hypot(s.x1[i] - s.x0[i], s.y1[i] - s.y0[i]));
  }
  const out = Float64Array.from(raw);
  let a = 0;
  while (a < n) {
    if (ROLE[s.feature[list[a]]] !== ROLE_WALL) { a++; continue; }
    // [a, b) is one wall path
    let b = a + 1;
    while (b < n && ROLE[s.feature[list[b]]] === ROLE_WALL
      && Math.abs(s.x0[list[b]] - s.x1[list[b - 1]]) < JOIN && Math.abs(s.y0[list[b]] - s.y1[list[b - 1]]) < JOIN) b++;
    if (b - a > 1) {
      // prefix sums of length and length x score along the path
      const P = new Float64Array(b - a + 1), Q = new Float64Array(b - a + 1);
      for (let k = a; k < b; k++) { P[k - a + 1] = P[k - a] + len[k]; Q[k - a + 1] = Q[k - a] + len[k] * raw[k]; }
      let lo = 0, hi = 0;
      for (let k = a; k < b; k++) {
        const mid = P[k - a] + len[k] / 2;
        while (P[lo + 1] < mid - SMOOTH) lo++;                   // first move reaching into the window
        while (hi < b - a && P[hi] < mid + SMOOTH) hi++;         // one past the last
        out[k] = (Q[hi] - Q[lo]) / (P[hi] - P[lo]);
      }
    }
    a = b;
  }
  return out;
}

/**
 * Classify one file's moves against the other file's grid, layer by layer.
 * Layers are matched by Z: exact, else the nearest within 0.05 mm (float
 * noise); a layer the other file does not have is all changed.
 */
function classify(mine, other, mark, g) {
  const s = mine.p.segments;
  const cls = new Uint8Array(mine.p.count).fill(CLASS.NEUTRAL);
  const otherZ = [...other.idx.byZ.keys()];
  let mm = 0, sameMm = 0, moves = 0, changed = 0;
  for (const [z, list] of mine.idx.byZ) {
    let oz = other.idx.byZ.has(z) ? z : null;
    if (oz == null) {
      for (const c of otherZ) if (Math.abs(c - z) <= 5 && (oz == null || Math.abs(c - z) < Math.abs(oz - z))) oz = c;
    }
    clearGrid(g);
    if (oz != null) drawLayer(g, other.p, other.idx.byZ.get(oz));
    const score = oz != null ? pathScores(g, s, list) : null;
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      const len = Math.hypot(s.x1[i] - s.x0[i], s.y1[i] - s.y0[i]);
      const same = score != null && score[k] >= SHARE;
      cls[i] = same ? CLASS.SAME : mark;
      moves++;
      mm += len;
      if (same) sameMm += len; else changed++;
    }
  }
  return { cls, mm, sameMm, moves, changed };
}

/**
 * @param {{segments: object, count: number}} cur  the file on screen (new)
 * @param {{segments: object, count: number}} old  the file it is compared with
 *   segments need x0, y0, x1, y1, z1, width, kind, feature
 * @returns {{curClass: Uint8Array, oldClass: Uint8Array, stats: object}}
 *   curClass: 0 same, 1 added, 255 neutral; oldClass: 0 same, 2 removed, 255 neutral
 */
export function compareToolpaths(cur, old) {
  const t0 = Date.now();
  const A = { p: cur, idx: index(cur) };
  const B = { p: old, idx: index(old) };

  const gx0 = Math.min(A.idx.x0, B.idx.x0) - 1, gy0 = Math.min(A.idx.y0, B.idx.y0) - 1;
  const gx1 = Math.max(A.idx.x1, B.idx.x1) + 1, gy1 = Math.max(A.idx.y1, B.idx.y1) + 1;
  if (!Number.isFinite(gx0)) {
    const none = (p) => new Uint8Array(p.count).fill(CLASS.NEUTRAL);
    return { curClass: none(cur), oldClass: none(old), stats: { empty: true, ms: Date.now() - t0 } };
  }
  const w = Math.ceil((gx1 - gx0) / RES), h = Math.ceil((gy1 - gy0) / RES);
  const g = makeGrid(gx0, gy0, w, h);

  const c = classify(A, B, CLASS.ADDED, g);
  const o = classify(B, A, CLASS.REMOVED, g);

  const r = (v) => Math.round(v * 10) / 10;
  return {
    curClass: c.cls,
    oldClass: o.cls,
    stats: {
      curMm: r(c.mm), curSameMm: r(c.sameMm), curAddedMm: r(c.mm - c.sameMm),
      oldMm: r(o.mm), oldSameMm: r(o.sameMm), oldRemovedMm: r(o.mm - o.sameMm),
      curMoves: c.moves, addedMoves: c.changed, oldMoves: o.moves, removedMoves: o.changed,
      gridCells: w * h,
      ms: Date.now() - t0,
    },
  };
}

/**
 * Rank candidate base files for `current`: earlier versions of the same model
 * first, then files whose MODEL name shares words with it (EnclosureBase ->
 * enclosure-base-mesh-fast), then the rest. Words in the what-changed part
 * ("wire gap") are ignored: they would pull in the lid of the same iteration
 * instead of the base's own previous version.
 * @param {string} current  Archive-relative path
 * @param {string[]} paths  every G-code path
 */
export function rankBases(current, paths) {
  const conv = /^[A-Za-z0-9]+_[0-9.]+_(.+)_[^_]+_[0-9.]+_v(\d+)-/;
  const info = (p) => {
    const file = p.split('/').pop();
    const m = conv.exec(file);
    const model = m ? m[1] : file.replace(/\.gcode$/i, '');
    const words = new Set(model.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
      .split(/[^a-z]+/).filter((w) => w.length > 2 && !['hspla', 'pla', 'mesh', 'fast', 'final'].includes(w)));
    return { model: m ? m[1] : null, version: m ? Number(m[2]) : null, words };
  };
  const cur = info(current);
  return paths
    .filter((p) => p !== current)
    .map((p) => {
      const o = info(p);
      let score = 0;
      for (const w of o.words) if (cur.words.has(w)) score += 2;
      if (o.words.size && [...o.words].every((w) => cur.words.has(w))) score += 3;
      if (cur.model && o.model === cur.model && o.version < cur.version) score += 10 + o.version;
      return { path: p, score };
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}
