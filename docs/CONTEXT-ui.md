# UI — context

Last updated: 2026-09-18

Owns `index.html`, `src/styles.css`, `src/ui/`. Nothing else. No dependencies —
vanilla ES modules and CSS, icons are inline SVG.

`src/main.js` is the only consumer. It talks to exactly one function,
`createUI(root)`, and never reaches into a panel module.

| File | Owns |
|---|---|
| `index.html` | the shell document, the boot/fallback logic, the favicon |
| `src/styles.css` | design tokens and **all** styling |
| `src/ui/layout.js` | builds the frame, wires the panels, exposes the public API, holds the mock harness |
| `src/ui/toolbar.js` | view modes, feature toggles, travel/retract, viewport tools (camera presets incl. bottom, fit, the Select button + panel, × exit, Deselect N), the Lane B list |
| `src/ui/legend.js` | colour key: list (share %, meta, note) or ramp; collapses to a title pill |
| `src/ui/compare.js` | the diff card (`createCompareBar`) and Claude's pointer list (`createPointerList`) |
| `src/ui/layerbar.js` | the vertical layer range control + per-layer time histogram |
| `src/ui/inspector.js` | picked-move readout, selection summary, Lane A adjust, attach buttons |
| `src/ui/terminal.js` | the live Claude Code terminal (xterm.js), its tool bar and menus — see [CONTEXT-terminal.md](CONTEXT-terminal.md) |
| `src/ui/diffmodal.js` | the edit-confirmation gate and the generic modal host |
| `src/ui/toast.js` | transient notifications |

Colours come from [`src/render/colors.js`](../src/render/colors.js) and nowhere
else — see *Data colour* below.

---

## Layout

Full viewport, no page scroll, CSS grid:

```
+-----------------------------------------------------------------------+
| title bar  logo | file switcher | time / filament / layers | Finalize Check Diff ↻ ⋯ |
+---------+--------------------------------+-------+--------------------+
|  rail   |  viewport  (the <canvas>)      | layer |  inspector         |
|  modes  |    TR: camera + Select         |  bar  |  ---- split -----  |
|  feats  |        (+ Deselect N, panel)   |       |  Claude (terminal) |
|  moves  |    TL: diff card + Claude's key|       |                    |
|  Lane B |    BL: legend   BR: toasts     |       |                    |
|         |  < rail notch on the left edge |       |                    |
+---------+--------------------------------+-------+--------------------+
| status bar  parse ms | moves | layers | warnings | lanes | connection  |
+-----------------------------------------------------------------------+
```

Three things about this that are decisions, not accidents:

- **The layer bar is docked to the right edge of the canvas**, not in the
  bottom strip. It is vertical because layers are vertical, and it sits next to
  the model so the eye does not travel.
- **The right panel is a resizable split, not tabs.** The whole point of the
  tool is "I selected this region, now let me talk about it", so the selection
  summary and the chat have to be visible at the same time. Drag the divider to
  re-weight, double-click to reset, drag the panel's left edge to widen it.
  Both are persisted in `localStorage`.
- **Toasts are mounted inside the viewport**, bottom-right of the *canvas*, not
  of the window. The bottom-right of the window is Claude's terminal prompt, and a
  notification that covers what you are typing into is worse than no
  notification.

Responsive, verified with no horizontal or vertical page overflow from 738 px to
1898 px wide: panels narrow at 1400 and 1180, the rail becomes an overlay drawer
below 980 (a hamburger appears in the title bar), the layer-bar histogram drops
below 760.

### The file name

The naming convention in [`../context/versions.md`](../context/versions.md)
puts the meaningful part of a file name at the **end**
(`..._v4-ironed_57m.gcode`). So the title bar truncates in the **middle**, never
the tail: the version suffix is rendered in the accent colour and is always
whole, the prefix is dimmed and gets the ellipsis. The cut point is measured
with `canvas.measureText` against the element's real width and recomputed on
resize, so it is exact rather than a character-count guess.

---

### Title bar (2026-09-16, user request)

Logo only (the window title already names the app) · file switcher · stats · **Finalize** (drafts) ·
**Check** (the print check, drawn on the model) · **Diff** · ↻ refresh · **⋯ menu** (Add printer preview, Keyboard shortcuts). **Dark only**: the
light/dark toggle was removed; `data-theme` is forced to `dark` (the light tokens in `styles.css` are
unused but left in place). Two top bars (Windows + app) stay for now — see TODO.

### Rail, Select panel, Deselect (2026-09-16, user request)

- **Hide the rail**: `‹` at the top of the rail or `[`. A notch on the viewport's left edge (`.rail-notch`)
  brings it back. `data-rail-hidden` on `.app`, remembered in `gcs.rail.hidden`. Below 980 px the
  same controls drive the existing drawer.
- **Select panel** is separate from the select mode: choosing Area / Visible closes the panel and the
  mode stays on (the button then reads "Area" / "Visible"); clicking the button reopens the panel;
  Layers keeps it open until "Select these layers". `×` next to the button, **stop (Esc)** in the panel,
  or `Esc` leaves select mode. **hide** closes the panel only.
- **Selection colour** (2026-09-17, **locked by the user**): cyan mixed 50 % over the move's own colour,
  model stays solid (an X-ray look was rejected). Area select colours crossing lines only inside the
  rectangle — see CONTEXT-render.md → *Area select*.
- **Side bar icon** (2026-09-17, user: open / close the side bar with a window icon): the title bar's first button
  (`tb-railbtn`, icon `I.sidebar`) shows / hides the rail at every window width (`toggleRail()`, same as `[`);
  `aria-pressed` = bar shown. Narrow windows still start with the overlay rail closed. It used to be a menu icon that
  only existed below 980 px. The old `‹` hide button at the top of the rail was removed (user); the notch still shows a hidden bar. Backup: `backup\2026-09-17-before-sidebar-btn\`.
- **Deselect N** appears under the viewport tools whenever something is selected
  (`vptools.setSelectionCount`, fed by `showSelection`).
- The Select button shows the active mode's name; the rail-tools labels (collapse all / expand all)
  do not wrap (`white-space: nowrap`).

## Design tokens

All of them live in the `:root` block at the top of `styles.css`, with a
`:root[data-theme="light"]` override (unused since 2026-09-16: dark only). Nothing outside that block hardcodes a
colour, a spacing step, a radius, a duration or a font.

| Group | Tokens | Why this shape |
|---|---|---|
| Surfaces | `--surf-0` … `--surf-8` | Nine steps, cool-shifted (hue ~218), ~4–6 % lightness apart. **Elevation is a surface step, not a border or a shadow.** `--surf-0` is `#080a0d`, never `#000`: pure black makes the canvas read as a hole. The warm data colours (orange outer wall, yellow inner wall) read as warm against a cool grey. |
| Glass | `--glass`, `--glass-strong`, `--scrim` | Translucent, for the things that float over the canvas (legend, camera tools, menus, toasts). A solid panel there cuts a hole in the model. |
| Text | `--fg-1` … `--fg-4` | Four steps. `--fg-1` is `#e5eaf1`, not white — pure white blooms on a dark surface and makes dense numeric text harder to scan. |
| Hairlines | `--line-1/2/3` | Alpha, not solid, so one line reads correctly on every surface step. |
| Accent | `--accent`, `--accent-hi/lo/tint`, `--on-accent` | A single indigo `#5b7cfa`. Chosen because no feature colour in `colors.js` sits near it, so a selected chrome control is never mistaken for data. |
| Status | `--ok`, `--warn`, `--err`, `--info` + `-tint` | |
| Lanes | `--lane-a*`, `--lane-b*` | See *The two-lane language*. |
| Spacing | `--s-1` (2px) … `--s-10` (40px) | 2px-based and tighter than a normal web scale. This is a technical tool: hierarchy comes from type weight and colour, not from whitespace. |
| Radii | `--r-1` (3px) … `--r-4` (10px) | Small. Large radii read as "consumer app"; instruments have tight corners. |
| Type | `--t-micro` (10px) … `--t-2xl` (26px) | Working range is 11–13 px. 10 px only for all-caps micro labels, where `--track-caps` letter-spacing carries legibility. |
| Motion | `--dur-1/2/3` (110/150/190 ms), `--ease*` | Fast enough to feel native, slow enough to be seen. A `prefers-reduced-motion` block collapses everything to 1 ms. |
| Frame | `--titlebar-h`, `--statusbar-h`, `--rail-w`, `--side-w`, `--layerbar-w`, `--ctl-h` | The grid metrics. `--side-w` is also written inline on `.app` by the panel-width drag. |

### Typography

- UI sans: `ui-sans-serif, -apple-system, "Segoe UI Variable Text", "Segoe UI", …`
- Mono: `ui-monospace, "Cascadia Mono", "Segoe UI Mono", Consolas, …`

**Every numeric readout is tabular-figure monospace** (`.mono` / `.num`, which
set `font-variant-numeric: tabular-nums slashed-zero`). In a live inspector
that updates on hover, proportional digits jitter by a few pixels per frame and
the column becomes unreadable. File names, G-code, source line numbers and
measurements all use the mono stack for the same reason.

### Data colour

`colors.js` is the only source of a data colour and this rule is absolute:

- feature swatches in the rail, the legend and the selection breakdown read
  `FEATURE_COLORS` / `legendFor()` and apply them as an inline `background`;
- the travel / retraction toggles use `TRAVEL_COLOR` / `RETRACT_COLOR`;
- the layer-time histogram samples `RAMPS.layerTime` through `sampleRamp()`,
  so it matches the renderer's own layer-time ramp;
- `styles.css` contains **no** feature colour at all.

If a colour looks wrong next to ElegooSlicer, change `colors.js`. Nothing in
`src/ui/` needs to know.

### `[hidden]`

Every panel in this app is shown and hidden with the `hidden` property, and
most of the hidden things set `display` in a class rule — which silently beats
the UA sheet's `[hidden]`. `styles.css` therefore declares
`[hidden] { display: none !important; }` near the top. One `!important` is
cheaper than remembering a `[hidden]` rule per class, and forgetting one is
invisible until a panel renders on top of another.

---

## The public API (`src/ui/layout.js`)

```js
import { createUI } from './ui/layout.js';
const ui = createUI(document.getElementById('app'));
```

### Required surface

| Method | Notes |
|---|---|
| `getCanvas()` | The `<canvas>`. See *The canvas contract*. |
| `setFile({name, path, meta, layers, warnings, parseMs, count})` | Populates the title bar, the stat strip, the layer bar and the status bar. `layers` is the parse result's `layers` array verbatim. **Emits `onLayerRangeChange` once** — see below. Optional extra key `relativeE: false` disables the Lane A controls outright (CONTEXT.md safety rule 5). |
| `setJobs(jobs, currentPath)` | `jobs` may be strings or `{path, name?, time?, meta?}`; grouped in the menu by directory. |
| `showPickedSegment(info \| null)` | `info` is a plain object of **already-formatted** field/value pairs, rendered in insertion order. Any key whose name ends in "line" (but not "Line width") is accented and gets a copy button; every row is copyable on hover, plus "copy all". |
| `showSelection(summary \| null)` | Accepts the CONTEXT.md `summary` object **or** a whole selection (`{id, summary}`). The `id` is what the chat attaches to a message; if absent, one is generated locally. |
| `setViewMode(id)` / `onViewModeChange(cb)` | `id` from `VIEW_MODES`. |
| `setLegend(entries)` | Straight from `legendFor()`. The array's `layout` decides: `'list'` = swatch rows (features in the file; or the values a numeric mode actually uses, with their share of the plastic), `'ramp'` = gradient bar with ticks at real values. `entries.note` is a footnote. Collapsed, the legend is a small title pill. While a diff is on, Changes mode shows the diff key instead (Only in this file +m / Only in the base −m / Same in both); Overlay keeps these entries and adds the note "faint ghost = <base>". Numeric entries come from `legendFor(mode, viewer.getValueRange(mode), unit)` (single/discrete → list with share %, quantile → ramp); feature entries from `legendFor('feature', counts)`, only features in the file. |
| `onLayerRangeChange(cb)` → `cb(lo, hi)` | Fires on every drag frame. |
| `setLayerRange(lo, hi)` | Does not fire the callback. |
| `onFeatureToggle(cb)` → `cb(Set<featureIndex>)` | |
| `onTravelToggle(cb)`, `onRetractToggle(cb)` | Both start **off**: on a 92 k-move file the travel web hides the part. |
| `onCameraPreset(cb)` → `cb('iso'\|'top'\|'bottom'\|'front'\|'fit')` | |
| `onSelectModeChange(cb)` → `cb('box' \| 'area' \| 'layers' \| null)` | One Select button, three modes (Area / Visible / Layers), at most one on. `box`/`area` set a crosshair cursor; `layers` draws nothing. `setSelectMode(m)` sets it without firing. |
| `onSendToClaude(cb)` → `cb(note)` | The **Attach selection** button / `Ctrl+Enter`. `note` is `''`, or one line describing any non-zero Lane A sliders. |
| `onAttachMove(cb)` | The **attach to Claude** link on a picked move. |
| `startTerminal({url})` | Starts the live terminal; `url()` returns the `ws://` URL with the token. Not called by the mock harness. |
| `typeToClaude(text)` → `bool` | Types `text` into Claude's prompt **without Enter**, switches to the Claude tab. `false` if the terminal was never started. |
| `onFileOpen(cb)` → `cb(path)` | |
| `confirmEdit({title, subtitle?, diff, validation, confirmLabel?, lane?})` → `Promise<bool>` | Resolves `true` **only** on an explicit confirm click. |
| `toast(message, kind)` | `'info' \| 'success' \| 'warn' \| 'error'`. Errors do not auto-dismiss. |
| `setStatus({connected, message})` | Updates the connection dot and text in the status bar. |
| `setBusy(bool, label)` | Indeterminate bar above the status strip plus a label in it. |

### Chat surface

Removed 2026-09-16 with the mailbox (see "mailbox removed" below).

### Optional extras

Not required by the brief; safe to ignore.

| Method | Notes |
|---|---|
| `setFeatureCounts(counts)` | `{featureIndex \| name: n}`. Shows a count next to each toggle and hides features the file does not contain. Without it, all 17 feature types are listed. |
| `onEditRequest(cb)` | Fires for a Lane A "Apply to selection" (`{lane:'A', changes, selectionId, summary, note}`) and for a Lane B rail click (`{lane:'B', key, label, file}`). If unwired, the UI toasts that the pipeline is not connected rather than pretending something happened. |
| `onClearSelection(cb)` | The user cleared the selection from the UI (**Deselect N** button, × in the inspector, or `Esc`). |
| `focusClaude()` | Focuses the terminal. |
| `getAreaOptions()` / `onAreaOptions(cb)` → `cb({match, includeAux})` | The Select panel's "Counts if" rule and the skirt/brim tick. |
| `onSelectLayers(cb)` → `cb(lo, hi)` | Layers mode: "Select these layers". |
| `onDiff(cb)`, `onDiffPick(cb)`, `onCompareMode(cb)` → `cb('changes'\|'both')`, `onFinalize(cb)` | Title bar Diff / base picker / Changes–Overlay / Finalize. |
| `onCheck(cb)`, `setChecking(bool)` | Title bar **Check** (and `K`): run the print check on the open file and draw its findings as pointer boxes; `setChecking` lights the button while they are on the model. |
| `showCompare({name, path, mode, stats} \| null)`, `setCompareBusy(text)`, `setDraft(bool)` | Diff card; "comparing…"; shows Finalize on drafts. |
| `setSelectMode(m)`, `getSelectionId()`, `getViewMode()`, `getLayerRange()`, `showShortcuts()`, `destroy()` | |

### The canvas contract

`layout.js` sizes the canvas **with CSS only** and never touches
`canvas.width` / `canvas.height` — the renderer owns the backing store. On
every viewport resize it dispatches a bubbling `gcs:resize` `CustomEvent` on the
canvas:

```js
ui.getCanvas().addEventListener('gcs:resize', (e) => {
  const { width, height, dpr } = e.detail;   // CSS pixels
  renderer.setSize(width, height, false);    // false: do not write inline styles
});
```

Ignore it if the renderer has its own `ResizeObserver`; it is additive.

### `setFile` emits a layer range

Layer 0 in this dialect is the start-G-code stub, so the layer bar's default
range is `[1, maxLayer]`, not `[0, maxLayer]`. `setFile` therefore calls
`onLayerRangeChange` once after loading the layers, so the renderer draws what
the bar says it is drawing. If main.js has already called
`viewer.setLayerRange(0, top)`, this corrects it on the same tick.

---

## The layer bar

Two handles on one vertical track:

- **top handle = `hi`** — the layer you are looking at.
- **bottom handle = `lo`** — how far down the stack stays visible.

| Gesture | Result |
|---|---|
| Drag a handle | Moves that handle; the other is pushed if crossed. |
| Drag the filled band between them | Moves both, keeping the depth — this is how you sweep a fixed-depth window up through a part. |
| Click the track | Jumps the nearer handle there and starts dragging it. |
| Click / drag the histogram | Scrubs `hi`. The histogram is what you are actually looking at when you hunt for a slow layer. |
| Wheel over the bar | Steps `hi` by 1, or 10 with Shift. |
| Hover anywhere in the bar | A tooltip with the layer number, Z and layer time. |
| `↑` `↓` with a handle focused | ±1 layer. |
| `Shift` + `↑` `↓` | ±10 layers. |
| `PageUp` / `PageDown` | ±10 layers. |
| `Home` / `End` | Top / bottom of the stack. |
| The two buttons under the track | "Show all layers" and "Show only the top layer". |

Both handles are `role="slider"` with live `aria-valuenow` / `aria-valuetext`.

**The histogram** is per-layer print time, drawn into a `<canvas>` (a 1000-layer
file would otherwise be 1000 DOM nodes restyled on every frame of a scrub).
Colour comes from `RAMPS.layerTime`.

Two outliers would make it useless if it scaled to the true maximum: the layer-0
stub (heat-up waits) and layer 1 (slow base + brim + skirt — 689 s against a
15 s median on a real phone-case file). So the scale is the **92nd percentile**
of the real layers, and the few bars above it are drawn full width with a notch
on the leading edge so they still read as off-scale rather than as ordinary.

**Layer 0** is handled explicitly everywhere: excluded from the histogram scale,
drawn as a hatched zone at the bottom of the track, labelled `start G-code`
instead of a Z height, and excluded from the default range.

One gotcha worth knowing if you touch this file: `.lb-hist` must keep
`flex: 1 1 0`. A `<canvas>`'s intrinsic size comes from its `width`/`height`
attributes, which the paint writes every frame; with `flex-basis: auto` that
feeds back into layout, re-fires the `ResizeObserver`, and the bar repaints
forever.

---

## The two-lane visual language

From CONTEXT.md, *The one hard boundary*: speed / fan / temp / flow are numbers
already in the G-code and can be edited directly (Lane A, instant); anything
geometric has to go back through ElegooSlicer (Lane B, ~2.2 s re-slice). The UI
must never let a Lane B action look like something it can do to a file.

| | Lane A | Lane B |
|---|---|---|
| Colour | `--accent` indigo | `--lane-b` amber |
| Badge | `LANE A · INSTANT` | `RE-SLICE` |
| Second signal | none needed | a **diagonal hatch** on the leading edge (`.lane-b-edge`) — amber alone is not enough for a colour-blind user |
| Where it appears | the Adjust panel in the inspector, the diff modal header | the *Geometry* group in the rail, the diff modal header |
| What a click does | opens the diff + validator, then writes a new version | opens a re-slice **request**; never touches the G-code |

Both badges also sit permanently in the status bar with a tooltip explaining
the difference, so the vocabulary is learnable without hunting.

**The ±20 % flow cap** (safety rule 4: the UI must refuse, not warn) is enforced
in three independent places:

1. the range input's own `min`/`max`,
2. a clamp in the change handler,
3. amber end-stop marks drawn on the track, so the limit is visible before you
   reach it rather than being a message after you break it.

The slider physically cannot be dragged past ±20 %. There is no override.

The diff modal is the same idea: **confirm is disabled while the validator
reports any error**, there is no "apply anyway", `Enter` does not confirm, focus
starts on Cancel, and every exit path except an explicit confirm click resolves
`false`.

---

## The chat panel (history — removed 2026-09-16)

`src/ui/chat.js` is deleted; this section and the two below describe the old mailbox panel.

Claude is **not** a service the page calls. The transport is a file-backed
mailbox — `bridge/chat.jsonl` — that the server appends to and that Claude reads
from the terminal on a polling loop. A reply arrives when Claude next looks,
which is tens of seconds. Everything in the panel follows from that:

- a sent message appears immediately as `sent`, with an explicit waiting state
  and a **running elapsed timer**, so silence is a number rather than a mystery;
- there is **no typing indicator**, because nothing is typing;
- the header carries the transport state (`live` / `polled 4s` / `offline`) and
  the time since the last poll;
- the composer disables with a stated reason when the server is unreachable.

The elapsed-time ticker starts on demand and stops as soon as nothing is
waiting. When it is off, the "polled Ns ago" label is refreshed by each
`setChatState()` call, which main.js makes on every poll anyway.

### Message format (contract with the server) (history — removed 2026-09-16)

One JSON object per line in `bridge/chat.jsonl`:

```json
{"id":"msg-1726500000000-a1","ts":"2026-09-16T12:34:56.000Z","role":"user","text":"...","selectionId":"sel-...|null","status":"pending|seen|answered"}
{"id":"msg-...","ts":"...","role":"claude","text":"markdown","replyTo":"msg-...","actions":[{"kind":"edit|slice|info","label":"...","detail":"..."}]}
```

| Field | UI behaviour |
|---|---|
| `status: 'pending'` | "sent" + waiting bar + elapsed timer |
| `status: 'seen'` | "picked up" + "Claude is on it" + elapsed timer |
| `status: 'answered'` | a tick, timer stops |
| `status: 'failed'` | red outline, "not sent" badge (UI-only; not in the file format) |
| `replyTo` | a Claude message marks the message it answers as `answered` automatically |
| `selectionId` | renders a clickable chip; clicking it fires `onSelectionChip(id)` |
| `selectionLabel` | optional extra field — a human summary for the chip. Without it the chip shows the label the UI remembers for that id, or the raw id. |
| `actions[]` | buttons. `kind: 'slice'` gets the Lane B treatment (amber + hatch), `'edit'` gets Lane A, `'info'` is plain. Clicking fires `onChatAction(action, message)`. |

Endpoints (server side): `GET /api/bridge/chat?since=<id>`,
`POST /api/bridge/chat {text, selectionId}`, plus pushes over the existing
`GET /api/watch` SSE stream — prefer SSE, fall back to polling every 5 s.

### Markdown (history — removed 2026-09-16)

`renderMarkdown(text)` at the bottom of `chat.js` is ~150 lines and has no
dependencies. It supports paragraphs, `#`–`###` headings, bullet and numbered
lists (with continuation lines), blockquotes, `---` rules, GFM pipe tables,
fenced code blocks with a language label and a copy button, bold, italic,
strikethrough, inline code, and `http(s)`/relative links. Anything it does not
recognise falls through as literal text.

**It is safe by construction**: it builds DOM nodes and never assigns
`innerHTML`, so there is no escaping step to forget — markup cannot be injected
because markup is never parsed as HTML. Links with any other scheme degrade to
plain text.

One trap that already bit once: the inline scanner's regex is compiled **per
call**, not shared. `inline()` recurses into the contents of bold/italic/link
spans, and a shared `/g` regex has its `lastIndex` clobbered by the inner call,
restarting the outer scan from zero — an infinite loop on any line containing
emphasis.

Scroll stays pinned to the bottom unless the user scrolls up, at which point a
"Jump to latest" pill appears.

---

## Keyboard

Global, ignored while typing in an input or textarea. While the terminal has focus it owns every
key (Esc, Ctrl+O, Ctrl+Enter, Shift+Tab) except `F5`, which reloads the app.

| Key | Action |
|---|---|
| `1` … `7` | View mode: feature / speed / flow / fan / temp / width / height |
| `Z` / `X` / `V` / `C` | Camera: isometric / top / bottom / front |
| `F` | Frame all |
| `T` / `R` | Toggle travel / retraction moves |
| `B` | Visible select — only the moves you can see (switches straight into the mode; press again to leave) |
| `G` | Area select — everything inside the rectangle, hidden moves included (press again to leave) |
| `L` | Layer select — opens the Select panel on Layers |
| `D` | Diff on / off |
| `K` | Check before printing on / off |
| `[` | Hide / show the side bar |
| `A` | Show all layers |
| `S` | Show only the top layer |
| `↑` / `↓` | Move the top layer by one (Shift: by ten) |
| `Esc` | Leave select mode, else clear the selection, or close a dialog |
| `Ctrl`+`Enter` | Attach the selection to Claude's prompt |
| `/` | Focus Claude |
| `Ctrl`+`O` | Switch file |
| `?` | Shortcut sheet (also title bar ⋯ menu → Keyboard shortcuts) |

Everything is reachable by `Tab`, with a visible `:focus-visible` ring. The view
mode list is a `radiogroup` with roving arrow keys; the modal traps focus and
restores it on close.

---

## The mock harness

`index.html` boots `src/main.js`. If that import fails — or if the URL carries
`?mock=1` — it falls back to `mountMockHarness(ui)`, which is at the bottom of
`layout.js` behind a banner comment, below a line that nothing above it
references.

```
npx vite                              (Claude: only when the user asks)
http://localhost:5173/?mock=1
```

It feeds the real numbers from the `phonecase-17pro` job (57 layers, 92 648
moves, 49m 15s, 15.10 g, 122 ms parse, a realistic feature breakdown and layer
times including the 689 s first layer) plus a three-message conversation with a
markdown table and a code block, and wires every callback to a visible
response. **Delete the whole block and the `mountMockHarness` export when the
real loop is stable**; `createUI` does not depend on it.

---

## Verified

- Renders with no console errors under Vite dev and in a production build
  (`vite build` succeeds).
- No horizontal or vertical page overflow at 738 / 838 / 958 / 1158 / 1378 /
  1658 / 1898 px wide.
- Dark theme only (2026-09-16); last build: layout chunk 92 kB, CSS 54 kB, main 564 kB (three.js).
- Diff modal, validator checklist, shortcut sheet, selection summary, picked-move
  readout, chat markdown (tables, fenced code, emphasis, inline code) all render.

## Not done / known gaps

- The viewport shows a faint grid and a placeholder label only in mock mode; in
  the real app the renderer owns every pixel of the canvas.
- Box-select is a mode toggle only — the rubber-band rectangle itself is drawn
  by the renderer, not by the UI.

---

## Update 2026-09-16

- **Left rail scrolls** as one column (`overflow-y: auto`, `scrollbar-gutter: stable`); sections
  size to their content inside it. It used to clip, cutting off Moves and Geometry on short windows.
- **Collapsible rail sections.** A chevron before each title (the title is clickable too) folds the
  section to its header; **collapse all / expand all** sit at the top of the rail. State is stored
  per section under `localStorage['gcs.rail.collapsed.<modes|features|moves|geometry>']`.
  CSS: `.panel.is-collapsed > :not(.panel__head) { display:none }`.
- **Title-bar ⋯ menu → Add printer preview** → `ui.onAddThumbnail(cb)`; `main.js` runs dry run → confirm → write.
- **Lane A "Apply to selection" is wired.** `main.js` turns `changes[]` into server ops on the
  selection's `lineRanges`: speed → `scaleSpeed`, flow → `scaleFlow` (±20 % cap), fan (pp on top of
  the region's average) → `setFan`, nozzle (°C on top of the region's temp) → `setTemp`. The
  filename note is generated (`speedminus20-l34-41`), not the free-text Claude note.
- Lane B rail items now type a re-slice request into Claude's prompt, with the selection attached.
- Selection summaries now carry `{count, lengthMm, timeSec}` per feature, so the breakdown shows
  real length and time instead of dashes.
- Cosmetic, known: the scrollbar gutter trims the longest feature names (`Sparse in…`).

## Update 2026-09-16 (later) — Claude in the app

- (superseded) The lower right pane was **Claude | Mailbox** tabs; the Mailbox tab is gone, the pane is only Claude.
- **Wide** button (pane header, right): Claude Code wants ~80 columns and the 348 px panel gives it
  ~44. It borrows width (52 % of the window, max 860 px) until toggled off. The panel's drag
  limit went from 680 px to `window width − 420`.
- (superseded) The terminal stayed dark in the light theme; the app is dark only now.
- Inspector: the note textarea is gone — the message is written in Claude's prompt, where the
  conversation is. **Attach selection to Claude** and the picked move's **attach to Claude** link
  save the data (and a picture of the view) through `POST /api/bridge/attach` and type a one-line
  reference into the prompt. Nothing is sent until you press Enter.
- Hovering previews a move; leaving the model shows the **clicked** move again, so "attach move"
  attaches what was clicked.
- Lane B rail items type a re-slice request into Claude's prompt (the mailbox fallback is gone).
- **Area select** (`G`, in the Select panel). See CONTEXT-render.md for the renderer
  side and CONTEXT-terminal.md for how it reaches Claude.

## Update 2026-09-16 (latest) — mailbox removed

The Mailbox tab, `src/ui/chat.js` and its ~280 lines of CSS are gone. The lower right pane is only
Claude. Removed from the public API: `setChatHistory`, `appendChat`, `onChatSend`, `onChatAction`,
`setChatState`, `focusChat` (now `focusClaude`), `onSelectionChip`. The left rail's Geometry items
type a re-slice request into Claude's prompt; if Claude is not running they say so instead of
falling back to the mailbox. Sections above that describe the chat panel are history.

## Update 2026-09-16 (latest) — diff bar, drafts, Claude's boxes

- Title bar: **Finalize** (only on `…_vN-draft.gcode`), **Diff** (`D`). Diff card top-left
  (`src/ui/compare.js` `createCompareBar`): "DIFF VS <base>" (click = pick another) + ✕, Changes /
  Overlay under it, "comparing…" while busy. Totals are in the legend. `placeTopLeft()` moves the
  card below the view tools when both do not fit on one row. File picker: `ui.pickFile({title, items})`.
- Under it, the pointer key (`createPointerList`): "Claude is pointing at", numbered coloured rows,
  zoom-to, ✕. API: `showPointers(list|null)`, `onPointersClear`, `onPointersFrame`.
- `ui.toast(message, kind, {ttl, action})` — used for the "New file … Open + diff" pop-up.

## Check button (2026-09-18)

The title bar has **Check** next to Diff (`K`): it runs `checkPrint` + `checkScrewSeats` (`src/printcheck.js`) on the
open file in the browser -- no server call -- and draws the findings with the same boxes and labels as
`server/print-check-cli.js <file> --show` (nearby findings of one kind merged, HIGH first, at most 12 boxes).
A toast gives `N HIGH, M MEDIUM` and any thin screw seat. Pressing it again (or Deselect / clearing the pointers)
removes the boxes. Code: `runCheck` / `checkBoxes` in `src/main.js`, button in `src/ui/layout.js`.
Backup before this change: `backup6-09-18-before-check-button\`.
