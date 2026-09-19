/**
 * compare.js (ui) -- the small card shown over the viewport while a diff is on.
 *
 *   DIFF VS <base name>                x
 *   [ Changes | Overlay ]   comparing...
 *   Old ----o--- 55 %   New --------o 100 %   [ ] hide same
 *
 * The look row (2026-09-17, user: "we need diff settings ... opacity for the old
 * and new"): per mode. New below 100 % makes the new file see-through, so the old
 * one shows through it (a thinner floor, a wall inside a wall). "hide same"
 * (Changes only) hides this file's unchanged moves.
 *
 * Changes: added moves green, removed red, the rest dimmed.
 * Overlay: the file in its normal colours, the base as a faint ghost.
 * The added / removed totals live in the colour key (layout.js), next to the
 * colours they describe. Deliberately just this -- the diff is meant to be
 * seen on the model.
 */

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
  return e;
}

export const fmtMm = (mm) => (mm >= 1000 ? (mm / 1000).toFixed(1) + ' m' : Math.round(mm) + ' mm');

/**
 * @param {{onMode?: (m:'changes'|'both')=>void, onClose?: ()=>void, onPick?: ()=>void, onAlign?: ()=>void,
 *          onLook?: (look:{oldOpacity:number,newOpacity:number,hideSame:boolean})=>void}} opts
 */
export function createCompareBar(opts = {}) {
  const name = h('button', { class: 'cmp__name mono', type: 'button', title: 'Compare with a different file' });
  name.addEventListener('click', () => opts.onPick && opts.onPick());

  const modes = new Map();
  const seg = h('div', { class: 'seg cmp__seg' });
  for (const [id, label, title] of [
    ['changes', 'Changes', 'Green: only in this file · red: only in the base · grey: the same'],
    ['both', 'Overlay', 'This file in its colours, the base as a faint ghost'],
  ]) {
    const b = h('button', { class: 'seg__btn', type: 'button', 'aria-pressed': 'false', title }, label);
    b.addEventListener('click', () => { setMode(id); if (opts.onMode) opts.onMode(id); });
    modes.set(id, b);
    seg.append(b);
  }
  const busy = h('span', { class: 'cmp__busy', hidden: true });

  const close = h('button', { class: 'iconbtn iconbtn--sm', type: 'button', title: 'Leave diff (D)', 'aria-label': 'Leave diff' }, '✕');
  close.addEventListener('click', () => opts.onClose && opts.onClose());

  // the base is drawn moved by the align notes (Finalize centres parts)
  const alignTxt = h('span', { class: 'cmp__align mono' });
  const alignBtn = h('button', { class: 'link', type: 'button' });
  alignBtn.addEventListener('click', () => opts.onAlign && opts.onAlign());
  const alignRow = h('div', { class: 'cmp__row cmp__row--align', hidden: true }, alignTxt, alignBtn);

  // opacity of the base (old) and this file (new), and hide-unchanged
  const slider = (label, title) => {
    const input = h('input', { class: 'range cmp__range', type: 'range', min: '0', max: '100', step: '5', title, 'aria-label': label + ' opacity' });
    const val = h('span', { class: 'cmp__val mono' });
    const wrap = h('label', { class: 'cmp__look', title }, h('span', { class: 'cmp__lk', text: label }), input, val);
    return { input, val, wrap };
  };
  const oldS = slider('Old', 'How solid the base (old file) is drawn');
  const newS = slider('New', 'How solid this file is drawn. Below 100 % the old file shows through it');
  const same = h('input', { type: 'checkbox' });
  const sameWrap = h('label', { class: 'cmp__same', title: 'Hide the moves that are the same in both files (Changes)' }, same, h('span', { text: 'hide same' }));
  const lookNow = () => ({
    oldOpacity: Number(oldS.input.value) / 100,
    newOpacity: Number(newS.input.value) / 100,
    hideSame: same.checked,
  });
  const paintVals = () => {
    oldS.val.textContent = oldS.input.value + '%';
    newS.val.textContent = newS.input.value + '%';
  };
  for (const inp of [oldS.input, newS.input]) {
    inp.addEventListener('input', () => { paintVals(); if (opts.onLook) opts.onLook(lookNow()); });
  }
  same.addEventListener('change', () => { if (opts.onLook) opts.onLook(lookNow()); });
  const lookRow = h('div', { class: 'cmp__row cmp__row--look' }, oldS.wrap, newS.wrap);
  const sameRow = h('div', { class: 'cmp__row cmp__row--same' }, sameWrap);

  const el = h('div', { class: 'cmp', hidden: true },
    h('div', { class: 'cmp__row' }, h('span', { class: 'cmp__k', text: 'Diff vs' }), name, close),
    h('div', { class: 'cmp__row' }, seg, busy),
    lookRow,
    sameRow,
    alignRow);

  function setMode(m) {
    for (const [id, b] of modes) b.setAttribute('aria-pressed', id === m ? 'true' : 'false');
    sameRow.hidden = m !== 'changes';
  }

  return {
    el,
    setMode,
    /** look = {oldOpacity, newOpacity, hideSame} (0..1) for the mode on screen; fires nothing */
    setLook(look) {
      if (!look) return;
      oldS.input.value = String(Math.round(look.oldOpacity * 100));
      newS.input.value = String(Math.round(look.newOpacity * 100));
      same.checked = !!look.hideSame;
      paintVals();
    },
    /** info = {name, path, align?: {dx, dy, on}} or null to hide */
    show(info) {
      el.hidden = !info;
      if (!info) return;
      const a = info.align;
      alignRow.hidden = !a || (!a.dx && !a.dy);
      if (a) {
        const mm = (v) => (v > 0 ? '+' : '') + v;
        const shift = [a.dx ? mm(a.dx) + ' mm X' : '', a.dy ? mm(a.dy) + ' mm Y' : ''].filter(Boolean).join(', ');
        alignTxt.textContent = a.on ? `base lined up ${shift}` : 'bed positions (not lined up)';
        alignTxt.title = a.on
          ? ['The finals were centred on Finalize; the base is drawn moved so unchanged parts overlap.', ...(a.steps || [])].join('\n')
          : 'Where the printer really puts each file';
        alignBtn.textContent = a.on ? 'off' : 'line up';
      }
      name.textContent = info.name;
      name.title = info.path + '\n\nClick to compare with a different file';
    },
    setBusy(text) {
      busy.hidden = !text;
      busy.textContent = text || '';
    },
  };
}

/**
 * The key for Claude's pointer boxes: one coloured row per box, and a clear
 * button. Shown under the diff bar while Claude is pointing at something.
 * @param {{onClear?: ()=>void, onFrame?: ()=>void}} opts
 */
export function createPointerList(opts = {}) {
  const rows = h('div', { class: 'ptr__rows' });
  const frame = h('button', { class: 'link', type: 'button', text: 'zoom to', title: 'Frame the boxes' });
  frame.addEventListener('click', () => opts.onFrame && opts.onFrame());
  const clear = h('button', { class: 'iconbtn iconbtn--sm', type: 'button', title: 'Clear Claude\u2019s boxes', 'aria-label': 'Clear' }, '✕');
  clear.addEventListener('click', () => opts.onClear && opts.onClear());
  const el = h('div', { class: 'ptr', hidden: true },
    h('div', { class: 'ptr__head' }, h('span', { class: 'ptr__title', text: 'Claude is pointing at' }), frame, clear),
    rows);
  return {
    el,
    /** list = [{label, color}] or null */
    show(list) {
      el.hidden = !list || !list.length;
      rows.replaceChildren(...(list || []).map((r, i) => h('div', { class: 'ptr__row' },
        h('i', { class: 'cmp__sw', style: `background:${r.color}` }),
        h('span', { class: 'ptr__n mono', text: String(i + 1) }),
        h('span', { class: 'ptr__label', text: r.label, title: r.label }))));
    },
  };
}
