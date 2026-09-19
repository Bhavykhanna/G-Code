// Minimal PNG encode/decode, plus a self-contained DEFLATE compressor.
//
// Everything here is pure data in / data out so it runs unchanged in Node and in the
// browser. The environment-specific compressor is injectable:
//
//   Node    encodePNG(rgba, w, h, { deflate: (u8) => zlib.deflateSync(u8) })
//           decodePNG(bytes,      { inflate: (u8) => zlib.inflateSync(u8) })
//   Browser encodePNG(rgba, w, h)                       // built-in fixed-Huffman deflate
//           or canvas.toBlob() / ctx.drawImage()        // if you would rather not
//
// With no options encodePNG still produces a valid PNG; it is simply a little larger
// than zlib's, because the built-in compressor only emits fixed-Huffman blocks.

// ---------------------------------------------------------------------------
// CRC32 / Adler32
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf, start = 0, end = buf.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(buf) {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------------------------------------------------------------------------
// DEFLATE (fixed Huffman, LZ77 with a hash chain)
// ---------------------------------------------------------------------------

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59,
  67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
  4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385,
  513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8,
  9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

class BitWriter {
  constructor() {
    this.buf = new Uint8Array(1 << 16);
    this.len = 0;
    this.bit = 0;
    this.acc = 0;
  }

  _grow(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  /** n bits of `value`, least significant bit first (DEFLATE stream order). */
  bits(value, n) {
    this.acc |= (value & ((1 << n) - 1)) << this.bit;
    this.bit += n;
    while (this.bit >= 8) {
      this._grow(1);
      this.buf[this.len++] = this.acc & 255;
      this.acc >>>= 8;
      this.bit -= 8;
    }
  }

  /** A Huffman code: stored most significant bit first, so reverse it. */
  huff(code, n) {
    let r = 0;
    for (let i = 0; i < n; i++) r |= ((code >> (n - 1 - i)) & 1) << i;
    this.bits(r, n);
  }

  finish() {
    if (this.bit > 0) {
      this._grow(1);
      this.buf[this.len++] = this.acc & 255;
      this.acc = 0;
      this.bit = 0;
    }
    return this.buf.subarray(0, this.len);
  }
}

function writeLiteral(w, sym) {
  if (sym < 144) w.huff(0x30 + sym, 8);
  else w.huff(0x190 + sym - 144, 9);
}

/** Raw DEFLATE stream, single fixed-Huffman block. */
export function deflateRaw(input) {
  const w = new BitWriter();
  w.bits(1, 1); // BFINAL
  w.bits(1, 2); // BTYPE = 01, fixed Huffman

  const n = input.length;
  const WSIZE = 32768;
  const head = new Int32Array(1 << 15).fill(-1);
  const prev = new Int32Array(n > 0 ? n : 1).fill(-1);
  const hashAt = (i) => ((input[i] << 10) ^ (input[i + 1] << 5) ^ input[i + 2]) & 0x7fff;

  let i = 0;
  while (i < n) {
    let bestLen = 0, bestDist = 0;
    if (i + 3 <= n) {
      let chain = head[hashAt(i)];
      let tries = 0;
      const maxLen = Math.min(258, n - i);
      while (chain >= 0 && tries++ < 48) {
        const dist = i - chain;
        if (dist <= 0 || dist > WSIZE) break;
        if (input[chain + bestLen] === input[i + bestLen]) {
          let l = 0;
          while (l < maxLen && input[chain + l] === input[i + l]) l++;
          if (l > bestLen) { bestLen = l; bestDist = dist; if (l === maxLen) break; }
        }
        chain = prev[chain];
      }
    }

    const emitted = bestLen >= 3 ? bestLen : 1;
    if (bestLen >= 3) {
      let code = 0;
      while (code < 28 && LEN_BASE[code + 1] <= bestLen) code++;
      // Fixed Huffman: symbols 256..279 are 7 bits (0x00..0x17), 280..287 are 8 bits
      // (0xC0..0xC7). Length symbol is 257 + code.
      if (code <= 22) w.huff(code + 1, 7);
      else w.huff(0xc0 + (code - 23), 8);
      if (LEN_EXTRA[code]) w.bits(bestLen - LEN_BASE[code], LEN_EXTRA[code]);
      let dc = 0;
      while (dc < 29 && DIST_BASE[dc + 1] <= bestDist) dc++;
      w.huff(dc, 5);
      if (DIST_EXTRA[dc]) w.bits(bestDist - DIST_BASE[dc], DIST_EXTRA[dc]);
    } else {
      writeLiteral(w, input[i]);
    }
    for (let k = 0; k < emitted; k++) {
      const j = i + k;
      if (j + 3 <= n) {
        const h = hashAt(j);
        prev[j] = head[h];
        head[h] = j;
      }
    }
    i += emitted;
  }
  w.huff(0, 7); // end of block
  return w.finish();
}

/** zlib container around deflateRaw. */
export function deflateZlib(input) {
  const body = deflateRaw(input);
  const out = new Uint8Array(body.length + 6);
  out[0] = 0x78;
  out[1] = 0x01;
  out.set(body, 2);
  const a = adler32(input);
  out[out.length - 4] = (a >>> 24) & 255;
  out[out.length - 3] = (a >>> 16) & 255;
  out[out.length - 2] = (a >>> 8) & 255;
  out[out.length - 1] = a & 255;
  return out;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Prefix each scanline with filter byte 0 (None) -- what the raw IDAT data looks like. */
export function pngScanlines(rgba, width, height) {
  const stride = width * 4;
  const out = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    out[y * (stride + 1)] = 0;
    out.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return out;
}

/** Same, but with the Paeth filter (5) -- much friendlier to the compressor. */
export function pngScanlinesPaeth(rgba, width, height) {
  const stride = width * 4;
  const bpp = 4;
  const out = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    out[o] = 4;
    for (let x = 0; x < stride; x++) {
      const raw = rgba[y * stride + x];
      const a = x >= bpp ? rgba[y * stride + x - bpp] : 0;
      const b = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? rgba[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out[o + 1 + x] = (raw - pred) & 255;
    }
  }
  return out;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length), false);
  return out;
}

function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * 8-bit RGBA PNG.
 * @param {Uint8Array|Uint8ClampedArray} rgba width*height*4
 * @param {{deflate?:(u8:Uint8Array)=>Uint8Array}} [opts] pass zlib.deflateSync for
 *        smaller output; the default is the built-in fixed-Huffman compressor.
 * @returns {Uint8Array}
 */
export function encodePNG(rgba, width, height, opts = {}) {
  if (rgba.length < width * height * 4) throw new Error('encodePNG: rgba too short');
  const deflate = opts.deflate || deflateZlib;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width, false);
  dv.setUint32(4, height, false);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const raw = pngScanlinesPaeth(rgba, width, height);
  const idat = deflate(raw);
  return concat([
    Uint8Array.from(PNG_SIG),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat instanceof Uint8Array ? idat : new Uint8Array(idat)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/**
 * Non-interlaced, 8-bit PNG decoder. Handles colour types 0/2/3/4/6.
 * @param {Uint8Array} bytes
 * @param {{inflate:(u8:Uint8Array)=>Uint8Array}} opts inflate is required, e.g.
 *        `{ inflate: (u8) => zlib.inflateSync(u8) }`.
 * @returns {{width:number,height:number,rgba:Uint8Array}}
 */
export function decodePNG(bytes, opts = {}) {
  const inflate = opts.inflate;
  if (typeof inflate !== 'function') throw new Error('decodePNG: opts.inflate is required');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) throw new Error('decodePNG: not a PNG');

  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  let palette = null, trns = null;
  const idat = [];
  while (off + 8 <= bytes.length) {
    const len = dv.getUint32(off, false);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(off + 8, false);
      height = dv.getUint32(off + 12, false);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('decodePNG: interlaced PNG unsupported');
      if (bitDepth !== 8) throw new Error(`decodePNG: bit depth ${bitDepth} unsupported`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    off += 12 + len;
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`decodePNG: colour type ${colorType} unsupported`);
  const raw = new Uint8Array(inflate(concat(idat)));
  const stride = width * channels;
  const px = new Uint8Array(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prevRow = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prevRow ? prevRow[x] : 0;
      const c = x >= channels && prevRow ? prevRow[x - channels] : 0;
      let v = raw[pos + x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 255; break;
        case 2: v = (v + b) & 255; break;
        case 3: v = (v + ((a + b) >> 1)) & 255; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
          break;
        }
        default: throw new Error(`decodePNG: filter ${filter} unsupported`);
      }
      cur[x] = v;
    }
    pos += stride;
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let r, g, b, a = 255;
    if (colorType === 0) { r = g = b = px[i]; }
    else if (colorType === 2) { r = px[i * 3]; g = px[i * 3 + 1]; b = px[i * 3 + 2]; }
    else if (colorType === 3) {
      const p = px[i];
      r = palette[p * 3]; g = palette[p * 3 + 1]; b = palette[p * 3 + 2];
      if (trns && p < trns.length) a = trns[p];
    } else if (colorType === 4) { r = g = b = px[i * 2]; a = px[i * 2 + 1]; }
    else { r = px[i * 4]; g = px[i * 4 + 1]; b = px[i * 4 + 2]; a = px[i * 4 + 3]; }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { width, height, rgba };
}
