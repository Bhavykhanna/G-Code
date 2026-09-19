/**
 * toast.js -- transient notifications.
 *
 * Deliberately small. A toast is for something that already happened and that
 * the user does not have to act on. Anything that needs a decision is a modal
 * (see diffmodal.js); anything persistent belongs in the status bar.
 *
 * Errors do not auto-dismiss, because "the write failed" scrolling away after
 * three seconds is how you end up printing the wrong file.
 */

const NS = 'http://www.w3.org/2000/svg';

/** Minimal element builder. Duplicated per module on purpose: the ui/ modules
 *  have no shared runtime, so any one of them can be lifted out on its own. */
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

/** Icons are inline SVG -- no icon package, and they inherit currentColor. */
function svg(paths, size = 13) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.5');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  for (const d of [].concat(paths)) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}

const ICONS = {
  info:    ['M8 1.6a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 0 0 8 1.6Z', 'M8 7.2v3.6', 'M8 5.1h.01'],
  success: ['M8 1.6a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 0 0 8 1.6Z', 'M5.4 8.2 7.2 10l3.4-3.6'],
  warn:    ['M7.1 2.5 1.7 12a1 1 0 0 0 .9 1.5h10.8a1 1 0 0 0 .9-1.5L8.9 2.5a1 1 0 0 0-1.8 0Z', 'M8 6.3v2.9', 'M8 11.3h.01'],
  error:   ['M8 1.6a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 0 0 8 1.6Z', 'M10 6 6 10', 'M6 6l4 4'],
  x:       ['M11.5 4.5 4.5 11.5', 'M4.5 4.5l7 7'],
};

/** How long each kind stays up. `null` = until dismissed. */
const TTL = { info: 3600, success: 3200, warn: 7000, error: null };

/**
 * @param {HTMLElement} host  element the toast stack is appended to
 * @returns {{el: HTMLElement, show: Function, clear: Function}}
 */
export function createToaster(host) {
  const el = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  (host || document.body).append(el);

  const live = new Set();

  function dismiss(node) {
    if (!live.has(node)) return;
    live.delete(node);
    node.classList.add('is-leaving');
    node.addEventListener('animationend', () => node.remove(), { once: true });
    // belt and braces: prefers-reduced-motion collapses the animation to ~1ms,
    // but if animationend never fires the node must still go away.
    setTimeout(() => node.remove(), 400);
  }

  /**
   * @param {string} message
   * @param {'info'|'success'|'warn'|'error'} [kind]
   * @param {{ttl?: number|null, action?: {label: string, onClick: Function}}} [opts]
   */
  function show(message, kind = 'info', opts = {}) {
    if (!ICONS[kind]) kind = 'info';
    const node = h('div', { class: 'toast toast--' + kind });
    const ico = svg(ICONS[kind], 14);
    ico.classList.add('toast__icon');

    const msg = h('div', { class: 'toast__msg' });
    msg.textContent = String(message == null ? '' : message);

    node.append(ico, msg);

    if (opts.action && opts.action.label) {
      node.append(h('button', {
        class: 'btn btn--sm btn--ghost',
        onclick: () => { try { opts.action.onClick(); } finally { dismiss(node); } },
      }, opts.action.label));
    }

    const close = h('button', { class: 'iconbtn iconbtn--sm toast__x', 'aria-label': 'Dismiss' },
      svg(ICONS.x, 12));
    close.addEventListener('click', () => dismiss(node));
    node.append(close);

    // newest at the bottom of the visual stack (column-reverse in CSS)
    el.append(node);
    live.add(node);

    // cap the stack so a runaway loop cannot cover the app
    while (el.children.length > 5) dismiss(el.firstElementChild);

    const ttl = opts.ttl !== undefined ? opts.ttl : TTL[kind];
    if (ttl != null) {
      let timer = setTimeout(() => dismiss(node), ttl);
      node.addEventListener('pointerenter', () => clearTimeout(timer));
      node.addEventListener('pointerleave', () => { timer = setTimeout(() => dismiss(node), 1200); });
    }
    return { dismiss: () => dismiss(node) };
  }

  function clear() { for (const n of [...live]) dismiss(n); }

  return { el, show, clear };
}
