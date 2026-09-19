/**
 * viewer.js -- the public face of the renderer.
 *
 *   import { createViewer } from './render/viewer.js';
 *   const viewer = createViewer(canvasEl);
 *   viewer.setData(parseGcode(text));
 *
 * Design in one paragraph: geometry is built exactly once per file, into one
 * merged mesh for extrusions plus one LineSegments for travels and one Points
 * for retract/prime markers. After that nothing is ever rebuilt. The layer
 * slider moves `drawRange`; the view mode rewrites a Uint8 colour attribute;
 * feature toggles and selection flip bits in a Uint8 flags attribute that the
 * vertex shader uses to clip or recolour. Picking re-renders a handful of
 * pixels with an ID shader. See docs/CONTEXT-render.md.
 */

import * as THREE from 'three';
import { KIND, FEATURE_NAMES } from '../parser/parse.js';
import {
  SELECT_COLOR, TRAVEL_COLOR, VIEW_MODES, hexToRgb,
  DIFF_ADDED, DIFF_REMOVED, DIFF_SAME, GHOST_COLOR, GHOST_OPACITY,
} from './colors.js';
import {
  countLayers, autoQuality,
  buildExtrudeArrays, buildTravelArrays, buildMarkerArrays,
  makeExtrudeGeometry, makeTravelGeometry, makeMarkerGeometry,
  computeValueRanges, fillExtrudeColors, fillSolidColor,
  layerZTable, zSpanOfLayers, layerRangeByZ,
} from './geometry.js';
import { createControls } from './controls.js';
import { createPicker, createPickMaterial } from './picking.js';
import { createBed } from './bed.js';
import { selectInRect, viewProjection, normRect } from './area.js';

// Colour management off, output colour space linear: every hex in colors.js
// then reaches the screen as exactly that hex, modulated only by our own
// lighting term. The colours ARE the data here; a hidden sRGB conversion would
// mean the legend swatch and the ribbon no longer match.
THREE.ColorManagement.enabled = false;

const FLAG_HIDDEN = 1;
const FLAG_SELECTED = 2;
// Crossing move of an area select: highlighted only inside the area (uClipVP / uClipRect).
const FLAG_PARTIAL = 4;

const COMPARE_MODES = ['both', 'changes', 'old', 'new'];
const rgbBytes = (hex) => hexToRgb(hex).map((v) => Math.round(v * 255));
const RGB_ADDED = rgbBytes(DIFF_ADDED);
const RGB_REMOVED = rgbBytes(DIFF_REMOVED);
const RGB_SAME = rgbBytes(DIFF_SAME);
const RGB_GHOST = rgbBytes(GHOST_COLOR);
const RGB_DIM = [58, 64, 74];   // everything Claude is not pointing at

/** Which object owns a given source segment. */
const OWNER_NONE = 255, OWNER_EXTRUDE = 0, OWNER_TRAVEL = 1, OWNER_MARKER = 2;

/** Features that belong to the start/end G-code rather than to the object. */
const AUX_UNKNOWN = FEATURE_NAMES.indexOf('Unknown');
const AUX_CUSTOM = FEATURE_NAMES.indexOf('Custom');

const DEFAULTS = {
  background: 0x0e1116,
  showBed: true,
  showTravel: false,
  showRetractions: false,
  viewMode: 'feature',
  maxPixelRatio: 2,
  antialias: true,
  bedShape: null,
  boxSelectStroke: '#00e5ff',
  /** Rubber-band colour for area select (through-the-model). */
  areaSelectStroke: '#ffb020',
  /** 'auto' | 'high' | 'fast' | 'flat' -- see PROFILES in geometry.js. */
  quality: 'auto',
  /**
   * Drop the device pixel ratio when frames start missing vsync and raise it
   * again when they stop. On integrated graphics this is the single biggest
   * lever there is: DPR 2 with 4x MSAA is 16x the fragment work of DPR 1.
   */
  adaptiveResolution: true,
  /** How often a hover pick may run, ms. Once per frame is far too often. */
  hoverInterval: 45,
  /**
   * The pointer must rest this long before a hover pick runs. A pick is a
   * second full vertex pass, so throttling alone still costs ~20 extra passes a
   * second during a sweep; waiting for rest makes a sweep cost nothing and
   * answers as soon as the cursor settles on something.
   */
  hoverRest: 70,
  /**
   * Read the hover pick back synchronously. Slower (it stalls the GPU
   * pipeline) but answers within the same frame. Only worth setting if the
   * asynchronous PBO path misbehaves somewhere.
   */
  hoverSync: false,
  /** Show the built-in FPS/triangle overlay. Off by default; the UI owns chrome. */
  stats: false,
};

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Partial<typeof DEFAULTS>} [options]
 */
export function createViewer(canvas, options = {}) {
  const opt = { ...DEFAULTS, ...options };

  /* ------------------------------------------------------------ three */

  // THREE throws a bare "Error creating WebGL context." when there is no GPU,
  // when the context limit is hit, or when hardware acceleration is off. Turn
  // that into something the UI can show a person, with a code it can branch on.
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: opt.antialias,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
  } catch (err) {
    const e = new Error(
      'Could not start WebGL. The 3D view needs hardware acceleration: check that it is ' +
      'enabled in the browser, and that the graphics driver is up to date. (' +
      (err && err.message ? err.message : String(err)) + ')',
    );
    e.code = 'NO_WEBGL';
    e.cause = err;
    throw e;
  }
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(opt.background, 1);
  renderer.setPixelRatio(Math.min(opt.maxPixelRatio, globalThis.devicePixelRatio || 1));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 1, 5000);
  camera.up.set(0, 0, 1);

  const controls = createControls(camera, canvas, { onChange: () => { dirty = true; } });

  const modelRoot = new THREE.Group();
  modelRoot.name = 'model';
  scene.add(modelRoot);

  let bedGroup = null;
  const picker = createPicker(renderer, scene, camera);

  /* ------------------------------------------------------- materials */

  const uSelect = { value: new THREE.Color().setHex(colorNum(SELECT_COLOR)) };
  const uPixelRatio = { value: renderer.getPixelRatio() };

  // Uniform objects are shared (by reference) with the compare ghost material,
  // so a lighting tweak here reaches both.
  const ribbonUniforms = {
    uSelect,
    uL1: { value: new THREE.Vector3(0.36, -0.62, 0.70).normalize() },
    uL2: { value: new THREE.Vector3(-0.62, 0.34, 0.45).normalize() },
    uAmbient: { value: 0.30 },
    uHemi: { value: 0.22 },
    uKey: { value: 0.46 },
    uFill: { value: 0.18 },
    uSpec: { value: 0.10 },
    // -1 while the camera is below the plate: lights mirror in Z, so the
    // underside is lit like the top instead of by ambient alone
    uUp: { value: 1.0 },
    // The last area select as a fixed region on the model: the camera's
    // proj*view at selection time and the rectangle in its NDC. Moves flagged
    // PARTIAL are highlighted only where they lie inside it.
    uClipVP: { value: new THREE.Matrix4() },
    uClipRect: { value: new THREE.Vector4(0, 0, 0, 0) },
  };
  const ribbonMat = new THREE.ShaderMaterial({
    uniforms: { ...ribbonUniforms, uOpacity: { value: 1.0 } },
    vertexShader: RIBBON_VERT,
    fragmentShader: RIBBON_FRAG,
    side: THREE.FrontSide,
    toneMapped: false,
  });

  /**
   * The compare ghost: same shader, alpha = GHOST_OPACITY, blended, no depth
   * write. The polygon offset pushes its depth slightly back, so where the old
   * move coincides with a new one the opaque current ribbon wins the depth test
   * and the ghost only shows where the current file has nothing.
   */
  const ghostMat = new THREE.ShaderMaterial({
    uniforms: { ...ribbonUniforms, uOpacity: { value: GHOST_OPACITY } },
    vertexShader: RIBBON_VERT,
    fragmentShader: RIBBON_FRAG,
    side: THREE.FrontSide,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2,
    toneMapped: false,
  });

  /**
   * 'changes' mode: the removed (old) moves, faint and see-through, so the
   * new walls in the same place -- screw holes, moved dividers -- read clearly
   * in front of them instead of fighting a solid red copy.
   */
  const removedMat = ghostMat.clone();
  removedMat.uniforms = { ...ribbonUniforms, uOpacity: { value: 0.55 } };   // 0.3 was too faint to find the old holes (user)
  // 50 stacked layers of 30 % red add up to solid red. So a depth-only pass
  // (removedDepthMat, same geometry, drawn first) lays down the frontmost old
  // surface, and the red is then blended once, only where it is frontmost.
  // `transparent` only to keep it in the transparent queue, in renderOrder with
  // the passes around it (three draws every opaque object first)
  const removedDepthMat = new THREE.ShaderMaterial({
    vertexShader: RIBBON_VERT,
    fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }',
    transparent: true,
    colorWrite: false,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2,
  });

  /**
   * Diff look (2026-09-17, user: "we need diff settings ... like opacity for the
   * old and new"). With the new file below 100 % it is drawn AFTER the old one,
   * see-through, on a fresh depth buffer: a depth-only pass lays down its
   * frontmost surface, then that surface is blended once. The old file (its own
   * pre-pass, drawn first) therefore shows through it -- a thinner floor or a
   * wall inside the old one becomes visible.
   */
  const fadeMat = new THREE.ShaderMaterial({
    uniforms: { ...ribbonUniforms, uOpacity: { value: 1.0 } },
    vertexShader: RIBBON_VERT,
    fragmentShader: RIBBON_FRAG,
    side: THREE.FrontSide,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const fadeDepthMat = new THREE.ShaderMaterial({
    vertexShader: RIBBON_VERT,
    fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }',
    transparent: true,
    colorWrite: false,
    depthWrite: true,
  });

  const travelMat = new THREE.ShaderMaterial({
    uniforms: {
      uSelect,
      uColor: { value: new THREE.Color().setHex(colorNum(TRAVEL_COLOR)) },
      uOpacity: { value: 0.30 },
    },
    vertexShader: FLAT_VERT,
    fragmentShader: FLAT_FRAG,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });

  const markerMat = new THREE.ShaderMaterial({
    uniforms: {
      uSelect,
      uPointSize: { value: 7 },
      uPointScale: { value: 260 },
      uPixelRatio,
    },
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });

  const ribbonPick = createPickMaterial();
  const travelPick = createPickMaterial({ depthWrite: false });
  const markerPick = createPickMaterial({ points: true, pointSize: 9, depthWrite: false });
  markerPick.uniforms.uPixelRatio = uPixelRatio;

  /* ------------------------------------------------------------ state */

  let data = null;            // the parse result
  let built = null;           // { extrude, travel, marker } array bundles
  let meshes = { extrude: null, travel: null, marker: null };
  let layerCount = 0;
  let layerLo = 0, layerHi = 0;
  let viewMode = opt.viewMode;
  let ranges = null;
  let visibleFeatures = null; // null = all visible
  let selection = new Uint32Array(0);
  let selMask = null;         // Uint8Array(count)
  let partial = new Uint32Array(0);  // crossing moves of the last area select
  let partMask = null;        // Uint8Array(count)
  let selClip = null;         // {viewProj, ndc} of that area select, or null
  let ownerOf = null;         // Uint8Array(count)
  let slotOf = null;          // Int32Array(count)
  let showTravel = opt.showTravel;
  let showRetractions = opt.showRetractions;
  let boxSelectMode = false;
  let areaSelectMode = false;
  /** Normalised rect of the last completed box/area drag, CSS px. */
  let lastRect = null;
  let dirty = true;
  let disposed = false;
  let quality = opt.quality;
  let vertsPerSeg = 12;

  // Compare layer. `cmp` is null when compare is off -- then nothing below
  // costs anything. The group is hidden from the pick pass as a whole.
  const compareRoot = new THREE.Group();
  compareRoot.name = 'compare';
  modelRoot.add(compareRoot);
  picker.hideDuringPick(compareRoot);

  // Pointers: labelled boxes Claude draws to show "this is the area I mean".
  // Bed coordinates, same space as the toolpath; never pickable.
  const pointRoot = new THREE.Group();
  pointRoot.name = 'pointers';
  modelRoot.add(pointRoot);
  picker.hideDuringPick(pointRoot);
  /** @type {null|{parse:any, curClass:Uint8Array, oldClass:Uint8Array, ex:any, mesh:THREE.Mesh, zs:Float64Array, layerCount:number}} */
  let cmp = null;
  let compareMode = 'both';
  // opacity of the old / new file and whether the new file's unchanged moves
  // are hidden, per compare mode ('both' = Overlay, 'changes')
  const LOOK_DEFAULT = {
    both: { oldOpacity: GHOST_OPACITY, newOpacity: 1, hideSame: false },
    changes: { oldOpacity: 0.55, newOpacity: 1, hideSame: false },
  };
  const look = { both: { ...LOOK_DEFAULT.both }, changes: { ...LOOK_DEFAULT.changes } };
  let curLayerZ = null;       // lazily built Z table of the current file

  const listeners = { pick: [], hover: [], box: [], area: [] };
  let lastHover = null;
  let hoverPending = null;    // [x,y] in CSS pixels
  let lastHoverAt = 0;
  let lastPointerMoveAt = 0;

  /* ------------------------------------------------------------- size */

  let cssW = 1, cssH = 1;
  function resize() {
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width || canvas.clientWidth || 1));
    const h = Math.max(1, Math.round(r.height || canvas.clientHeight || 1));
    if (w === cssW && h === cssH) return;
    cssW = w; cssH = h;
    const pr = Math.min(opt.maxPixelRatio, globalThis.devicePixelRatio || 1);
    renderer.setPixelRatio(pr);
    uPixelRatio.value = pr;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dirty = true;
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(canvas);
  globalThis.addEventListener?.('resize', resize);
  resize();

  /* -------------------------------------------------------- box select */

  const boxEl = document.createElement('div');
  boxEl.style.cssText = 'position:absolute;pointer-events:none;display:none;z-index:20;';
  /** Colour the rubber band for the drag kind about to start. */
  function styleBox(kind) {
    const c = kind === 'area' ? opt.areaSelectStroke : opt.boxSelectStroke;
    boxEl.style.border = '1px ' + (kind === 'area' ? 'dashed ' : 'solid ') + c;
    // Translucent fill via 8-digit hex when the stroke is #rrggbb.
    boxEl.style.background = /^#[0-9a-f]{6}$/i.test(c) ? c + '1f' : 'transparent';
  }
  styleBox('box');
  let boxHost = canvas.parentElement;
  if (boxHost) {
    const pos = getComputedStyle(boxHost).position;
    if (pos === 'static') boxHost.style.position = 'relative';
    boxHost.appendChild(boxEl);
  } else {
    boxHost = null;
  }
  /** One rubber-band machine for both modes; `kind` says which result fires. */
  const boxDrag = { active: false, kind: 'box', id: -1, x0: 0, y0: 0, x1: 0, y1: 0 };

  /* ----------------------------------------------------------- input */

  const down = { x: 0, y: 0, t: 0, button: -1, moved: false };

  function localXY(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function onDown(e) {
    const [x, y] = localXY(e);
    down.x = x; down.y = y; down.t = performance.now();
    down.button = e.button; down.moved = false;
    hoverPending = null;             // a drag is starting; the queued hover is stale
    if ((boxSelectMode || areaSelectMode) && e.button === 0 && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      boxDrag.active = true;
      boxDrag.kind = areaSelectMode ? 'area' : 'box';
      styleBox(boxDrag.kind);
      boxDrag.id = e.pointerId;
      boxDrag.x0 = boxDrag.x1 = x;
      boxDrag.y0 = boxDrag.y1 = y;
      drawBox();
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      e.preventDefault();
    }
  }

  function onMove(e) {
    const [x, y] = localXY(e);
    if (Math.abs(x - down.x) > 3 || Math.abs(y - down.y) > 3) down.moved = true;
    // Same latch hazard as the orbit drag: if the release goes missing the
    // rubber band would follow the bare cursor. No buttons, no drag.
    if (boxDrag.active && e.buttons === 0) { finishBox(x, y, e.pointerId); return; }
    if (boxDrag.active && e.pointerId === boxDrag.id) {
      boxDrag.x1 = x; boxDrag.y1 = y;
      drawBox();
      return;
    }
    // Only queue a hover pick. It is spent in `hover()`, at most every
    // `hoverInterval` ms and never while the camera is moving -- a hover pick
    // is a second full vertex pass over the merged mesh, so doing it once per
    // frame roughly doubles the cost of moving the mouse.
    if (listeners.hover.length && !controls.isDragging()) {
      hoverPending = [x, y];
      lastPointerMoveAt = now();
    }
  }

  /** End a rubber-band drag and fire the result. Safe to call more than once. */
  function finishBox(x, y, pointerId) {
    if (!boxDrag.active) return;
    boxDrag.active = false;
    boxEl.style.display = 'none';
    try {
      const id = pointerId === undefined ? boxDrag.id : pointerId;
      if (canvas.hasPointerCapture?.(id)) canvas.releasePointerCapture(id);
    } catch { /* already gone */ }
    boxDrag.id = -1;
    const w = Math.abs(boxDrag.x1 - boxDrag.x0);
    const h = Math.abs(boxDrag.y1 - boxDrag.y0);
    if (w >= 3 && h >= 3) {
      lastRect = normRect(boxDrag.x0, boxDrag.y0, boxDrag.x1, boxDrag.y1);
      if (boxDrag.kind === 'area') emit('area', areaSelect(lastRect));
      else emit('box', picker.pickRect(boxDrag.x0, boxDrag.y0, boxDrag.x1, boxDrag.y1, cssW, cssH));
    } else {
      emit('pick', pickOne(x, y));
    }
  }

  function onUp(e) {
    const [x, y] = localXY(e);
    if (boxDrag.active) { finishBox(x, y, e.pointerId); return; }
    if (e.button === 0 && !down.moved && performance.now() - down.t < 500) {
      emit('pick', pickOne(x, y));
    }
  }

  function onLeave() {
    hoverPending = null;
    if (lastHover !== null) { lastHover = null; emit('hover', null); }
  }

  // A rubber band still up when the window loses focus would otherwise resume
  // against the bare cursor on return.
  const onWindowBlur = () => { hoverPending = null; finishBox(boxDrag.x1, boxDrag.y1); };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', onLeave);
  globalThis.addEventListener?.('blur', onWindowBlur);

  function drawBox() {
    const x = Math.min(boxDrag.x0, boxDrag.x1);
    const y = Math.min(boxDrag.y0, boxDrag.y1);
    boxEl.style.display = 'block';
    boxEl.style.left = (canvas.offsetLeft + x) + 'px';
    boxEl.style.top = (canvas.offsetTop + y) + 'px';
    boxEl.style.width = Math.abs(boxDrag.x1 - boxDrag.x0) + 'px';
    boxEl.style.height = Math.abs(boxDrag.y1 - boxDrag.y0) + 'px';
  }

  /**
   * Area select: every visible-feature extrusion in the layer range whose
   * midpoint projects into `rect`, occluded or not. CPU only, no GPU pass.
   */
  const vpScratch = new Float64Array(16);
  // What counts as inside (see AREA_MATCH in area.js) and which features are
  // never taken. Set by the UI's area options; skirt, brim and the purge line
  // are left out by default -- they cross every rectangle on the part.
  let areaOpts = { match: 'inside', exclude: null };
  function setAreaOptions(o = {}) {
    areaOpts = {
      match: o.match || areaOpts.match,
      exclude: o.exclude === undefined ? areaOpts.exclude
        : o.exclude ? new Set(o.exclude) : null,
    };
  }
  function areaSelect(rect) {
    const r = { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1, w: rect.w, h: rect.h };
    if (!data || !built) return { indices: new Uint32Array(0), rect: r, bounds: null, total: 0 };
    // controls.update() moves the camera; make both matrices match the screen.
    // No view offset is ever left set outside a pick, so this is the real view.
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    viewProjection(camera.projectionMatrix.elements, camera.matrixWorldInverse.elements, vpScratch);
    const ex = built.extrude;
    const lo = Math.max(0, Math.min(layerLo, layerCount - 1));
    const hi = Math.max(lo, Math.min(layerHi, layerCount - 1));
    const res = selectInRect({
      seg: data.segments,
      segOf: ex.segOf,
      slotStart: ex.layerSlotStart[lo],
      slotEnd: ex.layerSlotEnd[hi],
      features: visibleFeatures,
      exclude: areaOpts.exclude,
      match: areaOpts.match,
      viewProj: vpScratch,
      rect: r,
      width: cssW,
      height: cssH,
    });
    return {
      indices: res.indices, rect: r, bounds: res.bounds, total: res.indices.length,
      // pass both back to setSelection so the view matches the rectangle
      partial: res.partial, clip: { viewProj: Float64Array.from(vpScratch), ndc: res.ndc },
    };
  }

  // A pick renders into an off-screen target only; the default framebuffer is
  // never touched, so there is nothing to redraw and no reason to re-dirty.
  function pickOne(x, y) {
    if (!data) return null;
    return picker.pickAt(x, y, cssW, cssH, 5);
  }

  function emit(name, value) {
    for (const cb of listeners[name]) {
      try { cb(value); } catch (err) { console.error('[viewer] ' + name + ' handler failed', err); }
    }
  }

  /* ------------------------------------------------------------ build */

  function clearModel() {
    clearCompare();
    curLayerZ = null;
    picker.unregisterAll();
    for (const k of Object.keys(meshes)) {
      const m = meshes[k];
      if (m) { modelRoot.remove(m); m.geometry.dispose(); }
      meshes[k] = null;
    }
    built = null;
    data = null;
    ranges = null;
    selection = new Uint32Array(0);
    partial = new Uint32Array(0);
    selClip = null;
    selMask = null; partMask = null; ownerOf = null; slotOf = null;
    layerCount = 0; layerLo = 0; layerHi = 0;
  }

  function setData(parse) {
    clearModel();
    lastRect = null;
    pointed = [];
    setPointers([]);
    if (!parse || !parse.count) { dirty = true; return; }
    data = parse;

    const seg = parse.segments;
    const count = parse.count;
    layerCount = countLayers(seg, count);
    layerLo = 0;
    layerHi = layerCount - 1;

    const t0 = now();
    const ex = buildExtrudeArrays(seg, count, { layerCount, quality });
    const tv = buildTravelArrays(seg, count, { layerCount });
    const mk = buildMarkerArrays(seg, count, { layerCount });
    built = { extrude: ex, travel: tv, marker: mk };
    vertsPerSeg = ex.vertsPerSeg;

    ownerOf = new Uint8Array(count).fill(OWNER_NONE);
    slotOf = new Int32Array(count).fill(-1);
    for (let s = 0; s < ex.segOf.length; s++) { ownerOf[ex.segOf[s]] = OWNER_EXTRUDE; slotOf[ex.segOf[s]] = s; }
    for (let s = 0; s < tv.segOf.length; s++) { ownerOf[tv.segOf[s]] = OWNER_TRAVEL; slotOf[tv.segOf[s]] = s; }
    for (let s = 0; s < mk.segOf.length; s++) { ownerOf[mk.segOf[s]] = OWNER_MARKER; slotOf[mk.segOf[s]] = s; }
    selMask = new Uint8Array(count);
    partMask = new Uint8Array(count);

    const gEx = makeExtrudeGeometry(ex);
    meshes.extrude = new THREE.Mesh(gEx, ribbonMat);
    meshes.extrude.frustumCulled = false;
    meshes.extrude.name = 'extrusions';
    modelRoot.add(meshes.extrude);
    picker.register(meshes.extrude, ribbonPick);

    const gTv = makeTravelGeometry(tv);
    meshes.travel = new THREE.LineSegments(gTv, travelMat);
    meshes.travel.frustumCulled = false;
    meshes.travel.visible = showTravel;
    meshes.travel.name = 'travels';
    meshes.travel.renderOrder = 2;
    modelRoot.add(meshes.travel);
    picker.register(meshes.travel, travelPick);

    const gMk = makeMarkerGeometry(mk);
    meshes.marker = new THREE.Points(gMk, markerMat);
    meshes.marker.frustumCulled = false;
    meshes.marker.visible = showRetractions;
    meshes.marker.name = 'retractions';
    meshes.marker.renderOrder = 3;
    modelRoot.add(meshes.marker);
    picker.register(meshes.marker, markerPick);

    ranges = computeValueRanges(parse);
    applyColors();
    refreshFlags();
    applyDrawRanges();

    ensureBed(parse.meta?.bedShape);
    if (underside) bedGroup?.setUnderside(true);
    updateSceneSphere();
    frameAll(true);
    dirty = true;
    lastBuildMs = now() - t0;
  }

  /**
   * The sphere the camera's near/far planes bracket. It has to enclose
   * everything that is actually drawn, bed included -- clip the bed and the
   * grid vanishes from under the model as you pan.
   */
  function updateSceneSphere() {
    const box = new THREE.Box3();
    if (built) {
      const b = built.extrude.bounds;
      box.set(new THREE.Vector3(b.min[0], b.min[1], b.min[2]),
        new THREE.Vector3(b.max[0], b.max[1], b.max[2]));
    }
    if (cmp) {
      const b = cmp.ex.bounds;
      box.expandByPoint(new THREE.Vector3(b.min[0], b.min[1], b.min[2]));
      box.expandByPoint(new THREE.Vector3(b.max[0], b.max[1], b.max[2]));
    }
    if (bedGroup) {
      const bb = bedGroup.userData.bounds;
      box.expandByPoint(new THREE.Vector3(bb.minX, bb.minY, -1));
      box.expandByPoint(new THREE.Vector3(bb.maxX, bb.maxY, 1));
    }
    if (box.isEmpty()) { controls.sceneSphere = null; return; }
    const s = box.getBoundingSphere(new THREE.Sphere());
    controls.sceneSphere = { center: s.center, radius: s.radius };
  }

  let lastBuildMs = 0;

  function ensureBed(shape) {
    const want = opt.bedShape || shape || null;
    if (bedGroup) {
      scene.remove(bedGroup);
      bedGroup.dispose();
      picker.clearHidden();
      picker.hideDuringPick(compareRoot);
      picker.hideDuringPick(pointRoot);
      bedGroup = null;
    }
    if (!opt.showBed) return;
    bedGroup = createBed(want, opt.bed || {});
    scene.add(bedGroup);
    picker.hideDuringPick(bedGroup);
  }

  /* ---------------------------------------------------------- colours */

  function applyColors() {
    if (!data || !meshes.extrude) return;
    const a = meshes.extrude.geometry.getAttribute('aColor');
    if (cmp && compareMode === 'changes') fillDiffColors(a.array);
    else if (pointersOn) fillSolidColor(a.array, RGB_DIM);   // Claude is pointing: only the boxes are coloured
    else fillExtrudeColors(a.array, data, built.extrude.segOf, viewMode, getValueRange(viewMode), vertsPerSeg);
    paintPointed(a.array);
    a.needsUpdate = true;
    dirty = true;
  }

  /**
   * Moves inside Claude's pointer boxes are painted in the box's own colour,
   * on top of whatever the view mode drew -- so "the area Claude means" never
   * looks like the user's (cyan) selection.
   */
  let pointed = [];   // [{indices: Uint32Array, rgb: [r,g,b]}]
  let pointersOn = false;
  function paintPointed(out) {
    if (!pointed.length || !ownerOf) return;
    for (const p of pointed) {
      const [r, g, b] = p.rgb;
      for (let k = 0; k < p.indices.length; k++) {
        const i = p.indices[k];
        if (ownerOf[i] !== OWNER_EXTRUDE) continue;
        const base = slotOf[i] * vertsPerSeg * 3;
        for (let j = 0; j < vertsPerSeg * 3; j += 3) { out[base + j] = r; out[base + j + 1] = g; out[base + j + 2] = b; }
      }
    }
  }

  /** Current mesh in 'changes' mode: added green, everything else dim grey. */
  function fillDiffColors(out) {
    const segOf = built.extrude.segOf;
    const cls = cmp.curClass;
    const VP = vertsPerSeg;
    let v = 0;
    for (let s = 0; s < segOf.length; s++) {
      const c = cls[segOf[s]] === 1 ? RGB_ADDED : RGB_SAME;
      const r = c[0], g = c[1], b = c[2];
      for (let j = 0; j < VP; j++) { out[v++] = r; out[v++] = g; out[v++] = b; }
    }
  }

  function setViewMode(modeId) {
    if (!VIEW_MODES.some((m) => m.id === modeId)) {
      console.warn('[viewer] unknown view mode "' + modeId + '"');
      return;
    }
    viewMode = modeId;
    applyColors();
    // Only 'old' shows the other file in view-mode colours.
    if (cmp && compareMode === 'old') applyCompareColors();
  }

  function getValueRange(modeId) {
    const id = modeId || viewMode;
    if (!ranges) return { min: 0, max: 1 };
    const r = ranges[id];
    return r ? { ...r } : { min: 0, max: 1 };
  }

  /* ------------------------------------------------------------ flags */

  /** Rewrite every flags byte from `visibleFeatures` + `selMask`. */
  function refreshFlags() {
    if (!data) return;
    const seg = data.segments;

    const ex = built.extrude;
    const fa = meshes.extrude.geometry.getAttribute('aFlags');
    const f = fa.array;
    const hideCurSame = !!(cmp && compareMode === 'changes' && look.changes.hideSame);
    for (let s = 0; s < ex.segOf.length; s++) {
      const i = ex.segOf[s];
      let v = 0;
      if (visibleFeatures && !visibleFeatures.has(seg.feature[i])) v |= FLAG_HIDDEN;
      if (hideCurSame && cmp.curClass[i] !== 1) v |= FLAG_HIDDEN;
      if (selMask[i]) v |= FLAG_SELECTED;
      if (partMask[i]) v |= FLAG_PARTIAL;
      const base = s * vertsPerSeg;
      for (let j = 0; j < vertsPerSeg; j++) f[base + j] = v;
    }
    fa.needsUpdate = true;

    writeSimpleFlags(meshes.travel, built.travel, 2);
    writeSimpleFlags(meshes.marker, built.marker, 1);
    if (cmp) applyCompareFlags();
    dirty = true;
  }

  function writeSimpleFlags(mesh, bundle, stride) {
    const fa = mesh.geometry.getAttribute('aFlags');
    const f = fa.array;
    for (let s = 0; s < bundle.segOf.length; s++) {
      const v = selMask[bundle.segOf[s]] ? FLAG_SELECTED : 0;
      const base = s * stride;
      for (let j = 0; j < stride; j++) f[base + j] = v;
    }
    fa.needsUpdate = true;
  }

  /** Flip one flag bit (SELECTED / PARTIAL) for one segment; used for incremental updates. */
  function setFlagBit(i, bit, on) {
    const owner = ownerOf[i];
    if (owner === OWNER_NONE) return;
    const slot = slotOf[i];
    const mesh = owner === OWNER_EXTRUDE ? meshes.extrude
      : owner === OWNER_TRAVEL ? meshes.travel : meshes.marker;
    const stride = owner === OWNER_EXTRUDE ? vertsPerSeg : owner === OWNER_TRAVEL ? 2 : 1;
    const fa = mesh.geometry.getAttribute('aFlags');
    const f = fa.array;
    const base = slot * stride;
    for (let j = 0; j < stride; j++) {
      f[base + j] = on ? (f[base + j] | bit) : (f[base + j] & ~bit);
    }
    fa.needsUpdate = true;
  }

  /**
   * @param {Uint32Array|number[]} indices  the selected moves
   * @param {{partial?: Uint32Array, clip?: {viewProj: ArrayLike<number>, ndc: number[]}}} [o]
   *   from an area select: crossing moves, highlighted only inside `clip`.
   *   Left out, any previous partial highlight is cleared.
   */
  function setSelection(indices, o = {}) {
    if (!data) return;
    for (let k = 0; k < selection.length; k++) {
      const i = selection[k];
      if (selMask[i]) { selMask[i] = 0; setFlagBit(i, FLAG_SELECTED, false); }
    }
    for (let k = 0; k < partial.length; k++) {
      const i = partial[k];
      if (partMask[i]) { partMask[i] = 0; setFlagBit(i, FLAG_PARTIAL, false); }
    }
    const next = indices instanceof Uint32Array ? indices : Uint32Array.from(indices || []);
    for (let k = 0; k < next.length; k++) {
      const i = next[k];
      if (i < data.count && !selMask[i]) { selMask[i] = 1; setFlagBit(i, FLAG_SELECTED, true); }
    }
    selection = next;

    const clip = next.length && o.clip && o.partial && o.partial.length ? o.clip : null;
    partial = clip ? o.partial : new Uint32Array(0);
    selClip = clip;
    for (let k = 0; k < partial.length; k++) {
      const i = partial[k];
      if (i < data.count && !partMask[i]) { partMask[i] = 1; setFlagBit(i, FLAG_PARTIAL, true); }
    }
    if (clip) {
      ribbonUniforms.uClipVP.value.fromArray(clip.viewProj);
      ribbonUniforms.uClipRect.value.fromArray(clip.ndc);
    }
    dirty = true;
  }

  function clearSelection() { setSelection(new Uint32Array(0)); }

  function setVisibleFeatures(set) {
    if (!set) visibleFeatures = null;
    else if (set instanceof Set) visibleFeatures = set;
    else visibleFeatures = new Set(set);
    if (visibleFeatures && visibleFeatures.size >= FEATURE_NAMES.length) visibleFeatures = null;
    refreshFlags();
  }

  /* ------------------------------------------------------- draw ranges */

  function applyDrawRanges() {
    if (!data) return;
    const lo = Math.max(0, Math.min(layerLo, layerCount - 1));
    const hi = Math.max(lo, Math.min(layerHi, layerCount - 1));

    const ex = built.extrude;
    const s = ex.layerIdxStart[lo];
    meshes.extrude.geometry.setDrawRange(s, ex.layerIdxEnd[hi] - s);

    const tv = built.travel;
    const ts = tv.layerVertStart[lo];
    meshes.travel.geometry.setDrawRange(ts, tv.layerVertEnd[hi] - ts);

    const mk = built.marker;
    const ms = mk.layerVertStart[lo];
    meshes.marker.geometry.setDrawRange(ms, mk.layerVertEnd[hi] - ms);

    if (cmp) applyCompareRange(lo, hi);
    dirty = true;
  }

  function setLayerRange(lo, hi) {
    layerLo = lo | 0;
    layerHi = hi | 0;
    applyDrawRanges();
  }

  function setShowTravel(v) {
    showTravel = !!v;
    if (meshes.travel) meshes.travel.visible = showTravel;
    dirty = true;
  }

  function setShowRetractions(v) {
    showRetractions = !!v;
    if (meshes.marker) meshes.marker.visible = showRetractions;
    dirty = true;
  }

  /** Box and area modes are mutually exclusive; either one takes the left button. */
  function applySelectModes() {
    const on = boxSelectMode || areaSelectMode;
    // Mode switched mid-drag: drop the drag rather than fire the wrong kind.
    if (boxDrag.active && (!on || boxDrag.kind !== (areaSelectMode ? 'area' : 'box'))) {
      boxDrag.active = false;
      boxEl.style.display = 'none';
      try {
        if (canvas.hasPointerCapture?.(boxDrag.id)) canvas.releasePointerCapture(boxDrag.id);
      } catch { /* already gone */ }
      boxDrag.id = -1;
    }
    controls.enableRotate = !on;
    canvas.style.cursor = on ? 'crosshair' : '';
  }

  function setBoxSelectMode(v) {
    boxSelectMode = !!v;
    if (boxSelectMode) areaSelectMode = false;
    applySelectModes();
  }

  function setAreaSelectMode(v) {
    areaSelectMode = !!v;
    if (areaSelectMode) boxSelectMode = false;
    applySelectModes();
  }

  /* ----------------------------------------------------------- compare */

  /**
   * Show another file against the current one. `o = { parse, curClass,
   * oldClass }` from compareToolpaths (see docs/CONTEXT-compare.md), or null to
   * leave compare. The other file's extrusions become a second ribbon mesh,
   * built like setData's (same quality profile), never pickable. Replaced on
   * every call; setData clears it.
   */
  function setCompare(o) {
    clearCompare();
    if (!o || !o.parse || !o.parse.count || !data) {
      // Back to exactly the non-compare look.
      if (data) { meshes.extrude.visible = true; applyColors(); refreshFlags(); }
      updateSceneSphere();
      dirty = true;
      return;
    }
    const t0 = now();
    const op = o.parse;
    const seg = op.segments;
    const lc = countLayers(seg, op.count);
    const ex = buildExtrudeArrays(seg, op.count, { layerCount: lc, quality: built.extrude.quality });
    const mesh = new THREE.Mesh(makeExtrudeGeometry(ex), ghostMat);
    mesh.frustumCulled = false;
    mesh.name = 'compare-extrusions';
    mesh.renderOrder = 2;         // after the current ribbons and the depth pass
    compareRoot.add(mesh);
    const depthPass = new THREE.Mesh(mesh.geometry, removedDepthMat);
    depthPass.frustumCulled = false;
    depthPass.renderOrder = 1;
    depthPass.visible = false;
    compareRoot.add(depthPass);
    // the current file's depth pass for the see-through look; clears the depth
    // buffer first so the old file does not hide the new one
    const curDepth = new THREE.Mesh(meshes.extrude.geometry, fadeDepthMat);
    curDepth.frustumCulled = false;
    curDepth.renderOrder = 3;
    curDepth.visible = false;
    curDepth.onBeforeRender = (r) => r.clearDepth();
    compareRoot.add(curDepth);

    const okCur = o.curClass instanceof Uint8Array && o.curClass.length === data.count;
    const okOld = o.oldClass instanceof Uint8Array && o.oldClass.length === op.count;
    if (!okCur) console.warn('[viewer] setCompare: curClass does not match the current file; no additions shown');
    if (!okOld) console.warn('[viewer] setCompare: oldClass does not match the other file; no removals shown');
    cmp = {
      parse: op,
      curClass: okCur ? o.curClass : new Uint8Array(data.count),
      oldClass: okOld ? o.oldClass : new Uint8Array(op.count),
      ex,
      mesh,
      depthPass,
      curDepth,
      zs: layerZTable(seg, op.count, lc),
      layerCount: lc,
      buildMs: 0,
    };
    if (!curLayerZ) curLayerZ = layerZTable(data.segments, data.count, layerCount);

    applyCompareMode(true);
    applyDrawRanges();
    updateSceneSphere();
    cmp.buildMs = now() - t0;
    dirty = true;
  }

  function clearCompare() {
    if (!cmp) return;
    compareRoot.remove(cmp.mesh);
    compareRoot.remove(cmp.depthPass);
    compareRoot.remove(cmp.curDepth);
    cmp.mesh.geometry.dispose();
    cmp = null;
    if (meshes.extrude) {
      meshes.extrude.material = ribbonMat;
      meshes.extrude.renderOrder = 0;
    }
  }

  function setCompareMode(mode) {
    if (!COMPARE_MODES.includes(mode)) {
      console.warn('[viewer] unknown compare mode "' + mode + '"');
      return;
    }
    const was = compareMode;
    compareMode = mode;
    if (!cmp) return;             // remembered for the next setCompare
    // The current mesh's colours only change when entering or leaving 'changes'.
    applyCompareMode(was === 'changes' || mode === 'changes');
  }

  /** Visibility, material, colours and flags for `compareMode`. */
  function applyCompareMode(recolorCurrent) {
    const m = compareMode;
    meshes.extrude.visible = m !== 'old';
    cmp.mesh.visible = m !== 'new';
    cmp.depthPass.visible = m === 'changes';
    cmp.mesh.material = m === 'both' ? ghostMat : m === 'changes' ? removedMat : ribbonMat;
    applyLook();
    if (recolorCurrent) applyColors();
    applyCompareColors();
    applyCompareFlags();
    refreshFlags();
    dirty = true;
  }

  /** Opacities and the see-through order for the current mode (see fadeMat). */
  function applyLook() {
    const L = look[compareMode];
    const fade = !!(cmp && L && L.newOpacity < 0.999 && meshes.extrude.visible);
    meshes.extrude.material = fade ? fadeMat : ribbonMat;
    meshes.extrude.renderOrder = fade ? 4 : 0;
    fadeMat.uniforms.uOpacity.value = L ? L.newOpacity : 1;
    if (cmp) cmp.curDepth.visible = fade;
    removedMat.uniforms.uOpacity.value = look.changes.oldOpacity;
    ghostMat.uniforms.uOpacity.value = look.both.oldOpacity;
    dirty = true;
  }

  /**
   * @param {'both'|'changes'} mode
   * @param {{oldOpacity?: number, newOpacity?: number, hideSame?: boolean}} o  0..1
   */
  function setCompareLook(mode, o = {}) {
    const L = look[mode];
    if (!L) return;
    const clamp = (v, d) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
    const hideWas = L.hideSame;
    L.oldOpacity = clamp(o.oldOpacity, L.oldOpacity);
    L.newOpacity = clamp(o.newOpacity, L.newOpacity);
    if (typeof o.hideSame === 'boolean') L.hideSame = o.hideSame;
    if (!cmp) return;
    applyLook();
    if (mode === 'changes' && hideWas !== L.hideSame && compareMode === 'changes') refreshFlags();
  }

  const getCompareLook = (mode) => (look[mode] ? { ...look[mode] } : null);

  function applyCompareColors() {
    const a = cmp.mesh.geometry.getAttribute('aColor');
    const out = a.array;
    if (compareMode === 'old') {
      // The current file's value range, so Old and New share one legend.
      fillExtrudeColors(out, cmp.parse, cmp.ex.segOf, viewMode, getValueRange(viewMode), cmp.ex.vertsPerSeg);
    } else if (compareMode === 'changes') {
      fillSolidColor(out, RGB_REMOVED);   // unchanged ones are hidden by flag
    } else {
      fillSolidColor(out, RGB_GHOST);
    }
    a.needsUpdate = true;
    dirty = true;
  }

  /** Feature filter on the other mesh, plus hiding its unchanged moves in 'changes'. */
  function applyCompareFlags() {
    const fa = cmp.mesh.geometry.getAttribute('aFlags');
    const f = fa.array;
    const hideSame = compareMode === 'changes';
    fa.needsUpdate = true;
    dirty = true;
    if (!visibleFeatures && !hideSame) { f.fill(0); return; }
    const segOf = cmp.ex.segOf;
    const feat = cmp.parse.segments.feature;
    const cls = cmp.oldClass;
    const VP = cmp.ex.vertsPerSeg;
    let v = 0;
    for (let s = 0; s < segOf.length; s++) {
      const i = segOf[s];
      const hide = (hideSame && cls[i] !== 2) || (visibleFeatures !== null && !visibleFeatures.has(feat[i]));
      const b = hide ? FLAG_HIDDEN : 0;
      for (let j = 0; j < VP; j++) f[v++] = b;
    }
  }

  /** The other mesh follows the current layer range by Z (lo/hi already clamped). */
  function applyCompareRange(lo, hi) {
    const g = cmp.mesh.geometry;
    const span = zSpanOfLayers(curLayerZ, lo, hi);
    const r = span && layerRangeByZ(cmp.zs, span[0], span[1], 0.001);
    if (!r) { g.setDrawRange(0, 0); return; }
    const s = cmp.ex.layerIdxStart[r[0]];
    g.setDrawRange(s, cmp.ex.layerIdxEnd[r[1]] - s);
  }

  /* ------------------------------------------------------------ camera */

  /**
   * Bounding box of the currently visible extrusions, for framing.
   *
   * 'Unknown' and 'Custom' are excluded. They are the moves the start/end
   * G-code makes -- on this printer that is a single 100 mm purge line at
   * y = 0.5, 130 mm away from the part. Included, it drags the framing box
   * across a third of the bed and the model ends up small and off-centre, in
   * `frameAll()` and in every thumbnail. They are still drawn; they are just
   * not what the camera aims at. If nothing else exists, they are used anyway.
   */
  function visibleBox(includeAux) {
    const box = new THREE.Box3();
    if (!data) {
      if (bedGroup) {
        const b = bedGroup.userData.bounds;
        box.set(new THREE.Vector3(b.minX, b.minY, 0), new THREE.Vector3(b.maxX, b.maxY, 1));
      }
      return box;
    }
    const seg = data.segments;
    const ex = built.extrude;
    const lo = Math.max(0, Math.min(layerLo, layerCount - 1));
    const hi = Math.max(lo, Math.min(layerHi, layerCount - 1));
    const s = ex.layerSlotStart[lo], e = ex.layerSlotEnd[hi];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let k = s; k < e; k++) {
      const i = ex.segOf[k];
      const f = seg.feature[i];
      if (!includeAux && (f === AUX_UNKNOWN || f === AUX_CUSTOM)) continue;
      if (visibleFeatures && !visibleFeatures.has(f)) continue;
      minX = Math.min(minX, seg.x0[i], seg.x1[i]); maxX = Math.max(maxX, seg.x0[i], seg.x1[i]);
      minY = Math.min(minY, seg.y0[i], seg.y1[i]); maxY = Math.max(maxY, seg.y0[i], seg.y1[i]);
      minZ = Math.min(minZ, seg.z0[i], seg.z1[i]); maxZ = Math.max(maxZ, seg.z0[i], seg.z1[i]);
    }
    if (!Number.isFinite(minX)) return includeAux ? box : visibleBox(true);
    box.set(new THREE.Vector3(minX, minY, Math.max(0, minZ - 1)), new THREE.Vector3(maxX, maxY, maxZ));
    return box;
  }

  function frameAll(instant) {
    const box = visibleBox();
    if (box.isEmpty() && bedGroup) {
      const b = bedGroup.userData.bounds;
      box.set(new THREE.Vector3(b.minX, b.minY, 0), new THREE.Vector3(b.maxX, b.maxY, 30));
    }
    controls.frameBox(box, { margin: 1.3, instant: !!instant });
    dirty = true;
  }

  function frameSelection(instant) {
    if (!data || !selection.length) return frameAll(instant);
    const seg = data.segments;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let k = 0; k < selection.length; k++) {
      const i = selection[k];
      if (i >= data.count) continue;
      minX = Math.min(minX, seg.x0[i], seg.x1[i]); maxX = Math.max(maxX, seg.x0[i], seg.x1[i]);
      minY = Math.min(minY, seg.y0[i], seg.y1[i]); maxY = Math.max(maxY, seg.y0[i], seg.y1[i]);
      minZ = Math.min(minZ, seg.z0[i], seg.z1[i]); maxZ = Math.max(maxZ, seg.z0[i], seg.z1[i]);
    }
    if (!Number.isFinite(minX)) return frameAll(instant);
    const pad = 2;
    const box = new THREE.Box3(
      new THREE.Vector3(minX - pad, minY - pad, minZ - pad),
      new THREE.Vector3(maxX + pad, maxY + pad, maxZ + pad),
    );
    controls.frameBox(box, { margin: 1.5, instant: !!instant });
    dirty = true;
  }

  /**
   * Camera below the plate: see-through bed, lights mirrored (see bed.js), and
   * ribbons drawn double-sided -- the `fast` / `flat` profiles big files get
   * have no bottom face, so from below only their inner faces are there to see.
   */
  let underside = false;
  function updateUnderside() {
    const below = camera.position.z < 0;
    if (below === underside) return;
    underside = below;
    ribbonUniforms.uUp.value = below ? -1 : 1;
    if (bedGroup) bedGroup.setUnderside(below);
    for (const m of [ribbonMat, ghostMat, removedMat, removedDepthMat, fadeMat, fadeDepthMat]) {
      m.side = below ? THREE.DoubleSide : THREE.FrontSide;
      m.needsUpdate = true;
    }
  }

  const setTopView = () => { controls.setView('top'); dirty = true; };
  const setBottomView = () => { controls.setView('bottom'); dirty = true; };
  const setFrontView = () => { controls.setView('front'); dirty = true; };
  const setIsoView = () => { controls.setView('iso'); dirty = true; };

  /* --------------------------------------------------------- thumbnail */

  /**
   * Off-screen render of the model alone (no bed, no grid) on a transparent
   * background, returned as a PNG data URL. Rendered through a RenderTarget and
   * a 2D canvas rather than `canvas.toDataURL()`, because the latter needs
   * `preserveDrawingBuffer` which costs performance on every single frame.
   */
  function renderThumbnail(width = 512, height = 512) {
    const w = Math.max(16, width | 0), h = Math.max(16, height | 0);
    const rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      samples: 4,
    });
    rt.texture.colorSpace = THREE.NoColorSpace;

    const cam = new THREE.PerspectiveCamera(38, w / h, 1, 5000);
    cam.up.set(0, 0, 1);
    const box = visibleBox();
    const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const size = box.isEmpty() ? new THREE.Vector3(100, 100, 100) : box.getSize(new THREE.Vector3());
    const r = 0.5 * Math.hypot(size.x, size.y, size.z) || 50;
    const vFov = (cam.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * cam.aspect);
    const dist = Math.max(r / Math.sin(vFov / 2), r / Math.sin(hFov / 2)) * 1.12;
    const th = -Math.PI / 4, ph = Math.PI / 3.2;
    cam.position.set(
      c.x + dist * Math.sin(ph) * Math.cos(th),
      c.y + dist * Math.sin(ph) * Math.sin(th),
      c.z + dist * Math.cos(ph),
    );
    cam.near = Math.max(0.05, dist * 0.004);
    cam.far = dist * 24 + 1200;
    cam.updateProjectionMatrix();
    cam.lookAt(c);

    const bedWas = bedGroup ? bedGroup.visible : false;
    const upWas = ribbonUniforms.uUp.value;
    ribbonUniforms.uUp.value = 1;   // the thumbnail looks from above
    if (bedGroup) bedGroup.visible = false;
    // A thumbnail is of the current file alone, even in 'old' mode.
    const cmpWas = compareRoot.visible;
    const ptrWas = pointRoot.visible;
    pointRoot.visible = false;
    const exWas = meshes.extrude ? meshes.extrude.visible : false;
    compareRoot.visible = false;
    if (meshes.extrude) meshes.extrude.visible = true;
    const savedTarget = renderer.getRenderTarget();
    const savedClear = new THREE.Color();
    renderer.getClearColor(savedClear);
    const savedAlpha = renderer.getClearAlpha();

    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(rt);
    renderer.clear(true, true, false);
    renderer.render(scene, cam);

    const px = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);

    renderer.setRenderTarget(savedTarget);
    renderer.setClearColor(savedClear, savedAlpha);
    if (bedGroup) bedGroup.visible = bedWas;
    ribbonUniforms.uUp.value = upWas;
    compareRoot.visible = cmpWas;
    pointRoot.visible = ptrWas;
    if (meshes.extrude) meshes.extrude.visible = exWas;
    rt.dispose();

    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const ctx = out.getContext('2d');
    const img = ctx.createImageData(w, h);
    // GL reads bottom-up; PNG wants top-down.
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4;
      img.data.set(px.subarray(src, src + w * 4), y * w * 4);
    }
    ctx.putImageData(img, 0, 0);
    dirty = true;
    return out.toDataURL('image/png');
  }

  /* ------------------------------------------------------- capture view */

  /**
   * PNG data URL of the current camera view: same camera, bed, background and
   * selection highlight as on screen. Off-screen RenderTarget + readback, like
   * renderThumbnail, so `preserveDrawingBuffer` stays off.
   *
   * Colour: the screen path writes shader output straight to the canvas
   * (outputColorSpace = LinearSRGB, ColorManagement off, no tone mapping). In
   * three r180 a render target always gets LinearSRGB output, and a
   * NoColorSpace texture is stored as plain RGBA8 (not SRGB8_ALPHA8), so the
   * bytes read back are the bytes the screen shows. No conversion either way.
   * The background is the renderer clear colour (the scene has no
   * `background`), so it is cleared explicitly with `opt.background`.
   * Pick materials are only swapped in inside picker.drawRegion, which restores
   * them before returning, so they cannot be active here.
   */
  function captureView({ maxWidth = 1280, rect = null, label = null } = {}) {
    const scale = Math.min(1, Math.max(16, Number(maxWidth) || 1280) / cssW);
    const w = Math.max(1, Math.round(cssW * scale));
    const h = Math.max(1, Math.round(cssH * scale));
    const rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      samples: opt.antialias ? 4 : 0,
    });
    rt.texture.colorSpace = THREE.NoColorSpace;

    const savedTarget = renderer.getRenderTarget();
    const savedClear = new THREE.Color();
    renderer.getClearColor(savedClear);
    const savedAlpha = renderer.getClearAlpha();
    const savedAutoClear = renderer.autoClear;
    const savedPr = uPixelRatio.value;
    const px = new Uint8Array(w * h * 4);
    try {
      // Point sprites are sized in device pixels; match the capture's scale.
      uPixelRatio.value = w / cssW;
      camera.updateMatrixWorld();
      renderer.setClearColor(opt.background, 1);
      renderer.autoClear = true;
      renderer.setRenderTarget(rt);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    } finally {
      renderer.setRenderTarget(savedTarget);
      renderer.setClearColor(savedClear, savedAlpha);
      renderer.autoClear = savedAutoClear;
      uPixelRatio.value = savedPr;
      rt.dispose();
      dirty = true;
    }

    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const ctx = out.getContext('2d');
    const img = ctx.createImageData(w, h);
    // GL reads bottom-up; PNG wants top-down. Alpha is forced opaque.
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4;
      img.data.set(px.subarray(src, src + w * 4), y * w * 4);
    }
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    ctx.putImageData(img, 0, 0);

    if (rect) {
      const k = w / cssW;
      const x0 = Math.min(rect.x0, rect.x1) * k, x1 = Math.max(rect.x0, rect.x1) * k;
      const y0 = Math.min(rect.y0, rect.y1) * k, y1 = Math.max(rect.y0, rect.y1) * k;
      ctx.save();
      ctx.strokeStyle = '#ffb020';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.restore();
    }
    if (label) {
      const text = String(label);
      ctx.save();
      ctx.font = '13px ui-monospace, Consolas, monospace';
      ctx.textBaseline = 'top';
      const boxW = Math.max(1, Math.min(w - 12, ctx.measureText(text).width + 12));
      ctx.fillStyle = 'rgba(10,14,20,0.78)';
      ctx.fillRect(6, 6, boxW, 22);
      ctx.fillStyle = '#e8eef5';
      ctx.fillText(text, 12, 10, Math.max(1, boxW - 12));
      ctx.restore();
    }
    return out.toDataURL('image/png');
  }

  /* ---------------------------------------------------------- run loop */

  let raf = 0;
  let lastT = now();
  let frames = 0, frameAccum = 0, lastFps = 0;
  let lastFrameMs = 0;          // wall time of the last render call, CPU side
  let renderMsAvg = 0;

  // Adaptive resolution. `busy` counts consecutive rendered frames that missed
  // the 60 Hz budget; `easy` counts consecutive comfortable ones.
  const PR_STEPS = [1, 1.25, 1.5, 2];
  let prIndex = PR_STEPS.length - 1;
  let busy = 0, easy = 0, lastPrChange = 0;

  function tick() {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    const t = now();
    const dt = Math.min(0.1, (t - lastT) / 1000);
    lastT = t;

    const moved = controls.update(dt);
    const rendering = moved || dirty;
    if (rendering) {
      dirty = false;
      updateUnderside();
      const r0 = now();
      renderer.render(scene, camera);
      lastFrameMs = now() - r0;
      renderMsAvg = renderMsAvg ? renderMsAvg * 0.9 + lastFrameMs * 0.1 : lastFrameMs;
      frames++;
      frameAccum += dt;
      if (frameAccum >= 0.5) { lastFps = frames / frameAccum; frames = 0; frameAccum = 0; }
      if (opt.adaptiveResolution) adaptResolution(dt, t);
    } else {
      busy = 0; easy = 0;
    }
    updatePointers(rendering);
    // Hover last, so the pick pass cannot interleave with the visible render.
    // It draws only into an off-screen target, so it never dirties the frame.
    hover(t);
  }

  /**
   * Only ever judged on frames we actually rendered back to back -- a single
   * slow frame after an idle pause says nothing. Hysteresis is wide (22 ms down,
   * 12 ms up) and changes are rate-limited, so it settles instead of pumping.
   */
  function adaptResolution(dt, t) {
    const ms = dt * 1000;
    if (ms > 22) { busy++; easy = 0; } else if (ms < 12) { easy++; busy = 0; }
    if (t - lastPrChange < 1200) return;
    let next = prIndex;
    if (busy >= 20 && prIndex > 0) next = prIndex - 1;
    else if (easy >= 90 && prIndex < PR_STEPS.length - 1) next = prIndex + 1;
    if (next === prIndex) return;
    prIndex = next;
    busy = 0; easy = 0; lastPrChange = t;
    const pr = Math.min(PR_STEPS[prIndex], opt.maxPixelRatio, globalThis.devicePixelRatio || 1);
    renderer.setPixelRatio(pr);
    uPixelRatio.value = pr;
    renderer.setSize(cssW, cssH, false);
    dirty = true;
  }

  function hover(t) {
    if (!hoverPending || !listeners.hover.length) return;
    // Nobody inspects a segment mid-orbit, and a pick during a drag is the
    // most expensive moment to spend a second geometry pass.
    if (controls.isDragging() || boxDrag.active) { hoverPending = null; return; }
    // Still moving: keep the request and wait for the cursor to settle.
    if (t - lastPointerMoveAt < opt.hoverRest) return;
    if (t - lastHoverAt < opt.hoverInterval) return;
    lastHoverAt = t;
    const [x, y] = hoverPending;
    hoverPending = null;
    if (!data) {
      if (lastHover !== null) { lastHover = null; emit('hover', null); }
      return;
    }
    if (opt.hoverSync) {
      const id = picker.pickAt(x, y, cssW, cssH, 3);
      if (id !== lastHover) { lastHover = id; emit('hover', id); }
      return;
    }
    // Asynchronous: the answer lands a frame or two later, off the critical
    // path. `undefined` means the request was dropped (one already in flight)
    // or the async path is unavailable -- either way, say nothing.
    Promise.resolve(picker.pickAtAsync(x, y, cssW, cssH, 3)).then((id) => {
      if (disposed || id === undefined) return;
      if (id !== lastHover) { lastHover = id; emit('hover', id); }
    });
  }

  raf = requestAnimationFrame(tick);

  /* ------------------------------------------------------------- stats */

  /**
   * Live counters. `fps` is frames *rendered* per second -- this is an
   * on-demand renderer, so a still scene legitimately reports 0. `renderMs` is
   * the CPU time inside `renderer.render`; on a GPU-bound frame that is only
   * the submit cost, so watch `frameMs` (the real wall time between rendered
   * frames) for the honest number.
   */
  function getStats() {
    const info = renderer.info.render;
    return {
      segments: data ? data.count : 0,
      layers: layerCount,
      quality: built ? built.extrude.quality : quality,
      vertsPerSeg,
      vertices: built ? built.extrude.vertexCount : 0,
      triangles: built ? Math.round(built.extrude.indexCount / 3) : 0,
      travelVertices: built ? built.travel.vertexCount : 0,
      markers: built ? built.marker.slotCount : 0,
      buildMs: Math.round(lastBuildMs),
      fps: Math.round(lastFps),
      renderMs: +renderMsAvg.toFixed(2),
      frameMs: lastFps ? +(1000 / lastFps).toFixed(1) : 0,
      drawCalls: info.calls,
      drawnTriangles: info.triangles,
      pixelRatio: renderer.getPixelRatio(),
      layerRange: [layerLo, layerHi],
      compare: cmp ? {
        mode: compareMode,
        segments: cmp.parse.count,
        vertices: cmp.ex.vertexCount,
        triangles: Math.round(cmp.ex.indexCount / 3),
        buildMs: Math.round(cmp.buildMs),
      } : null,
    };
  }

  let statsEl = null;
  let statsTimer = 0;

  function setStatsVisible(on) {
    if (on && !statsEl && boxHost) {
      statsEl = document.createElement('div');
      statsEl.style.cssText =
        'position:absolute;left:8px;top:8px;z-index:21;pointer-events:none;' +
        'font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;' +
        'color:#9fe8ff;background:rgba(10,14,20,.72);padding:6px 9px;' +
        'border:1px solid rgba(120,170,200,.25);border-radius:4px;white-space:pre;';
      boxHost.appendChild(statsEl);
      statsTimer = setInterval(() => {
        const s = getStats();
        statsEl.textContent =
          s.fps + ' fps   ' + s.frameMs + ' ms/frame\n' +
          s.drawnTriangles.toLocaleString() + ' tris   ' + s.drawCalls + ' calls\n' +
          s.segments.toLocaleString() + ' moves   ' + s.vertices.toLocaleString() + ' verts\n' +
          'quality ' + s.quality + '   dpr ' + s.pixelRatio + '   build ' + s.buildMs + 'ms';
      }, 250);
    } else if (!on && statsEl) {
      clearInterval(statsTimer);
      statsEl.remove();
      statsEl = null;
    }
  }
  if (opt.stats) setStatsVisible(true);

  /**
   * Rebuild the ribbon mesh at a different quality. This is the one call that
   * does rebuild geometry, so it is not on the hot path -- the layer slider,
   * the view mode and the feature toggles never come through here.
   * @param {'auto'|'high'|'fast'|'flat'} q
   */
  function setQuality(q) {
    if (q === quality) return;
    quality = q;
    if (!data) return;
    const parse = data;
    const keepSel = selection;
    const keepPart = { partial, clip: selClip };
    const keepLo = layerLo, keepHi = layerHi;
    const keepFeat = visibleFeatures;
    const keepCmp = cmp ? { parse: cmp.parse, curClass: cmp.curClass, oldClass: cmp.oldClass } : null;
    const keepCam = {
      theta: controls.goal.theta, phi: controls.goal.phi,
      radius: controls.goal.radius, target: controls.goal.target.clone(),
    };
    setData(parse);
    visibleFeatures = keepFeat;
    layerLo = keepLo; layerHi = keepHi;
    refreshFlags();
    applyDrawRanges();
    setSelection(keepSel, keepPart);
    // Same file, so the classes still match: rebuild the compare mesh too.
    if (keepCmp) setCompare(keepCmp);
    controls.goal.theta = keepCam.theta;
    controls.goal.phi = keepCam.phi;
    controls.goal.radius = keepCam.radius;
    controls.goal.target.copy(keepCam.target);
    dirty = true;
  }

  /* ------------------------------------------------------------ public */

  function on(name, cb) {
    if (typeof cb !== 'function') return () => {};
    listeners[name].push(cb);
    return () => {
      const i = listeners[name].indexOf(cb);
      if (i >= 0) listeners[name].splice(i, 1);
    };
  }

  /**
   * Claude's pointer boxes.
   * @param {Array<{
   *   min:number[], max:number[], color:string, label?:string,
   *   indices?:Uint32Array,              moves painted in `color`
   *   after?:{min:number[], max:number[]} where the box will be after the edit
   * }>} list  [] clears
   *
   * While any box is shown, everything else is drawn dim grey so the marked
   * parts are the only colour on screen. Each box: faint fill, solid outline,
   * a numbered tag. With `after`: a dashed outline at the new place, arrows
   * from each edge that moves, and a copy that slides there on a loop.
   */
  const ptrLabels = [];     // [{el, pos: Vector3}]
  let ptrAnims = [];        // [{mesh, from: Vector3, to: Vector3, sFrom: Vector3, sTo: Vector3}]
  const ptrAnimStart = now();

  function setPointers(list) {
    for (const c of [...pointRoot.children]) {
      pointRoot.remove(c);
      c.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    }
    for (const l of ptrLabels) l.el.remove();
    ptrLabels.length = 0;
    if (disposed && !(list && list.length)) { pointed = []; pointersOn = false; return; }
    ptrAnims = [];

    list = list || [];
    pointersOn = list.length > 0;
    pointed = list.filter((r) => r.indices && r.indices.length)
      .map((r) => ({ indices: r.indices, rgb: rgbBytes(r.color || '#ffffff') }));

    const size = (mn, mx) => new THREE.Vector3(
      Math.max(0.2, mx[0] - mn[0]), Math.max(0.2, mx[1] - mn[1]), Math.max(0.2, mx[2] - mn[2]));
    const centre = (mn, mx) => new THREE.Vector3((mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2);
    const add = (o) => { o.renderOrder = 10; o.frustumCulled = false; pointRoot.add(o); return o; };

    list.forEach((r, k) => {
      const color = new THREE.Color(r.color || '#ffffff');
      const s = size(r.min, r.max), c = centre(r.min, r.max);
      const geo = new THREE.BoxGeometry(s.x, s.y, s.z);

      const fill = add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.07, depthWrite: false,
      })));
      fill.position.copy(c);
      const edges = add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({
        color, transparent: true, opacity: 0.9, depthTest: false,
      })));
      edges.position.copy(c);

      if (r.after) {
        const as = size(r.after.min, r.after.max), ac = centre(r.after.min, r.after.max);
        const ageo = new THREE.BoxGeometry(as.x, as.y, as.z);
        const dashed = add(new THREE.LineSegments(new THREE.EdgesGeometry(ageo), new THREE.LineDashedMaterial({
          color, dashSize: 1.2, gapSize: 0.8, transparent: true, opacity: 0.95, depthTest: false,
        })));
        dashed.computeLineDistances();
        dashed.position.copy(ac);

        // one arrow per moving edge, at the top of the box
        const zTop = Math.max(r.max[2], r.after.max[2]) + 1.5;
        const yMid = c.y, xMid = c.x;
        const arrow = (from, dir, len) => {
          const L = Math.max(len, 3);
          const a = new THREE.ArrowHelper(dir, from, L, color.getHex(), Math.min(2.2, L * 0.45), Math.min(1.6, L * 0.35));
          a.traverse((o) => { if (o.material) { o.material.depthTest = false; o.material.transparent = true; } o.renderOrder = 11; });
          add(a);
        };
        for (const [axis, i] of [['x', 0], ['y', 1]]) {
          for (const edge of ['min', 'max']) {
            const d = r.after[edge][i] - r[edge][i];
            if (Math.abs(d) < 0.01) continue;
            const from = axis === 'x'
              ? new THREE.Vector3(r[edge][0], yMid, zTop)
              : new THREE.Vector3(xMid, r[edge][1], zTop);
            const dir = axis === 'x' ? new THREE.Vector3(Math.sign(d), 0, 0) : new THREE.Vector3(0, Math.sign(d), 0);
            arrow(from, dir, Math.abs(d));
          }
        }

        // the sliding copy
        const ghost = add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.28, depthWrite: false, depthTest: false,
        })));
        ghost.position.copy(c);      // not at the origin: framing measures it
        ghost.scale.copy(s);
        ghost.userData.noFrame = true;
        ptrAnims.push({ mesh: ghost, from: c, to: ac, sFrom: s, sTo: as });
      }

      const el = document.createElement('div');
      el.className = 'ptr-tag';
      el.textContent = String(k + 1);
      el.style.cssText =
        'position:absolute;z-index:21;pointer-events:none;transform:translate(-50%,-100%);' +
        'min-width:18px;height:18px;padding:0 5px;border-radius:9px;display:none;' +
        'font:600 11px/18px ui-monospace,Consolas,monospace;text-align:center;' +
        `background:${r.color || '#fff'};color:#0c0f13;box-shadow:0 1px 4px rgba(0,0,0,.6);`;
      if (r.label) el.title = r.label;
      if (boxHost) boxHost.appendChild(el);
      ptrLabels.push({ el, pos: new THREE.Vector3(c.x, r.max[1], r.max[2] + 0.5) });
    });

    applyColors();
    dirty = true;
  }

  /** Tags follow the camera; the sliding copies loop. Called from tick(). */
  const tagTmp = new THREE.Vector3();
  function updatePointers(rendered) {
    if (ptrAnims.length) {
      const period = 2600;
      const t = ((now() - ptrAnimStart) % period) / period;
      // hold at the start, glide, hold at the end
      const g = t < 0.2 ? 0 : t > 0.8 ? 1 : 0.5 - 0.5 * Math.cos(((t - 0.2) / 0.6) * Math.PI);
      for (const a of ptrAnims) {
        a.mesh.position.lerpVectors(a.from, a.to, g);
        a.mesh.scale.lerpVectors(a.sFrom, a.sTo, g);
      }
      dirty = true;
    }
    if (!rendered || !ptrLabels.length) return;
    // Narrow boxes side by side would stack their tags; lift a tag above any
    // earlier one it would overlap.
    const placed = [];
    for (const l of ptrLabels) {
      tagTmp.copy(l.pos).project(camera);
      const vis = tagTmp.z > -1 && tagTmp.z < 1;
      l.el.style.display = vis ? 'block' : 'none';
      if (!vis) continue;
      const x = (tagTmp.x + 1) / 2 * cssW;
      let y = (1 - tagTmp.y) / 2 * cssH;
      for (let guard = 0; guard < 12; guard++) {
        const hit = placed.find((q) => Math.abs(q.x - x) < 24 && Math.abs(q.y - y) < 20);
        if (!hit) break;
        y = hit.y - 22;
      }
      placed.push({ x, y });
      l.el.style.left = (canvas.offsetLeft + x) + 'px';
      l.el.style.top = (canvas.offsetTop + y) + 'px';
    }
  }

  /**
   * Frame the boxes. Top-down by default -- the plan view is what "where"
   * means -- or a raised side view (see controls VIEWS) for things in a wall.
   */
  function framePointers(instant, view = 'top') {
    if (!pointRoot.children.length) return;
    const box = new THREE.Box3();
    for (const o of pointRoot.children) if (!o.userData.noFrame && o.isMesh) box.expandByObject(o);
    if (box.isEmpty()) return;
    box.expandByScalar(4);
    controls.setView(view, !!instant);
    controls.frameBox(box, { margin: view === 'top' ? 1.15 : 1.35, instant: !!instant });
    dirty = true;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    canvas.removeEventListener('pointerleave', onLeave);
    globalThis.removeEventListener?.('resize', resize);
    ro?.disconnect();
    setStatsVisible(false);
    controls.dispose();
    picker.dispose();
    clearModel();
    if (bedGroup) { scene.remove(bedGroup); bedGroup.dispose(); bedGroup = null; }
    boxEl.remove();
    modelRoot.remove(compareRoot);
    setPointers([]);
    modelRoot.remove(pointRoot);
    for (const m of [ribbonMat, ghostMat, removedMat, removedDepthMat, fadeMat, fadeDepthMat, travelMat, markerMat, ribbonPick, travelPick, markerPick]) m.dispose();
    renderer.dispose();
    globalThis.removeEventListener?.('blur', onWindowBlur);
    lastRect = null;
    listeners.pick.length = listeners.hover.length = listeners.box.length = listeners.area.length = 0;
  }

  const viewer = {
    setData,
    setViewMode,
    setLayerRange,
    setVisibleFeatures,
    setShowTravel,
    setShowRetractions,
    setSelection,
    clearSelection,
    onPick: (cb) => on('pick', cb),
    onHover: (cb) => on('hover', cb),
    onBoxSelect: (cb) => on('box', cb),
    setBoxSelectMode,
    setAreaSelectMode,
    setAreaOptions,
    onAreaSelect: (cb) => on('area', cb),
    getLastRect: () => (lastRect ? { ...lastRect } : null),
    captureView,
    frameAll: () => frameAll(false),
    frameSelection: () => frameSelection(false),
    setTopView,
    setBottomView,
    setFrontView,
    setIsoView,
    renderThumbnail,
    getValueRange,
    setCompare,
    setCompareMode,
    setCompareLook,
    getCompareLook,
    setPointers,
    framePointers,
    dispose,

    getStats,
    setQuality,
    setStatsVisible,
    // --- not in the contract, but the UI and the diagnostics panel want them.
    get stats() { return getStats(); },
    get layerCount() { return layerCount; },
    get viewMode() { return viewMode; },
    get selection() { return selection; },
    get compareMode() { return compareMode; },
    get comparing() { return !!cmp; },
    /** Escape hatches for anything the app needs that the contract does not cover. */
    three: { renderer, scene, camera, controls, modelRoot, get bed() { return bedGroup; } },
    requestRender() { dirty = true; },
    resize,
  };
  return viewer;
}

/* --------------------------------------------------------------- shaders */

/**
 * `aFlags` is one byte per vertex: bit 0 = hidden, bit 1 = selected.
 * Hidden vertices are pushed outside the clip volume rather than discarded in
 * the fragment shader -- clipping happens before rasterisation, so a hidden
 * feature costs nothing but its vertex transform.
 */
const FLAG_DECODE = `
  float hiddenBit = step(0.5, mod(aFlags, 2.0));
  float selBit = step(0.5, mod(floor(aFlags * 0.5), 2.0));
  float partBit = step(0.5, mod(floor(aFlags * 0.25), 2.0));
`;

const RIBBON_VERT = `
attribute vec3 aColor;
attribute float aFlags;
varying vec3 vColor;
varying vec3 vN;
varying vec3 vV;
varying float vSel;
varying float vPart;
varying vec3 vW;
void main() {
${FLAG_DECODE}
  vSel = selBit;
  vPart = partBit;
  vColor = aColor;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vN = mat3(modelMatrix) * normal;
  vV = cameraPosition - wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  if (hiddenBit > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

/**
 * Lighting is deliberately narrow-band: luminance runs about 0.30 to 1.16, so
 * every ribbon stays recognisably its own colour. This is a data view first and
 * a render second -- if two speeds shade into the same pixel value the ramp has
 * failed. One key light, one fill, a hemisphere term for the ground/sky split
 * and a weak specular so the beads read as rounded rather than as flat tape.
 */
const RIBBON_FRAG = `
uniform vec3 uSelect;
uniform vec3 uL1;
uniform vec3 uL2;
uniform float uAmbient;
uniform float uHemi;
uniform float uKey;
uniform float uFill;
uniform float uSpec;
uniform float uUp;
uniform float uOpacity;
uniform mat4 uClipVP;
uniform vec4 uClipRect;
varying vec3 vColor;
varying vec3 vN;
varying vec3 vV;
varying float vSel;
varying float vPart;
varying vec3 vW;
void main() {
  // A crossing move of an area select counts as selected only where this
  // fragment lies inside the selected rectangle, seen from where it was drawn.
  float sel = vSel;
  if (vPart > 0.5) {
    vec4 c = uClipVP * vec4(vW, 1.0);
    if (c.w > 0.0 && c.x >= uClipRect.x * c.w && c.x <= uClipRect.z * c.w
        && c.y >= uClipRect.y * c.w && c.y <= uClipRect.w * c.w) sel = 1.0;
  }
  vec3 n = normalize(vN);
  vec3 v = normalize(vV);
  if (dot(n, v) < 0.0) n = -n;
  n.z *= uUp;
  v.z *= uUp;
  // LOCKED by the user (2026-09-17): the selection cyan is laid over the move's
  // own colour at 50 %. Do not change without asking.
  sel *= 0.5;
  vec3 base = mix(vColor, uSelect, sel);
  float hemi = 0.5 + 0.5 * n.z;
  float lum = uAmbient + uHemi * hemi
            + uKey * max(dot(n, uL1), 0.0)
            + uFill * max(dot(n, uL2), 0.0);
  float spec = pow(max(dot(n, normalize(uL1 + v)), 0.0), 26.0) * uSpec;
  vec3 col = base * lum + vec3(spec);
  col += base * sel * 0.30;
  gl_FragColor = vec4(col, uOpacity);
}
`;

const FLAT_VERT = `
attribute float aFlags;
varying float vSel;
void main() {
${FLAG_DECODE}
  vSel = selBit;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  if (hiddenBit > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const FLAT_FRAG = `
uniform vec3 uColor;
uniform vec3 uSelect;
uniform float uOpacity;
varying float vSel;
void main() {
  gl_FragColor = vec4(mix(uColor, uSelect, vSel), mix(uOpacity, 1.0, vSel));
}
`;

const POINT_VERT = `
attribute vec3 aColor;
attribute float aFlags;
uniform float uPointSize;
uniform float uPointScale;
uniform float uPixelRatio;
varying vec3 vColor;
varying float vSel;
void main() {
${FLAG_DECODE}
  vSel = selBit;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uPointSize * uPixelRatio * (uPointScale / max(-mv.z, 0.001)), 2.0, 40.0);
  if (hiddenBit > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const POINT_FRAG = `
uniform vec3 uSelect;
varying vec3 vColor;
varying float vSel;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float edge = smoothstep(0.25, 0.14, r2);
  vec3 c = mix(vColor, uSelect, vSel);
  gl_FragColor = vec4(c * (0.75 + 0.25 * edge), 0.55 + 0.45 * edge);
}
`;

function colorNum(hex) { return parseInt(hex.slice(1), 16); }
function now() { return (globalThis.performance || Date).now(); }

export { VIEW_MODES, KIND, FEATURE_NAMES, hexToRgb };
