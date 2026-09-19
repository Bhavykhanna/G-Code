// ColPic ("COLPIC") thumbnail codec used by Elegoo / Chitu printer screens.
//
// This is the format behind the `;gimage:` and `;simage:` lines that ElegooSlicer's
// GUI writes at the top of a G-code file. The Neptune 4 Max screen reads those lines
// directly; without them the print tile is blank.
//
// Pure data in / pure data out: no DOM, no node: imports. Runs in Node and the browser.
//
// Binary layout (little endian):
//   0x00 u32  encodeVer    always 3
//   0x04 u32  width
//   0x08 u32  height
//   0x0C u32  magic        0x05DDC33C
//   0x10 u32  paletteBytes (= colorCount * 2)
//   0x14 u32  dataBytes    (length of the RLE stream)
//   0x18 u32  reserved 0
//   0x1C u32  reserved 0
//   0x20 ...  palette: u16 RGB565, sorted by descending pixel count
//   ...       RLE stream, see byte8bitEncode/byte8bitDecode below
//
// The binary is then re-coded 3 bytes -> 4 chars in a 6-bit alphabet (see below).

export const COLPIC_MAGIC = 0x05ddc33c;
export const COLPIC_HEADER_SIZE = 32;
export const COLPIC_ENCODE_VER = 3;
/** Hard ceiling from the reference encoder: a palette index must fit in sid(5)+tid(5). */
export const COLPIC_MAX_COLORS = 1024;

// ---------------------------------------------------------------------------
// 6-bit character codec
// ---------------------------------------------------------------------------
// Alphabet is ASCII 48..111 ('0'..'o') with 92 ('\') swapped for 126 ('~'),
// because a backslash inside a G-code comment is an escape hazard.

function valToChar(v) {
  const c = v + 48;
  return String.fromCharCode(c === 92 ? 126 : c);
}

function charToVal(code) {
  const c = code === 126 ? 92 : code;
  const v = c - 48;
  return v < 0 || v > 63 ? -1 : v;
}

/** Pack bytes (length must be a multiple of 3) into the 6-bit alphabet. */
export function bytesToColPicString(bytes) {
  let out = '';
  for (let i = 0; i + 2 < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += valToChar(b0 >> 2);
    out += valToChar(((b0 & 3) << 4) | (b1 >> 4));
    out += valToChar(((b1 & 15) << 2) | (b2 >> 6));
    out += valToChar(b2 & 63);
  }
  return out;
}

/** Unpack a 6-bit-alphabet string back into bytes. Characters outside the set are skipped. */
export function colPicStringToBytes(str) {
  const out = new Uint8Array(Math.floor(str.length / 4) * 3);
  let n = 0, acc = 0, have = 0;
  for (let i = 0; i < str.length; i++) {
    const v = charToVal(str.charCodeAt(i));
    if (v < 0) continue;
    acc = (acc << 6) | v;
    if (++have === 4) {
      out[n++] = (acc >>> 16) & 255;
      out[n++] = (acc >>> 8) & 255;
      out[n++] = acc & 255;
      acc = 0;
      have = 0;
    }
  }
  return out.subarray(0, n);
}

// ---------------------------------------------------------------------------
// RGB565
// ---------------------------------------------------------------------------

export function rgb565(r, g, b) {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

export function rgb565ToRgb(c) {
  const r5 = (c >> 11) & 31, g6 = (c >> 5) & 63, b5 = c & 31;
  // Replicate the high bits downwards so 31 -> 255; standard 565 expansion.
  return [(r5 << 3) | (r5 >> 2), (g6 << 2) | (g6 >> 4), (b5 << 3) | (b5 >> 2)];
}

/**
 * RGBA -> RGB565, compositing over an opaque background first.
 *
 * ElegooSlicer renders the preview on transparency (that is what lands in the PNG
 * thumbnail) but the ColPic palette of the reference file starts with 0xFFFF and its
 * first run is exactly the number of transparent pixels, i.e. the ColPic image is the
 * same render flattened onto white.
 */
export function rgbaToRgb565(rgba, count, bg = [255, 255, 255]) {
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const a = rgba[i * 4 + 3] / 255;
    const r = Math.round(rgba[i * 4] * a + bg[0] * (1 - a));
    const g = Math.round(rgba[i * 4 + 1] * a + bg[1] * (1 - a));
    const b = Math.round(rgba[i * 4 + 2] * a + bg[2] * (1 - a));
    out[i] = rgb565(r, g, b);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/**
 * Build the palette the way the reference encoder does:
 *  - colours in first-appearance order with occurrence counts
 *  - insertion-sorted by count descending, using `>=` as the test, which puts equal
 *    counts in REVERSE first-appearance order (comparator below reproduces that)
 *  - anything past `colorsMax` merged into its nearest survivor, rarest first,
 *    distance = |dr| + |dg| + |db| measured in 5/6/5 space
 *
 * Deviation from the reference, deliberate: the reference stops collecting after the
 * 1024th distinct colour and silently maps every later colour to palette slot 0. We
 * collect all distinct colours and then merge down. Output is identical whenever the
 * image has <= colorsMax distinct colours (every ElegooSlicer preview so far), and
 * merely correct instead of speckled when it has more.
 */
function buildPalette(pixels565, colorsMax) {
  const index = new Map();
  const colors = [];
  const counts = [];
  for (let i = 0; i < pixels565.length; i++) {
    const c = pixels565[i];
    const slot = index.get(c);
    if (slot === undefined) {
      index.set(c, colors.length);
      colors.push(c);
      counts.push(1);
    } else {
      counts[slot]++;
    }
  }

  const order = colors.map((_, i) => i);
  order.sort((a, b) => (counts[b] - counts[a]) || (b - a));
  const palette = order.map((i) => colors[i]);

  const remap = new Map();
  while (palette.length > colorsMax) {
    const victim = palette[palette.length - 1];
    const vr = (victim >> 11) & 31, vg = (victim >> 5) & 63, vb = victim & 31;
    let best = Infinity, bestIdx = 0;
    for (let i = 0; i < colorsMax; i++) {
      const c = palette[i];
      const d = Math.abs(((c >> 11) & 31) - vr)
        + Math.abs(((c >> 5) & 63) - vg)
        + Math.abs((c & 31) - vb);
      if (d < best) { best = d; bestIdx = i; }
    }
    remap.set(victim, palette[bestIdx]);
    palette.pop();
  }

  const slotOf = new Map();
  palette.forEach((c, i) => slotOf.set(c, i));
  for (const [from, to] of remap) slotOf.set(from, slotOf.get(to));

  const indices = new Uint16Array(pixels565.length);
  for (let i = 0; i < pixels565.length; i++) indices[i] = slotOf.get(pixels565[i]);
  return { palette, indices };
}

// ---------------------------------------------------------------------------
// RLE ("Byte8bitEncode" in the reference)
// ---------------------------------------------------------------------------
//
// A palette index splits into sid = index >> 5 (bank) and tid = index & 31.
// The decoder holds a current bank, initially 0.
//
//   0xE0 | sid       switch current bank to sid          1 byte,  sid 0..31
//   dots<<5 | tid    run of `dots` pixels, dots 1..6     1 byte,  0x20..0xDF
//   0x00 | tid, n    run of n pixels, n 7..255           2 bytes, first byte 0x00..0x1F
//
// dots == 7 is never emitted as a one-byte token, so 0xE0..0xFF is unambiguously a
// bank switch. Runs never exceed 255 pixels and cross scanlines freely: the image is
// one flat left-to-right, top-to-bottom stream of width*height pixels.

function byte8bitEncode(indices, out) {
  let src = 0, left = indices.length, lastid = 0;
  while (left > 0) {
    let dots = 1;
    for (let i = 0; i < left - 1; i++) {
      if (indices[src + i] !== indices[src + i + 1]) break;
      dots++;
      if (dots === 255) break;
    }
    const temp = indices[src];
    const tid = temp % 32;
    const sid = Math.floor(temp / 32);
    if (lastid !== sid) {
      out.push(0xe0 + sid);
      lastid = sid;
    }
    if (dots <= 6) {
      out.push((dots << 5) + tid);
    } else {
      out.push(tid);
      out.push(dots);
    }
    src += dots;
    left -= dots;
  }
}

function byte8bitDecode(data, dotsqty) {
  const indices = new Uint16Array(dotsqty);
  let p = 0, i = 0, lastid = 0;
  while (i < data.length && p < dotsqty) {
    const b = data[i++];
    if (b >= 0xe0) { lastid = b & 31; continue; }
    const tid = b & 31;
    let dots = b >> 5;
    if (dots === 0) {
      if (i >= data.length) break;
      dots = data[i++];
    }
    const idx = lastid * 32 + tid;
    for (let k = 0; k < dots && p < dotsqty; k++) indices[p++] = idx;
  }
  if (p < dotsqty) throw new Error(`ColPic RLE short: ${p} of ${dotsqty} pixels`);
  return indices;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {Uint8Array|Uint8ClampedArray} rgba width*height*4 bytes
 * @param {number} width
 * @param {number} height
 * @param {{colorsMax?:number, background?:number[]}} [opts]
 * @returns {string} the payload that goes after `;gimage:` / `;simage:`
 */
export function encodeColPic(rgba, width, height, opts = {}) {
  const colorsMax = Math.min(opts.colorsMax ?? COLPIC_MAX_COLORS, COLPIC_MAX_COLORS);
  const dots = width * height;
  if (rgba.length < dots * 4) throw new Error('encodeColPic: rgba shorter than width*height*4');

  const pixels565 = rgbaToRgb565(rgba, dots, opts.background ?? [255, 255, 255]);
  const { palette, indices } = buildPalette(pixels565, colorsMax);

  const rle = [];
  byte8bitEncode(indices, rle);

  const paletteBytes = palette.length * 2;
  const total = COLPIC_HEADER_SIZE + paletteBytes + rle.length;
  // The reference always pads to the NEXT multiple of 3 -- `temp = 3 - qty % 3` yields
  // 3, not 0, when already aligned. Reproduce it or the string length drifts from the
  // GUI's.
  const padded = total + (3 - (total % 3));
  const buf = new Uint8Array(padded);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, COLPIC_ENCODE_VER, true);
  dv.setUint32(4, width, true);
  dv.setUint32(8, height, true);
  dv.setUint32(12, COLPIC_MAGIC, true);
  dv.setUint32(16, paletteBytes, true);
  dv.setUint32(20, rle.length, true);
  for (let i = 0; i < palette.length; i++) {
    dv.setUint16(COLPIC_HEADER_SIZE + i * 2, palette[i], true);
  }
  buf.set(rle, COLPIC_HEADER_SIZE + paletteBytes);

  return bytesToColPicString(buf);
}

/**
 * @param {string} str payload from one or more `;gimage:` / `;simage:` lines, concatenated
 * @returns {{width:number,height:number,rgba:Uint8Array,palette:number[]}}
 */
export function decodeColPic(str) {
  const bytes = colPicStringToBytes(str);
  if (bytes.length < COLPIC_HEADER_SIZE) throw new Error('ColPic: truncated header');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ver = dv.getUint32(0, true);
  const width = dv.getUint32(4, true);
  const height = dv.getUint32(8, true);
  const magic = dv.getUint32(12, true);
  const paletteBytes = dv.getUint32(16, true);
  const dataBytes = dv.getUint32(20, true);
  if (magic !== COLPIC_MAGIC) throw new Error(`ColPic: bad magic 0x${magic.toString(16)}`);
  if (ver !== COLPIC_ENCODE_VER) throw new Error(`ColPic: unsupported encodeVer ${ver}`);
  if (!width || !height || width * height > (1 << 24)) throw new Error('ColPic: bad dimensions');

  const palette = [];
  for (let i = 0; i < paletteBytes / 2; i++) {
    palette.push(dv.getUint16(COLPIC_HEADER_SIZE + i * 2, true));
  }
  const dataStart = COLPIC_HEADER_SIZE + paletteBytes;
  const data = bytes.subarray(dataStart, dataStart + dataBytes);

  const indices = byte8bitDecode(data, width * height);
  const rgba = new Uint8Array(width * height * 4);
  const lut = palette.map(rgb565ToRgb);
  for (let i = 0; i < indices.length; i++) {
    const c = lut[indices[i]] || [0, 0, 0];
    rgba[i * 4] = c[0];
    rgba[i * 4 + 1] = c[1];
    rgba[i * 4 + 2] = c[2];
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba, palette };
}
