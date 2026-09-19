/**
 * area.js -- "area select": every extrusion inside a screen rectangle,
 * hidden or not (see AREA_MATCH for what "inside" means). Pure math on typed arrays; no DOM, no
 * WebGL, no THREE objects, so it runs (and is tested) in Node.
 *
 * Box select (picking.js) is a visibility test; this is its through-the-model
 * counterpart. Occlusion is ignored on purpose -- see docs/CONTEXT-render.md.
 *
 * Hot loop: 92k segments, no allocation per segment, the 4x4 transform is
 * written out by hand. Measured by test/check-area-select.js.
 */

/**
 * `out = proj * view`, both column-major 16-element arrays (THREE's
 * `Matrix4.elements`). Result is column-major too.
 * @param {ArrayLike<number>} p projection matrix elements
 * @param {ArrayLike<number>} v view matrix (camera.matrixWorldInverse) elements
 * @param {Float64Array} [out]
 */
export function viewProjection(p, v, out = new Float64Array(16)) {
  for (let c = 0; c < 4; c++) {
    const v0 = v[c * 4], v1 = v[c * 4 + 1], v2 = v[c * 4 + 2], v3 = v[c * 4 + 3];
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = p[r] * v0 + p[4 + r] * v1 + p[8 + r] * v2 + p[12 + r] * v3;
    }
  }
  return out;
}

/**
 * Normalise a drag rectangle: `{x0,y0,x1,y1,w,h}` with x0 <= x1, y0 <= y1.
 */
export function normRect(ax, ay, bx, by) {
  const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
  const y0 = Math.min(ay, by), y1 = Math.max(ay, by);
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/**
 * How a move has to relate to the rectangle to count.
 *   'inside' -- both ends inside (default). A long skirt, brim or infill line
 *               that merely crosses the rectangle is NOT taken.
 *   'center' -- its midpoint is inside. Takes crossing lines whose middle
 *               happens to fall in the rectangle -- which is how a whole skirt
 *               line ends up selected. Kept because it is the loosest-but-one.
 *   'touch'  -- any part of it is inside.
 */
export const AREA_MATCH = ['inside', 'center', 'touch'];

/**
 * @param {object} a
 * @param {{x0,y0,x1,y1,feature}} a.seg     parse.segments (struct of arrays)
 * @param {Uint32Array} a.segOf             slot -> segment index (built.extrude.segOf)
 * @param {number} a.slotStart              first slot, inclusive
 * @param {number} a.slotEnd                last slot, exclusive
 * @param {Set<number>|null} a.features     visible feature ids; null = all
 * @param {Set<number>|null} [a.exclude]    feature ids never taken (skirt, brim, purge line)
 * @param {'inside'|'center'|'touch'} [a.match]  default 'inside'
 * @param {ArrayLike<number>} a.viewProj    column-major proj*view (see viewProjection)
 * @param {{x0,y0,x1,y1}} a.rect            normalised, CSS px, canvas space
 * @param {number} a.width                  canvas CSS width
 * @param {number} a.height                 canvas CSS height
 * @returns {{indices: Uint32Array, partial: Uint32Array, ndc: number[],
 *            bounds: {min:number[], max:number[]}|null}}
 *   indices are segment indices in slot (= file) order, so already ascending.
 *   `partial`: moves that cross the rectangle but are not taken (same filters) --
 *   the viewer highlights only their part inside it, so the view matches the
 *   rectangle. Always empty for 'touch'. `ndc`: the rectangle as [x0,y0,x1,y1] in NDC.
 */
export function selectInRect(a) {
  const { seg, segOf, features, viewProj: m, rect, width, height } = a;
  const match = a.match || 'inside';
  const s0 = Math.max(0, a.slotStart | 0);
  const s1 = Math.min(segOf.length, a.slotEnd | 0);
  const none = new Uint32Array(0);
  if (s1 <= s0 || !(width > 0) || !(height > 0)) return { indices: none, partial: none, ndc: [0, 0, 0, 0], bounds: null };

  // Feature lookup as a byte table; a Set.has() per segment is ~5x slower.
  const fOk = new Uint8Array(256).fill(1);
  if (features) {
    fOk.fill(0);
    for (const f of features) if (f >= 0 && f < 256) fOk[f] = 1;
  }
  if (a.exclude) for (const f of a.exclude) if (f >= 0 && f < 256) fOk[f] = 0;

  // Rectangle in NDC. Screen y grows downwards, NDC y upwards.
  const nx0 = (rect.x0 / width) * 2 - 1, nx1 = (rect.x1 / width) * 2 - 1;
  const ny0 = 1 - (rect.y1 / height) * 2, ny1 = 1 - (rect.y0 / height) * 2;

  const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3];
  const m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7];
  const m8 = m[8], m9 = m[9], m10 = m[10], m11 = m[11];
  const m12 = m[12], m13 = m[13], m14 = m[14], m15 = m[15];

  // Projected point, written by proj(): NDC x, y and a validity flag
  // (in front of the camera and between near and far).
  let px = 0, py = 0, pok = false;
  const proj = (x, y, z) => {
    const cw = m3 * x + m7 * y + m11 * z + m15;
    if (!(cw > 0)) { pok = false; return; }
    const cz = m2 * x + m6 * y + m10 * z + m14;
    if (cz < -cw || cz > cw) { pok = false; return; }
    px = (m0 * x + m4 * y + m8 * z + m12) / cw;
    py = (m1 * x + m5 * y + m9 * z + m13) / cw;
    pok = true;
  };
  const inRect = (x, y) => x >= nx0 && x <= nx1 && y >= ny0 && y <= ny1;

  /** Does the 2D segment (ax,ay)-(bx,by) touch the rectangle? Liang-Barsky. */
  const crosses = (ax, ay, bx, by) => {
    let t0 = 0, t1 = 1;
    const dx = bx - ax, dy = by - ay;
    const clip = (p, q) => {
      if (p === 0) return q >= 0;
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else { if (r < t0) return false; if (r < t1) t1 = r; }
      return true;
    };
    return clip(-dx, ax - nx0) && clip(dx, nx1 - ax) && clip(-dy, ay - ny0) && clip(dy, ny1 - ay);
  };

  const X0 = seg.x0, Y0 = seg.y0, Z0 = seg.z0, X1 = seg.x1, Y1 = seg.y1, Z1 = seg.z1;
  const F = seg.feature;
  const out = new Uint32Array(s1 - s0);
  const part = match === 'touch' ? null : new Uint32Array(s1 - s0);
  let n = 0, np = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let k = s0; k < s1; k++) {
    const i = segOf[k];
    if (fOk[F[i]] === 0) continue;
    const ax = X0[i], ay = Y0[i], az = Z0[i], bx = X1[i], by = Y1[i], bz = Z1[i];

    // 'center' decides on the midpoint alone (as it always has); the ends are
    // projected only to decide 'inside' / 'touch' and the partial list. An end
    // behind the camera or past near/far means "not inside, not crossing".
    let take = false;
    if (match === 'center') {
      proj((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
      take = pok && inRect(px, py);
    }
    if (!take) {
      proj(ax, ay, az);
      if (!pok) continue;
      const qx = px, qy = py, qIn = inRect(qx, qy);
      proj(bx, by, bz);
      if (!pok) continue;
      const rIn = inRect(px, py);
      if (match === 'inside' && qIn && rIn) take = true;
      else if (qIn || rIn || crosses(qx, qy, px, py)) {
        if (match === 'touch') take = true;
        else part[np++] = i;
      }
      if (!take) continue;
    }
    out[n++] = i;
    if (ax < minX) minX = ax; if (ax > maxX) maxX = ax;
    if (bx < minX) minX = bx; if (bx > maxX) maxX = bx;
    if (ay < minY) minY = ay; if (ay > maxY) maxY = ay;
    if (by < minY) minY = by; if (by > maxY) maxY = by;
    if (az < minZ) minZ = az; if (az > maxZ) maxZ = az;
    if (bz < minZ) minZ = bz; if (bz > maxZ) maxZ = bz;
  }

  return {
    indices: out.slice(0, n),
    partial: part ? part.slice(0, np) : none,
    ndc: [nx0, ny0, nx1, ny1],
    bounds: n ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } : null,
  };
}
