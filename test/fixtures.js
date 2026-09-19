/**
 * fixtures.js -- where the checks find real print files.
 *
 * Two sources, and every check should be able to run from either:
 *
 *   - **the demo job in this repo** (`demo\`), which is always there. A real
 *     full-size print with a previous version beside it, so any check that just
 *     needs "a real file" has one on a fresh clone. Exported as `demoFile` /
 *     `demoBase`, discovered from the folder rather than named, so re-versioning
 *     the demo does not break the tests.
 *   - **the print archive**, which is private and not in this repo. Its paths
 *     live in `test/fixtures.local.js` (git-ignored) and come out as `fx`, or
 *     `null` where there is no archive. Checks that need a *specific* history --
 *     centring, align notes, known print-check findings -- use `fx` and skip
 *     when it is absent.
 *
 * So: `fx` for "this exact file with this exact history", `demoFile` for "any
 * real print". A check that crashes instead of skipping on a clone is a bug
 * (B16), not a missing file.
 *
 * To run the archive half on a machine that has it, write test/fixtures.local.js:
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
 *
 *     // server-smoke.js: the job whose version history is worth pinning.
 *     smoke: { job: '<job folder>', minVersions: 4, oldVersions: [1, 2, 3], stlCount: 1 },
 *     // server-diff.js: two versions with ONE setting group between them.
 *     // Paths here are Archive-relative, the form the API speaks (no `arc()`).
 *     diffPair: {
 *       a: '<job>/old/<v3>.gcode', b: '<job>/old/<v4>.gcode',
 *       settingPrefix: 'ironing',      // the key group that should show up
 *       feature: 'Ironing', featureOnlyIn: 'b',
 *       aTimeText: '50m 4s', bTimeText: '57m 13s', deltaTimeSec: 429,
 *       minLayerRows: 53,
 *     },
 *     // server-diff.js: a re-tune across layer heights.
 *     diffRetune: { a: '<job>/old/<0.12 mm v1>.gcode', b: '<job>/old/<0.20 mm v4>.gcode' },
 *   };
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let local = null;
try {
  local = (await import('./fixtures.local.js')).default;
} catch {
  local = null;
}

/** The archive fixture set, or null when this machine has no print archive. */
export const fx = local;

/** `../` + a path relative to the Archive root. */
export const arc = (p) => '../' + p;

/** An absolute path inside the repo, so a check does not depend on the cwd. */
export const repo = (p) => path.join(fileURLToPath(new URL('..', import.meta.url)), p);

/**
 * The shipped demo job: its current version and the one before it.
 * Found by looking, not by name — `{ dir, name, current, base }`, or null if
 * `demo\` is ever shipped without a G-code in it.
 */
function findDemo() {
  const root = repo('demo');
  let jobs = [];
  try {
    jobs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch { return null; }

  for (const job of jobs) {
    const dir = path.join(root, job.name);
    const gcode = (p) => {
      try {
        return readdirSync(p)
          .filter((f) => f.toLowerCase().endsWith('.gcode'))
          .map((f) => path.join(p, f))
          .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      } catch { return []; }
    };
    const current = gcode(dir);
    if (!current.length) continue;
    const older = gcode(path.join(dir, 'old'));
    return { dir, name: job.name, current: current[0], base: older[0] || null };
  }
  return null;
}

const found = findDemo();

/** A real, full-size print file that is always available. */
export const demoFile = found ? found.current : null;
/** The version before it, so a diff or an A/B check has a base. */
export const demoBase = found ? found.base : null;
/** `{ dir, name, current, base }` for the whole demo job. */
export const demoJob = found;
