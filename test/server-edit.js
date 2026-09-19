/**
 * server-edit.js -- Lane A edits, the validator, and versioning, against a real file.
 *
 *   node test/server-edit.js
 *
 * The real job folders are NEVER touched: the 17 Pro G-code is copied into a
 * scratch job folder inside the Archive tree (the sandbox root), edited there,
 * and the folder is removed at the end.
 *
 * What this proves:
 *   - a scaleSpeed dry-run rewrites exactly the F values it should, restores the
 *     previous feedrate at the region boundary, leaves every other byte alone,
 *     and passes validation
 *   - flow beyond +/-20 % is refused by the op, and an out-of-band flow change
 *     is caught independently by the validator
 *   - a Z shift below the bed is rejected
 *   - a failed validation blocks the write
 *   - a real write produces the next version and moves the old one into old\
 */
import './_isolate.js'; // must be first: keeps the tests out of the live bridge\ folder
import { mkdir, copyFile, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseGcode, KIND } from '../src/parser/parse.js';
import { start, stop } from '../server/index.js';
import { ARCHIVE_ROOT } from '../server/api/files.js';
import { validate } from '../server/api/validate.js';
import * as editMod from '../server/api/edit.js';
import { ok, eq, section, row, run, post, get, PORT, BASE, auth } from './server-helpers.js';

const SRC = path.join(ARCHIVE_ROOT, 'phonecase-17pro', 'old', 'EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v1-ironed_49m.gcode');
const TMP_JOB = path.join(ARCHIVE_ROOT, 'gcode-studio-scratch-edit');
const TMP_NAME = 'EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v1-ironed_49m.gcode';
const TMP_FILE = path.join(TMP_JOB, TMP_NAME);
const REL = 'gcode-studio-scratch-edit/' + TMP_NAME;

// Layer 20 outer wall: a real, contiguous region in the middle of the print.
let region, srcText, srcParsed;

await run(async () => {
  await rm(TMP_JOB, { recursive: true, force: true });
  await mkdir(TMP_JOB, { recursive: true });
  await copyFile(SRC, TMP_FILE);
  await start(PORT, '127.0.0.1');

  srcText = await readFile(TMP_FILE, 'utf8');
  srcParsed = parseGcode(srcText);

  section('the source file');
  row('moves', srcParsed.count.toLocaleString());
  row('bytes', srcText.length.toLocaleString());
  row('eol', JSON.stringify(srcParsed.meta.eol));
  row('time / weight', `${srcParsed.meta.estimatedTimeText}  ${srcParsed.meta.filamentUsedG} g`);

  // Pick every move of layer 20 and use its source-line span as the selection,
  // exactly as a 3D box-select would produce it.
  const seg = srcParsed.segments;
  let lo = Infinity, hi = -Infinity, n = 0;
  for (let i = 0; i < srcParsed.count; i++) {
    if (seg.layer[i] !== 20) continue;
    lo = Math.min(lo, seg.line[i]); hi = Math.max(hi, seg.line[i]); n++;
  }
  region = [lo, hi];
  row('layer 20 selection', `lines ${lo}-${hi}, ${n} moves`);

  // -----------------------------------------------------------------------
  section('scaleSpeed 0.8x dry run');
  const e1 = await post('/api/edit', {
    path: REL, note: 'slow layer 20', dryRun: true,
    ops: [{ op: 'scaleSpeed', factor: 0.8, lineRanges: [region] }],
  });
  if (!e1.ok) for (const er of e1.validation.errors) row('ERROR ' + er.code, er.message + ' ' + JSON.stringify(er.detail || ''));
  for (const wn of e1.validation.warnings) row('warn ' + wn.code, wn.message);
  ok(e1.ok, 'validation passed');
  ok(e1.written === false, 'dryRun wrote nothing');
  eq(e1.validation.errors.length, 0, 'zero errors');
  row('op notes', e1.preview.ops[0].notes.join(' | '));
  row('matched moves', e1.preview.ops[0].matched);
  row('changed lines', `${e1.diff.changedLines} changed, ${e1.diff.insertedLines} inserted, ${e1.diff.deletedLines} deleted`);
  row('time', `${e1.preview.before.timeText} -> ${e1.preview.after.timeText}  (${e1.preview.delta.timePct}%)`);
  row('filament', `${e1.preview.before.filamentG} g -> ${e1.preview.after.filamentG} g`);
  row('outPath', e1.outPath);
  ok(e1.preview.after.timeSec > e1.preview.before.timeSec, 'slowing down predicts a LONGER print');
  eq(e1.preview.delta.filamentG, 0, 'a speed edit changes no filament');
  eq(e1.outPath, 'gcode-studio-scratch-edit/EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v2-draft.gcode',
    'editing final v1 plans a v2 draft');

  // Inspect the actual diff entries.
  const first = e1.diff.entries.find((x) => x.kind === 'change');
  row('example change', `line ${first.line}:  ${first.before}   ->   ${first.after}`);
  const fBefore = Number(/F(\d+)/.exec(first.before)?.[1] || 0);
  const fAfter = Number(/F(\d+)/.exec(first.after)[1]);
  if (fBefore) ok(Math.abs(fAfter / fBefore - 0.8) < 0.01, `F scaled 0.8x: ${fBefore} -> ${fAfter}`);
  ok(e1.diff.entries.some((x) => x.kind === 'change' && /F\d+/.test(x.after)), 'F values were rewritten');

  // -----------------------------------------------------------------------
  section('byte fidelity');
  const local = applyLocally(srcText, srcParsed, { op: 'scaleSpeed', factor: 0.8, lineRanges: [region] });
  const a = srcText.split('\n'), b = local.split('\n');
  eq(b.length, a.length, 'scaleSpeed inserts and deletes nothing');
  const stripF = (s) => s.replace(/\s*F-?[\d.]+/, '');
  let differing = 0, nonFdiff = 0;
  const outside = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    differing++;
    if (stripF(a[i]) !== stripF(b[i])) nonFdiff++;   // only F is allowed to differ
    if (i < region[0] || i > region[1]) outside.push(i);
  }
  row('lines differing', differing);
  eq(nonFdiff, 0, 'every differing line differs ONLY in its F parameter');
  eq(outside.length, 1, 'exactly one line outside the region changed -- the feedrate restore');
  row('restore line', `${outside[0]}:  ${a[outside[0]]}   ->   ${b[outside[0]]}`);
  ok(outside[0] > region[1], 'and it is the first move AFTER the region');

  // -----------------------------------------------------------------------
  section('flow cap (safety rule 4)');
  const bad = await post('/api/edit', {
    path: REL, note: 'too much flow', dryRun: true,
    ops: [{ op: 'scaleFlow', factor: 2.0, lineRanges: [region] }],
  });
  eq(bad.__status, 422, 'flow 2.0x is refused with 422');
  ok(/hard cap/.test(bad.error), 'and says why: ' + bad.error.slice(0, 90) + '...');
  const bad2 = await post('/api/edit', { path: REL, note: 'x', dryRun: true, ops: [{ op: 'scaleFlow', factor: 0.5, lineRanges: [region] }] });
  eq(bad2.__status, 422, 'flow 0.5x is refused too');
  const good = await post('/api/edit', {
    path: REL, note: 'a touch more flow', dryRun: true,
    ops: [{ op: 'scaleFlow', factor: 1.1, lineRanges: [region] }],
  });
  ok(good.ok, 'flow 1.1x is allowed and validates');
  row('filament', `${good.preview.before.filamentG} g -> ${good.preview.after.filamentG} g (+${good.preview.delta.filamentG} g)`);
  ok(good.preview.delta.filamentG > 0, 'and really does add filament');

  // -----------------------------------------------------------------------
  section('the validator catches a flow change made behind its back');
  // Hand-mutate every E on layer 20 by 2x, bypassing edit.js entirely.
  const lines = srcText.split('\n');
  for (let i = region[0]; i <= region[1]; i++) {
    lines[i] = lines[i].replace(/\bE(-?[\d.]+)/, (mm, v) => (Number(v) > 0 ? 'E' + (Number(v) * 2).toFixed(5) : mm));
  }
  const v = validate(lines.join('\n'), { original: srcParsed });
  ok(!v.ok, 'validation fails');
  row('errors', v.errors.map((e) => e.code).join(', '));
  ok(v.errors.some((e) => e.code === 'FLOW_CAP'), 'FLOW_CAP error raised');

  // -----------------------------------------------------------------------
  section('Z below the bed is rejected');
  const zbad = await post('/api/edit', {
    path: REL, note: 'z too low', dryRun: true,
    ops: [{ op: 'setZOffset', mm: -5, lineRanges: [region] }],
  });
  ok(!zbad.ok, 'validation failed');
  row('errors', zbad.validation.errors.map((e) => e.code).join(', '));
  ok(zbad.validation.errors.some((e) => e.code === 'OUT_OF_BOUNDS' || e.code === 'Z_REGRESSION'), 'flagged as out of bounds / Z regression');
  const wrote = await post('/api/edit', {
    path: REL, note: 'z too low', dryRun: false,
    ops: [{ op: 'setZOffset', mm: -5, lineRanges: [region] }],
  });
  eq(wrote.__status, 422, 'a failed validation BLOCKS the write (422)');
  const dir = await readdir(TMP_JOB);
  eq(dir.filter((f) => f.endsWith('.gcode')).length, 1, 'nothing new was written to disk');

  // A small positive Z shift should pass.
  const zok = await post('/api/edit', { path: REL, note: 'lift a hair', dryRun: true, ops: [{ op: 'setZOffset', mm: 0.05, lineRanges: [region] }] });
  ok(zok.ok, 'setZOffset +0.05 mm validates');

  // -----------------------------------------------------------------------
  section('the other ops');
  for (const [label, op, check] of [
    ['setSpeed 40 mm/s', { op: 'setSpeed', mm_s: 40, lineRanges: [region] }, (r) => r.preview.after.timeSec > r.preview.before.timeSec],
    ['setFan 100%', { op: 'setFan', percent: 100, lineRanges: [region] }, (r) => r.diff.insertedLines >= 2],
    ['scaleFan 0.5x', { op: 'scaleFan', factor: 0.5, lineRanges: [region] }, (r) => r.diff.insertedLines >= 2],
    ['setTemp 210 C', { op: 'setTemp', celsius: 210, lineRanges: [region] }, (r) => r.diff.entries.some((e) => /M104 S210/.test(e.after || ''))],
    ['setAccel 1500', { op: 'setAccel', mm_s2: 1500, lineRanges: [region] }, (r) => r.diff.entries.some((e) => /ACCEL=1500/.test(e.after || ''))],
    ['insertPause at layer 30', { op: 'insertPause', atLayer: 30 }, (r) => r.diff.entries.some((e) => /M600/.test(e.after || ''))],
    ['deleteRegion (layer 20)', { op: 'deleteRegion', lineRanges: [region] }, (r) => r.diff.deletedLines > 100],
    ['filter: Ironing, layers 0-10', { op: 'scaleSpeed', factor: 0.9, filter: { layers: [0, 10], features: ['Ironing', 'Top surface'] } }, (r) => r.preview.ops[0].matched > 1000],
  ]) {
    const r = await post('/api/edit', { path: REL, note: label, dryRun: true, ops: [op] });
    const errs = r.validation ? r.validation.errors.map((e) => e.code).join(',') : 'n/a';
    row(label, `${r.ok ? 'ok  ' : 'FAIL'}  matched=${r.preview?.ops[0]?.matched}  +${r.diff?.insertedLines}/-${r.diff?.deletedLines}/~${r.diff?.changedLines}  ${errs || 'no errors'}`);
    ok(r.ok, label + ' validates');
    ok(check(r), label + ' did what it says');
  }

  section('multiple ops in one request');
  const multi = await post('/api/edit', {
    path: REL, note: 'slow and cool layer 20', dryRun: true,
    ops: [
      { op: 'scaleSpeed', factor: 0.75, lineRanges: [region] },
      { op: 'setFan', percent: 60, lineRanges: [region] },
    ],
  });
  ok(multi.ok, 'combined speed + fan edit validates');
  eq(multi.preview.ops.length, 2, 'both ops reported');

  // -----------------------------------------------------------------------
  section('a real write goes into a draft; the final stays');
  const draftRel = 'gcode-studio-scratch-edit/EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v2-draft.gcode';
  const w = await post('/api/edit', {
    path: REL, note: 'slow layer 20', dryRun: false,
    ops: [{ op: 'scaleSpeed', factor: 0.8, lineRanges: [region] }],
  });
  ok(w.written === true, 'the file was written');
  row('new file', w.commit.name);
  row('step', w.commit.step);
  eq(w.outPath, draftRel, 'written to ..._v2-draft.gcode');
  eq(w.commit.version, 2, 'draft is v2');
  let after = await readdir(TMP_JOB);
  ok(after.includes(TMP_NAME), 'final v1 is still in the job folder (it is the file to print)');
  ok(after.includes('EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v2-draft.gcode'), 'the draft is next to it');
  let steps = await readdir(path.join(TMP_JOB, 'old', 'v2-steps'));
  eq(steps.length, 1, 'one step saved');
  eq(steps[0], '00-from-' + TMP_NAME, 'step 00 is the final it started from');

  const written = await readFile(path.join(TMP_JOB, w.commit.name), 'utf8');
  const wp = parseGcode(written);
  row('new footer time', wp.meta.estimatedTimeText);
  ok(wp.meta.estimatedTimeSec > srcParsed.meta.estimatedTimeSec, 'the footer time was updated to the predicted value');
  ok(Math.abs(wp.meta.filamentUsedG - srcParsed.meta.filamentUsedG) < 0.02, 'the footer weight is unchanged by a speed edit');
  ok(written.includes('; gcode-studio: note = slow layer 20'), 'a provenance comment was left in the footer');
  eq(validate(written, { parsed: wp }).ok, true, 'the file on disk validates standalone');

  section('a second edit changes the same draft, and saves the step before it');
  const w2 = await post('/api/edit', {
    path: draftRel, note: 'fan 60', dryRun: false,
    ops: [{ op: 'setFan', percent: 60, lineRanges: [region] }],
  });
  eq(w2.outPath, draftRel, 'still the v2 draft');
  steps = (await readdir(path.join(TMP_JOB, 'old', 'v2-steps'))).sort();
  eq(steps.length, 2, 'two steps now');
  eq(steps[1], '01-fan-60.gcode', 'step 01 is named after the edit');
  eq(await readFile(path.join(TMP_JOB, 'old', 'v2-steps', steps[1]), 'utf8'), written, 'step 01 holds the draft as it was before the fan edit');

  section('the final cannot be edited twice into two drafts');
  const clash = await fetch(BASE + '/api/edit', {
    method: 'POST', headers: auth({ 'content-type': 'application/json' }),
    body: JSON.stringify({ path: REL, note: 'other', dryRun: false, ops: [{ op: 'scaleSpeed', factor: 0.9, lineRanges: [region] }] }),
  });
  eq(clash.status, 409, 'a second draft of v1 is refused (409)');

  section('base and finalize');
  const base = await get('/api/base?path=' + encodeURIComponent(draftRel));
  eq(base.base, REL, 'the draft is compared with final v1');
  const fin = await post('/api/finalize', { path: draftRel, note: 'slow top fan 60' });
  row('final', fin.path);
  ok(/_v2-slow-top-fan-60_\d+(h\d+)?m\.gcode$/.test(fin.name), 'renamed to ..._v2-<note>_<time>.gcode');
  after = await readdir(TMP_JOB);
  eq(after.filter((f) => f.endsWith('.gcode')).length, 1, 'one current G-code: the new final');
  const oldDir = (await readdir(path.join(TMP_JOB, 'old'))).sort();
  ok(oldDir.includes(TMP_NAME), 'final v1 moved into old\\');
  ok(oldDir.includes('v2-steps'), 'the steps are kept');
  eq((await get('/api/base?path=' + encodeURIComponent(fin.path))).base, 'gcode-studio-scratch-edit/old/' + TMP_NAME,
    'final v2 is compared with v1 in old\\');

  section('versions of the scratch job');
  const vs = await get('/api/versions?job=gcode-studio-scratch-edit');
  for (const x of vs.versions) row(`v${x.version} ${x.archived ? 'old' : 'cur'}`, `${x.footer.timeText}  ${x.footer.filamentG} g  ${x.name}`);
  eq(vs.versions.length, 2, 'two versions listed (steps are not versions)');

  section('v3 starts as a new draft of final v2');
  const w3 = await post('/api/edit', {
    path: fin.path, note: 'x', dryRun: false,
    ops: [{ op: 'scaleSpeed', factor: 0.99, lineRanges: [region] }],
  });
  eq(w3.outPath, 'gcode-studio-scratch-edit/EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v3-draft.gcode', 'v3 draft');

  await stop();
  await rm(TMP_JOB, { recursive: true, force: true });
});

function timeField(sec) {
  const s = Math.floor(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${m}m` : `${m}m`;
}

/** Run one op through the module API so the test can inspect the raw output. */
function applyLocally(text, parsed, op) {
  // Imported lazily to keep the module graph obvious at the top of the file.
  const doc = new editMod.LineDoc(text, parsed.meta.eol);
  editMod.applyOp(doc, parsed, op);
  return doc.render();
}