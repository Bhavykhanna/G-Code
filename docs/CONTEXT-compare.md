# Compare (Diff button) — context

Last updated: 2026-09-17

Owns `src/compare.js`, `src/compare-worker.js`, the compare UI (`src/ui/compare.js`) and the
renderer's compare layer (`setCompare` in `src/render/viewer.js`). Part of
[G-code Studio](../CONTEXT.md).

Asked for on 2026-09-16: "when we make a new iteration from the old one I want to see the diff
between the old base file model and the new one with a diff button". First real case: the enclosure
base v2 (`<job>\v2\`, stretched 2.2 mm in X) against its base
`<job>\v1\enclosure-base-mesh-fast.gcode`, which does **not** follow the naming
convention — so the base has to be picked, not derived.

---

## As built (2026-09-16) — kept simple on purpose

The user asked for the diff "on the model only, visual", and "don't over-complicate". So:

- **Diff** button in the title bar (or `D`). It compares with the file's base
  (`/api/base`: the final it came from). Without one — files outside the naming convention — the
  best name match is used if it is clearly best (`rankBases` score ≥ 4), else a picker opens.
- A small card over the viewport: `DIFF VS <base>` (click the name to pick another file) + ✕, and
  **Changes** (default) / **Overlay** under it. The +added / −removed totals are in the colour key
  ("Only in this file" +m / "Only in the base" −m / "Same in both").
- After an edit, a finalize, or `app-cli.js open --diff`, the new file opens with the diff on.
- A new G-code appearing on disk (not in `old\`, not our own write) shows a pop-up with
  **Open + diff**.
- The renderer also supports Old / New modes; the UI does not show them.

First version (superseded, see "Matching, rewritten"): measured on the enclosure base (wire-gap folder) against `enclosure-base-mesh-fast`: 356 ms in the
worker; 12 % of the new file's extrusion length marked added, 10 % of the old one removed.
`test/check-compare.js`, `test/check-compare-render.js`.

Seen and approved on screen by the user (2026-09-16), Changes mode. Overlay mode not yet commented on.

## What it shows

| Mode | Current file (new) | Other file (old / base) |
|---|---|---|
| **Overlay** (renderer `'both'`) | normal colours | ghost: one colour, translucent, behind |
| **Changes** | added moves green, unchanged moves dim grey | removed moves red, unchanged hidden |
| **Old** (renderer only) | hidden | normal feature colours |
| **New** (renderer only) | normal colours | hidden |

The `/api/diff` numbers are not shown in the app; only the +/− metres in the legend.

Both files are drawn in **bed coordinates, unaligned** — that is where the printer puts them.
A stretched model therefore shows changes at both ends if the slicer re-centred it. That is the
truth about the print, and the stats say how much moved.

## Contract

### Matching (src/compare.js, pure, runs in a worker) (superseded, see below)

`compareToolpaths(cur, old, opts)` → `{ curClass, oldClass, stats }`

- `cur`, `old`: `{ segments, count }` from the parser (only `x0..z1`, `kind` are read).
- `curClass`: `Uint8Array(cur.count)` — `0` unchanged, `1` added (only in cur), `255` not an extrusion.
- `oldClass`: `Uint8Array(old.count)` — `0` unchanged, `2` removed (only in old), `255` not an extrusion.
- A move is *unchanged* when at least 80 % of points sampled along it every `step` (0.5 mm) land
  within one `cell` (0.25 mm) of the other file's extrusion at the same Z (Z rounded to 0.01 mm).
- `stats`: `{ curMm, curSameMm, curAddedMm, oldMm, oldSameMm, oldRemovedMm, curMoves, addedMoves,
  oldMoves, removedMoves, ms }`.

### Renderer (src/render/viewer.js)

| Addition | Behaviour |
|---|---|
| `setCompare({ parse, curClass, oldClass } \| null)` | Builds the other file's extrusion geometry (same builder as `setData`, same quality) as a **second, non-pickable** mesh. `null` removes it and restores normal colours. Replaced whenever called again. Cleared by `setData` (a new current file invalidates `curClass`). |
| `setCompareMode('both' \| 'changes' \| 'old' \| 'new')` | Cheap switch (colour/visibility only, no rebuild). Default `'both'`. |
| layer range | The other mesh follows the current layer range **by Z**: its layers whose Z lies within `[z(lo) − 0.001, z(hi) + 0.001]` of the current file's layers. |
| feature filter | Applied to both meshes. |
| selection, picking, box/area select | Current file only. |
| `captureView` | Includes the compare layer as shown. |

Colours live in `src/render/colors.js`: `DIFF_ADDED` (green), `DIFF_REMOVED` (red),
`DIFF_SAME` (dim grey), `GHOST_COLOR` (+ `GHOST_OPACITY`).

### UI (src/ui/compare.js, wired by layout.js / main.js)

- Title bar **Diff** (or `D`) starts the diff against `/api/base`; without a base, `rankBases` picks
  a clear best match or a picker sheet opens (best matches first, current file excluded). Clicking
  the base name in the card opens the picker.
- Card: `DIFF VS <name>`, ✕, Changes / Overlay. UI default is Changes (`main.js`); the renderer's
  own default is `'both'`.
- Keys: `D` turns the diff on, or off when it is on.

## Matching, rewritten (2026-09-16, later) — supersedes the grid-cell rules above

The user could not see the moved screw holes and asked for a clean redo instead of patches.
The first version matched moves against a set of 0.25 mm cells with 0.75 mm slack and no idea of
feature or direction: a moved screw-hole ring counted as "unchanged" wherever it crossed the old
ring or lay on old floor. `src/compare.js` now works on **plastic per layer**:

| Step | Rule |
|---|---|
| Grid | 0.1 mm, per layer (matched by Z, ±0.05 mm), drawn at each line's real width in half-cell steps (whole-cell steps left holes from float rounding) |
| Walls (inner, outer, overhang, gap fill) | unchanged if ≥ 80 % of the centreline lies on old wall plastic running the same way (±22.5°). Each cell keeps a **set** of directions — neighbouring loops overlap and would overwrite a single one |
| Wall paths | a move's score is averaged ±2 mm along its path, so a moved ring that briefly runs parallel to an old wall still reads as moved (cost: a real change can show up to 2 mm wider) |
| Fill (solid infill, top/bottom, bridges, ironing, support) | unchanged if ≥ 80 % lies on any old plastic — a re-laid floor is not a change |
| Neutral | sparse infill, skirt, brim, prime tower, start/end G-code: regenerated every slice, never green/red |

Renderer: in Changes mode the removed moves are drawn half-transparent (55 %; 30 % was too faint) behind a depth-only pre-pass, so
50 stacked layers do not add up to solid red.

Measured, enclosure base draft vs v1: 0.8 s; moved screw-hole rings 95 % added; walls of the untouched
right half < 5 % added (the real-file check now picks final v2 with the 7 divider openings and
fails this — B12); +24.4 m / −22.6 m. `test/check-compare.js` covers these plus synthetic
cases (self, moved wall, 0.05 mm nudge, wall on old floor, crossing rings, floor re-laid at 90°,
sparse neutral, other layer). Headless SwiftShader screenshot: the new holes read clearly.

**Approved by the user 2026-09-16** on the enclosure base draft ("nice … it's good now"), after one
tweak: removed moves at 55 % opacity (30 % hid the old screw holes).


## The diff card (redone 2026-09-16, user: "the diff bar is a mess")

Top-left card: `DIFF VS <base>` (click the name to pick another base) + `×`, and the
Changes / Overlay switch under it. The +added / −removed totals moved into the **colour key**, which in
Changes mode shows the diff colours ("Only in this file" +m / "Only in the base" −m / "Same in both") and in Overlay mode
the normal key plus "faint ghost = <base>" (`paintLegend()` in `layout.js`). When the viewport is too
narrow for the card and the view tools on one row, the card drops below the tools (`placeTopLeft()`).

## Centring and alignment (2026-09-17)

User: "we only center the build on the finalise". Drafts stay where the final they came from sits (so
draft-vs-final diffs need nothing); **Finalize centres the part** on the bed (`server/api/centre.js`,
geometry in `src/align.js`) and writes the shift to `<job>\old\v<N>-steps\align.json`:

```
{ "<model>": { "final": "<final name>", "dx": 2.1, "dy": 0,
               "alignedWith": "<file the draft was lined up with>", "bedCentre": [213, 213], ...,
               "atFinal": ["04-...gcode"] } }
```

- **Centring** moves every absolute X/Y on G0–G3 lines of the print body (`;LAYER:1` → `;PRINT_END`) and
  the `EXCLUDE_OBJECT_DEFINE` outline; start/end G-code, I/J and G91 moves stay. "The part" = extrusions
  without skirt, brim, prime tower, custom. Refused if the print would leave the bed. Checked after
  writing: same move count, part centre on the bed centre. The text before is saved as a step.
- **The diff** (`findAlign` in `main.js` → `alignFor`) walks the notes from the current file back to the
  base, adding up the shifts, and draws the base moved by the total (`shiftParse`). Drafts use the
  final they came from; any file in a version's steps folder counts as that version before centring,
  **except** files listed in the entry's `atFinal`: kept copies of the centred final, which sit where
  the final sits (e.g. `04-EnclosureBase-before-corner-fix.gcode`, 2026-09-17; `centre.js` keeps the list
  when it rewrites the entry);
  unconnected files get no shift. The card shows "base lined up +2.1 mm X" with **off / line up**.
- Checked by `test/check-align.js` (part of `npm run check`): shift and shift back are byte-identical;
  centred v2 vs v1 lined up classifies like before (2 of 105,290 moves differ — 0.1 mm grid rounding).
- Finalize's centring runs in the server, so it needs a server started after 2026-09-17 (ask the user
  before restarting). The diff side works in the running app after a reload.

## Diff look: opacity old / new, hide same (2026-09-17, waiting for the user's check)

User, looking at the v3 base (floor 1 mm thinner): "I can't see the diff here, we need diff settings ...
like opacity for the old and new". A thinner floor lies inside the old one, so the old red floor
covered the new green top.

- Card row **Old** / **New** sliders (0-100 %, step 5) and, in Changes, **hide same**. Values per mode,
  remembered in this browser (`localStorage` `gcs.diffLook.changes` / `.both`). Defaults = the approved
  look: Changes old 55 % / new 100 %, Overlay old 22 % (`GHOST_OPACITY`) / new 100 %.
- Renderer: `setCompareLook(mode, {oldOpacity, newOpacity, hideSame})`, `getCompareLook(mode)`.
  New = 100 %: as before (new solid, old behind it). **New < 100 %:** the new mesh switches to `fadeMat`
  and is drawn after the old one on a cleared depth buffer (`curDepth` pass, `onBeforeRender` clears depth,
  then a depth-only pass, then one blended colour pass). So each file shows its own frontmost surface and
  the old one shows through the new one. The two files no longer hide each other in that setting (on
  purpose: it is the "see inside" setting); the bed does not hide the new file either.
- Order: three draws every opaque object first, so both depth-only passes (`removedDepthMat`,
  `fadeDepthMat`) are marked `transparent` to stay in `renderOrder` (old depth 1, old colour 2, new depth 3,
  new colour 4). `curDepth` lives under `compareRoot`, so picking never sees it.
- **hide same** sets the hidden flag on the new file's unchanged moves (`refreshFlags`), so they are also
  not pickable; cleared when the diff or Changes is left.
- Backup before this change: `backup\2026-09-17-before-diff-look\` (src, dist). Not yet seen on screen.

**`alignedWith` after Finalize (2026-09-17):** the note stores where the base was when the draft was finalized;
Finalize then moves that base into `old\`. `alignFor` treats `<dir>/old/<name>` as the same file, so v3 vs
the archived v2 is found (and the chain continues past it to v1).
