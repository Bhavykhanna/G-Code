/**
 * printcheck.js -- find the spots in a G-code where the nozzle is likely to
 * damage the part: tiny islands that soak up heat and blobs, travel moves that
 * skim fresh plastic at layer height, and spans over air that print fast or
 * with a fan that has no time to spin up. Pure (typed arrays in, plain objects
 * out); used by server/print-check-cli.js and tested by test/check-printcheck.js.
 *
 * Why (2026-09-17): a printed part came out with the tops of its divider
 * openings melted and a little black -- the nozzle had touched them. The
 * slicer settings were the reference ones; the cause was the shape (8 tiny
 * bars, 3.6 mm spans) meeting those settings. This check finds such places in
 * any file before it is printed.
 *
 * Also (user, 2026-09-17: "other generic checks like the nozzle hitting the part
 * or being too close in travel"): moves whose nozzle is below plastic printed on
 * earlier layers, long unlifted travels over fresh plastic, and lines printed
 * over a line of the same layer (double extrusion). checkScrewSeats (below)
 * warns about thin plastic under screw heads.
 *
 * Everything is grouped into CELL x CELL mm squares of the bed, so a report
 * names places, not thousands of moves.
 */

import { KIND, FEATURE_NAMES } from './parser/parse.js';

export const CHECK_DEFAULTS = {
  cell: 5,              // mm, grouping square
  islandMax: 2.0,       // mm, a run between push-out and pull-back smaller than this is a "tiny island"
  lowClearance: 0.1,    // mm, nozzle this close above the layer top counts as touching
  gridRes: 0.3,         // mm, raster of "already printed on this layer"
  spanMin: 2.0,         // mm, overhang / bridge runs shorter than this are ignored
  spanFastSpeed: 50,    // mm/s, spans faster than this are flagged
  burstJump: 0.3,       // fan fraction: a span fan this much above the layer's normal fan is a short burst
  longSkim: 3.0,        // mm, one unlifted travel over this much fresh plastic is reported on its own
  collideTol: 0.05,     // mm, nozzle this far below earlier plastic = collision
  doubleRes: 0.1,       // mm, raster of centrelines for the double-extrusion check
  doubleMin: 0.8,       // mm, a line must lie this long on an earlier centreline to count
};

const SPAN_FEATURES = new Set(['Overhang wall', 'Bridge']);
// surfaces a dragging nozzle marks (long unlifted travels are only counted over these)
const VISIBLE_FEATURES = new Set(['Outer wall', 'Top surface', 'Overhang wall', 'Bridge']);
// laid over plastic of the same layer on purpose
const OVERPRINT_FEATURES = new Set(['Ironing']);

/**
 * @param {object} parse  parseGcode() result
 * @param {object} [opts] see CHECK_DEFAULTS
 * @returns {{islands: object[], lowTravel: object[], spans: object[], findings: object[], summary: object}}
 */
export function checkPrint(parse, opts = {}) {
  const o = { ...CHECK_DEFAULTS, ...opts };
  const s = parse.segments;
  const n = parse.count;
  const spanFeat = new Uint8Array(256);
  FEATURE_NAMES.forEach((name, i) => { if (SPAN_FEATURES.has(name)) spanFeat[i] = 1; });
  const visFeat = new Uint8Array(256), overFeat = new Uint8Array(256);
  FEATURE_NAMES.forEach((name, i) => {
    if (VISIBLE_FEATURES.has(name)) visFeat[i] = 1;
    if (OVERPRINT_FEATURES.has(name)) overFeat[i] = 1;
  });

  // layer top z and the "normal" fan of each layer (the fan most of its plastic prints with)
  const layerZ = new Map();
  const fanMM = new Map();   // layer -> Map(fan -> mm)
  for (let i = 0; i < n; i++) {
    if (s.kind[i] !== KIND.EXTRUDE) continue;
    const L = s.layer[i];
    layerZ.set(L, Math.max(layerZ.get(L) || 0, s.z1[i]));
    const len = Math.hypot(s.x1[i] - s.x0[i], s.y1[i] - s.y0[i]);
    const m = fanMM.get(L) || new Map();
    const f = Math.round(s.fan[i] * 100) / 100;
    m.set(f, (m.get(f) || 0) + len);
    fanMM.set(L, m);
  }
  const layerFan = new Map();
  for (const [L, m] of fanMM) layerFan.set(L, [...m].sort((a, b) => b[1] - a[1])[0][0]);

  const cellKey = (x, y) => `${Math.floor(x / o.cell)},${Math.floor(y / o.cell)}`;
  const group = (map, x, y) => {
    const k = cellKey(x, y);
    let g = map.get(k);
    if (!g) {
      g = { cell: k, x: 0, y: 0, w: 0, count: 0, mm: 0, layers: new Set(), sizes: new Set(), speeds: new Set(), fans: new Set() };
      map.set(k, g);
    }
    g.x += x; g.y += y; g.w += 1;
    return g;
  };

  const islands = new Map(), low = new Map(), spans = new Map();
  const collide = new Map(), longSkims = new Map(), doubled = new Map();

  // top of the plastic printed on EARLIER layers (committed when a layer ends)
  const HR = 0.5;
  const hkey = (x, y) => Math.floor(x / HR) * 100000 + Math.floor(y / HR);
  const height = new Map();
  let layerTops = [];         // [key, z] of the layer being printed
  const commitLayer = () => {
    for (const [k, z] of layerTops) if (!(height.get(k) >= z)) height.set(k, z);
    layerTops = [];
  };
  // centrelines of this layer: cell -> index of the move that laid it
  const DR = o.doubleRes;
  const dkey = (x, y) => Math.floor(x / DR) * 1000000 + Math.floor(y / DR);
  let centres = new Map();

  // walk in file order: per layer, a raster of what is already printed
  const R = o.gridRes;
  let printed = new Set(), visible = new Set(), curL = -1;
  const rkey = (x, y) => Math.floor(x / R) * 100000 + Math.floor(y / R);
  const markPrinted = (i, into = printed) => {
    const hw = Math.max(R / 2, s.width[i] / 2);
    const len = Math.hypot(s.x1[i] - s.x0[i], s.y1[i] - s.y0[i]);
    const steps = Math.max(1, Math.ceil(len / (R / 2)));
    for (let k = 0; k <= steps; k++) {
      const x = s.x0[i] + (s.x1[i] - s.x0[i]) * k / steps;
      const y = s.y0[i] + (s.y1[i] - s.y0[i]) * k / steps;
      for (let ox = -hw; ox <= hw + 1e-9; ox += R / 2) {
        for (let oy = -hw; oy <= hw + 1e-9; oy += R / 2) into.add(rkey(x + ox, y + oy));
      }
    }
  };

  let run = null;       // extrusion since the last push-out
  let span = null;      // consecutive overhang / bridge moves
  const closeSpan = () => {
    if (!span) return;
    if (span.mm >= o.spanMin) {
      const g = group(spans, span.x, span.y);
      g.count++; g.mm += span.mm; g.layers.add(span.L);
      g.speeds.add(Math.round(span.maxSpeed));
      g.fans.add(Math.round(span.fan * 100));
      const base = layerFan.get(span.L) || 0;
      g.fast = (g.fast || 0) + (span.maxSpeed > o.spanFastSpeed ? 1 : 0);
      g.burst = (g.burst || 0) + (span.fan - base >= o.burstJump ? 1 : 0);
      g.layerFans = g.layerFans || new Set();
      g.layerFans.add(Math.round(base * 100));
    }
    span = null;
  };

  for (let i = 0; i < n; i++) {
    const L = s.layer[i];
    if (L !== curL) { printed = new Set(); visible = new Set(); centres = new Map(); commitLayer(); curL = L; closeSpan(); }
    const k = s.kind[i];

    if (k === KIND.EXTRUDE) {
      const len = Math.hypot(s.x1[i] - s.x0[i], s.y1[i] - s.y0[i]);
      // double extrusion: this line runs on a centreline laid a few moves earlier
      const dsteps = overFeat[s.feature[i]] ? -1 : Math.max(1, Math.ceil(len / (DR / 2)));
      let on = 0, hitX = 0, hitY = 0;
      const mine = [];
      for (let t = 0; t <= dsteps; t++) {
        const x = s.x0[i] + (s.x1[i] - s.x0[i]) * t / dsteps;
        const y = s.y0[i] + (s.y1[i] - s.y0[i]) * t / dsteps;
        const dk = dkey(x, y);
        const prev = centres.get(dk);
        if (prev !== undefined && i - prev > 1) { if (!on) { hitX = x; hitY = y; } on++; }
        mine.push(dk);
      }
      for (const dk of mine) centres.set(dk, i);
      if (on * len / dsteps >= o.doubleMin && s.width[i] > 0) {
        const g = group(doubled, hitX, hitY);
        g.count++; g.mm += on * len / dsteps; g.layers.add(L);
      }
      // nozzle inside plastic from earlier layers
      const top = s.z1[i];
      for (const [x, y] of [[s.x0[i], s.y0[i]], [(s.x0[i] + s.x1[i]) / 2, (s.y0[i] + s.y1[i]) / 2], [s.x1[i], s.y1[i]]]) {
        const hz = height.get(hkey(x, y));
        if (hz !== undefined && top < hz - o.collideTol) {
          const g = group(collide, x, y);
          g.count++; g.layers.add(L); g.mm = Math.max(g.mm, hz - top);
          break;
        }
      }
      layerTops.push([hkey((s.x0[i] + s.x1[i]) / 2, (s.y0[i] + s.y1[i]) / 2), top]);
      markPrinted(i);
      if (visFeat[s.feature[i]]) markPrinted(i, visible);
      if (!run) run = { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, L };
      run.x0 = Math.min(run.x0, s.x0[i], s.x1[i]); run.x1 = Math.max(run.x1, s.x0[i], s.x1[i]);
      run.y0 = Math.min(run.y0, s.y0[i], s.y1[i]); run.y1 = Math.max(run.y1, s.y0[i], s.y1[i]);
      if (spanFeat[s.feature[i]]) {
        if (!span) span = { mm: 0, x: 0, y: 0, maxSpeed: 0, fan: 0, L };
        span.mm += len;
        span.x = (s.x0[i] + s.x1[i]) / 2; span.y = (s.y0[i] + s.y1[i]) / 2;
        span.maxSpeed = Math.max(span.maxSpeed, s.speed[i]);
        span.fan = Math.max(span.fan, s.fan[i]);
      } else closeSpan();
      continue;
    }
    closeSpan();

    if (k === KIND.RETRACT) {
      if (run && run.L > 0) {
        const w = run.x1 - run.x0, h = run.y1 - run.y0;
        if (Math.max(w, h) < o.islandMax) {
          const cx = (run.x0 + run.x1) / 2, cy = (run.y0 + run.y1) / 2;
          const g = group(islands, cx, cy);
          g.count++; g.layers.add(run.L); g.sizes.add(`${w.toFixed(1)}x${h.toFixed(1)}`);
          g.fans.add(Math.round((layerFan.get(run.L) || 0) * 100));
        }
      }
      run = null;
      continue;
    }
    if (k !== KIND.TRAVEL) continue;

    const z = layerZ.get(L);
    if (z === undefined) continue;
    const len = Math.hypot(s.x1[i] - s.x0[i], s.y1[i] - s.y0[i]);
    if (len < 0.05) continue;
    const steps = Math.ceil(len / 0.1);
    let hits = 0, hx = 0, hy = 0, vis = 0, vx = 0, vy = 0, hitCol = false, cx = 0, cy = 0, depth = 0;
    for (let t = 0; t <= steps; t++) {
      const x = s.x0[i] + (s.x1[i] - s.x0[i]) * t / steps;
      const y = s.y0[i] + (s.y1[i] - s.y0[i]) * t / steps;
      const zz = s.z0[i] + (s.z1[i] - s.z0[i]) * t / steps;
      if (zz - z < o.lowClearance && printed.has(rkey(x, y))) {
        if (!hits) { hx = x; hy = y; }
        hits++;
        if (visible.has(rkey(x, y))) { if (!vis) { vx = x; vy = y; } vis++; }
      }
      const hz = height.get(hkey(x, y));
      if (hz !== undefined && zz < hz - o.collideTol && hz - zz > depth) { hitCol = true; cx = x; cy = y; depth = hz - zz; }
    }
    if (hitCol) {
      const g = group(collide, cx, cy);
      g.count++; g.layers.add(L); g.mm = Math.max(g.mm, depth);
      g.speeds.add(Math.round(s.speed[i]));
    }
    if (!hits) continue;
    const g = group(low, hx, hy);
    g.count++; g.mm += hits * len / steps; g.layers.add(L);
    g.speeds.add(Math.round(s.speed[i]));
    if (vis * len / steps >= o.longSkim) {
      const q = group(longSkims, vx, vy);
      q.count++; q.mm = Math.max(q.mm, vis * len / steps); q.layers.add(L);
      q.speeds.add(Math.round(s.speed[i]));
    }
  }
  closeSpan();
  commitLayer();

  const finish = (map) => [...map.values()].map((g) => {
    const Ls = [...g.layers].sort((a, b) => a - b);
    return {
      cell: g.cell, x: +(g.x / g.w).toFixed(1), y: +(g.y / g.w).toFixed(1),
      count: g.count, mm: +g.mm.toFixed(1), layers: Ls.length, layerFrom: Ls[0], layerTo: Ls.at(-1),
      zFrom: +(layerZ.get(Ls[0]) || 0).toFixed(2), zTo: +(layerZ.get(Ls.at(-1)) || 0).toFixed(2),
      sizes: [...g.sizes], speeds: [...g.speeds].sort((a, b) => a - b), fans: [...g.fans].sort((a, b) => a - b),
      fast: g.fast || 0, burst: g.burst || 0, layerFans: g.layerFans ? [...g.layerFans].sort((a, b) => a - b) : [],
    };
  });
  const I = finish(islands).sort((a, b) => b.count - a.count);
  const T = finish(low).sort((a, b) => b.mm - a.mm);
  const S = finish(spans).sort((a, b) => b.mm - a.mm);
  const C = finish(collide).sort((a, b) => b.count - a.count);
  const K = finish(longSkims).sort((a, b) => b.count - a.count);
  const D = finish(doubled).sort((a, b) => b.mm - a.mm);

  // findings: combine the three by cell
  const findings = [];
  const lowBy = new Map(T.map((t) => [t.cell, t]));
  for (const is of I) {
    if (is.layers < 3) continue;
    const t = lowBy.get(is.cell);
    const hot = is.fans.length && Math.max(...is.fans) <= 30;
    findings.push({
      level: t ? 'HIGH' : 'MEDIUM', kind: 'tiny islands', x: is.x, y: is.y,
      text: `${is.count} tiny islands (${is.sizes.slice(0, 3).join(', ')} mm) on ${is.layers} layers, Z ${is.zFrom}-${is.zTo}` +
        `, each with its own pull-back / push-out` + (hot ? `, fan only ${is.fans.join('/')} %` : '') +
        (t ? `; the nozzle also skims plastic here at layer height (${t.count} moves, ${t.mm} mm)` : ''),
    });
  }
  for (const sp of S) {
    if (!sp.fast && !sp.burst) continue;
    findings.push({
      level: sp.fast && sp.burst ? 'HIGH' : 'MEDIUM', kind: 'spans over air', x: sp.x, y: sp.y,
      text: `${sp.count} overhang / bridge runs (${sp.mm} mm) on ${sp.layers} layer(s), Z ${sp.zFrom}-${sp.zTo}` +
        (sp.fast ? `, up to ${Math.max(...sp.speeds)} mm/s` : '') +
        (sp.burst ? `, fan ${sp.fans.join('/')} % only while spanning (layer fan ${sp.layerFans.join('/')} %) -- too short to spin up` : ''),
    });
  }
  for (const c of C) {
    findings.push({
      level: 'HIGH', kind: 'nozzle inside the part', x: c.x, y: c.y, zFrom: c.zFrom, zTo: c.zTo,
      text: `${c.count} move(s) on ${c.layers} layer(s), Z ${c.zFrom}-${c.zTo}, go up to ${c.mm.toFixed(2)} mm below plastic printed earlier`,
    });
  }
  for (const k of K) {
    if (k.count < 3) continue;
    findings.push({
      level: 'MEDIUM', kind: 'long unlifted travel', x: k.x, y: k.y, zFrom: k.zFrom, zTo: k.zTo,
      text: `${k.count} travels without a lift cross >= ${o.longSkim} mm of fresh outer wall / top surface (longest ${k.mm.toFixed(1)} mm) on ${k.layers} layer(s), Z ${k.zFrom}-${k.zTo}, at ${k.speeds.join('/')} mm/s`,
    });
  }
  for (const d of D) {
    if (d.count < 5) continue;
    findings.push({
      level: 'MEDIUM', kind: 'printed twice', x: d.x, y: d.y, zFrom: d.zFrom, zTo: d.zTo,
      text: `${d.count} lines (${d.mm.toFixed(0)} mm) are laid on a line already printed on the same layer, ${d.layers} layer(s), Z ${d.zFrom}-${d.zTo}`,
    });
  }
  for (const f of findings) {
    if (f.zFrom === undefined) {
      const src = [...I, ...S].find((g) => g.x === f.x && g.y === f.y);
      if (src) { f.zFrom = src.zFrom; f.zTo = src.zTo; }
    }
  }
  const rank = { HIGH: 0, MEDIUM: 1 };
  findings.sort((a, b) => rank[a.level] - rank[b.level] || a.y - b.y || a.x - b.x);

  return {
    islands: I, lowTravel: T, spans: S, collisions: C, longSkims: K, doubled: D, findings,
    summary: {
      islands: I.reduce((a, g) => a + g.count, 0),
      lowTravelMoves: T.reduce((a, g) => a + g.count, 0),
      lowTravelMm: +T.reduce((a, g) => a + g.mm, 0).toFixed(0),
      spanRuns: S.reduce((a, g) => a + g.count, 0),
      collisions: C.reduce((a, g) => a + g.count, 0),
      longSkims: K.reduce((a, g) => a + g.count, 0),
      doubled: D.reduce((a, g) => a + g.count, 0),
      high: findings.filter((f) => f.level === 'HIGH').length,
      medium: findings.filter((f) => f.level === 'MEDIUM').length,
    },
  };
}

/* ------------------------------------------------------------ screw seats */

export const SEAT_DEFAULTS = {
  minSeat: 1.5,        // mm of plastic wanted between a head pocket and the top of the shaft hole
  maxHoleR: 6,         // mm, larger round loops are not screw holes
  pocketStep: 0.6,     // mm, a pocket is at least this much wider (radius) than the shaft
  pocketRatio: 1.25,   // ...and at least this many times the shaft radius: a head pocket is much
                       // wider, while first-layer widening is a few per cent
  maxDev: 0.12,        // radius scatter / mean radius, sampled along the path
  maxRound: 1.10,      // rMax/rMin: a hexagon is 1.155, a polygonised circle 1.01-1.08
  sampleStep: 0.3,     // mm between radius samples along a loop
};

const WALLS = new Set(['Inner wall', 'Outer wall', 'Overhang wall']);

/**
 * Shape of a closed run of wall moves, measured ALONG the path: centre, mean
 * radius, the scatter of that radius, and rMin / rMax.
 * Why the samples (2026-09-19): reading the radius only at the ends of the moves
 * makes any straight-edged hole look perfectly round -- every end point of a
 * hexagon is a corner, so they all sit at the same radius (rMax/rMin 1.008), and
 * the hexagon holes of a phone case were reported as screw holes. Sampled along
 * the edges a hexagon reads 1.155 and a polygonised circle 1.01-1.08.
 * @returns {{cx: number, cy: number, r: number, dev: number, rMin: number, rMax: number}|null}
 */
function loopShape(s, run, step = 0.3) {
  let per = 0;
  for (const i of run) per += Math.hypot(s.x1[i] - s.x0[i], s.y1[i] - s.y0[i]);
  if (!(per > 0)) return null;
  const st = Math.max(step, per / 256);          // bounded work per loop
  const px = [], py = [];
  for (const i of run) {
    const dx = s.x1[i] - s.x0[i], dy = s.y1[i] - s.y0[i];
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / st));
    for (let k = 0; k < n; k++) { px.push(s.x0[i] + (dx * k) / n); py.push(s.y0[i] + (dy * k) / n); }
  }
  const n = px.length;
  let cx = 0, cy = 0;
  for (let k = 0; k < n; k++) { cx += px[k]; cy += py[k]; }
  cx /= n; cy /= n;                              // evenly spaced samples, so this is the outline's centre
  let sum = 0, sum2 = 0, rMin = 1e9, rMax = 0;
  for (let k = 0; k < n; k++) {
    const r = Math.hypot(px[k] - cx, py[k] - cy);
    sum += r; sum2 += r * r;
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
  }
  const r = sum / n;
  if (!(rMin > 0)) return null;
  return { cx, cy, r, dev: Math.sqrt(Math.max(0, sum2 / n - r * r)), rMin, rMax };
}

/**
 * Screw holes with a head pocket underneath (measured case: pocket r 3.15 up
 * to Z 2.4, shaft r 1.75 through the floor). Found from the round wall loops
 * around them, layer by layer. `seat` = plastic between the top of the pocket
 * and the top of the shaft wall (what the screw head pulls against).
 * Why (2026-09-17): thinning the base floor left 0.8 mm under the heads; the
 * user wants a warning whenever that happens again.
 * @returns {{holes: object[], findings: object[]}}
 */
export function checkScrewSeats(parse, opts = {}) {
  const o = { ...SEAT_DEFAULTS, ...opts };
  const s = parse.segments;
  const wall = new Uint8Array(256);
  FEATURE_NAMES.forEach((name, i) => { if (WALLS.has(name)) wall[i] = 1; });

  // closed round loops per layer
  const loops = [];
  let run = [];
  const closeRun = () => {
    if (run.length >= 6) {
      const a = run[0], b = run[run.length - 1];
      if (Math.hypot(s.x0[a] - s.x1[b], s.y0[a] - s.y1[b]) < 0.35) {
        // cheap bounding box first (both ends of every move), so only small,
        // roughly square loops are worth sampling
        let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
        for (const i of run) {
          x0 = Math.min(x0, s.x0[i], s.x1[i]); x1 = Math.max(x1, s.x0[i], s.x1[i]);
          y0 = Math.min(y0, s.y0[i], s.y1[i]); y1 = Math.max(y1, s.y0[i], s.y1[i]);
        }
        const w = x1 - x0, h = y1 - y0;
        if (w > 0.5 && h > 0.5 && Math.max(w, h) / Math.min(w, h) < 1.25 && Math.max(w, h) <= 2.4 * o.maxHoleR) {
          const q = loopShape(s, run, o.sampleStep);
          if (q && q.r <= o.maxHoleR && q.dev / q.r < o.maxDev && q.rMax / q.rMin < o.maxRound) {
            loops.push({ L: s.layer[a], z: s.z1[a], cx: q.cx, cy: q.cy, r: q.r });
          }
        }
      }
    }
    run = [];
  };
  for (let i = 0; i < parse.count; i++) {
    if (s.kind[i] === KIND.EXTRUDE && wall[s.feature[i]]) {
      if (run.length) {
        const p = run[run.length - 1];
        if (Math.hypot(s.x1[p] - s.x0[i], s.y1[p] - s.y0[i]) > 0.05) closeRun();
      }
      run.push(i);
    } else closeRun();
  }
  closeRun();

  // group by centre, innermost loop per layer
  const groups = [];
  const grid = new Map();   // 1 mm cells -> groups, so grouping stays linear
  const gkey = (x, y) => Math.floor(x) * 10000 + Math.floor(y);
  for (const l of loops) {
    let g = null;
    for (let dx = -1; dx <= 1 && !g; dx++) {
      for (let dy = -1; dy <= 1 && !g; dy++) {
        for (const q of grid.get(gkey(l.cx + dx, l.cy + dy)) || []) {
          if (Math.hypot(q.cx - l.cx, q.cy - l.cy) < 0.8) { g = q; break; }
        }
      }
    }
    if (!g) {
      g = { cx: l.cx, cy: l.cy, byL: new Map() };
      groups.push(g);
      const k = gkey(l.cx, l.cy);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(g);
    }
    const cur = g.byL.get(l.L);
    if (!cur || l.r < cur.r) g.byL.set(l.L, { z: l.z, r: l.r });
  }

  const holes = [], findings = [];
  for (const g of groups) {
    const rows = [...g.byL].sort((a, b) => a[0] - b[0]).map(([L, v]) => ({ L, ...v }));
    if (rows.length < 4) continue;
    const shaftR = Math.min(...rows.map((q) => q.r));
    // a head pocket is much wider than the shaft, not a few per cent wider: that keeps
    // the first layer's elephant-foot widening, and a chamfer at the mouth of a hole,
    // from reading as a pocket
    const isPocket = (q) => q.r > shaftR + o.pocketStep && q.r > shaftR * o.pocketRatio;
    // the last pocket layer that has shaft layers above it
    let k = -1;
    for (let j = 0; j < rows.length - 1; j++) if (isPocket(rows[j]) && !isPocket(rows[j + 1])) { k = j; break; }
    const hole = { x: +g.cx.toFixed(1), y: +g.cy.toFixed(1), shaftR: +shaftR.toFixed(2), layers: rows.length, pocket: k >= 0 };
    if (k >= 0) {
      let top = k + 1;
      while (top + 1 < rows.length && !isPocket(rows[top + 1]) && rows[top + 1].L === rows[top].L + 1) top++;
      hole.pocketR = +rows[k].r.toFixed(2);
      hole.pocketTop = +rows[k].z.toFixed(2);
      hole.shaftTop = +rows[top].z.toFixed(2);
      hole.seat = +(rows[top].z - rows[k].z).toFixed(2);
      if (hole.seat < o.minSeat) {
        findings.push({
          level: 'HIGH', kind: 'thin screw seat', x: hole.x, y: hole.y, zFrom: hole.pocketTop, zTo: hole.shaftTop,
          text: `screw hole (shaft r ${hole.shaftR}, head pocket r ${hole.pocketR} up to Z ${hole.pocketTop}): only ${hole.seat} mm of plastic ` +
            `under the head (shaft wall ends at Z ${hole.shaftTop}); wanted >= ${o.minSeat} mm`,
        });
      }
    }
    holes.push(hole);
  }
  holes.sort((a, b) => a.y - b.y || a.x - b.x);
  return { holes, findings };
}
