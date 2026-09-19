/**
 * terminal.js -- real, interactive Claude Code inside the app.
 *
 * xterm.js draws it; the server runs `claude` in a PTY and streams it over
 * /api/term (see docs/CONTEXT-terminal.md for the wire format). One Claude per
 * server, shared by every window, so reloading the app keeps the conversation.
 *
 * xterm is imported lazily: it is ~300 KB the 3D view does not need to start.
 *
 * Keys, the way VS Code's terminal does them:
 *   Ctrl+C        copy when text is selected, otherwise ^C to Claude
 *   Ctrl+V        paste
 *   Esc           goes to Claude -- that is how you stop its current step
 * Every other key, including Ctrl+O and Shift+Tab, goes to Claude untouched.
 */

const NS = 'http://www.w3.org/2000/svg';

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

const I = {
  stop:  ['M4.5 4.5h7v7h-7z'],
  chev:  ['M4.5 6.5 8 10l3.5-3.5'],
  play:  ['M5 3.5v9l7-4.5z'],
  mode:  ['M2.5 5h8', 'M8.5 2.5 11 5 8.5 7.5', 'M13.5 11h-8', 'M7.5 8.5 5 11l2.5 2.5'],
  slash: ['M10.5 2.5 5.5 13.5'],
};

/**
 * Built-in commands worth one click. Deliberately short: typing `/` in the
 * terminal shows Claude Code's own list, which is always current and includes
 * skills -- a copy kept here would go stale.
 */
const COMMANDS = [
  ['/clear', 'Start a fresh conversation'],
  ['/compact', 'Summarise the conversation to free context'],
  ['/context', 'How full the context window is'],
  ['/model', 'Switch model'],
  ['/resume', 'Pick an earlier conversation'],
  ['/memory', 'Edit memory files'],
  ['/status', 'Account, model and settings'],
  ['/help', 'Everything Claude Code can do'],
];

/* Claude Code's colours assume a dark background, so the terminal stays dark
   in the light app theme too -- the same call VS Code users usually make. */
const XTERM_THEME = {
  background: '#0c0f13',
  foreground: '#e5eaf1',
  cursor: '#7893ff',
  cursorAccent: '#0c0f13',
  selectionBackground: 'rgba(91, 124, 250, 0.40)',
  black: '#161b21', brightBlack: '#545d69',
  red: '#f0555c', brightRed: '#ff7a80',
  green: '#3cba6d', brightGreen: '#5fd68a',
  yellow: '#e0a33c', brightYellow: '#f2bb62',
  blue: '#5b7cfa', brightBlue: '#7893ff',
  magenta: '#b77cf0', brightMagenta: '#cd9cff',
  cyan: '#4fb8c9', brightCyan: '#74d3e2',
  white: '#aab5c2', brightWhite: '#f2f5ff',
};

const ESC = '\x1b';
const SHIFT_TAB = '\x1b[Z';

/**
 * @param {{
 *   url: () => string,                          ws:// URL including the token
 *   toast?: (msg: string, kind?: string) => void,
 *   onState?: (state: object) => void,
 * }} opts
 */
export function createTerminal(opts = {}) {
  const toast = opts.toast || (() => {});

  let term = null;          // xterm instance, once loaded
  let fit = null;
  let ws = null;
  let wsOpen = false;
  let closed = false;
  let backoff = 500;
  let state = { running: false };
  let autoStarted = false;
  let lastOutAt = 0;
  let startedAt = 0;
  /** text waiting for Claude to be ready (attach while it was not running) */
  let pendingPaste = [];
  let visible = true;

  /* -- DOM ----------------------------------------------------------------- */

  const dot = h('span', { class: 'term-dot', 'data-state': 'off' });
  const stateTxt = h('span', { class: 'term-state__txt', text: 'connecting…' });
  const stateEl = h('span', { class: 'term-state', title: '' }, dot, stateTxt);

  const btn = (label, title, icon, onClick, cls = '') => {
    const b = h('button', { class: 'term-btn ' + cls, type: 'button', title, 'aria-label': title },
      icon ? svg(icon, 11) : null, label ? h('span', { text: label }) : null);
    b.addEventListener('click', (ev) => { ev.preventDefault(); onClick(ev); });
    return b;
  };

  const stopBtn = btn('Stop', 'Stop what Claude is doing (Esc)', I.stop, () => key(ESC), 'term-btn--stop');
  const ctrlCBtn = btn('^C', 'Send Ctrl+C: clears the prompt; twice in a row quits Claude', null, () => key('\x03'));
  const modeBtn = btn('Mode', 'Cycle mode: normal → auto-accept edits → plan (Shift+Tab)', I.mode, () => key(SHIFT_TAB));
  const cmdBtn = btn('Commands', 'Slash commands', I.slash, (ev) => openMenu(ev.currentTarget, commandItems()));
  cmdBtn.append(svg(I.chev, 10));
  const sessBtn = btn('Session', 'Start, resume or stop Claude', null, (ev) => openMenu(ev.currentTarget, sessionItems()));
  sessBtn.append(svg(I.chev, 10));

  const tools = h('div', { class: 'term-tools' }, stopBtn, ctrlCBtn, modeBtn, cmdBtn, sessBtn);

  const host = h('div', { class: 'term-host' });

  const offTitle = h('div', { class: 'term-off__t', text: 'Claude is not running' });
  const offSub = h('div', { class: 'term-off__s', text: '' });
  const startBtn = btn('Start Claude', 'Start a new Claude session', I.play, () => start('new', false), 'btn btn--primary btn--sm');
  const resumeBtn = btn('Resume last', 'claude --continue: pick up the most recent conversation', null, () => start('continue', false), 'btn btn--sm');
  const off = h('div', { class: 'term-off', hidden: true },
    offTitle, offSub, h('div', { class: 'term-off__row' }, startBtn, resumeBtn));

  const body = h('div', { class: 'term-body' }, host, off);
  const el = h('div', { class: 'term' }, body);

  /* -- menu ---------------------------------------------------------------- */

  const menu = h('div', { class: 'menu term-menu', role: 'menu', hidden: true });
  document.body.append(menu);

  function commandItems() {
    return [
      ...COMMANDS.map(([cmd, what]) => ({ label: cmd, meta: what, run: () => command(cmd) })),
      { sep: true },
      { label: '/ …', meta: 'Type / to see every command', run: () => { focus(); send('/'); } },
    ];
  }
  function sessionItems() {
    return [
      { label: 'New session', meta: 'Restart Claude, fresh conversation', run: () => start('new', true) },
      { label: 'Resume last', meta: 'Restart with claude --continue', run: () => start('continue', true) },
      { sep: true },
      { label: 'Quit Claude', meta: 'Stop the process', run: () => msg({ t: 'stop' }), danger: true },
    ];
  }

  function openMenu(anchor, items) {
    menu.replaceChildren(...items.map((it) => {
      if (it.sep) return h('div', { class: 'menu__sep' });
      const b = h('button', { class: 'menu__item' + (it.danger ? ' menu__item--danger' : ''), role: 'menuitem', type: 'button' },
        h('span', { class: 'menu__name mono', text: it.label }),
        it.meta ? h('span', { class: 'menu__meta', text: it.meta }) : null);
      b.addEventListener('click', () => { closeMenu(); it.run(); });
      return b;
    }));
    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth, hgt = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - 8 - w)) + 'px';
    // open upwards when there is no room below -- the terminal sits low
    const below = r.bottom + 4;
    menu.style.top = (below + hgt > window.innerHeight - 8 ? Math.max(8, r.top - 4 - hgt) : below) + 'px';
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    document.addEventListener('keydown', menuKeys, true);
    const first = menu.querySelector('.menu__item');
    if (first) first.focus();
  }
  function closeMenu() {
    menu.hidden = true;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', menuKeys, true);
  }
  function outside(ev) { if (!menu.contains(ev.target)) closeMenu(); }
  function menuKeys(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeMenu(); focus(); return; }
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    const items = [...menu.querySelectorAll('.menu__item')];
    ev.preventDefault();
    const i = items.indexOf(document.activeElement);
    items[(i + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  }

  /* -- xterm --------------------------------------------------------------- */

  const ready = (async () => {
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/xterm/css/xterm.css'),
    ]);
    term = new Terminal({
      theme: XTERM_THEME,
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", ui-monospace, monospace',
      fontSize: 12.5,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      macOptionIsMeta: true,
      // Claude Code's full-screen UI redraws a lot; a smooth-scroll animation
      // just makes it look laggy.
      smoothScrollDuration: 0,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      const ctrl = ev.ctrlKey || ev.metaKey;
      const k = ev.key.toLowerCase();
      if (ctrl && k === 'c' && (ev.shiftKey || term.hasSelection())) {
        copySelection();
        ev.preventDefault();
        return false;
      }
      // Let the browser paste into xterm's textarea; xterm then wraps it in
      // bracketed-paste markers so multi-line text is not sent line by line.
      if (ctrl && k === 'v') return false;
      // F5 reloads the app, not a key for the terminal (Ctrl+R stays Claude's history search)
      if (ev.key === 'F5') return false;
      return true;
    });
    term.onData((d) => send(d));
    // right-click: copy if something is selected, paste otherwise (as Windows Terminal does)
    host.addEventListener('contextmenu', async (ev) => {
      ev.preventDefault();
      if (term.hasSelection()) { copySelection(); return; }
      try { const t = await navigator.clipboard.readText(); if (t) term.paste(t); } catch { /* denied */ }
    });

    const ro = new ResizeObserver(() => refit());
    ro.observe(host);
    refit();
    return term;
  })().catch((err) => {
    host.replaceChildren(h('div', { class: 'term-fail', text: 'Terminal failed to load: ' + err.message }));
    throw err;
  });

  async function copySelection() {
    const text = term.getSelection();
    if (!text) return;
    try { await navigator.clipboard.writeText(text); toast('Copied', 'info'); } catch { /* denied */ }
    term.clearSelection();
  }

  let fitTimer = 0;
  function refit() {
    if (!term || !fit || !visible) return;
    const r = host.getBoundingClientRect();
    if (r.width < 40 || r.height < 30) return; // collapsed or hidden: keep the last size
    try { fit.fit(); } catch { return; }
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => msg({ t: 'resize', cols: term.cols, rows: term.rows }), 60);
  }

  /* -- socket -------------------------------------------------------------- */

  function connect() {
    if (closed) return;
    let sock;
    try { sock = new WebSocket(opts.url()); } catch (err) { paintState('offline: ' + err.message); retry(); return; }
    ws = sock;
    paintState();

    sock.onopen = () => {
      wsOpen = true;
      backoff = 500;
      if (term) msg({ t: 'resize', cols: term.cols, rows: term.rows });
    };
    sock.onmessage = async (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      await ready.catch(() => null);
      onMessage(m);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      wsOpen = false;
      ws = null;
      state = { ...state, connected: false };
      paintState();
      retry();
    };
    sock.onerror = () => { /* onclose follows */ };
  }

  function retry() {
    if (closed) return;
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 8000);
  }

  function onMessage(m) {
    switch (m.t) {
      case 'hello':
        setState(m);
        if (term) term.reset();
        // The client, not the server, decides to start Claude -- once per page
        // load, so quitting it on purpose and then reloading is still a choice.
        if (!m.running && !autoStarted) { autoStarted = true; start('new', false); }
        break;
      case 'out':
        if (term && m.d) term.write(m.d);
        lastOutAt = Date.now();
        schedulePasteFlush();
        break;
      case 'reset':
        if (term) term.reset();
        break;
      case 'state':
        setState(m);
        if (m.running) { startedAt = Date.now(); schedulePasteFlush(); }
        else if (m.exitCode != null) toast('Claude exited (code ' + m.exitCode + ')', 'info');
        break;
      case 'error':
        toast('Terminal: ' + m.message, 'error');
        offSub.textContent = m.message;
        break;
      default:
    }
  }

  function setState(s) {
    const { t, ...rest } = s;
    state = { ...state, ...rest, connected: true };
    paintState();
    if (opts.onState) opts.onState(state);
  }

  function paintState(extra) {
    const connected = wsOpen && state.connected !== false;
    const running = connected && !!state.running;
    dot.dataset.state = !connected ? 'off' : running ? 'on' : 'idle';
    let txt;
    if (extra) txt = extra;
    else if (!connected) txt = 'connecting…';
    else if (running) txt = (state.mode === 'continue' ? 'resumed' : 'running') + (state.pid ? ' · pid ' + state.pid : '');
    else txt = 'stopped';
    stateTxt.textContent = txt;
    stateEl.title = state.cmd ? `${state.cmd}\nin ${state.cwd || ''}` : '';
    off.hidden = !connected || running;
    for (const b of [stopBtn, ctrlCBtn, modeBtn, cmdBtn]) b.disabled = !running;
    sessBtn.disabled = !connected;
  }

  function msg(obj) {
    if (ws && wsOpen) {
      try { ws.send(JSON.stringify(obj)); return true; } catch { /* closing */ }
    }
    return false;
  }

  function send(d) { if (d) msg({ t: 'in', d }); }
  function key(seq) { send(seq); focus(); }

  function command(cmd) {
    focus();
    send(cmd);
    // give Claude's autocomplete a moment to settle on the exact match
    setTimeout(() => send('\r'), 120);
  }

  function start(mode, restart) {
    if (term) term.reset();
    if (!msg({ t: restart ? 'restart' : 'start', mode })) toast('Terminal is not connected yet', 'warn');
    focus();
  }

  /* -- paste queue ----------------------------------------------------------
     An attach while Claude is still starting would land in its splash screen
     and vanish. Wait until it has been running a moment and gone quiet. */

  let flushTimer = 0;
  function schedulePasteFlush() {
    if (!pendingPaste.length) return;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushPaste, 700);
  }
  function flushPaste() {
    if (!pendingPaste.length || !term) return;
    const readyNow = state.running && Date.now() - startedAt > 1500 && Date.now() - lastOutAt > 500;
    if (!readyNow) { schedulePasteFlush(); return; }
    const text = pendingPaste.join(' ');
    pendingPaste = [];
    term.paste(text);
    focus();
  }

  /* -- public -------------------------------------------------------------- */

  function focus() { if (term) term.focus(); }

  /**
   * Type text into Claude's prompt WITHOUT pressing Enter. Used by attach: the
   * user writes the actual message after it.
   */
  async function paste(text) {
    await ready;
    if (!state.running) {
      pendingPaste.push(text);
      if (wsOpen && !state.running) start('new', false);
      toast('Starting Claude — the reference will be typed in when it is ready', 'info');
      return;
    }
    term.paste(text);
    focus();
  }

  connect();

  return {
    el,
    head: h('div', { class: 'term-headbits' }, stateEl, tools),
    paste,
    focus,
    send,
    isRunning: () => !!state.running,
    setVisible(v) {
      visible = !!v;
      if (visible) requestAnimationFrame(refit);
    },
    refit,
    destroy() {
      closed = true;
      closeMenu();
      menu.remove();
      if (ws) try { ws.close(); } catch { /* ignore */ }
      if (term) term.dispose();
    },
  };
}
