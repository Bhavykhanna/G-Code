/**
 * controls.js -- CAD-style orbit / pan / zoom, written here rather than pulled
 * from three/examples for three reasons:
 *
 *   1. Z is up. OrbitControls assumes Y-up and needs a quaternion shim that
 *      makes the pole clamping behave oddly.
 *   2. Zoom-to-cursor. OrbitControls dollies toward the target, which is wrong
 *      for inspecting one corner of a 426 mm bed.
 *   3. The viewer has to be able to take the left button away for box select
 *      without disabling pan, which OrbitControls does not cleanly allow.
 *
 * The camera is always at
 *     target + r * (sin(phi)cos(theta), sin(phi)sin(theta), cos(phi))
 * with phi clamped away from both poles, so there is no gimbal flip -- ever.
 *
 * Every input writes to a *goal*; `update(dt)` eases the live value toward it
 * with a frame-rate independent exponential, so a flick keeps gliding for a
 * few frames instead of stopping dead.
 */

import * as THREE from 'three';

const MIN_PHI = 0.008;                 // ~0.5 degrees off straight down
const MAX_PHI = Math.PI - 0.008;

export function createControls(camera, dom, opts = {}) {
  const state = {
    theta: -Math.PI / 4,
    phi: Math.PI / 3,
    radius: 400,
    target: new THREE.Vector3(),
  };
  const goal = {
    theta: state.theta,
    phi: state.phi,
    radius: state.radius,
    target: state.target.clone(),
  };

  const api = {
    enabled: true,
    enableRotate: true,
    enablePan: true,
    enableZoom: true,
    rotateSpeed: opts.rotateSpeed ?? 1,
    panSpeed: opts.panSpeed ?? 1,
    zoomSpeed: opts.zoomSpeed ?? 1,
    /**
     * Easing rate for anything that is NOT an active drag: wheel zoom, the
     * view buttons, framing. Higher is snappier.
     */
    damping: opts.damping ?? 22,
    /** Wheel zoom on its own -- it wants to feel crisper than a view transition. */
    zoomDamping: opts.zoomDamping ?? 34,
    /**
     * While the button is down the camera tracks the pointer exactly, with no
     * easing at all. Easing a drag is the single thing that makes a 3D view
     * feel laggy: at 14/s only about a fifth of the movement lands in the first
     * frame, so the model visibly trails the cursor the whole way round. Ease
     * the transitions, never the drag.
     */
    instantDrag: opts.instantDrag !== false,
    minRadius: opts.minRadius ?? 0.5,
    maxRadius: opts.maxRadius ?? 6000,
    zoomToCursor: opts.zoomToCursor !== false,
    /**
     * Everything that gets drawn, as a world-space sphere: `{center, radius}`.
     * The viewer sets it after `setData` (model union bed). The near and far
     * planes bracket it, so they stay correct no matter how far you pan.
     */
    sceneSphere: null,
    state, goal,
    update, setView, setTarget, frameBox, dispose,
    isDragging: () => drag.mode !== null,
    onChange: opts.onChange || null,
  };

  /* ------------------------------------------------------------- input */

  const drag = { mode: null, id: -1, x: 0, y: 0 };
  const tmpV = new THREE.Vector3();
  const tmpN = new THREE.Vector3();
  const ray = new THREE.Ray();

  function modeFor(e) {
    // middle, or shift/ctrl + left  -> pan.  plain left -> orbit.
    if (e.button === 1) return api.enablePan ? 'pan' : null;
    if (e.button === 2) return api.enablePan ? 'pan' : null;
    if (e.button === 0) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) return api.enablePan ? 'pan' : null;
      return api.enableRotate ? 'orbit' : null;
    }
    return null;
  }

  function onPointerDown(e) {
    // Swallow middle and right on the canvas whatever we then do with them. On
    // Windows middle-click starts the browser's autoscroll and right-click
    // opens the context menu, and BOTH of those eat the matching pointerup --
    // which is how a drag gets latched on forever.
    if (e.button === 1 || e.button === 2) e.preventDefault();
    if (!api.enabled || drag.mode) return;
    const m = modeFor(e);
    if (!m) return;
    drag.mode = m;
    drag.id = e.pointerId;
    drag.x = e.clientX;
    drag.y = e.clientY;
    try { dom.setPointerCapture(e.pointerId); } catch { /* not captureable */ }
    e.preventDefault();
  }

  function onPointerMove(e) {
    // This check comes FIRST, before the pointerId match, because a mismatched
    // id is exactly the case that would otherwise stay latched forever.
    // The release can go missing: middle-click starts the browser's autoscroll,
    // right-click opens the context menu, and losing focus mid-drag fires
    // nothing at all. Any of those leaves `drag.mode` set and the camera then
    // follows the bare cursor. `buttons === 0` means nothing is held right now,
    // whatever events we did or did not receive -- so the pan really does
    // happen only while the button is down.
    // Restricted to a real mouse on purpose: precision touchpads, pens and
    // touch can legitimately report buttons === 0 during a drag, and killing
    // the drag on that reading stops them panning at all.
    if (drag.mode && e.buttons === 0 && e.pointerType === 'mouse') {
      endDrag(e.pointerId);
      return;
    }
    if (!drag.mode || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    const h = dom.clientHeight || 1;

    if (drag.mode === 'orbit') {
      goal.theta -= (2 * Math.PI * dx / h) * api.rotateSpeed;
      goal.phi -= (2 * Math.PI * dy / h) * api.rotateSpeed;
      goal.phi = Math.min(MAX_PHI, Math.max(MIN_PHI, goal.phi));
    } else {
      // Pan in the camera plane. The scale keeps 1 screen pixel equal to the
      // same world distance regardless of how far out we are.
      const k = (2 * goal.radius * Math.tan((camera.fov * Math.PI) / 360)) / h;
      const right = tmpV.setFromMatrixColumn(camera.matrix, 0);
      goal.target.addScaledVector(right, -dx * k * api.panSpeed);
      const up = tmpN.setFromMatrixColumn(camera.matrix, 1);
      goal.target.addScaledVector(up, dy * k * api.panSpeed);
    }
    e.preventDefault();
  }

  /** Single place a drag ends, so no path can leave it latched. */
  function endDrag(pointerId) {
    if (!drag.mode) return;
    drag.mode = null;
    const id = pointerId === undefined ? drag.id : pointerId;
    drag.id = -1;
    try { dom.releasePointerCapture(id); } catch { /* already gone */ }
  }

  // Any release or cancellation ends the drag, matching id or not. Being
  // over-eager here costs at worst one interrupted gesture; being under-eager
  // costs a camera that will not stop moving.
  function onPointerUp(e) { endDrag(e.pointerId); }

  function onWheel(e) {
    if (!api.enabled || !api.enableZoom) return;
    e.preventDefault();
    // Normalise: some mice report lines, trackpads report pixels.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const d = e.deltaY * unit;
    const k = Math.pow(0.9985, -d * api.zoomSpeed);
    const next = clamp(goal.radius * k, api.minRadius, api.maxRadius);
    const applied = next / goal.radius;

    if (api.zoomToCursor && applied < 1) {
      // Keep whatever is under the cursor under the cursor: find the point on
      // the plane through the target facing the camera and slide the target
      // toward it by exactly the fraction we just dollied in.
      const rect = dom.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      ray.origin.setFromMatrixPosition(camera.matrixWorld);
      ray.direction.set(nx, ny, 0.5).unproject(camera).sub(ray.origin).normalize();
      tmpN.copy(camera.position).sub(goal.target).normalize();
      const denom = ray.direction.dot(tmpN);
      if (Math.abs(denom) > 1e-6) {
        const t = tmpV.copy(goal.target).sub(ray.origin).dot(tmpN) / denom;
        if (t > 0 && t < 1e7) {
          tmpV.copy(ray.direction).multiplyScalar(t).add(ray.origin);
          goal.target.lerp(tmpV, 1 - applied);
        }
      }
    }
    goal.radius = next;
  }

  function onContextMenu(e) { e.preventDefault(); }

  // A drag that is still latched when the window loses focus, or when the tab is
  // hidden, would resume against the bare cursor on return.
  const onLoseFocus = () => endDrag();
  const onVisibility = () => { if (document.hidden) endDrag(); };
  // Middle-click otherwise starts the browser's autoscroll, which eats the
  // release; auxclick covers the case where pointerdown's preventDefault did not.
  const onAuxClick = (e) => { if (e.button === 1) e.preventDefault(); };

  dom.addEventListener('pointerdown', onPointerDown);
  dom.addEventListener('pointermove', onPointerMove);
  dom.addEventListener('pointerup', onPointerUp);
  dom.addEventListener('pointercancel', onPointerUp);
  dom.addEventListener('wheel', onWheel, { passive: false });
  dom.addEventListener('contextmenu', onContextMenu);
  dom.addEventListener('auxclick', onAuxClick);
  window.addEventListener('blur', onLoseFocus);
  document.addEventListener('visibilitychange', onVisibility);

  /* -------------------------------------------------------------- frame */

  const EPS = 1e-4;

  /**
   * Ease toward the goal and write the camera. Returns true when anything
   * actually moved, so the viewer can skip a redraw when the scene is still.
   */
  function update(dt) {
    const step = Math.min(dt, 0.1);
    const dragging = drag.mode !== null && api.instantDrag;
    const f = dragging ? 1 : 1 - Math.exp(-api.damping * step);
    const fz = dragging ? 1 : 1 - Math.exp(-api.zoomDamping * step);
    const dTheta = goal.theta - state.theta;
    const dPhi = goal.phi - state.phi;
    const dRad = goal.radius - state.radius;
    const dTx = goal.target.x - state.target.x;
    const dTy = goal.target.y - state.target.y;
    const dTz = goal.target.z - state.target.z;

    const moving = Math.abs(dTheta) > EPS || Math.abs(dPhi) > EPS ||
      Math.abs(dRad) > state.radius * EPS ||
      Math.abs(dTx) + Math.abs(dTy) + Math.abs(dTz) > state.radius * EPS;

    if (moving) {
      state.theta += dTheta * f;
      state.phi += dPhi * f;
      state.radius += dRad * fz;
      state.target.x += dTx * f;
      state.target.y += dTy * f;
      state.target.z += dTz * f;
    } else {
      state.theta = goal.theta;
      state.phi = goal.phi;
      state.radius = goal.radius;
      state.target.copy(goal.target);
    }
    state.phi = clamp(state.phi, MIN_PHI, MAX_PHI);

    const sp = Math.sin(state.phi);
    camera.position.set(
      state.target.x + state.radius * sp * Math.cos(state.theta),
      state.target.y + state.radius * sp * Math.sin(state.theta),
      state.target.z + state.radius * Math.cos(state.phi),
    );
    camera.up.set(0, 0, 1);
    camera.lookAt(state.target);

    // --- near / far ------------------------------------------------------
    // Derived from the camera's ACTUAL distance to the scene, not from the
    // orbit radius. Panning moves camera and target together and leaves the
    // radius untouched, so radius-derived planes stop matching the moment you
    // pan off-centre: the model drifts toward one end of the depth range and
    // 0.2 mm layers start z-fighting, which looks exactly like the print being
    // sliced open. Bracketing the scene sphere instead keeps the ratio tight --
    // about 8:1 at a normal bed-wide view, against 6700:1 before.
    let near, far;
    const S = api.sceneSphere;
    if (S && S.radius > 0) {
      const d = camera.position.distanceTo(S.center);
      far = (d + S.radius) * 1.05 + 1;
      near = (d - S.radius) * 0.9;          // 0 or less once we are inside it
      if (!(near > 0.05)) near = Math.max(0.05, Math.min(0.5, far * 1e-4));
    } else {
      near = Math.max(0.05, state.radius * 0.004);
      far = state.radius * 24 + 1200;
    }
    if (camera.near !== near || camera.far !== far) {
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    if (moving && api.onChange) api.onChange();
    return moving;
  }

  function setTarget(v, instant) {
    goal.target.copy(v);
    if (instant) state.target.copy(v);
  }

  /**
   * @param {'top'|'bottom'|'front'|'back'|'left'|'right'|'iso'|'hi-right'|'hi-left'|'hi-front'} name
   * @param {boolean} [instant]
   */
  function setView(name, instant) {
    const v = VIEWS[name] || VIEWS.iso;
    goal.theta = nearestAngle(state.theta, v[0]);
    goal.phi = clamp(v[1], MIN_PHI, MAX_PHI);
    if (instant) { state.theta = goal.theta; state.phi = goal.phi; }
  }

  /**
   * Fit a world-space box. `fov` covers the vertical; the horizontal is only
   * as wide as the aspect allows, so both are checked and the looser wins.
   */
  function frameBox(box, opt = {}) {
    if (!box || box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    const margin = opt.margin ?? 1.25;
    const vFov = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    // Radius of the bounding sphere is the safe conservative fit for any orbit
    // angle, which is what we want -- the framing must not break on rotate.
    const r = 0.5 * Math.hypot(s.x, s.y, s.z);
    const dist = Math.max(r / Math.sin(vFov / 2), r / Math.sin(hFov / 2)) * margin;
    goal.target.copy(c);
    goal.radius = clamp(dist, api.minRadius, api.maxRadius);
    if (opt.instant) {
      state.target.copy(goal.target);
      state.radius = goal.radius;
    }
  }

  function dispose() {
    dom.removeEventListener('auxclick', onAuxClick);
    window.removeEventListener('blur', onLoseFocus);
    document.removeEventListener('visibilitychange', onVisibility);
    dom.removeEventListener('pointerdown', onPointerDown);
    dom.removeEventListener('pointermove', onPointerMove);
    dom.removeEventListener('pointerup', onPointerUp);
    dom.removeEventListener('pointercancel', onPointerUp);
    dom.removeEventListener('wheel', onWheel);
    dom.removeEventListener('contextmenu', onContextMenu);
  }

  return api;
}

/** theta (azimuth from +X, CCW), phi (polar from +Z). */
const VIEWS = {
  top: [-Math.PI / 2, MIN_PHI],
  bottom: [-Math.PI / 2, MAX_PHI],
  front: [-Math.PI / 2, Math.PI / 2],
  back: [Math.PI / 2, Math.PI / 2],
  left: [Math.PI, Math.PI / 2],
  right: [0, Math.PI / 2],
  iso: [-Math.PI / 4, Math.PI / 3],
  // raised side views: look at a wall's face over the walls in front of it
  'hi-right': [0, 0.95],
  'hi-left': [Math.PI, 0.95],
  'hi-front': [-Math.PI / 2, 0.95],
};

/** Pick the representation of `to` closest to `from`, so we never spin 350 deg. */
function nearestAngle(from, to) {
  const two = Math.PI * 2;
  let d = (to - from) % two;
  if (d > Math.PI) d -= two;
  if (d < -Math.PI) d += two;
  return from + d;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
