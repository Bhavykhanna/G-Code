/**
 * Centring on Finalize, and lining versions up again for the diff.
 *
 *   node test/check-align.js
 *
 * What it proves (read-only; nothing is written):
 *   - nameFields reads the naming convention, drafts included
 *   - shiftGcode on a real part: it lands on the bed centre,
 *     the move count is unchanged, start G-code is untouched, and shifting
 *     back gives the original text byte for byte
 *   - the diff: centred v2 against v1 moved by the note's shift classifies
 *     the moves like the uncentred v2 against v1 did (grid rounding aside)
 *   - alignFor walks a chain of notes (final -> final -> other folder) and a
 *     draft, and returns null when the notes do not connect
 */
import { readFileSync, existsSync } from 'node:fs';
import { parseGcode } from '../src/parser/parse.js';
import { centreShift, shiftGcode, partBox, nameFields, alignFor, shiftParse, notePath } from '../src/align.js';
import { compareToolpaths } from '../src/compare.js';
import { fx, arc } from './fixtures.js';

let fails = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) fails++;
  console.log('  ' + (cond ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(62) + detail);
};

console.log('\n=== nameFields / notePath ===');
{
  const f = nameFields('EN4Max_0.4_Iphone16Pro_HexCover_HSPLA+_0.20_v5-thumbnail_57m.gcode');
  ok('model with an underscore', f && f.model === 'Iphone16Pro_HexCover' && f.version === 5 && !f.draft, JSON.stringify(f));
  const d = nameFields('EN4Max_0.4_ExampleModel_HSPLA+_0.20_v3-draft.gcode');
  ok('draft', d && d.draft && d.version === 3 && d.model === 'ExampleModel');
  ok('not the convention -> null', nameFields('some-old-export.gcode') === null);
  ok('note path from the job folder', notePath('job/x_v3-a_1m.gcode', 3) === 'job/old/v3-steps/align.json');
  ok('note path from old\\', notePath('job\\old\\x_v2-a_1m.gcode', 2) === 'job/old/v2-steps/align.json');
}

// the version as it was before centring (finals are centred since 2026-09-17)
const V2 = fx ? arc(fx.jobRel + fx.beforeCentre) : null;
const V1 = fx ? arc(fx.v1BaseRel) : null;

console.log('\n=== shiftGcode on a real part ===');
if (!V2 || !existsSync(V2) || !existsSync(V1)) console.log('  skip  no test/fixtures.local.js');
else {
  const text = readFileSync(V2, 'utf8');
  const before = parseGcode(text);
  const plan = centreShift(before);
  ok('needs +2.1 mm in X, 0 in Y', Math.abs(plan.dx - 2.1) < 0.002 && Math.abs(plan.dy) < 0.002, `${plan.dx}, ${plan.dy}`);
  ok('fits on the bed', plan.fits);
  const t0 = Date.now();
  const { text: out, changedLines } = shiftGcode(text, plan.dx, plan.dy);
  const ms = Date.now() - t0;
  const after = parseGcode(out);
  const box = partBox(after);
  ok('part now on the bed centre', Math.abs(box.cx - 213) < 0.01 && Math.abs(box.cy - 213) < 0.01, `${box.cx.toFixed(3)}, ${box.cy.toFixed(3)}`);
  ok('same number of moves', after.count === before.count, `${after.count}`);
  ok('same number of lines', out.split('\n').length === text.split('\n').length);
  ok('lines changed', changedLines > 1000, `${changedLines} in ${ms} ms`);
  const head = (t) => t.split('\n').slice(0, t.split('\n').findIndex((l) => /^;LAYER:1\b/.test(l)));
  const h0 = head(text), h1 = head(out);
  const diffHead = h0.filter((l, i) => l !== h1[i]);
  ok('start G-code unchanged (only the EXCLUDE_OBJECT outline moved)',
    diffHead.length === 1 && diffHead[0].startsWith('EXCLUDE_OBJECT_DEFINE'), `${diffHead.length} line(s)`);
  ok('outline centre moved to 213', /CENTER=213,213/.test(out));
  const back = shiftGcode(out, -plan.dx, -plan.dy).text;
  ok('shifting back gives the original byte for byte', back === text);
  const extrudeSame = (() => {
    const a = before.segments, b = after.segments;
    for (let i = 0; i < before.count; i++) if (a.e[i] !== b.e[i] || a.z1[i] !== b.z1[i]) return false;
    return true;
  })();
  ok('E and Z untouched', extrudeSame);

  console.log('\n=== diff: centred v2 vs v1 lined up == uncentred v2 vs v1 ===');
  const old = parseGcode(readFileSync(V1, 'utf8'));
  const raw = compareToolpaths(before, old);
  const lined = compareToolpaths(after, shiftParse(old, plan.dx, plan.dy));
  let same = 0, differ = 0;
  for (let i = 0; i < before.count; i++) (raw.curClass[i] === lined.curClass[i] ? same++ : differ++);
  ok('classified the same (grid rounding: <= 0.01 %)', differ <= before.count * 1e-4, `${same} same, ${differ} differ`);
  const unaligned = compareToolpaths(after, old);
  ok('without lining up, the diff is wrong (sanity)', unaligned.stats.curAddedMm > raw.stats.curAddedMm * 1.3,
    `${Math.round(unaligned.stats.curAddedMm)} mm added vs ${Math.round(raw.stats.curAddedMm)}`);
  ok('shiftParse leaves the input alone', old.segments.x0[100] !== shiftParse(old, 1, 0).segments.x0[100]);
}

console.log('\n=== alignFor ===');
{
  const notes = {
    'job/old/v3-steps/align.json': { Box: { final: 'EN4Max_0.4_Box_PLA_0.20_v3-b_10m.gcode', dx: 1.5, dy: -1, alignedWith: 'job/old/EN4Max_0.4_Box_PLA_0.20_v2-a_9m.gcode' } },
    'job/old/v2-steps/align.json': { Box: { final: 'EN4Max_0.4_Box_PLA_0.20_v2-a_9m.gcode', dx: 2, dy: 0, alignedWith: 'first/box.gcode' } },
  };
  const read = async (p) => notes[p] || null;
  const v3 = 'job/EN4Max_0.4_Box_PLA_0.20_v3-b_10m.gcode';
  const v2 = 'job/old/EN4Max_0.4_Box_PLA_0.20_v2-a_9m.gcode';
  const r1 = await alignFor(v3, v2, read);
  ok('final v3 vs v2 = v3 note', r1 && r1.dx === 1.5 && r1.dy === -1, JSON.stringify(r1));
  const r2 = await alignFor(v3, 'first/box.gcode', read);
  ok('final v3 vs another folder = sum of notes', r2 && r2.dx === 3.5 && r2.dy === -1, JSON.stringify(r2));
  const r3 = await alignFor(v3, v3, read);
  ok('same file = no shift', r3 && r3.dx === 0 && r3.dy === 0);
  const draft = 'job/EN4Max_0.4_Box_PLA_0.20_v4-draft.gcode';
  const r4 = await alignFor(draft, v3, read, async () => v3);
  ok('draft vs the final it came from = no shift', r4 && r4.dx === 0);
  const r5 = await alignFor(draft, v2, read, async () => v3);
  ok('draft vs an older final = that final\'s notes', r5 && r5.dx === 1.5);
  const r6 = await alignFor(v3, 'somewhere/else.gcode', read);
  ok('notes do not reach the base -> null', r6 === null);
  const r7 = await alignFor(v2.replace('v2-a', 'v2-x'), 'first/box.gcode', read);
  ok('note filed under another final name -> null', r7 === null);
  // v3's note says it was lined up with v2 at job/, but Finalize then moved v2 to job/old/
  notes['job/old/v4-steps/align.json'] = { Box: { final: 'EN4Max_0.4_Box_PLA_0.20_v4-c_11m.gcode', dx: 0, dy: 0, alignedWith: 'job/EN4Max_0.4_Box_PLA_0.20_v3-b_10m.gcode' } };
  const v4 = 'job/EN4Max_0.4_Box_PLA_0.20_v4-c_11m.gcode';
  const r10 = await alignFor(v4, 'job/old/EN4Max_0.4_Box_PLA_0.20_v3-b_10m.gcode', read);
  ok('base moved to old\\ after the note was written -> still found', r10 && r10.dx === 0, JSON.stringify(r10));
  const r11 = await alignFor(v4, v2, read);
  ok('and the chain goes on past it', r11 && r11.dx === 1.5 && r11.dy === -1, JSON.stringify(r11));
  notes['job/old/v3-steps/align.json'].Box.atFinal = ['05-before-fix.gcode'];
  const r8 = await alignFor(v3, 'job/old/v3-steps/05-before-fix.gcode', read);
  ok('atFinal step = where the final sits (no shift)', r8 && r8.dx === 0 && r8.dy === 0, JSON.stringify(r8));
  const r9 = await alignFor(v3, 'job/old/v3-steps/02-before-centre.gcode', read);
  ok('other step files still get the centring shift', r9 && r9.dx === 1.5 && r9.dy === -1, JSON.stringify(r9));
}

console.log('\n=== the app\'s path with real align notes ===');
if (!fx) console.log('  skip  no test/fixtures.local.js');
else {
  const { readFile } = await import('node:fs/promises');
  const read = (p) => readFile('../' + p, 'utf8').then(JSON.parse).catch(() => null);
  const job = fx.jobRel;
  for (const { tag, final, v1, step, kept } of fx.finals) {
    if (!existsSync('../' + job + final)) { console.log('  skip  ' + tag); continue; }
    const a = await alignFor(job + final, v1, read);
    ok(`${tag}: final vs v1 -> +2.1 X`, a && a.dx === 2.1 && a.dy === 0, JSON.stringify(a && [a.dx, a.dy]));
    const st = await alignFor(job + final, job + 'old/v2-steps/' + step, read);
    ok(`${tag}: final vs its copy from before centring -> +2.1 X`, st && st.dx === 2.1);
    for (const k of kept) {
      const keptR = await alignFor(job + final, job + 'old/v2-steps/' + k, read);
      ok(`${tag}: final vs kept old final ${k.slice(0, 2)} -> no shift`, keptR && keptR.dx === 0 && keptR.dy === 0, JSON.stringify(keptR && [keptR.dx, keptR.dy]));
    }
    const none = await alignFor(job + final, 'another-job/whatever.gcode', read);
    ok(`${tag}: final vs an unrelated file -> no shift (null)`, none === null);
  }
  const v3 = job + fx.v3.file;
  if (existsSync('../' + v3)) {
    const a1 = await alignFor(v3, fx.v1BaseRel, read);
    ok('v3 vs v1 -> +2.1 X (through v2\'s note)', a1 && a1.dx === 2.1 && a1.dy === 0, JSON.stringify(a1 && [a1.dx, a1.dy]));
    const a2 = await alignFor(v3, job + fx.v3.prevFinal, read);
    ok('v3 vs the previous final (now in old\) -> no shift, found', a2 && a2.dx === 0 && a2.dy === 0, JSON.stringify(a2 && [a2.dx, a2.dy]));
    const a3 = await alignFor(v3, job + fx.v3.ownStep, read);
    ok('v3 vs one of its own steps -> no shift', a3 && a3.dx === 0, JSON.stringify(a3 && [a3.dx, a3.dy]));
    for (const k of fx.v3.atFinal) {
      const a4 = await alignFor(v3, job + 'old/v3-steps/' + k, read);
      ok(`v3 vs the copy kept as step ${k.slice(0, 2)} -> no shift`, a4 && a4.dx === 0, JSON.stringify(a4 && [a4.dx, a4.dy]));
    }
  } else console.log('  skip  v3');
}

console.log(fails ? `\n  ${fails} CHECK(S) FAILED\n` : '\n  all checks passed\n');
process.exit(fails ? 1 : 0);
