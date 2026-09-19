/**
 * fixtures.js -- where the checks find real print files.
 *
 * This repo ships no job files, and the job folders' names stay private, so the
 * paths live in `test/fixtures.local.js`, which is git-ignored. Without that file
 * the checks that need a real print print "skip" and everything else still runs,
 * so a fresh clone gets a green suite.
 *
 * To run the full suite on a machine that has the print archive, write
 * test/fixtures.local.js as:
 *
 *   export default {
 *     jobRel: '<job folder>/',          // relative to the Archive root
 *     v1BaseRel: '<job>/v1/<base>.gcode',
 *     v1LidRel:  '<job>/v1/<lid>.gcode',
 *     beforeCentre: 'old/v2-steps/<step>.gcode',   // inside jobRel
 *     beforeChange: 'old/v2-steps/<step>.gcode',
 *     finals: [{ tag, final, v1, step, kept: [] }],
 *     v3: { file, prevFinal, ownStep, atFinal: [] },
 *     screwSeats: [[file, expectedFindings, label]],
 *     printed: '<file with known print-check findings>.gcode',
 *   };
 */
let local = null;
try {
  local = (await import('./fixtures.local.js')).default;
} catch {
  local = null;
}

/** The fixture set, or null when this machine has no print archive. */
export const fx = local;

/** `../` + a path relative to the Archive root. */
export const arc = (p) => '../' + p;
