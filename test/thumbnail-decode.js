/**
 * Decode the ColPic thumbnails out of a GUI-sliced G-code file and check them against
 * the base64 PNG thumbnail sitting in the same file. Both are the same render, so if
 * our ColPic decoder is right the two images agree pixel for pixel.
 *
 *   node test/thumbnail-decode.js [file.gcode] [--png <outdir>]
 *
 * `--png <outdir>` also writes decoded-gimage.png / decoded-simage.png so you can look
 * at them. Looking at them is the only real proof the format is understood.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { argv } from 'node:process';

import {
  decodeColPic, rgbaToRgb565, rgb565ToRgb, COLPIC_MAGIC, COLPIC_HEADER_SIZE,
  colPicStringToBytes,
} from '../src/thumbnail/colpic.js';
import { decodePNG, encodePNG } from '../src/thumbnail/png.js';
import { extractColPic } from '../src/thumbnail/inject.js';

const GUI_FILE = argv.find((a) => a.endsWith('.gcode'))
  || '../EN4Max_0.4_3DBenchy_PLA0.25_21m42s.gcode';
const PNG_OUT = argv.includes('--png') ? argv[argv.indexOf('--png') + 1] : null;

const HEAD_BYTES = 64 * 1024; // the thumbnails always live in the first few KB

function guiHead() {
  return readFileSync(GUI_FILE, 'latin1').slice(0, HEAD_BYTES);
}

function referencePng(text) {
  let on = false, b64 = '';
  for (const line of text.split('\n')) {
    if (/^; thumbnail begin/.test(line)) { on = true; continue; }
    if (/^; thumbnail end/.test(line)) break;
    if (on) b64 += line.slice(2);
  }
  assert.ok(b64.length > 0, 'no base64 thumbnail block in the reference file');
  return decodePNG(Buffer.from(b64, 'base64'), { inflate: (u) => inflateSync(u) });
}

if (!existsSync(GUI_FILE)) {
  console.log(`skip: ${GUI_FILE} not found (needs a GUI-sliced file with thumbnails)`);
} else {
  const text = guiHead();

  test('header fields are the documented ColPic head', () => {
    for (const [tag, size] of [['gimage', 320], ['simage', 160]]) {
      const bytes = colPicStringToBytes(extractColPic(text, tag));
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      assert.equal(dv.getUint32(0, true), 3, `${tag} encodeVer`);
      assert.equal(dv.getUint32(4, true), size, `${tag} width`);
      assert.equal(dv.getUint32(8, true), size, `${tag} height`);
      assert.equal(dv.getUint32(12, true), COLPIC_MAGIC, `${tag} magic`);
      assert.equal(dv.getUint32(24, true), 0, `${tag} reserved`);
      assert.equal(dv.getUint32(28, true), 0, `${tag} reserved`);
      const paletteBytes = dv.getUint32(16, true);
      const dataBytes = dv.getUint32(20, true);
      assert.equal(paletteBytes % 2, 0);
      // header + palette + rle, then padded up to the next multiple of 3
      const total = COLPIC_HEADER_SIZE + paletteBytes + dataBytes;
      assert.equal(bytes.length, total + (3 - (total % 3)), `${tag} 3-byte padding`);
    }
  });

  test('gimage decodes to a 320x320 image', () => {
    const im = decodeColPic(extractColPic(text, 'gimage'));
    assert.equal(im.width, 320);
    assert.equal(im.height, 320);
    assert.equal(im.rgba.length, 320 * 320 * 4);
    assert.ok(im.palette.length > 1 && im.palette.length <= 1024);
    assert.equal(im.palette[0], 0xffff, 'palette is frequency sorted, background first');
    if (PNG_OUT) {
      mkdirSync(PNG_OUT, { recursive: true });
      writeFileSync(join(PNG_OUT, 'decoded-gimage.png'),
        encodePNG(im.rgba, im.width, im.height, { deflate: (u) => deflateSync(u, { level: 9 }) }));
    }
  });

  test('simage matches the base64 PNG thumbnail in the same file', () => {
    const im = decodeColPic(extractColPic(text, 'simage'));
    const ref = referencePng(text);
    assert.equal(im.width, ref.width);
    assert.equal(im.height, ref.height);

    // The PNG keeps the transparent background; ColPic is the same render flattened
    // onto white and quantised to RGB565. Put the PNG through the same treatment.
    const flat = rgbaToRgb565(ref.rgba, ref.width * ref.height);
    let exact = 0, maxDelta = 0;
    for (let i = 0; i < flat.length; i++) {
      const [r, g, b] = rgb565ToRgb(flat[i]);
      const d = Math.abs(r - im.rgba[i * 4]) + Math.abs(g - im.rgba[i * 4 + 1])
        + Math.abs(b - im.rgba[i * 4 + 2]);
      if (d === 0) exact++;
      if (d > maxDelta) maxDelta = d;
    }
    const pct = (100 * exact) / flat.length;
    console.log(`  simage vs reference PNG: ${pct.toFixed(2)} % exact, worst channel-sum delta ${maxDelta}`);
    // The handful of misses are antialiased silhouette pixels where the slicer
    // composited in the renderer rather than from 8-bit RGBA, so they round differently.
    assert.ok(pct > 99, `expected >99 % exact pixels, got ${pct.toFixed(2)} %`);
    assert.ok(maxDelta <= 48, `expected only rounding-scale differences, got ${maxDelta}`);

    if (PNG_OUT) {
      mkdirSync(PNG_OUT, { recursive: true });
      writeFileSync(join(PNG_OUT, 'decoded-simage.png'),
        encodePNG(im.rgba, im.width, im.height, { deflate: (u) => deflateSync(u, { level: 9 }) }));
    }
  });

  test('the two ColPic images are the same picture at two sizes', () => {
    const big = decodeColPic(extractColPic(text, 'gimage'));
    const small = decodeColPic(extractColPic(text, 'simage'));
    // Compare on a coarse 16x16 grid so resampling differences do not matter.
    let sum = 0;
    for (let gy = 0; gy < 16; gy++) {
      for (let gx = 0; gx < 16; gx++) {
        const bo = ((gy * 20 + 10) * big.width + gx * 20 + 10) * 4;
        const so = ((gy * 10 + 5) * small.width + gx * 10 + 5) * 4;
        sum += Math.abs(big.rgba[bo] - small.rgba[so])
          + Math.abs(big.rgba[bo + 1] - small.rgba[so + 1])
          + Math.abs(big.rgba[bo + 2] - small.rgba[so + 2]);
      }
    }
    const mean = sum / (16 * 16 * 3);
    console.log(`  gimage vs simage mean channel difference on a 16x16 grid: ${mean.toFixed(2)}`);
    assert.ok(mean < 12, `images differ too much (${mean.toFixed(2)})`);
  });
}
