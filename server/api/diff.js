/**
 * diff.js -- A/B compare two G-code files.
 *
 * "Where did the five minutes go between v3 and v4" is the question this
 * answers, and it answers it in three layers:
 *
 *   1. settings   -- the CONFIG_BLOCK of each file (624 keys on these files),
 *                    reduced to only the keys whose values differ. This is the
 *                    killer feature: the slicer will not tell you what changed
 *                    between two exports, but the exports themselves will.
 *   2. per layer  -- time and filament, layer by layer, aligned by index.
 *   3. per feature-- time and extruded length per feature type.
 *
 * The time figures come from the parser's per-segment model, which is rescaled
 * so each file's total matches its own slicer estimate. That makes the totals
 * exact and the per-layer split a good approximation -- see CONTEXT-parser.md.
 */
import { KIND, FEATURE_NAMES, formatDuration } from '../../src/parser/parse.js';
import { HttpError, parseFile, relPath } from './files.js';
import path from 'node:path';

/**
 * GET /api/diff?a=<path>&b=<path>
 * @returns the object documented in docs/CONTEXT-server.md
 */
export async function handleDiff(aPath, bPath, opts = {}) {
  if (!aPath || !bPath) throw new HttpError(400, 'both a and b are required');
  const [A, B] = await Promise.all([parseFile(aPath), parseFile(bPath)]);
  if (A.abs === B.abs) throw new HttpError(400, 'a and b are the same file');

  return {
    a: fileInfo(A),
    b: fileInfo(B),
    settings: settingsDiff(A.parsed.config, B.parsed.config),
    totals: totalsDiff(A.parsed, B.parsed),
    layers: layerDiff(A.parsed, B.parsed, opts),
    features: featureDiff(A.parsed, B.parsed),
  };
}

function fileInfo(entry) {
  const p = entry.parsed;
  return {
    path: relPath(entry.abs),
    name: path.basename(entry.abs),
    bytes: entry.size,
    mtime: entry.mtimeMs,
    generator: p.meta.generator,
    moves: p.count,
    layers: p.layers.length,
    configKeys: Object.keys(p.config).length,
    warnings: p.warnings,
  };
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

/**
 * Only the keys that differ, both values kept verbatim (the CONFIG_BLOCK stores
 * everything as a string, including numbers and comma-joined lists).
 */
export function settingsDiff(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed = [];
  const onlyInA = [];
  const onlyInB = [];
  for (const k of [...keys].sort()) {
    const av = a[k], bv = b[k];
    if (av === undefined) { onlyInB.push({ key: k, b: bv }); continue; }
    if (bv === undefined) { onlyInA.push({ key: k, a: av }); continue; }
    if (av !== bv) changed.push({ key: k, a: av, b: bv, numeric: numDelta(av, bv) });
  }
  return {
    changed, onlyInA, onlyInB,
    counts: { a: Object.keys(a).length, b: Object.keys(b).length, changed: changed.length, onlyInA: onlyInA.length, onlyInB: onlyInB.length },
  };
}

/** When both sides parse as plain numbers, hand the UI the delta too. */
function numDelta(av, bv) {
  const x = Number(av), y = Number(bv);
  if (!Number.isFinite(x) || !Number.isFinite(y) || av.trim() === '' || bv.trim() === '') return null;
  return { a: x, b: y, delta: round(y - x), pct: x !== 0 ? round(((y - x) / Math.abs(x)) * 100) : null };
}

// ---------------------------------------------------------------------------
// totals
// ---------------------------------------------------------------------------

function totalsOf(p) {
  const seg = p.segments;
  let deposited = 0, extrudeLen = 0, travelLen = 0, retracts = 0;
  for (let i = 0; i < p.count; i++) {
    const k = seg.kind[i];
    const len = Math.hypot(seg.x1[i] - seg.x0[i], seg.y1[i] - seg.y0[i], seg.z1[i] - seg.z0[i]);
    if (k === KIND.EXTRUDE) { deposited += seg.e[i]; extrudeLen += len; }
    else if (k === KIND.TRAVEL) travelLen += len;
    else if (k === KIND.RETRACT) retracts++;
  }
  return {
    timeSec: p.meta.estimatedTimeSec,
    timeText: p.meta.estimatedTimeText,
    filamentMm: p.meta.filamentUsedMm || round(deposited),
    filamentG: p.meta.filamentUsedG,
    filamentCm3: p.meta.filamentUsedCm3,
    depositedMm: round(deposited),
    extrudedPathMm: round(extrudeLen),
    travelMm: round(travelLen),
    retracts,
    layerCount: p.layers.length,
    maxZ: p.meta.maxZ,
    layerHeight: p.config.layer_height ? Number(p.config.layer_height) : null,
    moves: p.count,
  };
}

function totalsDiff(pa, pb) {
  const a = totalsOf(pa), b = totalsOf(pb);
  const delta = {};
  for (const k of Object.keys(a)) {
    if (typeof a[k] === 'number' && typeof b[k] === 'number') delta[k] = round(b[k] - a[k]);
  }
  delta.timeText = `${formatDuration(a.timeSec)} -> ${formatDuration(b.timeSec)} (${b.timeSec >= a.timeSec ? '+' : '-'}${formatDuration(Math.abs(b.timeSec - a.timeSec))})`;
  return { a, b, delta };
}

// ---------------------------------------------------------------------------
// per layer
// ---------------------------------------------------------------------------

/**
 * Aligned by layer index, which is the only alignment that means anything when
 * the two files have different layer heights (v1 was 0.12 mm, v4 is 0.20 mm --
 * then the Z column tells you the layers are not comparable and the totals are
 * what you should read instead).
 */
function layerDiff(pa, pb, opts = {}) {
  const A = indexLayers(pa), B = indexLayers(pb);
  const idx = [...new Set([...A.keys(), ...B.keys()])].sort((x, y) => x - y);
  const rows = [];
  for (const i of idx) {
    const a = A.get(i), b = B.get(i);
    rows.push({
      index: i,
      zA: a ? round(a.z) : null,
      zB: b ? round(b.z) : null,
      timeA: a ? round(a.time) : null,
      timeB: b ? round(b.time) : null,
      // deltas are the difference of the ROUNDED values, not the rounded
      // difference, so a displayed row adds up exactly (they differ by 0.01)
      dTime: a && b ? round(round(b.time) - round(a.time)) : null,
      filamentA: a ? round(a.filamentMm) : null,
      filamentB: b ? round(b.filamentMm) : null,
      dFilament: a && b ? round(round(b.filamentMm) - round(a.filamentMm)) : null,
      lengthA: a ? round(a.extrudeMm) : null,
      lengthB: b ? round(b.extrudeMm) : null,
      maxFanA: a ? round(a.maxFan * 100) : null,
      maxFanB: b ? round(b.maxFan * 100) : null,
      onlyIn: a && b ? null : (a ? 'a' : 'b'),
    });
  }
  const biggest = rows
    .filter((r) => r.dTime != null)
    .sort((x, y) => Math.abs(y.dTime) - Math.abs(x.dTime))
    .slice(0, opts.topLayers || 10)
    .map((r) => ({ index: r.index, dTime: r.dTime, timeA: r.timeA, timeB: r.timeB }));
  return { rows, biggestTimeChanges: biggest };
}

function indexLayers(p) {
  const m = new Map();
  for (const L of p.layers) m.set(L.index, L);
  return m;
}

// ---------------------------------------------------------------------------
// per feature
// ---------------------------------------------------------------------------

function featureTotals(p) {
  const seg = p.segments;
  const acc = new Map();
  for (let i = 0; i < p.count; i++) {
    if (seg.kind[i] !== KIND.EXTRUDE) continue;
    const name = FEATURE_NAMES[seg.feature[i]];
    let a = acc.get(name);
    if (!a) { a = { time: 0, lengthMm: 0, filamentMm: 0, moves: 0 }; acc.set(name, a); }
    a.time += seg.time[i];
    a.lengthMm += Math.hypot(seg.x1[i] - seg.x0[i], seg.y1[i] - seg.y0[i], seg.z1[i] - seg.z0[i]);
    a.filamentMm += seg.e[i];
    a.moves++;
  }
  // Travel is not a feature but it is where time hides, so report it too.
  let travelTime = 0, travelLen = 0, travelMoves = 0;
  for (let i = 0; i < p.count; i++) {
    if (seg.kind[i] === KIND.EXTRUDE) continue;
    travelTime += seg.time[i];
    travelLen += Math.hypot(seg.x1[i] - seg.x0[i], seg.y1[i] - seg.y0[i], seg.z1[i] - seg.z0[i]);
    travelMoves++;
  }
  acc.set('(travel & retract)', { time: travelTime, lengthMm: travelLen, filamentMm: 0, moves: travelMoves });
  return acc;
}

function featureDiff(pa, pb) {
  const A = featureTotals(pa), B = featureTotals(pb);
  const names = [...new Set([...A.keys(), ...B.keys()])];
  const rows = names.map((name) => {
    const a = A.get(name), b = B.get(name);
    return {
      name,
      timeA: a ? round(a.time) : 0,
      timeB: b ? round(b.time) : 0,
      // as in the layer rows: difference of the rounded values, so it adds up
      dTime: round(round(b?.time || 0) - round(a?.time || 0)),
      lengthA: a ? round(a.lengthMm) : 0,
      lengthB: b ? round(b.lengthMm) : 0,
      dLength: round(round(b?.lengthMm || 0) - round(a?.lengthMm || 0)),
      filamentA: a ? round(a.filamentMm) : 0,
      filamentB: b ? round(b.filamentMm) : 0,
      movesA: a ? a.moves : 0,
      movesB: b ? b.moves : 0,
      onlyIn: a && b ? null : (a ? 'a' : 'b'),
    };
  });
  rows.sort((x, y) => Math.abs(y.dTime) - Math.abs(x.dTime));
  return rows;
}

const round = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
