# iPhone 17 Pro hexagon cover

> **Demo copy.** These files ship with G-code Studio as a worked example. Links below to sibling
> job folders (the 16 Pro case) point at the print archive on the original machine and are not in
> this repo; everything needed to open, diff, check and re-slice the 17 Pro job is here.

**Print this:** `EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v2-thumbnail_49m.gcode`
(same print as v1, plus a preview image for the printer screen)
49m 15s · 15.10g · 57 layers · Elegoo Neptune 4 Max 0.4 nozzle · HS PLA+

Sliced 2026-09-16 with the same profile as the 16 Pro case (`..\phonecase-16pro\`), unchanged.
The `.json` files here are the exact profiles used, so it can be re-sliced identically.

## The model

74.85 x 153.01 x 11.55mm · 10.4 cm3 · 105,762 facets · **manifold, 1 part, no open edges**

Cleaner mesh than the 16 Pro, which had 2 parts and 10 open edges the slicer had to repair.
Lies on its back already. **No supports needed** - measured 0 mm2 of true horizontal overhang
(the 80-91 degree band); the steepest downward faces are 35-50 degrees, which prints fine unsupported.

Two things checked before slicing, both fine:
- The STL has `min_z = -1.4`, i.e. it sits below the origin plane. The slicer dropped it to the bed
  correctly - the output reports `max_z_height: 11.55`, the full model height, so nothing was clipped.
- Its X coordinates are negative in the file. The slicer centered it: the G-code footprint is
  X 168-263, Y 0.5-297, well inside the 426 x 426 bed.

## Settings

Identical to the 16 Pro - see `..\phonecase-16pro\README.md` for the full reasoning behind each one.

| | |
|---|---|
| Layer height | 0.20mm (first layer 0.28mm) |
| Walls / shells | 3 Arachne @ 0.5mm · 3 top / 3 bottom |
| Infill | gyroid 25% |
| Nozzle / bed | 225C / 60C |
| Adhesion | brim outer_only 6mm (0.1 gap) + 2 skirt loops |
| First layer | 15mm/s, infill 25, accel 300 |
| Speed ramp | `slow_down_layers = 3` |
| Walls | outer 100 · inner 180 mm/s |
| Top layers | `slow_down_layer_time = 15` |
| Ironing | `top`, monotonic, 0.25mm spacing, 60mm/s, 10% flow, 0.2 inset |
| Fan | off layers 1-11 · 15% cruise · 35% max · 45% overhangs |
| Supports | none |

## Verified in the output

- **Layer 7 is the last layer of the flat base** and the only layer with a `Top surface` (1446mm),
  so that is what gets ironed (13,625mm of ironing). From layer 8 on it is side walls only.
  One layer earlier than the 16 Pro, because this base is 1.0mm thick rather than 1.5mm.
- **Slow base:** layer 1 = 8m 6s at 50mm/s max, then 70 / 125 / 180mm/s over layers 2-4.
- **Top clamped:** layers 8-56 all land at ~15.0s each.
- **Fan peaks at 15% for the entire print.** Unlike the 16 Pro there are no 45% overhang spikes at all,
  because this model has no true overhangs for `overhang_fan_speed` to trigger on.

## Version history

| Version | File | Time | What changed |
|---|---|---|---|
| v1 | `old\EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v1-ironed_49m.gcode` | 49m 15s | first cut, using the 16 Pro's finished v4 profile unchanged |
| **v2** | `EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v2-thumbnail_49m.gcode` | **49m 15s** | + **printer-screen preview** embedded (2026-09-16, G-Code Studio). Toolpath byte-identical to v1. **<- print this** |

Naming: `EN4Max_0.4_<model>_<filament>_<layer height>_v<n>-<what changed>_<time>.gcode`.
The `.stl` keeps its original download name so it stays traceable to the source.

## Compared to the 16 Pro

| | 16 Pro | 17 Pro |
|---|---|---|
| Size | 74.5 x 153.5 x 10.7mm | 74.85 x 153.01 x 11.55mm |
| Volume | 12.2 cm3 | 10.4 cm3 |
| Mesh | 2 parts, 10 open edges | manifold, 1 part |
| Layers | 53 | 57 |
| Base top / ironed layer | 8 | 7 |
| Ironing | 18,107mm | 13,625mm |
| Peak fan | 45% (overhangs) | 15% |
| **Time / filament** | **57m 13s · 16.72g** | **49m 15s · 15.10g** |

## Moved from the Archive context (2026-09-17)

**`EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v2-thumbnail_49m.gcode`** - **49m 15s**, 15.10g, 57 layers.
Sliced 2026-09-16 with the **same profile as the 16 Pro, unchanged** (that slice is `v1-ironed`, now in `old\`);
v2 adds the printer-screen preview and is otherwise byte-identical. See `phonecase-17pro\README.md`.

Model: 74.85 x 153.01 x 11.55mm, 10.4 cm3, **manifold, 1 part, no open edges** - a cleaner mesh than the
16 Pro. Lies on its back. **No supports:** 0 mm2 of true horizontal overhang (80-91 degree band); the
steepest downward faces are 35-50 degrees.

Two mesh quirks checked before slicing, both handled by the slicer:
- `min_z = -1.4` (model sits below the origin plane) - dropped to the bed correctly, output reports
  `max_z_height: 11.55`, the full height, so nothing was clipped
- negative X coordinates in the STL - centered to X 168-263, Y 0.5-297, well inside the 426 x 426 bed

Differences from the 16 Pro, all consequences of the geometry rather than settings:

| | 16 Pro | 17 Pro |
|---|---|---|
| Layers | 53 | 57 |
| Base top surface (the ironed layer) | layer 8 | **layer 7** (base is 1.0mm thick, not 1.5mm) |
| Ironing | 18,107mm | 13,625mm |
| Peak fan | 45% on overhangs | **15% - no overhangs at all to trigger it** |
| Time / filament | 57m 13s / 16.72g | **49m 15s / 15.10g** |
