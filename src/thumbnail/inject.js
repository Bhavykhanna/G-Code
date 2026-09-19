// Inject ElegooSlicer-style thumbnails into G-code.
//
// The GUI puts three previews at the very top of the file, before everything else.
// Slicing from the CLI writes none of them (no GL context headless), so the Neptune 4
// Max screen shows a blank tile. This module reproduces the GUI's output byte for byte:
//
//   ;gimage:<1015 chars>            x N      320x320 ColPic, screen's large preview
//   ;;gimage:<rest>                          note the doubled ';' on the LAST data line
//   ;0000...                                 zero pad, block ends on a 1024-byte boundary
//   ;simage:<1015 chars>            x N      160x160 ColPic, screen's list/small preview
//   ;;simage:<rest>
//   ;0000...
//   <blank>
//   ; THUMBNAIL_BLOCK_START
//   <blank>
//   ;
//   ; thumbnail begin 160x160 <base64 length>
//   ; <78 base64 chars>             x N      standard PrusaSlicer/OrcaSlicer PNG block
//   ; thumbnail end
//   ; THUMBNAIL_BLOCK_END
//   <blank>
//
// Then the file's original content follows unchanged. Verified against
// EN4Max_0.4_3DBenchy_PLA0.25_21m42s.gcode, sliced by the ElegooSlicer GUI.

import { encodeColPic } from './colpic.js';
import { encodePNG } from './png.js';

/** Payload characters per `;gimage:` / `;simage:` line. Line is 8 + 1015 = 1023 chars. */
export const COLPIC_LINE_CHARS = 1015;
/** Each ColPic block is zero-padded so its byte length is a multiple of this. */
export const COLPIC_BLOCK_ALIGN = 1024;
/** Base64 characters per `; ` line inside the PNG block. */
export const PNG_LINE_CHARS = 78;

export const DEFAULT_SIZES = { gimage: 320, simage: 160, png: 160 };

const BLOCK_START = '; THUMBNAIL_BLOCK_START';
const BLOCK_END = '; THUMBNAIL_BLOCK_END';

// ---------------------------------------------------------------------------
// base64 (no Buffer / btoa, so this works in Node and the browser alike)
// ---------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64Encode(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Image fitting
// ---------------------------------------------------------------------------

/**
 * Scale RGBA into a size x size square, preserving aspect ratio and centring on a
 * transparent background. Downscaling is a box average over premultiplied alpha;
 * upscaling degenerates to nearest neighbour, which is fine for previews.
 */
export function fitRGBA(src, sw, sh, size) {
  const out = new Uint8Array(size * size * 4);
  const scale = Math.min(size / sw, size / sh);
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const ox = (size - dw) >> 1;
  const oy = (size - dh) >> 1;

  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * sw + xx) * 4;
          const al = src[o + 3];
          r += src[o] * al;
          g += src[o + 1] * al;
          b += src[o + 2] * al;
          a += al;
          n++;
        }
      }
      const o = ((y + oy) * size + (x + ox)) * 4;
      out[o] = a ? Math.round(r / a) : 0;
      out[o + 1] = a ? Math.round(g / a) : 0;
      out[o + 2] = a ? Math.round(b / a) : 0;
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block formatting
// ---------------------------------------------------------------------------

/**
 * Wrap a ColPic payload into `;gimage:` / `;simage:` lines and zero-pad the block to a
 * 1024-byte boundary. The last data line carries a doubled `;;` prefix -- that is what
 * the GUI writes, and the padding line count depends on it, so do not "fix" it.
 */
export function formatColPicBlock(tag, payload, eol = '\n') {
  let text = '';
  const chunks = Math.max(1, Math.ceil(payload.length / COLPIC_LINE_CHARS));
  for (let i = 0; i < chunks; i++) {
    const chunk = payload.substr(i * COLPIC_LINE_CHARS, COLPIC_LINE_CHARS);
    text += (i === chunks - 1 ? ';;' : ';') + tag + ':' + chunk + eol;
  }
  const minPad = 1 + eol.length; // ';' + eol
  const target = COLPIC_BLOCK_ALIGN * Math.ceil((text.length + minPad) / COLPIC_BLOCK_ALIGN);
  const pad = target - text.length;
  return text + ';' + '0'.repeat(pad - minPad) + eol;
}

/** The PrusaSlicer/OrcaSlicer `; thumbnail begin ... ; thumbnail end` block. */
export function formatPngBlock(pngBytes, width, height, eol = '\n') {
  const b64 = base64Encode(pngBytes);
  let text = `; thumbnail begin ${width}x${height} ${b64.length}${eol}`;
  for (let i = 0; i < b64.length; i += PNG_LINE_CHARS) {
    text += '; ' + b64.substr(i, PNG_LINE_CHARS) + eol;
  }
  return text + '; thumbnail end' + eol;
}

// ---------------------------------------------------------------------------
// Strip / inject
// ---------------------------------------------------------------------------

/**
 * Remove every thumbnail artefact this module (or the GUI) may have written, leaving
 * the rest of the file untouched. Applying this to a GUI-sliced file yields exactly
 * the same leading bytes as the CLI-sliced equivalent.
 *
 * It does NOT touch the `; thumbnails = ...` / `; thumbnails_format = ...` config lines
 * in the footer -- those are settings, not payload.
 */
export function stripThumbnails(gcodeText) {
  const eol = gcodeText.includes('\r\n') ? '\r\n' : '\n';
  const lines = gcodeText.split(/\r?\n/);
  const out = [];
  let i = 0;
  let justLeftColPic = false;

  while (i < lines.length) {
    const line = lines[i];

    if (/^;{1,2}(gimage|simage):/.test(line)) {
      i++;
      if (i < lines.length && /^;0*$/.test(lines[i])) i++; // block's zero padding
      justLeftColPic = true;
      continue;
    }
    if (justLeftColPic) {
      justLeftColPic = false;
      if (line === '') { i++; continue; } // blank line the GUI leaves after the blocks
    }

    if (line.trim() === BLOCK_START) {
      while (i < lines.length && lines[i].trim() !== BLOCK_END) i++;
      if (i < lines.length) i++;
      if (i < lines.length && lines[i] === '') i++;
      continue;
    }
    if (/^;\s*thumbnail begin\b/.test(line)) {
      while (i < lines.length && !/^;\s*thumbnail end\b/.test(lines[i])) i++;
      if (i < lines.length) i++;
      continue;
    }

    out.push(line);
    i++;
  }
  return out.join(eol);
}

/** Concatenated payload of a `;gimage:` / `;simage:` block, or '' if absent. */
export function extractColPic(gcodeText, tag) {
  const re = new RegExp('^;{1,2}' + tag + ':(.*)$');
  let payload = '';
  for (const line of gcodeText.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) payload += m[1];
    else if (payload) break; // blocks are contiguous
  }
  return payload;
}

/**
 * @param {string} gcodeText
 * @param {Uint8Array|Uint8ClampedArray} rgba preview pixels, width*height*4
 * @param {number} width
 * @param {number} height
 * @param {{deflate?:Function, sizes?:{gimage:number,simage:number,png:number}}} [opts]
 *        `deflate` is handed to encodePNG; pass `zlib.deflateSync` in Node for a
 *        smaller PNG block. Omit it and the built-in compressor is used.
 * @returns {string} new G-code text
 */
export function injectThumbnails(gcodeText, rgba, width, height, opts = {}) {
  if (!width || !height) throw new Error('injectThumbnails: width/height required');
  if (rgba.length < width * height * 4) throw new Error('injectThumbnails: rgba too short');

  const sizes = { ...DEFAULT_SIZES, ...(opts.sizes || {}) };
  const body = stripThumbnails(gcodeText);
  const eol = gcodeText.includes('\r\n') ? '\r\n' : '\n';

  const big = fitRGBA(rgba, width, height, sizes.gimage);
  const small = fitRGBA(rgba, width, height, sizes.simage);
  const forPng = sizes.png === sizes.simage ? small : fitRGBA(rgba, width, height, sizes.png);

  const header =
    formatColPicBlock('gimage', encodeColPic(big, sizes.gimage, sizes.gimage), eol)
    + formatColPicBlock('simage', encodeColPic(small, sizes.simage, sizes.simage), eol)
    + eol
    + BLOCK_START + eol
    + eol
    + ';' + eol
    + formatPngBlock(encodePNG(forPng, sizes.png, sizes.png, { deflate: opts.deflate }),
      sizes.png, sizes.png, eol)
    + BLOCK_END + eol
    + eol;

  return header + body;
}
