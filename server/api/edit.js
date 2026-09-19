/**
 * edit.js -- Lane A: direct, parametric G-code edits.
 *
 * Everything here operates on SOURCE LINES, not on a re-serialised model.
 * A line that is not part of an edit is copied byte for byte, including its
 * original EOL, its original number formatting and its original comments. The
 * file is split on '\n' and joined on '\n', so a CRLF file keeps its '\r' on
 * every untouched line without the code having to think about it.
 *
 * Two shapes of op, and the difference matters:
 *
 *   per-move ops   setSpeed, scaleSpeed, scaleFlow
 *                  rewrite a parameter on each matching move's own line, then
 *                  restore the previous value on the first move after each run,
 *                  because F is sticky in this dialect.
 *
 *   state ops      setFan, scaleFan, setTemp, setAccel, setZOffset
 *                  M106 / M104 / SET_VELOCITY_LIMIT / Z are machine state, not
 *                  per-move parameters. They are applied across the SPAN of the
 *                  selection (first matched line .. last matched line) and
 *                  restored after it. If the selection is sparse inside that
 *                  span, non-selected moves in between are affected too --
 *                  `coverage` in the response reports exactly how much.
 *
 * Nothing here writes to disk unless `dryRun` is false AND the validator
 * returned ok. `dryRun` defaults to true.
 */
import { parseGcode, KIND, FEATURE_NAMES, formatDuration } from '../../src/parser/parse.js';
import { HttpError, parseFile, invalidate, relPath, safeResolveReal } from './files.js';
import { validate } from './validate.js';
import { commitVersion, planVersion, listVersions, slugifyChange, formatTimeField } from './version.js';
import path from 'node:path';

export const EDIT_OPS = [
  'setSpeed', 'scaleSpeed', 'setFan', 'scaleFan', 'setTemp', 'scaleFlow',
  'setAccel', 'deleteRegion', 'insertPause', 'setZOffset',
];

/** CONTEXT.md safety rule 4. Not configurable, deliberately. */
export const FLOW_MIN = 0.8;
export const FLOW_MAX = 1.2;

const DIFF_CAP = 400;

// ---------------------------------------------------------------------------
// line document
// ---------------------------------------------------------------------------

/**
 * A mutable view over the source lines, indexed by ORIGINAL line number for
 * the whole lifetime of an edit. Insertions live in side tables rather than
 * shifting the array, so op #2 can still target the line numbers that came out
 * of the parser for op #1's file.
 */
export class LineDoc {
  constructor(text, eol) {
    this.lines = text.split('\n');
    this.cr = eol === '\r\n';
    this.text = this.lines.slice();
    this.before = new Map(); // original index -> inserted lines placed before it
    this.after = new Map();  // original index -> inserted lines placed after it
    this.changed = new Set();
    this.removed = new Set();
  }

  get length() { return this.lines.length; }

  /** The line's content with any trailing '\r' stripped. */
  body(i) {
    const l = this.text[i];
    if (l == null) return null;
    return l.endsWith('\r') ? l.slice(0, -1) : l;
  }

  /** The ORIGINAL content of a line, for the diff. */
  origBody(i) {
    const l = this.lines[i];
    if (l == null) return null;
    return l.endsWith('\r') ? l.slice(0, -1) : l;
  }

  setBody(i, s) {
    if (this.text[i] === null) return; // deleted; do not resurrect
    this.text[i] = this.cr ? s + '\r' : s;
    this.changed.add(i);
  }

  remove(i) {
    if (this.text[i] === null) return;
    this.text[i] = null;
    this.removed.add(i);
    this.changed.add(i);
  }

  isRemoved(i) { return this.text[i] === null; }

  insertBefore(i, lines) {
    const a = this.before.get(i) || [];
    a.push(...[].concat(lines));
    this.before.set(i, a);
  }

  insertAfter(i, lines) {
    const a = this.after.get(i) || [];
    a.push(...[].concat(lines));
    this.after.set(i, a);
  }

  render() {
    const out = [];
    const wrap = (s) => (this.cr ? s + '\r' : s);
    for (let i = 0; i < this.text.length; i++) {
      const b = this.before.get(i);
      if (b) for (const s of b) out.push(wrap(s));
      if (this.text[i] !== null) out.push(this.text[i]);
      const a = this.after.get(i);
      if (a) for (const s of a) out.push(wrap(s));
    }
    return out.join('\n');
  }

  /** Structured diff, capped so a whole-file edit does not blow up the response. */
  diff(cap = DIFF_CAP) {
    const entries = [];
    let changed = 0, inserted = 0, deleted = 0;
    const idx = new Set([...this.changed, ...this.before.keys(), ...this.after.keys()]);
    for (const i of [...idx].sort((a, b) => a - b)) {
      for (const s of this.before.get(i) || []) {
        inserted++;
        if (entries.length < cap) entries.push({ line: i, kind: 'insert', before: null, after: s });
      }
      if (this.text[i] === null) {
        deleted++;
        if (entries.length < cap) entries.push({ line: i, kind: 'delete', before: this.origBody(i), after: null });
      } else if (this.changed.has(i) && this.text[i] !== this.lines[i]) {
        changed++;
        if (entries.length < cap) entries.push({ line: i, kind: 'change', before: this.origBody(i), after: this.body(i) });
      }
      for (const s of this.after.get(i) || []) {
        inserted++;
        if (entries.length < cap) entries.push({ line: i, kind: 'insert', before: null, after: s });
      }
    }
    return {
      changedLines: changed, insertedLines: inserted, deletedLines: deleted,
      entries, truncated: changed + inserted + deleted > entries.length,
    };
  }
}

// ---------------------------------------------------------------------------
// G-code line surgery
// ---------------------------------------------------------------------------

function splitComment(body) {
  const i = body.indexOf(';');
  return i < 0 ? [body, ''] : [body.slice(0, i), body.slice(i)];
}

const NUMBER = '(-?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?)';

export function getParam(body, letter) {
  const [code] = splitComment(body);
  const m = new RegExp('(?:^|\\s)' + letter + NUMBER).exec(code);
  return m ? Number(m[1]) : NaN;
}

export function setParam(body, letter, valueStr) {
  const [code, comment] = splitComment(body);
  const re = new RegExp('((?:^|\\s)' + letter + ')' + NUMBER);
  if (re.test(code)) return code.replace(re, '$1' + valueStr) + comment;
  const head = code.replace(/\s+$/, '');
  return head + ' ' + letter + valueStr + (comment ? ' ' + comment : '');
}

export function hasParam(body, letter) {
  return !Number.isNaN(getParam(body, letter));
}

/**
 * `G1 X1 Y2 E.5` / `G0 X1 Y2` / `G2 X1 Y2 I3 J0 E.5` -- a motion command we are
 * allowed to touch. Arcs carry F and E exactly like G1, and the parser draws
 * them, so a selection can contain them and an edit must not skip them.
 */
function isMove(body) {
  return /^G[0-3](\s|$)/.test(body);
}

/** Integer, for F and S. */
const fmtInt = (v) => String(Math.max(0, Math.round(v)));

/**
 * Format an E value the way the slicer does: 5 decimals, trailing zeros
 * trimmed, no leading zero (`.00982`, `-.456`, `.6`, `1.19226`).
 */
export function fmtE(v) {
  if (!Number.isFinite(v)) return '0';
  let s = v.toFixed(5);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0' || s === '0' || s === '') return '0';
  return s.replace(/^(-?)0\./, '$1.');
}

/** Z keeps its leading zero -- the slicer writes `Z0.4`. */
export function fmtZ(v) {
  let s = v.toFixed(5);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

// ---------------------------------------------------------------------------
// targeting
// ---------------------------------------------------------------------------

function normalizeRanges(ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) return null;
  const out = [];
  for (const r of ranges) {
    if (!Array.isArray(r) || r.length < 2) throw new HttpError(400, 'lineRanges entries must be [from, to]');
    const a = Math.min(r[0], r[1]), b = Math.max(r[0], r[1]);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0) {
      throw new HttpError(400, 'lineRanges must be non-negative integers');
    }
    out.push([a, b]);
  }
  out.sort((x, y) => x[0] - y[0]);
  // merge overlaps so membership tests stay cheap
  const merged = [out[0]];
  for (let i = 1; i < out.length; i++) {
    const last = merged[merged.length - 1];
    if (out[i][0] <= last[1] + 1) last[1] = Math.max(last[1], out[i][1]);
    else merged.push(out[i]);
  }
  return merged;
}

function inRanges(ranges, v) {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (v < ranges[mid][0]) hi = mid - 1;
    else if (v > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

const FEATURE_BY_NAME = new Map(FEATURE_NAMES.map((n, i) => [n.toLowerCase(), i]));

/**
 * Resolve an op's target into segment indices plus the source-line span.
 * @returns {{segs:number[], span:[number,number], runs:number[][], coverage:number}}
 */
export function resolveTarget(parsed, op) {
  const seg = parsed.segments;
  const n = parsed.count;
  const segs = [];

  const ranges = normalizeRanges(op.lineRanges);
  const filter = op.filter || (op.layers || op.features ? { layers: op.layers, features: op.features } : null);

  if (ranges) {
    for (let i = 0; i < n; i++) if (inRanges(ranges, seg.line[i])) segs.push(i);
  } else if (filter) {
    let lo = -Infinity, hi = Infinity;
    if (Array.isArray(filter.layers) && filter.layers.length === 2) {
      lo = Number(filter.layers[0]); hi = Number(filter.layers[1]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new HttpError(400, 'filter.layers must be [lo, hi]');
    }
    let feats = null;
    if (Array.isArray(filter.features) && filter.features.length) {
      feats = new Set();
      for (const f of filter.features) {
        const idx = FEATURE_BY_NAME.get(String(f).toLowerCase());
        if (idx === undefined) {
          throw new HttpError(400, `unknown feature "${f}"`, { known: FEATURE_NAMES });
        }
        feats.add(idx);
      }
    }
    let kinds = null;
    if (Array.isArray(filter.kinds) && filter.kinds.length) {
      kinds = new Set(filter.kinds.map((k) => (typeof k === 'number' ? k : KIND[String(k).toUpperCase()])));
    }
    for (let i = 0; i < n; i++) {
      if (seg.layer[i] < lo || seg.layer[i] > hi) continue;
      if (feats && !(seg.kind[i] === KIND.EXTRUDE && feats.has(seg.feature[i]))) continue;
      if (kinds && !kinds.has(seg.kind[i])) continue;
      segs.push(i);
    }
  } else {
    throw new HttpError(400, `op "${op.op || op.type}": needs either lineRanges or filter {layers, features}`);
  }

  if (!segs.length) return { segs, span: null, runs: [], coverage: 0 };

  const span = [seg.line[segs[0]], seg.line[segs[segs.length - 1]]];
  if (ranges) { span[0] = Math.min(span[0], ranges[0][0]); span[1] = Math.max(span[1], ranges[ranges.length - 1][1]); }

  const runs = [];
  let s = segs[0], p = segs[0];
  for (let k = 1; k < segs.length; k++) {
    if (segs[k] === p + 1) { p = segs[k]; continue; }
    runs.push([s, p]); s = p = segs[k];
  }
  runs.push([s, p]);

  // How much of the span the selection actually covers. State ops hit the
  // whole span, so a low number here is a real warning for the user.
  const spanSegs = countSegsInLineRange(parsed, span[0], span[1]);
  return { segs, span, runs, coverage: spanSegs ? segs.length / spanSegs : 1 };
}

function countSegsInLineRange(parsed, a, b) {
  const line = parsed.segments.line;
  let c = 0;
  for (let i = 0; i < parsed.count; i++) if (line[i] >= a && line[i] <= b) c++;
  return c;
}

/** First segment after the end of a run (or -1). */
/** The first segment after `i` that is on a different source line (an arc is several segments on one line). */
const nextSeg = (parsed, i) => {
  const line = parsed.segments.line;
  let j = i + 1;
  while (j < parsed.count && line[j] === line[i]) j++;
  return j < parsed.count ? j : -1;
};

// ---------------------------------------------------------------------------
// the ops
// ---------------------------------------------------------------------------

/**
 * Apply one op to the document.
 * @returns {{op:string, matched:number, spanLines:[number,number]|null, coverage:number, notes:string[]}}
 */
export function applyOp(doc, parsed, op) {
  const name = op.op || op.type;
  if (!EDIT_OPS.includes(name)) {
    throw new HttpError(400, `unknown op "${name}"`, { known: EDIT_OPS });
  }
  const notes = [];
  const seg = parsed.segments;

  // insertPause is the only op that does not take a region target.
  if (name === 'insertPause') return opInsertPause(doc, parsed, op, notes);

  const t = resolveTarget(parsed, op);
  if (!t.segs.length) {
    return { op: name, matched: 0, spanLines: null, coverage: 0, notes: ['nothing matched -- no change made'] };
  }
  if (t.coverage < 0.98 && ['setFan', 'scaleFan', 'setTemp', 'setAccel', 'setZOffset'].includes(name)) {
    notes.push(
      `${name} is a machine-state op: it applies across source lines ${t.span[0]}-${t.span[1]}, ` +
      `and the selection only covers ${(t.coverage * 100).toFixed(1)}% of the moves in that span`);
  }

  switch (name) {
    case 'setSpeed':
    case 'scaleSpeed': opSpeed(doc, parsed, op, t, name, notes); break;
    case 'scaleFlow': opFlow(doc, parsed, op, t, notes); break;
    case 'setFan':
    case 'scaleFan': opFan(doc, parsed, op, t, name, notes); break;
    case 'setTemp': opTemp(doc, parsed, op, t, notes); break;
    case 'setAccel': opAccel(doc, parsed, op, t, notes); break;
    case 'setZOffset': opZOffset(doc, parsed, op, t, notes); break;
    case 'deleteRegion': opDelete(doc, parsed, op, t, notes); break;
  }

  return { op: name, matched: t.segs.length, spanLines: t.span, coverage: Math.round(t.coverage * 1000) / 1000, notes };
}

// --- speed -----------------------------------------------------------------

function opSpeed(doc, parsed, op, t, name, notes) {
  const seg = parsed.segments;
  let compute;
  if (name === 'setSpeed') {
    const v = Number(op.mm_s);
    if (!Number.isFinite(v) || v <= 0) throw new HttpError(400, 'setSpeed needs mm_s > 0');
    if (v > 500) throw new HttpError(422, 'setSpeed above 500 mm/s exceeds machine_max_speed_x');
    compute = () => v * 60;
  } else {
    const f = Number(op.factor);
    if (!Number.isFinite(f) || f <= 0) throw new HttpError(400, 'scaleSpeed needs factor > 0');
    if (f > 10) throw new HttpError(422, 'scaleSpeed factor above 10x is refused');
    compute = (i) => seg.speed[i] * 60 * f;
  }

  for (const i of t.segs) {
    const li = seg.line[i];
    const body = doc.body(li);
    if (body == null || !isMove(body)) continue;
    doc.setBody(li, setParam(body, 'F', fmtInt(compute(i))));
  }

  // F is sticky: put the previous feedrate back on the first move after each run.
  let restored = 0;
  for (const [, end] of t.runs) {
    const j = nextSeg(parsed, end);
    if (j < 0) continue;
    const lj = seg.line[j];
    const body = doc.body(lj);
    if (body == null || !isMove(body)) continue;
    doc.setBody(lj, setParam(body, 'F', fmtInt(seg.speed[j] * 60)));
    restored++;
  }
  notes.push(`rewrote F on ${t.segs.length} move(s); restored the previous feedrate on ${restored} boundary move(s)`);
}

// --- flow ------------------------------------------------------------------

function opFlow(doc, parsed, op, t, notes) {
  if (!parsed.relativeE) {
    throw new HttpError(422,
      'this file does not use M83 relative extrusion, so a flow edit would invalidate every later E value; re-slice instead');
  }
  const f = Number(op.factor);
  if (!Number.isFinite(f)) throw new HttpError(400, 'scaleFlow needs a numeric factor');
  if (f < FLOW_MIN || f > FLOW_MAX) {
    throw new HttpError(422,
      `flow factor ${f} is outside the hard cap of ${FLOW_MIN}-${FLOW_MAX}x. ` +
      'Beyond +/-20% the bead will not lay flat; the correct action is a re-slice (Lane B). ' +
      'This is CONTEXT.md safety rule 4 and there is no override.',
      { factor: f, min: FLOW_MIN, max: FLOW_MAX });
  }

  const seg = parsed.segments;
  let touched = 0;
  // An arc is several segments on ONE line. Scale each line once, or a 10 %
  // change would compound once per chord.
  const done = new Set();
  for (const i of t.segs) {
    if (seg.kind[i] !== KIND.EXTRUDE) continue; // never scale a retract or a prime
    const li = seg.line[i];
    if (done.has(li)) continue;
    done.add(li);
    const body = doc.body(li);
    if (body == null || !isMove(body)) continue;
    const e = getParam(body, 'E');
    if (Number.isNaN(e)) continue;
    doc.setBody(li, setParam(body, 'E', fmtE(e * f)));
    touched++;
  }
  notes.push(`scaled E on ${touched} extruding line(s) by ${f}x; retract and prime moves were left alone`);
}

// --- fan -------------------------------------------------------------------

function fanCommand(value255) {
  const v = Math.max(0, Math.min(255, Math.round(value255)));
  return v === 0 ? 'M107' : 'M106 S' + v;
}

function opFan(doc, parsed, op, t, name, notes) {
  const seg = parsed.segments;
  let map;
  if (name === 'setFan') {
    const p = Number(op.percent);
    if (!Number.isFinite(p) || p < 0 || p > 100) throw new HttpError(400, 'setFan needs percent 0-100');
    map = () => (p / 100) * 255;
  } else {
    const f = Number(op.factor);
    if (!Number.isFinite(f) || f < 0) throw new HttpError(400, 'scaleFan needs factor >= 0');
    map = (cur255) => cur255 * f;
  }

  const [l0, l1] = t.span;
  const first = t.segs[0];
  const last = t.segs[t.segs.length - 1];
  const fanAtStart = seg.fan[first] * 255;
  const after = nextSeg(parsed, last);
  const fanAfter = after >= 0 ? seg.fan[after] * 255 : seg.fan[last] * 255;

  doc.insertBefore(l0, [
    ';GCODE-STUDIO fan region start',
    fanCommand(map(fanAtStart)),
  ]);

  // Any M106/M107 inside the region would override us, so they are rewritten.
  let interior = 0;
  for (let li = l0; li <= l1; li++) {
    const body = doc.body(li);
    if (body == null) continue;
    if (body.startsWith('M106')) {
      const s = getParam(body, 'S');
      doc.setBody(li, fanCommand(map(Number.isNaN(s) ? 255 : s)));
      interior++;
    } else if (body.startsWith('M107')) {
      doc.setBody(li, fanCommand(map(0)));
      interior++;
    }
  }

  doc.insertAfter(l1, [
    fanCommand(fanAfter),
    ';GCODE-STUDIO fan region end',
  ]);
  notes.push(`fan set across source lines ${l0}-${l1}; ${interior} existing M106/M107 line(s) inside the region rewritten; restored to ${Math.round(fanAfter)}/255 after`);
}

// --- temperature -----------------------------------------------------------

function opTemp(doc, parsed, op, t, notes) {
  const c = Number(op.celsius);
  if (!Number.isFinite(c)) throw new HttpError(400, 'setTemp needs celsius');
  if (c < 170 || c > 300) {
    throw new HttpError(422, `setTemp ${c} C is outside the safe nozzle range 170-300 C`);
  }
  const seg = parsed.segments;
  const [l0, l1] = t.span;
  const last = t.segs[t.segs.length - 1];
  const after = nextSeg(parsed, last);
  const prev = after >= 0 ? seg.temp[after] : seg.temp[last];

  doc.insertBefore(l0, [';GCODE-STUDIO temp region start', 'M104 S' + fmtInt(c)]);

  let interior = 0;
  for (let li = l0; li <= l1; li++) {
    const body = doc.body(li);
    if (body == null) continue;
    if (body.startsWith('M104') || body.startsWith('M109')) {
      doc.setBody(li, setParam(body, 'S', fmtInt(c)));
      interior++;
    }
  }

  doc.insertAfter(l1, ['M104 S' + fmtInt(prev), ';GCODE-STUDIO temp region end']);
  notes.push(`nozzle set to ${c} C across source lines ${l0}-${l1}, restored to ${Math.round(prev)} C after; ${interior} existing M104/M109 line(s) rewritten`);
  if (!(prev >= 170 && prev <= 300)) {
    notes.push(`WARNING: the temperature restored after the region is ${Math.round(prev)} C, read from the parse at that point`);
  }
}

// --- acceleration ----------------------------------------------------------

function opAccel(doc, parsed, op, t, notes) {
  const a = Number(op.mm_s2);
  if (!Number.isFinite(a) || a <= 0) throw new HttpError(400, 'setAccel needs mm_s2 > 0');
  if (a > 20000) throw new HttpError(422, 'setAccel above 20000 mm/s2 is refused');
  const seg = parsed.segments;
  const [l0, l1] = t.span;
  const last = t.segs[t.segs.length - 1];
  const after = nextSeg(parsed, last);
  const prev = after >= 0 ? seg.accel[after] : seg.accel[last];

  doc.insertBefore(l0, [';GCODE-STUDIO accel region start', 'SET_VELOCITY_LIMIT ACCEL=' + fmtInt(a)]);

  let interior = 0;
  for (let li = l0; li <= l1; li++) {
    const body = doc.body(li);
    if (body == null) continue;
    if (body.startsWith('SET_VELOCITY_LIMIT')) {
      if (/ACCEL=/.test(body)) {
        doc.setBody(li, body.replace(/ACCEL=[\d.]+/, 'ACCEL=' + fmtInt(a)));
        interior++;
      }
    } else if (body.startsWith('M204')) {
      doc.setBody(li, setParam(body, 'S', fmtInt(a)));
      interior++;
    }
  }

  doc.insertAfter(l1, ['SET_VELOCITY_LIMIT ACCEL=' + fmtInt(prev), ';GCODE-STUDIO accel region end']);
  notes.push(`acceleration set to ${a} mm/s2 across source lines ${l0}-${l1} (Klipper SET_VELOCITY_LIMIT; M204 S is also handled), restored to ${Math.round(prev)} after; ${interior} existing line(s) rewritten`);
}

// --- Z offset --------------------------------------------------------------

function opZOffset(doc, parsed, op, t, notes) {
  const dz = Number(op.mm);
  if (!Number.isFinite(dz)) throw new HttpError(400, 'setZOffset needs mm');
  if (Math.abs(dz) > 5) throw new HttpError(422, 'setZOffset beyond +/-5 mm is refused');
  const seg = parsed.segments;
  const [l0, l1] = t.span;
  const first = t.segs[0];
  const last = t.segs[t.segs.length - 1];

  // Make sure the region opens at the offset height even if the first move
  // inherits Z from before the region.
  const firstLine = seg.line[first];
  const firstBody = doc.body(firstLine);
  let opened = false;
  if (firstBody != null && isMove(firstBody) && !hasParam(firstBody, 'Z')) {
    doc.setBody(firstLine, setParam(firstBody, 'Z', fmtZ(seg.z1[first] + dz)));
    opened = true;
  }

  let shifted = 0;
  for (let li = l0; li <= l1; li++) {
    const body = doc.body(li);
    if (body == null || !isMove(body)) continue;
    if (li === firstLine && opened) { shifted++; continue; }
    const z = getParam(body, 'Z');
    if (Number.isNaN(z)) continue;
    doc.setBody(li, setParam(body, 'Z', fmtZ(z + dz)));
    shifted++;
  }

  // Put the real Z back on the first move after the region.
  const after = nextSeg(parsed, last);
  if (after >= 0) {
    const la = seg.line[after];
    const b = doc.body(la);
    if (b != null && isMove(b)) doc.setBody(la, setParam(b, 'Z', fmtZ(seg.z1[after])));
  }
  notes.push(`Z shifted by ${dz} mm on ${shifted} move(s) across source lines ${l0}-${l1}; absolute Z restored on the first move after`);
}

// --- delete ----------------------------------------------------------------

/**
 * Remove matching extrusion moves.
 *
 * What is deleted: extruding G0/G1 moves in the target set.
 * What is NEVER deleted:
 *   - any line carrying a non-zero E that is not an extruding move, i.e. every
 *     retract, prime and wipe-retract. Deleting one of those unbalances the
 *     extruder and the validator would (rightly) reject the file.
 *   - anything outside the target set.
 * Position stays coherent for free: XYZ are absolute (G90) throughout the body,
 * so the next surviving move simply travels to its own absolute coordinates.
 * A `;TYPE:` header whose whole block was removed is deleted too, along with
 * its `;WIDTH:`/`;HEIGHT:` annotations, so nothing dangles.
 */
function opDelete(doc, parsed, op, t, notes) {
  const seg = parsed.segments;
  const deletable = new Set();
  for (const i of t.segs) {
    if (seg.kind[i] !== KIND.EXTRUDE) continue;
    deletable.add(seg.line[i]);
  }
  let removed = 0;
  for (const li of deletable) {
    const body = doc.body(li);
    if (body == null || !isMove(body)) continue;
    doc.remove(li);
    removed++;
  }

  // Tidy up blocks that are now empty.
  const blocks = scanBlocks(doc);
  let headers = 0, travels = 0;
  for (const b of blocks) {
    if (b.name.toLowerCase() === 'custom') continue;
    if (b.extrudeLines.some((li) => !doc.isRemoved(li))) continue;
    if (!b.extrudeLines.length) continue; // was already empty before this edit
    for (const li of b.annotationLines) { doc.remove(li); headers++; }
    // Pure travels left stranded inside the dead block go too, but only if they
    // carry no E at all -- a wipe travel carries a negative E and must stay.
    for (const li of b.travelLines) {
      const body = doc.body(li);
      if (body == null) continue;
      const e = getParam(body, 'E');
      if (!Number.isNaN(e) && e !== 0) continue;
      doc.remove(li); travels++;
    }
  }
  notes.push(`removed ${removed} extruding move(s), ${travels} stranded travel(s) and ${headers} now-empty ;TYPE:/;WIDTH:/;HEIGHT: annotation line(s); retract/prime moves were preserved`);
  if (!removed) notes.push('nothing was removed -- deleteRegion only removes extruding moves');
}

/** Walk the document and group lines into `;TYPE:` blocks. */
function scanBlocks(doc) {
  const blocks = [];
  let cur = null;
  const close = () => { if (cur) blocks.push(cur); cur = null; };
  for (let i = 0; i < doc.length; i++) {
    const body = doc.origBody(i);
    if (body == null || body.length === 0) continue;
    if (body.charCodeAt(0) === 59) {
      if (body.startsWith(';TYPE:')) {
        close();
        cur = { name: body.slice(6).trim(), start: i, annotationLines: [i], extrudeLines: [], travelLines: [] };
      } else if (body.startsWith(';LAYER:')) {
        close();
      } else if (cur && (body.startsWith(';WIDTH:') || body.startsWith(';HEIGHT:'))) {
        cur.annotationLines.push(i);
      }
      continue;
    }
    if (!cur || !isMove(body)) continue;
    const e = getParam(body, 'E');
    if (!Number.isNaN(e) && e > 0 && /\b[XY]-?[\d.]/.test(splitComment(body)[0])) cur.extrudeLines.push(i);
    else cur.travelLines.push(i);
  }
  close();
  return blocks;
}

// --- pause -----------------------------------------------------------------

function opInsertPause(doc, parsed, op, notes) {
  const at = Number(op.atLayer);
  if (!Number.isInteger(at)) throw new HttpError(400, 'insertPause needs an integer atLayer');
  const layer = parsed.layers.find((l) => l.index === at);
  if (!layer) {
    throw new HttpError(404, `layer ${at} does not exist`, { layers: [parsed.layers[0]?.index, parsed.layers[parsed.layers.length - 1]?.index] });
  }
  const mode = op.mode === 'park' ? 'park' : 'M600';
  const li = layer.lineStart;

  let lines;
  if (mode === 'M600') {
    // machine.json sets change_filament_gcode = M600, so the firmware owns the
    // park / retract / resume. Nothing here can unbalance the extruder.
    lines = [
      `;GCODE-STUDIO pause before layer ${at} (Z ${layer.z})`,
      'M600 ; filament change / pause -- resume from the printer screen',
    ];
  } else {
    // Explicit park. The retract and the prime are emitted as a matched pair so
    // the extruder state -- and the validator's retract/prime count -- balances.
    const seg = parsed.segments;
    let px = 0, py = 0;
    for (let i = layer.firstSeg - 1; i >= 0; i--) { px = seg.x1[i]; py = seg.y1[i]; break; }
    lines = [
      `;GCODE-STUDIO pause before layer ${at} (Z ${layer.z})`,
      'M83',
      'G1 E-2 F1800 ; retract before parking',
      'G91',
      'G1 Z5 F600 ; lift',
      'G90',
      'G1 X10 Y400 F6000 ; park at the back left',
      'PAUSE ; Klipper -- press RESUME on the screen',
      `G1 X${fmtZ(px)} Y${fmtZ(py)} F6000 ; back to where we stopped`,
      'G91',
      'G1 Z-5 F600 ; back down',
      'G90',
      'G1 E2 F1800 ; prime',
      ';GCODE-STUDIO pause end',
    ];
    notes.push('park mode emits a raw Klipper PAUSE; it assumes a PAUSE/RESUME macro exists on the printer. M600 (the default) is the safer choice on this machine.');
  }

  doc.insertBefore(li, lines);
  return {
    op: 'insertPause', matched: 1, spanLines: [li, li], coverage: 1,
    notes: [...notes, `inserted a ${mode} pause at source line ${li}, the start of layer ${at}`],
  };
}

// ---------------------------------------------------------------------------
// footer maintenance
// ---------------------------------------------------------------------------

/**
 * A Lane A edit changes how long the print takes and how much filament it uses,
 * but the slicer's footer still says the old numbers -- and the printer's screen
 * reads that footer. Rewrite it, and leave a provenance trail.
 *
 * Time is PREDICTED, not measured: the parser's trapezoidal model is rescaled
 * against the slicer's own estimate, so the ratio of the two raw model totals is
 * meaningful even though the absolute model is not. See CONTEXT-server.md.
 */
function updateFooter(doc, { timeSec, filamentMm, filamentCm3, filamentG, layerCount, note, ops, sourceName }) {
  const timeText = formatDuration(timeSec);
  let anchor = -1;
  const set = (i, s) => doc.setBody(i, s);

  for (let i = doc.length - 1; i >= 0 && i > doc.length - 200000; i--) {
    const b = doc.body(i);
    if (b == null) continue;
    if (b.startsWith('; filament used [mm] = ')) { set(i, '; filament used [mm] = ' + filamentMm.toFixed(2)); if (anchor < 0) anchor = i; }
    else if (b.startsWith('; filament used [cm3] = ')) set(i, '; filament used [cm3] = ' + filamentCm3.toFixed(2));
    else if (b.startsWith('; filament used [g] = ')) set(i, '; filament used [g] = ' + filamentG.toFixed(2));
    else if (b.startsWith('; total filament used [g] = ')) set(i, '; total filament used [g] = ' + filamentG.toFixed(2));
    else if (b.startsWith('; total layers count = ')) set(i, '; total layers count = ' + layerCount);
    else if (b.startsWith('; estimated printing time (normal mode) = ')) set(i, '; estimated printing time (normal mode) = ' + timeText);
    else if (b === '; EXECUTABLE_BLOCK_END') { anchor = i; break; }
  }

  if (anchor >= 0) {
    doc.insertAfter(anchor, [
      '',
      '; gcode-studio: edited ' + new Date().toISOString(),
      '; gcode-studio: source = ' + sourceName,
      '; gcode-studio: note = ' + String(note || '').replace(/[\r\n]+/g, ' '),
      '; gcode-studio: ops = ' + ops.map((o) => o.op || o.type).join(', '),
      '; gcode-studio: time and filament in the footer below are PREDICTED from the edit, not re-sliced',
    ]);
  }
  return timeText;
}

// ---------------------------------------------------------------------------
// the request
// ---------------------------------------------------------------------------

function summarise(parsed, timeSecOverride) {
  const seg = parsed.segments;
  let deposited = 0;
  for (let i = 0; i < parsed.count; i++) if (seg.kind[i] === KIND.EXTRUDE) deposited += seg.e[i];
  const area = Math.PI * ((parsed.meta.filamentDiameter || 1.75) / 2) ** 2;
  const cm3 = (deposited * area) / 1000;
  const sec = timeSecOverride ?? parsed.meta.estimatedTimeSec;
  return {
    timeSec: Math.round(sec),
    timeText: formatDuration(sec),
    filamentMm: Math.round(deposited * 100) / 100,
    filamentCm3: Math.round(cm3 * 100) / 100,
    filamentG: Math.round(cm3 * (parsed.meta.filamentDensity || 1.24) * 100) / 100,
    layers: parsed.layers.length,
    moves: parsed.count,
    maxZ: parsed.meta.maxZ,
  };
}

/** Raw (unscaled) total of the parser's time model. */
function rawTime(parsed) {
  if (parsed.timeScale > 0 && parsed.meta.estimatedTimeSec > 0) {
    return parsed.meta.estimatedTimeSec / parsed.timeScale;
  }
  let t = 0;
  for (let i = 0; i < parsed.count; i++) t += parsed.segments.time[i];
  return t;
}

/**
 * POST /api/edit
 * body: { path, ops: [...], dryRun = true, note }
 * -> { ok, dryRun, preview, validation, diff, outPath, written }
 */
export async function handleEdit(body) {
  const p = body?.path;
  const ops = body?.ops;
  const dryRun = body?.dryRun !== false; // DEFAULT: dry run, write nothing
  const note = typeof body?.note === 'string' ? body.note : '';

  if (!Array.isArray(ops) || ops.length === 0) {
    throw new HttpError(400, 'ops must be a non-empty array', { known: EDIT_OPS });
  }
  if (ops.length > 64) throw new HttpError(400, 'at most 64 ops per request');
  if (!dryRun && !note.trim()) {
    throw new HttpError(400,
      'note is required for a real write: it becomes the "<what-changed>" field of the new filename');
  }

  const src = await parseFile(p);
  if (!src.parsed.relativeE) {
    throw new HttpError(422,
      'this file is not M83 relative extrusion, so editing is disabled outright (CONTEXT.md safety rule 5)');
  }

  const doc = new LineDoc(src.text, src.parsed.meta.eol);
  const applied = [];
  for (const op of ops) applied.push(applyOp(doc, src.parsed, op));

  // Parse the edited body once to work out the new time and filament totals ...
  const stage1 = parseGcode(doc.render());
  const scale = rawTime(src.parsed);
  const predictedSec = scale > 0 ? src.parsed.meta.estimatedTimeSec * (rawTime(stage1) / scale) : stage1.meta.estimatedTimeSec;
  const after0 = summarise(stage1, predictedSec);

  // ... then write them into the footer, and validate what actually lands on disk.
  updateFooter(doc, {
    timeSec: predictedSec,
    filamentMm: after0.filamentMm,
    filamentCm3: after0.filamentCm3,
    filamentG: after0.filamentG,
    layerCount: stage1.layers.length,
    note, ops, sourceName: path.basename(src.abs),
  });

  const finalText = doc.render();
  const finalParsed = parseGcode(finalText);
  const validation = validate(finalText, { parsed: finalParsed, original: src.parsed, ops });

  const before = summarise(src.parsed);
  const after = summarise(finalParsed, predictedSec);
  const diff = doc.diff();

  // Where this would land, per the naming convention.
  let outPath = null, plan = null, planError = null;
  try {
    const versions = await listVersions(path.dirname(src.abs));
    plan = planVersion({ currentPath: src.abs, changed: note || 'edit', timeSec: predictedSec, versions });
    outPath = relPath(plan.newPath);
  } catch (e) {
    planError = e.message;
  }

  const result = {
    ok: validation.ok,
    dryRun,
    written: false,
    file: relPath(src.abs),
    preview: {
      ops: applied,
      before,
      after,
      delta: {
        timeSec: after.timeSec - before.timeSec,
        timePct: before.timeSec ? Math.round(((after.timeSec - before.timeSec) / before.timeSec) * 1000) / 10 : 0,
        filamentMm: Math.round((after.filamentMm - before.filamentMm) * 100) / 100,
        filamentG: Math.round((after.filamentG - before.filamentG) * 100) / 100,
        moves: after.moves - before.moves,
      },
      bytes: { before: Buffer.byteLength(src.text), after: Buffer.byteLength(finalText) },
      timeIsPredicted: true,
    },
    validation,
    diff,
    outPath,
    planError,
  };

  if (dryRun) return result;

  if (!validation.ok) {
    throw new HttpError(422, 'validation failed, nothing was written', {
      errors: validation.errors, warnings: validation.warnings, outPath,
    });
  }

  const versions = await listVersions(path.dirname(src.abs));
  const commit = await commitVersion({
    currentPath: src.abs, text: finalText, changed: note, timeSec: predictedSec, versions,
  });
  invalidate(src.abs);
  result.written = true;
  result.outPath = commit.newPath;
  result.commit = commit;
  return result;
}
