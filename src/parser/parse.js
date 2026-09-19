/**
 * parse.js -- G-code -> structured geometry, for ElegooSlicer / OrcaSlicer output.
 *
 * Pure ESM, no dependencies, runs identically in the browser worker, in Node for
 * the server-side validator, and in the tests.
 *
 * The dialect this targets (verified against the Neptune 4 Max files in ../..):
 *   - ;LAYER:n / ;Z:z / ;TYPE:name / ;WIDTH:w / ;HEIGHT:h annotations on every
 *     extrusion run, so feature type and line width are read, never inferred
 *   - M83 relative extrusion (this is what makes per-segment editing safe:
 *     changing one E does not invalidate every E after it)
 *   - Klipper SET_VELOCITY_LIMIT for acceleration, M106/M107 for fan
 *   - a trailing CONFIG_BLOCK holding the full slicer configuration
 *   - G2/G3 arcs (I/J or R form, helical Z allowed), split into short chords
 *     that stay within ARC_TOLERANCE of the true curve. Every chord keeps the
 *     arc's source line, so one arc line maps to several segments.
 *
 * Output is struct-of-arrays (typed arrays) so it transfers to the GPU and
 * across a worker boundary without a copy.
 */

/** Feature types, in a fixed order so colour indices stay stable across files. */
export const FEATURE_NAMES = [
  'Unknown',
  'Inner wall',
  'Outer wall',
  'Overhang wall',
  'Sparse infill',
  'Internal solid infill',
  'Top surface',
  'Bottom surface',
  'Ironing',
  'Bridge',
  'Internal Bridge',
  'Gap infill',
  'Skirt',
  'Brim',
  'Support',
  'Support interface',
  'Prime tower',
  'Custom',
];

const FEATURE_INDEX = new Map(FEATURE_NAMES.map((n, i) => [n.toLowerCase(), i]));

/** What a move physically is. */
export const KIND = {
  EXTRUDE: 0, // deposits material
  TRAVEL: 1,  // moves without extruding
  RETRACT: 2, // E-only move, negative (pulls filament back)
  PRIME: 3,   // E-only move, positive (pushes it back in)
};

const NUM_CHARS = new Uint8Array(128);
for (const c of '0123456789+-.eE') NUM_CHARS[c.charCodeAt(0)] = 1;

const CH = { X: 88, Y: 89, Z: 90, E: 69, F: 70, S: 83, I: 73, J: 74, R: 82 };

/** Largest gap, in mm, between an arc and the chords that draw it. */
export const ARC_TOLERANCE = 0.02;
const ARC_MAX_PIECES = 720;

/**
 * Read a <LETTER><number> parameter out of a G-code line without allocating.
 * Returns NaN when the letter is absent.
 */
function param(line, letter) {
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line.charCodeAt(i);
    if (ch === 59) return NaN; // ';' -- rest of the line is a comment
    if (ch === letter) {
      let j = i + 1;
      const start = j;
      while (j < n && NUM_CHARS[line.charCodeAt(j)]) j++;
      if (j === start) return NaN;
      return +line.slice(start, j);
    }
    while (i < n && line.charCodeAt(i) !== 32) i++;
    while (i < n && line.charCodeAt(i) === 32) i++;
  }
  return NaN;
}

/** Minimal growable typed arrays (push + trim), one per element type we store. */
function grower(Ctor) {
  return class {
    constructor(cap) { this.a = new Ctor(cap); this.n = 0; }
    push(v) {
      if (this.n === this.a.length) {
        const b = new Ctor(this.a.length * 2);
        b.set(this.a);
        this.a = b;
      }
      this.a[this.n++] = v;
    }
    trim() { return this.a.slice(0, this.n); }
  };
}
const F32 = grower(Float32Array);
const U32 = grower(Uint32Array);
const U8 = grower(Uint8Array);

/**
 * @param {string} text  full G-code file
 * @param {{onProgress?: (frac:number)=>void}} [opts]
 */
export function parseGcode(text, opts = {}) {
  const t0 = Date.now();
  const eol = text.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const lines = text.split('\n');
  const lineCount = lines.length;

  // Upper bound is one move per line; arrays are trimmed at the end.
  const cap = Math.max(1024, lineCount >> 1);
  const x0 = new F32(cap), y0 = new F32(cap), z0 = new F32(cap);
  const x1 = new F32(cap), y1 = new F32(cap), z1 = new F32(cap);
  const eArr = new F32(cap), width = new F32(cap), height = new F32(cap);
  const speed = new F32(cap), fanArr = new F32(cap), tempArr = new F32(cap);
  const accelArr = new F32(cap), timeArr = new F32(cap);
  const feature = new U8(cap), kind = new U8(cap);
  const layerArr = new U32(cap), lineArr = new U32(cap);

  // machine state
  let cx = 0, cy = 0, cz = 0;
  let curFeed = 30;          // mm/s
  let curFeature = 0;
  let curWidth = 0, curHeight = 0;
  let curFan = 0, curTemp = 0, curBed = 0;
  let curAccel = 1000;
  let relativeXYZ = false;
  let layer = -1, layerZ = 0;
  let sawM83 = false;

  const layers = [];
  const warnings = [];
  const config = Object.create(null);
  let inConfig = false;

  const meta = {
    generator: '', layerCount: 0, maxZ: 0, minZ: 0,
    filamentDiameter: 1.75, filamentDensity: 1.24,
    estimatedTimeText: '', estimatedTimeSec: 0,
    filamentUsedMm: 0, filamentUsedCm3: 0, filamentUsedG: 0,
    bedTemp: 0, bedShape: null, eol, lineCount,
  };

  let arcCount = 0;     // arcs drawn
  let arcBad = 0;       // arcs with no usable centre, drawn as straight lines
  const progressEvery = Math.max(1, lineCount >> 5);

  const startLayer = (n) => {
    layer = n;
    layers.push({
      index: n, z: layerZ, firstSeg: x0.n, lastSeg: x0.n,
      lineStart: 0, lineEnd: 0, time: 0, extrudeMm: 0, filamentMm: 0,
      maxFan: 0, temp: curTemp,
    });
  };

  /**
   * Record one straight move from the current position. `dt` is passed in so an
   * arc can share its time out across its chords instead of paying the
   * accelerate-and-stop cost once per chord.
   */
  const emit = (nx, ny, nz, de, dist, dt, li) => {
    let k;
    if (dist <= 1e-9) k = de < 0 ? KIND.RETRACT : KIND.PRIME;
    else if (de > 0) k = KIND.EXTRUDE;
    else k = KIND.TRAVEL;

    x0.push(cx); y0.push(cy); z0.push(cz);
    x1.push(nx); y1.push(ny); z1.push(nz);
    eArr.push(de);
    width.push(k === KIND.EXTRUDE ? curWidth : 0);
    height.push(k === KIND.EXTRUDE ? curHeight : 0);
    speed.push(curFeed);
    fanArr.push(curFan);
    tempArr.push(curTemp);
    accelArr.push(curAccel);
    timeArr.push(dt);
    feature.push(k === KIND.EXTRUDE ? curFeature : 0);
    kind.push(k);
    layerArr.push(layer < 0 ? 0 : layer);
    lineArr.push(li);

    if (layers.length) {
      const L = layers[layers.length - 1];
      L.lastSeg = x0.n;
      L.lineEnd = li;
      L.time += dt;
      if (k === KIND.EXTRUDE) { L.extrudeMm += dist; L.filamentMm += de; }
    }
    cx = nx; cy = ny; cz = nz;
  };

  for (let li = 0; li < lineCount; li++) {
    let line = lines[li];
    if (line.length && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
    if (line.length === 0) continue;

    if (opts.onProgress && (li % progressEvery) === 0) opts.onProgress(li / lineCount);

    const c0 = line.charCodeAt(0);

    // ---- comments & annotations -------------------------------------------
    if (c0 === 59) { // ';'
      if (inConfig) {
        if (line.startsWith('; CONFIG_BLOCK_END')) { inConfig = false; continue; }
        const eq = line.indexOf(' = ');
        if (eq > 2) config[line.slice(2, eq)] = line.slice(eq + 3);
        continue;
      }
      if (line.startsWith(';TYPE:')) {
        const name = line.slice(6).trim();
        const idx = FEATURE_INDEX.get(name.toLowerCase());
        if (idx === undefined) {
          curFeature = 0;
          const w = 'unknown feature type "' + name + '"';
          if (!warnings.includes(w)) warnings.push(w);
        } else curFeature = idx;
      } else if (line.startsWith(';WIDTH:')) {
        curWidth = +line.slice(7);
      } else if (line.startsWith(';HEIGHT:')) {
        curHeight = +line.slice(8);
      } else if (line.startsWith(';LAYER:')) {
        const n = +line.slice(7);
        if (Number.isFinite(n) && n !== layer) {
          startLayer(n);
          layers[layers.length - 1].lineStart = li;
          layers[layers.length - 1].lineEnd = li;
        }
      } else if (line.startsWith(';Z:')) {
        layerZ = +line.slice(3);
        if (layers.length) layers[layers.length - 1].z = layerZ;
      } else if (line.startsWith('; CONFIG_BLOCK_START')) {
        inConfig = true;
      } else if (line.startsWith('; generated by')) {
        meta.generator = line.slice(2).trim();
      } else if (line.startsWith('; total layer number:')) {
        meta.layerCount = +line.slice(21);
      } else if (line.startsWith('; max_z_height:')) {
        meta.maxZ = +line.slice(15);
      } else if (line.startsWith(';MINZ:')) {
        meta.minZ = +line.slice(6);
      } else if (line.startsWith('; filament_diameter:')) {
        meta.filamentDiameter = +line.slice(20);
      } else if (line.startsWith('; filament_density:')) {
        meta.filamentDensity = +line.slice(19);
      } else if (line.startsWith('; estimated printing time')) {
        const eq = line.indexOf('= ');
        if (eq > 0) {
          meta.estimatedTimeText = line.slice(eq + 2).trim();
          meta.estimatedTimeSec = parseDuration(meta.estimatedTimeText);
        }
      } else if (line.startsWith('; filament used [mm] =')) {
        meta.filamentUsedMm = +line.slice(22);
      } else if (line.startsWith('; filament used [cm3] =')) {
        meta.filamentUsedCm3 = +line.slice(23);
      } else if (line.startsWith('; filament used [g] =')) {
        meta.filamentUsedG = +line.slice(21);
      }
      continue;
    }

    // ---- motion -----------------------------------------------------------
    if (c0 === 71) { // 'G'
      const c1 = line.charCodeAt(1);
      const c2 = line.length > 2 ? line.charCodeAt(2) : 32;
      const isMove = (c1 === 48 || c1 === 49) && (c2 === 32 || c2 === 59);

      if (isMove) {
        const px = param(line, CH.X);
        const py = param(line, CH.Y);
        const pz = param(line, CH.Z);
        const pe = param(line, CH.E);
        const pf = param(line, CH.F);
        if (!Number.isNaN(pf)) curFeed = pf / 60;

        const nx = Number.isNaN(px) ? cx : (relativeXYZ ? cx + px : px);
        const ny = Number.isNaN(py) ? cy : (relativeXYZ ? cy + py : py);
        const nz = Number.isNaN(pz) ? cz : (relativeXYZ ? cz + pz : pz);
        const de = Number.isNaN(pe) ? 0 : pe; // relative mode: E is the delta

        const dx = nx - cx, dy = ny - cy, dz = nz - cz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        if (dist > 1e-9 || de !== 0) emit(nx, ny, nz, de, dist, moveTime(dist, curFeed, curAccel), li);
        cx = nx; cy = ny; cz = nz;
        continue;
      }

      if ((c1 === 50 || c1 === 51) && (c2 === 32 || c2 === 59)) {    // G2 / G3
        const clockwise = c1 === 50;
        const px = param(line, CH.X), py = param(line, CH.Y), pz = param(line, CH.Z);
        const pe = param(line, CH.E), pf = param(line, CH.F);
        const pi = param(line, CH.I), pj = param(line, CH.J), pr = param(line, CH.R);
        if (!Number.isNaN(pf)) curFeed = pf / 60;

        const nx = Number.isNaN(px) ? cx : (relativeXYZ ? cx + px : px);
        const ny = Number.isNaN(py) ? cy : (relativeXYZ ? cy + py : py);
        const nz = Number.isNaN(pz) ? cz : (relativeXYZ ? cz + pz : pz);
        const de = Number.isNaN(pe) ? 0 : pe;

        const arc = arcGeometry(cx, cy, nx, ny, clockwise, pi, pj, pr);
        if (!arc) {
          // No usable centre: draw it straight so position stays right, and say so.
          arcBad++;
          const dx = nx - cx, dy = ny - cy, dz = nz - cz;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist > 1e-9 || de !== 0) emit(nx, ny, nz, de, dist, moveTime(dist, curFeed, curAccel), li);
          cx = nx; cy = ny; cz = nz;
          continue;
        }
        arcCount++;

        const { ox, oy, r, a0, sweep } = arc;
        const planar = Math.abs(sweep) * r;
        const rise = nz - cz;
        const total = Math.sqrt(planar * planar + rise * rise);
        const chord = Math.sqrt(8 * r * ARC_TOLERANCE);
        const pieces = Math.max(1, Math.min(ARC_MAX_PIECES, Math.ceil(planar / Math.max(chord, 1e-3))));
        const dt = moveTime(total, curFeed, curAccel) / pieces;
        const z0a = cz;
        for (let p = 1; p <= pieces; p++) {
          const last = p === pieces;
          const a = a0 + (sweep * p) / pieces;
          // The last chord ends exactly on the commanded point, not on the
          // (rounded) circle, so the next move starts where the printer is.
          const ex = last ? nx : ox + r * Math.cos(a);
          const ey = last ? ny : oy + r * Math.sin(a);
          const ez = last ? nz : z0a + (rise * p) / pieces;
          const dx = ex - cx, dy = ey - cy, dz = ez - cz;
          emit(ex, ey, ez, de / pieces, Math.sqrt(dx * dx + dy * dy + dz * dz), dt, li);
        }
        cx = nx; cy = ny; cz = nz;
        continue;
      }
      if (c1 === 57 && c2 === 48) { relativeXYZ = false; continue; } // G90
      if (c1 === 57 && c2 === 49) { relativeXYZ = true; continue; }  // G91
      continue;
    }

    // ---- machine state ----------------------------------------------------
    if (c0 === 77) { // 'M'
      if (line.startsWith('M106')) {
        const s = param(line, CH.S);
        curFan = Number.isNaN(s) ? 1 : s / 255;
        if (layers.length) {
          const L = layers[layers.length - 1];
          if (curFan > L.maxFan) L.maxFan = curFan;
        }
      } else if (line.startsWith('M107')) {
        curFan = 0;
      } else if (line.startsWith('M104') || line.startsWith('M109')) {
        const s = param(line, CH.S);
        if (!Number.isNaN(s)) {
          curTemp = s;
          if (layers.length) layers[layers.length - 1].temp = s;
        }
      } else if (line.startsWith('M140') || line.startsWith('M190')) {
        const s = param(line, CH.S);
        if (!Number.isNaN(s)) curBed = s;
      } else if (line.startsWith('M204')) {
        const s = param(line, CH.S);
        if (!Number.isNaN(s)) curAccel = s;
      } else if (line.startsWith('M83')) {
        sawM83 = true;
      }
      continue;
    }

    if (line.startsWith('SET_VELOCITY_LIMIT')) {
      const m = /ACCEL=([0-9.]+)/.exec(line);
      if (m) curAccel = +m[1];
      continue;
    }
  }

  meta.bedTemp = curBed;

  if (!sawM83) {
    warnings.push('file does not use M83 relative extrusion; per-segment E edits are disabled');
  }
  if (arcBad) warnings.push(arcBad + ' arc move(s) (G2/G3) had no usable centre and are drawn as straight lines');

  if (config.bed_shape) {
    meta.bedShape = config.bed_shape.split(',').map((p) => p.split('x').map(Number));
  }

  // Our trapezoidal model ignores jerk and lookahead, so the per-move shape is
  // right but the absolute total drifts. The slicer's own figure is
  // authoritative -- anchor to it and keep the distribution.
  const timeRaw = timeArr.trim();
  let rawTotal = 0;
  for (let i = 0; i < timeRaw.length; i++) rawTotal += timeRaw[i];
  let timeScale = 1;
  if (meta.estimatedTimeSec > 0 && rawTotal > 0) {
    timeScale = meta.estimatedTimeSec / rawTotal;
    for (let i = 0; i < timeArr.n; i++) timeArr.a[i] *= timeScale;
    for (const L of layers) L.time *= timeScale;
  }

  const segments = {
    x0: x0.trim(), y0: y0.trim(), z0: z0.trim(),
    x1: x1.trim(), y1: y1.trim(), z1: z1.trim(),
    e: eArr.trim(), width: width.trim(), height: height.trim(),
    speed: speed.trim(), fan: fanArr.trim(), temp: tempArr.trim(),
    accel: accelArr.trim(), time: timeArr.trim(),
    feature: feature.trim(), kind: kind.trim(),
    layer: layerArr.trim(), line: lineArr.trim(),
  };

  if (!meta.layerCount) meta.layerCount = layers.length;

  return {
    meta, config, segments, layers, warnings,
    count: x0.n,
    relativeE: sawM83,
    arcCount,
    timeScale,
    parseMs: Date.now() - t0,
  };
}

/**
 * Centre, radius, start angle and signed sweep of a G2/G3 arc in the XY plane.
 * I/J are offsets from the start point to the centre; R is the radius
 * (negative R = the long way round, > 180 degrees). Returns null when neither
 * form gives a usable centre.
 * A start equal to the end with I/J is a full circle.
 */
export function arcGeometry(sx, sy, ex, ey, clockwise, I, J, R) {
  let ox, oy;
  if (!Number.isNaN(I) || !Number.isNaN(J)) {
    ox = sx + (Number.isNaN(I) ? 0 : I);
    oy = sy + (Number.isNaN(J) ? 0 : J);
  } else if (!Number.isNaN(R) && R !== 0) {
    const dx = ex - sx, dy = ey - sy;
    const d = Math.hypot(dx, dy);
    const rr = Math.abs(R);
    if (d < 1e-9 || d > 2 * rr + 1e-6) return null;
    const h = Math.sqrt(Math.max(0, rr * rr - (d / 2) * (d / 2)));
    // For a counter-clockwise arc under 180 degrees the centre is to the left
    // of start->end; clockwise flips it, and a negative R flips it again.
    let side = clockwise ? -1 : 1;
    if (R < 0) side = -side;
    ox = (sx + ex) / 2 - (side * h * dy) / d;
    oy = (sy + ey) / 2 + (side * h * dx) / d;
  } else {
    return null;
  }
  const r = Math.hypot(sx - ox, sy - oy);
  if (!(r > 1e-6)) return null;
  const a0 = Math.atan2(sy - oy, sx - ox);
  const a1 = Math.atan2(ey - oy, ex - ox);
  let sweep = a1 - a0;
  if (Math.abs(sweep) < 1e-9) sweep = 0;
  if (clockwise) { if (sweep >= 0) sweep -= 2 * Math.PI; }
  else if (sweep <= 0) sweep += 2 * Math.PI;
  return { ox, oy, r, a0, sweep };
}

/**
 * Trapezoidal move time: accelerate to the feedrate, cruise, decelerate.
 * Assumes each move starts and ends at rest, which over-estimates short moves;
 * parseGcode rescales against the slicer's own total to correct for that.
 */
function moveTime(dist, feed, accel) {
  if (dist <= 0 || feed <= 0) return 0;
  if (accel <= 0) return dist / feed;
  const rampDist = (feed * feed) / accel; // accelerate + decelerate
  if (rampDist >= dist) return 2 * Math.sqrt(dist / accel);
  return (2 * feed) / accel + (dist - rampDist) / feed;
}

/** "1h 11m 5s" / "49m 15s" -> seconds */
export function parseDuration(text) {
  const unit = { d: 86400, h: 3600, m: 60, s: 1 };
  let total = 0;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/g)) total += +m[1] * unit[m[2]];
  return total;
}

/** seconds -> "1h 11m" / "49m 15s" */
export function formatDuration(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return h + 'h ' + m + 'm';
  if (m) return m + 'm ' + s + 's';
  return s + 's';
}

/** Volumetric flow (mm^3/s) for one segment. */
export function flowRate(seg, i, filamentDiameter = 1.75) {
  if (seg.time[i] <= 0) return 0;
  const area = Math.PI * (filamentDiameter / 2) ** 2;
  return (seg.e[i] * area) / seg.time[i];
}

/** Length of one segment in mm. */
export function segLength(seg, i) {
  const dx = seg.x1[i] - seg.x0[i], dy = seg.y1[i] - seg.y0[i], dz = seg.z1[i] - seg.z0[i];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
