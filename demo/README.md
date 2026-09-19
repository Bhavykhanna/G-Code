# Demo job — iPhone 17 Pro hexagon cover

A real, finished print job, shipped with the app so anyone who clones it has something to open.
Nothing here needs the printer: load a file and the viewer, selection, print check and diff all work.

| File | What |
|---|---|
| `phonecase-17pro\EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v2-thumbnail_49m.gcode` | the current version — 57 layers, 49 min, and it carries a printer-screen preview image |
| `phonecase-17pro\old\…_v1-ironed_49m.gcode` | the version before it, so **Diff** (`D`) has something to compare against |
| `phonecase-17pro\iphone17pro_hexagoncover.stl` | the model it was sliced from |
| `phonecase-17pro\machine.json` `process.json` `filament.json` | the exact profiles that produced the G-code — a re-slice reproduces it byte for byte |
| `phonecase-17pro\README.md` | the job's own notes: settings, what changed per version, what was learned |

## Try this

1. Open the `v2-thumbnail` file from the title bar.
2. **Diff** (`D`) → it lines up against `old\…_v1-ironed…`: green is new, red is gone, grey unchanged.
3. **Check** (`K`) → the print check draws what it finds on the model (this file is clean: **0 HIGH**,
   1 MEDIUM — three unlifted travels across fresh top surface).
4. **Select** → *Area* (`G`), drag over the top surface, and the panel shows that region's moves,
   plastic and time per feature.

These are **copies**. The job they came from lives outside this repo, next to the printer's other
jobs; the version rules that made them are in [`..\context\versions.md`](../context/versions.md).
