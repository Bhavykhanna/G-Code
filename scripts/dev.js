/**
 * dev.js -- one command that brings the whole app up.
 *
 * Starts the API server and the Vite dev server, waits for both to answer, then
 * opens a chromeless Edge window so it behaves like a desktop app rather than a
 * browser tab (the same feel as run_tag_aligner.bat next door).
 *
 *   node scripts/dev.js            start everything and open the window
 *   node scripts/dev.js --built    build, serve dist\ from the API server (no hot reload)
 *   node scripts/dev.js --no-open  start servers only
 *   node scripts/dev.js --force    restart even if a server is already running
 *
 * **Closing the app window does not stop the server**, and that is on purpose:
 * Claude lives in a PTY inside it, so killing the server would end the session
 * the user was in the middle of. Running this again therefore does NOT restart
 * by default -- if a healthy server is already answering it just opens a new
 * window onto it (user, 2026-09-19: the X left a server behind and the launcher
 * then appeared to do nothing). `--force`, or stop-gcode-studio.bat, is the way
 * to get a clean restart; server code changes need one.
 *
 * When it does start, it first closes the previous window and frees the ports,
 * so a restart always ends with exactly one window on the fresh code.
 */

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, openSync, writeSync, statSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI_PORT = 5173;
const API_PORT = 5174;
const UI_URL = 'http://localhost:' + UI_PORT;
/** The app window's private browser profile (see openWindow). */
const APP_PROFILE = join(root, '.app-profile');

const children = [];
let shuttingDown = false;

function run(name, cmd, args, colour, useShell = false) {
  // `shell: true` concatenates argv without quoting, so any path containing a
  // space (node itself lives in "C:\Program Files\nodejs") gets split. Only npx
  // needs a shell on Windows; node is spawned directly.
  const child = spawn(cmd, args, {
    cwd: root,
    shell: useShell,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = '\x1b[' + colour + 'm[' + name + ']\x1b[0m ';
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) if (l.trim()) out.write(tag + l + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(tag + 'exited with code ' + code);
    shutdown(code ?? 1);
  });

  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try { c.kill(); } catch { /* already gone */ }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/** Poll a URL until it answers, or give up. */
async function waitFor(url, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.status < 500) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.error('timed out waiting for ' + label + ' at ' + url);
  return false;
}

/**
 * Open the app in a real window. Edge and Chrome both support --app=, which
 * gives a frame with no tabs, address bar or bookmarks. Falls back to the
 * default browser if neither is installed.
 */
function openWindow(url) {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const exe = candidates.find((p) => existsSync(p));
  if (exe) {
    // Own profile = own browser process. Without it the window joins whatever
    // Edge is already running, and closing "the app" on restart could take the
    // user's other tabs with it.
    spawn(exe, [
      '--app=' + url, '--window-size=1600,1000',
      '--user-data-dir=' + APP_PROFILE, '--no-first-run', '--no-default-browser-check',
    ], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    console.log('opened app window via ' + exe.split('\\').pop());
  } else {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    console.log('opened ' + url + ' in the default browser');
  }
}

/**
 * A restart must leave exactly one app window and no stale server. Close any
 * earlier G-code Studio window and stop whatever still holds our ports --
 * otherwise the new server fails with EADDRINUSE and the old window keeps
 * showing the old build.
 *
 * Windows are recognised ONLY by the app's private profile directory in their
 * command line, so the user's own browser windows are never touched.
 */
function clearPrevious() {
  if (process.platform !== 'win32') return;
  const script = join(root, 'scripts', 'close-previous.ps1');
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Profile', APP_PROFILE, '-Ports', UI_PORT + ',' + API_PORT, '-Keep', String(process.pid),
  ], { stdio: 'ignore', timeout: 30000, windowsHide: true });
  if (r.error) console.warn('could not clear the previous instance: ' + r.error.message);
  else console.log('closed any previous G-code Studio window and server');
}

const BUILT = process.argv.includes('--built');
const FORCE = process.argv.includes('--force');
const url = BUILT ? 'http://localhost:' + API_PORT + '/' : UI_URL;

/**
 * Is a server of ours already answering? The page itself, not `/api/*`, because
 * every API route needs the per-start token and a launcher has no business
 * reading it.
 */
async function alreadyRunning() {
  try {
    const res = await fetch('http://127.0.0.1:' + API_PORT + '/', { signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Mirror everything this process prints into .server.log, instead of letting
 * the launcher redirect the whole command there.
 *
 * Why: `cmd /c ... > .server.log` takes an exclusive handle, so while an older
 * hidden instance was alive the NEXT launch failed on the redirect before node
 * ever ran -- the user double-clicked the .bat and nothing happened at all.
 * Node's own file handles share, so two instances can write here safely.
 */
function teeToLog(append) {
  const file = join(root, '.server.log');
  let fd;
  try {
    // Appending forever would grow without a bound, so a log past a megabyte
    // starts again. A real start always starts again.
    let big = false;
    try { big = statSync(file).size > 1024 * 1024; } catch { /* not there yet */ }
    fd = openSync(file, append && !big ? 'a' : 'w');
  } catch {
    // EBUSY here means an instance started by the OLD launcher is still alive
    // and holding the log through `cmd > .server.log`. Nothing to do but skip
    // the log; it comes back on the next clean start.
    return;
  }
  for (const s of [process.stdout, process.stderr]) {
    const write = s.write.bind(s);
    s.write = (chunk, ...rest) => {
      // Written synchronously on purpose: the reuse path prints four lines and
      // exits immediately, and a stream's buffer is thrown away by process.exit
      // -- the log came out empty exactly when it was most wanted.
      try { writeSync(fd, typeof chunk === 'string' ? chunk : Buffer.from(chunk)); } catch { /* the log is a convenience, never a blocker */ }
      return write(chunk, ...rest);
    };
  }
}

const running = await alreadyRunning();

// A reuse appends, so the running server's own log is not wiped from under it;
// a real start truncates, unless the log has grown past a megabyte.
teeToLog(running && !FORCE);

if (running && !FORCE) {
  console.log('\nG-code Studio -- a server is already answering on ' + API_PORT + '.');
  console.log('opening a window onto it; the server and the Claude session inside it keep running.');
  console.log('(run-gcode-studio.bat --force, or stop-gcode-studio.bat, for a clean restart --');
  console.log(' server code changes need one.)');
  if (!process.argv.includes('--no-open')) openWindow(url);
  process.exit(0);
}

console.log('G-code Studio -- starting' + (BUILT ? ' (built mode, no hot reload)' : ''));
clearPrevious();

const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');

if (BUILT) {
  // Build first; the API server decides at startup whether dist\ exists.
  console.log('building...');
  const b = spawnSync(process.execPath, [viteBin, 'build', '--logLevel', 'error'], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
  if (b.status !== 0) {
    console.error('build failed');
    process.exit(1);
  }
}

run('api', process.execPath, ['server/index.js'], '36');
if (!BUILT) {
  // Run vite through its own JS entry point rather than the npx shim, so this
  // needs no shell and no PATH lookup.
  if (existsSync(viteBin)) {
    run('ui', process.execPath, [viteBin, '--port', String(UI_PORT), '--strictPort'], '35');
  } else {
    run('ui', 'npx', ['vite', '--port', String(UI_PORT), '--strictPort'], '35', true);
  }
}

const apiUp = await waitFor('http://127.0.0.1:' + API_PORT + '/api/jobs', 'api server');
const uiUp = BUILT ? apiUp : await waitFor(UI_URL, 'vite');

if (apiUp && uiUp) {
  console.log('ready -> ' + url);
  if (!process.argv.includes('--no-open')) openWindow(url);
} else {
  shutdown(1);
}
