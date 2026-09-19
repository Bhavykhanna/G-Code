/**
 * validate.js -- the safety gate. Nothing is written without passing this.
 *
 * This drives real hardware, so the rules from CONTEXT.md "Safety rules" are
 * implemented as hard errors, not warnings. A single error blocks the write;
 * there is no override flag and there should never be one.
 *
 * The validator re-PARSES the edited text rather than trusting the edit code.
 * That is the whole point: it checks the bytes that would land on disk, so a
 * bug in edit.js shows up here as a geometry or state error.
 *
 * Two modes:
 *   - standalone: `validate(text)` -- sanity-check any G-code file
 *   - differential: `validate(text, { original })` -- additionally compare
 *     against the file it was derived from (retract counts, filament total,
 *     layer count, feature blocks). This catches damage that looks locally
 *     legal but changed the file's character.
 */
import { parseGcode, KIND, FEATURE_NAMES } from '../../src/parser/parse.js';

/** Machine envelope. Overridden per-file from the CONFIG_BLOCK when present. */
const DEFAULT_LIMITS = {
  bedX: 426,
  bedY: 426,
  maxZ: 480,
  nozzleMin: 170,
  nozzleMax: 300,
  bedTempMax: 110,
  maxFeedMmMin: 500 * 60,   // machine_max_speed_x = 500 mm/s
  maxVolumetric: 20,        // filament_max_volumetric_speed
};

const FILAMENT_AREA = (d) => Math.PI * (d / 2) ** 2;

/**
 * @param {string} text        the G-code that would be written
 * @param {object} [opts]
 * @param {object} [opts.parsed]    a parse of `text`, if the caller already has one
 * @param {object} [opts.original]  parse result of the file this was derived from
 * @param {string} [opts.originalText]  its text, for holding the edit to that
 *   file's own end sequence rather than to one printer's
 * @param {Array}  [opts.ops]       the edit ops, for context in messages
 * @returns {{ok:boolean, errors:Array, warnings:Array, stats:object, limits:object}}
 */
export function validate(text, opts = {}) {
  const parsed = opts.parsed || parseGcode(text);
  const original = opts.original || null;
  const errors = [];
  const warnings = [];
  const err = (code, message, detail) => errors.push({ code, message, ...(detail ? { detail } : {}) });
  const warn = (code, message, detail) => warnings.push({ code, message, ...(detail ? { detail } : {}) });

  const limits = limitsFor(parsed.config);
  const seg = parsed.segments;
  const n = parsed.count;

  // ---- 0. the file has to be editable at all ------------------------------
  if (!parsed.relativeE) {
    err('ABSOLUTE_E',
      'file does not use M83 relative extrusion; a single E edit would invalidate every later E, so editing is disabled');
  }
  if (n === 0) {
    err('NO_MOVES', 'the file contains no movement commands');
    return done();
  }

  // Segments emitted before the first `;LAYER:` annotation belong to the start
  // G-code (home, purge line at Z0.4). They are not part of any layer and must
  // be excluded from the per-layer Z checks or the purge trips every one.
  const bodyStart = parsed.layers.length ? parsed.layers[0].firstSeg : 0;

  // ---- 1. envelope --------------------------------------------------------
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  let outOfBounds = 0, firstOOB = null;
  for (let i = 0; i < n; i++) {
    for (const [x, y, z] of [[seg.x0[i], seg.y0[i], seg.z0[i]], [seg.x1[i], seg.y1[i], seg.z1[i]]]) {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        if (firstOOB === null) firstOOB = { line: seg.line[i], x, y, z, why: 'not a number' };
        outOfBounds++;
        continue;
      }
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      if (x < -0.001 || x > limits.bedX || y < -0.001 || y > limits.bedY || z < -0.001 || z > limits.maxZ) {
        outOfBounds++;
        if (firstOOB === null) {
          firstOOB = { line: seg.line[i], x: r(x), y: r(y), z: r(z), why: z < -0.001 ? 'below the bed' : 'outside the envelope' };
        }
      }
    }
  }
  if (outOfBounds) {
    err('OUT_OF_BOUNDS',
      `${outOfBounds} move endpoint(s) fall outside the ${limits.bedX}x${limits.bedY} bed / Z ${limits.maxZ} envelope`,
      { first: firstOOB, bbox: { x: [r(minX), r(maxX)], y: [r(minY), r(maxY)], z: [r(minZ), r(maxZ)] } });
  }

  // ---- 2. Z monotonicity --------------------------------------------------
  // Z-hops make raw "Z never decreases" false, so the rule is applied to
  // EXTRUDING moves only: within a layer the nozzle must not dip below the
  // height it started laying material at, and a layer must not sit below the
  // one before it.
  const layerZ = new Map(); // layer index -> { first, min, max, nExtrude }
  for (let i = bodyStart; i < n; i++) {
    if (seg.kind[i] !== KIND.EXTRUDE) continue;
    const L = seg.layer[i];
    const z = seg.z1[i];
    let a = layerZ.get(L);
    if (!a) { a = { first: z, min: z, max: z, nExtrude: 0, firstLine: seg.line[i] }; layerZ.set(L, a); }
    if (z < a.min) a.min = z;
    if (z > a.max) a.max = z;
    a.nExtrude++;
    if (z < a.first - 0.011) {
      err('Z_DROP_IN_LAYER',
        `layer ${L}: an extruding move drops to Z ${r(z)} after the layer started at Z ${r(a.first)}`,
        { layer: L, line: seg.line[i], z: r(z), layerZ: r(a.first) });
      break; // one is enough; the rest will be the same fault
    }
  }
  const layerKeys = [...layerZ.keys()].sort((a, b) => a - b);
  for (let k = 1; k < layerKeys.length; k++) {
    const prev = layerZ.get(layerKeys[k - 1]), cur = layerZ.get(layerKeys[k]);
    if (cur.first < prev.first - 0.011) {
      err('Z_REGRESSION',
        `layer ${layerKeys[k]} prints at Z ${r(cur.first)}, below layer ${layerKeys[k - 1]} at Z ${r(prev.first)}`,
        { layer: layerKeys[k], line: cur.firstLine });
      break;
    }
  }

  // ---- 3. extrusion sanity -------------------------------------------------
  const area = FILAMENT_AREA(parsed.meta.filamentDiameter || 1.75);
  let deposited = 0, extrudeMoves = 0, maxE = 0, maxEline = 0;
  let maxMm3PerMm = 0, maxFlow = 0, overFlow = 0;
  for (let i = 0; i < n; i++) {
    const k = seg.kind[i];
    const e = seg.e[i];
    if (!Number.isFinite(e)) {
      err('E_NAN', 'a move has a non-numeric E value', { line: seg.line[i] });
      break;
    }
    if (k !== KIND.EXTRUDE) continue;
    deposited += e;
    extrudeMoves++;
    // The start G-code's purge line legitimately lays down E30 in one move, so
    // the single-move cap only applies to the print body.
    if (i >= bodyStart && e > maxE) { maxE = e; maxEline = seg.line[i]; }
    const len = Math.hypot(seg.x1[i] - seg.x0[i], seg.y1[i] - seg.y0[i], seg.z1[i] - seg.z0[i]);
    if (len > 0.01) {
      const mm3PerMm = (e * area) / len;
      if (mm3PerMm > maxMm3PerMm) maxMm3PerMm = mm3PerMm;
      if (mm3PerMm > 5) {
        err('E_TOO_FAT',
          `a ${r(len)} mm move deposits ${r2(mm3PerMm)} mm3/mm -- far more than a 0.4 mm nozzle can lay`,
          { line: seg.line[i], e: r2(e), lengthMm: r(len) });
        break;
      }
    }
    if (seg.time[i] > 1e-6) {
      const flow = (e * area) / seg.time[i];
      if (flow > maxFlow) maxFlow = flow;
      if (flow > limits.maxVolumetric * 1.25) overFlow++;
    }
  }
  if (maxE > 25) {
    err('E_TOO_LARGE', `a single move extrudes ${r2(maxE)} mm of filament`, { line: maxEline });
  }
  if (overFlow) {
    warn('FLOW_RATE_HIGH',
      `${overFlow} move(s) exceed filament_max_volumetric_speed (${limits.maxVolumetric} mm3/s) by more than 25%; peak ${r2(maxFlow)} mm3/s`,
      { note: 'the time model is approximate, so treat this as a hint rather than a measurement' });
  }

  // ---- 4. retract / prime balance -----------------------------------------
  let retracts = 0, primes = 0, state = 0, minState = 0, maxState = 0, worstLine = 0;
  for (let i = 0; i < n; i++) {
    const k = seg.kind[i];
    if (k === KIND.EXTRUDE) continue;
    const e = seg.e[i];
    if (e === 0) continue;
    if (k === KIND.RETRACT) retracts++;
    else if (k === KIND.PRIME) primes++;
    state += e;
    if (state < minState) { minState = state; worstLine = seg.line[i]; }
    if (state > maxState) maxState = state;
  }
  if (minState < -15) {
    err('RETRACT_RUNAWAY',
      `the extruder ends up ${r2(-minState)} mm retracted at one point; the filament would be pulled out of the melt zone`,
      { line: worstLine });
  }
  if (maxState > 2) {
    warn('PRIME_EXCESS', `${r2(maxState)} mm more filament is primed than retracted at one point`);
  }

  // ---- 5. temperatures ----------------------------------------------------
  const lines = text.split('\n');
  const firstLayerLine = parsed.layers.length ? parsed.layers[0].lineStart : 0;
  let nozzleCmds = 0, bedCmds = 0;
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    if (l.charCodeAt(0) !== 77) continue; // 'M'
    const isNozzle = l.startsWith('M104') || l.startsWith('M109');
    const isBed = l.startsWith('M140') || l.startsWith('M190');
    if (!isNozzle && !isBed) continue;
    const m = /\bS(-?[\d.]+)/.exec(l);
    if (!m) continue;
    const s = Number(m[1]);
    if (isNozzle) {
      nozzleCmds++;
      if (s > limits.nozzleMax) {
        err('NOZZLE_TEMP_HIGH', `M104/M109 S${s} exceeds the ${limits.nozzleMax} C limit`, { line: li });
      } else if (s > 0 && s < limits.nozzleMin && li > firstLayerLine) {
        err('NOZZLE_TEMP_LOW', `M104/M109 S${s} during the print is below ${limits.nozzleMin} C; PLA will not flow and the extruder will grind`, { line: li });
      } else if (s < 0) {
        err('NOZZLE_TEMP_NEGATIVE', `M104/M109 S${s} is negative`, { line: li });
      }
    } else {
      bedCmds++;
      if (s > limits.bedTempMax || s < 0) {
        err('BED_TEMP', `M140/M190 S${s} is outside 0-${limits.bedTempMax} C`, { line: li });
      }
    }
  }
  if (nozzleCmds === 0) err('NO_NOZZLE_TEMP', 'the file never sets a nozzle temperature');

  // ---- 6. feedrates --------------------------------------------------------
  let badFeed = 0, badFeedLine = 0, maxFeed = 0;
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    if (l.charCodeAt(0) !== 71) continue; // 'G'
    if (!/^G[0-3][ \t]/.test(l)) continue; // arcs carry F too
    const m = /\bF(-?[\d.]+)/.exec(l.split(';')[0]);
    if (!m) continue;
    const f = Number(m[1]);
    if (f > maxFeed) maxFeed = f;
    if (!(f > 0) || f > limits.maxFeedMmMin * 1.001) {
      badFeed++;
      if (!badFeedLine) badFeedLine = li;
    }
  }
  if (badFeed) {
    err('BAD_FEEDRATE',
      `${badFeed} move(s) carry a feedrate that is <= 0 or above the machine limit of ${limits.maxFeedMmMin} mm/min (${limits.maxFeedMmMin / 60} mm/s)`,
      { line: badFeedLine, maxFeed });
  }

  // ---- 7. feature blocks ---------------------------------------------------
  const blocks = featureBlocks(lines);
  if (blocks.dangling.length) {
    const msg = `${blocks.dangling.length} feature block(s) declare a ;TYPE: but contain no extrusion`;
    if (original) {
      const before = featureBlocks(null, original).dangling.length;
      if (blocks.dangling.length > before) {
        err('DANGLING_FEATURE', msg + ` (was ${before} before the edit)`, { lines: blocks.dangling.slice(0, 10) });
      } else {
        warn('DANGLING_FEATURE', msg + ' (unchanged from the source file)');
      }
    } else {
      warn('DANGLING_FEATURE', msg, { lines: blocks.dangling.slice(0, 10) });
    }
  }

  // ---- 8. the end sequence -------------------------------------------------
  // What a correct ending looks like is the machine profile's business, not
  // this file's. So an EDIT is held against the ending the source file actually
  // had: every shutdown marker that was there has to still be there. For this
  // printer that is the same five markers as before, and for any other printer
  // it is that printer's own. A file validated on its own has no source to
  // compare with, so it only has to shut the machine down at all.
  const tail = executableTail(text);
  const endMarkers = { found: markersIn(tail), required: [] };
  if (opts.originalText) {
    endMarkers.required = markersIn(executableTail(String(opts.originalText)));
    const have = new Set(endMarkers.found.map((m) => m.token));
    for (const m of endMarkers.required) {
      if (!have.has(m.token)) {
        err('END_SEQUENCE', `the file no longer ends with ${m.what} (\`${m.token}\` is missing, and the file this was derived from has it)`);
      }
    }
  } else {
    for (const group of ['hotend', 'steppers']) {
      if (!endMarkers.found.some((m) => m.group === group)) {
        err('END_SEQUENCE', `the file does not end by ${GROUP_WHAT[group]} — no ${END_MARKERS.filter((m) => m.group === group).map((m) => '`' + m.token + '`').join(' / ')}`);
      }
    }
    if (!endMarkers.found.some((m) => m.group === 'bed')) {
      warn('END_SEQUENCE', 'the file does not turn the bed heater off at the end');
    }
  }
  if (!text.includes('; CONFIG_BLOCK_START') || !text.includes('; CONFIG_BLOCK_END')) {
    warn('NO_CONFIG_BLOCK', 'the CONFIG_BLOCK is missing, so A/B settings diff will not work on this file');
  }

  // ---- 9. differential checks vs the source file ---------------------------
  const stats = {
    moves: n,
    extrudeMoves,
    layers: parsed.layers.length,
    depositedMm: r2(deposited),
    depositedG: r2((deposited * area * (parsed.meta.filamentDensity || 1.24)) / 1000),
    footerFilamentMm: parsed.meta.filamentUsedMm,
    maxZ: r(maxZ),
    minZ: r(minZ),
    bbox: { x: [r(minX), r(maxX)], y: [r(minY), r(maxY)], z: [r(minZ), r(maxZ)] },
    retracts,
    primes,
    retractStateRange: [r2(minState), r2(maxState)],
    maxMm3PerMm: r2(maxMm3PerMm),
    maxFlowMm3s: r2(maxFlow),
    maxFeedMmMin: maxFeed,
    endMarkers: endMarkers.found.map((m) => m.token),
  };

  if (original) {
    const o = originalStats(original);
    stats.original = o;

    const dFil = o.depositedMm > 0 ? (deposited - o.depositedMm) / o.depositedMm : 0;
    stats.filamentDeltaPct = r2(dFil * 100);
    if (Math.abs(dFil) > 0.30) {
      err('FILAMENT_IMPLAUSIBLE',
        `total filament changed by ${r2(dFil * 100)}% (${r2(o.depositedMm)} -> ${r2(deposited)} mm); that is a re-slice, not an edit`);
    } else if (Math.abs(dFil) > 0.05) {
      warn('FILAMENT_CHANGED', `total filament changed by ${r2(dFil * 100)}%`);
    }

    if (retracts !== o.retracts || primes !== o.primes) {
      err('RETRACT_UNBALANCED',
        `retract/prime move counts changed: ${o.retracts}/${o.primes} -> ${retracts}/${primes}; an edit must not add or remove them`);
    }
    if (parsed.layers.length !== o.layers) {
      warn('LAYER_COUNT_CHANGED', `layer count changed ${o.layers} -> ${parsed.layers.length}`);
    }
    if (Math.abs(maxZ - o.maxZ) > 0.011) {
      warn('MAX_Z_CHANGED', `max Z changed ${r(o.maxZ)} -> ${r(maxZ)} mm`);
    }
    // A flow edit that slipped past the cap shows up as a per-move ratio.
    if (n === original.count) {
      let worst = 1, worstIdx = -1;
      const os = original.segments;
      for (let i = 0; i < n; i++) {
        if (seg.kind[i] !== KIND.EXTRUDE || os.kind[i] !== KIND.EXTRUDE) continue;
        if (!(os.e[i] > 1e-6)) continue;
        const ratio = seg.e[i] / os.e[i];
        if (Math.abs(Math.log(ratio)) > Math.abs(Math.log(worst))) { worst = ratio; worstIdx = i; }
      }
      stats.worstFlowRatio = r3(worst);
      if (worstIdx >= 0 && (worst < 0.8 - 1e-6 || worst > 1.2 + 1e-6)) {
        err('FLOW_CAP',
          `a move's extrusion was scaled by ${r3(worst)}x; flow edits are hard-capped at 0.80-1.20x (CONTEXT.md safety rule 4)`,
          { line: seg.line[worstIdx] });
      }
    }
  }

  return done();

  function done() {
    return { ok: errors.length === 0, errors, warnings, stats: stats || {}, limits };
  }
}

// ---------------------------------------------------------------------------
// The end sequence
// ---------------------------------------------------------------------------

/**
 * Shutdown markers, across the dialects this parser can read. `group` is what
 * the marker achieves, so a file can satisfy "turn the hotend off" in whatever
 * wording its own firmware uses.
 *
 * This list is only ever used to RECOGNISE markers. Which ones a given file
 * must have is decided by the file it was derived from (see §8), never by this
 * list -- that is what lets another printer's end sequence be just as binding
 * as this one's without anybody writing it down here.
 */
const END_MARKERS = [
  { token: ';PRINT_END', group: 'marker', what: 'the end-of-print marker' },
  { token: '; EXECUTABLE_BLOCK_END', group: 'marker', what: 'the end of the executable block' },
  { token: ';End of Gcode', group: 'marker', what: 'the end-of-print marker' },
  { token: 'M104 S0', group: 'hotend', what: 'turning the hotend off' },
  { token: 'M109 S0', group: 'hotend', what: 'turning the hotend off' },
  { token: 'TURN_OFF_HEATERS', group: 'hotend', what: 'turning the heaters off' },
  { token: 'M140 S0', group: 'bed', what: 'turning the bed off' },
  { token: 'M190 S0', group: 'bed', what: 'turning the bed off' },
  { token: 'M84', group: 'steppers', what: 'disabling the steppers' },
  { token: 'M18', group: 'steppers', what: 'disabling the steppers' },
];

const GROUP_WHAT = {
  hotend: 'turning the hotend off',
  bed: 'turning the bed off',
  steppers: 'disabling the steppers',
};

/**
 * The end of the file's EXECUTABLE part -- what the printer actually runs.
 *
 * The CONFIG_BLOCK is not it, and it quotes `machine_end_gcode` verbatim: a file
 * whose real end sequence had been deleted still had every marker sitting in its
 * own settings dump, so the check passed on a file that would never turn the
 * hotend off. Everything from `; CONFIG_BLOCK_START` on is cut before looking.
 */
function executableTail(text) {
  const at = text.lastIndexOf('; CONFIG_BLOCK_START');
  return (at > 0 ? text.slice(0, at) : text).slice(-200000);
}

/** The shutdown markers present in a chunk of text (the tail of a file). */
function markersIn(text) {
  return END_MARKERS.filter((m) => text.includes(m.token));
}

// ---------------------------------------------------------------------------

function limitsFor(config = {}) {
  const L = { ...DEFAULT_LIMITS };
  if (config.bed_shape) {
    const pts = String(config.bed_shape).split(',').map((p) => p.split('x').map(Number));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    if (xs.every(Number.isFinite) && ys.every(Number.isFinite)) {
      L.bedX = Math.max(...xs);
      L.bedY = Math.max(...ys);
    }
  }
  const h = Number(config.printable_height);
  if (Number.isFinite(h) && h > 0) L.maxZ = h;
  const lo = Number(config.nozzle_temperature_range_low);
  const hi = Number(config.nozzle_temperature_range_high);
  if (Number.isFinite(lo) && lo > 0) L.nozzleMin = Math.min(L.nozzleMin, lo);
  if (Number.isFinite(hi) && hi > 0) L.nozzleMax = Math.max(hi, 250);
  const v = Number(config.filament_max_volumetric_speed);
  if (Number.isFinite(v) && v > 0) L.maxVolumetric = v;
  // `''.split(',')` is `['']` and `Number('')` is 0, which is finite -- so a file
  // with no machine_max_speed_x used to end up with a maximum feedrate of ZERO
  // and every single move in it failed BAD_FEEDRATE (B14). Only real numbers
  // above zero count, and if none are left the default stands.
  const sx = String(config.machine_max_speed_x || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((nn) => Number.isFinite(nn) && nn > 0);
  if (sx.length) L.maxFeedMmMin = Math.max(...sx) * 60;
  return L;
}

/**
 * Feature blocks: every `;TYPE:` run and whether it actually extrudes.
 * `;TYPE:Custom` is the start/end G-code and never extrudes by design.
 * Accepts either a line array or a parse result (whose text we do not keep).
 */
function featureBlocks(lines, parsedFallback) {
  if (!lines && parsedFallback) {
    // Reconstruct from segments: a block is dangling if no EXTRUDE move carries
    // it. Walk the feature array by layer-ordered runs instead of the text.
    const seg = parsedFallback.segments;
    const seen = new Set();
    for (let i = 0; i < parsedFallback.count; i++) {
      if (seg.kind[i] === KIND.EXTRUDE) seen.add(seg.layer[i] + ':' + seg.feature[i]);
    }
    return { dangling: [], blocks: seen.size };
  }
  const dangling = [];
  let open = null;
  let blocks = 0;
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    if (l.charCodeAt(0) === 59) { // ';'
      if (l.startsWith(';TYPE:')) {
        if (open && !open.extruded && open.name.toLowerCase() !== 'custom') dangling.push(open.line);
        const name = l.slice(6).trim().replace(/\r$/, '');
        open = { name, line: li, extruded: false };
        blocks++;
      } else if (l.startsWith(';LAYER:')) {
        if (open && !open.extruded && open.name.toLowerCase() !== 'custom') dangling.push(open.line);
        open = null;
      }
      continue;
    }
    if (open && !open.extruded && l.charCodeAt(0) === 71) {
      const code = l.split(';')[0];
      const m = /\bE(-?[\d.]+)/.exec(code);
      if (m && Number(m[1]) > 0 && /\b[XY]-?[\d.]/.test(code)) open.extruded = true;
    }
  }
  if (open && !open.extruded && open.name.toLowerCase() !== 'custom') dangling.push(open.line);
  return { dangling, blocks };
}

function originalStats(original) {
  const seg = original.segments;
  let deposited = 0, retracts = 0, primes = 0, maxZ = 0, extrudeMoves = 0;
  for (let i = 0; i < original.count; i++) {
    const k = seg.kind[i];
    if (k === KIND.EXTRUDE) { deposited += seg.e[i]; extrudeMoves++; }
    else if (k === KIND.RETRACT) retracts++;
    else if (k === KIND.PRIME) primes++;
    if (seg.z1[i] > maxZ) maxZ = seg.z1[i];
  }
  return {
    moves: original.count,
    extrudeMoves,
    depositedMm: deposited,
    retracts,
    primes,
    layers: original.layers.length,
    maxZ,
    estimatedTimeSec: original.meta.estimatedTimeSec,
  };
}

const r = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);

export { FEATURE_NAMES };
