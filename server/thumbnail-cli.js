/**
 * thumbnail-cli.js -- add a printer-screen preview to a G-code file from the
 * terminal. Works whether or not the HTTP server is running.
 *
 *   node server/thumbnail-cli.js <path> [--dry] [--png out.png]
 *
 *   <path>      G-code path relative to the Archive folder,
 *               e.g. phonecase-17pro/EN4Max_..._v1-ironed_49m.gcode
 *   --dry       say what would be written, write nothing
 *   --png FILE  also save the 320x320 preview as a PNG to look at
 *
 * Writes the preview into the job's draft (..._v<n+1>-draft.gcode, the step
 * saved in old\v<n+1>-steps\), exactly like an edit made in the app. The
 * final stays where it is; finalize the draft to name it.
 */

import { writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { handleThumbnail } from './api/thumbnail.js';
import { parseFile } from './api/files.js';
import { renderThumbnail } from './thumbnail-render.js';
import { fitRGBA } from '../src/thumbnail/inject.js';
import { encodePNG } from '../src/thumbnail/png.js';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry');
const pngAt = args.indexOf('--png');
const pngOut = pngAt >= 0 ? args[pngAt + 1] : null;

if (!target) {
  console.error('usage: node server/thumbnail-cli.js <path> [--dry] [--png out.png]');
  process.exit(2);
}

try {
  if (pngOut) {
    const src = await parseFile(target);
    const img = renderThumbnail(src.parsed);
    const small = fitRGBA(img.rgba, img.width, img.height, 320);
    writeFileSync(pngOut, encodePNG(small, 320, 320, { deflate: zlib.deflateSync }));
    console.log('preview saved   ' + pngOut);
  }
  const r = await handleThumbnail({ path: target, dryRun });
  console.log((r.written ? 'written         ' : 'would write     ') + r.outPath);
  console.log('from            ' + r.file);
  console.log('size added      ' + (r.bytesAdded / 1024).toFixed(1) + ' KB');
  if (r.commit && r.commit.archivedPath) console.log('archived        ' + r.commit.archivedPath);
} catch (e) {
  console.error('failed: ' + e.message);
  process.exit(1);
}
