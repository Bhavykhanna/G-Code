/**
 * integration-check.js -- verifies the parts actually fit together.
 *
 * Four parts were built against a written contract (../CONTEXT.md). This asserts
 * that each one exports what the others import, so a mismatch shows up here as a
 * named missing method rather than as a console error in the browser.
 *
 * Browser-only modules (anything importing three.js, touching `document`, or
 * using `fetch`) are checked by static inspection rather than by importing them,
 * because Node has no DOM.
 *
 *   node test/integration-check.js
 */

import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const problems = [];

function ok(label) { pass++; console.log('  \x1b[32mOK\x1b[0m    ' + label); }
function bad(label, detail) {
  fail++;
  problems.push(label + (detail ? ' -- ' + detail : ''));
  console.log('  \x1b[31mFAIL\x1b[0m  ' + label + (detail ? '  (' + detail + ')' : ''));
}

async function exists(rel) {
  try { await access(join(root, rel)); return true; } catch { return false; }
}

/**
 * Check a source file declares the given exported names. Static, not executed --
 * these modules need a browser to import.
 */
async function checkExports(rel, names) {
  if (!(await exists(rel))) { bad(rel, 'file missing'); return; }
  const src = await readFile(join(root, rel), 'utf8');
  const missing = names.filter((n) => {
    const re = new RegExp('export\\s+(async\\s+)?(function|const|let|class)\\s+' + n + '\\b');
    return !re.test(src) && !new RegExp('export\\s*\\{[^}]*\\b' + n + '\\b').test(src);
  });
  if (missing.length) bad(rel, 'missing exports: ' + missing.join(', '));
  else ok(rel + '  exports ' + names.join(', '));
}

/** Check a factory's returned object mentions each required method. */
async function checkMethods(rel, label, methods) {
  if (!(await exists(rel))) { bad(rel, 'file missing'); return; }
  const src = await readFile(join(root, rel), 'utf8');
  const missing = methods.filter((m) => !new RegExp('\\b' + m + '\\b\\s*[:(=]').test(src));
  if (missing.length) bad(label, 'missing methods: ' + missing.join(', '));
  else ok(label + '  (' + methods.length + ' methods)');
}

console.log('\n=== modules that run in Node ===');

// The parser and selection logic are pure and must import cleanly.
try {
  const p = await import('../src/parser/parse.js');
  const needed = ['parseGcode', 'FEATURE_NAMES', 'KIND', 'formatDuration', 'flowRate', 'segLength', 'parseDuration'];
  const missing = needed.filter((n) => !(n in p));
  missing.length ? bad('src/parser/parse.js', 'missing ' + missing.join(', ')) : ok('src/parser/parse.js imports and exports its API');
} catch (e) { bad('src/parser/parse.js', e.message); }

try {
  const s = await import('../src/selection.js');
  const needed = ['buildSelection', 'toLineRanges', 'describeSelection', 'indicesForLineRanges'];
  const missing = needed.filter((n) => !(n in s));
  missing.length ? bad('src/selection.js', 'missing ' + missing.join(', ')) : ok('src/selection.js imports and exports its API');
} catch (e) { bad('src/selection.js', e.message); }

try {
  const c = await import('../src/render/colors.js');
  const needed = ['FEATURE_COLORS', 'RAMPS', 'VIEW_MODES', 'sampleRamp', 'legendFor', 'hexToRgb', 'rgbToHex'];
  const missing = needed.filter((n) => !(n in c));
  if (missing.length) bad('src/render/colors.js', 'missing ' + missing.join(', '));
  else {
    const { FEATURE_COLORS } = c;
    const { FEATURE_NAMES } = await import('../src/parser/parse.js');
    if (FEATURE_COLORS.length !== FEATURE_NAMES.length) {
      bad('colour/feature alignment', FEATURE_COLORS.length + ' colours vs ' + FEATURE_NAMES.length + ' features');
    } else ok('src/render/colors.js  (' + FEATURE_COLORS.length + ' colours, aligned with FEATURE_NAMES)');
  }
} catch (e) { bad('src/render/colors.js', e.message); }

console.log('\n=== renderer contract (static) ===');
await checkExports('src/render/viewer.js', ['createViewer']);
await checkMethods('src/render/viewer.js', 'viewer API', [
  'setData', 'setViewMode', 'setLayerRange', 'setVisibleFeatures', 'setShowTravel',
  'setShowRetractions', 'setSelection', 'clearSelection', 'onPick', 'onHover',
  'onBoxSelect', 'setBoxSelectMode', 'frameAll', 'setTopView', 'setFrontView',
  'setIsoView', 'renderThumbnail', 'getValueRange', 'dispose',
]);

console.log('\n=== UI contract (static) ===');
await checkExports('src/ui/layout.js', ['createUI']);
await checkMethods('src/ui/layout.js', 'ui API', [
  'getCanvas', 'setFile', 'setJobs', 'showPickedSegment', 'showSelection',
  'setViewMode', 'onViewModeChange', 'setLegend', 'onLayerRangeChange', 'setLayerRange',
  'onFeatureToggle', 'onTravelToggle', 'onRetractToggle', 'onCameraPreset',
  'onSelectModeChange', 'onAttachMove', 'startTerminal', 'typeToClaude', 'onSendToClaude', 'onFileOpen', 'confirmEdit', 'toast',
  'setStatus', 'setBusy', 'focusClaude',
]);

console.log('\n=== server contract ===');
for (const f of [
  'server/index.js', 'server/api/files.js', 'server/api/edit.js', 'server/api/validate.js',
  'server/api/version.js', 'server/api/slice.js', 'server/api/diff.js', 'server/api/bridge.js',
]) {
  (await exists(f)) ? ok(f) : bad(f, 'file missing');
}

// Every SSE event the server broadcasts must have a listener in the client --
// a missing one fails silently (app-cli.js show once did nothing because of it).
if (await exists('server/index.js') && await exists('src/bridge/client.js')) {
  const srv = await readFile(join(root, 'server/index.js'), 'utf8');
  const cli = await readFile(join(root, 'src/bridge/client.js'), 'utf8');
  const sent = new Set([...srv.matchAll(/broadcast\('([a-z]+)'/g)].map((m) => m[1]));
  const heard = new Set([...cli.matchAll(/addEventListener\('([a-z]+)'/g)].map((m) => m[1]));
  const unused = new Set(['chat']); // the mailbox panel was removed from the app on purpose
  const deaf = [...sent].filter((e) => !heard.has(e) && !unused.has(e));
  deaf.length ? bad('server events the app listens for', 'no listener for: ' + deaf.join(', '))
              : ok('the app listens for all ' + [...sent].filter((e) => !unused.has(e)).length + ' server events it needs ('
                + [...sent].filter((e) => !unused.has(e)).join(', ') + '; chat is legacy)');
}

// Every route main.js/client.js calls must appear somewhere in the server.
if (await exists('server/index.js')) {
  const files = ['server/index.js', 'server/api/files.js', 'server/api/edit.js',
    'server/api/slice.js', 'server/api/diff.js', 'server/api/bridge.js', 'server/api/version.js'];
  let all = '';
  for (const f of files) if (await exists(f)) all += await readFile(join(root, f), 'utf8');
  const routes = ['/jobs', '/file', '/meta', '/edit', '/slice', '/diff', '/versions',
    '/bridge/selection', '/bridge/attach', '/term', '/watch'];
  const missing = routes.filter((r) => !all.includes(r));
  missing.length ? bad('routes the frontend calls', 'not found: ' + missing.join(', '))
                 : ok('all ' + routes.length + ' routes the frontend calls are present');
}

console.log('\n=== app shell ===');
for (const f of ['index.html', 'src/styles.css', 'src/main.js', 'vite.config.js']) {
  (await exists(f)) ? ok(f) : bad(f, 'file missing');
}
if (await exists('index.html')) {
  const html = await readFile(join(root, 'index.html'), 'utf8');
  html.includes('src/main.js') ? ok('index.html loads src/main.js')
                               : bad('index.html', 'does not load src/main.js');
}

console.log('\n=== context files ===');
for (const f of ['CONTEXT.md', 'docs/CONTEXT-parser.md', 'docs/CONTEXT-render.md',
  'docs/CONTEXT-server.md', 'docs/CONTEXT-ui.md', 'docs/CONTEXT-bridge.md']) {
  (await exists(f)) ? ok(f) : bad(f, 'file missing');
}

console.log('\n' + '-'.repeat(60));
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) {
  console.log('\nOutstanding:');
  for (const p of problems) console.log('  - ' + p);
}
process.exit(fail ? 1 : 0);
