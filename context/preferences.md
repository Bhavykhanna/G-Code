# How the user wants Claude to work

Last updated: 2026-09-19. Part of the context set — **index: [`README.md`](README.md), read that first**. Always loaded (imported by `CLAUDE.md`).

## Before anything else

Two standing rules that frame everything below:

- **The repo is public.** Knowledge goes in `context\` written generically; job, customer and model names
  go in `context-local\` (git-ignored). If a sentence needs a name, that sentence belongs in the private
  half — see [`README.md`](README.md).
- **When a task is done, update the context** before saying so. [`README.md`](README.md) §4 is the table of
  which file takes what.

## Change only what was asked

**Ask first** (user, 2026-09-16):
- **Ask before editing any G-code or STL file, and before major changes to context files.** Small factual
  fixes to context files are fine.
- **Never launch or relaunch browsers, headless screenshots (`scripts/screenshot.mjs`) or the app window,
  and never start or restart the server, unless the user asks** — it crashed things once. Refresh the app
  with `node gcode-studio/server/app-cli.js reload`; if the server doesn't know that route, ask the user
  to press ↻ / F5.

**Never add a brim, skirt, fan change or any other setting the user did not ask for.** When you
update a file, diff the settings you are about to slice with against the version you started from;
anything extra is a *suggestion* to the user ("the corner lift would need a brim — want it?"),
not a change. (2026-09-16: an update to the enclosure base came out with an unasked-for brim.)

**New or changed areas keep the print settings of the model before the edit.** If you stretch,
add or reshape part of a model, the new part must print exactly like the part it continues:
same walls, line width, infill, layer height, speeds, fan, temperatures — slice with the same
profile files the previous version used, and check the result against the old G-code (same
settings block apart from what the user asked for). Never let a region fall back to slicer defaults.

**How to build a new version (user's words, keep to it):** keep print speeds and temperatures
unchanged — copy *all* settings from the previous version's G-code settings block, change only the
requested values (plus the travel/retraction preference below), and after slicing verify that no
other value differs. `<job>\v2\build.py` does exactly this; reuse it.

**Travel moves (user preference):** 500 mm/s is too fast for this user. In every new draft set
`travel_speed` to **300 mm/s** unless they give a number, **and** lower `retraction_minimum_travel`
(1.5 → 0.3–0.5): measured on the phone cases, the stray lines during walls come from sub-1.5 mm hops
over the hexagon holes that skip retraction, and those never reach 500 anyway. Say both changes in
your reply. Details in memory.

## Preview every change on the model first (required — the user's favourite)

Before you edit or re-slice anything, **show the plan in the app** and wait for a yes. Words and
coordinates alone are not enough. The standard preview, used and approved 2026-09-16:

1. One box per part, in reading order. Labels say what the part is and what happens to it
   ("…: moves 3.2 mm left", "…: stays"). Don't number the labels; the app numbers them.
2. Every part that moves gets `--move DX[,DY]`; anything that grows or shrinks gets
   `--to A:B` / `--to-y A:B`; parts that stay get a box too, labelled "stays", so the user sees
   the boundary.
3. The app turns the rest grey, looks top-down, paints the walls in each box's colour, draws
   dashed outlines where things end up, arrows and a sliding copy. Say the size change in your
   reply (e.g. "base gets 3.2 mm longer").
4. If the user changes the numbers, run `show` again with the new ones before building.

Worked example: widening the enclosure base's wire gap to 4 mm.

```
node gcode-studio/server/app-cli.js show "<job>/v1 final/enclosure-base-mesh-fast.gcode" \
  --x 154.2:167.5 --label "outer wall + screw holes: moves 3.2 mm left" --move -3.2 \
  --x 167.5:168.7 --label "first line (controller compartment start): moves left" --move -3.2 \
  --x 168.7:192.0 --y 186.8:239.2 --label "controller compartment: moves left, stays 23.35 mm" --move -3.2 \
  --x 192.0:193.2 --label "divider (controller compartment end): moves left" --move -3.2 \
  --x 193.2:194.05 --label "gap: 0.79 mm -> 4 mm" --to 190.0:194.05 \
  --x 194.05:196.1 --y 190.6:235.4 --label "left L brackets: stay"
node gcode-studio/server/app-cli.js show --clear
```

Coordinates are bed / G-code mm (v1 models are centred on the bed, X/Y 213 on this printer; the enclosure v2 is shifted −2.1 mm in X).
Measure the real wall positions from the G-code first; don't guess. `--y`, `--z` or `--layers`
narrow a box; left out, it spans the whole part. Colours per box: white, gold, pink, violet,
cyan, peach.

## Show the user what changed

After writing or changing any G-code, open it in the app with the diff on:

```
node gcode-studio/server/app-cli.js open "<file>" --diff              (diff vs the final it came from)
node gcode-studio/server/app-cli.js open "<file>" --diff "<base file>" (any base, e.g. another folder)
```

After rebuilding the app (`npm run build` in `gcode-studio`), refresh the window yourself:
`node gcode-studio/server/app-cli.js reload` (Claude keeps running; a server restart would end this session).

## When the user attaches something from the app

A line like `[G-code Studio · area sel-… · <file> · … · data gcode-studio/bridge/attached/sel-….json · view ….png]`
is a selection from the 3D view. Read the JSON (source line ranges, layers, features) and look at the
PNG before answering. Geometry (walls, line width, gaps, infill) needs a re-slice; speed, flow
(±20 %), fan, temperature can be edited in the G-code.

## Check every print file before calling it done (user, 2026-09-17)

The enclosure base v3 printed with the tops of its divider openings melted and a little black: the nozzle
touched them. So, for every new or changed G-code, before saying it is done or finalizing:

```
node gcode-studio/server/print-check-cli.js "<file>" [--vs "<previous version>"] --show
```

The app has the same check on the **Check** button in the title bar (`K`), which draws the boxes itself (2026-09-18).
It lists (and with `--show` draws in the app) tiny islands, travels skimming fresh plastic, fast spans with a
fan that only bursts, the nozzle below printed plastic, long unlifted travels, lines printed twice, and
**screw holes with < 1.5 mm of plastic under the head** (the user wants that warning every time, in the app).
Say every HIGH finding in the reply and compare with the previous version (`--vs`): new HIGH findings are
something to fix or to ask about, never to pass over silently. The check never changes a file.

## Summary for every new print file
- Change **only** what was asked; copy every other setting from the previous version and verify by
  diffing the settings blocks. No brim/skirt unless asked.
- Run `print-check-cli.js` (with `--vs` the previous version, `--show`) and report its HIGH findings.
- Travel speed **300 mm/s** (500 is too fast), `retraction_minimum_travel` ~0.4 (stray lines over holes).
- Work in a `..._vN-draft.gcode`, keep each step in `old\vN-steps\`, finalize when the user says so.
- Show planned changes in G-code Studio first (`gcode-studio/server/app-cli.js show …`), and open results
  with the diff. Rules for Claude: `CLAUDE.md` in this folder.
