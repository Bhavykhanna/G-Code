/**
 * layerbar.js -- the vertical layer range control.
 *
 * This is the most-used control in a G-code viewer, so it does more than a
 * slider:
 *
 *   - It is a RANGE. `hi` is the top layer being drawn (the one you are
 *     looking at); `lo` is how far down the stack stays visible. Dragging the
 *     filled band between them moves both, which is how you sweep a fixed-depth
 *     window up through a part.
 *   - A per-layer print-time histogram runs alongside the track. Layer time is
 *     the thing you actually want to see: it is where the minutes are, and a
 *     tall bar in the middle of the part is usually a settings problem. Colour
 *     comes from RAMPS.layerTime in colors.js, so it matches the renderer's
 *     own layer-time ramp.
 *   - Layer 0 in ElegooSlicer output is the start-G-code stub: it has no real
 *     Z and no real geometry. It is drawn as a hatched zone at the bottom of
 *     the track, excluded from the histogram scale, and the default range
 *     starts at layer 1 so nobody has to discover this.
 *
 * The histogram is a <canvas>: a 1000-layer file would otherwise be 1000 DOM
 * nodes restyled on every frame of a scrub.
 */

import { sampleRamp, rgbToHex } from '../render/colors.js';
import { formatDuration } from '../parser/parse.js';

const NS = 'http://www.w3.org/2000/svg';

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
  return e;
}

function svg(paths, size = 12) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.5');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  for (const d of [].concat(paths)) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * @param {{onChange?: (lo:number, hi:number)=>void}} opts
 */
export function createLayerBar(opts = {}) {
  /** @type {Array<{index:number,z:number,time:number}>} */
  let layers = [];
  let min = 0, max = 0;
  let lo = 0, hi = 0;
  let firstReal = 0;          // first layer that is not the start-G-code stub
  let maxTime = 1;
  let dragging = null;        // 'lo' | 'hi' | 'band' | null
  let bandOffset = 0;
  let raf = 0;

  /* -- DOM ---------------------------------------------------------------- */
  const headLayer = h('span', { class: 'lb-head__layer mono', text: '--' });
  const headOf = h('span', { class: 'lb-head__of mono', text: '' });
  const headZ = h('div', { class: 'lb-head__z mono', text: '' });
  const headT = h('div', { class: 'lb-head__t mono', text: '' });
  const head = h('div', { class: 'lb-head' },
    h('div', { class: 'lb-head__k', text: 'Layer' }),
    h('div', {}, headLayer, headOf),
    headZ, headT,
  );

  const hist = h('canvas', { class: 'lb-hist', 'aria-hidden': 'true' });
  const fill = h('div', { class: 'lb-fill' });
  const stub = h('div', { class: 'lb-stub', hidden: true });
  const cursor = h('div', { class: 'lb-cursor' });

  const handleHi = h('button', {
    class: 'lb-handle lb-handle--hi', role: 'slider', tabindex: '0',
    'aria-label': 'Top visible layer', 'aria-orientation': 'vertical',
    'aria-valuemin': '0', 'aria-valuemax': '0', 'aria-valuenow': '0',
  });
  const handleLo = h('button', {
    class: 'lb-handle lb-handle--lo', role: 'slider', tabindex: '0',
    'aria-label': 'Bottom visible layer', 'aria-orientation': 'vertical',
    'aria-valuemin': '0', 'aria-valuemax': '0', 'aria-valuenow': '0',
  });

  const track = h('div', { class: 'lb-track' }, fill, stub, cursor, handleLo, handleHi);
  const body = h('div', { class: 'lb-body' }, hist, track);

  const tip = h('div', { class: 'lb-tip mono', hidden: true });

  const rangeLabel = h('div', { class: 'lb-range mono', text: '--' });
  const resetBtn = h('button', {
    class: 'iconbtn iconbtn--sm', title: 'Show all layers (A)', 'aria-label': 'Show all layers',
  }, svg(['M8 2.6v10.8', 'M5.4 5.2 8 2.6l2.6 2.6', 'M5.4 10.8 8 13.4l2.6-2.6'], 12));
  resetBtn.addEventListener('click', () => set(firstReal, max, true));

  const soloBtn = h('button', {
    class: 'iconbtn iconbtn--sm', title: 'Show only the top layer (S)', 'aria-label': 'Show only the top layer',
  }, svg(['M2.6 8h10.8'], 12));
  soloBtn.addEventListener('click', () => set(hi, hi, true));

  const foot = h('div', { class: 'lb-foot' },
    rangeLabel,
    h('div', { class: 'lb-foot__row' }, resetBtn, soloBtn),
  );

  const el = h('div', { class: 'layerbar' }, head, body, foot, tip);

  /* -- geometry ----------------------------------------------------------- */

  const trackH = () => track.clientHeight;
  /** layer value -> pixel offset from the top of the track */
  function valueToY(v) {
    if (max === min) return 0;
    return (1 - (v - min) / (max - min)) * trackH();
  }
  /** pixel offset from the top of the track -> layer value */
  function yToValue(y) {
    if (max === min) return min;
    const t = 1 - clamp(y, 0, trackH()) / Math.max(1, trackH());
    return Math.round(min + t * (max - min));
  }

  /* -- rendering ---------------------------------------------------------- */

  function layerAt(v) { return layers.find((L) => L.index === v) || null; }

  function paintTrack() {
    const yHi = valueToY(hi), yLo = valueToY(lo);
    fill.style.top = yHi + 'px';
    fill.style.height = Math.max(2, yLo - yHi) + 'px';
    handleHi.style.top = yHi + 'px';
    handleLo.style.top = yLo + 'px';

    if (firstReal > min) {
      stub.hidden = false;
      const y0 = valueToY(firstReal - 1 + 0.5);
      stub.style.top = y0 + 'px';
      stub.style.height = Math.max(2, trackH() - y0) + 'px';
    } else {
      stub.hidden = true;
    }

    for (const [node, v] of [[handleHi, hi], [handleLo, lo]]) {
      node.setAttribute('aria-valuemin', String(min));
      node.setAttribute('aria-valuemax', String(max));
      node.setAttribute('aria-valuenow', String(v));
      const L = layerAt(v);
      node.setAttribute('aria-valuetext', L ? `layer ${v}, Z ${L.z.toFixed(2)} mm` : `layer ${v}`);
    }
  }

  function paintHead() {
    if (!layers.length) {
      headLayer.textContent = '--'; headOf.textContent = '';
      headZ.textContent = ''; headT.textContent = '';
      rangeLabel.textContent = '--';
      return;
    }
    const L = layerAt(hi);
    headLayer.textContent = String(hi);
    headOf.textContent = ' / ' + max;
    if (hi < firstReal) {
      headZ.textContent = 'start G-code';
      headT.textContent = '';
    } else {
      headZ.innerHTML = '';
      headZ.append('Z ' + (L ? L.z.toFixed(2) : '--'), h('span', { class: 'u', text: 'mm' }));
      headT.textContent = L && L.time ? formatDuration(L.time) : '';
    }
    rangeLabel.textContent = lo === hi ? String(hi) : lo + '–' + hi;
  }

  function paintHist() {
    const w = hist.clientWidth, hgt = hist.clientHeight;
    if (!w || !hgt) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (hist.width !== Math.round(w * dpr) || hist.height !== Math.round(hgt * dpr)) {
      hist.width = Math.round(w * dpr);
      hist.height = Math.round(hgt * dpr);
    }
    const ctx = hist.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    if (!layers.length || max === min) return;

    const n = max - min + 1;
    const rowH = hgt / n;
    const barH = Math.max(1, Math.min(rowH - 0.5, rowH * 0.82));

    for (const L of layers) {
      const raw = maxTime > 0 ? (L.time || 0) / maxTime : 0;
      const t = clamp(raw, 0, 1);
      const y = (1 - (L.index - min + 0.5) / n) * hgt - barH / 2;
      const len = Math.max(1.5, t * (w - 1));
      const inRange = L.index >= lo && L.index <= hi;
      ctx.globalAlpha = inRange ? 0.95 : 0.22;
      ctx.fillStyle = L.index < firstReal ? stubColor() : rgbToHex(sampleRamp('layerTime', t));
      ctx.fillRect(w - len, y, len, barH);
      // over the scale: notch the leading edge so it is visibly clipped
      if (raw > 1.02) {
        ctx.fillStyle = stubColor();
        ctx.fillRect(0, y, 1.5, barH);
      }
    }
    ctx.globalAlpha = 1;
  }

  /* The stub layer is chrome, not data, so its bar takes a theme token rather
     than a literal. Read lazily and cached: getComputedStyle is not free. */
  let stubColorCache = null;
  function stubColor() {
    if (stubColorCache) return stubColorCache;
    const v = getComputedStyle(el).getPropertyValue('--fg-4').trim();
    stubColorCache = v || '#777';
    return stubColorCache;
  }

  let paintQueued = false;
  function paint() {
    if (paintQueued) return;
    paintQueued = true;
    raf = requestAnimationFrame(() => {
      paintQueued = false;
      paintTrack(); paintHead(); paintHist();
    });
  }

  /* -- value changes ------------------------------------------------------ */

  function set(nextLo, nextHi, fire) {
    if (!layers.length) return;
    let a = clamp(Math.round(nextLo), min, max);
    let b = clamp(Math.round(nextHi), min, max);
    if (a > b) [a, b] = [b, a];
    const changed = a !== lo || b !== hi;
    lo = a; hi = b;
    paint();
    if (changed && fire && opts.onChange) opts.onChange(lo, hi);
  }

  function nudge(which, delta, fire = true) {
    if (which === 'hi') set(Math.min(lo, hi + delta), hi + delta, fire);
    else set(lo + delta, Math.max(hi, lo + delta), fire);
  }

  /* -- pointer ------------------------------------------------------------ */

  function localY(ev) {
    return ev.clientY - track.getBoundingClientRect().top;
  }

  function beginDrag(which, ev) {
    dragging = which;
    track.classList.add('is-dragging');
    (which === 'lo' ? handleLo : which === 'hi' ? handleHi : track).classList.add('is-active');
    try { ev.target.setPointerCapture(ev.pointerId); } catch { /* not captureable */ }
  }

  function endDrag() {
    dragging = null;
    track.classList.remove('is-dragging');
    handleLo.classList.remove('is-active');
    handleHi.classList.remove('is-active');
    hideTip();
  }

  handleHi.addEventListener('pointerdown', (ev) => { ev.preventDefault(); handleHi.focus(); beginDrag('hi', ev); });
  handleLo.addEventListener('pointerdown', (ev) => { ev.preventDefault(); handleLo.focus(); beginDrag('lo', ev); });

  track.addEventListener('pointerdown', (ev) => {
    if (ev.target === handleHi || ev.target === handleLo) return;
    if (!layers.length) return;
    ev.preventDefault();
    const y = localY(ev);
    const v = yToValue(y);
    // inside the band and not near an edge -> move the whole window
    const yHi = valueToY(hi), yLo = valueToY(lo);
    if (y > yHi + 8 && y < yLo - 8) {
      bandOffset = v - hi;
      beginDrag('band', ev);
      return;
    }
    // otherwise jump the nearer handle to the click
    const which = Math.abs(y - yHi) <= Math.abs(y - yLo) ? 'hi' : 'lo';
    (which === 'hi' ? handleHi : handleLo).focus();
    if (which === 'hi') set(Math.min(lo, v), v, true); else set(v, Math.max(hi, v), true);
    beginDrag(which, ev);
  });

  window.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const v = yToValue(localY(ev));
    if (dragging === 'hi') set(Math.min(lo, v), v, true);
    else if (dragging === 'lo') set(v, Math.max(hi, v), true);
    else if (dragging === 'band') {
      const span = hi - lo;
      let nHi = clamp(v - bandOffset, min + span, max);
      set(nHi - span, nHi, true);
    }
    showTip(v, localY(ev));
  });
  window.addEventListener('pointerup', () => { if (dragging) endDrag(); });
  window.addEventListener('pointercancel', () => { if (dragging) endDrag(); });

  /* hovering the track or the histogram previews a layer */
  function onHover(ev) {
    if (!layers.length) return;
    const y = localY(ev);
    cursor.style.top = clamp(y, 0, trackH()) + 'px';
    showTip(yToValue(y), y);
  }
  body.addEventListener('pointermove', (ev) => { if (!dragging) onHover(ev); });
  body.addEventListener('pointerleave', () => { if (!dragging) hideTip(); });

  /* clicking the histogram scrubs the top handle there -- the histogram is the
     part you are actually looking at when you hunt for a slow layer */
  hist.addEventListener('pointerdown', (ev) => {
    if (!layers.length) return;
    ev.preventDefault();
    const v = yToValue(localY(ev));
    handleHi.focus();
    set(Math.min(lo, v), v, true);
    beginDrag('hi', ev);
  });

  /* wheel over the whole bar steps the top layer */
  el.addEventListener('wheel', (ev) => {
    if (!layers.length) return;
    ev.preventDefault();
    const step = (ev.shiftKey ? 10 : 1) * (ev.deltaY > 0 ? -1 : 1);
    nudge('hi', step);
  }, { passive: false });

  function showTip(v, y) {
    const L = layerAt(v);
    tip.hidden = false;
    tip.style.top = (track.offsetTop + clamp(y, 0, trackH())) + 'px';
    if (v < firstReal) {
      tip.textContent = `L${v} · start G-code`;
    } else {
      tip.replaceChildren(
        `L${v}`,
        h('span', { class: 'u', text: L ? L.z.toFixed(2) + 'mm' : '' }),
        h('span', { class: 'u', text: L && L.time ? formatDuration(L.time) : '' }),
      );
    }
  }
  function hideTip() { tip.hidden = true; }

  /* -- keyboard ----------------------------------------------------------- */

  function keyHandler(which) {
    return (ev) => {
      if (!layers.length) return;
      const big = ev.shiftKey ? 10 : 1;
      let handled = true;
      switch (ev.key) {
        case 'ArrowUp':   case 'ArrowRight': nudge(which, big); break;
        case 'ArrowDown': case 'ArrowLeft':  nudge(which, -big); break;
        case 'PageUp':    nudge(which, 10); break;
        case 'PageDown':  nudge(which, -10); break;
        case 'Home':      if (which === 'hi') set(lo, max, true); else set(max, max, true); break;
        case 'End':       if (which === 'hi') set(min, min, true); else set(min, hi, true); break;
        default: handled = false;
      }
      if (handled) { ev.preventDefault(); ev.stopPropagation(); }
    };
  }
  handleHi.addEventListener('keydown', keyHandler('hi'));
  handleLo.addEventListener('keydown', keyHandler('lo'));

  /* -- resize ------------------------------------------------------------- */

  const ro = new ResizeObserver(() => paint());
  ro.observe(track);
  ro.observe(hist);

  /* -- public ------------------------------------------------------------- */

  return {
    el,

    /**
     * @param {Array<{index:number,z:number,time:number}>} list  parse result `layers`
     * @param {{keepRange?: boolean}} [o]
     */
    setLayers(list, o = {}) {
      layers = Array.isArray(list) ? list.slice() : [];
      if (!layers.length) {
        min = max = lo = hi = 0; firstReal = 0; maxTime = 1;
        paint();
        return;
      }
      min = layers[0].index;
      max = layers[layers.length - 1].index;

      // Layer 0 is the start-G-code stub in this dialect: no Z of its own and
      // essentially no geometry. Treat the first layer with a real Z as the
      // first printable layer.
      firstReal = min;
      const l0 = layers[0];
      if (layers.length > 1 && (l0.index === 0) && (!(l0.z > 0) || (l0.extrudeMm != null && l0.extrudeMm <= 0))) {
        firstReal = layers[1].index;
      }

      // Histogram scale. Two outliers would otherwise make the whole chart
      // useless: the layer-0 stub (heat-up waits) and layer 1 (slow base, brim
      // and skirt -- 689 s against a 15 s median on a real phone-case file).
      // Scaling to the true max squashes every other layer to two pixels, so
      // scale to the 92nd percentile instead and clip the few above it. A
      // clipped bar is drawn full width with a notch, so it still reads as
      // "off the scale" rather than pretending to be the same as the rest.
      const times = layers.filter((L) => L.index >= firstReal).map((L) => L.time || 0).sort((a, b) => a - b);
      maxTime = times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.92))] : 0;
      if (!maxTime) maxTime = times.length ? times[times.length - 1] : 1;
      if (!maxTime) maxTime = 1;

      if (!o.keepRange) { lo = firstReal; hi = max; }
      else { lo = clamp(lo, min, max); hi = clamp(hi, min, max); }
      paint();
    },

    setRange(nextLo, nextHi) { set(nextLo, nextHi, false); },
    getRange: () => ({ lo, hi }),
    getFirstRealLayer: () => firstReal,
    getLimits: () => ({ min: firstReal, max }),
    showAll() { set(firstReal, max, true); },
    step(delta, which = 'hi') { nudge(which, delta); },
    focus() { handleHi.focus(); },
    refresh() { stubColorCache = null; paint(); },
    destroy() { ro.disconnect(); cancelAnimationFrame(raf); },
  };
}
