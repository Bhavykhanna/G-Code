/**
 * bed.js -- the print bed: plate, grid, origin, axis indicators.
 *
 * The bed is drawn from `meta.bedShape` (the slicer's own `bed_shape` config
 * key, e.g. `0x0,426x0,426x426,0x426`), never from a constant, so a different
 * machine profile just works. Everything sits at or below Z = 0 and the model
 * is never offset, so "the first layer touches the plate" is true by
 * construction rather than by fudge factor.
 *
 * Grid density is 10 mm minor / 50 mm major because that is what the bed
 * actually is: a 426 mm square, i.e. 42 minor and 8 major divisions. Lines are
 * deliberately dim -- the model is the subject, the bed is the reference.
 */

import * as THREE from 'three';

const DEFAULT = {
  plate: 0x14171c,
  minor: 0x2a3038,
  major: 0x3d4652,
  border: 0x5a6675,
  originX: 0xd0444c,
  originY: 0x49b05a,
  label: '#8d97a5',
  minorStep: 10,
  majorStep: 50,
  labels: true,
  axisLength: 55,
};

/**
 * @param {Array<[number,number]>|null} bedShape polygon, mm
 * @param {object} [opts]
 * @returns {THREE.Group} with a `dispose()` bolted on
 */
export function createBed(bedShape, opts = {}) {
  const o = { ...DEFAULT, ...opts };
  const poly = (bedShape && bedShape.length >= 3 ? bedShape : [[0, 0], [426, 0], [426, 426], [0, 426]])
    .map((p) => [Number(p[0]) || 0, Number(p[1]) || 0]);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }

  const group = new THREE.Group();
  group.name = 'bed';
  group.renderOrder = -10;
  const owned = [];

  /* ---- plate -------------------------------------------------------- */
  // A hair below zero so the first layer never z-fights the plate.
  const plateGeom = new THREE.PlaneGeometry(maxX - minX, maxY - minY);
  plateGeom.translate((minX + maxX) / 2, (minY + maxY) / 2, -0.06);
  const plateMat = new THREE.MeshBasicMaterial({
    color: o.plate, transparent: true, opacity: 0.94, depthWrite: true,
  });
  const plate = new THREE.Mesh(plateGeom, plateMat);
  plate.renderOrder = -10;
  group.add(plate);
  owned.push(plateGeom, plateMat);

  /* ---- grid --------------------------------------------------------- */
  const minorPts = [];
  const majorPts = [];
  const z = -0.04;
  for (let x = ceilTo(minX, o.minorStep); x <= maxX + 1e-6; x += o.minorStep) {
    const dst = isMultiple(x, o.majorStep) ? majorPts : minorPts;
    dst.push(x, minY, z, x, maxY, z);
  }
  for (let y = ceilTo(minY, o.minorStep); y <= maxY + 1e-6; y += o.minorStep) {
    const dst = isMultiple(y, o.majorStep) ? majorPts : minorPts;
    dst.push(minX, y, z, maxX, y, z);
  }
  group.add(lineSet(minorPts, o.minor, 0.5, owned, -9));
  group.add(lineSet(majorPts, o.major, 0.85, owned, -8));

  /* ---- border ------------------------------------------------------- */
  const borderPts = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    borderPts.push(a[0], a[1], -0.02, b[0], b[1], -0.02);
  }
  group.add(lineSet(borderPts, o.border, 1, owned, -7));

  /* ---- origin + axes ------------------------------------------------ */
  const axisPts = [];
  const L = o.axisLength;
  // X axis, red
  axisPts.push(0, 0, 0.02, L, 0, 0.02);
  axisPts.push(L, 0, 0.02, L - 6, 3, 0.02);
  axisPts.push(L, 0, 0.02, L - 6, -3, 0.02);
  group.add(lineSet(axisPts, o.originX, 1, owned, -6));

  const axisPtsY = [];
  axisPtsY.push(0, 0, 0.02, 0, L, 0.02);
  axisPtsY.push(0, L, 0.02, 3, L - 6, 0.02);
  axisPtsY.push(0, L, 0.02, -3, L - 6, 0.02);
  group.add(lineSet(axisPtsY, o.originY, 1, owned, -6));

  // Origin marker: a small ring so (0,0) is unmistakable at any zoom.
  const ringGeom = new THREE.RingGeometry(2.2, 3.2, 28);
  ringGeom.translate(0, 0, 0.02);
  const ringMat = new THREE.MeshBasicMaterial({
    color: o.border, side: THREE.DoubleSide, transparent: true, opacity: 0.9,
  });
  const ring = new THREE.Mesh(ringGeom, ringMat);
  ring.renderOrder = -6;
  group.add(ring);
  owned.push(ringGeom, ringMat);

  /* ---- labels ------------------------------------------------------- */
  if (o.labels) {
    group.add(makeLabel('X', '#e06a72', L + 8, -1, owned, 10));
    group.add(makeLabel('Y', '#63c473', -1, L + 8, owned, 10));
    for (let x = ceilTo(minX, o.majorStep); x <= maxX + 1e-6; x += o.majorStep) {
      if (x === 0) continue;
      group.add(makeLabel(String(Math.round(x)), o.label, x, minY - 7, owned, 6.5));
    }
    for (let y = ceilTo(minY, o.majorStep); y <= maxY + 1e-6; y += o.majorStep) {
      if (y === 0) continue;
      group.add(makeLabel(String(Math.round(y)), o.label, minX - 9, y, owned, 6.5));
    }
  }

  group.userData.bounds = { minX, minY, maxX, maxY };

  /*
   * Seen from below, the bed is not a real plate: the plate and labels go,
   * the lines fade to a faint outline, so the model's underside is visible
   * and the bed's position is still readable.
   */
  const lineMats = owned.filter((r) => r.isLineBasicMaterial);
  const lineOpacity = lineMats.map((m) => m.opacity);
  const lineTransparent = lineMats.map((m) => m.transparent);
  let underside = false;
  group.setUnderside = (on) => {
    on = !!on;
    if (on === underside) return;
    underside = on;
    plate.visible = !on;
    for (const c of group.children) if (c.isSprite) c.visible = !on;
    ring.visible = !on;
    lineMats.forEach((m, i) => {
      m.opacity = on ? lineOpacity[i] * 0.3 : lineOpacity[i];
      m.transparent = on || lineTransparent[i];
      m.needsUpdate = true;
    });
  };

  group.dispose = () => {
    for (const r of owned) r.dispose();
    group.clear();
  };
  return group;
}

function lineSet(points, color, opacity, owned, renderOrder) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  const m = new THREE.LineBasicMaterial({
    color, transparent: opacity < 1, opacity, depthWrite: false,
  });
  const l = new THREE.LineSegments(g, m);
  l.renderOrder = renderOrder;
  owned.push(g, m);
  return l;
}

/**
 * A text label as a world-space sprite. Sprites scale with distance, which is
 * what we want here: the bed numbers should shrink away when you zoom into a
 * single bead instead of covering the model.
 */
function makeLabel(text, color, x, y, owned, size = 13) {
  const px = 64;
  const canvas = document.createElement('canvas');
  canvas.width = px * 2;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = '600 44px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const s = new THREE.Sprite(mat);
  s.position.set(x, y, 0.4);
  s.scale.set(size * 2, size, 1);
  s.renderOrder = -5;
  owned.push(tex, mat);
  return s;
}

function ceilTo(v, step) { return Math.ceil(v / step - 1e-9) * step; }
function isMultiple(v, step) { return Math.abs(v / step - Math.round(v / step)) < 1e-9; }
