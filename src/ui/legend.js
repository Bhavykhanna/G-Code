/**
 * legend.js -- the colour key for the active view mode.
 *
 * This module never invents a colour. Everything it draws is handed to it by
 * `legendFor()` in src/render/colors.js, which is also what the renderer
 * samples, so the legend and the pixels on the canvas cannot drift apart.
 *
 * Two shapes, chosen by `entries.layout` from legendFor():
 *   - 'list' -> swatch rows: the features in the file, the few values a
 *     numeric mode really uses (with their share of the plastic), or the diff key
 *   - 'ramp' -> a gradient bar with ticks at real values, for values that are
 *     spread out (e.g. volumetric flow)
 * `entries.note` adds a footnote; collapsed, the legend is a small title pill.
 */

import { VIEW_MODES, formatShare } from '../render/colors.js';

const NS = 'http://www.w3.org/2000/svg';
const STORE_KEY = 'gcs.legend.collapsed';

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

function chevron(size = 11) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.6'); s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', 'M4 6.5 8 10.5l4-4');
  s.append(p);
  return s;
}

function readStore() {
  try { return localStorage.getItem(STORE_KEY) === '1'; } catch { return false; }
}
function writeStore(v) {
  try { localStorage.setItem(STORE_KEY, v ? '1' : '0'); } catch { /* private mode */ }
}

/**
 * @returns {{el: HTMLElement, set: (entries: Array<{name:string,color:string}>, mode?: string) => void}}
 */
export function createLegend() {
  const title = h('span', { class: 'legend__title', text: 'Feature type' });
  const chev = chevron();
  const toggle = h('button', {
    class: 'iconbtn iconbtn--sm legend__toggle',
    'aria-label': 'Collapse legend',
    title: 'Collapse legend',
  }, chev);

  const list = h('div', { class: 'legend__list' });
  const ramp = h('div', { class: 'legend__ramp', hidden: true });
  const bar = h('div', { class: 'legend__bar' });
  const ticks = h('div', { class: 'legend__ticks' });
  ramp.append(bar, ticks);
  const note = h('div', { class: 'legend__note', hidden: true });

  const el = h('div', { class: 'legend', hidden: true },
    h('div', { class: 'legend__head' }, title, toggle),
    list, ramp, note,
  );

  function setCollapsed(v) {
    el.dataset.collapsed = v ? '1' : '0';
    chev.style.transform = v ? 'rotate(-90deg)' : '';
    toggle.setAttribute('aria-label', v ? 'Expand legend' : 'Collapse legend');
    toggle.title = toggle.getAttribute('aria-label');
    writeStore(v);
  }
  setCollapsed(readStore());
  toggle.addEventListener('click', () => setCollapsed(el.dataset.collapsed !== '1'));

  /**
   * @param {Array<{name:string,color:string}>} entries  straight from legendFor()
   * @param {string} [mode]  the active VIEW_MODES id, so we know which shape to draw
   */
  function set(entries, mode = 'feature', titleText) {
    const def = VIEW_MODES.find((m) => m.id === mode);
    title.textContent = titleText || (def ? def.label : mode);

    if (!entries || !entries.length) { el.hidden = true; return; }
    el.hidden = false;

    note.textContent = entries.note || '';
    note.hidden = !entries.note;
    const layout = entries.layout || (mode === 'feature' ? 'list' : 'ramp');
    if (layout === 'list') {
      ramp.hidden = true;
      list.hidden = false;
      list.replaceChildren(...entries.map((e) =>
        h('div', { class: 'legend__item', title: e.title || null },
          h('span', { class: 'swatch', style: `background:${e.color}` }),
          h('span', { class: mode === 'feature' || mode === 'diff' ? 'legend__name' : 'legend__name mono', text: e.name }),
          e.meta ? h('span', { class: 'legend__share mono', text: e.meta })
            : e.share != null ? h('span', { class: 'legend__share mono', text: formatShare(e.share), title: 'share of the plastic' }) : null,
        )));
    } else {
      list.hidden = true;
      ramp.hidden = false;
      // entries[0] is the minimum; the bar runs bottom (min) -> top (max)
      const stops = entries.map((e) => e.color).join(',');
      bar.style.background = `linear-gradient(to top, ${stops})`;
      ticks.replaceChildren(...entries.slice().reverse().map((e) =>
        h('span', { text: e.name })));
    }
  }

  return { el, set, setCollapsed };
}
