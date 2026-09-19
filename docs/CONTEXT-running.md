# Running the app — context

Last updated: 2026-09-17. Part of [G-code Studio](../CONTEXT.md). Start, stop, reload, ports, the app window.

> **Claude: never start the `.bat` / `npm start`, restart the server, relaunch the app window, or run
> headless-browser scripts (`scripts/screenshot.mjs`) unless the user asks.** Refresh with
> `node gcode-studio/server/app-cli.js reload` (Claude keeps running; a server restart ends the in-app
> Claude session). Server code changes (routes, Finalize, job discovery) only take effect after a restart —
> say so and let the user choose when.

## Commands

```
run-gcode-studio.bat          double-click. builds, starts the server (hidden, log in .server.log), opens ONE app window
stop-gcode-studio.bat         closes the app window and the server (ends the in-app Claude session)
npm start                     the same from a terminal (built mode, no hot reload)
npm run dev                   Vite dev mode with hot reload, for editing the code
npm run api                   API server only, on 5174
npm run build                 production bundle into dist\
npm test                      unit tests (server files clash in parallel, B13; use node test/server-all.js)
npm run check                 integration, real file, arcs, area select, compare, compare render

node server/thumbnail-cli.js "<path>"      add a printer-screen preview (new version)
```

Two ways it serves, and the difference matters:

| | Port | Hot reload | Use when |
|---|---|---|---|
| **Vite dev** | 5173 | yes | editing the code |
| **Built** (`npm run build`, served by the API server) | 5174 | no | actually using the app |

The API server serves `dist\` when it exists and the project root otherwise — **it decides at
startup**, so build *before* starting it, or restart it after building (Claude: only when the user asks). `npm start` does both.

**Every start closes the previous instance first** (`scripts/close-previous.ps1`): the old app
window, and whatever still holds ports 5173/5174. The app window runs in its **own browser
profile** (`.app-profile\`), so it is a separate process and closing it can never take your
normal Edge tabs with it. Windows opened before that profile existed are closed by exact title
("G-code Studio") with a normal window close, not a kill.

The server lives only as long as the process that started it. If the app says it cannot reach the
server, run the `.bat` again (the user does this; Claude only when asked).

**Claude: never start the .bat / npm start, relaunch the app window, or run headless-browser scripts (scripts/screenshot.mjs) unless the user asks; refresh with `node gcode-studio/server/app-cli.js reload`.**

> Serving the project root directly does not work in a browser: the sources use a bare
> `import 'three'` specifier that only Vite resolves. Root serving is a dev convenience, not a
> supported mode.

## No console window (2026-09-17, user: "hide the G-code Studio server terminal on every launch")

`run-gcode-studio.bat` starts `node scripts/dev.js --built` through PowerShell `Start-Process -WindowStyle Hidden`,
with its output in `gcode-studio\.server.log` (a dotfile, never served). There is no window to close any more:
**`stop-gcode-studio.bat`** runs `scripts\close-previous.ps1` (app window + whatever holds ports 5173/5174),
which also ends the Claude session inside the app. Starting again (`run-gcode-studio.bat`) still closes the old
instance first. The old launcher is kept in `backup\2026-09-17-before-diff-look\run-gcode-studio.bat`.
Not tested yet: the first real launch will show it (Claude must not launch it unasked).
