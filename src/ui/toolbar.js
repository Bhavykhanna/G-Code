/**
 * toolbar.js -- every "change what is shown" control.
 *
 * Four independent factories, composed by layout.js:
 *   createViewModes()      left rail: which field colours the model
 *   createFeatureToggles() left rail: per-feature visibility + swatches
 *   createMoveToggles()    left rail: travel / retraction visibility
 *   createViewportTools()  canvas overlay: camera presets, fit, the Select button + panel
 *   createLaneBList()      left rail: the geometry settings that CANNOT be
 *                          edited here (see CONTEXT.md "The one hard boundary")
 *
 * Feature colours come from colors.js. Nothing here picks a data colour.
 */

import {
  VIEW_MODES, FEATURE_COLORS, FEATURE_NAMES, TRAVEL_COLOR, RETRACT_COLOR,
} from '../render/colors.js';

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

function svg(paths, size = 13, extra) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.4');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  if (extra) s.setAttribute('class', extra);
  for (const d of [].concat(paths)) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}

/* Per view mode glyphs. Deliberately geometric -- they read at 13px and they
   are about the *quantity*, not about a metaphor. */
const MODE_ICONS = {
  feature: ['M2 11.4 8 8.1l6 3.3-6 3.3z', 'M2 7.9 8 4.6l6 3.3', 'M8 1.2 2 4.5'],
  speed:   ['M2.6 12.4a6.5 6.5 0 1 1 10.8 0', 'M8 11 10.8 6.6'],
  flow:    ['M8 1.8c2.6 3 4 5 4 6.8a4 4 0 0 1-8 0c0-1.8 1.4-3.8 4-6.8Z'],
  fan:     ['M8 8a2.4 2.4 0 1 0 0-.01Z', 'M8 5.6c0-2.4-3.4-3.3-3.4-1 0 1.4 1.5 2.3 3.4 1Z', 'M10.1 9.2c2 1.2 4.4-1.4 2.4-2.5-1.2-.7-2.8.2-2.4 2.5Z', 'M5.9 9.2c-1.5 1.8.5 4.6 2 3 .9-1-.1-2.6-2-3Z'],
  temp:    ['M6.4 9.3V3.6a1.6 1.6 0 0 1 3.2 0v5.7a3.1 3.1 0 1 1-3.2 0Z', 'M8 11.8v.01'],
  width:   ['M2 8h12', 'M4.6 5.4 2 8l2.6 2.6', 'M11.4 5.4 14 8l-2.6 2.6'],
  height:  ['M8 2v12', 'M5.4 4.6 8 2l2.6 2.6', 'M5.4 11.4 8 14l2.6-2.6'],
};

/* -------------------------------------------------------------------------
   View mode selector
   ---------------------------------------------------------------------- */

/**
 * @param {{onChange?: (id: string) => void}} opts
 */
export function createViewModes(opts = {}) {
  const btns = new Map();
  const list = h('div', { class: 'modelist', role: 'radiogroup', 'aria-label': 'View mode' });

  VIEW_MODES.forEach((m, i) => {
    const icon = svg(MODE_ICONS[m.id] || MODE_ICONS.feature, 13);
    icon.classList.add('mode__icon');
    const b = h('button', {
      class: 'mode',
      role: 'radio',
      'aria-checked': 'false',
      'data-mode': m.id,
      title: m.label + (m.unit ? '  (' + m.unit + ')' : ''),
    },
      icon,
      h('span', { class: 'mode__label', text: m.label }),
      h('span', { class: 'mode__key', text: String(i + 1) }),
    );
    b.addEventListener('click', () => select(m.id, true));
    // roving arrow-key navigation inside the radiogroup
    b.addEventListener('keydown', (ev) => {
      const d = ev.key === 'ArrowDown' || ev.key === 'ArrowRight' ? 1
              : ev.key === 'ArrowUp' || ev.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      ev.preventDefault();
      const ids = VIEW_MODES.map((v) => v.id);
      const next = ids[(ids.indexOf(m.id) + d + ids.length) % ids.length];
      select(next, true);
      btns.get(next).focus();
    });
    btns.set(m.id, b);
    list.append(b);
  });

  let current = VIEW_MODES[0].id;

  function select(id, fire) {
    if (!btns.has(id)) return;
    current = id;
    for (const [k, b] of btns) {
      const on = k === id;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    if (fire && opts.onChange) opts.onChange(id);
  }
  select(current, false);

  const el = h('section', { class: 'panel' },
    h('div', { class: 'panel__head' }, h('h2', { class: 'panel__title', text: 'View mode' })),
    list,
  );

  return { el, set: (id) => select(id, false), get: () => current, byIndex: (i) => VIEW_MODES[i] && VIEW_MODES[i].id };
}

/* -------------------------------------------------------------------------
   Feature visibility toggles
   ---------------------------------------------------------------------- */

/**
 * Index 0 ('Unknown') is not offered: it is the parser's fallback bucket and
 * the legend filters it out too, so showing a toggle for it would imply a
 * feature type that the slicer never emits.
 *
 * @param {{onChange?: (visible: Set<number>) => void}} opts
 */
export function createFeatureToggles(opts = {}) {
  const INDICES = FEATURE_NAMES.map((_, i) => i).filter((i) => i !== 0);
  const visible = new Set(INDICES);
  const rows = new Map();
  const list = h('div', { class: 'featlist', role: 'group', 'aria-label': 'Feature visibility' });

  function fire() { if (opts.onChange) opts.onChange(new Set(visible)); }

  function render() {
    for (const [i, row] of rows) row.setAttribute('aria-pressed', visible.has(i) ? 'true' : 'false');
  }

  for (const i of INDICES) {
    const count = h('span', { class: 'feat__n', text: '' });
    const solo = h('span', {
      class: 'feat__solo', role: 'button', tabindex: '-1',
      title: 'Show only this feature', text: 'solo',
    });
    solo.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // clicking solo twice restores everything -- the usual DCC behaviour
      const isSolo = visible.size === 1 && visible.has(i);
      visible.clear();
      if (isSolo) for (const j of INDICES) visible.add(j);
      else visible.add(i);
      render(); fire();
    });

    const b = h('button', {
      class: 'feat', 'aria-pressed': 'true', 'data-feature': String(i),
      title: FEATURE_NAMES[i],
    },
      h('span', { class: 'tick' }),
      h('span', { class: 'swatch', style: `background:${FEATURE_COLORS[i]}` }),
      h('span', { class: 'feat__name', text: FEATURE_NAMES[i] }),
      count, solo,
    );
    b.addEventListener('click', () => {
      if (visible.has(i)) visible.delete(i); else visible.add(i);
      render(); fire();
    });
    b._count = count;
    rows.set(i, b);
    list.append(b);
  }

  const all = h('button', { class: 'link', text: 'all', title: 'Show all features' });
  const none = h('button', { class: 'link', text: 'none', title: 'Hide all features' });
  all.addEventListener('click', () => { for (const i of INDICES) visible.add(i); render(); fire(); });
  none.addEventListener('click', () => { visible.clear(); render(); fire(); });

  const el = h('section', { class: 'panel panel--grow' },
    h('div', { class: 'panel__head' },
      h('h2', { class: 'panel__title', text: 'Features' }),
      h('span', { class: 'panel__spacer' }), all, none,
    ),
    h('div', { class: 'panel__body' }, list),
  );

  /**
   * Optional: when main.js knows the per-feature move counts it can pass them
   * in. Features with a zero count are dimmed and pushed out of the way rather
   * than removed, so the list does not reorder between files.
   * @param {Record<number|string, number>|number[]|null} counts
   */
  function setCounts(counts) {
    for (const [i, row] of rows) {
      const n = counts ? Number(counts[i] ?? counts[FEATURE_NAMES[i]] ?? 0) : null;
      row._count.textContent = n ? formatCount(n) : '';
      row.style.display = counts && !n ? 'none' : '';
    }
  }

  return { el, setCounts, get: () => new Set(visible), set: (s) => { visible.clear(); for (const i of s) visible.add(i); render(); } };
}

function formatCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'k';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

/* -------------------------------------------------------------------------
   Travel / retraction toggles
   ---------------------------------------------------------------------- */

/**
 * @param {{onTravel?: (v:boolean)=>void, onRetract?: (v:boolean)=>void}} opts
 */
export function createMoveToggles(opts = {}) {
  // Travel starts off: on a 92k-move file the travel web hides the part.
  const state = { travel: false, retract: false };

  function row(key, label, colorVar, cb, hint) {
    const b = h('button', {
      class: 'toggle', 'aria-pressed': 'false', title: hint || label,
    },
      h('span', { class: 'switch' }),
      h('span', { class: 'swatch swatch--bar', style: `background:${colorVar}` }),
      h('span', { class: 'toggle__name', text: label }),
      h('span', { class: 'mode__key', text: key.toUpperCase()[0] }),
    );
    b.addEventListener('click', () => {
      state[key] = !state[key];
      b.setAttribute('aria-pressed', state[key] ? 'true' : 'false');
      if (cb) cb(state[key]);
    });
    return b;
  }

  const travelBtn = row('travel', 'Travel moves', TRAVEL_COLOR, (v) => opts.onTravel && opts.onTravel(v), 'Show non-extruding moves (T)');
  const retractBtn = row('retract', 'Retract / prime', RETRACT_COLOR, (v) => opts.onRetract && opts.onRetract(v), 'Show retraction and prime points (R)');

  const el = h('section', { class: 'panel' },
    h('div', { class: 'panel__head' }, h('h2', { class: 'panel__title', text: 'Moves' })),
    h('div', { class: 'togglelist' }, travelBtn, retractBtn),
  );

  return {
    el,
    toggleTravel: () => travelBtn.click(),
    toggleRetract: () => retractBtn.click(),
    get: () => ({ ...state }),
  };
}

/* -------------------------------------------------------------------------
   Viewport overlay tools: camera presets, box select, fit
   ---------------------------------------------------------------------- */

const CAM_ICONS = {
  iso:   ['M8 1.6 14 5v6l-6 3.4L2 11V5z', 'M8 8.4 14 5', 'M8 8.4 2 5', 'M8 8.4v6'],
  top:   ['M2.6 8 8 4.9 13.4 8 8 11.1z', 'M2.6 8v.01'],
  // the plate seen edge-on, an arrow looking up at it from below
  bottom: ['M2.6 5.2h10.8', 'M8 14V8', 'M5.8 10.2 8 8l2.2 2.2'],
  front: ['M3 4h10v8H3z', 'M3 7h10'],
  fit:   ['M2.6 5.6V3.4a.8.8 0 0 1 .8-.8h2.2', 'M10.4 2.6h2.2a.8.8 0 0 1 .8.8v2.2', 'M13.4 10.4v2.2a.8.8 0 0 1-.8.8h-2.2', 'M5.6 13.4H3.4a.8.8 0 0 1-.8-.8v-2.2'],
  box:   ['M2.6 5.2V3.6a1 1 0 0 1 1-1h1.6', 'M10.8 2.6h1.6a1 1 0 0 1 1 1v1.6', 'M13.4 10.8v1.6a1 1 0 0 1-1 1h-1.6', 'M5.2 13.4H3.6a1 1 0 0 1-1-1v-1.6', 'M6.2 6.2h3.6v3.6H6.2z'],
  layers: ['M2 11.4 8 8.1l6 3.3-6 3.3z', 'M2 7.9 8 4.6l6 3.3', 'M8 1.2 2 4.5 M8 1.2l6 3.3'],
  // a dashed square with depth lines: "everything inside, all the way through"
  area:  ['M3 3h1.6', 'M6.2 3h1.6', 'M9.4 3H11', 'M3 3v1.6', 'M3 6.2v1.6', 'M3 9.4V11', 'M3 11h1.6', 'M6.2 11h1.6', 'M9.4 11H11', 'M11 3v1.6', 'M11 6.2v1.6', 'M11 9.4V11', 'M11 11l2.4 2.4', 'M11 3l2.4 2.4v5.6'],
};

/**
 * Camera presets plus ONE "Select" button. Clicking it opens the select panel,
 * where you choose HOW to select:
 *   area   -- drag a rectangle; everything inside, hidden moves included
 *   box    -- drag a rectangle; only the moves you can see ("Visible")
 *   layers -- no drawing: every move in a layer range
 * At most one mode is on. The panel also holds the layer range (it limits
 * area and visible select too) and the area options.
 *
 * @param {{
 *   onPreset?: (p:'iso'|'top'|'bottom'|'front'|'fit')=>void,
 *   onSelectMode?: (mode: 'box'|'area'|'layers'|null)=>void,
 *   onLayerRange?: (lo:number, hi:number)=>void,
 *   onSelectLayers?: (lo:number, hi:number)=>void,
 *   onAreaOptions?: (o: {match:string, includeAux:boolean})=>void,
 *   onDeselect?: ()=>void,
 * }} opts
 */
export function createViewportTools(opts = {}) {
  function tool(name, label, key, onClick, iconKey) {
    const b = h('button', {
      class: 'vp-btn', title: `${label}  (${key})`, 'aria-label': label, 'data-tool': name,
    }, svg(CAM_ICONS[iconKey || name], 14));
    b.addEventListener('click', onClick);
    return b;
  }

  const iso = tool('iso', 'Isometric view', 'Z', () => opts.onPreset && opts.onPreset('iso'));
  const top = tool('top', 'Top view', 'X', () => opts.onPreset && opts.onPreset('top'));
  const bottom = tool('bottom', 'Bottom view (from under the bed)', 'V', () => opts.onPreset && opts.onPreset('bottom'));
  const front = tool('front', 'Front view', 'C', () => opts.onPreset && opts.onPreset('front'));
  const fit = tool('fit', 'Frame all / fit', 'F', () => opts.onPreset && opts.onPreset('fit'));

  const OPT_KEY = 'gcs.select.';
  const load = (k, d) => { try { return localStorage.getItem(OPT_KEY + k) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(OPT_KEY + k, v); } catch { /* private mode */ } };

  let mode = null;
  let panelOpen = false;
  let lastMode = ['area', 'box', 'layers'].includes(load('mode')) ? load('mode') : 'area';
  let match = ['inside', 'center', 'touch'].includes(load('match')) ? load('match') : 'inside';
  let includeAux = load('aux') === '1';

  /* -- the one button ------------------------------------------------------ */
  const selBtn = h('button', {
    class: 'vp-btn vp-btn--select', 'data-tool': 'select', 'aria-pressed': 'false', 'aria-expanded': 'false',
    title: 'Select: area, visible moves or layers  (G / B / L)', 'aria-label': 'Select',
  }, svg(CAM_ICONS.area, 14), h('span', { class: 'vp-btn__label', text: 'Select' }), svg(['M4.5 6.5 8 10l3.5-3.5'], 10));
  const selLabel = selBtn.querySelector('.vp-btn__label');
  // The button opens / closes the panel; the mode stays on while it is closed.
  selBtn.addEventListener('click', () => {
    if (!mode) { setMode(lastMode, true); openPanel(true); } else openPanel(!panelOpen);
  });
  // leave select mode without opening the panel
  const exitBtn = h('button', {
    class: 'vp-btn vp-btn--exit', type: 'button', hidden: true,
    title: 'Stop selecting  (Esc)', 'aria-label': 'Stop selecting',
  }, svg(['M4.5 4.5l7 7', 'M11.5 4.5l-7 7'], 11));
  exitBtn.addEventListener('click', () => setMode(null, true));

  // clear the current selection, from outside the panel
  const deselBtn = h('button', {
    class: 'vp-btn vp-btn--desel', type: 'button', hidden: true,
    title: 'Deselect everything', 'aria-label': 'Deselect',
  }, svg(['M4.5 4.5l7 7', 'M11.5 4.5l-7 7'], 11), h('span', { class: 'vp-btn__label' }));
  const deselLabel = deselBtn.querySelector('.vp-btn__label');
  deselBtn.addEventListener('click', () => opts.onDeselect && opts.onDeselect());

  const el = h('div', { class: 'vp-group', role: 'toolbar', 'aria-label': 'Viewport' },
    iso, top, bottom, front,
    h('span', { class: 'vp-sep' }),
    fit,
    h('span', { class: 'vp-sep' }),
    selBtn, exitBtn,
  );

  /* -- the panel ----------------------------------------------------------- */
  const MODES = [
    ['area', 'Area', 'G', 'Drag a rectangle. Everything inside it is taken, including moves hidden behind others.'],
    ['box', 'Visible', 'B', 'Drag a rectangle. Only the moves you can actually see are taken.'],
    ['layers', 'Layers', 'L', 'No drawing: every move in the layers below is taken.'],
  ];
  const modeBtns = new Map();
  const modeSeg = h('div', { class: 'seg seg--full', role: 'tablist' });
  for (const [id, label, key] of MODES) {
    const b = h('button', { class: 'seg__btn', type: 'button', 'aria-selected': 'false', title: `${label}  (${key})` },
      svg(CAM_ICONS[id === 'layers' ? 'layers' : id], 12), label);
    b.addEventListener('click', () => { setMode(id, true); if (id !== 'layers') openPanel(false); });
    modeBtns.set(id, b);
    modeSeg.append(b);
  }
  const hint = h('div', { class: 'selp__hint' });

  // layers
  const num = () => h('input', { class: 'selp__num mono', type: 'number', step: '1', inputmode: 'numeric' });
  const loIn = num(), hiIn = num();
  const ofTxt = h('span', { class: 'selp__of' });
  const allBtn = h('button', { class: 'link', type: 'button', text: 'all' });
  const oneBtn = h('button', { class: 'link', type: 'button', text: 'top only', title: 'Only the top layer of the range' });
  let limits = { min: 0, max: 0 };
  const clampL = (v) => Math.max(limits.min, Math.min(limits.max, Math.round(Number(v) || 0)));
  function readLayers() {
    let lo = clampL(loIn.value), hi = clampL(hiIn.value);
    if (lo > hi) [lo, hi] = [hi, lo];
    loIn.value = String(lo); hiIn.value = String(hi);
    return [lo, hi];
  }
  const pushLayers = () => { const [lo, hi] = readLayers(); if (opts.onLayerRange) opts.onLayerRange(lo, hi); };
  for (const inp of [loIn, hiIn]) {
    inp.addEventListener('change', pushLayers);
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation(); // arrows/letters here must not drive the viewport shortcuts
      if (ev.key === 'Enter') { pushLayers(); if (mode === 'layers') selectLayersBtn.click(); }
      if (ev.key === 'Escape') inp.blur();
    });
  }
  allBtn.addEventListener('click', () => { loIn.value = String(limits.min); hiIn.value = String(limits.max); pushLayers(); });
  oneBtn.addEventListener('click', () => { const [, hi] = readLayers(); loIn.value = String(hi); pushLayers(); });
  const layersRow = h('div', { class: 'selp__row' },
    h('span', { class: 'selp__k', text: 'Layers' }),
    loIn, h('span', { class: 'selp__dash', text: '–' }), hiIn, ofTxt,
    h('span', { class: 'panel__spacer' }), oneBtn, allBtn);

  const selectLayersBtn = h('button', { class: 'btn btn--primary btn--sm btn--block', type: 'button' }, 'Select these layers');
  selectLayersBtn.addEventListener('click', () => {
    const [lo, hi] = readLayers();
    if (opts.onLayerRange) opts.onLayerRange(lo, hi);
    if (opts.onSelectLayers) opts.onSelectLayers(lo, hi);
    openPanel(false);
  });

  // area options
  const matchBtns = new Map();
  const matchSeg = h('div', { class: 'seg seg--full' });
  for (const [id, label, title] of [
    ['inside', 'Fully inside', 'Both ends of a move must be inside. Long skirt / infill lines that only cross the rectangle are left out.'],
    ['center', 'Centre', 'The middle of a move must be inside. Can pick up long lines that cross the rectangle.'],
    ['touch', 'Touching', 'Any part of a move inside the rectangle counts.'],
  ]) {
    const b = h('button', { class: 'seg__btn', type: 'button', 'aria-pressed': 'false', title }, label);
    b.addEventListener('click', () => { match = id; save('match', id); paintOpts(true); });
    matchBtns.set(id, b);
    matchSeg.append(b);
  }
  const auxBox = h('input', { type: 'checkbox' });
  auxBox.addEventListener('change', () => { includeAux = auxBox.checked; save('aux', includeAux ? '1' : '0'); paintOpts(true); });
  const auxRow = h('label', { class: 'selp__check' }, auxBox, 'Include skirt, brim and purge line');

  const areaRows = h('div', { class: 'selp__group' },
    h('div', { class: 'selp__row' }, h('span', { class: 'selp__k', text: 'Counts if' }), matchSeg),
    auxRow);

  const hideBtn = h('button', { class: 'link', type: 'button', text: 'hide', title: 'Close this panel, keep selecting' });
  hideBtn.addEventListener('click', () => openPanel(false));
  const doneBtn = h('button', { class: 'link', type: 'button', text: 'stop (Esc)', title: 'Stop selecting' });
  doneBtn.addEventListener('click', () => setMode(null, true));

  const panel = h('div', { class: 'selp', hidden: true, role: 'dialog', 'aria-label': 'Select' },
    h('div', { class: 'selp__head' }, h('span', { class: 'selp__title', text: 'Select' }), h('span', { class: 'panel__spacer' }), hideBtn, doneBtn),
    modeSeg, hint, layersRow, areaRows, selectLayersBtn);

  function paintOpts(fire) {
    for (const [id, b] of matchBtns) b.setAttribute('aria-pressed', id === match ? 'true' : 'false');
    auxBox.checked = includeAux;
    if (fire && opts.onAreaOptions) opts.onAreaOptions({ match, includeAux });
  }

  function openPanel(open) {
    panelOpen = !!open && !!mode;
    panel.hidden = !panelOpen;
    selBtn.setAttribute('aria-expanded', panelOpen ? 'true' : 'false');
  }

  function setMode(m, fire) {
    mode = ['box', 'area', 'layers'].includes(m) ? m : null;
    if (mode) { lastMode = mode; save('mode', mode); }
    if (!mode) openPanel(false);
    selBtn.setAttribute('aria-pressed', mode ? 'true' : 'false');
    selBtn.dataset.mode = mode || '';
    exitBtn.hidden = !mode;
    const spec0 = MODES.find((x) => x[0] === mode);
    selLabel.textContent = spec0 ? spec0[1] : 'Select';
    for (const [id, b] of modeBtns) b.setAttribute('aria-selected', id === mode ? 'true' : 'false');
    const spec = MODES.find((x) => x[0] === mode);
    hint.textContent = spec ? spec[3] + (mode === 'layers' ? '' : ' Only layers in the range below can be picked.') : '';
    areaRows.hidden = mode !== 'area';
    selectLayersBtn.hidden = mode !== 'layers';
    if (fire && opts.onSelectMode) opts.onSelectMode(mode);
  }
  setMode(null, false);
  paintOpts(false);

  return {
    el,
    panel,
    deselect: deselBtn,
    setSelectMode: (m) => setMode(m, false),
    // keyboard G / B / L: switch straight into the mode, panel only for layers
    toggleSelectMode: (m) => { setMode(mode === m ? null : m, true); openPanel(mode === 'layers'); },
    /** show / hide the Deselect button; n = moves selected */
    setSelectionCount(n) {
      deselBtn.hidden = !n;
      deselLabel.textContent = n ? `Deselect ${n.toLocaleString()}` : '';
    },
    getSelectMode: () => mode,
    getAreaOptions: () => ({ match, includeAux }),
    /** keep the panel's numbers in step with the layer bar */
    setLayers(lo, hi, lim) {
      if (lim) limits = { min: lim.min, max: lim.max };
      for (const inp of [loIn, hiIn]) { inp.min = String(limits.min); inp.max = String(limits.max); }
      if (document.activeElement !== loIn) loIn.value = String(lo);
      if (document.activeElement !== hiIn) hiIn.value = String(hi);
      ofTxt.textContent = 'of ' + limits.max;
    },
  };
}

/* -------------------------------------------------------------------------
   Lane B: the things that are NOT editable here
   ---------------------------------------------------------------------- */

/**
 * CONTEXT.md is explicit: G-code is the slicer's output, not a model. Anything
 * geometric has to go back through ElegooSlicer. Rather than hide those
 * settings and let the user hunt for them, we list them -- visibly marked,
 * visibly not-a-G-code-edit -- and turn a click into a re-slice request.
 *
 * @param {{onRequest?: (key:string, label:string)=>void}} opts
 */
export function createLaneBList(opts = {}) {
  const ITEMS = [
    ['wall_loops', 'Wall count'],
    ['line_width', 'Line width'],
    ['sparse_infill_density', 'Infill density'],
    ['layer_height', 'Layer height'],
    ['brim_type', 'Brim / skirt'],
    ['enable_support', 'Supports'],
    ['ironing_type', 'Ironing'],
    ['geometry', 'Model geometry (hex gaps)'],
  ];

  const list = h('div', { class: 'laneb-list' },
    ITEMS.map(([key, label]) => {
      const b = h('button', {
        class: 'laneb lane-b-edge', 'data-lane': 'B', 'data-key': key,
        title: `${label} - geometric, needs a re-slice (~2.2 s). Cannot be edited in G-code.`,
      },
        h('span', { class: 'laneb__name', text: label }),
        svg(['M9.5 3.5 14 8l-4.5 4.5', 'M14 8H2.6'], 11, 'laneb__go'),
      );
      b.addEventListener('click', () => opts.onRequest && opts.onRequest(key, label));
      return b;
    }),
  );

  const el = h('section', { class: 'panel' },
    h('div', { class: 'panel__head' },
      h('h2', { class: 'panel__title', text: 'Geometry' }),
      h('span', { class: 'panel__spacer' }),
      h('span', { class: 'badge badge--b', text: 'Re-slice' }),
    ),
    list,
    h('p', {
      class: 'laneb-note',
      text: 'Geometric settings are not in the G-code. These open a re-slice request instead of an edit.',
    }),
  );

  return { el };
}
