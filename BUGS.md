# G-code Studio — bugs

Last updated: 2026-09-19. Part of [G-code Studio](CONTEXT.md). Planned work lives in [context-local\TODO.md](context-local/TODO.md).

For each bug: what you see, why it happens, where. Move fixed ones to the bottom with the date and
the fix, so the same trap is recognisable next time.

Entries here carry **no job or model names** - this file is public. `context-local\BUGS-local.md` stays on the machine and
is the index saying which real job, file and folder each entry came from.

## Open

| # | What you see | Cause | Where | Severity |
|---|---|---|---|---|
| ~~B1~~ | *moot 2026-09-16: the mailbox panel was removed; Claude runs in the app* — Chat messages from the app sat unanswered | Claude only reads `bridge/chat.jsonl` while its session is running; nothing polls it by default | process, not code — see TODO "Hands-off chat replies" | high (by design, but it looks broken) |
| B2 | The app says "server not reachable" some time after starting it | The server is a child of whatever started it; when that process ends (e.g. a Claude session closes) the server goes too | `scripts/dev.js` | medium — re-run the `.bat` (Claude: only when the user asks) |
| B3 | A fan or temperature edit also changes moves you did not select | Fan and temperature are machine state, so they apply to the whole span of the selection, gaps included | `server/api/edit.js` (`setFan`, `setTemp`) | medium — the server returns a coverage note; the UI does not show it yet |
| B4 | "Cannot version this file" when editing or adding a preview in an older job folder | New file names are derived from the old one, and files that predate the naming convention have nothing to derive from | `server/api/version.js` | low |
| B5 | Long feature names in the left rail are cut short ("Sparse in…") | The rail's scrollbar gutter takes ~9 px | `src/styles.css` `.rail` | cosmetic |
| B6 | Predicted print time after an edit is approximate | It is the parser's timing model scaled to the slicer's figure, not a re-slice | `server/api/edit.js` | low — labelled "predicted" in the confirm dialog |
| ~~B7~~ | *fixed 2026-09-16, see below* — Arc moves (`G2`/`G3`) were ignored | The parser skips them; 3 in the demo file, all in start/end G-code | `src/parser/parse.js` | low now — high if arc fitting is ever turned on in the slicer |
| ~~B9~~ | *fixed 2026-09-16, see below* — Any web page open in a browser on this PC could call the API | the server sends `Access-Control-Allow-Origin: *` and has no token. Binding to 127.0.0.1 keeps other machines out, not other pages. Today that allows versioned, validated edits and reading Archive files — tolerable. With an embedded terminal it would be remote code execution | `server/index.js` | **must fix before any terminal / Claude-runner feature**: drop CORS `*`, require a per-start random token the app receives from its own page |
| B8 | Headless screenshots always show the mock UI | Headless Edge has no WebGL by default | test tooling only | workaround exists (`scripts/screenshot.mjs`, headless Edge + SwiftShader) — **only run it when the user asks**; unasked headless runs crashed things (2026-09-16). The synthetic mouse drag does not reach the controls (orbit / area drag untested headless). |
| B10 | Claude in the app is cramped (~44 columns) | the right panel is 348 px | `src/ui/layout.js` | low — **Wide** button in the Claude pane header |
| B11 | Screenshots for Claude (`bridge/attached/*.png`) not yet compared with the screen | captured off-screen; colour handling argued from three's source, not measured | `src/render/viewer.js` `captureView` | low — check once |
| ~~B12~~ | *fixed 2026-09-17, see below* — `npm run check` failed "untouched right half" | | | |
| B13 | `npm test` reports server-smoke / server-terminal failed; each passes alone and `node test/server-all.js` passes all 6 | every server test binds the same port 5199 (`test/server-helpers.js:14`), and `node --test` runs the files in parallel — the `test/*.js` glob also includes `server-all.js`, which runs them all a second time | `package.json` "test", `test/server-*.js` | low — use `node test/server-all.js`; fix: exclude `server-*.js` from the glob or give each file its own port |

## Fixed

| Date | What you saw | Cause | Fix |
|---|---|---|---|
| 2026-09-17 | A printed part came out with the tops of its wall openings melted and a little black (the nozzle touched them) | 3.6 mm spans printed as overhang walls at 80-100 mm/s with a 70 % fan burst of ~0.5 s over a 15-19 % layer fan; 8 tiny bars (0.7 x 0.5 mm) printed as islands with their own pull-back / push-out; same pattern in v1 with 2.8 mm openings | not a code bug: `print-check-cli.js` now finds it in any file; the part itself still needs a fix (see the job notes) |
| 2026-09-17 | (found while finalizing base v3) a diff of a new final against the previous final, now in `old\`, would not line up | the align note stores `alignedWith` as the path before Finalize moved that final into `old\` | `alignFor` accepts the `old\` copy of `alignedWith`; tests in `check-align.js` (backup `backup\2026-09-17-before-align-old\`) |
| 2026-09-17 | (found while checking) a diff of a final against a kept copy of that same final in `old\v<N>-steps\` would shift the copy by the centring dx | `alignFor` treated every steps-folder file as "before centring" | `atFinal` list in the align note (`src/align.js`); `centre.js` keeps it; tests in `check-align.js` |
| 2026-09-17 | A rebuilt part had walled gaps in two corners that the version before it does not have (job bug, not the app) | `build.py` divider step re-saved the STL via trimesh `split()` + `concatenate()`: 32 duplicate seam triangles | the step writes the original triangles unchanged; the part was rebuilt and put in place under the same name (details in that job's own README, which stays local) |
| 2026-09-17 | Area select looked like a thin cyan strip + blobs, not the rectangle | with "Fully inside", long top-surface lines crossing the rectangle are not selected and cover the selected moves below them. Not the bottom-view change: it only acts while the camera is under the bed | crossing moves get a PARTIAL flag and are highlighted per pixel inside the rectangle (region fixed on the model); selection unchanged. *Confirmed by the user; cyan at 50 %, locked. Backup in `backup\2026-09-17-before-area-clip\`* |
| 2026-09-17 | `npm run check` failed "walls of the untouched right half" (B12) | the check took that job's first file, by then the final with the openings cut (and later centred) | it reads the kept pre-divider draft `old\v2-steps\01-before-divider-openings.gcode` |
| 2026-09-16 | Bottom view showed only specks of the model | big files use the `fast` tent profile, which has no bottom face; FrontSide culling left nothing to draw from below | ribbons double-sided while the camera is under the bed; lights mirrored; bed see-through |
| 2026-09-16 | F5 did nothing sometimes | the Claude terminal (xterm) took F5 as a key when focused | F5 passed to the browser; ↻ button; `app-cli.js reload` |
| 2026-09-16 | In the diff the new screw holes were hard to see / grey | old walls drawn solid; matching used 0.75 mm cells with no feature or direction, so moved rings crossing old rings or floor counted as unchanged | compare rewritten (plastic per layer, walls by direction, path smoothing, sparse neutral); removed moves faint with a depth pre-pass |
| 2026-09-16 | `app-cli.js show` opened the file but drew nothing | the app never subscribed to the server's `highlight` event | listener added; `npm run check` now fails if any server event has no listener |
| 2026-09-16 | "3 arc move(s) (G2/G3) were skipped" | the parser skipped arcs | arcs drawn as chords (≤0.02 mm), edits treat G2/G3 as moves, flow scaled once per line |
| 2026-09-16 | The app seemed stuck; "Claude replied" pop-ups from nowhere | server tests wrote into the live `bridge\` folder, and the running app reacted to every write | tests use their own folder (`GCS_BRIDGE_DIR`, `test/_isolate.js`); the junk was cleared |
| 2026-09-16 | Area select took the outer skirt "for no reason" | a move counted if its **midpoint** was inside; a skirt line's midpoint is inside almost any rectangle | default rule is now *both ends inside*; skirt, brim and purge line excluded unless ticked; rule selectable in the Select panel |
| 2026-09-16 | B9: any web page could call the API (and a terminal would have been a shell for it) | CORS `*`, no auth | per-start token in the page (`X-GCS-Token` / `?token=`), Host + Origin checks, no CORS headers, dotfiles not served |
| 2026-09-16 | Panning kept following the mouse after letting go | Middle-click autoscroll / context menu swallowed `pointerup`, so the drag stayed latched | drag ends on `buttons === 0` (mouse only), one `endDrag()` for every path, `auxclick` suppressed, clear on blur/hide |
| 2026-09-16 | Panning off-centre sliced the model open | near/far planes followed the orbit radius, not the camera's distance to the model | planes bracket the scene's bounding sphere |
| 2026-09-16 | Trackpad could not pan at all | the `buttons === 0` guard fired on touchpads/pens, which report 0 mid-drag | guard limited to `pointerType === 'mouse'` |
| 2026-09-16 | App showed fake data and "mock viewport" | `index.html` built the `main.js` import path at runtime, so the production build had no renderer; failures fell back to the mock silently | literal import; a red error bar and a report to the server on failure; `main.js` survives a renderer failure |
| 2026-09-16 | Page reloaded every few seconds | Vite hot-reload while files were being edited | built mode (`npm start` / `.bat`) serves `dist\` with no hot reload |
| 2026-09-16 | Launcher failed: `'C:\Program' is not recognized` | Node spawned through a shell split `C:\Program Files` at the space | spawn node directly; vite via its JS entry point |
| 2026-09-16 | "No G-code files found. Is the API server running?" | the server had stopped | restart; see B2 |
| 2026-09-16 | File menu listed folders that failed to open | the menu wants files, `main.js` passed job folders | flatten jobs into current + archived files |
| 2026-09-16 | "Apply to selection" did nothing | never connected to the server | wired: ops → dry run → diff → confirm → write → reopen |
| 2026-09-16 | Claude's replies never appeared in the app | server sends `chat` as `{messages:[...]}`; the app appended the wrapper as one message | handle the batch |
| 2026-09-16 | App never reloaded when a new version landed | server event is `gcode`, client listened for `file` | listen for `gcode`; ignore the "moved to old\" event of our own write |
| 2026-09-16 | Selection panel showed dashes for length/time per feature | selection carried only counts | `{count, lengthMm, timeSec}` per feature |
| 2026-09-16 | Moving the mouse over the model lagged | every hover ran a full extra geometry pass, ~20×/s | pick only once the pointer rests 70 ms |
| 2026-09-16 | Moves / Geometry cut off in the left rail | rail had `overflow: hidden` | rail scrolls; sections collapse |
| 2026-09-16 | Two app windows after a restart | the old window lived inside the shared Edge process, where the close-by-command-line check could not see it | own browser profile for the app; close-by-title for older windows |
| 2026-09-16 | Server tests failed after saving a new version | tests pinned "current" file names | tests use frozen `old\` files and check the rules, not the counts |
| 2026-09-16 | Preview button could create identical versions | a second server render of the same file is the same image | 409 when the file already has a preview |
| 2026-09-16 | Filament cross-check said 15 % off | the check subtracted retractions, which primes cancel | compare extrusion E only — parser was right |
