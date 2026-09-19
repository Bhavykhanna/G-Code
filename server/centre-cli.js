#!/usr/bin/env node
/**
 * centre-cli.js -- centre a finished part on the bed and record the shift,
 * from the terminal. Finalize does this by itself; this is for files that were
 * finalized before that existed. Works without the app server.
 *
 *   node gcode-studio/server/centre-cli.js <file> [--aligned-with <file>] [--apply]
 *
 *   <file>            G-code, Archive-relative or absolute
 *   --aligned-with F  the file this one was lined up with when it was built
 *                     (what the diff should line it up with again)
 *   --apply           write it. Without it: only say what would happen.
 *
 * Writes: the centred file (in place), the text before as a step in
 * old\v<N>-steps\NN-<model>-before-centre.gcode, and the shift in
 * old\v<N>-steps\align.json. Ask the user before --apply: it edits G-code.
 */
import path from 'node:path';
import { centreFile } from './api/centre.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const i = args.indexOf('--aligned-with');
const alignedWith = i >= 0 ? args[i + 1] : null;
const apply = args.includes('--apply');
if (!file) {
  console.log('usage: node gcode-studio/server/centre-cli.js <file> [--aligned-with <file>] [--apply]');
  process.exit(1);
}

try {
  const r = await centreFile({
    path: file,
    finalName: path.basename(file),
    alignedWith: alignedWith ? alignedWith.replace(/\\/g, '/') : null,
    dryRun: !apply,
  });
  console.log((apply ? 'centred         ' : 'would centre    ') + r.file);
  console.log('shift           X ' + r.dx + ' mm, Y ' + r.dy + ' mm' + (r.dx || r.dy ? '' : '  (already centred)'));
  console.log('part centre was ' + r.noteEntry.partCentreBefore.join(', ') + '  -> bed centre ' + r.noteEntry.bedCentre.join(', '));
  console.log('lines moved     ' + r.changedLines);
  console.log((apply ? 'note            ' : 'note would go   ') + r.note);
  if (r.step) console.log('undo step       ' + r.step);
} catch (e) {
  console.error('failed: ' + e.message);
  process.exit(1);
}
