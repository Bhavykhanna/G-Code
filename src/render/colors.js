/**
 * colors.js -- the single source of colour for the whole app.
 *
 * Feature colours follow OrcaSlicer's preview legend so the view reads the same
 * as the ElegooSlicer preview you already know. If a colour looks off next to
 * the real slicer, change it here -- nothing else hardcodes a colour.
 *
 * Every export is plain data so the UI legend and the WebGL renderer stay in
 * sync by construction.
 */

import { FEATURE_NAMES } from '../parser/parse.js';

/** Feature index -> hex colour. Index order matches FEATURE_NAMES exactly. */
export const FEATURE_COLORS = [
  '#9b9b9b', // Unknown
  '#ffe640', // Inner wall
  '#ff7d28', // Outer wall
  '#1f1fff', // Overhang wall
  '#b03030', // Sparse infill
  '#9654cc', // Internal solid infill
  '#f04040', // Top surface
  '#40c0a0', // Bottom surface
  '#ff8c69', // Ironing
  '#4d80ba', // Bridge
  '#6ea4d8', // Internal Bridge
  '#ffffff', // Gap infill
  '#857b21', // Skirt
  '#a8983a', // Brim
  '#00b000', // Support
  '#008000', // Support interface
  '#b3e3ab', // Prime tower
  '#5ed194', // Custom
];

/** Colours for non-extruding moves. */
export const TRAVEL_COLOR = '#3fb5e8';
export const RETRACT_COLOR = '#ff3b6b';
export const PRIME_COLOR = '#37d67a';

/** Highlight applied to the current selection. */
export const SELECT_COLOR = '#00e5ff';

/**
 * Compare (Diff) colours. Chosen against the #0e1116 background and away from
 * the feature palette: the added green is bluer and brighter than Support
 * (#00b000), the removed red pinker than Top surface (#f04040) / Sparse infill
 * (#b03030), and "same" is a dark slate so the change pops over it. The ghost
 * is magenta, which no feature uses.
 */
/**
 * Claude's pointer boxes (app-cli.js show), one colour per box, in order.
 * White first: it is the one colour no feature, view ramp, selection (cyan),
 * diff (green / red / grey) or ghost (magenta) uses at full brightness.
 */
export const CLAUDE_COLORS = ['#ffffff', '#ffe14d', '#ff7ad9', '#9d8cff', '#7df9ff', '#ffb366', '#bef264', '#60a5fa'];

export const DIFF_ADDED = '#3ee88a';
export const DIFF_REMOVED = '#ff4d6d';
export const DIFF_SAME = '#4a525e';
export const GHOST_COLOR = '#d25bff';
/** Alpha of the ghost (other file) in 'both' mode. */
export const GHOST_OPACITY = 0.22;

/**
 * Continuous colour ramps for the numeric view modes. Each is a list of stops
 * sampled linearly; `sampleRamp` interpolates between them.
 * Viridis-style ramps stay readable for colour-blind viewers and in both themes.
 */
export const RAMPS = {
  speed: ['#2b1a54', '#3f4a8a', '#2f7d8f', '#3fae6d', '#9fd13c', '#f9e721'],
  flow: ['#08306b', '#2171b5', '#6baed6', '#c6dbef', '#fdd0a2', '#f16913'],
  fan: ['#22313f', '#2e6b8f', '#48a9c5', '#9fe0ef', '#e8fbff'],
  temp: ['#1b2a6b', '#4a4fa8', '#a05ba0', '#e06a5a', '#ffc04d'],
  width: ['#003f5c', '#3d6d94', '#7a9cc6', '#bf8fa0', '#ff6361'],
  height: ['#003f5c', '#3d6d94', '#7a9cc6', '#bf8fa0', '#ff6361'],
  layerTime: ['#0d2b45', '#2a6f8f', '#57b8a9', '#b7e07a', '#ffe066'],
};

/** The numeric view modes the UI offers, with the segment field each reads. */
export const VIEW_MODES = [
  { id: 'feature', label: 'Feature type', field: null, unit: '' },
  { id: 'speed', label: 'Speed', field: 'speed', unit: 'mm/s' },
  { id: 'flow', label: 'Volumetric flow', field: null, unit: 'mm3/s' },
  { id: 'fan', label: 'Fan', field: 'fan', unit: '%' },
  { id: 'temp', label: 'Nozzle temp', field: 'temp', unit: 'C' },
  { id: 'width', label: 'Line width', field: 'width', unit: 'mm' },
  { id: 'height', label: 'Layer height', field: 'height', unit: 'mm' },
];

/** '#rrggbb' -> [r, g, b] in 0..1 */
export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** [r,g,b] 0..1 -> '#rrggbb' */
export function rgbToHex([r, g, b]) {
  const h = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

/**
 * Sample a ramp at t in 0..1.
 * @returns {[number,number,number]} rgb in 0..1
 */
export function sampleRamp(ramp, t) {
  if (!Number.isFinite(t)) t = 0;
  t = Math.max(0, Math.min(1, t));
  const stops = RAMPS[ramp] || RAMPS.speed;
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = hexToRgb(stops[i]);
  const b = hexToRgb(stops[i + 1]);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/**
 * Legend entries for the current view mode, ready to render.
 *
 *   legendFor('feature', counts?)   counts = {name: n}: only features in the file
 *   legendFor(mode, range, unit)    range from the renderer's getValueRange():
 *       single / discrete -> one row per value the file uses, with its share
 *       quantile          -> gradient ticks at the real values
 *   legendFor(mode, min, max, unit) plain linear ticks (old form, mock UI)
 *
 * The returned array carries `layout` ('list' | 'ramp') and `note`.
 */
export function legendFor(mode, min, max, unit) {
  if (mode === 'feature') {
    const counts = min && typeof min === 'object' ? min : null;
    const out = FEATURE_NAMES.map((name, i) => ({ name, color: FEATURE_COLORS[i], i }))
      .filter((e) => e.i !== 0 && (!counts || counts[e.name] > 0));
    out.layout = 'list';
    return out;
  }
  if (min && typeof min === 'object') return legendForScale(mode, min, max);
  const steps = 6;
  const out = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const v = min + (max - min) * t;
    out.push({ name: formatValue(v, unit), color: rgbToHex(sampleRamp(mode, t)) });
  }
  return out;
}

function legendForScale(mode, r, unit) {
  const tOf = (v) => {
    const A = r.anchors || [];
    if (A.length < 2 || v <= A[0].v) return A.length ? A[0].t : 0;
    for (let k = 1; k < A.length; k++) {
      if (v <= A[k].v) return A[k - 1].t + (A[k].t - A[k - 1].t) * ((v - A[k - 1].v) / (A[k].v - A[k - 1].v));
    }
    return A[A.length - 1].t;
  };
  const colorAt = (t) => rgbToHex(sampleRamp(mode, t));
  let out;
  if (r.kind === 'single' || r.kind === 'discrete') {
    const vals = r.values || [];
    out = vals.slice().reverse().map((g) => ({
      name: formatValue(g.v, unit, mode),
      color: colorAt(tOf(g.v)),
      share: vals.length > 1 ? g.share : null,
    }));
    out.layout = 'list';
    out.note = r.kind === 'single' ? 'the whole print'
      : r.otherCount ? `+${r.otherCount} other value${r.otherCount === 1 ? '' : 's'} in between (${pct(r.otherShare)})` : '';
    return out;
  }
  // quantile: the bar is even in plastic, so ticks are the values at even steps
  const A = r.anchors || [];
  const valueAt = (t) => {
    if (!A.length) return r.min;
    if (t <= A[0].t) return A[0].v;
    for (let k = 1; k < A.length; k++) {
      if (t <= A[k].t) return A[k - 1].v + (A[k].v - A[k - 1].v) * ((t - A[k - 1].t) / ((A[k].t - A[k - 1].t) || 1));
    }
    return A[A.length - 1].v;
  };
  out = [0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => ({ name: formatValue(valueAt(t), unit, mode), color: colorAt(t) }));
  out.layout = 'ramp';
  out.note = 'each colour band = the same amount of plastic';
  return out;
}

function pct(x) {
  const p = x * 100;
  return (p < 1 ? p.toFixed(1) : Math.round(p)) + ' %';
}
export { pct as formatShare };

function formatValue(v, unit, mode) {
  if (mode === 'width' || mode === 'height') return v.toFixed(2) + (unit ? ' ' + unit : '');
  if (mode === 'speed' || mode === 'temp' || mode === 'fan') {
    const r = Math.round(v * 10) / 10;
    return (Number.isInteger(r) ? String(r) : r.toFixed(1)) + (unit ? ' ' + unit : '');
  }
  const d = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
  return v.toFixed(d) + (unit ? ' ' + unit : '');
}

export { FEATURE_NAMES };
