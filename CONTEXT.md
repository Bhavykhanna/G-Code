# G-code Studio — main context

Last updated: 2026-09-18

A 3D G-code viewer, region selector and edit/re-slice loop for the **Elegoo Neptune 4 Max**,
with Claude Code running inside the app. Sits next to the jobs in `..\` (`phonecase-16pro\`,
`phonecase-17pro\`, `<job>\v1\`).

This file connects everything. Each part has its own context file:

| Part | Context file | Owns |
|---|---|---|
| Parser | [docs/CONTEXT-parser.md](docs/CONTEXT-parser.md) | `src/parser/` |
| Renderer | [docs/CONTEXT-render.md](docs/CONTEXT-render.md) | `src/render/` |
| Server & API | [docs/CONTEXT-server.md](docs/CONTEXT-server.md) | `server/` |
| UI | [docs/CONTEXT-ui.md](docs/CONTEXT-ui.md) | `index.html`, `src/ui/`, `src/styles.css` |
| Claude bridge | [docs/CONTEXT-bridge.md](docs/CONTEXT-bridge.md) | `bridge/`, `src/bridge/` |
| Thumbnails | [docs/CONTEXT-thumbnail.md](docs/CONTEXT-thumbnail.md) | `src/thumbnail/`, `server/thumbnail-*.js` |
| **Diff (compare)** | [docs/CONTEXT-compare.md](docs/CONTEXT-compare.md) | `src/compare*.js`, `src/ui/compare.js`, the renderer's compare layer |
| **Claude in the app** | [docs/CONTEXT-terminal.md](docs/CONTEXT-terminal.md) | `server/terminal.js`, `src/ui/terminal.js`, attach, the API token |
| **To do** | [context-local\TODO.md](context-local/TODO.md) | open work, in priority order |
| **Bugs** | [BUGS.md](BUGS.md) | known defects and their status |
| **Running** | [docs/CONTEXT-running.md](docs/CONTEXT-running.md) | start / restart / reload, ports, the app window |
| **Git** | [docs/CONTEXT-git.md](docs/CONTEXT-git.md) | `.git\`, `.gitignore`, the GitHub remote, what is tracked |
| **Context (all of it)** | [context/README.md](context/README.md) | `context\` — the index of every context file, when to read it, and the rule for updating them |
| **Default print profile** | [profiles/README.md](profiles/README.md) | `profiles\default\` — what a new model is sliced with, every value and why |
| **Demo job** | [demo/README.md](demo/README.md) | `demo\` — a finished job shipped with the app |

Printer, filament, slicing profiles and the file-naming convention live in [`context\`](context/README.md) —
start at its `README.md`, which says when to read which. **Those files are authoritative** for anything about
the printer itself; this one never restates it.

---

## Running it

Commands, ports, restart and reload rules: [docs/CONTEXT-running.md](docs/CONTEXT-running.md).
**Claude: never start or restart anything unless the user asks; refresh with `app-cli.js reload`.**


## Using it

| To | Do |
|---|---|
| Open a file | the file name in the title bar lists every G-code, grouped by folder, old versions included |
| Inspect a move | hover or click it — the right panel shows its values and **source line** |
| Select | **Select** button (viewport corner): **Area** `G` (everything in a rectangle), **Visible** `B` (what you can see), **Layers** `L` (a layer range). Area: lines crossing the rectangle's edge are coloured only inside it (not selected). Selection colour: cyan at 50 % over the move colour, **locked by the user** |
| Change speed / flow / fan / temp there | sliders under **Adjust**, then **Apply to selection** → review the diff → confirm |
| Ask for something geometric | the amber items in the left rail type a re-slice request into Claude's prompt — add details, press Enter |
| Hide / show the side bar | the **side bar icon** (window with a left panel) at the left of the title bar, lit while the bar is shown; or `[`; the notch on the viewport's left edge also brings it back |
| Deselect | **Deselect N** button under the view tools, or `Esc` |
| Talk to Claude | the **Claude** tab under the inspector is real Claude Code, started with the app. **Attach selection** / **attach to Claude** on a move types a reference into its prompt — write your message after it, press Enter |
| Add a printer-screen preview | title bar ⋯ menu → **Add printer preview** |
| See what changed | **Diff** (title bar, or `D`): green = new, red = gone, grey = same; **Overlay** shows the old file as a ghost. **Old / New** sliders set how solid each file is (New below 100 % shows the old one through it); **hide same** hides unchanged moves |
| Keyboard shortcuts | title bar ⋯ menu, or `?` |
| Refresh the app | the ↻ button in the title bar (or F5, which now also works while the Claude terminal has focus). Claude keeps running; from the terminal: `node gcode-studio/server/app-cli.js reload` |
| Check a file before printing | the **Check** button in the title bar (or `K`) draws the findings on the model; from the terminal `node gcode-studio/server/print-check-cli.js "<file>" [--vs "<other>"] [--show]`: tiny islands, skimming / unlifted travels, fast spans, nozzle inside the part, double lines, thin screw seats (`src/printcheck.js`) |
| Finish a draft from the terminal | `node gcode-studio/server/app-cli.js finalize "<draft>" "<what changed>"` |
| See what Claude means | Claude runs `app-cli.js show …`: coloured boxes on the model, moves inside painted in the same colour, listed top-left |
| Finish a version | **Finalize** (title bar, only on a `…_vN-draft.gcode`) → asks what changed, **centres the part on the bed**, gives the final name |
| Centre an older final | `node gcode-studio/server/centre-cli.js "<final>" --aligned-with "<file it was lined up with>"` (dry run; `--apply` writes — ask first) |

**Versions work as drafts** (since 2026-09-16): the first edit of final vN makes
`…_v<N+1>-draft.gcode` next to it (vN stays, it is still the file to print); later edits change
that draft, each step saved in `old\v<N+1>-steps\`; **Finalize** names it and moves vN to `old\`.
Nothing is overwritten or deleted. The app opens the result with the diff on.



## Controls

| Gesture | Action |
|---|---|
| **Left-drag** | Orbit |
| **Middle-drag**, **right-drag**, **Shift/Ctrl + left-drag** | Pan |
| Wheel | Zoom to cursor |
| `Z` / `X` / `V` / `C` | Iso / top / **bottom** / front view. Orbiting below the bed works too: the plate and labels hide, the grid fades and the underside is lit |
| Left-drag in box-select mode | Rectangle select |

## Why this exists

ElegooSlicer already previews G-code in 3D, and previews it well. This tool is **not** a
replacement. It exists for four things the slicer cannot do:

1. **Selection → Claude.** Box-select a region; Claude gets the exact move indices and source
   line numbers and can reason about that region specifically.
2. **Parametric region edits** with a diff, a safety validator, and automatic versioning into
   the project naming convention.
3. **Version A/B diff** — settings, per-layer time and per-feature time, answering "where did
   the 5 minutes go between v3 and v4".
4. **Thumbnail injection** — CLI slicing produces no preview image, so the printer screen shows
   a blank tile.

## The one hard boundary

**G-code is the slicer's output, not a model.** Anything geometric — wall count, line width,
infill density, layer height, supports, the gaps in the hexagon pattern — *cannot* be edited
here and must go back through ElegooSlicer. A full re-slice takes **1.4–2.3 s** and is
byte-identical given the same inputs, so this is cheap and it is always the right answer.

Two lanes, and the UI always shows which one you are in:

| Lane A — direct G-code edit (instant) | Lane B — re-slice (~2 s) |
|---|---|
| speed, fan, nozzle temp, acceleration | wall count, line width, infill %, layer height |
| flow ±20 % **hard cap** | brim, skirt, supports, ironing |
| delete a region (e.g. strip the brim) | anything that changes geometry |
| insert pause / `M600`, Z-offset | driven by Claude editing `process.json` / `filament.json` |

Claude drives Lane B from the terminal most of the time, so the app has a re-slice **trigger and
result compare**, not a 509-setting GUI. A settings GUI is deliberately deferred.

---

## Status

| Part | State | Verified by |
|---|---|---|
| Parser | done | deposited filament matches the slicer footer to **0.0001 %** (5022.23 mm), 92,648 moves in **122 ms** |
| Selection | done | move indices → line ranges round-trips 1,916 → 1,916 exactly; per-feature count, length and time. Area highlight matches the rectangle (2026-09-17, confirmed by the user) |
| Renderer | done | 872k triangles in **3 draw calls**, `setData` 58 ms, layer scrub 0.4 ms / 5,000 calls; pan confirmed by the user |
| Server & API | done | all 6 server test files pass (`node test/server-all.js`); real re-slice 1.4–2.3 s, byte-identical output |
| UI | done | builds clean, no overflow 738–1898 px, dark only since 2026-09-16 |
| Lane A edits | **wired end to end** | selection → ops → dry-run diff → confirm → new version → reopen. speed / flow / fan / temp all validate clean on the real 17 Pro file; flow +25 % refused |
| Thumbnails | done, **in use** | GUI payloads re-encode character-identical; server render ~50 ms; both phone cases now carry previews (16 Pro v5, 17 Pro v2) |
| Diff (compare) | **done, approved by the user** | plastic-per-layer matching; moved screw holes green, old ones red at 55 %; see docs/CONTEXT-compare.md |
| Claude in the app | **built, in daily use** | live terminal; attach; token on the API — see docs/CONTEXT-terminal.md. The mailbox panel was removed |

`npm run check` → integration 28/28, real file, arcs, area select, compare, compare render and align all pass
(B12 fixed 2026-09-17). `node test/server-all.js`
→ all 6 files pass; `npm test` reports server files failing only because they run in parallel (B13).
Server tests use their own bridge folder (`test/_isolate.js`), so they no longer disturb the running app.

## Known issues, open

1. **Thumbnails not yet seen on the printer screen.** Everything matches ElegooSlicer's own output
   byte-for-byte, which is strong evidence, not proof. Check the tile the first time you load one.
2. **Hover still costs one geometry pass** — but now only once the pointer rests for 70 ms, so a
   sweep across the model costs nothing extra. Eliminating it entirely would need a CPU spatial index.
3. **Fan / temp edits apply to the span of a selection**, not just the selected moves — they are
   machine state. A sparse selection also affects the moves between its pieces; the server
   reports a coverage note when that happens.
4. **Only files that follow the naming convention can be edited or previewed**, because the new
   version's name is derived from the old one. The `<job>\v1\` files do not follow it.

## Fixed on 2026-09-16

- Pan sticking to the cursor, and panning slicing the model open (confirmed by the user).
- Lane A edit buttons did nothing — now connected to the server.
- Claude's chat replies never appeared: the server sends `{messages:[...]}`, the app appended the
  wrapper. File-change events never arrived: the server names them `gcode`, the client listened for `file`.
- File menu listed job folders instead of files.
- Selection panel showed dashes for per-feature length and time.
- `/api/thumbnail` added (now title bar ⋯ menu → **Add printer preview**); refuses to mint an identical version when a file
  already has a preview.
- Server tests pinned "current" file names that change with every new version; they now use the
  frozen files in `old\` and check the versioning rules instead of today's counts.
- Left rail clipped Moves and Geometry on short windows — now scrolls, and every section
  collapses (arrow or title click; collapse all / expand all at the top; remembered).
- Restarting left the previous window open, sometimes two — the launcher now closes it, and the
  app uses its own browser profile so that is safe.
- Hover picking waits for the pointer to rest (70 ms) instead of firing ~20× a second mid-sweep.

Open work is tracked in [context-local\TODO.md](context-local/TODO.md); known defects in [BUGS.md](BUGS.md).

## Traps that already cost time

- **`index.html` falls back to a mock harness** when `src/main.js` fails to import. It now shows
  a red error bar saying so — previously it failed silently and looked like a working app full
  of fake data.
- **Query strings must be `encodeURIComponent`'d.** Filenames contain `HSPLA+`, and a raw `+`
  decodes as a space, giving a 404.
- **`dryRun` defaults to `true`** on `/api/edit`. A real write needs `dryRun:false` *and* a
  non-empty `note`, which becomes the `<what-changed>` field in the new filename.
- **The slicer writes its log to `00000.log` in its working directory**, not to stderr, which is
  always empty. On a failed slice read `slicerLog`.
- `layers.length` is 58 for the 57-layer 17 Pro file — `layer_change_gcode` emits a trailing
  `;LAYER:`. Display `meta.layerCount`; use `layers[]` for geometry.

---

## Layout

```
gcode-studio\
  CONTEXT.md            <- you are here
  docs\                 per-part context files
  index.html            app shell (+ mock-harness fallback)
  src\
    main.js             integration: wires parser + renderer + UI + server
    selection.js        move indices -> source line ranges
    styles.css          design tokens and all styling
    parser\             gcode -> typed arrays
    render\             three.js scene, geometry, GPU picking, controls
    ui\                 panels, layer bar, inspector, Claude terminal, diff modal
    thumbnail\          COLPIC + PNG encoders, G-code injection
    bridge\             client for the server (API, SSE events incl. reload/open/highlight); the mailbox is legacy
  server\               node API: files, edits, versioning, re-slice, diff, chat
  bridge\               selection.json, attached\ (what the app hands Claude); chat.jsonl is legacy
  context\              the whole Archive context, moved here 2026-09-19 so it is in the repo:
                        preferences / versions (always loaded) + printer / profiles / slicing /
                        archive-map / OPEN-DECISIONS, and memory\ (read every file at session start)
  demo\                 a finished job shipped with the app (iPhone 17 Pro cover, two versions)
  scripts\              dev.js (API + Vite), close-previous.ps1 (launcher cleanup),
                        screenshot.mjs (headless 3D shots, only when the user asks)
  test\                 parser, geometry, server, thumbnail and contract checks
  backup\               code snapshots taken before risky changes (restore by copying back + reload)
  run-gcode-studio.bat  double-click launcher
```

Deps: **three**, **vite**, and for the in-app terminal **@xterm/xterm**, **@xterm/addon-fit**, **node-pty** (ships a Windows prebuild — no compiler) and **ws**.

**The API needs a token** since 2026-09-16 (BUGS B9): the server writes it into the page and to `.gcs-token`. `curl -H "X-GCS-Token: $(cat .gcs-token)" ...`

---

## Shared contract

Depended on by more than one part. **Changing anything here means updating every part that
reads it.**

### Parse result (`src/parser/parse.js`)

```js
{
  meta: { generator, layerCount, maxZ, minZ, filamentDiameter, filamentDensity,
          estimatedTimeText, estimatedTimeSec, filamentUsedMm, filamentUsedCm3,
          filamentUsedG, bedTemp, bedShape, eol, lineCount },
  config,     // the full CONFIG_BLOCK from the footer, 624 keys, string values
  segments,   // struct-of-arrays, all length `count`
  layers: [{ index, z, firstSeg, lastSeg, lineStart, lineEnd,
             time, extrudeMm, filamentMm, maxFan, temp }],
  warnings, count, relativeE, timeScale, parseMs
}
```

| Field | Type | Meaning |
|---|---|---|
| `x0,y0,z0,x1,y1,z1` | Float32Array | move start and end, mm |
| `e` | Float32Array | **relative** filament delta, mm |
| `width`, `height` | Float32Array | extrusion width / layer height, mm (0 when not extruding) |
| `speed` | Float32Array | mm/s |
| `fan` | Float32Array | 0..1 |
| `temp`, `accel` | Float32Array | °C, mm/s² |
| `time` | Float32Array | seconds, scaled so the total matches the slicer's own estimate |
| `feature` | Uint8Array | index into `FEATURE_NAMES` |
| `kind` | Uint8Array | `EXTRUDE 0` / `TRAVEL 1` / `RETRACT 2` / `PRIME 3` |
| `layer` | Uint32Array | layer index |
| `line` | Uint32Array | **0-based source line — this is what makes editing possible** |

### Colours

`src/render/colors.js` is the **only** place a colour is defined. Renderer and UI legend both
import from it. Do not hardcode a colour anywhere else.

### A selection

```js
{
  id: 'sel-<timestamp>',
  file: 'phonecase-17pro/EN4Max_....gcode',
  lineRanges: [[from, to]],   // inclusive, 0-based source lines
  summary: { count, layers:[min,max], zRange:[min,max],
             features: { 'Outer wall': { count, lengthMm, timeSec }, ... },
             lengthMm, timeSec, filamentMm,
             speed:{min,max,avg}, width:{...}, fan:{...}, flow:{...} }
}
```

Written to `bridge/selection.json`. Full format in
[docs/CONTEXT-bridge.md](docs/CONTEXT-bridge.md). **A selection is only valid for the exact file
it names** — a new version moves every line number, so the app clears it on file change.

### Safety rules — non-negotiable, this drives real hardware

1. **Never modify a final in place.** An edit to a final writes a `-draft` of the next version;
   a draft is changed in place only after its previous state is saved as a step in
   `old\v<N>-steps\`. Finals move to `old\` on finalize. Nothing is ever deleted.
2. **Every write is validated first** (`server/api/validate.js`): Z never decreases within a
   layer, E deltas sane, all moves inside the 426×426 bed and under Z 480, temps in range,
   retract/prime balanced, no dangling feature block.
3. **Every edit shows a diff and requires explicit confirmation.** Confirm stays disabled while
   any validation error is present — no override.
4. **Flow changes are hard-capped at ±20 %.** Enforced three times: the op rejects, the
   validator rejects independently, and the slider cannot be dragged past it.
5. **Edits require `M83` relative extrusion.** In absolute-E files one E edit invalidates every
   later E, so editing is disabled outright.

## Update 2026-09-18

**Check button** in the title bar, next to Diff (`K`): runs `checkPrint` + `checkScrewSeats` on the open file in the
browser and draws the findings as the pointer boxes `print-check-cli.js --show` uses, with a toast saying
`N HIGH, M MEDIUM` (+ thin screw seats). Press again to clear. No server change, so a rebuild + `app-cli.js reload`
is enough. Code: `runCheck` / `checkBoxes` in `src/main.js`, button and `K` in `src/ui/layout.js`, notes in
docs/CONTEXT-ui.md. Backup before the change: `backup6-09-18-before-check-button\`.

Job work this day (enclosure base v3): hollow L-bracket feet, the box floor printed inside the pockets, and a 45 deg
roof on the pockets — all in `..\<job>\v2\` (`build.py --hollow-feet`, `--feet-pocket-roof`,
`hollow_feet.py`), see that folder's `CONTEXT-chat.md`.

## Update 2026-09-17

Area select fixed: with "Fully inside", long lines crossing the rectangle stayed uncoloured and hid the
selected moves under them. Now those lines are coloured per pixel only inside the rectangle (the region
stays fixed on the model when orbiting); the selection sent to edits / Claude is unchanged. Selection
cyan is **50 %** over the move colour — locked by the user. Details: docs/CONTEXT-render.md → *Area select*.
Backup of the code before the change: `backup\2026-09-17-before-area-clip\` (src, test, dist).

Align notes got an `atFinal` list: step files that are copies of the centred final get no shift in the diff
(docs/CONTEXT-compare.md). Needed because the enclosure base's corner fix replaced the v2 final under the same
name and kept the old one as `old\v2-steps\04-...`. Backup before that change: `backup\2026-09-17-before-atfinal\`.
`centre.js` changed too; that only matters for Finalize, which needs a server restart anyway (ask first).

Diff card: **Old / New** opacity sliders and **hide same** (Changes), remembered per mode; New below 100 % draws
the new file see-through over the old one (docs/CONTEXT-compare.md, "Diff look"). Not yet confirmed by the user;
backup `backup\2026-09-17-before-diff-look\`.

`alignFor` also finds a base that Finalize moved into `old\` after the note was written (found finalizing the
enclosure base v3; backup `backup\2026-09-17-before-align-old\`).

Code backups from today are in `backup\` (one folder per change; copy back + `app-cli.js reload` to undo).

**End of 2026-09-17:** also a title-bar **side bar icon** (window with a left panel; the old `‹` hide button is gone),
docs/CONTEXT-ui.md. Built but not yet seen by the user: diff opacity sliders, side bar icon, hidden launcher.
Open work in context-local\TODO.md "Next up"; where the jobs stand: `..\<job>\v2\CONTEXT-chat.md` (top).

## Update 2026-09-16 (evening)

Used end to end on a real job (`..\<job>\v2\`): preview with `app-cli show`
(`--move`, `--to`, raised side view for wall openings) → build → diff → finalize → pen drive. The
diff was rewritten cleanly on the way (docs/CONTEXT-compare.md) and approved by the user. The app
reopens the last open file on start. See context-local\TODO.md / BUGS.md for what is open.

**Print check (2026-09-17):** `src/printcheck.js` (`checkPrint`, `checkScrewSeats`) + `server/print-check-cli.js`,
tested by `test/check-printcheck.js` (in `npm run check`). Written after the enclosure base v3 printed with melted,
blackened opening tops. Calibrated on the enclosure base, the lid and both phone cases: base v3 36 HIGH (divider bars,
opening tops, pad pockets, holder dots), lid 0, phone cases 0-1.
**Launcher (2026-09-17):** the server runs without a console window; output in `.server.log`; `stop-gcode-studio.bat`
closes window + server. Not yet started this way (it needs the next launch).

## Update 2026-09-19

**Everything Claude reads now lives in this repo.** `Archive\context\*.md`, `OPEN-DECISIONS.md` and the
memory files moved into `context\` (memory into `context-local\memory\`); `Archive\CLAUDE.md` stays at the
Archive root as a pointer, because Claude Code loads a `CLAUDE.md` by location. Every read path was
rewritten (docs, server comments, job READMEs). The old memory folder under `%USERPROFILE%\.claude\`
holds a one-line pointer.

**Git:** remote is now `https://github.com/bhavy-wilyer/G-Code.git` (this PC's own account, already
logged in — no token needed); the second-account isolation was removed. The repo is **public** by the
user's choice and still has **zero commits** — Claude does not add, commit or push without being asked.
`.gitignore` now blocks `*.gcode` / `*.stl` / `*.3mf` / `*.exe` and `scripts\shots\` outright, with one
exception: `demo\`. See [docs/CONTEXT-git.md](docs/CONTEXT-git.md).

**Demo job** (`demo\phonecase-17pro\`): the finished iPhone 17 Pro cover — current version with its
printer preview, the previous version so Diff has a base, the STL and the three profiles. 11 MB, so a
clone can open, diff, check and re-slice a real file without the print archive.
