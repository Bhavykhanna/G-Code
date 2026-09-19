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
 *
 * Every start first closes the previous G-code Studio window and server, so a
 * restart always ends with exactly one window on the fresh code.
 */

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

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

const url = BUILT ? 'http://localhost:' + API_PORT + '/' : UI_URL;
const apiUp = await waitFor('http://127.0.0.1:' + API_PORT + '/api/jobs', 'api server');
const uiUp = BUILT ? apiUp : await waitFor(UI_URL, 'vite');

if (apiUp && uiUp) {
  console.log('ready -> ' + url);
  if (!process.argv.includes('--no-open')) openWindow(url);
} else {
  shutdown(1);
}
