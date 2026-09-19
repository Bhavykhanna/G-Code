/**
 * centre.js -- centre a part on the bed and record the shift (align.json).
 *
 * Used by Finalize (version.js) and by `server/centre-cli.js`. The geometry
 * work is in src/align.js; this file reads, checks, writes and keeps the undo
 * step. Nothing is lost: the text before centring is saved as a step in
 * `old\v<N>-steps\` first.
 */

import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseGcode } from '../../src/parser/parse.js';
import { centreShift, shiftGcode, partBox, notePath } from '../../src/align.js';
import { HttpError, relPath, safeResolveReal, contains, ARCHIVE_ROOT, invalidate } from './files.js';
import { parseJobFilename, nextStepPath, atomicWrite } from './version.js';

const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Shifts smaller than this are not worth rewriting the file for. */
const MIN_SHIFT = 0.01;

/**
 * Plan (and optionally apply) centring of one file.
 *
 * @param {object} o
 * @param {string} o.path          file to centre (a draft on Finalize, or a final by hand)
 * @param {string} o.finalName     name the note is filed under (the final's name)
 * @param {string|null} o.alignedWith  Archive-relative file this one was lined up with (for the diff)
 * @param {boolean} [o.dryRun=true]
 */
export async function centreFile({ path: p, finalName, alignedWith = null, dryRun = true }) {
  const abs = await safeResolveReal(p);
  if (!contains(ARCHIVE_ROOT, abs)) throw new HttpError(403, 'target is outside the Archive tree');
  const fields = parseJobFilename(finalName || path.basename(abs));
  if (!fields.ok) throw new HttpError(422, 'centring needs a file that follows the naming convention');

  const text = await readFile(abs, 'utf8');
  const before = parseGcode(text);
  const plan = centreShift(before);
  if (!plan.fits) {
    throw new HttpError(422, 'the part would not fit on the bed once centred -- left where it is', plan);
  }
  const needed = Math.abs(plan.dx) >= MIN_SHIFT || Math.abs(plan.dy) >= MIN_SHIFT;
  const dx = needed ? plan.dx : 0, dy = needed ? plan.dy : 0;

  let out = text, changedLines = 0;
  if (needed) {
    ({ text: out, changedLines } = shiftGcode(text, dx, dy));
    // check the result: same moves, part now on the centre
    const after = parseGcode(out);
    const box = partBox(after);
    if (after.count !== before.count) throw new HttpError(500, 'centring changed the number of moves -- nothing written');
    if (Math.abs(box.cx - plan.bed.cx) > 0.01 || Math.abs(box.cy - plan.bed.cy) > 0.01) {
      throw new HttpError(500, `centring missed the bed centre (${box.cx.toFixed(3)}, ${box.cy.toFixed(3)}) -- nothing written`);
    }
  }

  const note = {
    final: finalName || path.basename(abs),
    dx, dy,
    alignedWith: alignedWith || null,
    bedCentre: [plan.bed.cx, plan.bed.cy],
    partCentreBefore: [Math.round(plan.part.cx * 1000) / 1000, Math.round(plan.part.cy * 1000) / 1000],
    date: localDate(),
  };
  const noteAbs = path.join(ARCHIVE_ROOT, notePath(relPath(abs), fields.version));
  const result = {
    ok: true, dryRun, file: relPath(abs), dx, dy, changedLines,
    note: relPath(noteAbs), noteEntry: note, step: null,
  };
  if (dryRun) return result;

  const stepsDir = path.dirname(noteAbs);
  await mkdir(stepsDir, { recursive: true });
  if (needed) {
    const step = await nextStepPath(stepsDir, `${fields.model}-before-centre`);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(step, text, 'utf8');
    result.step = relPath(step);
    await atomicWrite(abs, out);
    invalidate(abs);
  }
  let notes = {};
  try { notes = JSON.parse(await readFile(noteAbs, 'utf8')); } catch { /* first note */ }
  // keep the list of kept final copies when the same final is noted again
  const prev = notes[fields.model];
  if (prev && prev.final === note.final && prev.atFinal) note.atFinal = prev.atFinal;
  notes[fields.model] = note;
  await atomicWrite(noteAbs, JSON.stringify(notes, null, 2) + '\n');
  return result;
}
