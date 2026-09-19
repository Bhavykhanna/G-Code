/**
 * diffmodal.js -- edit confirmation.
 *
 * CONTEXT.md safety rule 3: every edit shows a diff and requires explicit
 * confirmation before it is written. This module is that gate, and it is
 * deliberately hard to get past by accident:
 *
 *   - Confirm is DISABLED while the validator reports any error. There is no
 *     "apply anyway".
 *   - Enter does not confirm. Esc cancels. The confirm button must be clicked
 *     or tabbed to and activated.
 *   - Cancel is the default focus.
 *   - The promise resolves `false` on every path except an explicit confirm,
 *     including the scrim, the close button, Esc and an unexpected teardown.
 *
 * It is tolerant about the shapes it is handed, because the server's exact
 * validator output is not frozen yet:
 *
 *   diff:       a unified-diff string | [{line, before, after}] | {before, after}
 *   validation: {ok, errors[], warnings[], checks[]} | [{level, message}] | true
 */

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
  s.setAttribute('stroke-width', '1.5');
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
  ok:   ['M8 1.6a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 0 0 8 1.6Z', 'M5.4 8.2 7.2 10l3.4-3.6'],
  warn: ['M7.1 2.5 1.7 12a1 1 0 0 0 .9 1.5h10.8a1 1 0 0 0 .9-1.5L8.9 2.5a1 1 0 0 0-1.8 0Z', 'M8 6.3v2.9', 'M8 11.3h.01'],
  err:  ['M8 1.6a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 0 0 8 1.6Z', 'M10 6 6 10', 'M6 6l4 4'],
  x:    ['M11.5 4.5 4.5 11.5', 'M4.5 4.5l7 7'],
};

/* -------------------------------------------------------------------------
   Normalisers
   ---------------------------------------------------------------------- */

/** @returns {Array<{type:'add'|'del'|'ctx'|'hunk', ln:string, text:string}>} */
function normaliseDiff(diff) {
  if (!diff) return [];

  if (typeof diff === 'string') {
    const rows = [];
    let oldN = 0, newN = 0;
    for (const raw of diff.split(/\r?\n/)) {
      if (/^(---|\+\+\+|diff |index )/.test(raw)) continue;
      const hunk = /^@@\s*-(\d+)(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@/.exec(raw);
      if (hunk) {
        oldN = +hunk[1]; newN = +hunk[2];
        rows.push({ type: 'hunk', ln: '', text: raw });
        continue;
      }
      if (raw.startsWith('+')) rows.push({ type: 'add', ln: String(newN++), text: raw.slice(1) });
      else if (raw.startsWith('-')) rows.push({ type: 'del', ln: String(oldN++), text: raw.slice(1) });
      else rows.push({ type: 'ctx', ln: String(newN++), text: raw.replace(/^ /, '') }), oldN++;
    }
    return rows;
  }

  if (Array.isArray(diff)) {
    const rows = [];
    for (const d of diff) {
      if (typeof d === 'string') { rows.push({ type: 'ctx', ln: '', text: d }); continue; }
      const ln = d.line != null ? String(d.line) : '';
      if (d.before != null && d.before !== d.after) rows.push({ type: 'del', ln, text: String(d.before) });
      if (d.after != null && d.before !== d.after) rows.push({ type: 'add', ln, text: String(d.after) });
      if (d.before != null && d.before === d.after) rows.push({ type: 'ctx', ln, text: String(d.before) });
    }
    return rows;
  }

  if (typeof diff === 'object' && (diff.before != null || diff.after != null)) {
    const rows = [];
    for (const l of String(diff.before || '').split(/\r?\n/)) rows.push({ type: 'del', ln: '', text: l });
    for (const l of String(diff.after || '').split(/\r?\n/)) rows.push({ type: 'add', ln: '', text: l });
    return rows;
  }

  return [];
}

/** @returns {{ok: boolean, rows: Array<{level:'ok'|'warn'|'err', name:string, message:string}>}} */
function normaliseValidation(v) {
  const rows = [];
  if (v == null) return { ok: true, rows };

  if (v === true) return { ok: true, rows: [{ level: 'ok', name: 'Validator', message: 'All checks passed.' }] };
  if (v === false) return { ok: false, rows: [{ level: 'err', name: 'Validator', message: 'Validation failed.' }] };

  const push = (level, item) => {
    if (item == null) return;
    if (typeof item === 'string') rows.push({ level, name: '', message: item });
    else rows.push({
      level: item.level ? mapLevel(item.level) : level,
      name: item.name || item.check || item.rule || '',
      message: item.message || item.msg || item.detail || String(item),
    });
  };

  if (Array.isArray(v)) {
    for (const item of v) push(mapLevel(item && item.level) || 'warn', item);
  } else {
    for (const e of v.errors || []) push('err', e);
    for (const w of v.warnings || []) push('warn', w);
    for (const c of v.checks || []) {
      const lvl = c.ok === false ? 'err' : c.level ? mapLevel(c.level) : 'ok';
      push(lvl, c);
    }
    if (!rows.length && v.message) push(v.ok === false ? 'err' : 'ok', v.message);
  }

  const hasErr = rows.some((r) => r.level === 'err');
  const ok = v && typeof v === 'object' && !Array.isArray(v) && v.ok != null ? !!v.ok && !hasErr : !hasErr;
  if (!rows.length) rows.push({ level: ok ? 'ok' : 'err', name: 'Validator', message: ok ? 'All checks passed.' : 'Validation failed.' });
  return { ok, rows };
}

function mapLevel(l) {
  if (!l) return null;
  const s = String(l).toLowerCase();
  if (s.startsWith('err') || s === 'fatal') return 'err';
  if (s.startsWith('warn')) return 'warn';
  if (s === 'ok' || s === 'pass' || s === 'info') return 'ok';
  return null;
}

/* -------------------------------------------------------------------------
   The modal
   ---------------------------------------------------------------------- */

/**
 * @param {HTMLElement} host  where the modal root is mounted
 */
export function createModalHost(host) {
  const root = h('div', { class: 'modal-root' });
  (host || document.body).append(root);

  let closer = null;   // teardown for whatever modal is open

  function close(result) {
    if (closer) closer(result);
  }

  /** Mount an arbitrary modal. Returns a promise resolved by `close()`. */
  function open({ node, onClose, initialFocus }) {
    close(false); // only ever one modal

    const prevFocus = document.activeElement;
    const scrim = h('div', { class: 'modal-scrim' });
    root.replaceChildren(scrim, node);
    root.classList.add('is-open');

    let resolve;
    const p = new Promise((r) => { resolve = r; });

    function keydown(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(false); return; }
      if (ev.key !== 'Tab') return;
      // focus trap
      const f = [...node.querySelectorAll(
        'button:not([disabled]),[href],input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])')]
        .filter((e) => e.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    }

    document.addEventListener('keydown', keydown, true);
    scrim.addEventListener('pointerdown', () => close(false));

    closer = (result) => {
      closer = null;
      document.removeEventListener('keydown', keydown, true);
      root.classList.remove('is-open');
      root.replaceChildren();
      if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch { /* gone */ } }
      if (onClose) onClose(result);
      resolve(result);
    };

    // focus after paint so the rise animation does not fight the scroll-into-view
    requestAnimationFrame(() => { if (initialFocus && initialFocus.isConnected) initialFocus.focus(); });

    return p;
  }

  /**
   * The edit confirmation gate.
   * @param {{title?: string, subtitle?: string, diff?: any, validation?: any,
   *          confirmLabel?: string, lane?: 'A'|'B'}} o
   * @returns {Promise<boolean>} true ONLY on explicit confirm
   */
  function confirmEdit(o = {}) {
    const { ok, rows } = normaliseValidation(o.validation);
    const diffRows = normaliseDiff(o.diff);
    const adds = diffRows.filter((r) => r.type === 'add').length;
    const dels = diffRows.filter((r) => r.type === 'del').length;
    const errs = rows.filter((r) => r.level === 'err').length;
    const warns = rows.filter((r) => r.level === 'warn').length;

    const confirm = h('button', {
      class: 'btn btn--primary', disabled: !ok,
      title: ok ? '' : 'Blocked: the validator reported an error. There is no override.',
    }, o.confirmLabel || 'Write new version');

    const cancel = h('button', { class: 'btn' }, 'Cancel');

    const closeX = h('button', { class: 'iconbtn modal__x', 'aria-label': 'Close' }, svg(I.x, 13));

    const diffEl = h('div', { class: 'diff', role: 'group', 'aria-label': 'Diff' });
    if (!diffRows.length) {
      diffEl.append(h('div', { class: 'diff__empty', text: 'No textual change to show.' }));
    } else {
      // cap what we build: a 92k-move file can produce a very large diff and
      // 200k DOM rows will hang the window
      const CAP = 4000;
      for (const r of diffRows.slice(0, CAP)) {
        diffEl.append(h('div', { class: 'diff__row diff__row--' + r.type },
          h('span', { class: 'diff__ln', text: r.ln }),
          h('span', { class: 'diff__sign', text: r.type === 'add' ? '+' : r.type === 'del' ? '−' : r.type === 'hunk' ? '@' : ' ' }),
          h('span', { class: 'diff__txt', text: r.text }),
        ));
      }
      if (diffRows.length > CAP) {
        diffEl.append(h('div', { class: 'diff__empty', text: `… ${diffRows.length - CAP} more lines not shown` }));
      }
    }

    const laneBadge = o.lane === 'B'
      ? h('span', { class: 'badge badge--b', text: 'Lane B · re-slice' })
      : h('span', { class: 'badge badge--a', text: 'Lane A · G-code edit' });

    const node = h('div', {
      class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title || 'Confirm edit',
    },
      h('header', { class: 'modal__head' },
        h('div', {},
          h('div', { class: 'modal__title', text: o.title || 'Confirm edit' }),
          o.subtitle ? h('div', { class: 'modal__sub', text: o.subtitle }) : null,
        ),
        h('span', { class: 'panel__spacer' }),
        laneBadge,
        closeX,
      ),
      h('div', { class: 'modal__body' },
        h('div', { class: 'vsummary' },
          ok
            ? h('span', { class: 'badge badge--ok', text: 'Validated' })
            : h('span', { class: 'badge badge--err', text: errs + ' error' + (errs === 1 ? '' : 's') }),
          warns ? h('span', { class: 'badge badge--warn', text: warns + ' warning' + (warns === 1 ? '' : 's') }) : null,
          h('span', { class: 'panel__spacer' }),
          h('span', { class: 'diff-stats' },
            h('span', { class: 'diff-stats__add', text: '+' + adds }),
            h('span', { class: 'diff-stats__del', text: '−' + dels }),
          ),
        ),
        h('div', { class: 'vlist' }, rows.map((r) =>
          h('div', { class: 'vrow vrow--' + (r.level === 'err' ? 'err' : r.level === 'warn' ? 'warn' : 'ok') },
            svg(r.level === 'err' ? I.err : r.level === 'warn' ? I.warn : I.ok, 13, 'vrow__icon'),
            r.name ? h('span', { class: 'vrow__name', text: r.name }) : null,
            h('span', { class: 'vrow__msg', text: r.message }),
          ))),
        diffEl,
      ),
      h('footer', { class: 'modal__foot' },
        h('span', { class: 'modal__foot-note' },
          ok
            ? 'The current file moves to old\\ and a new version is written. Nothing is overwritten.'
            : 'Blocked by the validator. Fix the input or re-slice — there is no override.'),
        h('span', { class: 'modal__foot-spacer' }),
        cancel, confirm,
      ),
    );

    const p = open({ node, initialFocus: cancel });
    cancel.addEventListener('click', () => close(false));
    closeX.addEventListener('click', () => close(false));
    confirm.addEventListener('click', () => { if (!confirm.disabled) close(true); });

    return p.then((v) => v === true);
  }

  /** A plain informational / keyboard-shortcut sheet. */
  function sheet({ title, content, width }) {
    const closeX = h('button', { class: 'iconbtn modal__x', 'aria-label': 'Close' }, svg(I.x, 13));
    const done = h('button', { class: 'btn' }, 'Close');
    const node = h('div', {
      class: 'modal' + (width === 'sm' ? ' modal--sm' : ''),
      role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Info',
    },
      h('header', { class: 'modal__head' },
        h('div', { class: 'modal__title', text: title || '' }),
        h('span', { class: 'panel__spacer' }), closeX),
      h('div', { class: 'modal__body' }, content),
      h('footer', { class: 'modal__foot' }, h('span', { class: 'modal__foot-spacer' }), done),
    );
    const p = open({ node, initialFocus: done });
    done.addEventListener('click', () => close(false));
    closeX.addEventListener('click', () => close(false));
    return p;
  }

  return {
    el: root,
    confirmEdit,
    sheet,
    close: () => close(false),
    isOpen: () => !!closer,
  };
}
