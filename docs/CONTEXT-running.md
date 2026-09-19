# Running the app — context

Last updated: 2026-09-17. Part of [G-code Studio](../CONTEXT.md). Start, stop, reload, ports, the app window.

> **Claude: never start the `.bat` / `npm start`, restart the server, relaunch the app window, or run
> headless-browser scripts (`scripts/screenshot.mjs`) unless the user asks.** Refresh with
> `node gcode-studio/server/app-cli.js reload` (Claude keeps running; a server restart ends the in-app
> Claude session). Server code changes (routes, Finalize, job discovery) only take effect after a restart —
> say so and let the user choose when.

## Commands

```
run-gcode-studio.bat          double-click. starts the server if none is running, then opens ONE app window
run-gcode-studio.bat --force  clean restart: closes the old server and window, rebuilds, starts fresh
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

## Closing the window does not stop the server (2026-09-19)

The X on the app window closes **the window**. The server stays up, on purpose: Claude runs in a PTY
inside it, and killing the server would end whatever session the user was in the middle of.

So **running the launcher again does not restart anything** — it finds the healthy server and opens a
new window onto it, which is instant and keeps the Claude conversation. *(User, 2026-09-19: "when i
close app frm the x in window the servr is still running and the bat open dose not restart it." Now
confirmed working: window back, chat still there.)*

| To | Do |
|---|---|
| Get the window back | `run-gcode-studio.bat` — reuses the running server |
| Restart properly (server code changed) | `run-gcode-studio.bat --force`, or `stop-gcode-studio.bat` then the `.bat` |
| Stop everything | `stop-gcode-studio.bat` |

`dev.js` decides by asking `http://127.0.0.1:5174/` — the page, not an `/api/*` route, because every
API route needs the per-start token and a launcher has no business reading it.

**Why the old launcher appeared to do nothing at all.** It ran
`cmd /c node scripts/dev.js --built > .server.log`, and `>` takes an **exclusive** handle on the log.
With an older hidden instance still alive — exactly what closing the window leaves behind — the next
launch died on that redirect *before node ever ran*: no window, no error, nothing. Measured: a second
`cmd` redirect to the same file returns "The process cannot access the file because it is being used
by another process", and `openSync('.server.log','a')` against a running old-style instance is `EBUSY`.
The launcher no longer redirects; `dev.js` opens the log itself (`teeToLog`), synchronously, because a
stream's buffer is discarded by the `process.exit` on the reuse path.

**A real start still closes the previous instance first** (`scripts/close-previous.ps1`): the old app
window, and whatever still holds ports 5173/5174. The app window runs in its **own browser
profile** (`.app-profile\`), so it is a separate process and closing it can never take your
normal Edge tabs with it. Windows opened before that profile existed are closed by exact title
("G-code Studio") with a normal window close, not a kill.

The server still dies with the process that started it (B2), so if the app says it cannot reach the
server, run the `.bat` again — that is now the cheap, non-destructive thing to do (the user does this;
Claude only when asked).

**Claude: never start the .bat / npm start, relaunch the app window, or run headless-browser scripts (scripts/screenshot.mjs) unless the user asks; refresh with `node gcode-studio/server/app-cli.js reload`.**

> Serving the project root directly does not work in a browser: the sources use a bare
> `import 'three'` specifier that only Vite resolves. Root serving is a dev convenience, not a
> supported mode.

## No console window (2026-09-17, user: "hide the G-code Studio server terminal on every launch")

`run-gcode-studio.bat` starts `node scripts/dev.js --built` hidden, with its output in
`gcode-studio\.server.log` (a dotfile, never served). There is no window to close any more:
**`stop-gcode-studio.bat`** runs `scripts\close-previous.ps1` (app window + whatever holds ports 5173/5174),
which also ends the Claude session inside the app.

Since 2026-09-19 the `.bat` hands off to **`scripts\launch.ps1`** rather than building the command inline,
and that script does **not** redirect the output — see the section above for why that redirect was the whole
problem. A `--force` argument is passed straight through to `dev.js`.
