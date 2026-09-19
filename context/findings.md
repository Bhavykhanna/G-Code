# Findings — what was measured, and what it cost to learn

Last updated: 2026-09-19. Part of the context set — **index: [`README.md`](README.md), read that first**.
The numbers here were measured on this machine, on real files. Where something is argued rather than
measured, it says so. New findings are added here as they are made; the job they came from goes in
`..\context-local\` ([the split rule](README.md#the-split-two-folders-one-rule)).

## Printing

| Finding | The number | Why it matters |
|---|---|---|
| **A 100 % part fan was ruining PLA+ layer bonding** | fan min/max now **15 / 50 %**, cooling layer time 20 s | the single biggest quality change made here. Full cooling looked "safe" and was the defect |
| Nozzle temperature | 220 → **225 °C** | visibly better layer bonding, same speeds |
| **Strings across holes were not a travel-speed problem** | ~2,400 travels after wall moves had **no retraction**, every one shorter than 1.5 mm, because `retraction_minimum_travel` was 1.5 | a hop that short never reaches the travel speed (accel 10000), so slowing travel could not have fixed it. `retraction_minimum_travel` 0.4 did |
| Travel speed | **300 mm/s** (the printer's own limit is 500) | the user's standing choice, not a safety limit |
| **A flat roof over an opening melts** | a 3.6 mm span printed as overhang wall at 80–100 mm/s, with a 70 % fan burst of ~0.5 s over a 15–19 % layer fan | the nozzle sits over it long enough to reheat it. Pointed 45° tops fixed it |
| **Thin bars print as islands** | bars of 1.07 mm → own retract, own prime, reheated; **1.4 mm** is the working minimum | same mechanism as above, and the reason the print check counts tiny islands |
| Square pads around screw holes | their corners are islands of their own | round ring pads print clean |
| Plastic under a screw head | warn below **1.5 mm**; the parts here sit at **2.0 mm** | a thin seat pulls through |
| **The part lifted at a corner and shifted near the end** | no brim, no skirt, and the automatic fan rising on the tallest layers (15 % → 38 %) | a lifted corner has the longest lever arm at the top; adhesion was never tuned. Ask about a brim for a large flat base |
| Print-check calibration | a part that melted scored **36 HIGH**; after the fixes **14**; with an added pocket **22** | the check is graded against real prints, not invented cases |
| **Cooling and slow-down are time-driven** | the same settings gave 15 % instead of 19 % fan on 26 layers of a slightly longer part | "print it like the last version" means copying the fan and wall speeds back after slicing, not just keeping the settings |

Settings and the reasoning behind each: [`..\profiles\README.md`](../profiles/README.md). The tuning
history: [`profiles.md`](profiles.md).

## The app

| Finding | The number | Why it matters |
|---|---|---|
| The parser is trustworthy | deposited filament matches the slicer's own footer to **0.0001 %** (5022.23 mm); 92,648 moves parsed in **122 ms** | everything else — edits, diff, print check — rests on this |
| Selection round-trips | 1,916 moves → line ranges → 1,916 moves, exactly | what makes "select a region and hand it to Claude" safe |
| The renderer is not the bottleneck | 872k triangles in **3 draw calls**, `setData` 58 ms, layer scrub 0.4 ms per 5,000 calls | geometry can be rebuilt on every change without a budget |
| **A re-slice is cheap and exact** | **1.4–2.3 s**, byte-identical output for identical inputs | so anything geometric goes back through the slicer instead of being hacked in G-code — the boundary the whole app is built on |
| Hover picking cost a full geometry pass ~20×/s | now fires once the pointer rests **70 ms** | a sweep across the model costs nothing |
| Thumbnails re-encode character-identical to the slicer's own | server render ~50 ms | strong evidence the format is right — **still unverified on the printer's screen** |

## Traps that cost real time

- **`index.html` falls back to a mock harness** if `src/main.js` fails to import — it once looked like a
  working app full of fake data. It now shows a red error bar.
- **Query strings must be `encodeURIComponent`'d**: a filename containing `+` decodes as a space → 404.
- **`dryRun` defaults to `true`** on `/api/edit`; a real write needs `dryRun:false` *and* a note.
- **The slicer writes its log to `00000.log` in its working directory**, not to stderr, which is always
  empty. On a failed slice, read `slicerLog`.
- **`layers.length` is one more than the layer count** — `layer_change_gcode` emits a trailing `;LAYER:`.
  Display `meta.layerCount`, use `layers[]` for geometry.
- **Tests must never write into the live `bridge\` folder** — one run made the running app look stuck.
- **A local server with a terminal is a remote-code-execution surface.** With `Access-Control-Allow-Origin: *`
  and no token, any page open in any browser on the machine could have driven it. Binding to 127.0.0.1 keeps
  other machines out, not other pages; a per-start token plus Host/Origin checks is what closed it.
