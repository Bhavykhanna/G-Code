/**
 * Round-trip and byte-for-byte layout checks for the thumbnail writer.
 *
 *   node test/thumbnail-roundtrip.js [gui.gcode] [cli.gcode]
 *
 * The strong claim this file defends: re-encoding the GUI's own 320x320 and 160x160
 * ColPic images reproduces their payload strings character for character, and the
 * `;gimage:` / `;simage:` blocks we emit are byte-identical to the GUI's, padding
 * included. Nothing here writes to the project's G-code files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argv } from 'node:process';

import { decodeColPic, encodeColPic } from '../src/thumbnail/colpic.js';
import { encodePNG, decodePNG, deflateZlib } from '../src/thumbnail/png.js';
import {
  injectThumbnails, stripThumbnails, extractColPic, formatColPicBlock, base64Encode,
} from '../src/thumbnail/inject.js';

const files = argv.filter((a) => a.endsWith('.gcode'));
const GUI_FILE = files[0] || '../EN4Max_0.4_3DBenchy_PLA0.25_21m42s.gcode';
const CLI_FILE = files[1]
  || '../phonecase-17pro/old/EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v1-ironed_49m.gcode';

const haveGui = existsSync(GUI_FILE);
const guiHead = haveGui ? readFileSync(GUI_FILE, 'latin1').slice(0, 64 * 1024) : '';

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

test('ColPic re-encodes the GUI payloads character for character', { skip: !haveGui }, () => {
  for (const tag of ['gimage', 'simage']) {
    const payload = extractColPic(guiHead, tag);
    assert.ok(payload.length > 0, `${tag} missing from ${GUI_FILE}`);
    const im = decodeColPic(payload);
    const again = encodeColPic(im.rgba, im.width, im.height);
    assert.equal(again.length, payload.length, `${tag} payload length`);
    assert.equal(again, payload, `${tag} payload is not byte-identical`);
    console.log(`  ${tag}: ${im.width}x${im.height}, ${im.palette.length} colours, ` +
      `${payload.length} chars, re-encode identical`);
  }
});

test('decode(encode(image)) is lossless for images already in RGB565', { skip: !haveGui }, () => {
  const im = decodeColPic(extractColPic(guiHead, 'gimage'));
  const back = decodeColPic(encodeColPic(im.rgba, im.width, im.height));
  assert.deepEqual(Array.from(back.rgba), Array.from(im.rgba));
});

test('synthetic images survive the round trip', () => {
  const cases = [
    { w: 8, h: 8, f: (x, y) => [x * 32, y * 32, 0, 255] },                 // gradient
    { w: 64, h: 1, f: () => [255, 255, 255, 255] },                        // one long run
    { w: 40, h: 40, f: (x, y) => [(x * 7) & 255, (y * 11) & 255, 0, 255] },
    { w: 16, h: 16, f: (x, y) => ((x + y) & 1 ? [0, 0, 0, 255] : [255, 255, 255, 255]) },
    { w: 4, h: 4, f: () => [0, 0, 0, 0] },                                 // fully transparent
  ];
  for (const { w, h, f } of cases) {
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [r, g, b, a] = f(x, y);
        const o = (y * w + x) * 4;
        rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
      }
    }
    const im = decodeColPic(encodeColPic(rgba, w, h));
    assert.equal(im.width, w);
    assert.equal(im.height, h);
    // Encoding quantises to RGB565 over white, so compare against that, not the input.
    const ref = decodeColPic(encodeColPic(im.rgba, w, h));
    assert.deepEqual(Array.from(ref.rgba), Array.from(im.rgba), `${w}x${h} not stable`);
  }
});

test('runs longer than 255 px and palettes wider than 32 colours are handled', () => {
  const w = 300, h = 4;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    // >32 distinct colours forces bank-switch tokens; row 0 is one 300 px run.
    const v = i < w ? 0 : (i % 200) * 1;
    rgba[i * 4] = v & 255;
    rgba[i * 4 + 1] = (v * 3) & 255;
    rgba[i * 4 + 2] = (v * 7) & 255;
    rgba[i * 4 + 3] = 255;
  }
  const im = decodeColPic(encodeColPic(rgba, w, h));
  assert.ok(im.palette.length > 32, 'test needs a multi-bank palette');
  const again = decodeColPic(encodeColPic(im.rgba, w, h));
  assert.deepEqual(Array.from(again.rgba), Array.from(im.rgba));
});

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

test('PNG encode/decode round trip, with both compressors', () => {
  const w = 37, h = 23;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = i & 255;
    rgba[i * 4 + 1] = (i * 5) & 255;
    rgba[i * 4 + 2] = (i * 13) & 255;
    rgba[i * 4 + 3] = i % 9 === 0 ? 0 : 255;
  }
  for (const deflate of [undefined, (u) => deflateSync(u), deflateZlib]) {
    const png = encodePNG(rgba, w, h, { deflate });
    const back = decodePNG(png, { inflate: (u) => inflateSync(u) });
    assert.equal(back.width, w);
    assert.equal(back.height, h);
    assert.deepEqual(Array.from(back.rgba), Array.from(rgba));
  }
});

test('the built-in deflate produces a stream node:zlib accepts', () => {
  const data = new Uint8Array(40000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31) % 7 === 0 ? 0 : i & 255;
  assert.deepEqual(Array.from(inflateSync(Buffer.from(deflateZlib(data)))), Array.from(data));
});

test('base64Encode agrees with Buffer', () => {
  for (const len of [0, 1, 2, 3, 4, 5, 255, 1000]) {
    const b = new Uint8Array(len);
    for (let i = 0; i < len; i++) b[i] = (i * 37) & 255;
    assert.equal(base64Encode(b), Buffer.from(b).toString('base64'), `len ${len}`);
  }
});

// ---------------------------------------------------------------------------
// G-code block layout
// ---------------------------------------------------------------------------

test('our ColPic blocks are byte-identical to the GUI blocks', { skip: !haveGui }, () => {
  // Slice the GUI's own bytes for each block and compare against what we would write.
  const lines = guiHead.split('\n');
  for (const tag of ['gimage', 'simage']) {
    const first = lines.findIndex((l) => l.startsWith(`;${tag}:`));
    let last = first;
    while (last + 1 < lines.length
      && (lines[last + 1].startsWith(`;${tag}:`) || lines[last + 1].startsWith(`;;${tag}:`))) last++;
    // plus the zero padding line that closes the block
    assert.match(lines[last + 1], /^;0+$/, `${tag} padding line`);
    const original = lines.slice(first, last + 2).join('\n') + '\n';
    const ours = formatColPicBlock(tag, extractColPic(guiHead, tag));
    assert.equal(ours.length, original.length, `${tag} block byte length`);
    assert.equal(ours, original, `${tag} block bytes`);
    assert.equal(original.length % 1024, 0, `${tag} block is 1024-byte aligned`);
    console.log(`  ${tag} block: ${original.length} bytes (${original.length / 1024} KiB), identical`);
  }
});

test('stripping a GUI file leaves exactly what the CLI would have written', { skip: !haveGui }, () => {
  const stripped = stripThumbnails(guiHead);
  assert.ok(!stripped.includes(';gimage:'));
  assert.ok(!stripped.includes(';simage:'));
  assert.ok(!stripped.includes('THUMBNAIL_BLOCK'));
  assert.ok(!stripped.includes('; thumbnail begin'));
  assert.ok(stripped.startsWith('\n\n; HEADER_BLOCK_START\n'),
    `unexpected head: ${JSON.stringify(stripped.slice(0, 40))}`);
  // the settings lines are configuration, not payload: they must survive
  const full = readFileSync(GUI_FILE, 'latin1');
  assert.ok(full.includes('; thumbnails = '));
  assert.ok(stripThumbnails(full).includes('; thumbnails = '));
});

test('inject reproduces the GUI file layout, and changes nothing else', { skip: !haveGui }, () => {
  const im = decodeColPic(extractColPic(guiHead, 'gimage'));
  const body = stripThumbnails(guiHead);
  const out = injectThumbnails(body, im.rgba, im.width, im.height,
    { deflate: (u) => deflateSync(u, { level: 9 }) });

  // The 320x320 block is reproduced exactly: same payload, same wrapping, same padding.
  // The 160x160 block cannot be, because we downsample the 320 capture whereas the GUI
  // renders 160 natively -- so only its framing is checked, below.
  const gEnd = guiHead.indexOf(';simage:');
  assert.equal(out.slice(0, gEnd), guiHead.slice(0, gEnd),
    'gimage section differs from the GUI output');

  // Same framing everywhere else (the PNG bytes depend on the compressor).
  const classify = (l) => (
    /^;{1,2}(gimage|simage):/.test(l) ? `<${l.split(':')[0]}>`
      : /^;0+$/.test(l) ? '<pad>'
        : /^; thumbnail begin /.test(l) ? '; thumbnail begin'
          : /^; [A-Za-z0-9+/=]+$/.test(l) ? '<b64>' : l);
  const shape = (s) => {
    const acc = [];
    for (const l of s.split('\n')) {
      const t = classify(l);
      if (acc[acc.length - 1] !== t) acc.push(t);
    }
    return acc;
  };
  assert.deepEqual(
    shape(out.slice(0, out.indexOf('; HEADER_BLOCK_START'))),
    shape(guiHead.slice(0, guiHead.indexOf('; HEADER_BLOCK_START'))),
  );

  // And the body is untouched.
  assert.equal(stripThumbnails(out), body);
});

test('inject is idempotent and replaces rather than duplicates', { skip: !haveGui }, () => {
  const im = decodeColPic(extractColPic(guiHead, 'simage'));
  const once = injectThumbnails(guiHead, im.rgba, im.width, im.height);
  const twice = injectThumbnails(once, im.rgba, im.width, im.height);
  assert.equal(once, twice);
  assert.equal(once.split('; THUMBNAIL_BLOCK_START').length - 1, 1);
  assert.equal(once.split('; thumbnail begin').length - 1, 1);
});

test('inject into a real CLI-sliced file (temp copy only)', { skip: !existsSync(CLI_FILE) }, () => {
  const cli = readFileSync(CLI_FILE, 'latin1');
  assert.ok(!cli.includes(';gimage:'), 'CLI file unexpectedly already has thumbnails');

  const w = 320, h = 320;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = (i / w) | 0;
    const inside = (x - 160) ** 2 + (y - 160) ** 2 < 120 * 120;
    rgba[i * 4] = inside ? 32 : 0;
    rgba[i * 4 + 1] = inside ? 150 : 0;
    rgba[i * 4 + 2] = inside ? 210 : 0;
    rgba[i * 4 + 3] = inside ? 255 : 0;
  }

  const out = injectThumbnails(cli, rgba, w, h, { deflate: (u) => deflateSync(u, { level: 9 }) });
  assert.equal(out.slice(out.indexOf('\n\n; HEADER_BLOCK_START')), cli.slice(cli.indexOf('\n\n; HEADER_BLOCK_START')),
    'injection modified the original body');
  assert.equal(stripThumbnails(out), cli, 'strip(inject(x)) !== x');

  // The blocks the printer reads must land at the very start, 1024-aligned.
  assert.ok(out.startsWith(';gimage:'));
  const gEnd = out.indexOf(';simage:');
  assert.equal(gEnd % 1024, 0, 'gimage block is not 1024-byte aligned');
  // The blank line before THUMBNAIL_BLOCK_START sits on the byte after the last block.
  const blank = out.indexOf('\n; THUMBNAIL_BLOCK_START');
  assert.equal(blank % 1024, 0, 'simage block is not 1024-byte aligned');

  // Decoding what we wrote gives the circle back.
  const back = decodeColPic(extractColPic(out, 'gimage'));
  assert.equal(back.width, 320);
  const mid = (160 * 320 + 160) * 4;
  assert.ok(Math.abs(back.rgba[mid + 2] - 210) < 12, 'centre pixel lost its colour');
  const corner = 0;
  assert.equal(back.rgba[corner], 255, 'transparent background should flatten to white');

  const dir = mkdtempSync(join(tmpdir(), 'gcode-thumb-'));
  const path = join(dir, 'injected.gcode');
  writeFileSync(path, out, 'latin1');
  console.log(`  wrote ${(out.length / 1024 / 1024).toFixed(2)} MB to ${path} ` +
    `(+${((out.length - cli.length) / 1024).toFixed(1)} KB of thumbnail)`);
});
