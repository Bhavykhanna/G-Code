/**
 * align.js -- centring a finished part on the bed, and lining two versions up
 * again for the diff.
 *
 * Pure, no DOM, no Node APIs: used by the server (Finalize, centre-cli.js) and
 * by the app (the diff). See docs/CONTEXT-compare.md, "Centring and alignment".
 *
 * The rule (user, 2026-09-16): drafts stay lined up with the final they came
 * from, so a draft-vs-final diff needs nothing. **Finalize centres the part**
 * on the bed and writes the shift it applied into
 * `<job>\old\v<N>-steps\align.json`:
 *
 *   { "<model>": { "final": "<final name>", "dx": 2.1, "dy": 0,
 *                  "alignedWith": "<Archive-relative file the draft was lined up with>",
 *                  "bedCentre": [213, 213], "date": "2026-09-16",
 *                  "atFinal": ["04-...gcode"] } }
 *
 * Files in the steps folder sit where the version sat BEFORE centring, except
 * the ones named in `atFinal`: copies of the centred final itself (e.g. the old
 * final kept when a small fix replaced it under the same name, 2026-09-17).
 *
 * To diff final vK against an older file, walk the notes back from vK,
 * adding up the shifts, until the older file is reached; the old file is
 * drawn moved by that total.
 */

// Features that are not the part: unknown, skirt, brim, prime tower, custom.
const NOT_PART = new Set([0, 12, 13, 16, 17]);
const EXTRUDE = 0;

/** Bounding box of the part itself (walls, infill, surfaces), bed mm. */
export function partBox(parse) {
  const s = parse.segments;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < parse.count; i++) {
    if (s.kind[i] !== EXTRUDE || NOT_PART.has(s.feature[i])) continue;
    const w = (s.width[i] || 0) / 2;
    x0 = Math.min(x0, s.x0[i] - w, s.x1[i] - w); x1 = Math.max(x1, s.x0[i] + w, s.x1[i] + w);
    y0 = Math.min(y0, s.y0[i] - w, s.y1[i] - w); y1 = Math.max(y1, s.y0[i] + w, s.y1[i] + w);
  }
  if (!Number.isFinite(x0)) return null;
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

/** Everything that is printed (part, skirt, brim), bed mm. */
function printedBox(parse) {
  const s = parse.segments;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < parse.count; i++) {
    if (s.kind[i] !== EXTRUDE) continue;
    x0 = Math.min(x0, s.x0[i], s.x1[i]); x1 = Math.max(x1, s.x0[i], s.x1[i]);
    y0 = Math.min(y0, s.y0[i], s.y1[i]); y1 = Math.max(y1, s.y0[i], s.y1[i]);
  }
  return { x0, y0, x1, y1 };
}

/** Bed rectangle from the file's own bed_shape (default 426 x 426). */
export function bedBox(parse) {
  const shape = parse.meta && parse.meta.bedShape;
  const pts = shape && shape.length >= 3 ? shape : [[0, 0], [426, 0], [426, 426], [0, 426]];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const b = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  return { ...b, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2 };
}

const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * How far the part must move to sit on the bed centre, and whether it still
 * fits there. `{dx, dy, part, bed, fits}`; dx/dy rounded to 0.001 mm.
 */
export function centreShift(parse) {
  const part = partBox(parse);
  if (!part) throw new Error('no printed part found in this file');
  const bed = bedBox(parse);
  const dx = r3(bed.cx - part.cx), dy = r3(bed.cy - part.cy);
  const all = printedBox(parse);
  const fits = all.x0 + dx >= bed.x0 && all.x1 + dx <= bed.x1 && all.y0 + dy >= bed.y0 && all.y1 + dy <= bed.y1;
  return { dx, dy, part, bed, fits };
}

const NUM = /(^|\s)([XY])(-?\d*\.?\d+)/g;
const fmt = (v) => {
  const s = (Math.round(v * 1000) / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
};

/**
 * Move the print by (dx, dy): every absolute X/Y on G0-G3 lines of the print
 * body (from the first layer to ;PRINT_END), and the EXCLUDE_OBJECT outlines.
 * Start / end G-code (purge line, park) stays where the machine profile put
 * it; arc centres (I/J) are relative and need nothing. Relative (G91) moves
 * are left alone. Comments and every other line are kept byte for byte.
 *
 * @returns {{text: string, changedLines: number}}
 */
export function shiftGcode(text, dx, dy) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);
  const start = lines.findIndex((l) => /^;LAYER:1\b/.test(l) || l.startsWith(';LAYER_CHANGE'));
  if (start < 0) throw new Error('no ;LAYER:1 / ;LAYER_CHANGE marker: cannot tell the print body from the start G-code');
  let absolute = true;
  let inBody = false;
  let changed = 0;
  for (let n = 0; n < lines.length; n++) {
    const ln = lines[n];
    if (n === start) inBody = true;
    if (ln.startsWith(';PRINT_END')) inBody = false;
    if (ln.startsWith('EXCLUDE_OBJECT_DEFINE')) {
      const out = ln
        .replace(/CENTER=(-?[\d.]+),(-?[\d.]+)/, (_, a, b) => `CENTER=${fmt(+a + dx)},${fmt(+b + dy)}`)
        .replace(/\[(-?[\d.]+),(-?[\d.]+)\]/g, (_, a, b) => `[${fmt(+a + dx)},${fmt(+b + dy)}]`);
      if (out !== ln) { lines[n] = out; changed++; }
      continue;
    }
    const code = ln.split(';', 1)[0];
    if (/^\s*G90\b/.test(code)) absolute = true;
    else if (/^\s*G91\b/.test(code)) absolute = false;
    if (!inBody || !absolute || !/^G[0-3]\s/.test(code)) continue;
    const moved = code.replace(NUM, (_, pre, axis, v) => pre + axis + fmt(+v + (axis === 'X' ? dx : dy)));
    if (moved !== code) { lines[n] = moved + ln.slice(code.length); changed++; }
  }
  return { text: lines.join(eol), changedLines: changed };
}

/** `..._v3-...gcode` -> {model, filament, layerHeight, version, draft} (null if not the convention). */
export function nameFields(name) {
  const m = /^EN4Max_[\d.]+_(.+?)_([^_]+)_([\d.]+)_v(\d+)-(.+?)(?:_([\dhm]+))?\.gcode$/i.exec(name);
  if (!m) return null;
  return { model: m[1], filament: m[2], layerHeight: m[3], version: Number(m[4]), draft: /^draft$/i.test(m[5]) };
}

const dirOf = (p) => p.replace(/[\\/][^\\/]*$/, '');
const baseName = (p) => p.split(/[\\/]/).pop();
const norm = (p) => (p || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();

/** Where the align note for a version lives: `<job>/old/v<N>-steps/align.json`. */
export function notePath(filePath, version) {
  let dir = dirOf(filePath.replace(/\\/g, '/'));
  if (baseName(dir).toLowerCase() === 'old') dir = dirOf(dir);
  return `${dir}/old/v${version}-steps/align.json`;
}

/**
 * The shift that lines `basePath` up with `curPath`, from the align notes.
 *
 * @param {string} curPath
 * @param {string} basePath
 * @param {(path: string) => Promise<object|null>} readNote   parsed align.json or null
 * @param {(path: string) => Promise<string|null>} [baseOfDraft]  the final a draft came from
 * @returns {Promise<{dx:number, dy:number, steps:string[]} | null>}  null = no notes connect them
 */
export async function alignFor(curPath, basePath, readNote, baseOfDraft) {
  const target = norm(basePath);
  let p = curPath, dx = 0, dy = 0;
  const steps = [];
  for (let guard = 0; guard < 30 && p; guard++) {
    // `alignedWith` names where a file was when the note was written; Finalize
    // later moves that final into old\, so its old\ copy is the same file
    if (norm(p) === target || norm(dirOf(p) + '/old/' + baseName(p)) === target) {
      return { dx: r3(dx), dy: r3(dy), steps };
    }
    const f = nameFields(baseName(p));
    if (!f) return null;
    if (f.draft) {
      // a draft sits where the final it came from sits
      p = baseOfDraft ? await baseOfDraft(p) : null;
      continue;
    }
    const note = await readNote(notePath(p, f.version));
    const entry = note && note[f.model];
    if (!entry || norm(entry.final) !== norm(baseName(p))) return null;
    const stepsDir = norm(notePath(p, f.version)).replace(/align\.json$/, '');
    const inSteps = target.startsWith(stepsDir) && target.endsWith('.gcode');
    // a kept copy of the centred final sits where the final sits
    if (inSteps && (entry.atFinal || []).some((n) => norm(stepsDir + n) === target)) {
      return { dx: r3(dx), dy: r3(dy), steps };
    }
    dx += entry.dx || 0; dy += entry.dy || 0;
    // every other file in this version's steps folder (the draft states, the
    // copy taken before centring) sits where the version sat before centring
    if (inSteps && !target.includes('/00-from-')) {
      return { dx: r3(dx), dy: r3(dy), steps };
    }
    const mm = (v, ax) => (v ? `${v > 0 ? '+' : ''}${v} ${ax}` : '');
    steps.push(`${baseName(p)}: ` + ([mm(entry.dx, 'X'), mm(entry.dy, 'Y')].filter(Boolean).join(', ') || 'no shift'));
    p = entry.alignedWith;
  }
  return null;
}

/** A copy of a parse result with every X/Y moved by (dx, dy); the input is not touched. */
export function shiftParse(parse, dx, dy) {
  if (!dx && !dy) return parse;
  const s = parse.segments;
  const add = (a, d) => { const o = new a.constructor(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] + d; return o; };
  return {
    ...parse,
    segments: { ...s, x0: add(s.x0, dx), x1: add(s.x1, dx), y0: add(s.y0, dy), y1: add(s.y1, dy) },
  };
}
