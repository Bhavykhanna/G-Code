# Another printer, another slicer

Last updated: 2026-09-19. Part of the context set — **index: [`README.md`](README.md), read that first**.
What in this app follows the file it is given, what follows *this* machine's profile, and what refuses
outright. Written after a clone of the repo was measured against foreign G-code; the numbers below are from
that run, not from reading the code.

The app was built for one printer and says so ([`printer.md`](printer.md)). The question this file answers is
the narrower one: **how much of it is actually nailed to that machine, and what would it take to move it.**

## The short answer

| Part | Locked to the machine? | What decides it |
|---|---|---|
| **Viewer** — parse, bed, render, select, diff | **no** | the file's own `CONFIG_BLOCK` |
| **Annotations** the viewer reads | **soft** — needs this profile's custom G-code and Orca's vocabulary | `layer_change_gcode`, `;TYPE:` names |
| **Editor** — any write at all | **no**, since 2026-09-19 | the ending of the file being edited, not a constant |
| **Re-slice (Lane B)** | **hard** | the ElegooSlicer binary and profile names |
| **Printer-screen preview** | **hard**, but harmless elsewhere | the ColPic format Elegoo/Chitu screens read |

So: the viewer travels, the editor now travels with it, and the re-slicer is Elegoo's.

## 1. What already follows the file

Nothing here needs touching for another machine.

| Thing | Where it comes from |
|---|---|
| Bed outline, grid, origin | `meta.bedShape` ← `bed_shape` in the footer (`src/render/bed.js`) |
| Envelope check (X, Y, Z) | `bed_shape` + `printable_height` (`validate.js:limitsFor`) |
| Nozzle temperature range | `nozzle_temperature_range_low` / `_high` |
| Max feedrate | `machine_max_speed_x` |
| Volumetric limit | `filament_max_volumetric_speed` |
| File naming | the printer token in a name is `[A-Za-z0-9]+` and is carried over, not checked. `EN4Max` is only the fallback when a field is missing (`version.js`) |

The 426 × 426 × 480 numbers in the code are **defaults for a file that carries no config**, not rules. A file
from another machine that has a `CONFIG_BLOCK` overrides every one of them.

## 2. What needs the annotations this profile emits

These come from the machine profile's custom G-code, not from the firmware, so another printer running the
same slicer with the same custom G-code is fine — and the same printer with a stock profile is not.

| Needed | Emitted by | Without it |
|---|---|---|
| `;LAYER:n` | `layer_change_gcode` in `machine.json` | **0 layers**: no layer bar, no layer-range select, no per-layer diff, no per-layer time |
| `;TYPE:<name>` in Orca/Bambu wording (`Outer wall`, `Sparse infill`, …) | the slicer | every move lands in `Unknown`: no feature colours, no per-feature stats, most of the print check silent |
| `;WIDTH:` / `;HEIGHT:` | the slicer | extrusion width and layer height read 0 |
| `; CONFIG_BLOCK_START … END` | the slicer footer | no settings at all: no bed shape, no A/B settings diff, envelope falls back to the defaults |
| `; estimated printing time`, `; filament used [mm]` | the slicer footer | per-move times are the parser's own model, unanchored |

Measured on two synthetic files, both parsed with no crash and no data loss — they simply come out thin:

| File | Moves | Layers (`layers[]`) | Features | Config keys |
|---|---|---|---|---|
| This profile's own output (the demo job) | 92,664 | 58 (57 + the trailing marker) | all named | 624 |
| PrusaSlicer-style, Marlin, `;LAYER_CHANGE` | 6 | **0** | all `Unknown` | **0** (its footer is `; prusaslicer_config`, not `CONFIG_BLOCK`) |
| Cura-style, Marlin, `;LAYER:` | 5 | 2 | all `Unknown` (`WALL-OUTER`, `FILL`) | 0 |

**The cheap fixes, if the viewer should travel** (`src/parser/parse.js`, one place each):

1. accept `;LAYER_CHANGE` + `;Z:` as a layer boundary alongside `;LAYER:n`;
2. an alias table for feature names (`WALL-OUTER` / `External perimeter` → `Outer wall`, …);
3. read the `; prusaslicer_config = begin … end` footer as a second form of `CONFIG_BLOCK`;
4. fall back to "Z increased on an extruding move" for layers when there is no marker at all.

None of them touch the shared contract; all of them are additive.

## 3. What refuses outright

This was the real lock. **Fixed 2026-09-19** (public B15), with the user's yes, because it sat in the
safety gate rather than anywhere that looked printer-specific.

**It used to be:** `validate.js` required the file to end with *this* machine's five markers —
`;PRINT_END`, `M104 S0`, `M140 S0`, `M84`, `; EXECUTABLE_BLOCK_END`. `;PRINT_END` comes from
`machine_end_gcode` in this `machine.json` and `; EXECUTABLE_BLOCK_END` is Orca-family, so a foreign file
could be opened, measured, diffed and checked — and **not written to at all**.

**It is now:** an edit is held against *the ending the source file actually had*. Every shutdown marker
present in the original's executable tail must still be present after the edit. For this printer that is
the same five markers, enforced exactly as hard as before; for another printer it is that printer's own
ending, with nothing to configure. A file validated on its own (a fresh slice, say) has no source to
compare with, so it only has to shut the machine down at all: heaters off and steppers off, in any of the
dialects below — missing either is an error, and a missing bed-off is a warning.

| Group | Recognised as |
|---|---|
| marker | `;PRINT_END` · `; EXECUTABLE_BLOCK_END` · `;End of Gcode` |
| hotend | `M104 S0` · `M109 S0` · `TURN_OFF_HEATERS` |
| bed | `M140 S0` · `M190 S0` |
| steppers | `M84` · `M18` |

The list only *recognises* markers. Which ones a given file must keep is decided by the file, never by
the list — that is what makes another printer's ending exactly as binding as this one's.

> **A hole closed on the way.** The check searched the last 200 KB of the file, which includes the
> CONFIG_BLOCK — and the CONFIG_BLOCK quotes `machine_end_gcode` verbatim. A file whose real end sequence
> had been deleted still passed, because every marker was sitting in its own settings dump. Measured on
> the demo file: `;PRINT_END` appears twice, at 2,976,313 (the real ending) and 2,986,237 (inside the
> config). Everything from `; CONFIG_BLOCK_START` on is now cut before looking.

Two more refusals, both deliberate and both worth keeping:

- **`M83` relative extrusion is required for any E edit.** In an absolute-E file one E change invalidates
  every later E. Cura and PrusaSlicer default to absolute E, so their files are read-only here — correctly.
- **Flow is capped at ±20 %**, three times over. Nothing about that is machine-specific.

## 4. The re-slice lane

`server/api/slice.js` runs ElegooSlicer:

```
elegoo-slicer.exe --load-settings "<machine.json>;<process.json>" --load-filaments "<filament.json>"
                  --slice 0 --outputdir "<dir>" "<model.stl>"
```

- The binary path is `GCS_SLICER` or `C:\Program Files\ElegooSlicer\elegoo-slicer.exe`.
- OrcaSlicer and BambuStudio take the same arguments (ElegooSlicer is an Orca fork), so pointing `GCS_SLICER`
  at one of those is plausible — **untested here**. PrusaSlicer and CuraEngine take different arguments and
  would need their own invocation.
- Exit **-17** means the profile names do not match the printer: the machine profile has to be named exactly
  what the slicer calls that machine, and the process and filament profiles need it in `compatible_printers`.
  For another printer that is a new set of three complete JSONs (no `inherits` — the CLI does not resolve a
  parent), same shape as [`..\profiles\README.md`](../profiles/README.md) describes.

## 5. The printer-screen preview

`;gimage:` / `;simage:` ColPic blocks are what Elegoo and other Chitu-screen printers read. On any other
screen they are inert comments — harmless, just useless. The third block the injector writes, the base64 PNG
`; thumbnail begin`, **is** the PrusaSlicer/Orca standard and is what most other firmwares use.

## 6. Where the jobs live

Not printer-specific, but it bites every clone: the sandbox root is normally the folder **above** the app,
because the app is meant to sit in `<archive>\gcode-studio\`. A clone somewhere else would make that the
drive root. So it can be pointed elsewhere — `GCS_ARCHIVE`, or a git-ignored `.gcs-archive` file next to the
app holding one line (`demo`, to work against the shipped job). Details in
[`..\docs\CONTEXT-server.md`](../docs/CONTEXT-server.md).

## 7. A bug this measurement found — fixed

`limitsFor` built the feedrate limit with `String(config.machine_max_speed_x || '').split(',')`, which
yields `['']`; `Number('')` is `0` and passes `Number.isFinite`, so a file **without** that key got a maximum
feedrate of **0 mm/min** and every move in it tripped `BAD_FEEDRATE`. It never fired on this machine's files
(the key is always there). Fixed 2026-09-19 — only real numbers above zero count, and with none left the
default stands. Public B14.

## 8. Where this leaves it

After 2026-09-19, for a file from another printer or slicer:

| | Then | Now |
|---|---|---|
| Open, measure, render, diff, print-check | worked | works |
| Layers and feature colours | need this profile's annotations | unchanged — §2 is still open work |
| Feedrate validation | **broke on every move** | correct |
| Writing an edit | **refused outright** | allowed, held against the file's own ending |
| Re-slice | ElegooSlicer only | unchanged — §4 |

So the remaining distance between "reads any printer's G-code" and "works with any printer" is §2 (the
annotation dialects) and §4 (the slicer command line). Neither is a safety rule; both are additive.
