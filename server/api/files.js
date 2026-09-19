/**
 * files.js -- job discovery, path safety, file reading and the parse cache.
 *
 * This module is the ONLY place that decides what is inside the sandbox.
 * Everything that touches a user-supplied path goes through `safeResolve`.
 *
 * The sandbox root is the Archive folder (one level above the project), because
 * that is where the job folders live. Nothing outside it is readable or
 * writable through the API, ever.
 */
import { readFile, readdir, stat, realpath, open } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGcode } from '../../src/parser/parse.js';
import { parseJobFilename } from './version.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `<archive>\gcode-studio` -- the app itself. */
export const PROJECT_ROOT = path.resolve(HERE, '..', '..');

/**
 * The sandbox root: the folder whose subfolders are the jobs. Normally that is
 * simply the folder above the app, because the app lives in `Archive\gcode-studio\`.
 *
 * A clone that is not inside a print archive (a fresh `git clone` anywhere, a
 * second machine) would make that the drive root -- which finds no jobs, since
 * they would be three levels down, and puts a recursive watch on everything.
 * So the parent is a default, not a law; it can be pointed somewhere else:
 *
 *   1. `GCS_ARCHIVE`, for one run;
 *   2. `.gcs-archive` next to the app -- one line, the path. Git-ignored, so it
 *      stays on the machine that needs it and changes nothing anywhere else;
 *   3. the folder above the app.
 *
 * On a machine that has the print archive, none of the first two exist and this
 * is exactly what it always was. A clone with no archive can point it at
 * `demo\` and have a real job to open.
 */
function resolveArchiveRoot() {
  const fromEnv = (process.env.GCS_ARCHIVE || '').trim();
  if (fromEnv) return path.resolve(PROJECT_ROOT, fromEnv);
  try {
    const fromFile = readFileSync(path.join(PROJECT_ROOT, '.gcs-archive'), 'utf8').trim();
    if (fromFile) return path.resolve(PROJECT_ROOT, fromFile);
  } catch { /* not there: the normal case */ }
  return path.resolve(PROJECT_ROOT, '..');
}

/** `<archive>` -- the sandbox root. Nothing above this is reachable. */
export const ARCHIVE_ROOT = resolveArchiveRoot();

/** Folders under the Archive root that are never jobs. */
const SKIP_DIRS = new Set([
  'gcode-studio', '__MACOSX', 'node_modules', 'phonecase-slicing', '3.Model',
]);

/** An error carrying an HTTP status, so routing can turn it into a response. */
export class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// path safety
// ---------------------------------------------------------------------------

/**
 * Resolve a client-supplied path against the Archive root and refuse anything
 * that escapes it.
 *
 * Accepts either a path relative to the Archive root (`phonecase-17pro/x.gcode`,
 * the form the UI uses) or an absolute path that already lives inside it.
 * Both `/` and `\` separators work.
 *
 * Guards, in order:
 *   1. type / empty / NUL byte
 *   2. lexical containment after `path.resolve` (kills `..\..\..\Windows`)
 *   3. real containment after `realpath` when the file exists (kills a symlink
 *      or junction inside the Archive that points out of it)
 */
export function safeResolve(p, { mustExist = false } = {}) {
  if (typeof p !== 'string' || p.length === 0) {
    throw new HttpError(400, 'path is required');
  }
  if (p.includes('\0')) throw new HttpError(400, 'path contains a NUL byte');

  const abs = path.resolve(ARCHIVE_ROOT, p);
  if (!contains(ARCHIVE_ROOT, abs)) {
    throw new HttpError(403, 'path is outside the Archive tree', { path: p, root: ARCHIVE_ROOT });
  }
  if (mustExist) return abs; // caller calls safeResolveReal for the strict form
  return abs;
}

/** `safeResolve` plus a realpath check. Async because realpath is. */
export async function safeResolveReal(p) {
  const abs = safeResolve(p);
  let real;
  try {
    real = await realpath(abs);
  } catch {
    return abs; // does not exist yet -- lexical check already passed
  }
  if (!contains(ARCHIVE_ROOT, real)) {
    throw new HttpError(403, 'path resolves (via a link) outside the Archive tree');
  }
  return real;
}

/** True when `child` is `parent` or below it. Case-insensitive on win32. */
export function contains(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Archive-relative, forward-slashed -- the form the API speaks. */
export function relPath(abs) {
  return path.relative(ARCHIVE_ROOT, abs).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/** Read a text file inside the sandbox. */
export async function readText(p) {
  const abs = await safeResolveReal(p);
  try {
    return { abs, text: await readFile(abs, 'utf8') };
  } catch (e) {
    if (e.code === 'ENOENT') throw new HttpError(404, 'file not found: ' + relPath(abs));
    throw new HttpError(500, e.message);
  }
}

/**
 * Read the last `bytes` of a file without loading the whole thing.
 * Used to pull the footer (time / filament) out of a 3 MB G-code file --
 * the stats sit just above the ~25 KB CONFIG_BLOCK, so 128 KB is plenty.
 */
export async function readTail(abs, bytes = 131072) {
  const fh = await open(abs, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, bytes);
    const buf = Buffer.allocUnsafe(len);
    await fh.read(buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Pull the slicer's own footer numbers out of a tail string. */
export function footerStats(tail) {
  const grab = (re) => {
    const m = re.exec(tail);
    return m ? m[1].trim() : null;
  };
  const timeText = grab(/; estimated printing time \(normal mode\) = (.+)/);
  return {
    timeText,
    timeSec: timeText ? durationToSec(timeText) : 0,
    filamentMm: num(grab(/; filament used \[mm\] = (.+)/)),
    filamentCm3: num(grab(/; filament used \[cm3\] = (.+)/)),
    filamentG: num(grab(/; filament used \[g\] = (.+)/)),
    layerCount: num(grab(/; total layers count = (.+)/)),
  };
}
const num = (s) => (s == null ? 0 : Number(s));

/** "1h 11m 5s" -> seconds. Same grammar as the parser's parseDuration. */
export function durationToSec(text) {
  const unit = { d: 86400, h: 3600, m: 60, s: 1 };
  let t = 0;
  for (const m of String(text).matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/g)) t += +m[1] * unit[m[2]];
  return t;
}

// ---------------------------------------------------------------------------
// parse cache
// ---------------------------------------------------------------------------
// A parse result for the 17 Pro file is ~7 MB of typed arrays and takes ~120 ms.
// Cache by path + mtime + size so an edit, a validate and a diff of the same
// file in one request all share one parse, and re-parse automatically when
// Claude writes a new version from the terminal.

const CACHE_MAX = 4;
const cache = new Map(); // abs -> { key, result, text }

function cacheKey(st) {
  return st.mtimeMs + ':' + st.size;
}

/**
 * Parse a G-code file, cached. Returns `{ abs, key, text, parsed }`.
 * `text` is kept alongside so edit.js does not read the file twice.
 */
export async function parseFile(p) {
  const abs = await safeResolveReal(p);
  let st;
  try {
    st = await stat(abs);
  } catch {
    throw new HttpError(404, 'file not found: ' + relPath(abs));
  }
  const key = cacheKey(st);
  const hit = cache.get(abs);
  if (hit && hit.key === key) {
    cache.delete(abs);
    cache.set(abs, hit); // refresh LRU position
    return hit;
  }
  const text = await readFile(abs, 'utf8');
  const parsed = parseGcode(text);
  const entry = { abs, key, text, parsed, mtimeMs: st.mtimeMs, size: st.size };
  cache.set(abs, entry);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return entry;
}

/** Drop a file from the parse cache (called after a write). */
export function invalidate(abs) {
  cache.delete(abs);
}

/**
 * The /api/meta payload: everything the parse produced EXCEPT `segments`.
 * The typed arrays are 7 MB and the browser gets them from its own worker
 * parse; the server only needs to answer "what is in this file".
 */
export function slimParse(parsed) {
  return {
    meta: parsed.meta,
    config: parsed.config,
    layers: parsed.layers,
    warnings: parsed.warnings,
    count: parsed.count,
    relativeE: parsed.relativeE,
    timeScale: parsed.timeScale,
    parseMs: parsed.parseMs,
  };
}

// ---------------------------------------------------------------------------
// job discovery
// ---------------------------------------------------------------------------

/**
 * A job folder is any immediate subdirectory of the Archive root that holds at
 * least one `.gcode` (current or in `old\`). The definition is deliberately
 * loose so that a new job folder is picked up without registering it anywhere.
 */
export async function listJobs() {
  const out = [];
  let entries;
  try {
    entries = await readdir(ARCHIVE_ROOT, { withFileTypes: true });
  } catch (e) {
    throw new HttpError(500, 'cannot read the Archive root: ' + e.message);
  }
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    if (SKIP_DIRS.has(d.name) || d.name.startsWith('.')) continue;
    const dir = path.join(ARCHIVE_ROOT, d.name);
    const job = await describeJob(dir);
    if (job && (job.gcode.length || job.old.length)) { out.push(job); continue; }
    // A model folder groups its version folders
    // (`v1 final\`, `v2 wire-gap\`): look one level down.
    for (const sub of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!sub.isDirectory() || sub.name.startsWith('.') || sub.name.toLowerCase() === 'old') continue;
      const inner = await describeJob(path.join(dir, sub.name));
      if (inner && (inner.gcode.length || inner.old.length)) {
        inner.name = d.name + ' / ' + sub.name;
        out.push(inner);
      }
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Describe one job folder. `dir` must already be inside the sandbox. */
export async function describeJob(dir) {
  let files;
  try {
    files = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const gcode = [];
  const stl = [];
  let hasOld = false;
  const profiles = { machine: false, process: false, filament: false };
  let readme = false;

  for (const f of files) {
    if (f.isDirectory()) {
      if (f.name.toLowerCase() === 'old') hasOld = true;
      continue;
    }
    const lower = f.name.toLowerCase();
    if (lower.endsWith('.gcode')) gcode.push(await describeGcode(path.join(dir, f.name), false));
    else if (lower.endsWith('.stl')) stl.push(await describeStl(path.join(dir, f.name)));
    else if (lower === 'machine.json') profiles.machine = true;
    else if (lower === 'process.json') profiles.process = true;
    else if (lower === 'filament.json') profiles.filament = true;
    else if (lower === 'readme.md') readme = true;
  }

  const old = [];
  if (hasOld) {
    const oldDir = path.join(dir, 'old');
    for (const f of await readdir(oldDir, { withFileTypes: true }).catch(() => [])) {
      if (f.isFile() && f.name.toLowerCase().endsWith('.gcode')) {
        old.push(await describeGcode(path.join(oldDir, f.name), true));
      }
    }
  }

  const byVersion = (a, b) => (a.version ?? -1) - (b.version ?? -1) || a.mtime - b.mtime;
  gcode.sort(byVersion);
  old.sort(byVersion);

  return {
    name: path.basename(dir),
    path: relPath(dir),
    absPath: dir,
    gcode,
    old,
    stl,
    profiles: { ...profiles, allPresent: profiles.machine && profiles.process && profiles.filament },
    readme,
    hasOldDir: hasOld,
    // The file to open by default: the highest-version current G-code.
    current: gcode.length ? gcode[gcode.length - 1].path : null,
  };
}

async function describeGcode(abs, archived) {
  const st = await stat(abs);
  const parsedName = parseJobFilename(path.basename(abs));
  return {
    name: path.basename(abs),
    path: relPath(abs),
    size: st.size,
    mtime: st.mtimeMs,
    archived,
    convention: parsedName.ok,
    version: parsedName.ok ? parsedName.version : null,
    model: parsedName.ok ? parsedName.model : null,
    filament: parsedName.ok ? parsedName.filament : null,
    layerHeight: parsedName.ok ? parsedName.layerHeight : null,
    changed: parsedName.ok ? parsedName.changed : null,
    time: parsedName.ok ? parsedName.time : null,
  };
}

async function describeStl(abs) {
  const st = await stat(abs);
  return { name: path.basename(abs), path: relPath(abs), size: st.size, mtime: st.mtimeMs };
}

/** Resolve a job by folder name (or Archive-relative path) to its description. */
export async function getJob(nameOrPath) {
  if (typeof nameOrPath !== 'string' || !nameOrPath.length) {
    throw new HttpError(400, 'job is required');
  }
  const abs = await safeResolveReal(nameOrPath);
  let st;
  try {
    st = await stat(abs);
  } catch {
    throw new HttpError(404, 'no such job folder: ' + nameOrPath);
  }
  const dir = st.isDirectory() ? abs : path.dirname(abs);
  const job = await describeJob(dir);
  if (!job) throw new HttpError(404, 'no such job folder: ' + nameOrPath);
  return job;
}
