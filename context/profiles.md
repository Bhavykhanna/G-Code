# Print profiles

Last updated: 2026-09-17. Part of the context set — **index: [`README.md`](README.md), read that first**. The tuned settings the jobs start from, and what was learned printing them.

## Your tuned "enclosure base" settings (the reference profile)
From `enclosure-base-fast.gcode` / `enclosure-base-mesh.gcode` on the pen drive. Sliced in ElegooSlicer, starting from the preset `0.20mm Standard @Elegoo N4Max 0.4 nozzle`:

| Setting | Value |
|---|---|
| Layer height | 0.12mm (first layer 0.28mm) |
| Walls | 3 (Arachne), 0.5mm line width |
| Top / bottom shells | 3 / 3 |
| Infill | 40% (rectilinear in enclosure base) |
| Nozzle / bed | 220°C / 60°C |
| First layer speed | 12mm/s (first layer infill 20mm/s, accel 200) |
| Outer wall | 70mm/s · inner wall 200 (fast) or 120 (mesh) |
| Sparse infill | 300mm/s · travel 500mm/s |
| Retraction | 0.6mm @ 60mm/s, z-hop 0.25 |
| Pressure advance | 0.02 |
| Supports / brim | off / none |

The "fast" and "mesh" versions differ only in `inner_wall_speed` (200 vs 120) and `retract_lift_enforce` (Top Only vs All Surfaces).

## The current reference profile: `g25` (2026-09-15)
From the two G-code files in the `<job>\v1` folder (base and lid, identical settings).
Process `g25` on printer profile `EN4Max lines`. **This supersedes the enclosure-base settings above** - it is
the same printer and filament, re-tuned after actually watching the prints.

| Setting | Old enclosure base | g25 | Why |
|---|---|---|---|
| Nozzle temp | 220 | **225** | better layer bonding in PLA+ |
| Fan min / max | 100 / 100 | **15 / 50** | the big one - 100% fan was chilling PLA+ and weakening layer adhesion |
| Fan cooling layer time | 80 | **20** | stop slowing the print down to cool layers that don't need it |
| Max volumetric flow | 21 | **20** | 21 was over what the hotend actually sustains |
| First layer speed | 12 | **30** | 12mm/s was overkill; adhesion is fine at 30 |
| First layer infill | 20 | **45** | same |
| First layer accel | 200 | **1000** | same |
| `slow_down_layers` | 4 | **0** | no longer needed once the first layer is quick |
| Outer / inner wall | 70 / 120 | **100 / 180** | quality held up at the higher speeds |
| Top surface | 40 | **60** | same |
| Vertical shell | critical_only | **ensure_moderate** | fills thin vertical walls properly |
| `precise_z_height` | 0 | **1** | model reaches its true height instead of rounding to a layer |
| Layer height | 0.12 | **0.20** | reason not recorded |

Unchanged: 3 walls (Arachne) @ 0.5mm, 3/3 top/bottom shells, 0.28mm first layer, retraction 0.6mm @ 60mm/s,
z-hop 0.25 all surfaces, pressure advance 0.02, no supports, no brim, travel 500, sparse infill 300, bed 60C.

Results: base 50 layers / 27.86g / **44m 50s**; lid 44 layers / 18.91g / **30m 14s**.

### What went wrong on that print (2026-09-16)
The part **lifted at a corner and then shifted near the end of the print**, and the fan was clearly too fast
in the closing layers. Reading the G-code confirms both, and the cause is that g25 tuned only speed, temperature
and layer bonding - **it never touched bed adhesion**:

- `brim_type = no_brim` and `skirt_loops = 0` - nothing at all holding the corners down
- `hot_plate_temp = 60` - on the low side for PLA+, but 65 was tried and reverted; the brim is the real fix
- the fan **ramps up toward the end**, because `fan_cooling_layer_time = 20` while the top layers take under 10s.
  Measured peak `M106` per layer: layer 22 `S38` (15%), layer 33 `S48` (19%), layer 47 `S76` (30%), layer 48 `S97` (38%).
  `overhang_fan_speed = 70` also fires `S178` (70%) spikes, e.g. on layer 34.

So cooling escalated on exactly the layers where the part was tallest - a lifted corner has the longest lever arm
there, the nozzle caught it, and the part slid. **Fix adhesion before reusing g25 on anything with a large flat base.**
