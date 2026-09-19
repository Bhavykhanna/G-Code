/**
 * selection.js -- turns a set of picked move indices into something Claude and
 * the editor can both act on.
 *
 * The 3D view deals in move indices. Editing deals in source line numbers. This
 * is the translation between them, and it is the single most important piece of
 * glue in the app: get it wrong and an edit lands on the wrong lines.
 */

import { FEATURE_NAMES, KIND, segLength, flowRate } from './parser/parse.js';

/**
 * Collapse move indices into contiguous source line ranges.
 *
 * Moves are stored in file order, so their line numbers are ascending, but a
 * selection is usually sparse -- the user boxes a region and gets runs of moves
 * separated by the travels between them. Merging runs that are adjacent (or
 * separated only by a line or two of comments/annotations) keeps the range list
 * short and keeps whole `;TYPE:` blocks intact instead of slicing through them.
 *
 * @param {Uint32Array} lineNumbers 0-based, ascending
 * @param {number} gapTolerance lines that may separate two runs and still merge
 * @returns {Array<[number, number]>} inclusive ranges
 */
export function toLineRanges(lineNumbers, gapTolerance = 3) {
  if (!lineNumbers.length) return [];
  const sorted = Array.from(lineNumbers).sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i];
    if (n === prev) continue;
    if (n - prev <= gapTolerance + 1) {
      prev = n;
    } else {
      ranges.push([start, prev]);
      start = prev = n;
    }
  }
  ranges.push([start, prev]);
  return ranges;
}

/**
 * Build the full selection object -- the shape documented in
 * docs/CONTEXT-bridge.md, which is what gets written to bridge/selection.json.
 *
 * @param {Uint32Array} indices  move indices from the viewer
 * @param {object} parsed        the parse result
 * @param {string} filePath      path of the file the indices belong to
 */
export function buildSelection(indices, parsed, filePath) {
  const seg = parsed.segments;
  const n = indices.length;

  if (!n) return null;

  const lines = new Uint32Array(n);
  const features = Object.create(null);

  let lengthMm = 0, timeSec = 0, filamentMm = 0;
  let minLayer = Infinity, maxLayer = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  // where on the bed: "see here" means little without it
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

  const stat = () => ({ min: Infinity, max: -Infinity, sum: 0, n: 0 });
  const speed = stat(), width = stat(), fan = stat(), flow = stat();
  const add = (s, v) => {
    if (!Number.isFinite(v)) return;
    if (v < s.min) s.min = v;
    if (v > s.max) s.max = v;
    s.sum += v; s.n++;
  };

  for (let i = 0; i < n; i++) {
    const k = indices[i];
    lines[i] = seg.line[k];

    const layer = seg.layer[k];
    if (layer < minLayer) minLayer = layer;
    if (layer > maxLayer) maxLayer = layer;

    const z = seg.z1[k];
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;

    timeSec += seg.time[k];

    if (seg.kind[k] === KIND.EXTRUDE) {
      const name = FEATURE_NAMES[seg.feature[k]];
      const len = segLength(seg, k);
      const f = features[name] || (features[name] = { count: 0, lengthMm: 0, timeSec: 0 });
      f.count++;
      f.lengthMm += len;
      f.timeSec += seg.time[k];
      lengthMm += len;
      filamentMm += seg.e[k];
      minX = Math.min(minX, seg.x0[k], seg.x1[k]); maxX = Math.max(maxX, seg.x0[k], seg.x1[k]);
      minY = Math.min(minY, seg.y0[k], seg.y1[k]); maxY = Math.max(maxY, seg.y0[k], seg.y1[k]);
      add(speed, seg.speed[k]);
      add(width, seg.width[k]);
      add(fan, seg.fan[k]);
      add(flow, flowRate(seg, k, parsed.meta.filamentDiameter));
    }
  }

  for (const f of Object.values(features)) {
    f.lengthMm = round(f.lengthMm);
    f.timeSec = round(f.timeSec);
  }

  const done = (s) => (s.n
    ? { min: round(s.min), max: round(s.max), avg: round(s.sum / s.n) }
    : { min: 0, max: 0, avg: 0 });

  return {
    id: 'sel-' + Date.now(),
    file: filePath,
    createdAt: new Date().toISOString(),
    lineRanges: toLineRanges(lines),
    summary: {
      count: n,
      layers: [minLayer, maxLayer],
      zRange: [round(minZ), round(maxZ)],
      xRange: Number.isFinite(minX) ? [round(minX), round(maxX)] : null,
      yRange: Number.isFinite(minY) ? [round(minY), round(maxY)] : null,
      features,
      lengthMm: round(lengthMm),
      timeSec: round(timeSec),
      filamentMm: round(filamentMm),
      speed: done(speed),
      width: done(width),
      fan: done(fan),
      flow: done(flow),
    },
  };
}

/**
 * A one-line description of a selection, for the chat chip and log messages.
 * e.g. "812 moves - layers 34-41 - Outer wall"
 */
export function describeSelection(sel) {
  if (!sel) return 'nothing selected';
  const s = sel.summary;
  const count = (v) => (typeof v === 'number' ? v : v.count);
  const top = Object.entries(s.features).sort((a, b) => count(b[1]) - count(a[1]))[0];
  const parts = [
    s.count.toLocaleString() + ' moves',
    s.layers[0] === s.layers[1] ? 'layer ' + s.layers[0] : 'layers ' + s.layers[0] + '-' + s.layers[1],
  ];
  if (top) parts.push(top[0]);
  return parts.join(' · ');
}

/** Everything the viewer must highlight for a selection restored from disk. */
export function indicesForLineRanges(ranges, parsed) {
  const seg = parsed.segments;
  const out = [];
  for (let i = 0; i < parsed.count; i++) {
    const ln = seg.line[i];
    for (const [a, b] of ranges) {
      if (ln >= a && ln <= b) { out.push(i); break; }
    }
  }
  return Uint32Array.from(out);
}

function round(v) {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
}
