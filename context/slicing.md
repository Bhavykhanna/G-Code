# Slicing from the command line

Last updated: 2026-09-17. Part of the context set — **index: [`README.md`](README.md), read that first**. Read it before running ElegooSlicer's CLI.

## How to slice from the command line (for next time)
`phonecase-slicing\` holds the shared tooling and the master profiles (each phone-case job has its own
identical copies in `phonecase-16pro\` and `phonecase-17pro\`):
- `machine.json`, `process.json`, `filament.json`: complete profiles, ready to use
- `build_profiles.py`: rebuilds those profiles from an existing G-code's settings dump
  - It reads `D:\enclosure-base-fast.gcode`, so change that path if the pen drive isn't plugged in
  - The changes for this job are in the `# ---- requested changes` section
- `stlinfo.py` / `overhang.py`: check an STL's size, flat faces and overhangs
- `layers.py`: checks a G-code's speed, extrusion and feature types per layer

Command (PowerShell). The slicer is a GUI program, so use `Start-Process -Wait` or it returns immediately:
```powershell
$d = "<the job folder>"   # holds machine.json / process.json / filament.json
Start-Process "C:\Program Files\ElegooSlicer\elegoo-slicer.exe" -NoNewWindow -Wait -PassThru `
  -RedirectStandardOutput "$d\out.txt" -RedirectStandardError "$d\err.txt" `
  -ArgumentList @("--load-settings", "`"$d\machine.json;$d\process.json`"",
                  "--load-filaments", "`"$d\filament.json`"",
                  "--slice", "0", "--outputdir", "`"$d\out`"", "`"PATH\TO\model.stl`"")
# output: $d\out\plate_1.gcode
#   → rename to EN4Max_0.4_<model>_<filament>_<layer>_v<n>-<what changed>_<time>.gcode
#     e.g. EN4Max_0.4_Iphone16Pro_HexCover_HSPLA+_0.20_v4-ironed_57m.gcode
#   keep the previous version in an old\ subfolder rather than overwriting it
```

Problems we hit and how we fixed them:
- **Exit -17** means the process/filament profile is "not compatible" with the printer. The fix: name the machine profile exactly `Elegoo Neptune 4 Max 0.4 nozzle`, set `"from": "system"`, and give the process/filament profiles `compatible_printers: ["Elegoo Neptune 4 Max 0.4 nozzle"]`.
- **Exit -51 "Add G92 E0 to layer_gcode"** happens when you load the system JSONs directly. The CLI doesn't fill in their `inherits` parents, so use complete profiles instead.
- Settings that hold lists (e.g. `printable_area`, `nozzle_temperature`, `machine_max_speed_x`) must be JSON arrays.
- `--info model.stl` works for a quick check of the mesh (size, manifold, parts).
- Print time and filament use are near the end of the G-code: search for `estimated printing time` and `filament used`.
