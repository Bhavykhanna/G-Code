/**
 * slice.js -- Lane B: hand the job back to ElegooSlicer.
 *
 * G-code is the slicer's output, not a model. Anything geometric (wall count,
 * line width, infill, layer height, brim, supports, ironing) cannot be edited
 * in Lane A and has to come back through here. A full re-slice of the 17 Pro
 * model takes ~1.4-2.2 s and is byte-identical given identical inputs, so this
 * is always the right answer rather than a last resort.
 *
 * Verified invocation (see ..\..\context\slicing.md):
 *
 *   elegoo-slicer.exe --load-settings "<machine.json>;<process.json>"
 *                     --load-filaments "<filament.json>"
 *                     --slice 0 --outputdir "<dir>" "<model.stl>"
 *
 * Output always lands at <dir>\plate_1.gcode regardless of the model name.
 *
 * The binary is a GUI program. `spawn` + waiting for 'close' works (measured
 * exit 0 in 1358 ms from Node), but it must be waited on properly -- a
 * fire-and-forget spawn returns before the file exists.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, stat, readFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGcode } from '../../src/parser/parse.js';
import { HttpError, getJob, safeResolveReal, relPath, slimParse, ARCHIVE_ROOT } from './files.js';
import { validate } from './validate.js';
import { commitVersion, listVersions } from './version.js';

/** The profile a job falls back to when it has none of its own (profiles\README.md). */
const DEFAULT_PROFILE_DIR = fileURLToPath(new URL('../../profiles/default/', import.meta.url));

export const SLICER_EXE = process.env.GCS_SLICER
  || 'C:\\Program Files\\ElegooSlicer\\elegoo-slicer.exe';

/**
 * Windows reports a negative process exit code as an unsigned 32-bit value, so
 * Node hands back 4294967279 where the documentation (and the slicer) say -17.
 * Everything downstream uses the signed form.
 */
export function signedExit(code) {
  if (code == null) return null;
  return code > 0x7fffffff ? code - 0x100000000 : code;
}

/** Exit codes we have actually hit, and what they mean. */
export const EXIT_CODES = {
  0: { ok: true, meaning: 'sliced' },
  '-5': {
    ok: false,
    meaning: 'the slicer could not load one of the profiles (wrong kind of JSON, or malformed)',
    fix: 'check that --load-settings got a machine profile and a process profile, in that order, '
      + 'and --load-filaments a filament profile',
  },
  '-17': {
    ok: false,
    meaning: 'profile not compatible with the printer',
    fix: 'the machine profile must be named exactly "Elegoo Neptune 4 Max 0.4 nozzle" with "from": "system", '
      + 'and the process and filament profiles need compatible_printers: ["Elegoo Neptune 4 Max 0.4 nozzle"]',
  },
  '-51': {
    ok: false,
    meaning: 'incomplete profiles -- "Add G92 E0 to layer_gcode"',
    fix: 'the CLI does not resolve a profile\'s `inherits` parent, so the system JSONs cannot be loaded directly; '
      + 'use the complete profiles that live in the job folder',
  },
};

const DEFAULT_TIMEOUT_MS = 180000;

// The slicer is a single GUI binary writing into a shared config directory, so
// two concurrent invocations are asking for trouble. One at a time.
let queue = Promise.resolve();
function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/**
 * POST /api/slice
 * body: { job, stl?, profiles?: {machine, process, filament}, commit?, note?, timeoutMs? }
 * -> { ok, exitCode, ms, outPath, meta, stdout, stderr, hint?, validation?, commit? }
 */
export async function handleSlice(body) {
  const jobName = body?.job;
  if (!jobName) throw new HttpError(400, 'job is required (a folder name under the Archive root)');
  const job = await getJob(jobName);
  const jobDir = job.absPath;

  // ---- model --------------------------------------------------------------
  let stl;
  if (body.stl) {
    stl = await safeResolveReal(body.stl);
  } else if (job.stl.length === 1) {
    stl = path.join(ARCHIVE_ROOT, job.stl[0].path.split('/').join(path.sep));
  } else if (job.stl.length === 0) {
    throw new HttpError(400, `job "${job.name}" has no .stl; pass stl explicitly`);
  } else {
    throw new HttpError(400, `job "${job.name}" has ${job.stl.length} .stl files; pass stl explicitly`,
      { candidates: job.stl.map((s) => s.path) });
  }
  await assertFile(stl, 'stl');

  // ---- profiles -----------------------------------------------------------
  // The job's own copies come first -- they are what makes an old version
  // reproducible. A job that has none (a new model) falls back to the tuned
  // default in `profiles\default\`, the tuned reference profile; see
  // profiles\README.md for every value in it and why.
  const pf = body.profiles || {};
  const pick = async (given, name) => {
    if (given) return safeResolveReal(given);
    const inJob = path.join(jobDir, name);
    return safeResolveReal((await isFile(inJob)) ? inJob : path.join(DEFAULT_PROFILE_DIR, name));
  };
  const machine = await pick(pf.machine, 'machine.json');
  const process_ = await pick(pf.process, 'process.json');
  const filament = await pick(pf.filament, 'filament.json');
  for (const [p, what] of [[machine, 'machine.json'], [process_, 'process.json'], [filament, 'filament.json']]) {
    await assertFile(p, what);
  }

  // ---- output dir ---------------------------------------------------------
  // Deliberately OUTSIDE the job folder: a slice is a proposal, not a version.
  // It only enters the job folder through commitVersion, which archives the old
  // current file first.
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'gcode-studio-slice-'));

  const args = [
    '--load-settings', `${machine};${process_}`,
    '--load-filaments', filament,
    '--slice', '0',
    '--outputdir', outDir,
    stl,
  ];

  // The slicer drops a `00000.log` into its working directory when it fails, so
  // it is run FROM the temp output dir rather than from wherever the server was
  // started -- otherwise it litters the project root.
  const timeoutMs = Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const run = await serialize(() => spawnSlicer(args, timeoutMs, outDir));

  // ... and that log is the only place the real reason appears. Surface it.
  let slicerLog = '';
  try { slicerLog = (await readFile(path.join(outDir, '00000.log'), 'utf8')).slice(-4000); } catch { /* no log = no failure */ }

  const outPath = path.join(outDir, 'plate_1.gcode');
  let produced = false;
  try { produced = (await stat(outPath)).size > 0; } catch { /* not produced */ }

  const exitCode = signedExit(run.exitCode);
  const known = EXIT_CODES[String(exitCode)];
  const result = {
    ok: exitCode === 0 && produced,
    exitCode,
    rawExitCode: run.exitCode,
    signal: run.signal,
    ms: run.ms,
    timedOut: run.timedOut,
    cmd: [SLICER_EXE, ...args],
    outPath: produced ? outPath : null,
    outDir,
    stdout: run.stdout.slice(-8000),
    stderr: run.stderr.slice(-8000),
    slicerLog,
    hint: known && !known.ok ? known.fix : (exitCode !== 0 ? 'unrecognised exit code; check stderr' : undefined),
    meaning: known ? known.meaning : undefined,
    inputs: { stl: relPath(stl), machine: relPath(machine), process: relPath(process_), filament: relPath(filament) },
    meta: null,
    validation: null,
  };

  if (!result.ok) {
    if (exitCode === 0 && !produced) {
      result.hint = 'the slicer exited cleanly but produced no plate_1.gcode -- check that the STL is inside the bed';
    }
    return result;
  }

  const text = await readFile(outPath, 'utf8');
  const parsed = parseGcode(text);
  result.meta = slimParse(parsed);
  result.validation = validate(text, { parsed });
  result.bytes = Buffer.byteLength(text);

  // Optional, off by default: promote the slice into the job folder as the new
  // current version. Safety rule 3 says a write needs explicit confirmation, so
  // the caller has to ask for it and supply the "<what-changed>" note.
  if (body.commit) {
    if (!body.note || !String(body.note).trim()) {
      throw new HttpError(400, 'commit requires a note -- it becomes the "<what-changed>" field of the new filename');
    }
    if (!result.validation.ok) {
      throw new HttpError(422, 'the sliced output failed validation, nothing was committed', { errors: result.validation.errors });
    }
    const current = job.current
      ? path.join(ARCHIVE_ROOT, job.current.split('/').join(path.sep))
      : null;
    if (!current) throw new HttpError(409, 'the job has no current G-code to version from; name the first file by hand');
    const versions = await listVersions(jobDir);
    result.commit = await commitVersion({
      currentPath: current, text, changed: body.note,
      timeSec: parsed.meta.estimatedTimeSec, versions,
    });
  }

  return result;
}

async function isFile(p) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function assertFile(p, what) {
  try {
    const st = await stat(p);
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    throw new HttpError(404, `${what} not found: ${p}`);
  }
}

function spawnSlicer(args, timeoutMs, cwd) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let stdout = '', stderr = '', timedOut = false, settled = false;
    let child;
    try {
      child = spawn(SLICER_EXE, args, { windowsHide: true, cwd });
    } catch (e) {
      return resolve({ exitCode: null, signal: null, ms: 0, stdout: '', stderr: 'spawn failed: ' + e.message, timedOut: false });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* already gone */ }
    }, timeoutMs);

    child.stdout.on('data', (d) => { if (stdout.length < 200000) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 200000) stderr += d; });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, ms: Date.now() - t0, stdout, stderr: stderr + '\nspawn error: ' + e.message, timedOut });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, signal, ms: Date.now() - t0, stdout, stderr, timedOut });
    });
  });
}
