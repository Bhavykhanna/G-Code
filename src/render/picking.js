/**
 * picking.js -- GPU picking. No raycasting anywhere.
 *
 * Why: the 17 Pro file is 846k triangles in a single merged buffer. A CPU
 * raycast would need a BVH over that, cost tens of MB to build and still lose
 * to the GPU, which already rasterises the exact same geometry 60 times a
 * second. So we rasterise once more, with each fragment writing its source
 * segment index instead of a colour, and read the pixel back.
 *
 * The trick that makes it cheap enough to run on every mouse move is
 * `camera.setViewOffset`: instead of re-rendering the whole frame into a
 * full-size target, we re-render *only the few pixels under the cursor* into a
 * tiny target. A hover pick is a 3x3 render, not a 1600x900 one.
 *
 * Correctness by construction:
 *   - the pick pass uses the SAME BufferGeometry objects as the visible pass,
 *     so `drawRange` (the layer slider) applies automatically;
 *   - the pick shaders read the SAME `aFlags` attribute, so anything hidden by
 *     a feature toggle is clipped in the pick pass too and cannot be picked;
 *   - objects with `visible === false` (travel, retract markers) are skipped by
 *     the renderer, so they are not pickable while hidden.
 *
 * Encoding: fragment RGB = (segmentIndex + 1) little-endian, so 0 means "the
 * background" and indices up to 16,777,214 fit. Files top out around 10^5.
 */

import * as THREE from 'three';

/** Largest pick-rectangle we will read back, in pixels per side. */
const MAX_RECT = 1400;

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.PerspectiveCamera} camera
 */
export function createPicker(renderer, scene, camera) {
  // One small target for hover/click, grown on demand for box select.
  let rt = makeTarget(8, 8);
  let buf = new Uint8Array(8 * 8 * 4);

  /** Objects whose material must be swapped for the pick pass. */
  const entries = [];
  /** Objects to hide entirely during the pick pass (bed, grid, helpers). */
  const hidden = [];
  // Reused across calls: a pick can run every frame, and this path must not
  // allocate anything the GC then has to sweep mid-drag.
  const hiddenWas = [];
  const savedClear = new THREE.Color();

  const api = {
    /** @param {THREE.Object3D} object @param {THREE.Material} pickMaterial */
    register(object, pickMaterial) { entries.push({ object, pickMaterial, saved: null }); },
    unregisterAll() { entries.length = 0; },
    hideDuringPick(object) { hidden.push(object); },
    clearHidden() { hidden.length = 0; },
    pickAt, pickAtAsync, pickRect, dispose,
  };

  function makeTarget(w, h) {
    const t = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    t.texture.colorSpace = THREE.NoColorSpace;
    return t;
  }

  function ensure(w, h) {
    if (rt.width !== w || rt.height !== h) {
      rt.setSize(w, h);
    }
    const need = w * h * 4;
    if (buf.length < need) buf = new Uint8Array(need);
  }

  /**
   * Draw `w x h` CSS pixels starting at (x, y) from the top-left of the canvas
   * into `rt`, which is `tw x th`. `fullW/fullH` are the canvas size in the
   * same (CSS pixel) units.
   *
   * The readback is deliberately NOT part of this: a synchronous `readPixels`
   * drains the whole GPU pipeline, and paying that stall on every mouse move is
   * what makes a viewer feel sticky even when its frame rate looks fine. Hover
   * reads asynchronously through a pixel buffer object; clicks, which need an
   * answer in the same gesture, read synchronously.
   */
  function drawRegion(x, y, w, h, fullW, fullH, tw, th) {
    ensure(tw, th);

    const savedTarget = renderer.getRenderTarget();
    const savedTone = renderer.toneMapping;
    renderer.getClearColor(savedClear);
    const savedAlpha = renderer.getClearAlpha();
    const savedAutoClear = renderer.autoClear;

    for (const e of entries) {
      e.saved = e.object.material;
      // same faces as on screen (ribbons go double-sided under the bed)
      if (e.saved && e.pickMaterial.side !== e.saved.side) {
        e.pickMaterial.side = e.saved.side;
        e.pickMaterial.needsUpdate = true;
      }
      e.object.material = e.pickMaterial;
    }
    hiddenWas.length = 0;
    for (const o of hidden) { hiddenWas.push(o.visible); o.visible = false; }

    camera.setViewOffset(fullW, fullH, x, y, w, h);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setClearColor(0x000000, 1);
    renderer.autoClear = true;
    renderer.setRenderTarget(rt);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    restore(savedTarget, savedTone, savedAlpha, savedAutoClear);
  }

  function restore(savedTarget, savedTone, savedAlpha, savedAutoClear) {
    renderer.setRenderTarget(savedTarget);
    renderer.toneMapping = savedTone;
    renderer.setClearColor(savedClear, savedAlpha);
    renderer.autoClear = savedAutoClear;
    camera.clearViewOffset();
    for (const e of entries) { e.object.material = e.saved; e.saved = null; }
    hidden.forEach((o, i) => { o.visible = hiddenWas[i]; });
  }

  function decode(src, i) {
    const id = src[i] | (src[i + 1] << 8) | (src[i + 2] << 16);
    return id === 0 ? -1 : id - 1;
  }

  /** Nearest-to-centre hit in an r x r readback. */
  function nearest(src, r) {
    const half = (r - 1) / 2;
    let best = -1, bestD = Infinity;
    for (let py = 0; py < r; py++) {
      for (let px = 0; px < r; px++) {
        const id = decode(src, (py * r + px) * 4);
        if (id < 0) continue;
        const d = (px - half) * (px - half) + (py - half) * (py - half);
        if (d < bestD) { bestD = d; best = id; }
      }
    }
    return best < 0 ? null : best;
  }

  /**
   * Asynchronous pick, for hover. Same render, but the pixels come back through
   * a PBO one or two frames later instead of stalling the pipeline now. A
   * hover highlight arriving 30 ms late is imperceptible; a stall is not.
   *
   * Only one is ever in flight -- a second request while one is pending is
   * dropped, because by the time it resolved the pointer would have moved on.
   *
   * @returns {Promise<number|null>}
   */
  let inFlight = false;
  async function pickAtAsync(x, y, fullW, fullH, r = 3) {
    if (!entries.length || inFlight) return undefined;
    inFlight = true;
    const half = (r - 1) / 2;
    try {
      drawRegion(Math.round(x) - half, Math.round(y) - half, r, r, fullW, fullH, r, r);
      const px = new Uint8Array(r * r * 4);
      await renderer.readRenderTargetPixelsAsync(rt, 0, 0, r, r, px);
      return nearest(px, r);
    } catch {
      return undefined;            // context lost, or no PBO -- caller falls back
    } finally {
      inFlight = false;
    }
  }

  /**
   * Single pick. Renders an `r x r` neighbourhood and returns the hit nearest
   * the centre -- a 1x1 pick misses thin travel lines constantly and feels
   * broken, a 5x5 pick feels like the cursor has a magnet.
   *
   * @param {number} x CSS pixels from the canvas left edge
   * @param {number} y CSS pixels from the canvas top edge
   * @param {number} fullW canvas CSS width
   * @param {number} fullH canvas CSS height
   * @param {number} [r] odd neighbourhood size
   * @returns {number|null} segment index
   */
  function pickAt(x, y, fullW, fullH, r = 5) {
    if (!entries.length) return null;
    const half = (r - 1) / 2;
    drawRegion(Math.round(x) - half, Math.round(y) - half, r, r, fullW, fullH, r, r);
    renderer.readRenderTargetPixels(rt, 0, 0, r, r, buf);
    // readRenderTargetPixels returns bottom-up; the centre is the centre either
    // way, and we only need distance from it.
    return nearest(buf, r);
  }

  /**
   * Rectangle pick. Returns every segment index visible inside the rectangle.
   *
   * LIMITATION, on purpose: this is a visibility test, not a volume test. A
   * segment buried under other extrusions writes no fragment and is not
   * returned. Rotate or narrow the layer range to reach what is underneath.
   * The alternative -- a CPU frustum test over all 92k segments -- would select
   * infill you cannot see and had no way to deselect.
   *
   * @returns {Uint32Array} sorted, unique
   */
  function pickRect(x0, y0, x1, y1, fullW, fullH) {
    if (!entries.length) return new Uint32Array(0);
    const ax = Math.min(x0, x1), ay = Math.min(y0, y1);
    const w = Math.max(1, Math.round(Math.abs(x1 - x0)));
    const h = Math.max(1, Math.round(Math.abs(y1 - y0)));
    // Downsample very large drags rather than read back 20 MB. At the cap a
    // 1 px feature can fall between samples; that is the trade.
    const tw = Math.min(w, MAX_RECT);
    const th = Math.min(h, MAX_RECT);
    drawRegion(Math.round(ax), Math.round(ay), w, h, fullW, fullH, tw, th);
    renderer.readRenderTargetPixels(rt, 0, 0, tw, th, buf);

    const seen = new Set();
    const n = tw * th * 4;
    for (let i = 0; i < n; i += 4) {
      const id = decode(buf, i);
      if (id >= 0) seen.add(id);
    }
    const out = new Uint32Array(seen.size);
    let k = 0;
    for (const v of seen) out[k++] = v;
    out.sort();
    return out;
  }

  function dispose() {
    rt.dispose();
    entries.length = 0;
    hidden.length = 0;
    buf = new Uint8Array(0);
  }

  return api;
}

/* --------------------------------------------------------------- shaders */

/**
 * Shared GLSL: unpack the flags byte and turn `aId` into a byte-exact RGB.
 * Dividing by 255 matters -- the GL unorm8 write is round(v * 255), so k/255
 * round-trips exactly and k/256 would not.
 */
const PICK_VERT_HEAD = `
attribute float aId;
attribute float aFlags;
varying vec3 vId;
void main() {
  float hiddenBit = step(0.5, mod(aFlags, 2.0));
  float pid = aId + 1.0;
  float r = mod(pid, 256.0);
  float g = mod(floor(pid / 256.0), 256.0);
  float b = mod(floor(pid / 65536.0), 256.0);
  vId = vec3(r, g, b) / 255.0;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
`;

const PICK_FRAG = `
varying vec3 vId;
void main() { gl_FragColor = vec4(vId, 1.0); }
`;

/**
 * @param {{points?: boolean, pointSize?: number}} [opts]
 * @returns {THREE.ShaderMaterial}
 */
export function createPickMaterial(opts = {}) {
  const points = !!opts.points;
  const vert = PICK_VERT_HEAD +
    (points
      // Clamped at both ends, exactly like the visible marker material. Without
      // the upper bound a marker near the near plane asks for a point sprite
      // hundreds of thousands of pixels across, which some drivers do not
      // survive -- and it would also make every pick in the frame hit it.
      ? '  gl_PointSize = clamp(uPointSize * uPixelRatio * (uPointScale / max(-mv.z, 0.001)), 2.0, 40.0);\n'
      : '') +
    '  if (hiddenBit > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);\n}\n';

  const m = new THREE.ShaderMaterial({
    uniforms: points
      ? {
        uPointSize: { value: opts.pointSize ?? 7 },
        uPointScale: { value: 260 },
        uPixelRatio: { value: 1 },
      }
      : {},
    vertexShader: (points
      ? 'uniform float uPointSize;\nuniform float uPointScale;\nuniform float uPixelRatio;\n'
      : '') + vert,
    fragmentShader: PICK_FRAG,
    side: THREE.FrontSide,
    depthTest: true,
    // Travels and markers are drawn with depthWrite off in the visible pass, so
    // they appear on top of whatever they cross. The pick pass has to agree, or
    // clicking a travel line you can plainly see would pick the wall behind it.
    depthWrite: opts.depthWrite !== false,
    transparent: false,
    toneMapped: false,
  });
  return m;
}
