# Printer, pen drive and software

Last updated: 2026-09-17. Part of the context set — **index: [`README.md`](README.md), read that first**. Read it for anything about the machine itself.

## Hardware & materials
- **Printer:** Elegoo Neptune 4 Max (Klipper firmware), 0.4mm brass nozzle, direct drive
- **Bed:** 426 × 426mm in the printer profile / G-code (the physical plate measures 420 × 420; G-code Studio shows 426 as the file says — user's choice, 2026-09-16), max height 480mm, High Temp Plate
- **Filament in use:** **HS PLA+** (high-speed PLA+). Closest slicer profile: `Elegoo Rapid PLA+ @EN4 Series`
- **Pen drive:** a 7.5 GB USB stick (shows up as `D:` when plugged in). G-code files go in its main folder, then you print from the printer's menu. Newer jobs get their own folder (`<job> v2\`).

## Software
- **ElegooSlicer 1.5.3.5** at `C:\Program Files\ElegooSlicer\elegoo-slicer.exe` (based on OrcaSlicer)
  - Installer for an older version (1.3.0.11) is in this Archive folder
  - Settings/profiles: `%APPDATA%\ElegooSlicer\` (system profiles in `system\Elegoo\{machine,process,filament}\EN4SERIES\`)
- **Python 3.12** with numpy, trimesh 5.1.0 and manifold3d at `%LOCALAPPDATA%\Programs\Python\Python312\python.exe`

## Why the printer screen preview is blank (and how to fix it)
The CLI output already carries the right setting - `thumbnails = 320x320/COLPIC, 160x160/COLPIC,
160x160/PNG` - identical to a GUI slice. The CLI simply never renders the images, because there is
no GL context when it runs headless. So the setting is not the problem and changing it will not help.

`EN4Max_0.4_3DBenchy_PLA0.25_21m42s.gcode` was sliced by the **GUI** and does contain them, which
makes it the reference for the format. It holds three payloads: `;gimage:` (320x320) and `;simage:`
(160x160) in Elegoo's proprietary **COLPIC** encoding, which is what the Neptune 4 screen reads, plus
a standard `; thumbnail begin/end` base64 PNG block. COLPIC is a 6-bit encoding over ASCII 48-111
(`0`-`o`) with `\` replaced by `~`, four characters packing to three bytes, and a small binary header
carrying the dimensions. G-code Studio generates and injects these - see
[`gcode-studio\docs\CONTEXT-thumbnail.md`](../docs/CONTEXT-thumbnail.md).

**How to add one** (writes the preview into the job's `..._v<N+1>-draft.gcode`; the final stays — Finalize it after):
```
node gcode-studio\server\thumbnail-cli.js "phonecase-17pro/<file>.gcode"          # or title bar ⋯ menu → Add printer preview
node gcode-studio\server\thumbnail-cli.js "<path>" --dry --png preview.png          # look first, write nothing
```
The preview is drawn in ElegooSlicer's own blue from a front-left view (~50 ms), and the toolpath is
checked to be byte-identical afterwards. Done for both phone cases on 2026-09-16 (16 Pro v5, 17 Pro v2) — not yet on the pen drive (see `gcode-studio\context-local\TODO.md`).
**Not yet confirmed on the printer screen itself** - check the tile the first time one of these is loaded.
