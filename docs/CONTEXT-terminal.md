# Claude in the app — context

Last updated: 2026-09-17

Owns `server/terminal.js`, `src/ui/terminal.js`, and the attach flow
(`POST /api/bridge/attach`, `bridge/attached/`). Part of [G-code Studio](../CONTEXT.md).

The app runs **real interactive Claude Code** in a panel — the same thing you get in a terminal,
not a chat imitation. You open the app and Claude is already there. The old mailbox chat panel
was **removed from the app** on 2026-09-16 at the user's request; everything the app says to Claude
(attachments, the left rail's re-slice requests) is typed into this terminal. The server's mailbox
routes and `server/chat-cli.js` still exist ([CONTEXT-bridge.md](CONTEXT-bridge.md)) but nothing in
the app uses them.

Selections and picked moves are **attached**, not sent: the app types a one-line reference into
Claude's prompt (without pressing Enter), you write the message after it and press Enter yourself.

---

## Why it is built this way

| Decision | Why |
|---|---|
| `node-pty` + xterm.js, not `claude -p` per message | full Claude Code: permissions prompts, `/` commands, Esc to interrupt, plan mode. Headless mode has none of that and bills a fresh context per turn. Measured: `node-pty` 1.1.0 ships a win32-x64 prebuild, loads on Node 24.21 with no compiler, and `claude` 2.1.273 draws its full UI inside it and exits cleanly on Ctrl+C. |
| `claude.exe` spawned directly | `claude.cmd` is a batch wrapper; Ctrl+C through `cmd.exe` can leave "Terminate batch job (Y/N)?" behind. `cmd.exe /d /c claude` is only the fallback. |
| cwd = **Archive root**, not `gcode-studio\` | Claude's memory, `CLAUDE.md` and `context\` are keyed to the Archive folder, and the job folders are there. Every path handed to Claude is therefore relative to the Archive root (`gcode-studio/bridge/...`). |
| Session-marker env vars stripped | Measured: a server started from inside a Claude session passes `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION` etc. to its children, and the child Claude then runs with **transcript saving off**. |
| One PTY per server, shared by all windows | Reloading the window must not kill the conversation. Output is kept in a 256 KB scrollback and replayed on reconnect. |
| Token + origin + host checks (fixes BUGS B9) | A terminal endpoint is a shell. Before this, any web page open in any browser on this PC could call the API. |
| Attach = typed reference, not auto-send | You asked to write the message yourself. The reference is one line so Claude Code shows it inline instead of collapsing it into "[Pasted text]". |

---

## Contract

### 1. Security (server/index.js) — fixes B9

- A random token is made at server start: `crypto.randomBytes(24).toString('hex')`, or
  `process.env.GCS_TOKEN` when set (tests). It is written to `gcode-studio/.gcs-token`
  (for the Vite dev plugin and for Claude/CLI tools) and exported as `getToken()`.
- **Every `/api/*` request needs the token**: header `X-GCS-Token`, or query `?token=` (the only
  way `EventSource` and `WebSocket` can send it). Missing or wrong → `401 {error}`.
- `Host` header hostname must be `localhost`, `127.0.0.1` or `[::1]` → else `403` (DNS rebinding).
- If an `Origin` header is present it must be `http://localhost:<any>` or `http://127.0.0.1:<any>`
  → else `403`. Applies to the WebSocket upgrade too.
- **No CORS headers at all.** `OPTIONS` answers 204 with none, so cross-origin preflights fail.
- When the server serves `index.html` (from `dist\` or the project root) it injects
  `<meta name="gcs-token" content="…">` straight after `<head>`, `Cache-Control: no-store`.
  Other origins cannot read that page, which is what keeps the token private.
- Static serving refuses any path segment starting with `.` (so `.gcs-token`, `.app-profile`).

Client side: `src/bridge/client.js` reads the meta tag and sends the header on every call, and
`?token=` for `/api/watch` and `/api/term`. Vite dev (`vite.config.js`) injects the same meta tag
by reading `.gcs-token` on each page load, and proxies `/api` with `ws: true`.

### 2. Terminal (server/terminal.js)

WebSocket at `GET /api/term?token=…`. JSON text frames both ways.

Client → server

| Message | Effect |
|---|---|
| `{t:'in', d}` | write `d` to the PTY (raw keystrokes / paste bytes) |
| `{t:'resize', cols, rows}` | resize the PTY (last one wins; also used for the next start) |
| `{t:'start', mode}` | `mode` = `'new'` (plain `claude`) or `'continue'` (`claude --continue`). **No-op if already running.** |
| `{t:'restart', mode}` | kill if running, then start |
| `{t:'stop'}` | kill the process |

Server → client

| Message | When |
|---|---|
| `{t:'hello', ...state}` | on connect, then one `{t:'out', d: scrollback}` if the buffer is not empty |
| `{t:'out', d}` | PTY output (utf-8 string) |
| `{t:'reset'}` | just before a (re)start — clients call `term.reset()`; the scrollback is cleared too |
| `{t:'state', ...state}` | on start and on exit |
| `{t:'error', message}` | spawn failure, bad message |

`state` = `{ running, pid, mode, startedAt, exitCode, cmd, cwd, cols, rows, clients, error? }`.
Also `GET /api/term/state` → `state` (JSON, token required).

The **client decides** when to auto-start: after `hello`, if `!running`, it sends `start` once per
page load. The server never starts Claude on its own.

Spawn: resolve `claude` on PATH; if it is the npm `claude.cmd`, use
`<dir>\node_modules\@anthropic-ai\claude-code\bin\claude.exe` when that exists; a `claude.exe`
on PATH is used as is; otherwise `cmd.exe /d /c claude`. Resolved on every start (updates move it).
`name: 'xterm-256color'`, cwd = `ARCHIVE_ROOT`. Env = `process.env` minus `CLAUDECODE`,
`CLAUDE_PID`, `CLAUDE_EFFORT`, `AI_AGENT` and every `CLAUDE_CODE_*` key in
{`CHILD_SESSION`, `SESSION_ID`, `MESSAGING_SOCKET`, `MESSAGING_TOKEN`, `SESSION_ATTENDED`,
`ENTRYPOINT`, `EXECPATH`, `SSE_PORT`}; plus `TERM=xterm-256color`, `COLORTERM=truecolor`,
`GCS_API=http://127.0.0.1:<port>`, `GCS_TOKEN=<token>`. The PTY is killed when the server stops.

### 3. Attach (server/api/bridge.js)

`POST /api/bridge/attach` `{ kind, id, file, data, png? }`

- `kind` ∈ `selection | area | move`; `id` matches `/^[a-z]+-[0-9a-z-]{1,60}$/i`
- `data` is any JSON object (≤ 2 MB serialised) → written to `bridge/attached/<id>.json`
- `png` optional `data:image/png;base64,…` (≤ 6 MB) → `bridge/attached/<id>.png`
- keeps the newest 40 ids, deletes older files
- answers `{ ok, id, json, png }` where `json`/`png` are paths **relative to the Archive root**
  with forward slashes (`gcode-studio/bridge/attached/sel-123.json`), `png: null` when none.

The app then types into the terminal, for example:

```
[G-code Studio · area sel-1789… · <job>/v1 final/enclosure-base-mesh-fast.gcode · 502 moves · layers 6–50 · X 20.1–80.3 Y 30.0–90.2 Z 1.28–10.00 mm · Outer wall +6 · data gcode-studio/bridge/attached/sel-1789….json · view gcode-studio/bridge/attached/sel-1789….png] 
```

### 4. Area select (src/render/viewer.js)

| Addition | Behaviour |
|---|---|
| `setAreaSelectMode(bool)` | left-drag draws a rectangle in `areaSelectStroke` (amber `#ffb020`). Turning it on turns box mode off and vice versa. Rotation disabled while on, pan still works. |
| `onAreaSelect(cb)` | `cb({ indices: Uint32Array, rect, bounds, total, partial, clip })` — **every** extrusion move in the current layer range and visible features that matches the "Counts if" rule (default: both ends inside the rectangle), **including ones hidden behind others**. `bounds = {min:[x,y,z], max:[x,y,z]}` of those moves, or `null`. A click without a drag still emits `pick`. Returns an unsubscribe. |
| `getLastRect()` | `{x0,y0,x1,y1,w,h}` (CSS px, canvas space, normalised) of the last box **or** area drag, else `null` |
| `captureView({maxWidth=1280, rect, label})` | PNG data URL of the **current camera view** — bed, background and selection highlight as on screen. `rect` (CSS px) is outlined dashed amber; `label` drawn top-left. Aspect ratio of the canvas kept. |

Box select stays a visibility test (see CONTEXT-render.md); area select is its through-the-model
counterpart. The UI keys: `B` box, `G` area.

Selection object gains two optional fields: `mode: 'box' | 'area'` and
`area: { rect, bounds, crossingNotSelected }` — the last is the number of moves that cross the
rectangle's edge: drawn coloured inside it, but **not** in the selection. The attach line says so
("N moves cross the edge: shown cut to the area, not in the selection").

---

## Area options and layer select (added after the first test)

The user's first area select picked up whole skirt lines "for no reason": the rule was *midpoint
inside*, and a skirt line's midpoint sits inside almost any rectangle on the part. Now:

- `selectInRect({match})`: `'inside'` (default, both ends inside), `'center'` (the old rule),
  `'touch'` (any part inside, Liang–Barsky). `exclude` drops feature ids outright.
- `viewer.setAreaOptions({match, exclude})`. The UI excludes Skirt, Brim, Custom and Unknown (the
  purge line) unless "Include skirt, brim and purge line" is ticked.
- **One Select button** (viewport, top right) opens the Select panel: **Area** (`G`), **Visible**
  (`B`, the old box select), **Layers** (`L`, no drawing — every extrusion in a layer range, same
  filters). The panel's layer numbers drive the layer bar and follow it; they limit area and
  visible select too. Options are remembered (`localStorage['gcs.select.*']`).
- Measured on the 17 Pro file, full canvas: inside 4.0 ms, touch 3.7 ms, center 2.3 ms (median).

## What the terminal Claude is told

`Archive\CLAUDE.md` (loaded by Claude Code at every start) tells it to read
**every** memory file in `gcode-studio\context-local\memory\` (not just the index), `gcode-studio\context\printer.md` and the job's README before print work
(it imports `gcode-studio\context\preferences.md` and `gcode-studio\context\versions.md`; job folders load their own `CLAUDE.md`); to change only what was asked (no unrequested brim/skirt — that happened once); the
draft/finalize versioning; and to run `node gcode-studio/server/app-cli.js open "<file>" --diff`
after writing a file so the user sees the change.

## Status

2026-09-16 — built and tested.

| Check | Result |
|---|---|
| `node test/server-all.js` | all 6 files pass (including the new `server-terminal.js`) |
| `npm run check` | integration check, plus real-file, arcs, area-select, compare, compare-render (all pass since B12 was fixed 2026-09-17) |
| `node test/check-area-select.js` | all passed, including the skirt case from the user's screenshot and the crossing (`partial`) list |
| real Claude via the server | `claude.exe` spawned directly, cwd Archive, transcript saving **on**, two Ctrl+C exit 0 |
| real app after restart | page connected and auto-started Claude (`/api/term/state` → running, 1 client) |

Deviations from the contract, by the server builder: token file and attach dir overridable for
tests (`GCS_TOKEN_FILE`, `GCS_ATTACH_DIR`); `useConptyDll: true` (inbox ConPTY's kill hangs 5 s;
`GCS_CONPTY=inbox` reverts); host check on static files too; attach body limit 12 MB.

**Not verified yet:** attach typing into the prompt by hand, the capture PNG against the screen
(BUGS B11). Real-3D headless screenshots exist (`scripts/screenshot.mjs`, SwiftShader, terminal
socket blocked), but **only run it when the user asks** — no unasked headless-browser runs and no
app-window relaunches.

Keys in the terminal: Ctrl+C copies when text is selected (else ^C), Ctrl+V pastes, **F5 is passed
to the browser and reloads the app** (Claude keeps running), Ctrl+R stays with Claude (history
search), Esc goes to Claude. Also the title-bar ↻ button, or
`node gcode-studio/server/app-cli.js reload` from the terminal (needs a server started after
`/api/app/reload` was added).

Known limits: at the default panel width Claude gets ~42 columns — use **Wide**. The token keeps
out other web pages, not other programs running as you.

## Claude points at the model (2026-09-16)

Asked for when Claude explained "the gap at X 193.2–194.0" in words: the user wants to *see* it.

- `node gcode-studio/server/app-cli.js show "<file>" --x A:B [--y A:B] [--z A:B] [--layers A:B] --label "…"`
  (repeat `--x … --label …` for more boxes; `show --clear` removes them)
- → `POST /api/app/highlight {path?, regions:[{x,y,z,layers,label}]}` → SSE `highlight`
- The app opens the file if needed, draws each box (translucent fill, bright edges, drawn on top),
  paints the moves whose midpoint is inside in the **box's colour** (`CLAUDE_COLORS`: white, gold,
  pink, violet, cyan-white, peach — never the user's cyan selection), lists them top-left as
  "Claude is pointing at: 1 … 2 …" with move counts ("empty space" for a gap), and zooms to them.
- Coordinates are **bed / G-code mm**. A missing y/z spans the whole part (purge line excluded).
- `Archive\CLAUDE.md` tells Claude to do this before editing and to ask for a yes.

Tested: route validation in `test/server-smoke.js`; `npm run check` fails if any server event has no app listener. **Confirmed on screen by the user 2026-09-16** (six boxes on the enclosure base). A line is painted only when both its ends are inside a box (a midpoint rule painted long top-surface diagonals far outside narrow boxes).

### Clearer pointers + planned change (2026-09-16, later)

User: "too mangled" and "move it to the direction of what will be done". Now, while boxes show:
everything else is dim grey (`RGB_DIM`); only **walls** inside a box are painted (floor/infill
lines crossed every box as stripes); box fill 7 %, solid outline; numbered tags on the model that
step aside when they would overlap; the camera goes **top-down** and frames the boxes.
Planned change per box: `--move DX[,DY]` or `--to A:B` / `--to-y A:B` → dashed outline at the new
place, an arrow per moving edge, and a copy that slides there on a 2.6 s loop.
Verified in headless Edge with SwiftShader WebGL (screenshot) on a test server (before the
no-unasked-headless rule; ask first); `--move`/`--to` need the live server restarted to pass
through. Restarting the server kills the in-app Claude session; ask the user first. The window
alone can be reopened (close the msedge process whose command line contains
`gcode-studio\.app-profile`, relaunch with a quoted `--user-data-dir`) — only when the user asks. The app also reopens the last open file on F5
(`localStorage['gcs.lastFile']`).

**Locked in as the standard (2026-09-16):** the user called the 4 mm wire-gap preview "op" and
asked for it to be the way every change is shown. `Archive\CLAUDE.md` makes it required before any
edit, with that preview as the worked example.

### Wall previews (2026-09-16, evening)

`main.js` `viewFor(boxes)`: if any box is lower than 90 % of the part and every box is ≤ 3 mm thin
in X (or Y), the preview uses the raised side view (`hi-right` / `hi-front`) instead of top-down —
openings in a wall cannot be seen from above. Used for the enclosure base divider openings (the user:
"looks nice"). Showing pointers also turns an active diff off (it would paint over the boxes).
