# Default print profile — Elegoo Neptune 4 Max, 0.4 nozzle, PLA+

`profiles\default\` is the profile **new models start from**. It is the one that printed the enclosure
(base and lid) — tuned by watching real prints through v1, v2 and v3 — under the generic name
`EN4Max 0.4 default 0.20`. Three complete JSONs, no `inherits` parent, so the slicer CLI can load them
directly (a system profile cannot: see [`..\context\slicing.md`](../context/slicing.md)).

| File | Name inside | What it holds |
|---|---|---|
| `machine.json` | `Elegoo Neptune 4 Max 0.4 nozzle` | bed 426 × 426 × 480, start/end G-code, retraction, thumbnails. **Do not rename** — the slicer matches process and filament to this exact string |
| `process.json` | `EN4Max 0.4 default 0.20` | 512 keys: layers, walls, infill, speeds, acceleration |
| `filament.json` | `EN4Max 0.4 default PLA+` | temperatures, cooling, flow, volumetric limit |

**Verified 2026-09-19:** these three slice the demo cover from the CLI with no warning — 57 layers,
13.97 g, 33m 23s — and the resulting G-code carries every value below.

## Use it

```powershell
$d = "<path to>\gcode-studio\profiles\default"
Start-Process "C:\Program Files\ElegooSlicer\elegoo-slicer.exe" -NoNewWindow -Wait `
  -ArgumentList @("--load-settings", "`"$d\machine.json;$d\process.json`"",
                  "--load-filaments", "`"$d\filament.json`"",
                  "--slice", "0", "--outputdir", "`"<out folder>`"", "`"<model>.stl`"")
```

From the server, `POST /api/slice` uses the job folder's own `machine/process/filament.json` and falls back
to these when the job has none — so **a new model gets this profile without anyone choosing it**. A new job
should then keep its own copy of the three files next to its G-code; that copy is what makes an old version
reproducible later.

## What is in it, and why

Every "why" below came from a print that was looked at afterwards, not from a default.

### Layers, walls, shells

| Setting | Value | Why |
|---|---|---|
| `layer_height` / first layer | **0.20** / 0.28 mm | 0.12 was used at the start; 0.20 nearly halves the time with no visible loss on these parts |
| `wall_loops` | **3** @ 0.5 mm (`wall_generator: arachne`) | a 1.5 mm shell — stiff enough for a box that holds electronics, and Arachne fills the thin ribs this kind of model has instead of dropping them |
| top / bottom shells | **3 / 3**, `monotonic` | monotonic top surfaces are what make a lid read as one flat face |
| `ensure_vertical_shell_thickness` | `ensure_moderate` | thin vertical walls (the divider, the L brackets) come out solid instead of hollow |
| `precise_z_height` | 1 | the part reaches its true height instead of rounding to a layer — it matters when a lid has to fit |
| `wall_sequence` | inner → outer | the outer wall is laid against something already there, so the surface is cleaner |
| `seam_position` | aligned | one visible seam line instead of scattered blobs |

### Infill — 25 % gyroid, and why that pattern

`sparse_infill_pattern: gyroid`, `sparse_infill_density: 25%`, line width 0.68 mm, 300 mm/s.

Gyroid is the right default here for reasons that are specific, not fashion:

- **It is equally stiff in every direction.** A box like this is pressed on from above (a board clipped into
  it) and twisted when it is screwed down. Rectilinear is stiff along its lines and soft across them; gyroid has no
  weak axis, so the same 25 % does more work.
- **Its paths never cross inside a layer.** Nothing is printed twice, so no ridge builds up for the nozzle to
  hit on the next layer — one of the two things that melted an earlier version.
- **It is one continuous curve per region**, so it runs at the full 300 mm/s with almost no retractions or
  travels; at 25 % it is not slower in practice than a sparser rectilinear.
- **It carries flat tops well** at 25 %, which is why the top shells can stay at 3 layers.

Raise the density for a part that carries load; do not raise it "to be safe" — it costs time and adds warping
pull, and on these parts it is the shell that provides the stiffness.

### Speeds and acceleration

Outer wall **100**, inner wall **180**, sparse infill **300**, internal solid 250, top surface **60**,
gap fill 80, bridges 100, overhangs 150 / 100 / 80 / 80 by overlap, first layer **30** (its infill 45).
Acceleration 10000 default, outer wall 5000, first layer 1000, top surface 2000.

These are the second tuning round: the first profile ran the outer wall at 70 and the first layer at 12 mm/s.
Quality held at the higher numbers, and a first layer at 30 mm/s still sticks — which also removed the need
for `slow_down_layers`, now 0.

**`travel_speed` 300, not the printer's 500** — the user's standing preference; and
**`retraction_minimum_travel` 0.4, not 1.5**, which is the real fix for strings pulled across holes: hops
under 1.5 mm skipped the retraction entirely, and a hop that short never reaches 500 mm/s anyway, so lowering
the travel speed alone would not have fixed them.

### Temperature and cooling — the biggest lesson

| Setting | Value | Why |
|---|---|---|
| nozzle / bed | **225 / 60 °C** | 220 was the old value; 225 bonds PLA+ layers noticeably better |
| `fan_min_speed` / `fan_max_speed` | **15 / 50 %** | the single biggest change made here: the earlier profile ran the fan at **100 %**, which chilled PLA+ and weakened every layer bond |
| `fan_cooling_layer_time` | **20 s** | stops the slicer slowing the print down to cool layers that do not need it |
| `close_fan_the_first_x_layers` | 12 | the first layers stay warm and stuck |
| `overhang_fan_threshold` / `overhang_fan_speed` | 25 % / 70 % | short bursts on real overhangs only |
| `slow_down_layer_time` | 8 s | a small layer is slowed instead of blasted with air |
| flow ratio / max volumetric | 1.02 / **20 mm³/s** | 21 was over what this hotend actually sustains |

**Cooling is time-driven, so it moves when the model does.** A longer or reshaped part gives every layer a
different print time, so the slicer picks different fan percentages and wall speeds *from these same settings*.
When a new version has to print like the one before it, the fan value at each layer change and the slowed wall
speeds are copied back from the reference file after slicing — `fan_like_v1.py … --fan --speed` in the job
folder. Bridge bursts are left alone: they belong to this version's geometry.

### Adhesion — what this profile deliberately does not do

`brim_type: no_brim`, `skirt_loops: 0`, `enable_support: 0`, `ironing_type: no ironing`,
`elefant_foot_compensation: 0.1`.

Nothing is added unless it was asked for. But know the trade-off: the reference print **lifted at a corner and
then shifted near the end** — a large flat base, no brim, and the automatic fan rising on the tallest layers,
where a lifted corner has the longest lever arm. For a new model with a big flat footprint, raise a brim as a
question before slicing; never add one silently.

## Geometry rules that come with this profile

The print check (`server\print-check-cli.js`, and the **Check** button, `K`) was written after a print melted.
These are the shapes that survive this profile — worth designing to, because no setting rescues them:

- **No flat roof over a hole.** Give an opening a **45° pointed top**: a 3.6 mm flat span printed as an
  overhang wall at 80–100 mm/s, with a fan burst too short to spin up, melted and blackened.
- **Bars between openings ≥ 1.4 mm.** At 1.07 mm each bar is a tiny island — its own retract, its own prime,
  and the nozzle over it long enough to reheat it.
- **Round pads, not square ones,** around screw holes: the corners of a square pad are islands of their own.
- **≥ 1.5 mm of plastic under a screw head** (the check warns below that; these parts sit at 2.0 mm).
- **A pocket under an arm gets a 45° roof**, pulled back ~0.2 mm per layer, so the arm lands on plastic
  instead of bridging air.
- Run the check on every new file with `--vs` the previous version, and report every HIGH finding.

## History

Distilled from `..\..\<job>\`: the v1 reference prints, the v2 wire-gap rebuild and the v3 base
(deeper inside, square bottom, melting fixes, hollow feet with a pocket roof). The version-by-version story is
in [`..\context\versions.md`](../context/versions.md) → *Worked example*; the older tuning table and the
corner-lift post-mortem are in [`..\context\profiles.md`](../context/profiles.md).
