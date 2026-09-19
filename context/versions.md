# File names, versions and folders

Last updated: 2026-09-18. Part of the context set — **index: [`README.md`](README.md), read that first**. Read it before building, editing or finalizing a print file.

## File naming convention (use this for every slice)

```
EN4Max_0.4_<model>_<filament>_<layer height>_v<n>-<what changed>_<time>.gcode
```

| Field | Meaning | Examples |
|---|---|---|
| `EN4Max_0.4` | printer + nozzle | always this, for now |
| `<model>` | model name, CamelCase, no spaces | `Iphone16Pro_HexCover`, `Iphone17Pro_HexCover` |
| `<filament>` | filament used | `HSPLA+`, `PLA` |
| `<layer height>` | layer height in mm | `0.20`, `0.12` |
| `v<n>-<what changed>` | version number + **what changed vs the previous version**, kebab-case | `v1-honeycomb-nobrim`, `v2-brim-slowbase`, `v3-slowtop`, `v4-ironed` |
| `<time>` | print time from the G-code | `57m`, `1h11m` |

Rules:
- The **current** version sits in the job folder; **older versions move to an `old\` subfolder**, never overwritten.
- `v<n>` describes *the change*, not the whole config - the full settings live in the job's `README.md`.
- Source `.stl` files keep their original download name, so they stay traceable to where they came from.
- Each job gets its own folder (`phonecase-16pro\`, `phonecase-17pro\`) holding the G-code, the STL,
  a copy of the exact `machine.json` / `process.json` / `filament.json` that produced it, and a `README.md`.

Worked example:
```
phonecase-16pro\
    EN4Max_0.4_Iphone16Pro_HexCover_HSPLA+_0.20_v5-thumbnail_57m.gcode   <- current, print this
    Iphone16Pro_CoverHexagon_STL.stl
    machine.json   process.json   filament.json   README.md
    old\
        EN4Max_0.4_Iphone16Pro_HexCover_HSPLA+_0.12_v1-honeycomb-nobrim_1h11m.gcode
        EN4Max_0.4_Iphone16Pro_HexCover_HSPLA+_0.20_v2-brim-slowbase_45m.gcode
        EN4Max_0.4_Iphone16Pro_HexCover_HSPLA+_0.20_v3-slowtop_50m.gcode
        EN4Max_0.4_Iphone16Pro_HexCover_HSPLA+_0.20_v4-ironed_57m.gcode
phonecase-17pro\
    EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v2-thumbnail_49m.gcode    <- current, print this
    iphone17pro_hexagoncover.stl
    machine.json   process.json   filament.json   README.md
    old\
        EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v1-ironed_49m.gcode
```

## Folder layout (2026-09-17)

One folder per model. A model that got new iterations in their own folders keeps them together:

```
<job>\              the enclosure
    stl\                     the original STLs (never changed)
    v1 final\                the g25 reference prints (v1, never changed)
    v2 wire-gap\             v2: 5 mm wire gap + 7 divider openings (build.py, README, old\v2-steps\);
                             base v3 sits here too (old\v3-steps\): 2026-09-17 deeper inside + square bottom,
                             2026-09-18 hollow L-bracket feet with the floor printed inside the pocket
phonecase-16pro\  phonecase-17pro\   one folder per phone case, versions inside (current + old\)
```

G-code Studio lists version folders inside a model folder as "<job> / v2"
(a server started after 2026-09-17 is needed for that; the running one only lists top-level folders).

## Drafts, steps, Finalize (the rules)

File names follow `EN4Max_0.4_<model>_<filament>_<layer height>_v<n>-<what changed>_<time>.gcode`.

1. **Never edit a final file.** To change final `v2`, make `..._v3-draft.gcode` next to it
   (copy v2, or slice to that name). v2 stays in the folder as the file to print.
2. **All edits for v3 go into that one draft.** Before each change, copy the draft to
   `old\v3-steps\NN-<what>.gcode` (00-from-<final> when the draft is made, then 01, 02, …) so every step can be undone. The app's edit
   buttons do this themselves.
3. **When the user is happy, finalize:**
   `node gcode-studio/server/app-cli.js finalize "<job>\..._v3-draft.gcode" "<what changed>"`
   → **centres the part on the bed** (the shift goes into `old\v3-steps\align.json`; the copy before
   centring is kept as a step), renames it to `..._v3-<what changed>_<time>.gcode` and moves v2 into
   `old\`. Keep the steps. Drafts are *not* centred: they stay lined up with the final they came from,
   so the diff shows only the real change; the app reads `align.json` to line up finals later.
4. **v4 starts the same way**, as a new draft of final v3. Nothing is ever overwritten or deleted.
5. **A small fix to a final** (user, 2026-09-17: "too little a change for a v3") may, when the user asks,
   replace the final **under the same name**: build it as a draft first and check it, then move the old final
   to the next step `old\v<N>-steps\NN-<model>-before-<fix>.gcode`, put the fixed file in its place,
   and add that step's name to the model's `atFinal` list in `align.json` (so the diff knows it sits where
   the final sits). Say it in the job README. Example: the enclosure base corner fix in `<job>\v2\`.
6. A new iteration in a **new version folder inside the model folder** (e.g. `<job>\v3 <what changed>\`)
   is fine: say in its `README.md` which file it was made from.

---

## Worked example: one model from v1 to v3

This is the enclosure (`..\..\<job>\`), the job every rule above was learned on. Read it before
starting a new version — it shows what a version *is*, what goes in a step, and when a file may keep its name.
**Keep it updated:** every new version adds its line here when it teaches something, and to its job README always.

### v1 — the reference, never edited

Two files (base + lid) sliced from the STLs with the tuned profile, at 80 % Z on purpose. They predate the
naming convention and keep their old names; that is fine, a base only has to be readable. **Everything later is
built from v1's own settings block**, not from slicer defaults: the build script reads the `CONFIG_BLOCK` out of
v1's G-code and writes the three profile JSONs from it, so a new version cannot silently inherit a default.

### v2 — a geometry change, as a draft with steps

Change asked for: the wire gap 0.8 → 5 mm, and the divider openings from 9 × 2.8 mm to 7 × 3.6 mm.

1. `..._v2-draft.gcode` next to the v1 files. v1 stays the file to print until Finalize.
2. The build script: edit the STL → rebuild the profiles from v1's settings → slice → shift the result so the
   **unchanged side sits exactly where v1 had it** (so the app's diff shows only the real change) → diff the
   settings block against v1. That diff must contain **only what was asked**: it showed 6 of 627 keys —
   `travel_speed` 500 → 300, `retraction_minimum_travel` 1.5 → 0.4 (the standing preference) and 4 name labels.
3. Each stage was copied into `old\v2-steps\` first: `00-from-v1…`, `01-before-divider-openings…`, and so on.
4. **Finalize** centred the part on the bed (+2.1 mm X) and wrote the shift into `old\v2-steps\align.json`, so the
   diff still lines v2 up against v1 although the printed file moved. The uncentred copies stay as steps 02/03.

### Same-name replacements — a fix too small for a new version

Three of these happened on this model, each at the user's word ("too little a change for a v3"):

| Fix | Why it was not a new version |
|---|---|
| Corner gaps (the STL step had duplicated 32 seam triangles) | a bug in the build, not a design change |
| Fan per layer and lid wall speeds set back to v1's values | restoring the reference, not changing it |
| Hollow L-bracket feet | a 460-move edit inside one Z band |

The rule each time: build it as a draft, check it, move the old final to the next step
`old\v<N>-steps\NN-<model>-before-<fix>.gcode`, put the new file in its place **under the same name**, and add
that step to the model's `atFinal` list in `align.json` — without that the diff shifts the kept copy by the
centring offset and every line looks moved. Then say it in the job README.

### "Like v1" means what the printer runs, not only the settings block

The slicer picks the fan speed and the wall slow-down from each **layer's print time**, so a longer or reshaped
model comes out with different fan percentages and wall speeds from *identical* settings. On this job that was
15 % instead of 19 % on 26 layers, and lid walls at 35 mm/s instead of 31.6. The version is only "like v1" once
those are put back (`fan_like_v1.py … --fan --speed`), which is done **after** slicing and before finalizing.
Bridge bursts are left where this version's bridges are — they follow the geometry, not the reference.

### v3 — many edits, still one draft

Floor 1 mm thinner → holders 1 mm lower → ring pads round the screw holes → square bottom edge → openings moved
down and made taller → pointed opening tops and 1.4 mm bars (the melting fix) → hollow L-bracket feet → the box
floor printed inside the foot pocket → a 45° roof over the pocket. **All of it went into one
`..._v3-draft.gcode`**, with a step saved before each change (`old\v3-steps\00-…` = the v2 final it came from).
Steps 07 and 13–15 exist because v3 was later replaced under its own name — all of them are in `atFinal`.

### The gate before every Finalize

1. validator clean (`/api/edit` dry run or the build script's check);
2. settings diff against the previous final — only the requested keys, nothing else;
3. nozzle temperature identical per layer, fan matched to the reference;
4. `node gcode-studio/server/print-check-cli.js "<file>" --vs "<previous final>" --show`, and **every HIGH
   finding named in the reply** — new kinds are fixed or asked about, never passed over
   (this model went 36 HIGH → 14 after the melting fix, 22 with the feet pockets);
5. then `node gcode-studio/server/app-cli.js finalize "<draft>" "<what changed>"`.

### What it cost, version by version

| | base time / filament | what changed |
|---|---|---|
| v1 | 44m 50s · 27.86 g | the reference print |
| v2 | 46m 55s · 28.69 g | 5 mm wire gap, 7 openings; +travel 300 / retraction 0.4 |
| v3 | 46m 28s · 27.53 g | deeper inside, square bottom, melting fixes, hollow feet + pocket roof |
