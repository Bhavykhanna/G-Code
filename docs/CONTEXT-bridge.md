# Claude bridge context

Owns `bridge/` and `src/bridge/`. Part of [G-code Studio](../CONTEXT.md).

How the app and Claude talk. This is the reason the project exists — everything else is in
service of getting a precise region of a print in front of Claude and an answer back.

## The mechanism

Claude Code runs **inside the app** (a PTY, [CONTEXT-terminal.md](CONTEXT-terminal.md)). The app
hands it context in two ways: `bridge/selection.json` (the current 3D selection, always up to
date) and `bridge/attached/` (a selection, area or move the user attaches; the app types a
one-line reference into Claude's prompt). There is no API key and no outbound network call. The
old file mailbox (`chat.jsonl`) is **legacy** — the panel was removed 2026-09-16 and nothing in
the app uses it.

```
app  --POST /api/bridge/selection-->  bridge/selection.json  <--reads--  Claude
app  --POST /api/bridge/attach-->  bridge/attached/<id>.json|.png  --typed reference-->  Claude (in-app terminal)
```

Claude here is the real thing: its full toolset and the whole project context, able to read the
G-code, edit it, re-slice it and write a new version.

## `bridge/selection.json`

Written by the app whenever the user selects a region in 3D. One selection at a time; it is
overwritten, and the interesting history lives in the chat log instead.

```json
{
  "id": "sel-1726500000000",
  "file": "phonecase-17pro/EN4Max_0.4_Iphone17Pro_HexCover_HSPLA+_0.20_v1-ironed_49m.gcode",
  "createdAt": "2026-09-16T12:34:56.000Z",
  "lineRanges": [[97231, 97894], [98120, 98455]],
  "mode": "area",
  "area": { "rect": { "...": "CSS px of the drag" }, "bounds": { "min": [0, 0, 0], "max": [0, 0, 0] }, "crossingNotSelected": 0 },
  "summary": {
    "count": 812,
    "layers": [34, 41],
    "xRange": [120.4, 188.9],
    "yRange": [150.2, 276.0],
    "zRange": [6.88, 8.28],
    "features": {
      "Outer wall": { "count": 640, "lengthMm": 3310.2, "timeSec": 71.5 },
      "Inner wall": { "count": 172, "lengthMm": 900.3, "timeSec": 24.9 }
    },
    "lengthMm": 4210.5,
    "timeSec": 96.4,
    "filamentMm": 210.8,
    "speed": { "min": 49.0, "max": 180.0, "avg": 121.3 },
    "width": { "min": 0.5, "max": 0.5, "avg": 0.5 },
    "fan":   { "min": 0.0,  "max": 0.35, "avg": 0.28 },
    "flow":  { "min": 0.0,  "max": 0.0,  "avg": 0.0 }
  }
}
```

`mode` is `box`, `area` or `layers`; `area` is present only when the selection has a rectangle or
bounds.

`lineRanges` are **0-based, inclusive, source line numbers**, and they are the important part:
they are what an edit actually operates on. `segments` (move indices) stay in the app — they are
meaningless outside the parse of that exact file.

**A selection is only valid for the file it names.** Once a new version is written the line
numbers have moved, so the app clears the selection on file change rather than silently pointing
at the wrong lines. That clear is **in memory only**: `bridge/selection.json` on disk is not
cleared, so check its `file` against the file you are working on.

## `bridge/chat.jsonl` (legacy)

Kept for reference; the app no longer reads or writes it.

Append-only, one JSON object per line. Append-only because two processes write to it: the server
(user messages) and Claude from a terminal (replies). Never rewrite the whole file.

```json
{"id":"msg-1726500000000-a1","ts":"2026-09-16T12:34:56.000Z","role":"user","text":"why is the closing rim so slow here?","selectionId":"sel-1726500000000","status":"pending"}
{"id":"msg-1726500000042-b2","ts":"2026-09-16T12:35:10.000Z","role":"claude","text":"Those 41 layers are all short...","replyTo":"msg-1726500000000-a1","actions":[{"kind":"edit","label":"Raise slow_down_layer_time to 15s","detail":"..."}]}
```

| Field | Meaning |
|---|---|
| `role` | `user` or `claude` |
| `selectionId` | the selection this message is about, or `null` |
| `status` | on user messages: stored as `pending`; the API reports `answered` when a claude message has `replyTo` = its id |
| `actions` | on Claude replies: buttons the UI offers, `kind` of `edit` / `slice` / `info` |

Readers skip malformed lines rather than throwing — a half-written line from the other writer
must never take the endpoint down.

## How Claude used to work this from the terminal (legacy)

```bash
node server/chat-cli.js pending          # unanswered messages, with their selection inlined
node server/chat-cli.js reply "<text>"   # append a reply
```

The CLI touches `bridge/chat.jsonl` directly with the same append discipline, so it works whether
or not the HTTP server is running. Server routes are documented in
[CONTEXT-server.md](CONTEXT-server.md).

## What Claude does with a selection

The selection says *which moves*; the answer usually depends on *which lane* the request is in
(see [the hard boundary](../CONTEXT.md#the-one-hard-boundary)):

| The user asks | Lane | What actually happens |
|---|---|---|
| "slow this down" | A | `scaleSpeed` on those line ranges, diff, validate, new version |
| "less fan here" | A | `setFan` over the layer range |
| "stop it blobbing" | A | `scaleFlow`, hard-capped at ±20 % |
| "make this wall thicker" | **B** | `wall_loops` or line width in `process.json`, re-slice (2.2 s) |
| "widen the gaps in the pattern" | **neither** | that geometry is in the STL — a CAD change, not a slicer one |

The last row matters: some requests have no answer in this tool at all, and saying so is the
correct response.

## `bridge/attached/`

The second, faster path: Claude Code runs **inside the app** (a PTY, see
[CONTEXT-terminal.md](CONTEXT-terminal.md)) and the app *attaches* a selection, area or move to its
prompt. The bulky part goes to disk; the app types a one-line reference naming the files.

`POST /api/bridge/attach` `{ kind, id, file, data, png? }` → `{ ok, id, json, png }`

| Rule | Why |
|---|---|
| `kind` ∈ `selection` `area` `move`, else 400 | |
| `id` matches `/^[a-z]+-[0-9a-z-]{1,60}$/i`, else 400 | it becomes a filename — no `.`, `/`, `\` possible |
| `data` any JSON object, ≤ 2 MB serialised (413) → `<id>.json` | written verbatim (pretty-printed) |
| `png` optional `data:image/png;base64,…`, ≤ 6 MB decoded (413), must start with the PNG signature (400) → `<id>.png` | a screenshot of the view Claude can open |
| re-attaching an id without `png` deletes its old `<id>.png` | the response and the disk must agree |
| temp file + rename for both | Claude may read while the app writes |
| keeps the newest **40 ids** (by mtime), deletes the rest; the id just written is always kept | bounded disk use, no cleanup job |
| `json` / `png` in the answer are **Archive-relative, forward slashes** (`gcode-studio/bridge/attached/sel-123.json`), `png: null` when none | Claude's cwd is the Archive root, so it can open them as typed |

Unlike `chat.jsonl` this is not a mailbox: nothing waits for an answer. The user writes the
message after the reference and presses Enter in the terminal.

## Access

Every `/api` call needs the server's token (`X-GCS-Token` header or `?token=`) since BUGS B9 was
fixed — see [CONTEXT-server.md](CONTEXT-server.md). `server/chat-cli.js` touches the files directly
and needs no token. A Claude session started **by the app** gets `GCS_API` and `GCS_TOKEN` in its
environment, so it can call the API with
`curl -H "X-GCS-Token: $GCS_TOKEN" $GCS_API/api/health`; any other session reads
`gcode-studio/.gcs-token`.

## Files

| File | Role |
|---|---|
| `bridge/selection.json` | current 3D selection |
| `bridge/chat.jsonl` | legacy mailbox transcript (unused by the app) |
| `bridge/requests.jsonl` | append-only log; today only `index.html`'s startup-error report writes it |
| `bridge/attached/<id>.json` / `.png` | attachments typed into the in-app Claude's prompt (newest 40) |
| `src/bridge/client.js` | the frontend's fetch layer (the only other call is `index.html`'s startup-error report) |
| `server/api/bridge.js` | the routes |
| `server/chat-cli.js` | legacy mailbox CLI |
| `server/app-cli.js` | Claude → app: open / base / finalize / show / reload |

---

## Update 2026-09-16

- `summary.features` is now `{ "<feature>": { count, lengthMm, timeSec } }` (was `{ "<feature>": count }`).
  Readers accept both.
- ~~The app shows Claude's replies live~~ — moot: the mailbox panel was removed 2026-09-16.
- Lane B requests from the rail are typed into Claude's prompt as
  `[G-code Studio · re-slice request · <label> for <selection> · <file> · geometric, needs the slicer] `
  (no Enter).
- ~~Replies are manual unless Claude's session is polling~~ — moot (legacy — removed 2026-09-16).
