/**
 * inspector.js -- the right-hand readout.
 *
 * Three states, in priority order:
 *   1. a region is selected   -> the selection summary (see CONTEXT.md)
 *   2. a single move is picked -> its per-segment fields
 *   3. neither                -> how to get to 1 or 2
 *
 * A pick and a selection can both exist at once (you can click a move inside a
 * box selection), so they are tabs rather than a single swapped view. The tab
 * bar only appears when there is something to switch between.
 *
 * The values shown for a pick are NOT formatted here: `showPicked(info)` takes
 * an object of already-formatted field/value pairs from main.js, which is what
 * keeps unit decisions in one place (the renderer knows what it picked; the UI
 * does not need to re-derive flow from E and time).
 */

import { FEATURE_NAMES, FEATURE_COLORS } from '../render/colors.js';
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
  copy:   ['M5.6 5.6V3.4a.8.8 0 0 1 .8-.8h6.2a.8.8 0 0 1 .8.8v6.2a.8.8 0 0 1-.8.8h-2.2', 'M3.4 5.6h6.2a.8.8 0 0 1 .8.8v6.2a.8.8 0 0 1-.8.8H3.4a.8.8 0 0 1-.8-.8V6.4a.8.8 0 0 1 .8-.8Z'],
  cursor: ['M3.2 2.6 7 13.4l1.9-4.5 4.5-1.9z'],
  box:    ['M2.6 5.2V3.6a1 1 0 0 1 1-1h1.6', 'M10.8 2.6h1.6a1 1 0 0 1 1 1v1.6', 'M13.4 10.8v1.6a1 1 0 0 1-1 1h-1.6', 'M5.2 13.4H3.6a1 1 0 0 1-1-1v-1.6'],
  send:   ['M14 2 7.4 8.6', 'M14 2 9.8 14 7.4 8.6 2 6.2z'],
  x:      ['M11.5 4.5 4.5 11.5', 'M4.5 4.5l7 7'],
  reset:  ['M2.8 8a5.2 5.2 0 1 0 1.6-3.7', 'M2.6 3v3h3'],
};

/* -- number formatting ----------------------------------------------------
   Only used for the selection summary, where we are handed raw numbers. */

function num(v, d = 1) {
  if (!Number.isFinite(v)) return '--';
  return v.toFixed(d);
}
function mm(v) {
  if (!Number.isFinite(v)) return '--';
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(2) + ' m';
  return v.toFixed(v < 10 ? 2 : 1) + ' mm';
}
function count(n) {
  if (!Number.isFinite(n)) return '--';
  return n.toLocaleString('en-US');
}

/** The parser stores fan as 0..1. A summary that already scaled it to 0..100
 *  would otherwise show "0.4 %". Detect and normalise once. */
function fanScale(stats) {
  if (!stats) return 1;
  const max = Math.max(stats.max ?? 0, stats.avg ?? 0, stats.min ?? 0);
  return max <= 1.0001 ? 100 : 1;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard API needs a secure context; the fallback covers plain http
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

/* -------------------------------------------------------------------------
   Lane A adjust controls

   Every control here is a DELTA, and every one of them is a Lane A edit:
   speed / flow / fan / temp are all just numbers already present in the
   G-code, so changing them is a text edit, not a re-slice.

   Flow is capped at +/-20 % in three independent places: the input's own
   min/max, a clamp in the change handler, and the end-stop marks drawn on the
   track. CONTEXT.md safety rule 4 says the UI must refuse, not warn -- so the
   slider physically cannot be dragged past the cap.
   ---------------------------------------------------------------------- */

const ADJUSTMENTS = [
  { key: 'speed', label: 'Speed',  min: -50,  max: 100, step: 5, unit: '%',  fmt: (v) => (v > 0 ? '+' : '') + v + ' %' },
  { key: 'flow',  label: 'Flow',   min: -20,  max: 20,  step: 1, unit: '%',  fmt: (v) => (v > 0 ? '+' : '') + v + ' %', cap: true },
  { key: 'fan',   label: 'Fan',    min: -100, max: 100, step: 5, unit: 'pp', fmt: (v) => (v > 0 ? '+' : '') + v + ' pp' },
  { key: 'temp',  label: 'Nozzle', min: -15,  max: 15,  step: 1, unit: 'C',  fmt: (v) => (v > 0 ? '+' : '') + v + ' °C' },
];

/**
 * @param {{
 *   onSend?: (note: string) => void,        attach the selection (note = any Lane A intent)
 *   onAttachMove?: () => void,              attach the picked move
 *   onEditRequest?: (req: object) => void,
 *   onClear?: () => void,
 * }} opts
 */
export function createInspector(opts = {}) {
  let picked = null;
  let selection = null;
  let tab = 'pick';          // 'pick' | 'selection'
  let editable = true;       // false when the file is not M83 relative-E

  /* -- header ------------------------------------------------------------ */
  const tabPick = h('button', { class: 'seg__btn', 'aria-selected': 'false', 'data-tab': 'pick' },
    svg(I.cursor, 11), 'Move');
  const tabSel = h('button', { class: 'seg__btn', 'aria-selected': 'false', 'data-tab': 'selection' },
    svg(I.box, 11), 'Selection');
  const tabs = h('div', { class: 'seg', role: 'tablist', hidden: true }, tabPick, tabSel);
  tabPick.addEventListener('click', () => setTab('pick'));
  tabSel.addEventListener('click', () => setTab('selection'));

  const clearBtn = h('button', {
    class: 'iconbtn iconbtn--sm', title: 'Clear selection (Esc)', 'aria-label': 'Clear selection', hidden: true,
  }, svg(I.x, 12));
  clearBtn.addEventListener('click', () => { if (opts.onClear) opts.onClear(); });

  const head = h('header', { class: 'insp-head' },
    h('h2', { class: 'panel__title', text: 'Inspector' }),
    h('span', { class: 'panel__spacer' }),
    tabs, clearBtn,
  );

  /* -- bodies ------------------------------------------------------------ */
  const empty = h('div', { class: 'insp-empty' },
    svg(['M2.6 5.2V3.6a1 1 0 0 1 1-1h1.6', 'M10.8 2.6h1.6a1 1 0 0 1 1 1v1.6',
         'M13.4 10.8v1.6a1 1 0 0 1-1 1h-1.6', 'M5.2 13.4H3.6a1 1 0 0 1-1-1v-1.6',
         'M6.4 6.4h3.2v3.2H6.4z'], 30, 'insp-empty__mark'),
    h('div', { class: 'insp-empty__t', text: 'Nothing selected' }),
    h('div', { class: 'insp-empty__s' },
      'Click a move to inspect it. To select, press ',
      h('kbd', { text: 'B' }), ' (what you see) or ',
      h('kbd', { text: 'G' }), ' (everything in the area) and drag in the viewport.'),
  );

  const pickBody = h('div', { hidden: true });
  const selBody = h('div', { hidden: true });

  const body = h('div', { class: 'insp-body' }, empty, pickBody, selBody);

  /* -- Lane A adjust ----------------------------------------------------- */
  const adjState = Object.create(null);
  const adjRows = new Map();
  const adjList = h('div', { class: 'adjust' });

  for (const a of ADJUSTMENTS) {
    adjState[a.key] = 0;
    const val = h('span', { class: 'adj__v is-zero', text: a.fmt(0) });
    const input = h('input', {
      class: 'range', type: 'range',
      min: String(a.min), max: String(a.max), step: String(a.step), value: '0',
      'aria-label': a.label + ' change',
    });
    input.addEventListener('input', () => {
      // clamp defensively: min/max on the element is the first line of defence,
      // this is the second. Flow must never leave +/-20.
      const v = Math.max(a.min, Math.min(a.max, Number(input.value) || 0));
      if (v !== Number(input.value)) input.value = String(v);
      adjState[a.key] = v;
      val.textContent = a.fmt(v);
      val.classList.toggle('is-zero', v === 0);
      syncEdit();
    });
    input.addEventListener('dblclick', () => { input.value = '0'; input.dispatchEvent(new Event('input')); });

    const wrap = h('div', { class: 'adj__wrap' }, input, a.cap ? h('span', { class: 'adj__cap' }) : null);
    const row = h('div', { class: 'adj', 'data-adj': a.key },
      h('span', { class: 'adj__k', text: a.label }), wrap, val);
    adjList.append(row);
    if (a.cap) {
      adjList.append(h('div', {
        class: 'adj__cap-note',
        text: 'hard cap ±20 % — beyond this the bead will not lay flat; re-slice instead',
      }));
    }
    adjRows.set(a.key, { input, val, def: a });
  }

  const adjReset = h('button', { class: 'link', text: 'reset' });
  adjReset.addEventListener('click', () => resetAdjust());

  const applyBtn = h('button', { class: 'btn btn--sm btn--block', disabled: true },
    svg(I.reset, 12), 'Apply to selection');
  applyBtn.addEventListener('click', () => {
    const changes = activeChanges();
    if (!changes.length || !selection) return;
    if (opts.onEditRequest) {
      opts.onEditRequest({
        lane: 'A',
        changes,
        selectionId: selection.id || null,
        summary: describeSelection(),
      });
    }
  });

  const adjSection = h('section', { class: 'isec', hidden: true },
    h('div', { class: 'isec__head' },
      'Adjust', h('span', { class: 'panel__spacer' }), adjReset,
      h('span', { class: 'badge badge--a', text: 'Lane A · instant' }),
    ),
    h('div', { class: 'isec__body' },
      adjList,
      h('div', { style: 'height:8px' }),
      applyBtn,
      h('div', { class: 'send-hint', style: 'margin-top:6px' },
        'Writes a new version, never in place. A diff and the validator run first.'),
    ),
  );

  function activeChanges() {
    return ADJUSTMENTS
      .filter((a) => adjState[a.key] !== 0)
      .map((a) => ({ key: a.key, delta: adjState[a.key], unit: a.unit, label: a.label, text: a.label + ' ' + a.fmt(adjState[a.key]) }));
  }
  function resetAdjust() {
    for (const [k, r] of adjRows) {
      adjState[k] = 0; r.input.value = '0';
      r.val.textContent = r.def.fmt(0); r.val.classList.add('is-zero');
    }
    syncEdit();
  }
  function syncEdit() {
    const n = activeChanges().length;
    applyBtn.disabled = !n || !selection || !editable;
    applyBtn.lastChild.textContent = n
      ? `Apply ${n} change${n > 1 ? 's' : ''} to selection`
      : 'Apply to selection';
    for (const r of adjRows.values()) r.input.disabled = !editable;
  }

  /* -- footer: attach ------------------------------------------------------
     Attaching does not send anything. It types a one-line reference into
     Claude's prompt; the message itself is written there, where the
     conversation is. */
  const sendBtn = h('button', { class: 'btn btn--primary', disabled: true },
    svg(I.send, 13), 'Attach selection to Claude');
  sendBtn.addEventListener('click', () => {
    if (opts.onSend) opts.onSend(buildNote());
  });

  const foot = h('footer', { class: 'insp-foot' },
    h('div', { class: 'send-row' }, sendBtn),
    h('div', { class: 'send-hint' },
      'Types a reference into Claude — write your message after it, then ',
      h('kbd', { text: '↵' }), ' · ', h('kbd', { text: 'Ctrl' }), h('kbd', { text: '↵' })),
  );

  // The adjust panel lives INSIDE the scroll area. Pinned above the footer it
  // permanently ate ~200px, which on a 13-field move readout meant the source
  // line number -- the whole point of the panel -- was always below the fold.
  body.append(adjSection);

  const el = h('div', { class: 'inspector' }, head, body, foot);

  /* -- note composition --------------------------------------------------
     If the user has dialled in Lane A changes, that intent travels with the
     attachment so Claude sees it, not just the region. One line: it is typed
     into Claude's prompt. */
  function buildNote() {
    const changes = activeChanges();
    if (!changes.length) return '';
    return 'dialled in (Lane A): ' + changes.map((c) => c.text).join(', ');
  }

  /* -- rendering: picked move -------------------------------------------- */

  function renderPicked(info) {
    if (!info) { pickBody.replaceChildren(); return; }
    const rows = h('div', { class: 'kv' });
    for (const [k, v] of Object.entries(info)) {
      if (v == null) continue;
      // the source line number is the field that makes editing possible, so it
      // gets the accent. Must not also match "Line width".
      const isLine = /(^|[\s_])line(\s*(number|no\.?|#))?$/i.test(String(k).trim());
      const row = h('div', { class: 'kv__row' + (isLine ? ' kv__row--hi' : '') },
        h('span', { class: 'kv__k', text: k, title: k }),
        h('span', { class: 'kv__v', text: String(v), title: String(v) }),
      );
      const btn = h('button', {
        class: 'kv__copy', title: `Copy ${k}`, 'aria-label': `Copy ${k}`,
      }, svg(I.copy, 10));
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const ok = await copyText(String(v));
        btn.replaceChildren(svg(ok ? ['M4 8.3 6.6 11l5.4-5.8'] : I.copy, 10));
        setTimeout(() => btn.replaceChildren(svg(I.copy, 10)), 1100);
      });
      row.append(btn);
      rows.append(row);
    }

    const all = Object.entries(info).map(([k, v]) => `${k}: ${v}`).join('\n');
    const copyAll = h('button', { class: 'link', text: 'copy all' });
    copyAll.addEventListener('click', () => copyText(all));
    const attachMove = h('button', { class: 'link', text: 'attach to Claude',
      title: "Type a reference to this move into Claude's prompt" });
    attachMove.addEventListener('click', () => { if (opts.onAttachMove) opts.onAttachMove(); });

    pickBody.replaceChildren(
      h('section', { class: 'isec' },
        h('div', { class: 'isec__head' },
          'Move', h('span', { class: 'panel__spacer' }), attachMove, copyAll),
        h('div', { class: 'isec__body' }, rows),
      ),
    );
  }

  /* -- rendering: selection summary -------------------------------------- */

  function renderSelection(sum) {
    if (!sum) { selBody.replaceChildren(); return; }

    const layers = sum.layers || [];
    const zr = sum.zRange || [];
    const hero = h('div', { class: 'isel-hero' },
      h('span', { class: 'isel-hero__n', text: count(sum.count) }),
      h('span', { class: 'isel-hero__l', text: sum.count === 1 ? 'move' : 'moves' }),
      h('span', { class: 'isel-hero__r' },
        h('div', { class: 'total__k', text: 'Layers' }),
        h('div', { class: 'total__v', text: layers.length ? layers[0] + ' – ' + layers[1] : '--' }),
      ),
    );

    const zRow = h('div', { class: 'isec__body' },
      h('div', { class: 'kv' },
        kvRow('Z range', zr.length ? `${num(zr[0], 2)} – ${num(zr[1], 2)} mm` : '--'),
        kvRow('Layer span', layers.length ? String(layers[1] - layers[0] + 1) : '--'),
      ),
    );

    /* feature breakdown */
    const feats = normaliseFeatures(sum.features);
    const maxN = feats.reduce((m, f) => Math.max(m, f.count || 0), 0) || 1;
    const fbreak = h('div', { class: 'fbreak' },
      h('div', { class: 'fbreak__head' },
        h('span'), h('span', { text: 'Feature' }),
        h('span', { text: 'Moves' }), h('span', { text: 'Length' }), h('span', { text: 'Time' })),
      feats.map((f) => h('div', { class: 'fbreak__row', title: f.name },
        h('span', {
          class: 'fbreak__bar',
          style: `width:${((f.count / maxN) * 100).toFixed(1)}%;background:${f.color}`,
        }),
        h('span', { class: 'swatch', style: `background:${f.color}` }),
        h('span', { class: 'fbreak__name', text: f.name }),
        h('span', { class: 'fbreak__n mono', text: count(f.count) }),
        h('span', { class: 'fbreak__len mono', text: f.lengthMm != null ? mm(f.lengthMm) : '—' }),
        h('span', { class: 'fbreak__t mono', text: f.timeSec != null ? formatDuration(f.timeSec) : '—' }),
      )),
    );

    /* totals */
    const totals = h('div', { class: 'totals' },
      total('Length', sum.lengthMm != null ? mm(sum.lengthMm) : '--'),
      total('Time', sum.timeSec != null ? formatDuration(sum.timeSec) : '--'),
      total('Filament', sum.filamentMm != null ? mm(sum.filamentMm) : '--'),
    );

    /* min / avg / max */
    const fs = fanScale(sum.fan);
    const mma = h('div', { class: 'mma' },
      h('div', { class: 'mma__head' },
        h('span'), h('span', { text: 'min' }), h('span', { text: 'avg' }), h('span', { text: 'max' })),
      mmaRow('Speed  mm/s', sum.speed, (v) => num(v, 0)),
      mmaRow('Width  mm', sum.width, (v) => num(v, 3)),
      mmaRow('Fan  %', sum.fan, (v) => num(v * fs, 0)),
    );

    selBody.replaceChildren(
      h('section', { class: 'isec' }, hero, zRow),
      h('section', { class: 'isec' },
        h('div', { class: 'isec__head' }, 'By feature'),
        h('div', { class: 'isec__body' }, fbreak),
      ),
      h('section', { class: 'isec' },
        h('div', { class: 'isec__head' }, 'Totals'),
        h('div', { class: 'isec__body' }, totals),
      ),
      h('section', { class: 'isec' },
        h('div', { class: 'isec__head' }, 'Distribution'),
        h('div', { class: 'isec__body' }, mma),
      ),
    );
  }

  function kvRow(k, v) {
    return h('div', { class: 'kv__row' },
      h('span', { class: 'kv__k', text: k }),
      h('span', { class: 'kv__v', text: v }));
  }
  function total(k, v) {
    return h('div', { class: 'total' },
      h('div', { class: 'total__k', text: k }),
      h('div', { class: 'total__v', text: v, title: v }));
  }
  function mmaRow(label, stats, fmt) {
    const s = stats || {};
    return h('div', { class: 'mma__row' },
      h('span', { class: 'mma__k', text: label }),
      h('span', { class: 'mma__v', text: s.min != null ? fmt(s.min) : '--' }),
      h('span', { class: 'mma__v mma__v--avg', text: s.avg != null ? fmt(s.avg) : '--' }),
      h('span', { class: 'mma__v', text: s.max != null ? fmt(s.max) : '--' }),
    );
  }

  /**
   * The contract shape is `features: { 'Outer wall': 812 }`. If a richer shape
   * ({count, lengthMm, timeSec}) shows up we use it, because the brief asks for
   * length and time per feature and the server may well start sending them.
   */
  function normaliseFeatures(features) {
    if (!features) return [];
    const out = [];
    for (const [name, v] of Object.entries(features)) {
      const idx = FEATURE_NAMES.indexOf(name);
      const row = typeof v === 'number'
        ? { count: v, lengthMm: null, timeSec: null }
        : { count: v.count ?? 0, lengthMm: v.lengthMm ?? v.length ?? null, timeSec: v.timeSec ?? v.time ?? null };
      out.push({ name, color: FEATURE_COLORS[idx >= 0 ? idx : 0], ...row });
    }
    return out.sort((a, b) => b.count - a.count);
  }

  /* -- state switching ---------------------------------------------------- */

  function setTab(t) {
    tab = t;
    tabPick.setAttribute('aria-selected', t === 'pick' ? 'true' : 'false');
    tabSel.setAttribute('aria-selected', t === 'selection' ? 'true' : 'false');
    pickBody.hidden = !(t === 'pick' && picked);
    selBody.hidden = !(t === 'selection' && selection);
    empty.hidden = !!(pickBody.hidden === false || selBody.hidden === false);
  }

  function sync() {
    const hasPick = !!picked;
    const hasSel = !!selection;

    tabs.hidden = !(hasPick && hasSel);
    tabPick.disabled = !hasPick;
    tabSel.disabled = !hasSel;
    clearBtn.hidden = !hasSel;

    if (hasSel && (!hasPick || tab === 'selection')) tab = 'selection';
    else if (hasPick) tab = 'pick';

    setTab(tab);

    adjSection.hidden = !hasSel;
    sendBtn.disabled = !hasSel;
    sendBtn.title = hasSel ? "Type a reference to this selection into Claude's prompt"
                           : 'Select a region first (B or G, then drag in the viewport)';
    syncEdit();
  }

  /** A one-line description used for the chat attachment chip. */
  function describeSelection() {
    if (!selection) return null;
    const bits = [];
    if (selection.count != null) bits.push(count(selection.count) + ' moves');
    if (selection.layers && selection.layers.length) bits.push('layers ' + selection.layers[0] + '–' + selection.layers[1]);
    const feats = normaliseFeatures(selection.features);
    if (feats.length) bits.push(feats[0].name + (feats.length > 1 ? ` +${feats.length - 1}` : ''));
    return bits.join(' · ');
  }

  return {
    el,

    showPicked(info) {
      picked = info || null;
      renderPicked(picked);
      if (picked) tab = 'pick';
      sync();
    },

    showSelection(summary) {
      selection = summary || null;
      renderSelection(selection);
      if (selection) tab = 'selection';
      else resetAdjust();
      sync();
    },

    /** CONTEXT.md safety rule 5: absolute-E files cannot be edited at all. */
    setEditable(v) { editable = !!v; syncEdit(); },

    hasSelection: () => !!selection,
    getSelection: () => selection,
    describeSelection,
    buildNote,
    resetAdjust,
  };
}
