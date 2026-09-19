# Renderer — context

Last updated: 2026-09-17

Owns `src/render/`. Reads the parse result described in [`../CONTEXT.md`](../CONTEXT.md) → *Shared
contract*, and gets every colour from `src/render/colors.js`. Writes nothing back.

| File | Owns |
|---|---|
| `viewer.js` | the public API, the scene, the materials and shaders, the run loop |
| `geometry.js` | parse arrays → GPU buffers. Pure, no DOM, runs in Node |
| `picking.js` | GPU ID-buffer picking and box select |
| `area.js` | area select: CPU projection of segment midpoints into a rectangle. Pure, runs in Node |
| `controls.js` | orbit / pan / zoom, Z-up, hand-written |
| `bed.js` | plate, grid, origin, axis indicators |

Checked by `test/check-render-geometry.js` (Node, no WebGL) — run it after touching `geometry.js` —
and `test/check-area-select.js` (Node) after touching `area.js`.

---

## The public API

```js
import { createViewer } from './render/viewer.js';
const viewer = createViewer(canvasEl, options);
```

| Call | Cost | Notes |
|---|---|---|
| `setData(parseResult)` | ~60 ms | builds everything. Also frames the model and the bed |
| `setViewMode(id)` | 3–4 ms | one of the `VIEW_MODES` ids. Rewrites colours, no rebuild |
| `setLayerRange(lo, hi)` | **0.1 µs** | inclusive, 0-based, indexes `segments.layer` |
| `setVisibleFeatures(set)` | ~3 ms | `Set` of indices into `FEATURE_NAMES`; `null` = all |
| `setShowTravel(bool)` | free | off by default |
| `setShowRetractions(bool)` | free | off by default |
| `setSelection(Uint32Array, {partial, clip}?)` | ~0.5 ms / 4k segs | segment indices, highlighted in `SELECT_COLOR`; `partial` (area select) highlighted only inside `clip`, see *Area select* |
| `clearSelection()` | ~0.3 ms | |
| `onPick(cb)` / `onHover(cb)` / `onBoxSelect(cb)` | — | each returns an unsubscribe function |
| `setBoxSelectMode(bool)` | free | left-drag draws a rectangle instead of orbiting. Turns area mode off |
| `setAreaSelectMode(bool)` | free | same, amber dashed band (`areaSelectStroke`). Turns box mode off. Rotation off, pan on |
| `onAreaSelect(cb)` | **~2–5 ms** | `cb({indices: Uint32Array, rect, bounds, total, partial, clip})`, see *Area select*. Returns unsubscribe |
| `getLastRect()` | free | `{x0,y0,x1,y1,w,h}` (CSS px, canvas space) of the last completed box **or** area drag, else `null`. Cleared by `setData` |
| `captureView({maxWidth=1280, rect=null, label=null})` | 1 frame + readback | PNG data URL of the **current** view, bed and background included |
| `frameAll()` / `frameSelection()` | free | animated, damped |
| `setTopView()` / `setBottomView()` / `setFrontView()` / `setIsoView()` | free | animated. Bottom looks up from under the bed |
| `renderThumbnail(w, h)` | ~1 ms | PNG data URL, transparent background, bed hidden |
| `getValueRange(id)` | free | the colour scale: `{min, max, kind: 'single'\|'discrete'\|'quantile', anchors:[{v,t}], values:[{v,share}], otherShare?, otherCount?}` |
| `setAreaOptions({match, exclude})` | free | area-select rule (see `AREA_MATCH` in `area.js`) and the features never taken (skirt, brim, purge line by default) |
| `setQuality(q)` | full ribbon rebuild | `'auto'\|'high'\|'fast'\|'flat'`; the one call that rebuilds geometry |
| `getStats()` / `setStatsVisible(bool)` | free | frame/build stats object; an on-canvas stats overlay |
| `setPointers(list)` / `framePointers(instant, view)` | free | Claude's boxes, see *Pointers* below |
| `setCompare({parse, curClass, oldClass} \| null)` | ~16 ms (98k moves) | second, **non-pickable** ribbon mesh for another file, see *Compare layer*. `null` removes it. Cleared by `setData` |
| `setCompareMode('both'\|'changes'\|'old'\|'new')` | ~2–6 ms | colours / flags / visibility only, no rebuild. Default `'both'`; remembered across `setCompare` calls |
| `dispose()` | ~1 ms | removes every listener, frees every buffer |

`onPick` / `onHover` fire with a **segment index**, or `null` for empty space. That index is the row
number in the struct-of-arrays, so `segments.line[i]` is the source line and the selection contract in
`CONTEXT.md` needs nothing else.

Beyond the contract (safe to use, not load-bearing): `viewer.stats`, `viewer.layerCount`,
`viewer.viewMode`, `viewer.selection`, `viewer.compareMode`, `viewer.comparing`, `stats.compare`, `viewer.requestRender()`, `viewer.resize()`, and
`viewer.three` (`{renderer, scene, camera, controls, modelRoot, bed}`) as an escape hatch.

**Under the bed** (2026-09-16, user: "it's not a real build plate"): whenever the camera is below
Z = 0, `bed.setUnderside(true)` hides the plate, labels and origin ring and fades the lines to 30 %,
the shared ribbon uniform `uUp = -1` mirrors the lights in Z so the underside is lit like the
top (otherwise it gets ambient only, ~0.30), and the ribbon materials go **double-sided** — the
`fast` / `flat` profiles that big files get automatically have no bottom face, so from below the
model was invisible except for specks (the pick pass copies the side from the visible material). Checked every rendered frame; `renderThumbnail` forces
`uUp = 1`.

**Value colours** (2026-09-16): `computeValueRanges` also builds a colour scale per numeric mode from
the plastic (extrusion length) at each value — `kind: 'single'` (one value, e.g. 225 °C),
`'discrete'` (≤ 10 values with ≥ 0.5 % each cover ≥ 80 % of the plastic: each gets an evenly spaced
colour, in-between values blend) or `'quantile'` (spread values: equal plastic per colour band).
`scaleT(range, v)` maps a value; `getValueRange` returns the whole scale; `legendFor(mode, range, unit)`
turns it into legend rows. Tiny outliers (the 6.7 mm/s purge line) no longer stretch the scale.

`options`: `background`, `showBed`, `showTravel`, `showRetractions`, `viewMode`, `maxPixelRatio`,
`antialias`, `bedShape` (overrides `meta.bedShape`), `bed` (passed to `createBed`),
`boxSelectStroke`, `areaSelectStroke` (default `#ffb020`), `quality` (`'auto'|'high'|'fast'|'flat'`,
default `'auto'`), `adaptiveResolution` (true), `hoverInterval` (45 ms), `hoverRest` (70 ms),
`hoverSync` (false), `stats` (false).

---

## Geometry strategy

**Extrusions are real ribbons with true width, not lines.** `gl.LINES` cannot do width portably (the
`lineWidth` cap is 1 on every desktop driver worth naming), and 1 px lines throw away the single most
useful thing in the file — the fact that a bead is 0.50 mm here and 0.68 mm there. Seeing that is what
makes this read like ElegooSlicer's preview instead of a wireframe.

Each extruding move becomes a short prism:

```
        cross-section, in the move's own frame
        u = across the path (XY)   v = up (+Z)

           p2 ___________ p1          flat top   -> catches the key light,
             /           \                          top surfaces read bright
         p3 |             | p0        vertical sides -> go dark, so neighbouring
             \___________/                            beads have a visible seam
           p4             p5
```

Six points per ring, two rings per move → **12 vertices per move, fixed** (the `high` profile; `fast` = 6, `flat` = 4 — `geometry.js`
`PROFILES`, chosen by quality `'auto'`). Fixed matters: slot *k*
owns vertices `[12k, 12k+12)`, so "recolour segment *i*" and "select segment *i*" are arithmetic, not
a lookup table.

The ring is offset from the nozzle position by `height/2` downwards, because `z0`/`z1` in the parse
result is the **nozzle** Z, i.e. the top of the bead. On the 17 Pro file the lowest vertex comes out
at exactly `0.000` and the highest at `11.550` = `max_z_height`. The model sits on the plate because
the arithmetic says so, not because of a fudge offset.

**Joints are mitred, not capped.** 91 % of the extruding moves in the 17 Pro file continue exactly
from the previous one. At each such joint both moves derive the same bisector from the same two
directions and stretch the width by `1/cos(half-turn)`, so the two rings land on **identical points** —
zero gap, measured, asserted in the test. Corners sharper than a 2.5× stretch (3,322 of 46,403
joints here, mostly hard reversals in infill) fall back to flat end caps instead; a mitre there would
spike out to a visible barb. Caps cost 12 extra indices each.

Why mitre rather than just cap everything: capping every move costs 33 % more indices *and* leaves a
hairline crack at every corner when you zoom in. Mitring costs nothing extra and is watertight.

| | value |
|---|---|
| Vertices per extruding move | 12 |
| Indices per move | 36 side + 12 per cap |
| Normals | outward, edge-averaged **in scaled space** — a unit-hexagon normal would be wrong by 20°+ on a 0.5 × 0.2 mm bead and the top faces would shade like the sides |
| Winding | CCW outside, `FrontSide`, backface culled — `DoubleSide` while the camera is under the bed |

Travels are `LineSegments` (2 vertices/move, translucent, `depthWrite: false`). Retractions and primes
are `Points` (1 vertex/move, round via `gl_PointCoord`, size attenuated with distance).

### Buffer layout

One merged buffer per object type. Three draw calls for the whole print.

| Attribute | Type | Size | Written when |
|---|---|---|---|
| `position` | Float32 ×3 | 9.9 MB | build only |
| `normal` | Float32 ×3 | 9.9 MB | build only (ribbons only) |
| `aColor` | Uint8 ×3, normalized | 2.5 MB | `setViewMode` |
| `aFlags` | Uint8 ×1 | 0.8 MB | `setVisibleFeatures`, `setSelection` (bit 0 hidden, 1 selected, 2 partial) |
| `aId` | Float32 ×1 | 3.3 MB | build only |
| index | Uint32 | 10.5 MB | build only |

**≈ 36 MB on the GPU** for the 17 Pro file. `aFlags` is one byte: bit 0 hidden, bit 1 selected. Hidden
vertices get `gl_Position = vec4(2,2,2,1)` — clipped before rasterisation, so a hidden feature costs
one vertex transform and no fill at all. No `discard`, which would break early-Z.

Colours are a **vertex attribute**, not a uniform and not a texture lookup, because they have to vary
per segment inside a single draw call. Recolouring rewrites 2.5 MB through a 256-entry ramp LUT: 3 ms.

---

## Layer ranges

`segments.layer` is monotonically non-decreasing (the parser pushes in file order, layers only go up —
asserted in the test). So **a layer range is always one contiguous index range** and the slider is:

```js
geometry.setDrawRange(layerIdxStart[lo], layerIdxEnd[hi] - layerIdxStart[lo]);
```

Three `setDrawRange` calls, no allocation, no upload, no rebuild. Measured **0.4 ms for 5,000 calls**,
i.e. 0.08 µs each — the slider cannot be the bottleneck no matter how fast it is dragged.

`layerIdxStart/End` are built at load time with empty layers sealed to the previous layer's end, so
every index 0..layerCount-1 is valid and the ranges are gapless and complete (also asserted).

The same scheme gives travels and markers vertex ranges, and the ribbon mesh a *slot* range as well,
so `frameAll()` can walk only the visible segments.

---

## Picking

GPU ID buffer, never raycasting. The file is 872k triangles in one buffer; a CPU raycast needs a BVH
that costs tens of MB and still loses to the GPU, which already rasterises this exact geometry every
frame.

1. Swap every pickable object's material for an ID material, hide the bed.
2. `camera.setViewOffset(cssW, cssH, x, y, w, h)` — **render only the pixels under the cursor**. A
   hover is a 3×3 render, a click 5×5, not a full frame.
3. Fragment writes `segmentIndex + 1` as little-endian RGB (`/255.0`, so the unorm8 round-trip is
   exact). 0 means background.
4. `readRenderTargetPixels`, take the hit nearest the centre.

A 5×5 click neighbourhood rather than a single pixel is deliberate: a bead is about one pixel wide at
whole-bed zoom, and a 1×1 pick feels broken. This gives the cursor a magnet.

**Correctness is structural, not defensive.** The pick pass uses the *same* `BufferGeometry` objects,
so `drawRange` applies; the *same* `aFlags` attribute, so feature-hidden geometry is clipped in the
pick pass too; and objects with `visible === false` are skipped by three itself. There is no separate
"is this pickable" bookkeeping that could drift out of sync. Verified: with sparse infill hidden,
0 of ~600 probe clicks returned a sparse-infill segment; with layers 0–3 shown, 0 returned a segment
above layer 3; with travels hidden, 0 returned a travel.

**Box select** does the same thing over the dragged rectangle and collects unique IDs. Rectangles
bigger than 1400 px per side are downsampled rather than read back as 20 MB.

> **Limitation, on purpose.** Box select is a *visibility* test, not a volume test. A segment buried
> under other extrusions writes no fragment and is not returned. Rotate, or narrow the layer range, to
> reach what is underneath. The alternative — a CPU frustum test over all 92k segments — would quietly
> select infill you cannot see and give you no way to tell what you had picked up.

### Area select

Box select's through-the-model counterpart. On mouse-up (drag ≥ 3 px both ways; smaller emits
`pick` like box mode) `onAreaSelect` fires with **every** extrusion whose nozzle-path midpoint
projects inside the rectangle, **including ones hidden behind others**:

- only `built.extrude.segOf` slots — travels and retract markers are never included;
- only slots `layerSlotStart[lo] .. layerSlotEnd[hi]` (the layer slider);
- only features in `visibleFeatures`;
- midpoint in front of the camera (clip `w > 0`) and between near and far (NDC z in [-1, 1]);
- `indices` ascending (slot order is file order), `total = indices.length`,
  `bounds = {min, max}` of the selected moves' **endpoints** (nozzle Z, not bead bottom), or `null`;
- `rect` is the normalised drag rectangle, also kept for `getLastRect()`.

**Why it ignores occlusion.** Its job is "give me this region of the print", e.g. to hand it to
Claude or to edit it. A visibility test (box select) returns only the skin you can see — on a
phone case the outer wall and top surface — and silently drops the infill and inner walls inside
the same region, which are exactly the moves an edit usually needs. The layer slider and feature
toggles are the way to narrow it. The UI must make the difference visible (amber dashed band,
separate key) — the hazard noted under *Picking* is real if the two modes look alike.

**How.** CPU, not GPU: one `proj × view` product per call (`camera.updateMatrixWorld()` and
`updateProjectionMatrix()` first), then an inline 4×4 transform per slot with the inside test in
clip space (no division), a byte table for the feature set, no allocation in the loop.
Pure function `selectInRect()` in `area.js`.

**Measured** (`node test/check-area-select.js`, Node 24, this PC): 17 Pro file, 68,726 extrude
slots, 1600×900 full-canvas rect selects all 68,726 in **0.83 ms median / 2.8 ms worst** of 30
(matrix product included). Result is identical, index for index, to a `THREE.Vector4` reference on
a 5,757-segment partial selection with layer and feature filters, and on 20k random points
around/behind a perspective camera. Synthetic grid under an orthographic top view: exact counts.

**Crossing moves are drawn cut to the rectangle** (2026-09-17, user: the highlight must cover the
whole rectangle, solid look kept). `selectInRect` also returns `partial` — moves that touch the
rectangle but are not taken by the rule (same layer / feature / exclude filters; empty for
`'touch'`) — and `ndc`, the rectangle in NDC. `onAreaSelect` passes them on as `partial` and
`clip: {viewProj, ndc}`; `setSelection(indices, {partial, clip})` sets flag bit 2 (`FLAG_PARTIAL`,
value 4) on those moves and loads `uClipVP` / `uClipRect` (shared ribbon uniforms). The ribbon
fragment shader treats a partial move as selected only where the fragment's world position,
projected with the selection-time camera, falls inside the rectangle — so the cut is per pixel,
exact at the rectangle edge, and stays fixed on the model when you orbit (it is a prism through the
model, unbounded in depth). `setSelection` without the options clears it. **The selection itself is
unchanged**: `partial` never goes to edits or Claude; the attachment line only says how many moves
cross the edge (`sel.area.crossingNotSelected`).
**Locked (user, 2026-09-17): the selection cyan is mixed over the move's own colour at 50 %**, for full and partial moves alike (`sel *= 0.5` in `RIBBON_FRAG`). Don't change it without asking.

### captureView

Renders the scene with the **live camera** into a `WebGLRenderTarget` (4× MSAA when `antialias`)
of the canvas CSS size scaled down to `maxWidth` (never up), reads it back and returns a PNG.
No `preserveDrawingBuffer`. Bed, grid and background (the renderer clear colour, `opt.background`
— the scene has no `background`) are included; selection flags are whatever is set. Marker point
sprites are rescaled to the capture's pixel scale. Clear colour, alpha, `autoClear`, render target
and `uPixelRatio` are restored in a `finally`, then the frame is marked dirty.

Colour: the on-screen path writes shader output unconverted (`outputColorSpace = LinearSRGB`,
`ColorManagement` off, no tone mapping). three r180 always uses LinearSRGB output for a
non-XR render target, and a `NoColorSpace` texture is allocated `RGBA8` (not `SRGB8_ALPHA8`), so the
read-back bytes are the screen's bytes — checked in the three source, **not** by comparing pixels.
Pick materials are only swapped in inside `picker.drawRegion`, which restores them synchronously,
so they cannot leak in.

`rect` (CSS px) is drawn scaled as a 2 px dashed `#ffb020` outline; `label` top-left in 13 px
monospace on a `rgba(10,14,20,.78)` box, truncated to the image width. Alpha forced to 255.

---

## Compare layer

Contract: [`CONTEXT-compare.md`](CONTEXT-compare.md). Checked by `node test/check-compare-render.js`
(pure half only).

- **Mesh.** `setCompare` builds the other file's extrusions with `buildExtrudeArrays` at the
  current mesh's *resolved* quality (so both look alike), into a `compareRoot` group under
  `modelRoot`. The group is passed to `picker.hideDuringPick` (re-added after `ensureBed`
  clears the list), so picking, hover, box and area select only ever see the current file. No
  travels or markers for the other file. Its bounds join the near/far sphere. `setData` and
  `dispose` free it; `setQuality` rebuilds it with the same classes.
- **Modes** (colour and visibility only):

| Mode | current mesh | other mesh |
|---|---|---|
| `both` | view-mode colours | `GHOST_COLOR`, `ghostMat` (alpha `GHOST_OPACITY`) |
| `changes` | `curClass 1` → `DIFF_ADDED`, else `DIFF_SAME` (ignores view mode) | `removedMat` (`DIFF_REMOVED`, alpha 0.55) after a depth-only pre-pass (`removedDepthMat`); `oldClass ≠ 2` hidden by `FLAG_HIDDEN` |
| `old` | `visible = false` | `ribbonMat`, view-mode colours **on the current file's value range** |
| `new` | view-mode colours | `visible = false` |

- **Ghost transparency.** The ribbon fragment shader writes `uOpacity` as alpha (1.0 on
  `ribbonMat`). `ghostMat` is a second `ShaderMaterial` on the same shaders, sharing the lighting
  uniform objects by reference, with `transparent`, `depthWrite: false`, `renderOrder 1` and
  `polygonOffset` (2, 2). The offset matters: without it an unchanged old move sits at exactly
  the depth of the new one, passes `LessEqual` and tints the whole model magenta. With it the
  opaque current ribbon wins and the ghost only shows where the current file has nothing.
- **Flags.** The other mesh's `aFlags` = feature filter OR (`changes` and not removed). Current
  mesh flags are untouched by compare, so selection works in every mode (in `old` the mesh is
  hidden, so there is nothing to see or pick).
- **Layer range by Z.** `layerZTable` gives each layer index the lowest nozzle Z of its
  extrusions (NaN if none — `parse.layers[]` is not indexed by `segments.layer`).
  `zSpanOfLayers(curZ, lo, hi)` gives the current span, **open-ended when `lo` is the first or
  `hi` the last layer** (so the full range shows all of a taller/shorter old file), and
  `layerRangeByZ(otherZ, zLo, zHi, 0.001)` the first..last matching other layer → one
  `setDrawRange`. No match → draw count 0. Layers with Z out of order between the first and last
  match would be included (contiguous range); slicer output does not do that.
- **Leaving.** `setCompare(null)` makes the current mesh visible and re-runs `applyColors()`, which
  is the non-compare path again. `compareMode` is kept; the UI sets it on entry.
- **Thumbnails** hide the compare group and show the current mesh even in `old`. `captureView`
  renders the scene as displayed, compare included.
- **Cost** (`check-compare-render.js`, enclosure base v2 99,277 moves vs base 97,363, `fast`):
  other build + Z table 16 ms (current extrude build 29 ms); worst mode switch CPU 6 ms (ghost fill
  0.9, other recolour 1.8, other flags 1.2, current recolour 2.1) plus the attribute upload.
  Nothing runs per frame; with compare off every hook is one `if (cmp)`.

---

## Controls

Hand-written rather than `three/examples/OrbitControls`, for three reasons: Z is up here and
OrbitControls needs a quaternion shim that makes pole clamping behave oddly; it dollies toward the
target rather than the cursor, which is wrong for inspecting one corner of a 426 mm bed; and the
viewer needs to take the left button away for box select without also losing pan.

| Input | Action |
|---|---|
| Left drag | Orbit (disabled while box or area select mode is on) |
| Middle drag, right drag, Shift/Ctrl + left drag | Pan, at constant screen-pixels-per-mm |
| Wheel | Zoom **to the cursor** |
| — | Damped: every input moves a goal, `update(dt)` eases toward it with `1 - exp(-14 dt)` |

The camera is always `target + r·(sin φ cos θ, sin φ sin θ, cos φ)` with **φ clamped to
[0.008, π − 0.008]**. Clamping is the whole gimbal-flip fix; top view uses φ = 0.008 (≈0.5°, a 3 mm
offset at a 400 mm orbit — invisible) rather than a true pole, so `lookAt` never degenerates.

Near/far bracket the scene's bounding sphere (model ∪ bed ∪ compare mesh, set after `setData`):
`far = (d + R)·1.05 + 1`, `near = (d − R)·0.9`; inside the sphere near falls back to
`max(0.05, min(0.5, far·1e-4))`. Without a sphere: `near = max(0.05, r·0.004)`, `far = 24r + 1200`.
A fixed 0.1 / 10000 pair would throw away almost the whole depth buffer and 0.2 mm layers would
z-fight against each other.

---

## Lighting and colour

`THREE.ColorManagement.enabled = false` and `outputColorSpace = LinearSRGB`. Every hex in
`colors.js` therefore reaches the screen as exactly that hex, modulated only by our own lighting term.
This is not laziness — **the colour is the data**, and a hidden sRGB conversion would mean the legend
swatch and the ribbon no longer match.

Lighting is deliberately narrow-band: ambient 0.30 + hemisphere 0.22 + key 0.46 + fill 0.18, so
luminance runs about 0.30 to 1.16, plus a weak (0.10) Blinn specular so the beads read as rounded
rather than as flat tape. If two speeds ever shade into the same pixel value the ramp has failed,
which is why there is no strong specular and no tone mapping.

Bed: plate at Z = −0.06, minor grid every 10 mm, major every 50 mm, border, origin ring, X/Y arrows
and sprite tick labels. All of it drawn from `meta.bedShape` (`bed_shape` in the slicer config, here
`0x0,426x0,426x426,0x426`), so another machine profile just works.

---

## Measured

**Node, `test/check-render-geometry.js`**, on
`EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v1-ironed_49m.gcode` (92,648 moves, 58 layer indices,
max Z 11.55, bed 426×426):

| | |
|---|---|
| Extrude / travel / retract+prime moves | 68,726 / 20,561 / 3,361 |
| Ribbon vertices / triangles | 824,712 / 871,920 |
| Mitred joints / capped corners | 62,825 (91.4 %) / 11,802 caps |
| Worst gap at a mitred joint | **0.00 mm** (43,081 joints checked) |
| Geometry build | ~30 ms (extrude) / ~35 ms (all three) |
| Recolour 824k vertices | 3 ms |
| GPU footprint | 35.9 MB |

**Browser**, Chrome headless, 1200×760. See the honesty note below.

| | |
|---|---|
| `setData` end to end | 58 ms |
| `setLayerRange` × 5,000 | 0.40 ms total |
| `setViewMode` | 3–4 ms |
| `setVisibleFeatures` | ~3 ms |
| Draw calls for the model | 3 (ribbons, travels, markers) |
| GL errors, console warnings | 0 |

---

## Honesty: what is **not** verified

- **No hardware GPU number exists.** Browser automation is limited to `scripts/screenshot.mjs`
  (headless Edge + SwiftShader over CDP, only when the user asks); adding Playwright would have
  meant a new dependency, so the browser run was Chrome headless on
  **SwiftShader (software rasterisation)**. Everything *functional* is verified there — geometry,
  shaders compiling, picking, box select, gating, resize, thumbnail, dispose, zero GL errors. Nothing
  about **frame rate** is. SwiftShader managed ~5 fps at 872k triangles; that says nothing about a
  real GPU, where 872k triangles in 3 draw calls is unremarkable. **The 60 fps layer-scrub target is
  argued, not measured:** `setLayerRange` is 0.08 µs and uploads nothing, so scrubbing costs exactly
  one ordinary frame per tick. Someone should confirm this on the actual machine.
- **Pick cost is vertex-bound, not fill-bound.** `setViewOffset` shrinks the rasterised area to a few
  pixels but the whole 824k-vertex buffer is still transformed. On SwiftShader that was 37 ms per
  pick; on a real GPU it should be well under a millisecond, but it is not free, so hover picking
  runs only once the pointer has rested 70 ms and reads back asynchronously, so a sweep costs
  nothing extra. If it ever shows up in a profile, the fix is to cull the
  pick pass by layer range as well.
- **No visual A/B against ElegooSlicer.** The screenshot looks right and the feature colours match
  the OrcaSlicer legend by construction, but nobody has put the two side by side.
- **Arcs (G2/G3) are drawn as chords** (≤ 0.02 mm), see the parser.
- **Per-move widths are not blended across a mitre.** If two joined moves have different `;WIDTH:`
  (rare — the annotation usually changes at a `;TYPE:` boundary, which breaks the run anyway) their
  rings differ slightly at the seam. The test excludes those joints for exactly this reason.
- **Selection is a flat recolour**, not an outline. It reads well against every ramp, but a dense
  selection inside solid infill can be hard to see from outside. `frameSelection()` is the answer.
- **The box-select rectangle is a DOM element** appended to the canvas's parent, and the viewer sets
  that parent to `position: relative` if it was `static`. If the UI wants to own that element instead,
  it should pass its own container.
- **Area select and `captureView` are not verified on a GPU.** Headless Edge here has no WebGL,
  so the rubber band, the mode switching, the `onAreaSelect` wiring and the capture image were
  checked only by build + reading. The selection maths is tested in Node; the capture's colour
  match is argued from the three source, not measured. Someone should drag once and compare a
  capture with a screenshot.
- **The compare layer is not verified on a GPU.** Headless Edge has no WebGL here: the ghost's
  look (opacity 0.22, polygon offset hiding coincident moves), the mode switches and the capture
  with compare on were checked only by build + reading. The Z mapping and the costs are tested in
  Node. Someone should load the enclosure base v2, compare it with its base and try all four modes.
- **`renderThumbnail` renders with a transparent background** and hides the bed. The printer screen
  composites it over its own dark tile. If a solid background is ever wanted, that is a new option,
  not a change here.

## Things the integrator must know

1. **Call `setData` with the whole parse result**, not just `segments` — the renderer reads
   `meta.bedShape`, `meta.filamentDiameter` (for flow) and `meta.maxZ`.
2. **Layer indices are `segments.layer` values**, which run 0..`viewer.layerCount - 1`. That is *not*
   the same as `meta.layerCount`: this file reports 57 layers but has 58 distinct layer indices,
   because the slicer emits a `;LAYER:0` stub before the first real layer. Drive the slider from
   `viewer.layerCount`.
3. **`getValueRange('fan')` returns percent (0..100)**, not the parser's 0..1, because `VIEW_MODES`
   declares the unit as `%` and `legendFor` formats whatever it is handed. The ramp uses the same
   scale, so the legend and the ribbons always agree.
4. **Width and height ranges ignore zero values.** A move that ran before the slicer's first
   `;WIDTH:` annotation has width 0, meaning *unknown*, not *zero*; letting it into the range would
   flatten the whole ramp against one outlier. Geometry substitutes a 0.42 mm / 0.20 mm default there.
5. The canvas must have a **non-zero CSS size** before `createViewer`, or at least by the first
   `ResizeObserver` tick. The viewer handles DPR itself, capped at 2 — do not set
   `canvas.width/height` yourself.
6. `onPick` etc. return an **unsubscribe function**; the viewer allows multiple listeners per event.

## Pointers (Claude's boxes) — 2026-09-16

`setPointers([{min:[x,y,z], max:[x,y,z], color, indices?}])` / `setPointers([])`, `framePointers()`.
A `pointers` group under `modelRoot`: per box a `BoxGeometry` fill (opacity 0.07, no depth write)
and `EdgesGeometry` lines with `depthTest:false` so the outline shows through the part; never
pickable, hidden in thumbnails, cleared by `setData`. `indices` are painted in the box colour by
`paintPointed()`, which runs at the end of every `applyColors()` — so view-mode and compare
recolouring keep the paint. No shader change. Planned-change preview: a box with `after`
(`r.after = {min, max}`) also gets a dashed outline at the new place and one arrow per moving edge.

## Pointer views and colours (2026-09-16, evening)

- `framePointers(instant, view)` — `view` is `'top'` (default) or a raised side view from
  controls `VIEWS`: `'hi-right'` / `'hi-left'` / `'hi-front'` (polar 0.95 rad, so the camera looks
  at a wall's face over the walls in front of it). Side views frame tighter (margin 0.9).
- `CLAUDE_COLORS` has 8 entries (added lime `#bef264`, blue `#60a5fa`).
