# Parser context

Owns `src/parser/`. Part of [G-code Studio](../CONTEXT.md).

Turns an ElegooSlicer/OrcaSlicer G-code file into typed arrays the GPU and the editor can both
use. Pure ESM, zero dependencies, identical in the browser worker, in Node and in the tests.

## Status: done and verified

Measured on `..\..\phonecase-17pro\old\EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v1-ironed_49m.gcode`:

| | |
|---|---|
| File | 2.9 MB, 124,723 lines |
| Moves parsed | 92,648 |
| Parse time | **122 ms** |
| Deposited filament, ours vs slicer | 5022.23 mm vs 5022.23 mm — **0.0001 % error** |
| Config keys recovered | 624 |

Run the check yourself: `node test/check-real-file.js [file.gcode]`

## Why this dialect is easy to read

The slicer annotates far more than the bare machine commands, and the parser reads all of it
rather than inferring:

| Annotation | Count in the 17 Pro file | Used for |
|---|---|---|
| `;TYPE:<name>` | 1,182 | feature type per move — drives colour, filtering, selection |
| `;WIDTH:<mm>` | 21,096 | **true extrusion width**, so ribbons are drawn at real width |
| `;HEIGHT:<mm>` | 89 | layer height per move |
| `;LAYER:<n>` / `;Z:<mm>` | 58 / 57 | layer boundaries and heights |
| `; CONFIG_BLOCK` | 624 keys | the complete settings that produced the file |

Two properties of the output make everything downstream possible:

- **`M83` relative extrusion.** Each `E` is a delta, so changing one move's extrusion does not
  invalidate every later `E`. In an absolute-`E` file a single edit means rewriting the rest of
  the file. The parser reports `relativeE`, and **editing is disabled outright when it is false**.
- **Every segment carries its source line number** (`segments.line`). That is the link between
  a thing you clicked in 3D and the bytes to change on disk.

## Output shape

Documented once, in [the shared contract](../CONTEXT.md#parse-result-from-srcparserparsejs).
Struct-of-arrays, so the result transfers to a worker and uploads to the GPU without copying.

## Move classification (`segments.kind`)

| Kind | Test | Note |
|---|---|---|
| `EXTRUDE 0` | moves and `E > 0` | the only kind that counts as deposited material |
| `TRAVEL 1` | moves and `E <= 0` | may still carry a negative `E` — retract-while-travelling |
| `RETRACT 2` | no motion, `E < 0` | 1,681 of them in the 17 Pro file |
| `PRIME 3` | no motion, `E > 0` | the matching re-prime |

**The gotcha that already caught me once:** the slicer's `filament used [mm]` is the sum of `E`
over `EXTRUDE` moves *alone*. Do not subtract retractions — they are cancelled by their primes.
Subtracting them gives a 15 % error that looks like a parser bug and is not one.

## Timing model

Per-move time is a trapezoidal estimate: accelerate to the feedrate, cruise, decelerate, using
the live acceleration from Klipper's `SET_VELOCITY_LIMIT ACCEL=` (this printer) or `M204 S`.

It assumes every move starts and ends at rest, which over-estimates short moves — on the 17 Pro
file the raw total is **1.26× the slicer's own figure** (`timeScale` 0.796). The slicer's total
is authoritative, so the parser scales every move by that ratio. The result: totals are exact,
and the *distribution* across layers and features is a good approximation but not gospel.

Treat per-layer times as "which layers are slow", not as a promise.

## Known limitations

- ~~**Arc moves (`G2`/`G3`) are skipped**~~ — **drawn since 2026-09-16**: I/J or R form, helical Z,
  split into chords within `ARC_TOLERANCE` (0.02 mm) of the circle, last chord exactly on the
  commanded end, E and time shared out. Every chord keeps the arc's source line, so edits must
  touch each line once (`scaleFlow` dedupes; `nextSeg` skips same-line chords). An arc with no
  usable centre is drawn straight and warned about. `test/check-arcs.js`. (Historical: the 17 Pro file has 3 arcs, all in
  start/end G-code; before 2026-09-16 they were skipped with a warning. Now only an arc with no
  usable centre produces a warning.)
- Layer 0 in these files is a **start-G-code stub**, not a real layer; there are 58 `;LAYER:` tags
  for 57 layers. Consumers should present layers the way the slicer numbers them.
- Multi-extruder / tool changes are not modelled. Single-extruder only, which is what this
  printer is.
- An unrecognised `;TYPE:` name falls back to `Unknown` and is reported in `warnings` rather
  than throwing.

## Files

| File | Role |
|---|---|
| `parse.js` | the parser and its helpers (`FEATURE_NAMES`, `KIND`, `ARC_TOLERANCE`, `arcGeometry`, `parseDuration`, `formatDuration`, `flowRate`, `segLength`) |
| `gcode-worker.js` | runs the parse off the main thread, transfers the arrays back |
| `../../test/check-real-file.js` | cross-checks a real file against its own footer |
| `../../test/check-arcs.js` | arc chords, tolerance and edit handling |
