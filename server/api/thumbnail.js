/**
 * thumbnail.js -- POST /api/thumbnail: embed a printer-screen preview into a
 * G-code file, as a new version.
 *
 * body: { path, png?, dryRun? = true }  -- dryRun:false is required to write
 *   png     optional PNG data URL (e.g. captured from the app's 3D view). When
 *           absent the server renders one itself (server/thumbnail-render.js).
 *
 * Adding a preview changes the file, so it follows the same rule as any edit:
 * never in place -- a new version `..._v<n+1>-thumbnail_<time>.gcode`, with the
 * previous file moved to old\. The toolpath is checked to be byte-for-byte the
 * same afterwards: only the header blocks may change.
 */

import zlib from 'node:zlib';
import path from 'node:path';
import { parseGcode } from '../../src/parser/parse.js';
import { injectThumbnails, stripThumbnails } from '../../src/thumbnail/inject.js';
import { decodePNG } from '../../src/thumbnail/png.js';
import { renderThumbnail } from '../thumbnail-render.js';
import { HttpError, parseFile, invalidate, relPath } from './files.js';
import { commitVersion, planVersion, listVersions } from './version.js';

const MAX_PNG_BYTES = 8 * 1024 * 1024;

/** Build the new file text without writing anything. */
export function buildWithThumbnail(text, parsed, png) {
  let img;
  let source;
  if (png) {
    const m = /^data:image\/png;base64,(.+)$/s.exec(String(png));
    if (!m) throw new HttpError(400, 'png must be a data:image/png;base64 URL');
    const bytes = Buffer.from(m[1], 'base64');
    if (bytes.length > MAX_PNG_BYTES) throw new HttpError(413, 'png is too large');
    const d = decodePNG(new Uint8Array(bytes), { inflate: zlib.inflateSync });
    if (d.width < 160 || d.height < 160) throw new HttpError(400, 'png must be at least 160x160');
    img = { rgba: d.rgba, width: d.width, height: d.height };
    source = 'app capture';
  } else {
    img = renderThumbnail(parsed);
    if (!img.drawn) throw new HttpError(422, 'nothing to draw: the file has no model extrusion');
    source = 'server render';
  }

  const out = injectThumbnails(text, img.rgba, img.width, img.height, { deflate: zlib.deflateSync });

  // The toolpath must be untouched. Compare with the thumbnail blocks removed
  // from both sides, so a file that already had a preview still compares equal.
  if (stripThumbnails(out) !== stripThumbnails(text)) {
    throw new HttpError(500, 'thumbnail injection changed more than the preview blocks - refusing to write');
  }
  const check = parseGcode(out);
  if (check.count !== parsed.count ||
      Math.abs(check.meta.filamentUsedMm - parsed.meta.filamentUsedMm) > 1e-6) {
    throw new HttpError(500, 'the file no longer parses to the same toolpath - refusing to write');
  }
  return { text: out, source, bytesAdded: Buffer.byteLength(out) - Buffer.byteLength(text) };
}

export async function handleThumbnail(body) {
  const p = body?.path;
  const dryRun = body?.dryRun !== false; // DEFAULT: dry run, like /api/edit
  const src = await parseFile(p);
  // A server render of the same toolpath is the same image, so re-running it
  // on a file that already has a preview would only mint an identical version.
  // Replacing it with a different image (an app capture) is still allowed.
  if (!body?.png && stripThumbnails(src.text) !== src.text) {
    throw new HttpError(409, 'this file already has a printer preview');
  }
  const built = buildWithThumbnail(src.text, src.parsed, body?.png);
  const timeSec = src.parsed.meta.estimatedTimeSec;
  const versions = await listVersions(path.dirname(src.abs));

  let outPath = null;
  try {
    const plan = planVersion({ currentPath: src.abs, changed: 'thumbnail', timeSec, versions });
    outPath = relPath(plan.newPath);
  } catch (e) {
    throw new HttpError(422, 'cannot version this file: ' + e.message);
  }

  const result = {
    ok: true, dryRun, written: false, file: relPath(src.abs), outPath,
    source: built.source, bytesAdded: built.bytesAdded,
  };
  if (dryRun) return result;

  const commit = await commitVersion({
    currentPath: src.abs, text: built.text, changed: 'thumbnail', timeSec, versions,
  });
  invalidate(src.abs);
  result.written = true;
  result.outPath = commit.newPath;
  result.commit = commit;
  return result;
}
