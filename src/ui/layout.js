/**
 * layout.js -- builds the app shell and is the ONLY thing src/main.js talks to.
 *
 * Everything main.js needs is on the object returned by `createUI(root)`. The
 * panel modules (inspector, terminal, layerbar, ...) are composed here and are not
 * part of the public surface, so they can be rearranged without main.js
 * noticing.
 *
 * Frame, top to bottom / left to right:
 *
 *   +---------------------------------------------------------------+
 *   | title bar: brand | file + job switcher | time/weight/layers    |
 *   +--------+------------------------------------+-----------------+
 *   | rail   |  viewport (canvas)        | layer  |  inspector      |
 *   |  view  |    overlay: camera tools   | bar   |  ---- split ---- |
 *   |  feats |    overlay: legend         |       |  Claude pane    |
 *   +--------+------------------------------------+-----------------+
 *   | status bar: parse ms | moves | warnings | connection           |
 *   +---------------------------------------------------------------+
 *
 * The canvas: this module sizes it with CSS only and never touches
 * `canvas.width` / `canvas.height`, because the renderer owns the backing
 * store. On every resize it dispatches a bubbling `gcs:resize` CustomEvent on
 * the canvas with `{width, height, dpr}` in CSS pixels, which is what main.js
 * should feed to `renderer.setSize(w, h, false)`.
 */

import { VIEW_MODES, FEATURE_NAMES } from '../render/colors.js';
import { formatDuration } from '../parser/parse.js';
import { createViewModes, createFeatureToggles, createMoveToggles, createViewportTools, createLaneBList } from './toolbar.js';
import { createLegend } from './legend.js';
import { DIFF_ADDED, DIFF_REMOVED, DIFF_SAME } from '../render/colors.js';
import { createLayerBar } from './layerbar.js';
import { createInspector } from './inspector.js';
import { createTerminal } from './terminal.js';
import { createModalHost } from './diffmodal.js';
import { createToaster } from './toast.js';
import { createCompareBar, createPointerList, fmtMm } from './compare.js';

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

function svg(paths, size = 13, cls) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.4');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  if (cls) s.setAttribute('class', cls);
  for (const d of [].concat(paths)) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}

const I = {
  chev:  ['M4 6.5 8 10.5l4-4'],
  warn:  ['M7.1 2.5 1.7 12a1 1 0 0 0 .9 1.5h10.8a1 1 0 0 0 .9-1.5L8.9 2.5a1 1 0 0 0-1.8 0Z', 'M8 6.3v2.9', 'M8 11.3h.01'],
  tick:  ['M3.4 8.4 6.4 11.4l6.2-6.6'],
  sun:   ['M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M8 1.4v1.4', 'M8 13.2v1.4', 'M1.4 8h1.4', 'M13.2 8h1.4', 'M3.3 3.3l1 1', 'M11.7 11.7l1 1', 'M12.7 3.3l-1 1', 'M4.3 11.7l-1 1'],
  moon:  ['M13.4 9.6A5.8 5.8 0 0 1 6.4 2.6a5.8 5.8 0 1 0 7 7Z'],
  keys:  ['M2.6 4.4h10.8a1 1 0 0 1 1 1v5.2a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1V5.4a1 1 0 0 1 1-1Z', 'M4.6 7.2h.01', 'M7.2 7.2h.01', 'M9.8 7.2h.01', 'M5 9.6h6'],
  menu:  ['M2.4 4.4h11.2', 'M2.4 8h11.2', 'M2.4 11.6h11.2'],
  // a window with its left panel: the side bar toggle
  sidebar: ['M3 2.6h10a1 1 0 0 1 1 1v8.8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1Z', 'M6.2 2.6v10.8', 'M3.6 5.2h1.2', 'M3.6 7.2h1.2'],
  mark:  ['M2 11.4 8 8.1l6 3.3-6 3.3z', 'M2 7.9 8 4.6l6 3.3-6 3.3z', 'M2 4.4 8 1.1l6 3.3-6 3.3z'],
  hideL: ['M10 3.5 5.5 8l4.5 4.5'],
  showR: ['M6 3.5 10.5 8 6 12.5'],
  dots: ['M3.6 8h.01', 'M8 8h.01', 'M12.4 8h.01'],
  reload: ['M13.2 8a5.2 5.2 0 1 1-1.5-3.7', 'M13.4 2.4v2.6h-2.6'],
  image: ['M3 2.6h10a1 1 0 0 1 1 1v8.8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1Z', 'M2.4 10.6 5.6 7.6l3 2.8 1.8-1.6 3.2 2.8', 'M10.6 5.8h.01'],
};

/** text measurement for the middle-truncated file name */
const measureCtx = document.createElement('canvas').getContext('2d');
function measure(text, font) { measureCtx.font = font; return measureCtx.measureText(text).width; }

const SPLIT_KEY = 'gcs.split';
const SIDEW_KEY = 'gcs.sidew';

function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } }

/* ==========================================================================
   createUI
   ========================================================================== */

/**
 * @param {HTMLElement} rootElement
 */
export function createUI(rootElement) {
  const root = rootElement || document.body;
  root.classList.add('app');
  root.replaceChildren();

  /** every `onX(cb)` registration lands here */
  const on = {};
  const call = (name, ...args) => { const f = on[name]; if (typeof f === 'function') return f(...args); return undefined; };

  let fileInfo = null;
  let jobs = [];
  let currentPath = null;
  let viewMode = VIEW_MODES[0].id;
  let selectionId = null;
  let warnings = [];

  /* -- theme -------------------------------------------------------------- */
  // Dark only (user, 2026-09-16): the light toggle is gone; an old saved 'light' is ignored.
  document.documentElement.dataset.theme = 'dark';

  /* ======================================================================
     TITLE BAR
     ====================================================================== */

  // Side bar toggle (user, 2026-09-17): a window-with-panel icon, any window width; lit while the bar is shown.
  const railBtn = h('button', {
    class: 'iconbtn tb-railbtn', type: 'button', 'aria-label': 'Show or hide the side bar',
    title: 'Show / hide the side bar  ([)', 'aria-pressed': 'true',
  }, svg(I.sidebar, 15));
  railBtn.addEventListener('click', () => toggleRail());

  const brand = h('div', { class: 'tb-brand' },
    railBtn,
    svg(I.mark, 15, 'tb-brand__mark'),
    h('span', { class: 'tb-brand__name' }, h('b', { text: 'G-code' }), ' Studio'),
  );

  const fileNameEl = h('span', { class: 'jobswitch__name mono' });
  const jobBtn = h('button', {
    class: 'jobswitch', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    title: 'Switch file  (Ctrl+O)',
  }, fileNameEl, svg(I.chev, 12, 'jobswitch__chev'));

  const jobMenu = h('div', { class: 'menu', role: 'menu', hidden: true });
  document.body.append(jobMenu);

  const tbFile = h('div', { class: 'tb-file' }, jobBtn);

  function stat(key, id, optional) {
    const v = h('span', { class: 'stat__v mono', text: '—' });
    return { el: h('div', { class: 'stat', 'data-stat': id, 'data-opt': optional ? '1' : null },
      h('span', { class: 'stat__k', text: key }), v), v };
  }
  const sTime = stat('Time', 'time');
  const sWeight = stat('Filament', 'weight');
  const sLayers = stat('Layers', 'layers');
  const sMoves = stat('Moves', 'moves', true);
  const statstrip = h('div', { class: 'statstrip' }, sTime.el, sWeight.el, sLayers.el, sMoves.el);


  // Reload the page. F5 is not reliable (the Claude terminal can hold focus);
  // Claude keeps running, it lives on the server.
  const reloadBtn = h('button', { class: 'iconbtn', 'aria-label': 'Refresh app', title: 'Refresh the app  (F5)' }, svg(I.reload, 14));
  reloadBtn.addEventListener('click', () => location.reload());

  // Embeds a printer-screen preview into the current file (as a new version).
  // ⋯ menu: the less-used title bar actions
  const moreBtn = h('button', {
    class: 'iconbtn tb-more', type: 'button', 'aria-label': 'More', title: 'More',
    'aria-haspopup': 'menu', 'aria-expanded': 'false',
  }, svg(I.dots, 16));
  const moreMenu = h('div', { class: 'menu tb-menu', role: 'menu', hidden: true });
  document.body.append(moreMenu);
  const moreItems = [
    { icon: I.image, label: 'Add printer preview', meta: 'new -thumbnail version', run: () => call('addThumbnail') },
    { icon: I.keys, label: 'Keyboard shortcuts', meta: '?', run: () => showShortcuts() },
  ];
  function closeMore() {
    moreMenu.hidden = true;
    moreBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outsideMore, true);
    document.removeEventListener('keydown', moreKeys, true);
  }
  function outsideMore(ev) { if (!moreMenu.contains(ev.target) && !moreBtn.contains(ev.target)) closeMore(); }
  function moreKeys(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeMore(); moreBtn.focus(); return; }
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    const items = [...moreMenu.querySelectorAll('.menu__item')];
    const i = items.indexOf(document.activeElement);
    items[(i + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  }
  moreBtn.addEventListener('click', () => {
    if (!moreMenu.hidden) { closeMore(); return; }
    moreMenu.replaceChildren(...moreItems.map((it) => {
      const b = h('button', { class: 'menu__item', role: 'menuitem', type: 'button' },
        svg(it.icon, 14, 'menu__icon'),
        h('span', { class: 'menu__name', text: it.label }),
        h('span', { class: 'menu__meta', text: it.meta }));
      b.addEventListener('click', () => { closeMore(); it.run(); });
      return b;
    }));
    moreMenu.hidden = false;
    moreBtn.setAttribute('aria-expanded', 'true');
    const r = moreBtn.getBoundingClientRect();
    moreMenu.style.left = Math.max(8, Math.min(r.right - moreMenu.offsetWidth, window.innerWidth - 8 - moreMenu.offsetWidth)) + 'px';
    moreMenu.style.top = (r.bottom + 4) + 'px';
    setTimeout(() => {
      document.addEventListener('pointerdown', outsideMore, true);
      document.addEventListener('keydown', moreKeys, true);
    }, 0);
    moreMenu.querySelector('.menu__item')?.focus();
  });

  // Diff: show on the model what changed against the file this one came from.
  const diffBtn = h('button', { class: 'tb-btn', type: 'button', 'aria-pressed': 'false',
    title: 'Diff against the version this file came from  (D)' }, 'Diff');
  diffBtn.addEventListener('click', () => call('diff'));
  // Check: draw the print check's findings (tiny islands, spans over air, ...) on the model.
  const checkBtn = h('button', { class: 'tb-btn', type: 'button', 'aria-pressed': 'false',
    title: 'Check this file before printing: tiny islands, travels over fresh plastic, spans over air, '
      + 'thin screw seats -- drawn on the model  (K)' }, 'Check');
  checkBtn.addEventListener('click', () => call('check'));
  // Finalize: only for ..._vN-draft.gcode files.
  const finalizeBtn = h('button', { class: 'tb-btn tb-btn--primary', type: 'button', hidden: true,
    title: 'Give this draft its final name; the previous final moves to old\\' }, 'Finalize');
  finalizeBtn.addEventListener('click', () => call('finalize'));

  const titlebar = h('header', { class: 'titlebar' },
    brand, tbFile, statstrip,
    h('div', { class: 'tb-actions' }, finalizeBtn, checkBtn, diffBtn, reloadBtn, moreBtn),
  );

  /* ======================================================================
     LEFT RAIL
     ====================================================================== */

  const modes = createViewModes({
    onChange: (id) => { viewMode = id; paintLegend(); call('viewModeChange', id); },
  });
  const features = createFeatureToggles({ onChange: (set) => call('featureToggle', set) });
  const moves = createMoveToggles({
    onTravel: (v) => call('travelToggle', v),
    onRetract: (v) => call('retractToggle', v),
  });
  const laneB = createLaneBList({
    onRequest: (key, label) => {
      toaster.show(
        `${label} is geometric — it needs a re-slice. Typed into Claude: add details, press Enter.`,
        'warn',
      );
      call('editRequest', { lane: 'B', key, label, file: currentPath });
    },
  });

  /* -- collapsible rail sections ------------------------------------------ */
  const RAIL_KEY = 'gcs.rail.collapsed.';
  const railSections = [
    ['modes', modes.el], ['features', features.el], ['moves', moves.el], ['geometry', laneB.el],
  ];
  const sectionSetters = [];

  for (const [key, panel] of railSections) {
    const head = panel.querySelector(':scope > .panel__head');
    const title = head && head.querySelector('.panel__title');
    if (!head || !title) continue;
    const btn = h('button', {
      class: 'panel__collapse', type: 'button', 'aria-expanded': 'true',
      'aria-label': 'Collapse ' + title.textContent, title: 'Collapse / expand',
    }, svg(I.chev, 12));
    head.prepend(btn);
    title.classList.add('is-toggle');

    const set = (collapsed, remember = true) => {
      panel.classList.toggle('is-collapsed', collapsed);
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.setAttribute('aria-label', (collapsed ? 'Expand ' : 'Collapse ') + title.textContent);
      if (remember) store(RAIL_KEY + key, collapsed ? '1' : '0');
    };
    const toggle = () => set(!panel.classList.contains('is-collapsed'));
    btn.addEventListener('click', toggle);
    title.addEventListener('click', toggle);
    set(store(RAIL_KEY + key) === '1', false);
    sectionSetters.push(set);
  }

  const collapseAll = h('button', { class: 'link', type: 'button', text: 'collapse all' });
  const expandAll = h('button', { class: 'link', type: 'button', text: 'expand all' });
  collapseAll.addEventListener('click', () => sectionSetters.forEach((s) => s(true)));
  expandAll.addEventListener('click', () => sectionSetters.forEach((s) => s(false)));
  // Hide the whole rail for more model; a notch on the viewport's left edge brings it back.
  const RAIL_HIDDEN_KEY = 'gcs.rail.hidden';
  const narrow = () => window.matchMedia('(max-width: 980px)').matches;
  function setRailHidden(hide, remember = true) {
    railBtn.setAttribute('aria-pressed', hide ? 'false' : 'true');
    if (narrow()) { root.dataset.rail = hide ? 'closed' : 'open'; return; }
    root.dataset.railHidden = hide ? '1' : '0';
    if (remember) store(RAIL_HIDDEN_KEY, hide ? '1' : '0');
  }
  const railIsHidden = () => (narrow() ? root.dataset.rail !== 'open' : root.dataset.railHidden === '1');
  function toggleRail() { setRailHidden(!railIsHidden()); }
  // (the old '‹' hide button was removed 2026-09-17: the title bar's side bar icon does it)
  const railNotch = h('button', {
    class: 'rail-notch', type: 'button', 'aria-label': 'Show side bar', title: 'Show side bar  ([)',
  }, svg(I.showR, 12));
  railNotch.addEventListener('click', () => setRailHidden(false));
  const railTools = h('div', { class: 'rail-tools' }, h('span', { class: 'panel__spacer' }), collapseAll, expandAll);

  const rail = h('nav', { class: 'rail', 'aria-label': 'View controls' },
    railTools, modes.el, features.el, moves.el, laneB.el);

  /* ======================================================================
     STAGE
     ====================================================================== */

  const canvas = h('canvas', { class: 'viewport__canvas', id: 'gcs-canvas', tabindex: '0' });

  const vpEmpty = h('div', { class: 'vp-empty' },
    svg(I.mark, 44, 'vp-empty__mark'),
    h('div', { class: 'vp-empty__title', text: 'No G-code loaded' }),
    h('div', { class: 'vp-empty__sub', text: 'Pick a job from the file switcher in the title bar.' }),
  );

  const vptools = createViewportTools({
    onPreset: (p) => call('cameraPreset', p),
    onSelectMode: (m) => applySelectMode(m),
    onLayerRange: (lo, hi) => { layerbar.setRange(lo, hi); call('layerRangeChange', lo, hi); },
    onSelectLayers: (lo, hi) => call('selectLayers', lo, hi),
    onAreaOptions: (o) => call('areaOptions', o),
    onDeselect: () => { api.showSelection(null); call('clearSelection'); },
  });

  const compareBar = createCompareBar({
    onMode: (m) => { if (compareInfo) compareInfo.mode = m; paintLegend(); call('compareMode', m); },
    onAlign: () => call('compareAlign'),
    onLook: (look) => call('compareLook', look),
    onClose: () => call('diff'),
    onPick: () => call('diffPick'),
  });

  const pointerList = createPointerList({
    onClear: () => call('pointersClear'),
    onFrame: () => call('pointersFrame'),
  });

  const legend = createLegend();
  let lastLegend = [];
  let compareInfo = null;   // {name, path, mode, stats} while a diff is on

  /** The colour key: the diff's own key in Changes mode, else the view mode's. */
  function paintLegend() {
    if (compareInfo && compareInfo.mode !== 'both') {
      const st = compareInfo.stats;
      const rows = [
        { name: 'Only in this file', color: DIFF_ADDED, meta: st ? '+' + fmtMm(st.curAddedMm) : '', title: 'Printed only in this file' },
        { name: 'Only in the base', color: DIFF_REMOVED, meta: st ? '\u2212' + fmtMm(st.oldRemovedMm) : '', title: 'Printed only in ' + compareInfo.name },
        { name: 'Same in both', color: DIFF_SAME },
      ];
      rows.layout = 'list';
      legend.set(rows, 'diff', 'Diff');
      return;
    }
    const entries = lastLegend;
    if (compareInfo && entries.length) {
      const copy = entries.slice();
      copy.layout = entries.layout;
      copy.note = 'faint ghost = ' + compareInfo.name;
      legend.set(copy, viewMode);
      return;
    }
    legend.set(entries, viewMode);
  }

  const viewport = h('div', { class: 'viewport' },
    canvas, vpEmpty,
    h('div', { class: 'vp-overlay vp-overlay--tr' }, vptools.el, vptools.deselect, vptools.panel),
    h('div', { class: 'vp-overlay vp-overlay--tl' }, compareBar.el, pointerList.el),
    h('div', { class: 'vp-overlay vp-overlay--bl' }, legend.el),
    railNotch,
  );
  // narrow windows start with the overlay side bar closed, as before
  if (narrow()) railBtn.setAttribute('aria-pressed', root.dataset.rail === 'open' ? 'true' : 'false');
  else setRailHidden(store(RAIL_HIDDEN_KEY) === '1', false);

  // The top-left cards (diff, Claude's boxes) drop below the view tools when
  // the viewport is too narrow for both on one row.
  const tlOverlay = viewport.querySelector('.vp-overlay--tl');
  function placeTopLeft() {
    tlOverlay.classList.remove('is-below');
    const a = tlOverlay.getBoundingClientRect();
    const b = vptools.el.getBoundingClientRect();
    if (a.width && b.width && a.right + 8 > b.left) {
      const v = viewport.getBoundingClientRect();
      tlOverlay.style.setProperty('--tl-top', Math.round(b.bottom - v.top + 8) + 'px');
      tlOverlay.classList.add('is-below');
    }
  }
  new ResizeObserver(placeTopLeft).observe(viewport);
  new ResizeObserver(placeTopLeft).observe(tlOverlay);

  function applySelectMode(m) {
    viewport.classList.toggle('is-boxselect', m === 'box');
    viewport.classList.toggle('is-areaselect', m === 'area');
    call('selectModeChange', m);
  }

  const layerbar = createLayerBar({
    onChange: (lo, hi) => { syncSelectLayers(); call('layerRangeChange', lo, hi); },
  });
  function syncSelectLayers() {
    const r = layerbar.getRange();
    vptools.setLayers(r.lo, r.hi, layerbar.getLimits());
  }

  const stage = h('main', { class: 'stage' }, viewport, layerbar.el);

  /* canvas sizing: CSS owns the element box, the renderer owns the backing
     store, and this event is the handshake between them */
  const ro = new ResizeObserver(() => {
    const r = viewport.getBoundingClientRect();
    canvas.dispatchEvent(new CustomEvent('gcs:resize', {
      bubbles: true,
      detail: { width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)), dpr: window.devicePixelRatio || 1 },
    }));
  });
  ro.observe(viewport);

  /* ======================================================================
     RIGHT PANEL: inspector over the Claude pane
     ====================================================================== */

  const inspector = createInspector({
    onSend: (note) => call('sendToClaude', note),
    onAttachMove: () => call('attachMove'),
    onEditRequest: (req) => {
      if (on.editRequest) call('editRequest', req);
      else toaster.show('Edit pipeline is not wired up yet — nothing was written.', 'warn');
    },
    onClear: () => { api.showSelection(null); call('clearSelection'); },
  });

  /* -- the Claude pane: live Claude Code ----------------------------------
     The one way to talk to Claude. Everything the app wants to say to it --
     attachments, re-slice requests -- is typed into its prompt. */
  let terminal = null;
  const termSlot = h('div', { class: 'pane-slot' },
    h('div', { class: 'term-placeholder', text: 'Claude starts with the app…' }));
  const paneBits = h('div', { class: 'pane-head__bits' });
  // Claude Code wants ~80 columns; the default panel gives it ~44. "Wide"
  // borrows width from the viewport until it is switched off again.
  const wideBtn = h('button', { class: 'iconbtn iconbtn--sm', type: 'button', 'aria-pressed': 'false',
    title: 'Widen the panel for Claude', 'aria-label': 'Widen the panel for Claude' },
    svg(['M6 3.5 1.5 8 6 12.5', 'M1.5 8h7', 'M11 2.5v11', 'M14 2.5v11'], 12));
  const paneHead = h('header', { class: 'pane-head' },
    h('h2', { class: 'panel__title', text: 'Claude' }), paneBits, wideBtn);
  const pane = h('section', { class: 'claude-pane' }, paneHead, termSlot);

  let wide = false;
  let narrowW = null;
  function setWide(v) {
    wide = !!v;
    wideBtn.setAttribute('aria-pressed', wide ? 'true' : 'false');
    if (wide) {
      narrowW = root.style.getPropertyValue('--side-w') || null;
      root.style.setProperty('--side-w', Math.round(Math.min(860, window.innerWidth * 0.52)) + 'px');
    } else if (narrowW) {
      root.style.setProperty('--side-w', narrowW);
    } else {
      root.style.removeProperty('--side-w');
    }
    layerbar.refresh();
  }
  wideBtn.addEventListener('click', () => setWide(!wide));

  function focusClaude() { if (terminal) terminal.focus(); }

  const split = h('div', { class: 'split', role: 'separator', 'aria-orientation': 'horizontal', tabindex: '0',
    title: 'Drag to resize · double-click to reset' });
  const sideGrip = h('div', { class: 'side__grip', title: 'Drag to resize the panel' });

  const side = h('aside', { class: 'side' }, sideGrip, inspector.el, split, pane);

  /* -- split drag (inspector vs Claude) ------------------------------------- */
  const savedSplit = parseFloat(store(SPLIT_KEY));
  const SPLIT_DEFAULT = 0.55 / 0.45;   // inspector gets 55 % of the panel
  let splitFr = Number.isFinite(savedSplit) ? savedSplit : SPLIT_DEFAULT;
  function applySplit() {
    side.style.setProperty('--split', splitFr.toFixed(3) + 'fr');
  }
  applySplit();

  split.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    split.classList.add('is-dragging');
    split.setPointerCapture(ev.pointerId);
    const rect = side.getBoundingClientRect();
    const move = (e) => {
      const f = (e.clientY - rect.top) / Math.max(1, rect.height);
      splitFr = Math.max(0.16, Math.min(0.86, f)) / Math.max(0.14, 1 - Math.max(0.16, Math.min(0.86, f)));
      applySplit();
      layerbar.refresh();
    };
    const up = () => {
      split.classList.remove('is-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      store(SPLIT_KEY, String(splitFr));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  split.addEventListener('dblclick', () => { splitFr = SPLIT_DEFAULT; applySplit(); store(SPLIT_KEY, String(splitFr)); });
  split.addEventListener('keydown', (ev) => {
    const d = ev.key === 'ArrowUp' ? -0.08 : ev.key === 'ArrowDown' ? 0.08 : 0;
    if (!d) return;
    ev.preventDefault();
    splitFr = Math.max(0.2, Math.min(6, splitFr + d));
    applySplit(); store(SPLIT_KEY, String(splitFr));
  });

  /* -- panel width drag ---------------------------------------------------- */
  const savedW = parseFloat(store(SIDEW_KEY));
  if (Number.isFinite(savedW)) root.style.setProperty('--side-w', savedW + 'px');
  sideGrip.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    sideGrip.classList.add('is-dragging');
    sideGrip.setPointerCapture(ev.pointerId);
    const move = (e) => {
      const w = Math.max(280, Math.min(Math.max(680, window.innerWidth - 420), window.innerWidth - e.clientX));
      if (wide) { wide = false; wideBtn.setAttribute('aria-pressed', 'false'); }
      root.style.setProperty('--side-w', w + 'px');
    };
    const up = () => {
      sideGrip.classList.remove('is-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      store(SIDEW_KEY, String(parseFloat(root.style.getPropertyValue('--side-w'))));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  /* ======================================================================
     STATUS BAR
     ====================================================================== */

  const sbParse = h('span', { class: 'sb-item__v', text: '—' });
  const sbMoves = h('span', { class: 'sb-item__v', text: '—' });
  const sbLayers = h('span', { class: 'sb-item__v', text: '—' });
  const sbConnDot = h('span', { class: 'sb-dot', 'data-state': 'off' });
  const sbConnTxt = h('span', { text: 'disconnected' });
  const sbBusyTxt = h('span', { class: 'sb-item', hidden: true });

  const warnBtn = h('button', { class: 'sb-item sb-item--warn', hidden: true, 'aria-haspopup': 'dialog' },
    svg(I.warn, 11), h('span', { class: 'sb-item__v', text: '0' }), 'warnings');
  warnBtn.addEventListener('click', showWarnings);

  const lanesNote = h('span', { class: 'sb-item', title:
    'Lane A = speed / fan / temp / flow: a direct G-code edit, instant.\n' +
    'Lane B = anything geometric: needs a re-slice in ElegooSlicer (~2.2 s).' },
    h('span', { class: 'badge badge--a', text: 'Lane A' }),
    h('span', { class: 'badge badge--b', text: 'Lane B' }),
  );

  const statusbar = h('footer', { class: 'statusbar' },
    h('span', { class: 'sb-item' }, 'parse', sbParse, 'ms'),
    h('span', { class: 'sb-sep' }),
    h('span', { class: 'sb-item' }, sbMoves, 'moves'),
    h('span', { class: 'sb-item' }, sbLayers, 'layers'),
    warnBtn,
    sbBusyTxt,
    h('span', { class: 'sb-spacer' }),
    lanesNote,
    h('span', { class: 'sb-sep' }),
    h('span', { class: 'sb-item' }, sbConnDot, sbConnTxt),
  );

  const busyBar = h('div', { class: 'sb-busy', hidden: true });

  /* ======================================================================
     ASSEMBLE
     ====================================================================== */

  root.append(titlebar, rail, stage, side, statusbar);
  document.body.append(busyBar);

  // toasts sit over the canvas, never over Claude's prompt -- see styles.css
  const toaster = createToaster(viewport);
  const modal = createModalHost(document.body);

  /* ======================================================================
     FILE NAME: middle truncation
     The naming convention puts the meaningful part at the END
     (..._v4-ironed_57m.gcode), so the version suffix is never what gets cut.
     ====================================================================== */

  function splitName(name) {
    const s = String(name || '');
    const m = /_v\d+[^_]*_[^_]*$/.exec(s);       // "_v4-ironed_57m.gcode"
    if (m) return [s.slice(0, m.index), s.slice(m.index)];
    const dot = s.lastIndexOf('.');
    if (dot > 12) return [s.slice(0, dot - 8), s.slice(dot - 8)];
    return [s, ''];
  }

  function paintFileName() {
    const name = fileInfo && fileInfo.name ? fileInfo.name : null;
    if (!name) {
      fileNameEl.replaceChildren(h('span', { style: 'color:var(--fg-3)', text: 'Open a file…' }));
      jobBtn.title = 'Switch file  (Ctrl+O)';
      return;
    }
    jobBtn.title = (fileInfo.path || name) + '\n\nSwitch file  (Ctrl+O)';

    const cs = getComputedStyle(fileNameEl);
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const avail = fileNameEl.clientWidth || 260;
    const [head, tail] = splitName(name);

    let shownHead = head;
    if (measure(head + tail, font) > avail) {
      const ell = '…';
      let lo = 0, hi = head.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (measure(head.slice(0, mid) + ell + tail, font) <= avail) lo = mid; else hi = mid - 1;
      }
      shownHead = head.slice(0, lo) + ell;
    }
    fileNameEl.replaceChildren(
      h('em', { text: shownHead }),
      h('i', { text: tail }),
    );
  }
  // re-entrancy guard: painting changes the text, which could in principle
  // resize the span and re-trigger the observer
  let fitting = false;
  new ResizeObserver(() => {
    if (fitting) return;
    fitting = true;
    paintFileName();
    requestAnimationFrame(() => { fitting = false; });
  }).observe(fileNameEl);

  /* ======================================================================
     JOB MENU
     ====================================================================== */

  function closeMenu() {
    jobMenu.hidden = true;
    jobBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', menuKeys, true);
  }
  function outside(ev) { if (!jobMenu.contains(ev.target) && !jobBtn.contains(ev.target)) closeMenu(); }
  function menuKeys(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); closeMenu(); jobBtn.focus(); return; }
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    const items = [...jobMenu.querySelectorAll('.menu__item')];
    if (!items.length) return;
    ev.preventDefault();
    const idx = items.indexOf(document.activeElement);
    const next = ev.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
    items[next].focus();
  }

  function openMenu() {
    renderJobMenu();
    jobMenu.hidden = false;
    jobBtn.setAttribute('aria-expanded', 'true');
    const r = jobBtn.getBoundingClientRect();
    jobMenu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - jobMenu.offsetWidth)) + 'px';
    jobMenu.style.top = (r.bottom + 6) + 'px';
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', menuKeys, true);
    const first = jobMenu.querySelector('.menu__item');
    if (first) first.focus();
  }

  jobBtn.addEventListener('click', () => (jobMenu.hidden ? openMenu() : closeMenu()));

  /** jobs may be strings or objects; group by the directory part of the path */
  function renderJobMenu() {
    jobMenu.replaceChildren();
    if (!jobs.length) {
      jobMenu.append(h('div', { class: 'menu__empty', text: 'No G-code files found. Is the API server running?' }));
      return;
    }
    const groups = new Map();
    for (const raw of jobs) {
      const j = typeof raw === 'string' ? { path: raw } : { ...raw };
      j.path = j.path || j.file || j.name || '';
      j.name = j.name || j.file || j.path.split(/[\\/]/).pop();
      const parts = j.path.split(/[\\/]/);
      const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push(j);
    }
    for (const [dir, list] of groups) {
      jobMenu.append(h('div', { class: 'menu__group', text: dir || 'files' }));
      for (const j of list) {
        const cur = currentPath && j.path === currentPath;
        const meta = j.time || (j.meta && (j.meta.estimatedTimeText || (j.meta.estimatedTimeSec && formatDuration(j.meta.estimatedTimeSec)))) || '';
        const b = h('button', { class: 'menu__item', role: 'menuitem', 'aria-current': cur ? 'true' : 'false' },
          svg(I.tick, 11, 'menu__tick'),
          h('span', { class: 'menu__name', text: j.name, title: j.path }),
          meta ? h('span', { class: 'menu__meta', text: meta }) : null,
        );
        b.addEventListener('click', () => { closeMenu(); call('fileOpen', j.path); });
        jobMenu.append(b);
      }
    }
  }

  /* ======================================================================
     WARNINGS + SHORTCUTS SHEETS
     ====================================================================== */

  function showWarnings() {
    if (!warnings.length) return;
    modal.sheet({
      title: 'Parser warnings',
      width: 'sm',
      content: h('div', { style: 'padding:12px 16px' },
        h('ul', { class: 'warnlist' }, warnings.map((w) =>
          h('li', {}, svg(I.warn, 13), h('span', { text: String(w) })))),
      ),
    });
  }

  const SHORTCUTS = [
    ['View', [
      ['1 … 7', 'View mode: feature / speed / flow / fan / temp / width / height'],
      ['Z / X / V / C', 'Camera: isometric / top / bottom / front'],
      ['[', 'Hide / show the side bar'],
      ['F', 'Frame all'],
      ['T / R', 'Toggle travel / retraction moves'],
      ['B', 'Box select: the moves you can see'],
      ['G', 'Area select: everything inside, through the model'],
      ['L', 'Layer select: every move in a layer range'],
      ['Esc', 'Leave select mode, clear the selection, or close a dialog'],
    ]],
    ['Layers', [
      ['↑ / ↓', 'Move the top layer by one'],
      ['Shift ↑ / ↓', 'Move the top layer by ten'],
      ['Tab to the handle', 'Then arrows move that handle; Home / End jump to the ends'],
      ['A', 'Show all layers'],
      ['S', 'Show only the top layer'],
      ['Wheel over the bar', 'Scrub the top layer'],
    ]],
    ['Claude', [
      ['Ctrl + Enter', "Attach the selection to Claude's prompt"],
      ['/', 'Focus Claude'],
      ['Esc (in Claude)', 'Stop what Claude is doing'],
      ['Ctrl + C (in Claude)', 'Copy if text is selected, else clear the prompt'],
      ['Shift + Tab (in Claude)', 'Cycle normal / auto-accept / plan mode'],
    ]],
    ['File', [
      ['Ctrl + O', 'Switch file'],
      ['D', 'Diff against the previous version (again to leave)'],
      ['K', 'Check before printing: findings drawn on the model (again to clear)'],
      ['?', 'This sheet'],
    ]],
  ];

  function showShortcuts() {
    const grid = h('div', { class: 'keys' }, SHORTCUTS.map(([group, rows]) =>
      h('div', {},
        h('div', { class: 'keys__group', text: group }),
        rows.map(([k, d]) => h('div', { class: 'keys__row' },
          h('kbd', { text: k }), h('span', { text: d, title: d }))),
      )));
    modal.sheet({ title: 'Keyboard shortcuts', content: grid });
  }

  /* ======================================================================
     GLOBAL KEYS
     ====================================================================== */

  function typing(t) {
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.defaultPrevented) return;
    // The terminal owns every key while it has focus -- Ctrl+O, Ctrl+Enter and
    // Esc all mean something to Claude Code.
    if (ev.target && ev.target.closest && ev.target.closest('.term')) return;

    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'o' || ev.key === 'O')) {
      ev.preventDefault(); jobMenu.hidden ? openMenu() : closeMenu(); return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
      if (inspector.hasSelection()) { ev.preventDefault(); call('sendToClaude', inspector.buildNote()); }
      return;
    }
    if (typing(ev.target)) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

    const k = ev.key;

    if (k === '?' || (k === '/' && ev.shiftKey)) { ev.preventDefault(); showShortcuts(); return; }
    if (k === '/') { ev.preventDefault(); focusClaude(); return; }

    if (k >= '1' && k <= '7') {
      const id = modes.byIndex(+k - 1);
      if (id) { ev.preventDefault(); modes.set(id); viewMode = id; paintLegend(); call('viewModeChange', id); }
      return;
    }

    switch (k.toLowerCase()) {
      case 'z': ev.preventDefault(); call('cameraPreset', 'iso'); break;
      case 'x': ev.preventDefault(); call('cameraPreset', 'top'); break;
      case 'c': ev.preventDefault(); call('cameraPreset', 'front'); break;
      case 'v': ev.preventDefault(); call('cameraPreset', 'bottom'); break;
      case 'f': ev.preventDefault(); call('cameraPreset', 'fit'); break;
      case 'b': ev.preventDefault(); vptools.toggleSelectMode('box'); break;
      case 'g': ev.preventDefault(); vptools.toggleSelectMode('area'); break;
      case 'l': ev.preventDefault(); vptools.toggleSelectMode('layers'); break;
      case 'd': ev.preventDefault(); call('diff'); break;
      case 'k': ev.preventDefault(); call('check'); break;
      case 't': ev.preventDefault(); moves.toggleTravel(); break;
      case 'r': ev.preventDefault(); moves.toggleRetract(); break;
      case 'a': ev.preventDefault(); layerbar.showAll(); syncSelectLayers(); break;
      case 's': ev.preventDefault(); { const r = layerbar.getRange(); layerbar.setRange(r.hi, r.hi); syncSelectLayers(); call('layerRangeChange', r.hi, r.hi); } break;
      case '[': ev.preventDefault(); toggleRail(); break;
      case 'escape':
        if (modal.isOpen()) break;
        if (vptools.getSelectMode()) { ev.preventDefault(); vptools.setSelectMode(null); applySelectMode(null); break; }
        if (inspector.hasSelection()) { ev.preventDefault(); api.showSelection(null); call('clearSelection'); }
        break;
      default:
        if (k === 'ArrowUp' || k === 'ArrowDown') {
          ev.preventDefault();
          layerbar.step((k === 'ArrowUp' ? 1 : -1) * (ev.shiftKey ? 10 : 1), 'hi');
          syncSelectLayers();
        }
    }
  });

  /* ======================================================================
     PUBLIC API
     ====================================================================== */

  const api = {
    /* -- the canvas ------------------------------------------------------ */
    getCanvas: () => canvas,

    /* -- file ------------------------------------------------------------ */
    /**
     * @param {{name, path, meta, layers, warnings, parseMs, count}} f
     */
    setFile(f) {
      fileInfo = f || null;
      currentPath = f && f.path || null;
      const meta = (f && f.meta) || {};

      paintFileName();
      vpEmpty.hidden = !!f;

      sTime.v.textContent = meta.estimatedTimeText
        || (meta.estimatedTimeSec ? formatDuration(meta.estimatedTimeSec) : '—');
      sWeight.v.textContent = Number.isFinite(meta.filamentUsedG) ? meta.filamentUsedG.toFixed(2) + ' g' : '—';
      sLayers.v.textContent = meta.layerCount != null ? String(meta.layerCount)
        : (f && f.layers ? String(f.layers.length) : '—');
      sMoves.v.textContent = f && f.count != null ? f.count.toLocaleString('en-US') : '—';

      sbParse.textContent = f && f.parseMs != null ? String(Math.round(f.parseMs)) : '—';
      sbMoves.textContent = f && f.count != null ? f.count.toLocaleString('en-US') : '—';
      sbLayers.textContent = meta.layerCount != null ? String(meta.layerCount) : '—';

      warnings = (f && f.warnings) || [];
      warnBtn.hidden = !warnings.length;
      warnBtn.querySelector('.sb-item__v').textContent = String(warnings.length);
      warnBtn.lastChild.textContent = warnings.length === 1 ? 'warning' : 'warnings';
      warnBtn.title = warnings.join('\n');

      layerbar.setLayers((f && f.layers) || []);

      // The layer bar owns the range, and on load it excludes layer 0 (the
      // start-G-code stub). Announce that so the renderer draws what the bar
      // says it is drawing, instead of quietly including a layer the UI has
      // already marked as not-a-layer.
      syncSelectLayers();
      if (f && f.layers && f.layers.length) {
        const r = layerbar.getRange();
        call('layerRangeChange', r.lo, r.hi);
      }

      // CONTEXT.md safety rule 5: no M83 -> editing is off entirely
      const relE = f && f.relativeE;
      inspector.setEditable(relE !== false);
      if (relE === false) {
        toaster.show('This file does not use M83 relative extrusion — per-segment edits are disabled.', 'warn');
      }

      renderJobMenu();
    },

    setJobs(list, current) {
      jobs = Array.isArray(list) ? list : [];
      if (current !== undefined) currentPath = current;
      renderJobMenu();
    },

    /* -- selection / pick ------------------------------------------------ */
    showPickedSegment(info) { inspector.showPicked(info); },

    /**
     * Accepts either the summary object from CONTEXT.md or a whole selection
     * ({id, summary, ...}); the id is what an attachment refers to.
     */
    showSelection(summary) {
      if (!summary) {
        selectionId = null;
        inspector.showSelection(null);
        vptools.setSelectionCount(0);
        return;
      }
      const sum = summary.summary && typeof summary.summary === 'object' ? summary.summary : summary;
      vptools.setSelectionCount(sum.count || 1);
      selectionId = summary.id || sum.id || ('sel-' + Date.now());
      inspector.showSelection(sum);
    },

    getSelectionId: () => selectionId,

    /* -- view mode / legend ---------------------------------------------- */
    setViewMode(id) {
      if (!VIEW_MODES.some((m) => m.id === id)) return;
      viewMode = id;
      modes.set(id);
      paintLegend();
    },
    onViewModeChange(cb) { on.viewModeChange = cb; },
    setLegend(entries) { lastLegend = entries || []; paintLegend(); },

    /* -- layers ---------------------------------------------------------- */
    onLayerRangeChange(cb) { on.layerRangeChange = cb; },
    setLayerRange(lo, hi) { layerbar.setRange(lo, hi); syncSelectLayers(); },

    /* -- visibility ------------------------------------------------------ */
    onFeatureToggle(cb) { on.featureToggle = cb; },
    onTravelToggle(cb) { on.travelToggle = cb; },
    onRetractToggle(cb) { on.retractToggle = cb; },
    /** optional: per-feature move counts, shown next to each toggle */
    setFeatureCounts(counts) { features.setCounts(counts); },

    /* -- camera / selection tools ---------------------------------------- */
    onCameraPreset(cb) { on.cameraPreset = cb; },
    /** cb(mode) with mode 'box' | 'area' | 'layers' | null */
    onSelectModeChange(cb) { on.selectModeChange = cb; },
    /** "Select these layers": cb(lo, hi) */
    onSelectLayers(cb) { on.selectLayers = cb; },
    /** area options changed: cb({match, includeAux}) */
    onAreaOptions(cb) { on.areaOptions = cb; },
    getAreaOptions: () => vptools.getAreaOptions(),
    setSelectMode(m) {
      vptools.setSelectMode(m);
      viewport.classList.toggle('is-boxselect', m === 'box');
      viewport.classList.toggle('is-areaselect', m === 'area');
    },

    /* -- bridge ---------------------------------------------------------- */
    /** "Attach selection" (cb(noteFromAdjustments)) and "Attach move" (cb()) */
    onSendToClaude(cb) { on.sendToClaude = cb; },
    onAttachMove(cb) { on.attachMove = cb; },
    onFileOpen(cb) { on.fileOpen = cb; },
    onAddThumbnail(cb) { on.addThumbnail = cb; },
    /** optional: called when a Lane A apply or a Lane B re-slice is requested */
    onEditRequest(cb) { on.editRequest = cb; },
    /** optional: called when the user clears the selection from the UI */
    onClearSelection(cb) { on.clearSelection = cb; },

    focusClaude,

    /* -- the terminal ------------------------------------------------------ */
    /**
     * Start the live Claude terminal. Not done in createUI so the mock harness
     * never opens a socket. `url()` returns the ws:// URL with the token.
     */
    startTerminal(o) {
      if (terminal) return;
      terminal = createTerminal({ url: o.url, toast: (m, k) => toaster.show(m, k) });
      termSlot.replaceChildren(terminal.el);
      paneBits.replaceChildren(terminal.head);
      terminal.setVisible(true);
    },
    /** Type text into Claude's prompt without sending it, and show the terminal. */
    typeToClaude(text) {
      if (!terminal) return false;
      terminal.paste(text);
      return true;
    },

    /* -- diff / drafts ---------------------------------------------------- */
    /** Diff button, the bar's x, and D: cb() toggles the diff */
    onDiff(cb) { on.diff = cb; },
    /** Check button and K: cb() runs the print check and draws it (again to clear) */
    onCheck(cb) { on.check = cb; },
    /** light the Check button while its boxes are on the model */
    setChecking(on_) { checkBtn.setAttribute('aria-pressed', on_ ? 'true' : 'false'); },
    /** the base name in the bar was clicked: cb() should offer other files */
    onDiffPick(cb) { on.diffPick = cb; },
    onCompareMode(cb) { on.compareMode = cb; },
    /** the diff card's opacity sliders / hide-same: cb({oldOpacity, newOpacity, hideSame}) */
    onCompareLook(cb) { on.compareLook = cb; },
    /** put look values into the card without firing onCompareLook */
    setCompareLook(look) { compareBar.setLook(look); },
    /** the align switch in the diff card: cb() toggles lining the base up */
    onCompareAlign(cb) { on.compareAlign = cb; },
    onFinalize(cb) { on.finalize = cb; },
    /** info = {name, path, stats?, mode} or null */
    showCompare(info) {
      compareInfo = info ? { ...info } : null;
      compareBar.show(info);
      if (info && info.mode) compareBar.setMode(info.mode);
      paintLegend();
      requestAnimationFrame(placeTopLeft);
      diffBtn.setAttribute('aria-pressed', info ? 'true' : 'false');
    },
    setCompareBusy(text) { compareBar.setBusy(text); },
    /** Claude's pointer boxes: list = [{label, color}] or null */
    showPointers(list) { pointerList.show(list); },
    onPointersClear(cb) { on.pointersClear = cb; },
    onPointersFrame(cb) { on.pointersFrame = cb; },
    setDraft(isDraft) { finalizeBtn.hidden = !isDraft; },
    /**
     * Let the user pick a file. items = [{path, note?}], best first.
     * @returns {Promise<string|null>}
     */
    pickFile({ title, items }) {
      return new Promise((resolve) => {
        let chosen = null;
        const list = h('div', { class: 'pick' });
        for (const it of items) {
          const parts = it.path.split('/');
          const b = h('button', { class: 'menu__item pick__item', type: 'button', title: it.path },
            h('span', { class: 'menu__name', text: parts.pop() }),
            h('span', { class: 'menu__meta', text: it.note || parts.join('/') }));
          b.addEventListener('click', () => { chosen = it.path; modal.close(); });
          list.append(b);
        }
        modal.sheet({ title, content: list }).then(() => resolve(chosen));
      });
    },

    /* -- dialogs / feedback ----------------------------------------------- */
    confirmEdit(o) { return modal.confirmEdit(o || {}); },
    /** opts: {ttl?, action?: {label, onClick}} */
    toast(message, kind, opts) { return toaster.show(message, kind, opts); },

    setStatus(s = {}) {
      if (s.connected != null) {
        sbConnDot.dataset.state = s.connected ? 'on' : 'off';
        sbConnTxt.textContent = s.connected ? 'connected' : 'disconnected';
      }
      if (s.message != null) {
        sbConnTxt.textContent = String(s.message);
        sbConnTxt.title = String(s.message);
      }
    },

    setBusy(busy, label) {
      busyBar.hidden = !busy;
      sbBusyTxt.hidden = !busy;
      sbBusyTxt.textContent = busy ? (label || 'Working…') : '';
      root.setAttribute('aria-busy', busy ? 'true' : 'false');
    },

    /* -- escape hatches --------------------------------------------------- */
    showShortcuts,
    getViewMode: () => viewMode,
    getLayerRange: () => layerbar.getRange(),
    destroy() { ro.disconnect(); layerbar.destroy(); if (terminal) terminal.destroy(); jobMenu.remove(); busyBar.remove(); },
  };

  /* initial paint */
  api.setFile(null);
  api.setStatus({ connected: false });
  legend.set([], viewMode);

  return api;
}

/* ==========================================================================
   ==========================================================================

     M O C K   H A R N E S S   --   D E L E T E   T H I S   W H O L E   B L O C K

   Everything below this line exists only so the shell can be developed and
   judged without a renderer or a server. index.html calls mountMockHarness()
   when `?mock=1` is present, or when src/main.js cannot be imported.

   Nothing above this line references anything below it.

   ==========================================================================
   ========================================================================== */

/** Numbers taken from the demo job, so the layout is tested
 *  against realistic magnitudes rather than round ones. */
const MOCK = {
  name: 'EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v1-ironed_49m.gcode',
  path: 'phonecase-17pro/EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v1-ironed_49m.gcode',
  count: 92648,
  parseMs: 122,
  meta: {
    generator: 'ElegooSlicer 1.5.3.5',
    layerCount: 57,
    minZ: 0.28, maxZ: 11.55,
    filamentDiameter: 1.75, filamentDensity: 1.24,
    estimatedTimeText: '49m 15s', estimatedTimeSec: 2955,
    filamentUsedMm: 6285.4, filamentUsedCm3: 12.18, filamentUsedG: 15.10,
    bedTemp: 60, lineCount: 341207,
  },
  warnings: ['3 arc move(s) (G2/G3) were skipped'],
  relativeE: true,
};

function mockLayers() {
  const out = [];
  // layer 0 is the start-G-code stub: no Z, no extrusion, but it does cost
  // wall-clock time (heat-up), which is exactly the case the layer bar has to
  // handle without flattening the histogram
  out.push({ index: 0, z: 0, firstSeg: 0, lastSeg: 40, lineStart: 0, lineEnd: 120, time: 96, extrudeMm: 0, filamentMm: 0, maxFan: 0, temp: 225 });
  let seg = 41;
  for (let i = 1; i <= 57; i++) {
    const z = +(0.28 + (i - 1) * 0.2).toFixed(2);
    // layer 1 is the slow base + skirt; 2-4 ramp; 7 is the ironed top of the
    // base; 8+ are thin walls clamped by slow_down_layer_time
    let t = 15.2;
    if (i === 1) t = 689;
    else if (i === 2) t = 96;
    else if (i === 3) t = 61;
    else if (i <= 6) t = 44;
    else if (i === 7) t = 212;          // ironing
    else if (i < 14) t = 27 + Math.sin(i) * 3;
    else t = 15 + Math.sin(i * 0.7) * 1.4;
    const n = Math.round(400 + t * 22);
    out.push({
      index: i, z,
      firstSeg: seg, lastSeg: seg + n,
      lineStart: seg * 3, lineEnd: (seg + n) * 3,
      time: +t.toFixed(2),
      extrudeMm: +(t * 62).toFixed(1),
      filamentMm: +(t * 2.1).toFixed(2),
      maxFan: i < 13 ? 0 : 0.15,
      temp: 225,
    });
    seg += n;
  }
  return out;
}

const MOCK_SELECTION = {
  id: 'sel-1726488000000',
  summary: {
    count: 812,
    layers: [34, 41],
    zRange: [6.88, 8.28],
    features: {
      'Outer wall': { count: 341, lengthMm: 4182.6, timeSec: 41.8 },
      'Inner wall': { count: 288, lengthMm: 3140.2, timeSec: 17.4 },
      'Sparse infill': { count: 121, lengthMm: 2604.9, timeSec: 8.7 },
      'Internal solid infill': { count: 46, lengthMm: 681.3, timeSec: 4.5 },
      'Gap infill': { count: 16, lengthMm: 44.2, timeSec: 0.9 },
    },
    lengthMm: 10653.2,
    timeSec: 73.3,
    filamentMm: 321.7,
    speed: { min: 48.0, avg: 138.4, max: 180.0 },
    width: { min: 0.42, avg: 0.487, max: 0.52 },
    fan: { min: 0.0, avg: 0.13, max: 0.15 },
  },
};

const MOCK_PICK = {
  'Move': '#48,213',
  'Layer': '37',
  'Z': '7.48 mm',
  'Feature': 'Outer wall',
  'Line width': '0.500 mm',
  'Layer height': '0.200 mm',
  'Speed': '100.0 mm/s',
  'Flow': '9.63 mm³/s',
  'Fan': '15 %',
  'Nozzle': '225 °C',
  'E delta': '0.0412 mm',
  'Length': '1.71 mm',
  'Source line': '182,406',
};


const MOCK_FEATURE_COUNTS = {
  1: 26410, 2: 21884, 4: 9120, 5: 6603, 6: 1958, 7: 4412, 8: 13625, 11: 1841, 13: 3170,
};

const MOCK_JOBS = [
  { path: 'phonecase-17pro/EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v1-ironed_49m.gcode', time: '49m 15s' },
  { path: 'phonecase-16pro/EN4Max_0.4_Iphone16Pro_HexCover_HSPLA+_0.20_v4-ironed_57m.gcode', time: '57m 13s' },
  { path: 'phonecase-16pro/old/EN4Max_0.4_Iphone16Pro_HexCover_HSPLA+_0.20_v3-slowtop_50m.gcode', time: '50m 02s' },
  { path: 'phonecase-16pro/old/EN4Max_0.4_Iphone16Pro_HexCover_HSPLA+_0.20_v2-brim-slowbase_45m.gcode', time: '45m 11s' },
  { path: 'phonecase-16pro/old/EN4Max_0.4_Iphone16Pro_HexCover_HSPLA+_0.12_v1-honeycomb-nobrim_1h11m.gcode', time: '1h 11m' },
  { path: 'enclosure/v1 final/EN4Max_0.4_EnclosureBase_HSPLA+_0.20_g25_44m.gcode', time: '44m 50s' },
];

const MOCK_DIFF = `@@ -178204,6 +178204,6 @@
 ;LAYER:37
 ;Z:7.48
 ;TYPE:Outer wall
-M106 S38
+M106 S13
 G1 X142.881 Y88.412 E.04118
 G1 X143.902 Y89.044 E.03906
@@ -182390,5 +182390,5 @@
 ;TYPE:Outer wall
-M106 S38
+M106 S13
 G1 X151.220 Y104.883 E.05512
 G1 X152.004 Y105.617 E.03118`;

const MOCK_VALIDATION = {
  ok: true,
  checks: [
    { name: 'Z monotonic', ok: true, message: 'No Z decrease inside a layer.' },
    { name: 'E bounds', ok: true, message: 'All E deltas within 0–0.6 mm; retract/prime still balanced.' },
    { name: 'Bed envelope', ok: true, message: 'All moves inside 426 × 426 mm.' },
    { name: 'Temperature', ok: true, message: 'Nozzle stays at 225 °C, bed at 60 °C.' },
    { name: 'Relative E', ok: true, message: 'File uses M83, so per-segment edits are safe.' },
  ],
  warnings: [
    { name: 'Fan floor', message: 'Fan drops to 13 % on layers 37–41. Below fan_min_speed (15 %) for this profile — intentional here, but check the overhang at layer 41.' },
  ],
};

/**
 * Feed a `ui` with plausible data so the shell can be looked at standalone.
 * @param {ReturnType<createUI>} ui
 * @param {string|null} reason  shown as a toast when the fallback kicked in
 */
export function mountMockHarness(ui, reason) {
  const layers = mockLayers();

  ui.setJobs(MOCK_JOBS, MOCK.path);
  ui.setFile({ ...MOCK, layers });
  ui.setFeatureCounts(MOCK_FEATURE_COUNTS);
  ui.setStatus({ connected: true, message: 'mock · no server' });

  // legend for the initial (feature) mode, via the real colors.js helper
  import('../render/colors.js').then(({ legendFor }) => {
    const paint = (mode) => {
      const ranges = {
        speed: [12, 300, 'mm/s'], flow: [0.4, 19.6, 'mm3/s'], fan: [0, 100, '%'],
        temp: [215, 235, 'C'], width: [0.38, 0.62, 'mm'], height: [0.12, 0.28, 'mm'],
      };
      if (mode === 'feature') ui.setLegend(legendFor('feature'));
      else { const [a, b, u] = ranges[mode] || [0, 1, '']; ui.setLegend(legendFor(mode, a, b, u)); }
    };
    paint('feature');
    ui.onViewModeChange((id) => { paint(id); ui.toast('View mode: ' + id, 'info'); });
  });

  ui.showSelection(MOCK_SELECTION);
  ui.showPickedSegment(MOCK_PICK);


  /* wire every callback to something visible */
  ui.onLayerRangeChange(() => { /* quiet: fires on every drag frame */ });
  ui.onFeatureToggle((s) => ui.toast(`${s.size} of ${FEATURE_NAMES.length - 1} feature types visible`, 'info'));
  ui.onTravelToggle((v) => ui.toast('Travel moves ' + (v ? 'shown' : 'hidden'), 'info'));
  ui.onRetractToggle((v) => ui.toast('Retractions ' + (v ? 'shown' : 'hidden'), 'info'));
  ui.onCameraPreset((p) => ui.toast('Camera: ' + p, 'info'));
  ui.onSelectModeChange((m) => ui.toast(m ? `${m === 'area' ? 'Area' : 'Box'} select armed — drag in the viewport` : 'Select mode off', 'info'));
  ui.onAttachMove(() => ui.toast('Would type a reference to this move into Claude', 'info'));
  ui.onFileOpen((p) => { ui.toast('Would open ' + p.split('/').pop(), 'info'); });
  ui.onClearSelection(() => ui.toast('Selection cleared', 'info'));

  ui.onSendToClaude((note) => ui.toast('Would type a reference to this selection into Claude' + (note ? ' (' + note + ')' : ''), 'info'));

  ui.onEditRequest(async (req) => {
    if (req.lane === 'B') return;   // already toasted by the rail
    const ok = await ui.confirmEdit({
      title: req.changes.map((c) => c.text).join(', '),
      subtitle: MOCK.name + '  ·  812 moves',
      lane: 'A',
      diff: MOCK_DIFF,
      validation: MOCK_VALIDATION,
    });
    ui.toast(ok ? 'Would write a new version' : 'Cancelled — nothing was written', ok ? 'success' : 'info');
  });

  ui.toast(reason || 'Mock mode — plausible data, no renderer and no server.', reason ? 'warn' : 'info');

  // a visible reminder on the canvas that there is no renderer behind it
  const cv = ui.getCanvas();
  const draw = () => {
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.max(1, Math.round(r.width * dpr));
    cv.height = Math.max(1, Math.round(r.height * dpr));
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    const cs = getComputedStyle(document.documentElement);
    g.strokeStyle = cs.getPropertyValue('--line-2').trim() || '#222';
    g.lineWidth = 1;
    const step = 28;
    // a faint bed grid, just so the viewport is not an empty rectangle
    for (let x = (r.width % step) / 2; x < r.width; x += step) {
      g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, r.height); g.stroke();
    }
    for (let y = (r.height % step) / 2; y < r.height; y += step) {
      g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(r.width, y + 0.5); g.stroke();
    }
    g.fillStyle = cs.getPropertyValue('--fg-4').trim() || '#666';
    g.font = '12px ui-monospace, Consolas, monospace';
    g.textAlign = 'center';
    g.fillText('mock viewport — the renderer draws here', r.width / 2, r.height / 2);
  };
  cv.addEventListener('gcs:resize', draw);
  requestAnimationFrame(draw);
}
