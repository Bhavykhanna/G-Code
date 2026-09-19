/**
 * version.js -- the file naming convention and the `old\` archive.
 *
 * The convention is defined in `..\..\context\versions.md` and that file is
 * authoritative. This module only implements it:
 *
 *     EN4Max_0.4_<model>_<filament>_<layerheight>_v<n>-<what-changed>_<time>.gcode
 *
 * Drafts (asked for 2026-09-16): edits do not mint a version each time.
 *   - editing a FINAL vN creates `..._v<N+1>-draft.gcode` next to it; vN stays
 *     as the file to print
 *   - editing a DRAFT changes it in place, after saving its previous state as
 *     an undo step in `old\v<N>-steps\NN-<what>.gcode` (steps are kept)
 *   - `finalizeDraft` renames the draft to the convention and moves the older
 *     finals into `old\`
 *
 * Rules that are enforced here, not suggested:
 *   - the current version lives in the job folder, older ones in `old\`
 *   - a file is NEVER overwritten and NEVER deleted; a commit that would
 *     clobber something fails loudly instead
 *   - the new version is written first, and only then is the old current file
 *     moved aside, so a crash leaves two files rather than none
 */
import { rename, mkdir, writeFile, readdir, stat, access } from 'node:fs/promises';
import path from 'node:path';
import { HttpError, readTail, footerStats, relPath, safeResolveReal, contains, ARCHIVE_ROOT } from './files.js';

// ---------------------------------------------------------------------------
// name parsing
// ---------------------------------------------------------------------------

/**
 * Split a conventional filename into its fields.
 *
 * The model name may itself contain underscores (`Iphone17Pro_HexCover`), so
 * the name is parsed from both ends and the middle is split by the two fields
 * that have a recognisable shape: the layer height is the last `_`-segment that
 * looks like a decimal, and the filament is the segment before it.
 *
 * Returns `{ ok: false, name }` for anything that does not match, which is a
 * normal outcome -- `plate_1.gcode` and other unversioned files exist too.
 */
export function parseJobFilename(name) {
  const fail = { ok: false, name };
  let m = /^([A-Za-z0-9]+)_([0-9.]+)_(.+)_v(\d+)-draft\.gcode$/i.exec(name);
  const draft = !!m;
  if (draft) m = [...m.slice(0, 5), 'draft', null];
  else m = /^([A-Za-z0-9]+)_([0-9.]+)_(.+)_v(\d+)-(.+)_([^_]+)\.gcode$/i.exec(name);
  if (!m) return fail;
  const [, printer, nozzle, middle, version, changed, time] = m;

  const parts = middle.split('_');
  if (parts.length < 3) return fail;
  const layerHeight = parts[parts.length - 1];
  if (!/^\d+\.\d+$/.test(layerHeight)) return fail;
  const filament = parts[parts.length - 2];
  const model = parts.slice(0, -2).join('_');
  if (!model) return fail;

  return {
    ok: true,
    name,
    printer,            // 'EN4Max'
    nozzle,             // '0.4'
    model,              // 'Iphone17Pro_HexCover'
    filament,           // 'HSPLA+'
    layerHeight,        // '0.20'
    version: Number(version),
    changed,            // 'ironed' ('draft' for a draft)
    time,               // '49m' (null for a draft)
    draft,              // true for ..._v3-draft.gcode
  };
}

/** Rebuild a filename from fields. The inverse of `parseJobFilename`. */
export function formatJobFilename(f) {
  if (f.draft) {
    return [f.printer || 'EN4Max', f.nozzle || '0.4', f.model, f.filament, f.layerHeight,
      'v' + f.version + '-draft'].join('_') + '.gcode';
  }
  return [
    f.printer || 'EN4Max',
    f.nozzle || '0.4',
    f.model,
    f.filament,
    f.layerHeight,
    'v' + f.version + '-' + f.changed,
    f.time,
  ].join('_') + '.gcode';
}

/**
 * Time field format, taken from the worked examples in the printing context:
 * `49m`, `57m`, `1h11m`. Minutes are floored -- 49m 15s is `49m`, and that is
 * what the existing files on disk use.
 */
export function formatTimeField(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${m}m` : `${m}m`;
}

/** "slow the top down a bit" -> "slow-the-top-down-a-bit", clipped. */
export function slugifyChange(note, fallback = 'edit') {
  const s = String(note || '')
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
  return s || fallback;
}

// ---------------------------------------------------------------------------
// version listing
// ---------------------------------------------------------------------------

/**
 * Every version of a job -- the current file(s) plus everything in `old\` --
 * with the name fields parsed and the print time / weight read from each file's
 * own footer.
 *
 * The footer is read with a 128 KB tail read rather than a full parse, so
 * listing four 3-5 MB files costs milliseconds instead of half a second.
 */
export async function listVersions(jobDir) {
  const out = [];
  const add = async (abs, archived) => {
    const st = await stat(abs);
    const fields = parseJobFilename(path.basename(abs));
    let footer = { timeText: null, timeSec: 0, filamentMm: 0, filamentCm3: 0, filamentG: 0, layerCount: 0 };
    try {
      footer = footerStats(await readTail(abs));
    } catch { /* unreadable footer is not fatal -- report the file anyway */ }
    out.push({
      name: path.basename(abs),
      path: relPath(abs),
      archived,
      size: st.size,
      mtime: st.mtimeMs,
      convention: fields.ok,
      fields: fields.ok ? fields : null,
      version: fields.ok ? fields.version : null,
      footer,
    });
  };

  for (const f of await readdir(jobDir, { withFileTypes: true })) {
    if (f.isFile() && f.name.toLowerCase().endsWith('.gcode')) {
      await add(path.join(jobDir, f.name), false);
    }
  }
  const oldDir = path.join(jobDir, 'old');
  for (const f of await readdir(oldDir, { withFileTypes: true }).catch(() => [])) {
    if (f.isFile() && f.name.toLowerCase().endsWith('.gcode')) {
      await add(path.join(oldDir, f.name), true);
    }
  }

  out.sort((a, b) => (a.version ?? -1) - (b.version ?? -1) || a.mtime - b.mtime);
  return out;
}

/** The highest version number present anywhere in the job, current or archived. */
export function highestVersion(versions) {
  let n = 0;
  for (const v of versions) if (v.version != null && v.version > n) n = v.version;
  return n;
}

// ---------------------------------------------------------------------------
// planning and committing a new version
// ---------------------------------------------------------------------------

/**
 * Work out the filename the next version gets, without writing anything.
 *
 * @param {object} o
 * @param {string} o.currentPath  absolute path of the file being edited
 * @param {string} o.changed      what changed, free text; slugified
 * @param {number} o.timeSec      print time of the NEW file, seconds
 * @param {Array}  o.versions     result of listVersions, for the version bump
 */
export function planVersion({ currentPath, changed, timeSec, versions = [] }) {
  const base = path.basename(currentPath);
  const fields = parseJobFilename(base);
  if (!fields.ok) {
    throw new HttpError(
      422,
      'the current file does not follow the naming convention, so a version cannot be bumped',
      { name: base, convention: 'EN4Max_0.4_<model>_<filament>_<layerheight>_v<n>-<what-changed>_<time>.gcode' },
    );
  }
  const dir = path.dirname(currentPath);
  const slug = slugifyChange(changed, 'edit');

  if (fields.draft) {
    // Edit the draft in place; its current state becomes the next undo step.
    const stepsDir = path.join(dir, 'old', `v${fields.version}-steps`);
    return {
      name: base, version: fields.version, from: fields, dir, draft: true, inPlace: true,
      newPath: currentPath, stepsDir, stepSlug: slug, archivePath: null,
    };
  }

  const same = (v) => v.fields && v.fields.model === fields.model
    && v.fields.filament === fields.filament && v.fields.layerHeight === fields.layerHeight;
  const openDraft = versions.find((v) => !v.archived && v.fields && v.fields.draft && same(v));
  if (openDraft) {
    throw new HttpError(409,
      `a draft already exists (${openDraft.name}) -- edit that, or finalize it first`, { draft: openDraft.path });
  }
  const next = Math.max(fields.version, highestVersion(versions.filter(same))) + 1;
  const name = formatJobFilename({ ...fields, version: next, draft: true });
  return {
    name, version: next, from: fields, dir, draft: true, inPlace: false,
    newPath: path.join(dir, name),
    stepsDir: path.join(dir, 'old', `v${next}-steps`), stepSlug: slug,
    // the final stays where it is: it is still the file to print
    archivePath: null,
  };
}

const exists = (p) => access(p).then(() => true, () => false);

/**
 * Write the new version and move the previous current file into `old\`.
 *
 * Order is deliberate:
 *   1. write `<new>.tmp` then rename it into place (atomic within a volume)
 *   2. only then move the old current file into `old\`
 * A failure at step 2 leaves BOTH files in the job folder -- visible and
 * recoverable. The reverse order could lose the current file.
 */
export async function commitVersion({ currentPath, text, changed, timeSec, versions = [] }) {
  const abs = await safeResolveReal(currentPath);
  if (!contains(ARCHIVE_ROOT, abs)) throw new HttpError(403, 'write target is outside the Archive tree');

  const plan = planVersion({ currentPath: abs, changed, timeSec, versions });

  if (plan.draft) return commitDraft(plan, abs, text);

  if (await exists(plan.newPath)) {
    throw new HttpError(409, 'refusing to overwrite an existing file: ' + plan.name);
  }
  await mkdir(path.join(plan.dir, 'old'), { recursive: true });
  if (await exists(plan.archivePath)) {
    throw new HttpError(409, 'refusing to overwrite an archived file: old\\' + path.basename(abs));
  }

  const tmp = plan.newPath + '.tmp-' + process.pid + '-' + Date.now();
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, plan.newPath);

  let archived = null;
  try {
    await rename(abs, plan.archivePath);
    archived = relPath(plan.archivePath);
  } catch (e) {
    return {
      newPath: relPath(plan.newPath),
      newAbsPath: plan.newPath,
      name: plan.name,
      version: plan.version,
      archivedPath: null,
      warning: 'the new version was written but the previous current file could not be moved into old\\: ' + e.message,
    };
  }

  return {
    newPath: relPath(plan.newPath),
    newAbsPath: plan.newPath,
    name: plan.name,
    version: plan.version,
    archivedPath: archived,
    previous: path.basename(abs),
  };
}

// ---------------------------------------------------------------------------
// drafts
// ---------------------------------------------------------------------------

/** Next free step file name in a steps folder: `03-<slug>.gcode`. */
export async function nextStepPath(stepsDir, slug) {
  await mkdir(stepsDir, { recursive: true });
  const names = await readdir(stepsDir).catch(() => []);
  let n = 0;
  for (const f of names) { const m = /^(\d+)-/.exec(f); if (m) n = Math.max(n, Number(m[1])); }
  return path.join(stepsDir, String(n + 1).padStart(2, '0') + '-' + slug + '.gcode');
}

export async function atomicWrite(target, text) {
  const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, target); // replaces an existing file on Windows too
}

/**
 * Write an edit into a draft.
 *   - from a final: create the draft, and save the final's text as step 00 so
 *     the steps folder alone shows how the version was built
 *   - from a draft: save the draft as the next step, then overwrite it
 */
async function commitDraft(plan, abs, text) {
  const { readFile } = await import('node:fs/promises');
  const before = await readFile(abs, 'utf8');
  if (!plan.inPlace && await exists(plan.newPath)) {
    throw new HttpError(409, 'refusing to overwrite an existing file: ' + plan.name);
  }
  const step = plan.inPlace
    ? await nextStepPath(plan.stepsDir, plan.stepSlug)
    : path.join(plan.stepsDir, '00-from-' + path.basename(abs));
  await mkdir(plan.stepsDir, { recursive: true });
  if (!(await exists(step))) await writeFile(step, before, 'utf8');
  await atomicWrite(plan.newPath, text);
  return {
    newPath: relPath(plan.newPath),
    newAbsPath: plan.newPath,
    name: plan.name,
    version: plan.version,
    draft: true,
    step: relPath(step),
    archivedPath: null,
    previous: path.basename(abs),
  };
}

/**
 * The file a version is compared with: for a draft or a final vN, the highest
 * final below N of the same model (job folder first, then old\). Null for
 * files outside the convention -- the UI then asks.
 */
export async function baseOf(absPath) {
  const fields = parseJobFilename(path.basename(absPath));
  if (!fields.ok) return null;
  const inOld = path.basename(path.dirname(absPath)).toLowerCase() === 'old';
  const jobDir = inOld ? path.dirname(path.dirname(absPath)) : path.dirname(absPath);
  const versions = await listVersions(jobDir);
  let best = null;
  for (const v of versions) {
    const f = v.fields;
    if (!f || f.draft || f.model !== fields.model || f.filament !== fields.filament) continue;
    if (f.version >= fields.version) continue;
    if (!best || f.version > best.version || (f.version === best.version && !v.archived)) best = v;
  }
  return best ? best.path : null;
}

/**
 * Finalize a draft: centre the part on the bed (unless `centre: false`), then
 * `..._v3-draft.gcode` -> `..._v3-<what changed>_<time>.gcode`, then move the
 * older finals of the same model into old\.
 */
export async function finalizeDraft({ path: p, note, timeSec, centre = true }) {
  const abs = await safeResolveReal(p);
  if (!contains(ARCHIVE_ROOT, abs)) throw new HttpError(403, 'target is outside the Archive tree');
  const fields = parseJobFilename(path.basename(abs));
  if (!fields.ok || !fields.draft) throw new HttpError(422, 'only a ..._vN-draft.gcode file can be finalized');
  const slug = slugifyChange(note, '');
  if (!slug) throw new HttpError(400, 'say what changed -- it becomes the <what-changed> part of the name');

  const dir = path.dirname(abs);
  const name = formatJobFilename({ ...fields, draft: false, changed: slug, time: formatTimeField(timeSec) });
  const target = path.join(dir, name);
  if (await exists(target)) throw new HttpError(409, 'refusing to overwrite an existing file: ' + name);

  // Centre the part on the bed (user, 2026-09-16). The draft sat where the
  // final it came from sits, so the diff worked; the shift goes into
  // old\v<N>-steps\align.json so later diffs can undo it.
  let centred = null;
  if (centre) {
    const { centreFile } = await import('./centre.js');
    centred = await centreFile({ path: abs, finalName: name, alignedWith: await baseOf(abs), dryRun: false });
  }
  await rename(abs, target);

  const moved = [];
  await mkdir(path.join(dir, 'old'), { recursive: true });
  for (const v of await listVersions(dir)) {
    const f = v.fields;
    if (v.archived || !f || f.draft || f.model !== fields.model || f.filament !== fields.filament) continue;
    if (f.version >= fields.version) continue;
    const from = path.join(dir, v.name);
    const to = path.join(dir, 'old', v.name);
    if (await exists(to)) continue; // never clobber; leave it visible instead
    await rename(from, to);
    moved.push(relPath(to));
  }
  return { ok: true, path: relPath(target), name, moved, centred };
}
