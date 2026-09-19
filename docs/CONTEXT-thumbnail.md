# Thumbnail context

Owns `src/thumbnail/`. Part of [G-code Studio](../CONTEXT.md).

Generates the print preview the Neptune 4 Max shows on its screen, and injects it into a
G-code file. Pure ESM, zero dependencies, identical in the browser and in Node.

## Status: format reverse-engineered and verified

| Check | Result |
|---|---|
| Decode the GUI's 320×320 `;gimage:` and render it | **a recognisable 3DBenchy** |
| `encodeColPic(decodeColPic(payload))` vs the GUI payload | **character-identical**, both sizes |
| Our `;gimage:` / `;simage:` block bytes vs the GUI's | **byte-identical**, padding included |
| Decoded `;simage:` vs the base64 PNG in the same file | **99.84 % of pixels exact**, worst delta 21/765 |
| Injected file re-parsed by `src/parser/` | 5022.23 mm, unchanged to 0.0001 % |

```
node test/thumbnail-decode.js --png out\      # writes decoded-gimage.png, look at it
node test/thumbnail-roundtrip.js
```

## Why this exists

ElegooSlicer's GUI renders thumbnails with OpenGL. Slicing from the CLI has no GL context, so
it writes **none** — even though the CLI output still declares them:

```
; thumbnails = 320x320/COLPIC, 160x160/COLPIC, 160x160/PNG
; thumbnails_format = COLPIC
```

The setting is already right; the images are simply never rendered. Every file this project
produces therefore shows a blank tile on the printer. Since the app already renders the model
in WebGL, it can capture those pixels and write the images itself.

Ground truth for everything below is `..\..\EN4Max_0.4_3DBenchy_PLA0.25_21m42s.gcode`,
sliced by the GUI, which contains real thumbnails from the actual target software. **It is
read-only.** Never write to a project G-code file during a test; copy to a temp dir.

## The three payloads, and what reads them

| Block | Size | Format | Read by |
|---|---|---|---|
| `;gimage:` | 320×320 | ColPic | printer screen, large preview |
| `;simage:` | 160×160 | ColPic | printer screen, file list tile |
| `; thumbnail begin/end` | 160×160 | base64 PNG | host software (Orca/Prusa convention), not the printer |

All three sit at the **very top of the file**, before the first blank line. The printer only
reads the head of the file, so placement is not cosmetic.

---

## ColPic

Chitu's palette + RLE format, used across Elegoo/Chitu screens. Authoritative reference
implementation (the encoder, in Python) is
[`lib_col_pic.py`](https://github.com/fifonik/ElegooNeptuneThumbnailPrusaMod/blob/main/lib_col_pic.py)
— `ColPic_EncodeStr` / `ColPicEncode` / `Byte8bitEncode`. `src/thumbnail/colpic.js` reproduces
it; the notes below are what the reference actually does, confirmed against the Benchy file.

### 1. The 6-bit character codec

The binary is re-coded 3 bytes → 4 characters so it survives inside a G-code comment.

| | |
|---|---|
| Alphabet | ASCII **48..111** (`0`..`o`), 64 symbols |
| Exception | 92 (`\`) is written as 126 (`~`) — a backslash is an escape hazard |
| Value | `v = (ch === '~' ? 92 : charCode) - 48`, range 0..63 |
| Packing | `(v0<<18)|(v1<<12)|(v2<<6)|v3` → 3 bytes, most significant first |

Identical to base64's packing step with a different alphabet. Binary length is always a
multiple of 3 (see padding below), so there is never a partial group and no `=` padding.

### 2. Header — 32 bytes, little endian

| Offset | Type | Value |
|---|---|---|
| `0x00` | u32 | `encodeVer`, always **3** |
| `0x04` | u32 | width |
| `0x08` | u32 | height |
| `0x0C` | u32 | magic **`0x05DDC33C`** (= 98419516) |
| `0x10` | u32 | `paletteBytes` = colourCount × 2 |
| `0x14` | u32 | `dataBytes`, length of the RLE stream |
| `0x18` | u32 | reserved, 0 |
| `0x1C` | u32 | reserved, 0 |

Then `paletteBytes` of palette, then `dataBytes` of RLE stream.

### 3. Palette

`colourCount` × **u16 RGB565 little endian**, sorted by **descending pixel count**.

- The image is flattened onto **white** first. The GUI renders on transparency (that is what
  lands in the PNG thumbnail) but `palette[0]` of the Benchy file is `0xFFFF` and the first
  run is exactly the number of transparent pixels — 5844, which is the PNG's transparent-pixel
  count to the pixel.
- Ties in the count are ordered by **reverse first appearance**. The reference uses an
  insertion sort whose test is `>=`, so a later colour jumps ahead of an equally common
  earlier one. Reproducing this is what makes the re-encode character-identical.
- Hard ceiling **1024 colours**, because an index must fit in `sid(5) + tid(5)` — see the RLE.
  Colours past the limit are merged into the nearest survivor, rarest first, distance
  `|Δr| + |Δg| + |Δb|` measured in 5/6/5 units (not 8-bit units).

Benchy palette sizes: 90 colours at 320×320, 78 at 160×160. ElegooSlicer's preview render is
flat-shaded enough that the limit is nowhere near being hit.

### 4. RLE stream (`Byte8bitEncode`)

The image is **one flat stream of width×height pixels**, left to right, top to bottom. Runs
cross scanline boundaries freely — there is no per-row structure.

A palette index splits into `sid = index >> 5` (bank) and `tid = index & 31`. The decoder holds
a current bank, **initially 0**.

| Bytes | Pattern | Meaning |
|---|---|---|
| 1 | `0xE0 \| sid` (`0xE0`..`0xFF`) | set current bank to `sid` |
| 1 | `dots<<5 \| tid` (`0x20`..`0xDF`) | run of `dots` pixels, **dots 1..6** |
| 2 | `0x00 \| tid` (`0x00`..`0x1F`), then `n` | run of `n` pixels, **n 7..255** |

`dots == 7` is never emitted as a one-byte token, which is what makes `0xE0`..`0xFF`
unambiguously a bank switch. A run never exceeds **255** pixels; longer ones are split into
repeated max-length runs. The bank byte is emitted **only when the bank changes**, so a
≤32-colour image contains none at all.

Worked example, the first bytes of the Benchy `;gimage:`:

```
00 ff  00 ff  ... (×22)   run of 255 px of palette[0] (white)     = 5610
00 ea                     run of 234 px of palette[0]             = 5844 ← first non-white pixel
e1                        switch to bank 1
2a                        dots=1, tid=10  -> index 1*32+10 = 42
e0                        switch to bank 0
00 9d                     run of 157 px of palette[0]
39                        dots=1, tid=25  -> index 25
```

### 5. The 3-byte padding quirk

Before the character coding, the binary is padded to the next multiple of 3 with zeros —
and the reference computes `temp = 3 - qty % 3`, which yields **3, not 0**, when the length is
already aligned. So it always appends 1..3 zero bytes. Get this wrong and the payload string
length differs from the GUI's.

| | `;gimage:` | `;simage:` |
|---|---|---|
| header + palette + RLE | 32 + 180 + 9746 = 9958 | 32 + 156 + 3444 = 3632 |
| after 3-byte padding | 9960 | 3633 |
| characters (× 4/3) | **13280** | **4844** |

---

## G-code block layout

Reproduced byte for byte from the Benchy file. Line endings are **LF** in the GUI sample; the
injector copies the file's own EOL (CRLF if the file uses it).

```
;gimage:<1015 chars>                 × 13     line is 8 + 1015 = 1023 chars
;;gimage:<85 chars>                           ← the LAST data line has a DOUBLED ';'
;0000…0                                       ';' + zeros, pads the block to 14336 B
;simage:<1015 chars>                 × 4
;;simage:<784 chars>
;0000…0                                       pads the block to 5120 B
<blank>
; THUMBNAIL_BLOCK_START
<blank>
;
; thumbnail begin 160x160 8452                8452 = base64 length, not PNG byte length
; <78 base64 chars>                  × 108
; <28 base64 chars>
; thumbnail end
; THUMBNAIL_BLOCK_END
<blank>
```

and then the file's original content, which starts `\n\n; HEADER_BLOCK_START`.

| Rule | Value | Why it matters |
|---|---|---|
| Payload chars per line | **1015** | line is exactly 1023 chars + LF = 1024 bytes |
| Last data line prefix | **`;;`** | present in both blocks in the GUI output; the pad length depends on it |
| Block alignment | **1024 bytes** | 14 KiB for `;gimage:`, 5 KiB for `;simage:` — the firmware reads fixed-size blocks, so do not "tidy" this away |
| Padding line | `;` + `0`× n | one line, sized to hit the boundary |
| Base64 line width | **78** chars after `; ` | PrusaSlicer/OrcaSlicer convention |

`stripThumbnails()` applied to the GUI file leaves exactly `\n\n; HEADER_BLOCK_START…` — i.e.
it lands on the same leading bytes as a CLI-sliced file. That is the test that proves strip and
inject are inverses.

**Not stripped:** the `; thumbnails = …` / `; thumbnails_format = …` lines in the footer. Those
are configuration, not payload.

---

## API

```js
// src/thumbnail/colpic.js
encodeColPic(rgba, w, h, { colorsMax = 1024, background = [255,255,255] }) -> string
decodeColPic(str) -> { width, height, rgba, palette }

// src/thumbnail/png.js  -- pure data; the compressor is injectable
encodePNG(rgba, w, h, { deflate }) -> Uint8Array     // deflate optional, see below
decodePNG(bytes, { inflate })      -> { width, height, rgba }
deflateZlib(u8) / deflateRaw(u8)                     // built-in, fixed-Huffman

// src/thumbnail/inject.js
injectThumbnails(gcodeText, rgba, w, h, { deflate, sizes }) -> string
stripThumbnails(gcodeText) -> string
extractColPic(gcodeText, 'gimage'|'simage') -> string
fitRGBA(rgba, sw, sh, size) -> Uint8Array            // aspect-preserving, centred
```

`rgba` is `width*height*4`, straight from `canvas.getContext('webgl2').readPixels` or
`ctx.getImageData`. **Flip it vertically first if it came from WebGL** — `readPixels` returns
bottom-up.

`injectThumbnails` derives all three images from one capture: 320×320 and 160×160 via
`fitRGBA`, which box-averages over premultiplied alpha. Against the GUI's own native 160×160
render the downsample is visually indistinguishable.

### Where the environment-specific parts are

Nothing in `src/thumbnail/` imports `node:*`. PNG needs DEFLATE, so it is passed in:

| | |
|---|---|
| Node | `injectThumbnails(…, { deflate: (u) => zlib.deflateSync(u, { level: 9 }) })` |
| Browser | omit it — the built-in fixed-Huffman compressor is used |
| Browser, alternative | `canvas.toBlob()` and hand the bytes to `formatPngBlock()` |

The built-in compressor is correct (node:zlib inflates its output byte for byte) and about
8 % larger than zlib level 9. `decodePNG` has no fallback: `inflate` is required.

### Cost

Injecting into the 2.9 MB 17 Pro file, from a 320×320 capture:

| | |
|---|---|
| Added bytes | **+33.1 KB** with node:zlib, +35.9 KB with the built-in compressor |
| Time | ~70 ms total, of which ~18 ms is the two ColPic encodes |

---

## What is verified, and what is not

**Verified.**
- The decode is visually a 3DBenchy at 320×320 and 160×160.
- Re-encoding the GUI's own images reproduces the payload strings **character for character**,
  and the full `;gimage:` / `;simage:` blocks **byte for byte**. That covers the charset, the
  bit packing, every header field, the palette order including the tie rule, the RLE, the
  3-byte padding quirk, the 1015-char wrapping, the `;;` prefix and the 1024-byte padding.
- The decoded `;simage:` matches the base64 PNG in the same file on 99.84 % of pixels; the
  ~40 that differ are antialiased silhouette pixels, worst delta 21 out of 765 summed channels.
  These are the slicer compositing in the renderer rather than from 8-bit RGBA, not a format
  misunderstanding.
- Injecting does not disturb the body: `stripThumbnails(inject(x)) === x`, and the parser reads
  the injected file with the same 5022.23 mm total.

**Not verified.**
- **It has not been shown on the printer.** Everything above is agreement with the GUI's own
  output; the screen itself has not rendered a file we wrote. That is the one remaining check.
- The `;;` on the last data line is copied, not explained. It is in both blocks of the only
  GUI-sliced sample available, so it is treated as the rule.
- Only one GUI-sliced file exists to compare against, at 320/160/160. Other size combinations,
  and `;gimage:` at a size other than 320×320, are untested — the block sizes (14 KiB / 5 KiB)
  would change, and whether the firmware cares is unknown.
- The >1024-colour path is a deliberate deviation: the reference stops collecting after the
  1024th distinct colour and silently maps everything later to palette slot 0. We collect all
  colours and merge down instead. Output is identical whenever an image has ≤1024 distinct
  RGB565 colours (every ElegooSlicer preview seen so far), and merely correct rather than
  speckled when it has more. No GUI sample exercises this path, so it is unverified against
  the real encoder.
- `fitRGBA` upscaling degenerates to nearest neighbour. Captures should be ≥320×320.

---

## Update 2026-09-16 — server-side rendering, in use

The encoder above now has a producer that needs no browser.

| File | Role |
|---|---|
| `server/thumbnail-render.js` | draws a parse result as a preview: orthographic, front-left from above (az -60°, el 38°), each extruding move stamped as a thick line into a depth buffer, rendered 640² and box-filtered to 320/160 by `fitRGBA`. ~50 ms for the phone cases |
| `server/api/thumbnail.js` | `POST /api/thumbnail {path, png?, dryRun = true}` → writes the preview into `…_v<N+1>-draft.gcode` (the final stays; step saved). `png` (data URL) replaces the server render, e.g. an app capture |
| `server/thumbnail-cli.js` | `node server/thumbnail-cli.js "<path>" [--dry] [--png out.png]` (writes the draft) |
| title-bar image button | dry run → confirm → write → reopen the new version |

**Look:** a single blue model on transparent, matching ElegooSlicer. Colours were sampled from the
GUI-sliced Benchy (lit ~`rgb(49,158,214)`, shadow ~`rgb(24,89,123)`); base `rgb(52,168,226)`,
ambient 0.42. Skirt, brim, prime tower and custom moves are left out, as the GUI does. Walls are
lit by a sideways normal facing the camera (tilted up 0.25); surfaces and infill by +Z.

**Safety checks before any write:** `stripThumbnails(new) === stripThumbnails(old)` (nothing but the
preview blocks changed), and the re-parse has the same move count and filament. A file that already
has a preview is refused (409) unless a different image is supplied — a second server render would
only mint an identical version.

**Used on:** 16 Pro → `v5-thumbnail`, 17 Pro → `v2-thumbnail` (written before drafts existed; a
preview added today goes into a draft). Both verified: toolpath
byte-identical to the previous version, embedded `;gimage:` decodes to a recognisable image.

**Still unverified:** how the Neptune 4 screen actually shows it. See `../BUGS.md` / `../context-local/TODO.md`.
