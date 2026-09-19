#!/usr/bin/env node
/**
 * app-cli.js -- tell the open G-code Studio window what to show.
 *
 *   node gcode-studio/server/app-cli.js open <file> [--diff [<base>]]
 *   node gcode-studio/server/app-cli.js base <file>
 *   node gcode-studio/server/app-cli.js finalize <draft> "<what changed>"
 *   node gcode-studio/server/app-cli.js show <file> --x A:B [--y A:B] [--z A:B] [--layers A:B] --label "..."
 *                                            [--move DX[,DY]] [--to A:B] [--to-y A:B]   [--x ... ]
 *   node gcode-studio/server/app-cli.js show --clear
 *   node gcode-studio/server/app-cli.js reload
 *
 *   open      open <file> in the app. --diff alone compares it with the final
 *             it came from; --diff <base> compares with that file.
 *   reload    refresh the app window (after a rebuild; Claude keeps running).
 *   base      print the file <file> would be compared with.
 *   finalize  ..._v3-draft.gcode -> ..._v3-<what changed>_<time>.gcode, and
 *             move the older finals into old\.
 *   show      draw coloured, labelled boxes on the model so the user SEES the
 *             area you mean. Coordinates are bed / G-code mm (what the app
 *             shows), not model mm. Every --x starts a new box; --y/--z/--layers/
 *             --label apply to the box before them. Missing --y or --z = the whole
 *             part in that direction. The moves inside each box are painted in
 *             the box's colour (white, gold, pink, ...), never the user's cyan
 *             selection; everything else turns grey, and the view goes top-down.
 *             Show the PLANNED change with --move (the box shifts by DX mm, e.g.
 *             --move -2.2) or --to / --to-y (its new range, e.g. a gap growing):
 *             a dashed outline at the new place, arrows, and a sliding preview.
 *             Opens <file> first if it is not open. `show --clear` removes them.
 *
 * Paths may be absolute or relative to the Archive folder. Needs the app's
 * server running (it reads the token from gcode-studio\.gcs-token).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const ARCHIVE = path.resolve(PROJECT, '..');
const API = process.env.GCS_API || 'http://127.0.0.1:5174';

function token() {
  if (process.env.GCS_TOKEN) return process.env.GCS_TOKEN;
  try { return readFileSync(path.join(PROJECT, '.gcs-token'), 'utf8').trim(); } catch { return ''; }
}

/** The server wants Archive-relative paths with forward slashes. */
function rel(p) {
  const abs = path.resolve(ARCHIVE, p);
  return path.relative(ARCHIVE, abs).split(path.sep).join('/');
}

async function call(method, route, body) {
  let res;
  try {
    res = await fetch(API + route, {
      method,
      headers: { 'X-GCS-Token': token(), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    console.error('G-code Studio is not running (' + API + '). Start it with gcode-studio\\run-gcode-studio.bat');
    process.exit(2);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`error ${res.status}: ${data.error || res.statusText}`);
    process.exit(1);
  }
  return data;
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'open' && args[0]) {
  const i = args.indexOf('--diff');
  let diff;
  if (i >= 0) diff = args[i + 1] && !args[i + 1].startsWith('--') ? rel(args[i + 1]) : true;
  const r = await call('POST', '/api/app/open', { path: rel(args[0]), diff });
  console.log(`opened ${r.path}` + (r.diff ? `, diff against ${r.diff}` : (diff ? ' (no base found to diff against)' : ''))
    + (r.windows ? '' : '  -- note: no app window is connected'));
} else if (cmd === 'reload') {
  const r = await call('POST', '/api/app/reload');
  console.log(r.windows ? `reloaded ${r.windows} window(s)` : 'no app window is connected');
} else if (cmd === 'base' && args[0]) {
  const r = await call('GET', '/api/base?path=' + encodeURIComponent(rel(args[0])));
  console.log(r.base || '(none -- the file does not follow the naming convention or is v1)');
} else if (cmd === 'finalize' && args[0] && args[1]) {
  const r = await call('POST', '/api/finalize', { path: rel(args[0]), note: args.slice(1).join(' ') });
  console.log(`finalized as ${r.path}` + (r.moved.length ? `; moved to old\\: ${r.moved.join(', ')}` : ''));
} else if (cmd === 'show' && args[0] === '--clear') {
  await call('POST', '/api/app/highlight', { clear: true });
  console.log('cleared');
} else if (cmd === 'show' && args.length) {
  const file = args[0].startsWith('--') ? null : args[0];
  const regions = [];
  const range = (v, flag) => {
    const m = /^(-?[\d.]+):(-?[\d.]+)$/.exec(v || '');
    if (!m) { console.error(`${flag} needs FROM:TO, e.g. ${flag} 193.2:194.0`); process.exit(1); }
    return [Number(m[1]), Number(m[2])];
  };
  let select = true;
  for (let i = file ? 1 : 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--no-select') { select = false; continue; }
    const v = args[++i];
    if (a === '--x' || (!regions.length && ['--y', '--layers'].includes(a))) regions.push({});
    const r = regions[regions.length - 1];
    if (!r) { console.error('start each box with --x (or --y / --layers)'); process.exit(1); }
    if (a === '--x') r.x = range(v, a);
    else if (a === '--y') r.y = range(v, a);
    else if (a === '--z') r.z = range(v, a);
    else if (a === '--layers') r.layers = range(v, a);
    else if (a === '--label') r.label = v;
    else if (a === '--move') {
      const m = String(v || '').split(',').map(Number);
      if (!m.length || m.length > 2 || !m.every(Number.isFinite)) { console.error('--move needs DX or DX,DY, e.g. --move -2.2'); process.exit(1); }
      r.move = [m[0], m[1] || 0];
    }
    else if (a === '--to') r.toX = range(v, a);
    else if (a === '--to-y') r.toY = range(v, a);
    else { console.error('unknown option ' + a); process.exit(1); }
  }
  const out = await call('POST', '/api/app/highlight', { path: file ? rel(file) : null, regions, select });
  console.log(`showing ${out.regions.length} area(s)` + (out.path ? ` on ${out.path}` : '') + (out.windows ? '' : '  -- note: no app window is connected'));
} else {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n?/, ''));
  process.exit(cmd ? 1 : 0);
}
