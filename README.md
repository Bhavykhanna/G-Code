<div align="center">

# G-code Studio

### See the print. Select the part that is wrong. Fix it, version it, check it.

A 3D G-code viewer, region editor and re-slice loop — with **Claude Code running inside the window**,
so you can point at a corner of a print and talk about *that*.

![Node](https://img.shields.io/badge/Node-22%2B-5b7cfa?style=flat-square)
![Platform](https://img.shields.io/badge/Windows-desktop_app-5b7cfa?style=flat-square)
![Renderer](https://img.shields.io/badge/three.js-WebGL2-5b7cfa?style=flat-square)
![Dependencies](https://img.shields.io/badge/runtime_deps-5-4caf50?style=flat-square)
![Status](https://img.shields.io/badge/status-in_daily_use-4caf50?style=flat-square)

<sub>Built for an Elegoo Neptune 4 Max — and built to be pointed somewhere else.
See **[Making it yours](#-making-it-yours).**</sub>

</div>

---

> **The idea in one line.** Your slicer's preview shows you the print. This one lets you *reach into
> it* — select a region, see exactly which moves and which lines of the file it is, change them
> safely, and keep every version of the result.

<table>
<tr>
<td width="25%" valign="top">

**🎯 Point at it**

Drag a box. Get the exact moves and source lines — not "the top-left bit".

</td>
<td width="25%" valign="top">

**✏️ Change it**

Speed, flow, fan, temp, pauses. Diff first, validate, confirm, then write.

</td>
<td width="25%" valign="top">

**🗂 Keep it**

Drafts, steps, finals, archive. Nothing overwritten. Nothing deleted. Ever.

</td>
<td width="25%" valign="top">

**🔍 Trust it**

Diff two versions, and a pre-print check calibrated on prints that failed.

</td>
</tr>
</table>

---

## Contents

[Why it exists](#-why-it-exists) · [The one honest limit](#-the-one-honest-limit) ·
[What's in it](#-whats-in-it) · [Nothing gets lost](#-nothing-gets-lost) ·
[Claude in the window](#-claude-in-the-window) · [Making it yours](#-making-it-yours) ·
[Getting started](#-getting-started) · [Finding your way around](#-finding-your-way-around) ·
[Where it stands](#-where-it-stands)

---

## 🧭 Why it exists

Your slicer already previews G-code in 3D, and does it well. **This is not a replacement for that.**
It exists for four things a slicer preview cannot do:

| | |
|---|---|
| **Hand a region to an assistant** | Box-select a corner and Claude gets the exact move indices and source line numbers — it can reason about *that region*, not a description of it |
| **Edit a region directly** | With a line-by-line diff, a safety validator and automatic versioning into a naming convention |
| **Answer "where did the time go?"** | Version A/B diff by layer, by feature, and by setting |
| **Put the preview tile back** | Slicing from the command line produces no preview image, so the printer's screen shows a blank square |

## ⚖️ The one honest limit

G-code is your slicer's **output**: a list of paths the nozzle takes. It is not a model. So there are
two kinds of change, and the app always shows you which one you are in.

<table>
<tr>
<th width="50%">🟦 Lane A — edit the file, instantly</th>
<th width="50%">🟧 Lane B — back through the slicer, ~2 s</th>
</tr>
<tr>
<td valign="top">

- speed, acceleration
- fan, nozzle temperature
- flow, **hard-capped at ±20 %**
- Z offset, pauses / filament change
- delete a region (strip a brim, say)

</td>
<td valign="top">

- wall count, line width
- infill density, layer height
- brim, skirt, supports, ironing
- anything with a shape to it

</td>
</tr>
</table>

A full re-slice of the reference model takes **1.4–2.3 seconds** and is byte-identical for identical
settings — so going back to the slicer is cheap, and it is always the right answer rather than a last
resort. And some requests have no answer in either lane: if the shape itself is wrong, that is a CAD
change, and the app says so instead of pretending.

## 🧩 What's in it

Everything below is in the window today, not planned.

<details open>
<summary><b>👁 Seeing the print</b></summary>

- Full 3D of every move as real extrusion ribbons — **872k triangles in 3 draw calls**, so scrubbing
  never stutters.
- Colour by **feature type · speed · volumetric flow · fan · nozzle temp · line width · layer
  height** (keys `1`–`7`), each with its own legend and units.
- Show, hide or solo any feature; toggle travels and retractions.
- A two-handled layer bar: drag a range, arrow-key it, "top layer only", or scrub with the wheel.
- Camera presets for isometric, top, front and **bottom** — orbit under the bed and the plate fades,
  the grid dims and the underside is lit.
- Hover or click any move for its feature, speed, width, height, fan, temperature, extrusion — and
  **the line it came from in the file**.

</details>

<details open>
<summary><b>🎯 Selecting a region</b></summary>

- Three ways: drag a rectangle over the model, take everything currently visible, or pick a layer
  range.
- The panel totals what you grabbed — moves, layers, Z range, per-feature count, length and time,
  filament used, and min/max/average speed, width, fan and flow.
- Underneath, a selection is a set of **source line ranges**. That is what makes both editing and
  handing it to Claude exact instead of approximate.

</details>

<details open>
<summary><b>✏️ Changing it</b></summary>

- Set or scale **speed** · scale **flow** (±20 % cap) · set or scale **fan** · set **nozzle
  temperature** · set **acceleration** · apply a **Z offset** · **insert a pause** or filament change ·
  **delete the region**.
- Every edit is a **dry run first**: line-by-line diff, counts of changed / inserted / removed lines,
  predicted new print time, full validation report. Confirm stays disabled while any error stands.
- Fan, temperature and acceleration are *machine state*, so they apply across the span of a selection.
  The app reports its **coverage** rather than quietly doing more than you asked.
- Geometric settings are listed too — wall count, line width, infill, layer height, brim, supports,
  ironing — but clicking one writes a **re-slice request** into Claude's prompt instead of faking a
  G-code edit.

</details>

<details open>
<summary><b>🗂 Versioning — a filing system, not just an editor</b></summary>

- Editing a finished version creates **the next version as a draft** beside it. The finished file
  stays exactly where it is, still the one you print.
- Editing that draft again first saves its previous state as a numbered **step** in an archive folder,
  so every intermediate is recoverable.
- **Finalize** gives the draft its real name — printer, nozzle, model, filament, layer height, version,
  what changed, print time — centres the part on the bed, and moves the older version into the archive.
- **Nothing is ever overwritten and nothing is ever deleted.** A write that would clobber something
  fails loudly. The new file is written *before* the old one is moved aside, so a crash leaves two
  files rather than none.
- The app remembers which file a draft came from, so the diff always has the right base — even after
  a finalize has moved that base into the archive.

</details>

<details open>
<summary><b>🔍 Comparing two versions</b></summary>

- **Diff** lays this version over another: green is new, red is gone, grey is unchanged — with sliders
  to fade each file and a switch to hide everything that did not change.
- It compares plastic per layer and matches walls by direction, so a hole that *moved* shows as moved
  instead of quietly matching itself.
- Per-layer and per-feature time and filament — the answer to "where did the five minutes go between
  v3 and v4" — plus a settings diff between the two files' own configuration blocks.
- Versions centred at different times are lined up automatically before comparing.

</details>

<details open>
<summary><b>🛟 Checking before you print</b></summary>

One button draws the risky spots straight onto the model:

| Finding | Why it matters |
|---|---|
| Tiny islands | they soak up heat and blob |
| Travels skimming fresh plastic | the nozzle drags through what you just laid down |
| Long unlifted travels over visible surfaces | scars on the faces you will actually look at |
| Fast spans, or a fan that only bursts | overhangs and bridges that never get to cool |
| Nozzle below plastic printed earlier | a collision, not a scuff |
| Lines printed twice | double extrusion in the same place |
| Thin screw seats | the head pulls through |

Every rule is calibrated against prints that actually failed — the check was written after a part came
out of the printer with melted, blackened opening tops.

</details>

<details open>
<summary><b>🖼 Printer-screen previews</b></summary>

Slicing from the command line leaves the printer's file list showing a blank tile. The app renders the
preview itself and embeds it — in the format the screen reads, plus the standard image other firmwares
use — and refuses to mint a pointless new version when a file already has one.

</details>

<details open>
<summary><b>🤖 Working with Claude</b></summary>

- Attach a selection, an area or a single move — with a screenshot of the view — and a one-line
  reference is typed into the prompt for you.
- From its side, Claude can open a file in the window, turn the diff on, **draw labelled coloured
  boxes on the model to show what it means before changing anything**, reload the window, run the
  print check and finalize a draft — all through the same validated paths you use.

</details>

## 🔒 Nothing gets lost

The versioning above is one half of it. The other half is the gate every write goes through — rules
the app enforces rather than suggests:

- A finished version is **never** modified in place, and nothing is ever deleted; a write that would
  clobber a file fails loudly instead.
- Every write is re-read **from the bytes that would land on disk** and validated: no move outside the
  bed, no impossible temperature, no unbalanced retraction, no Z going backwards mid-layer, no
  dangling feature block.
- Every edit shows its diff and waits for you. If validation finds a problem, confirm stays off —
  there is no override flag, by design.
- Flow changes are capped at ±20 %, enforced in three independent places.

> This drives real hardware. That is the whole reason for the tone of that list.

## 🤖 Claude in the window

The panel under the inspector is a real Claude Code session, started with the app and working in your
print folder — not a chat box with an API key behind it. It has its own tools and the project's own
notes, so it can read the G-code, edit it through the same validated path you would, re-slice, run the
print check, and open the result in the window with the diff already on. You write your message after
the attached reference and press Enter; nothing happens until you do.

**Nothing leaves your machine.** The server listens on localhost only, every request carries a token
regenerated on each start, and there is no outbound call anywhere in it.

## 🔧 Making it yours

The app is more portable than it looks, and less portable than you might hope. Here is the honest map.

| | What | What it takes |
|---|---|---|
| ✅ | **Bed shape, printable envelope, temperature range, max feedrate, volumetric limit** | Nothing. All read from the settings block your slicer writes into the file — a different bed simply draws itself. The naming convention keeps whatever printer name your files already use |
| 🟡 | **Layer and feature detection** | A small, additive change. The app reads the comments a slicer leaves in the file and currently speaks one dialect of them (OrcaSlicer / Elegoo). A PrusaSlicer or Cura file still parses every move correctly, but shows no layers and no feature colours. Teaching it the other dialects is an alias table plus two extra markers, in one dependency-free file |
| 🟠 | **Writing to a file from another printer** | A decision, not just code. The validator refuses to save anything that does not end with the exact shutdown sequence this machine's profile produces — that check is what stops a half-valid file reaching a hot nozzle. Making it read the expected ending from *your* profile is a change to a safety rule, and should be a conscious one |
| 🟠 | **The re-slice loop** | Your slicer. It calls the ElegooSlicer command line, an OrcaSlicer fork; point it at an Orca or Bambu build and the arguments are the same. PrusaSlicer or CuraEngine would need their own invocation |
| 🟡 | **The printer-screen preview** | Nothing, but it only *helps* on Elegoo and other Chitu-screen machines. Elsewhere it is an inert comment — and the standard preview image the app also writes is the one most other firmwares read |
| ✅ | **Where your prints live** | One small file next to the app points it anywhere. A clone with no print archive at all points it at the bundled demo job and works immediately |

The full map — what was measured, what each change would cost, and which one is a safety decision —
is in [`context/other-printers.md`](context/other-printers.md).

## 🚀 Getting started

You need **Node.js** and a Chromium browser. Then:

1. Clone the repo.
2. Double-click **`run-gcode-studio.bat`** — the first run installs dependencies, builds the app,
   starts the local server and opens the window.
3. **`stop-gcode-studio.bat`** closes the window and the server again.

Closing the window with the X leaves the server up on purpose, because Claude is running inside it.
Double-click the launcher again and you get the window back instantly, conversation and all;
`run-gcode-studio.bat --force` is the clean restart.

A finished job ships in **`demo/`**: a real printed part, its previous version so the diff has
something to compare, the model, and the three slicer profiles. Enough to open, inspect, diff, check
and re-slice something real before you point the app at your own prints.

## 📚 Finding your way around

| If you want | Read |
|---|---|
| What the app is, part by part | [`CONTEXT.md`](CONTEXT.md) — the index, one file per part under [`docs/`](docs) |
| How it behaves on another printer | [`context/other-printers.md`](context/other-printers.md) |
| The printing knowledge behind the defaults | [`profiles/README.md`](profiles/README.md), [`context/profiles.md`](context/profiles.md) |
| What has actually been measured | [`context/findings.md`](context/findings.md) |
| Known defects, and the ones already fixed | [`BUGS.md`](BUGS.md) |

The [`context/`](context) folder is the public half of the project's notes, written without job or
customer names; anything with a name on it stays on the machine it came from.
[`context/README.md`](context/README.md) describes that split.

## 📈 Where it stands

In daily use for real prints.

| Measured | On |
|---|---|
| Deposited filament matches the slicer's own footer to **0.0001 %** | a 92,648-move file, parsed in **122 ms** |
| A selection round-trips to source lines and back **exactly** | 1,916 moves → line ranges → 1,916 moves |
| **872k triangles in 3 draw calls**, layer scrub 0.4 ms per 5,000 calls | the renderer |
| A re-slice is **1.4–2.3 s** and byte-identical for identical inputs | the reference model |

Both test suites run on a bare clone, against the demo job: `npm run check` is 28/28 plus every
real-file check, and the server suite is **402 checks, 0 failed**. Nothing in them is pinned to a file
you do not have.

**Honest gaps.** The printer-screen preview matches the slicer's own output byte for byte but has not
yet been *seen* on a printer screen; everything marked 🟠 above is a decision waiting to be made, not a
thing quietly half-done. [`BUGS.md`](BUGS.md) keeps the current list, and nothing in it is hidden from
you — including the three defects that this repo's own first clone exposed, and what each of them cost.
