/**
 * thumbnail-render.js -- draws a G-code parse result as a printer-screen preview,
 * with no browser and no GPU.
 *
 * Why this exists: the preview the Neptune 4 shows comes from images embedded in
 * the G-code, and CLI slicing never renders them (it has no GL context). The app
 * can capture one from its WebGL view, but that needs a window open. This
 * renderer lets the server, the CLI and the re-slice path add a preview on
 * their own.
 *
 * Look: matches ElegooSlicer's own thumbnails -- a single blue model on a
 * transparent background, seen from the front-left and above. The colours were
 * sampled from the GUI-sliced 3DBenchy in ..\..\ (lit ~rgb(49,158,214),
 * shadow ~rgb(24,89,123)).
 *
 * Method: orthographic projection, every extruding move stamped as a thick
 * line into a depth buffer, lit per move from a normal inferred from the
 * feature type (walls face sideways, surfaces face up). Rendered at 2x and
 * box-filtered down by the injector, which gives clean antialiased edges.
 */

import { KIND, FEATURE_NAMES } from '../src/parser/parse.js';

const BASE = [52, 168, 226];
const AMBIENT = 0.42;

/** Features the GUI leaves out of its preview: they are not part of the model. */
const SKIP = new Set(['Skirt', 'Brim', 'Prime tower', 'Custom', 'Unknown']);

/** Horizontal features: their normal points straight up. */
const FLAT = new Set([
  'Top surface', 'Ironing', 'Bottom surface', 'Sparse infill',
  'Internal solid infill', 'Bridge', 'Internal Bridge', 'Gap infill',
  'Support', 'Support interface',
]);

/**
 * @param {object} parsed  result of parseGcode
 * @param {{size?:number, azimuthDeg?:number, elevationDeg?:number, margin?:number}} [opts]
 * @returns {{rgba: Uint8Array, width: number, height: number, drawn: number}}
 */
export function renderThumbnail(parsed, opts = {}) {
  const size = opts.size || 640;
  const az = ((opts.azimuthDeg ?? -60) * Math.PI) / 180;
  const el = ((opts.elevationDeg ?? 38) * Math.PI) / 180;
  const margin = opts.margin ?? 0.08;

  // Unit vector from the model toward the camera, and the screen basis.
  const d = [Math.cos(el) * Math.sin(az), -Math.cos(el) * Math.cos(az), Math.sin(el)];
  const r = normalize(cross([0, 0, 1], d));          // screen right
  const u = cross(d, r);                               // screen up
  // Light from the camera side, raised and a little to the left.
  const L = normalize([d[0] - 0.35 * r[0] + 0.3 * u[0], d[1] - 0.35 * r[1] + 0.3 * u[1], d[2] + 0.35]);

  const s = parsed.segments;
  const n = parsed.count;
  const keep = new Uint8Array(n);
  const flat = new Uint8Array(FEATURE_NAMES.length);
  const skip = new Uint8Array(FEATURE_NAMES.length);
  FEATURE_NAMES.forEach((name, i) => {
    flat[i] = FLAT.has(name) ? 1 : 0;
    skip[i] = SKIP.has(name) ? 1 : 0;
  });

  // Bounds in screen space, over the moves we will actually draw.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let kept = 0;
  for (let i = 0; i < n; i++) {
    if (s.kind[i] !== KIND.EXTRUDE || skip[s.feature[i]]) continue;
    keep[i] = 1;
    kept++;
    for (const [x, y, z] of [[s.x0[i], s.y0[i], s.z0[i]], [s.x1[i], s.y1[i], s.z1[i]]]) {
      const sx = x * r[0] + y * r[1] + z * r[2];
      const sy = x * u[0] + y * u[1] + z * u[2];
      if (sx < minX) minX = sx; if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
    }
  }
  const rgba = new Uint8Array(size * size * 4);
  if (!kept) return { rgba, width: size, height: size, drawn: 0 };

  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const scale = (size * (1 - 2 * margin)) / span;         // px per mm
  const ox = (size - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = (size - (maxY - minY) * scale) / 2 + maxY * scale;

  const depth = new Float32Array(size * size).fill(-Infinity);

  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const x0 = s.x0[i], y0 = s.y0[i], z0 = s.z0[i];
    const x1 = s.x1[i], y1 = s.y1[i], z1 = s.z1[i];

    // Normal: up for surfaces, sideways (toward the camera) for walls.
    let nx = 0, ny = 0, nz = 1;
    if (!flat[s.feature[i]]) {
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      nx = dy / len; ny = -dx / len; nz = 0;
      if (nx * d[0] + ny * d[1] < 0) { nx = -nx; ny = -ny; }
      // A little upward tilt so wall tops catch light like a rounded bead.
      nz = 0.25;
      const m = Math.hypot(nx, ny, nz); nx /= m; ny /= m; nz /= m;
    }
    const lambert = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
    const k = AMBIENT + (1 - AMBIENT) * lambert;
    const cr = Math.min(255, BASE[0] * k), cg = Math.min(255, BASE[1] * k), cb = Math.min(255, BASE[2] * k);

    const ax = (x0 * r[0] + y0 * r[1] + z0 * r[2]) * scale + ox;
    const ay = oy - (x0 * u[0] + y0 * u[1] + z0 * u[2]) * scale;
    const az0 = x0 * d[0] + y0 * d[1] + z0 * d[2];
    const bx = (x1 * r[0] + y1 * r[1] + z1 * r[2]) * scale + ox;
    const by = oy - (x1 * u[0] + y1 * u[1] + z1 * u[2]) * scale;
    const bz = x1 * d[0] + y1 * d[1] + z1 * d[2];

    const w = s.width[i] || 0.45;
    const rad = Math.max(0.75, (w * scale) / 2);
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    const ri = Math.ceil(rad);
    const rr = rad * rad;

    for (let t = 0; t <= steps; t++) {
      const f = t / steps;
      const cx = ax + (bx - ax) * f;
      const cy = ay + (by - ay) * f;
      const cz = az0 + (bz - az0) * f;
      const px0 = Math.max(0, Math.floor(cx - ri)), px1 = Math.min(size - 1, Math.ceil(cx + ri));
      const py0 = Math.max(0, Math.floor(cy - ri)), py1 = Math.min(size - 1, Math.ceil(cy + ri));
      for (let py = py0; py <= py1; py++) {
        const ddy = py + 0.5 - cy;
        for (let px = px0; px <= px1; px++) {
          const ddx = px + 0.5 - cx;
          if (ddx * ddx + ddy * ddy > rr) continue;
          const p = py * size + px;
          if (cz <= depth[p]) continue;
          depth[p] = cz;
          const q = p * 4;
          rgba[q] = cr; rgba[q + 1] = cg; rgba[q + 2] = cb; rgba[q + 3] = 255;
        }
      }
    }
  }

  return { rgba, width: size, height: size, drawn: kept };
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(v) {
  const m = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / m, v[1] / m, v[2] / m];
}
