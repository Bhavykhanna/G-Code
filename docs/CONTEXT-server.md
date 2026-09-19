# Server & API — context

Last updated: 2026-09-16

Owns `server/`. Node 24 built-ins plus exactly two packages, both only for the terminal: `ws` and
`node-pty` (native, loaded lazily — if it fails to load, only the terminal is down). **No express.** Everything imports
`src/parser/parse.js` unchanged; the parser is the shared truth and this part never re-implements it.

Read [`../CONTEXT.md`](../CONTEXT.md) first for the shared contract and the safety rules, and
[`..\context\`](../context/printer.md) for the printer, the profiles and the
naming convention. **Neither is restated here.**

```
server\
  index.js          HTTP, routing, access control (token/Host/Origin), static/dev, SSE, ws upgrade
  terminal.js       the shared Claude Code PTY behind /api/term (contract: CONTEXT-terminal.md)
  app-cli.js        tells the open app what to do: open / base / finalize / show / reload
  chat-cli.js       LEGACY: terminal end of the old chat mailbox (nothing in the app uses it)
  thumbnail-cli.js  add a printer-screen preview from the terminal
  thumbnail-render.js  server-side preview renderer
  api\
    files.js        path sandbox, job discovery, parse cache   <- everything else depends on this
    edit.js         Lane A ops, the LineDoc, footer maintenance
    validate.js     the safety gate
    version.js      naming convention, version bump, old\ archiving
    slice.js        ElegooSlicer CLI
    diff.js         A/B compare
    bridge.js       selection.json / requests.jsonl / chat.jsonl / attached\
    thumbnail.js    POST /api/thumbnail
```

```
node server/index.js          # API on 127.0.0.1:5174
PORT=5555 node server/index.js
node test/server-all.js       # all 6 server test files, against the real job folders
```

> Starting or restarting the server ends the in-app Claude session. Do it **only when the user
> asks**.

---

## The sandbox — the one rule that has no exceptions

`ARCHIVE_ROOT` is the folder one level above the project (`…\Archive\`), because that is where the
jobs live. **Every** client-supplied path — `/api/file`, `/api/meta`, `/api/diff`, `/api/edit`,
`/api/slice`'s profile and STL overrides — goes through `safeResolve` / `safeResolveReal` in
`files.js`. Three guards, in order:

| Guard | Catches |
|---|---|
| type / empty / NUL byte | `path=`, `path=a\0b` |
| `path.resolve` + lexical containment | `..\..\..\Windows\win.ini`, `C:\Windows\win.ini` |
| `realpath` + containment again | a symlink or junction inside the Archive pointing out of it |

**Where that root is** (`files.js:resolveArchiveRoot`, 2026-09-19). The folder above the app is the
default, not a law — it is right only while the app sits in `<archive>\gcode-studio\`. A clone
anywhere else would make the drive root the sandbox: no jobs found (they would be three levels
down) and a recursive `fs.watch` over everything on that drive. So, in order:

| # | Source | For |
|---|---|---|
| 1 | `GCS_ARCHIVE` | one run, or a launcher that sets it |
| 2 | `.gcs-archive` next to the app — one line, the path, relative to the app or absolute | a machine that keeps its jobs somewhere else. Git-ignored, so it changes nothing for anyone else |
| 3 | the folder above the app | the normal case, unchanged |

A clone with no print archive points it at `demo`, and the shipped job is a real job to open.

A path may be given Archive-relative (`phonecase-17pro/x.gcode`, what the UI uses) or absolute
inside the Archive. `/` and `\` both work. Anything else is **403**, not 404 — the distinction is
deliberate so a traversal attempt is visible in the log rather than looking like a typo.

> Query strings decode `+` as a space. Job filenames contain `HSPLA+`, so the UI **must** use
> `encodeURIComponent` (`HSPLA%2B`). Getting this wrong produces a 404 on a file that exists.

---

## Routes

All JSON except `/api/file` (text), `/api/watch` (SSE) and `/api/term` (WebSocket). Errors are
`{ error, detail? }` with a real status code.

### Access control — fixes BUGS B9

Before this, CORS was `*` and there was no auth: any web page open in any browser on this PC could
read and write through the API. With a terminal endpoint that is a shell, so:

| Check | Rule | Fails with |
|---|---|---|
| token | every `/api/*` request (and the ws upgrade) carries header `X-GCS-Token` or `?token=` (the only way `EventSource`/`WebSocket` can send it). Compared with `timingSafeEqual`. | 401 |
| Host | hostname is `localhost`, `127.0.0.1` or `[::1]` — on **every** request, static included, so DNS rebinding cannot read the token out of `index.html` | 403 |
| Origin | if present, `http://localhost[:port]` or `http://127.0.0.1[:port]` | 403 |
| CORS | **no `Access-Control-*` header anywhere**; `OPTIONS` is a bare 204, so cross-origin preflights fail | — |

Host/Origin are checked before the token, so a foreign page gets 403, not a hint about the token.

| Token detail | |
|---|---|
| value | `process.env.GCS_TOKEN` if set, else `crypto.randomBytes(24)` hex — new on every start |
| exported | `getToken()`, `checkAccess(req, url, needToken)`, `tokenFile()` from `server/index.js` |
| on disk | `gcode-studio\.gcs-token` (for the Vite dev plugin and CLI tools), written after `listen`. `GCS_TOKEN_FILE` overrides the path — the tests use it so a test run never overwrites the live app's token. |
| in the page | when this server serves `index.html` (`dist\` or the root) it inserts `<meta name="gcs-token" content="…">` straight after `<head>`, `Cache-Control: no-store`. Other origins cannot read the response, which is what keeps the token private. |
| in the terminal | the PTY child gets `GCS_TOKEN` and `GCS_API=http://127.0.0.1:<port>`, so Claude can call the API |

From a shell: `curl -H "X-GCS-Token: $(cat .gcs-token)" http://127.0.0.1:5174/api/health`.


### `GET /api/health`
`{ ok, port, projectRoot, archiveRoot, node, uptimeSec, sseClients, watching, chat:{…}, term:{…} }`

### `GET /api/jobs`
Every immediate subdirectory of the Archive root holding ≥1 `.gcode`, current or in `old\`.
Deliberately loose — a new job folder needs no registration. Skips `gcode-studio`, `__MACOSX`,
`node_modules`, `phonecase-slicing`, `3.Model` and dot-folders.

```js
{ archiveRoot, jobs: [{
  name, path, absPath,
  gcode: [{ name, path, size, mtime, archived:false,
            convention, version, model, filament, layerHeight, changed, time }],
  old:   [ …same, archived:true ],
  stl:   [{ name, path, size, mtime }],
  profiles: { machine, process, filament, allPresent },
  readme, hasOldDir,
  current            // path of the highest-version current file, or null
}] }
```

`gcode` and `old` are sorted by version then mtime. `convention:false` means the filename does not
follow the naming convention and the other name fields are `null` (`plate_1.gcode`,
`enclosure-base.gcode`). Such a file can be read and diffed but **cannot be version-bumped**.

### `GET /api/file?path=[&from=&to=]`
Raw G-code, `text/plain`, byte for byte. `from`/`to` are 0-based inclusive source lines, for
fetching just the region a selection covers instead of 3 MB.

### `GET /api/meta?path=`
The parse result **minus `segments`** — the typed arrays are ~7 MB and the browser gets them from
its own worker parse. Returns `{ path, bytes, mtime, meta, config, layers, warnings, count,
relativeE, timeScale, parseMs }`.

Cached by `path + mtime + size`, 4 entries (LRU). Measured on the 17 Pro file: **199 ms cold,
6 ms warm**. The cache is invalidated automatically when the file changes on disk, so Claude
writing a new version from the terminal is picked up with no restart.

> `layers.length` is **58** for the 57-layer 17 Pro file. `layer_change_gcode` emits `;LAYER:n` for
> the layer it is *about* to start, so there is one extra empty trailing record. Show
> `meta.layerCount` (the header's own figure) to the user; use `layers[]` for geometry.

### `GET /api/versions?job=`
`{ job, path, current, versions: [{ name, path, archived, size, mtime, convention, fields, version,
footer:{ timeText, timeSec, filamentMm, filamentCm3, filamentG, layerCount } }] }`

`footer` comes from a **128 KB tail read**, not a full parse — the stats sit just above the ~25 KB
CONFIG_BLOCK. Listing all four 16 Pro versions (3–5 MB each) costs milliseconds.

### `POST /api/edit`
See the whole section below. Body `{ path, ops[], dryRun = true, note }`.

### `POST /api/slice`
See the slicer section. Body `{ job, stl?, profiles?, commit?, note?, timeoutMs? }`. Profiles resolve in this
order: what the body names → the job folder's own `machine/process/filament.json` → **`profiles\default\`**
(the tuned default, so a new model with no profiles of its own still slices; see `profiles\README.md`).

### `GET /api/diff?a=&b=[&topLayers=]`
See the diff section.

### App control and drafts
| Route | Shape |
|---|---|
| `GET /api/base?path=` | `{ path, base }` — see *Drafts* |
| `POST /api/finalize` | `{path, note}` → `{ ok, path, name, moved[] }`; broadcasts `gcode` |
| `POST /api/app/open` | `{path, diff?: true\|<path>}` → `{ ok, path, diff, windows }`; broadcasts `open` |
| `POST /api/app/highlight` | `{path?, regions:[{x,y?,z?,layers?,label,move?,toX?,toY?}], clear?, select?}` (≤20 regions) → `{ ok, path, regions, select, windows }`; broadcasts `highlight` |
| `POST /api/app/reload` | `{}` → `{ ok, windows }`; broadcasts `reload` (the app calls `location.reload()`, Claude keeps running). Only on a server started after it was added (2026-09-16 late); restarting the server ends the in-app Claude session — ask the user first. |
| `POST /api/thumbnail` | `{path, png?, dryRun = true}` — see [CONTEXT-thumbnail.md](CONTEXT-thumbnail.md) |

### Bridge
| Route | Shape |
|---|---|
| `GET /api/bridge/selection` | `{ selection }` or `{ selection: null }` |
| `POST /api/bridge/selection` | body is the selection (or `{selection}`); writes temp+rename; returns `{ ok, selection }` |
| `POST /api/bridge/request` | appends to `requests.jsonl`; returns `{ ok, request }` |
| `POST /api/bridge/attach` | `{kind, id, file, data, png?}` → `{ ok, id, json, png }` — see [CONTEXT-bridge.md](CONTEXT-bridge.md). Body limit 12 MB (the others 8 MB). |
| `GET /api/bridge/requests[?limit=]` | `{ requests, total, skipped }` |
| `GET /api/bridge/chat[?since=&limit=]` | `{ messages, total, skipped, since?, sinceUnknown? }` |
| `POST /api/bridge/chat` | `{text, selectionId?}` → `{ ok, message }` |
| `POST /api/bridge/chat/reply` | `{text, replyTo?, actions?}` → `{ ok, message }` |
| `GET /api/bridge/chat/pending` | `{ pending, count, currentSelection, chatFile, skipped }` |

### Terminal
| Route | Shape |
|---|---|
| `GET /api/term?token=` | WebSocket, JSON frames — protocol in [CONTEXT-terminal.md §2](CONTEXT-terminal.md). A plain GET is 426. |
| `GET /api/term/state` | `{ running, pid, mode, startedAt (ms), exitCode, cmd, cwd, cols, rows, clients, error? }` |

`/api/health` also carries `term` (the same state).

### `GET /api/watch` — SSE
`text/event-stream`, `retry: 2000`, keepalive `ping` every 20 s.

| Event | Data | When |
|---|---|---|
| `hello` | `{archiveRoot, projectRoot, port, ts}` | on connect |
| `gcode` | `{path, name, job, archived, event, exists, size, mtime}` | any `.gcode` under the Archive is written/renamed/removed. Sent by edit/finalize/thumbnail writes it carries only `{path, name, event:'written', exists:true}` |
| `open` | `{path, diff}` | `POST /api/app/open` |
| `highlight` | `{path, regions, select}` | `POST /api/app/highlight` |
| `reload` | `{}` | `POST /api/app/reload` |
| `chat` | `{messages:[…]}` | a chat message is appended, **by anyone** (legacy — the app no longer listens) |
| `selection` | `{id, file}` from the route, `{path:'bridge/selection.json'}` from the watcher | `selection.json` written |
| `ping` | timestamp | every 20 s |

One recursive `fs.watch` on the Archive root, debounced 300 ms per path, filtering out
`gcode-studio/`, `node_modules/` and our own `*.tmp-<pid>-<ts>` files. New job folders are picked up
without a restart. **Verified**: writing a `.gcode` into a new folder pushes `event: gcode` naming
the file.

### Static / dev
Non-`/api` GETs are served from `dist\` if it exists, else from the project root (so `index.html`,
`src\`, `node_modules\three\` all resolve and the app runs from one process with no Vite). Static
serving has its own containment check against the project root, and refuses (403) any path segment
starting with `.` — `.gcs-token`, `.app-profile\`, `.git\`. `index.html` gets the token meta tag
(above). Anything not found returns a JSON
404 explaining where the API is — it does not fall back to `index.html`, because a SPA router is not
this part's problem.

---

## Lane A edits — `server/api/edit.js`

### The line document

Edits operate on **source lines**. `LineDoc` splits on `'\n'` and joins on `'\n'`, so a CRLF file
keeps its `'\r'` on every untouched line for free, and every byte that is not part of an edit is
identical. Insertions live in `before`/`after` side tables keyed by the **original** line number, so
line numbers stay stable for the whole request and op #2 can still use the indices the parser
produced for op #1's file. Nothing is ever reformatted or re-serialised.

**Measured**: a `scaleSpeed 0.8x` over layer 20 of the 17 Pro file (source lines 97235–97840,
499 moves) changes 500 lines out of 124,723, and *every changed line differs only in its `F`
parameter*.

### Targeting

Each op carries one of:

- `lineRanges: [[from, to], …]` — 0-based, inclusive, the form a 3D box-select produces. Overlapping
  ranges are merged; membership is a binary search.
- `filter: { layers:[lo,hi], features:[…], kinds:[…] }` — `features` are `FEATURE_NAMES` strings,
  case-insensitive; an unknown one is a 400 listing the valid names. `features` implies extruding
  moves only.

No target at all is a 400. `insertPause` is the one op that takes neither.

### Per-move ops vs state ops — **this matters**

| | ops | how |
|---|---|---|
| **per-move** | `setSpeed` `scaleSpeed` `scaleFlow` | rewrite the parameter on each matching move's own line |
| **state** | `setFan` `scaleFan` `setTemp` `setAccel` `setZOffset` | apply across the **span** (first matched line … last matched line) and restore after |

`F`, `M106`, `M104`, `SET_VELOCITY_LIMIT` and `Z` are all *sticky* machine state in this dialect, so
a change leaks forward until something changes it back.

- Per-move ops handle that by putting the **previous** value back on the first move after each
  contiguous run. The layer-20 test shows exactly one line outside the region changing — line 97848,
  `G1 X249.13 Y165.183 Z4.31571` → `… F30000`, the feedrate restore.
- State ops cannot do that per-move without emitting thousands of `M106` lines, so they cover the
  whole span. The response reports `coverage` (matched moves ÷ moves in the span); below 0.98 the op
  also returns a note saying so. **A sparse selection with a state op will affect moves you did not
  select.** Show `coverage` in the UI.

### The ops

| op | params | behaviour |
|---|---|---|
| `setSpeed` | `mm_s` | `F = mm_s*60`, rounded. Refuses ≤0 or >500 mm/s (`machine_max_speed_x`). |
| `scaleSpeed` | `factor` | `F *= factor`. Refuses ≤0 or >10. |
| `setFan` | `percent` 0–100 | inserts `M106 S<0-255>` (`M107` at 0) at the span start, **rewrites every `M106`/`M107` inside the span**, restores the following value after. |
| `scaleFan` | `factor` | same, multiplying each existing value. |
| `setTemp` | `celsius` | `M104 S` at the span start, rewrites interior `M104`/`M109`, restores the previous value after. Refuses outside 170–300 °C. |
| `scaleFlow` | `factor` | multiplies `E` on **extruding moves only** — never a retract, prime or wipe. **Hard cap 0.80–1.20**; outside that it is a 422 naming safety rule 4, with no override. Refuses outright unless `relativeE`. |
| `setAccel` | `mm_s2` | rewrites `SET_VELOCITY_LIMIT ACCEL=` (this printer is Klipper — the 17 Pro file has 318 of them and zero `M204`); `M204 S` is handled too. Inserts at the span start, restores after. Refuses >20000. |
| `deleteRegion` | — | removes matching **extruding** moves, then any stranded zero-E travels and the now-empty `;TYPE:`/`;WIDTH:`/`;HEIGHT:` headers of fully-deleted blocks. |
| `insertPause` | `atLayer`, `mode` | inserts before that layer's `;LAYER:` line. `mode:'M600'` (default) or `'park'`. |
| `setZOffset` | `mm` | ensures the span's first move carries `Z+offset`, shifts every Z-carrying move inside the span, restores the true absolute Z on the first move after. Refuses beyond ±5 mm. |

Ops are applied **in order** against the *original* parse. Two ops touching the same line: the later
one wins on that line. Up to 64 ops per request.

**Why `deleteRegion` is safe.** XYZ are absolute (`G90`) through the whole print body, so the next
surviving move simply travels to its own coordinates — position is coherent for free, no
recalculation. E is `M83` relative, so removed extrusions do not cascade. Retracts, primes and
wipe-retracts (`G1 X… Y… E-0.144` inside `;WIPE_START`) are **never** deleted, which is what keeps
the extruder balanced; the validator enforces that independently by comparing retract/prime counts
before and after.

**Why `insertPause` defaults to `M600`.** `machine.json` sets `change_filament_gcode = M600`, so
the firmware owns the park, retract and resume and nothing here can unbalance the extruder.
`mode:'park'` emits an explicit Klipper sequence — it assumes a `PAUSE`/`RESUME` macro exists on
the printer, and it emits the retract and the matching prime as a pair so the counts still balance.

### Footer maintenance

A Lane A edit changes how long the print takes and how much filament it uses, but the slicer's
footer still says the old numbers — and the printer's screen reads that footer. So the written file
gets:

```
; filament used [mm] / [cm3] / [g] / total filament used [g]    recomputed from the edited E values
; total layers count                                            recomputed
; estimated printing time (normal mode)                         PREDICTED
; gcode-studio: edited <ISO>  /  source = …  /  note = …  /  ops = …
```

**Time is predicted, not measured, and the UI must say so** (`preview.timeIsPredicted` is always
`true`). The parser's trapezoidal model ignores jerk and lookahead, so its absolute total is wrong —
`parseGcode` rescales it against the slicer's own estimate. The *ratio* of the two raw model totals
is meaningful even though the model is not, so:

```
newSec = originalFooterSec × rawModelTotal(edited) / rawModelTotal(original)
```

Measured: `scaleSpeed 0.8x` over layer 20 → 49m 15s → **49m 17s** (+0.1 %). That is a real result —
layer 20 is 6 s of a 49-minute print — not a bug.

Order of operations, deliberately: apply ops → parse → predict → **write the footer** → parse again →
**validate the exact bytes that would land on disk**. Two full parses per edit request (~250 ms on
the 17 Pro file). Worth it: the validator never approves something other than what gets written.

### Response

```js
{
  ok,                       // === validation.ok
  dryRun, written, file,
  preview: {
    ops: [{ op, matched, spanLines:[from,to], coverage, notes:[…] }],
    before: { timeSec, timeText, filamentMm, filamentCm3, filamentG, layers, moves, maxZ },
    after:  { …same },
    delta:  { timeSec, timePct, filamentMm, filamentG, moves },
    bytes:  { before, after },
    timeIsPredicted: true
  },
  validation: { ok, errors:[…], warnings:[…], stats:{…}, limits:{…} },
  diff: { changedLines, insertedLines, deletedLines,
          entries:[{ line, kind:'change'|'insert'|'delete', before, after }], truncated },
  outPath,                  // where it WOULD land, per the naming convention
  planError,                // set instead when the current filename is off-convention
  commit                    // only when written
}
```

`diff.entries` is capped at **400**; `truncated` says whether more exist. `dryRun` defaults to
`true` — omitting it writes nothing. A real write additionally requires a non-empty `note`, because
the note becomes the `<what-changed>` field of the filename.

HTTP status is **200** when validation passed and **422** when it did not (the body is the same
shape either way, so the UI can render the errors). A non-dry-run with failing validation is a 422
and **writes nothing**.

---

## The validator — `server/api/validate.js`

`validate(text, { parsed?, original?, ops? })` → `{ ok, errors, warnings, stats, limits }`.
`ok === errors.length === 0`. **A failed validation blocks the write. There is no override flag and
there should never be one.**

It **re-parses the edited text** rather than trusting `edit.js`. That is the point: a bug in the edit
code surfaces here as a geometry or state error. It also runs standalone on any file — every
`/api/slice` result is validated before it is offered.

Limits come from the file's own CONFIG_BLOCK where possible (`bed_shape`, `printable_height`,
`nozzle_temperature_range_*`, `filament_max_volumetric_speed`, `machine_max_speed_x`) and fall back
to 426 × 426 / Z 480 / 170–300 °C / bed 0–110 / 500 mm/s / 20 mm³/s.

### Errors (block the write)

| code | check |
|---|---|
| `ABSOLUTE_E` | no `M83`. Safety rule 5 — in absolute-E files one E edit invalidates every later E. |
| `NO_MOVES` | the file contains no motion |
| `OUT_OF_BOUNDS` | any move endpoint outside the bed or Z envelope, or not a number. Reports the first offender and the bounding box. |
| `Z_DROP_IN_LAYER` | an **extruding** move drops >0.011 mm below the Z the layer started laying at |
| `Z_REGRESSION` | a layer's first extruding Z is below the previous layer's |
| `E_NAN` | a non-numeric E |
| `E_TOO_FAT` | a move deposits >5 mm³/mm — more than a 0.4 mm nozzle can lay |
| `E_TOO_LARGE` | a single move in the print body extrudes >25 mm |
| `RETRACT_RUNAWAY` | the extruder ends up >15 mm retracted at some point |
| `NOZZLE_TEMP_HIGH` / `NOZZLE_TEMP_LOW` / `NOZZLE_TEMP_NEGATIVE` / `NO_NOZZLE_TEMP` | temperature commands |
| `BED_TEMP` | `M140`/`M190` outside 0–110 |
| `BAD_FEEDRATE` | `F` ≤ 0 or above the machine limit |
| `DANGLING_FEATURE` | a `;TYPE:` block with no extrusion — **error only if the count increased** vs the source file, warning otherwise |
| `END_SEQUENCE` | a shutdown marker the **source file** had is missing after the edit; standalone, the file does not turn the hotend or the steppers off at all (see below) |
| `FILAMENT_IMPLAUSIBLE` | total filament changed >30 % — that is a re-slice, not an edit |
| `RETRACT_UNBALANCED` | retract/prime **move counts** differ from the source file |
| `FLOW_CAP` | any move's E scaled outside 0.80–1.20× vs the source file — an independent second line of defence behind the op-level cap |

### Warnings (do not block)

`FLOW_RATE_HIGH` (peak volumetric >125 % of `filament_max_volumetric_speed`; the time model is
approximate so this is a hint), `PRIME_EXCESS`, `NO_CONFIG_BLOCK`, `FILAMENT_CHANGED` (>5 %),
`LAYER_COUNT_CHANGED`, `MAX_Z_CHANGED`, `DANGLING_FEATURE` when unchanged.

### Three things worth knowing about how these are phrased

- **Z-hops mean "Z never decreases" is literally false.** A hop lifts and comes back down inside a
  layer. So the rule is applied to *extruding* moves only, against the Z the layer started at.
- **The start G-code legitimately breaks two rules.** `M104 S140` (preheat) is below 170 °C and the
  purge line lays `E30` in one move. Both checks therefore skip everything before `layers[0]` — the
  nozzle-temp floor only applies after the first layer marker, and the single-move E cap only in the
  print body.
- **Differential checks need `original`.** Run standalone (e.g. on a slice result) the validator
  still does every envelope, geometry and state check, but cannot compare counts or flow ratios.
- **The end sequence is the file's own, not this printer's** (2026-09-19, B15). An edit must keep every
  shutdown marker that was in the source file's executable tail — pass `originalText` as well as
  `original` for that, which `edit.js` does. It is exactly as strict for this machine (its five markers
  are all there, so all five are required) and correct for a file from any other. Standalone, with no
  source to compare against, the file only has to turn the heaters and the steppers off, in any dialect
  `END_MARKERS` knows (`M104 S0` / `M109 S0` / `TURN_OFF_HEATERS`, `M84` / `M18`, …); no bed-off is a
  warning. `stats.endMarkers` lists what was found.
  **The tail is cut at `; CONFIG_BLOCK_START` first** — the settings dump quotes `machine_end_gcode`
  verbatim, so before that a file whose real ending had been deleted still passed.
  Pinned by `test/check-validate.js` (in `npm run check`): synthetic files in two dialects, every
  marker dropped one at a time, the gutted-but-quoted file, and the feedrate fallback.

`stats` carries `moves, extrudeMoves, layers, depositedMm, depositedG, maxZ, minZ, bbox, retracts,
primes, retractStateRange, maxMm3PerMm, maxFlowMm3s, maxFeedMmMin, endMarkers`, plus `original`,
`filamentDeltaPct` and `worstFlowRatio` in differential mode. Show these; they are the numbers that
explain a rejection.

---

## Versioning — `server/api/version.js`

The convention is defined in `..\context\versions.md` and that file is authoritative.

```
EN4Max_0.4_<model>_<filament>_<layerheight>_v<n>-<what-changed>_<time>.gcode
```

**Parsing.** The model may itself contain underscores (`Iphone17Pro_HexCover`), so the name is
parsed from both ends: `^(printer)_(nozzle)_` … `_v(\d+)-(changed)_(time)\.gcode$`, and the middle
is split by the two fields with a recognisable shape — the layer height is the last `_`-segment that
looks like `\d+\.\d+`, the filament is the one before it, the rest is the model. `parseJobFilename`
returns `{ ok:false }` for anything else, which is a normal outcome (`plate_1.gcode`).

**Bumping.** `v<n+1>`, where `n` is the highest version (current or archived) of the same model,
filament and layer height. The new file is always `…_v<n+1>-draft.gcode` (see *Drafts*).

**`<what-changed>`** is the request's `note`, kebab-cased, lowercase, `[a-z0-9-]` only, ≤40 chars.
`"slow layer 20"` → `slow-layer-20`.

**`<time>`** is `formatTimeField(sec)`: `49m`, `57m`, `1h11m` — minutes **floored**, no seconds, no
space, matching the files on disk (49m 15s → `49m`). It comes from the edited file's own footer,
which `edit.js` has already rewritten with the predicted time.

**Writing** (always a draft): the pre-edit text is saved as a step in `old\v<N>-steps\`, then the
draft is written to `<draft>.tmp-<pid>-<ts>` and renamed into place. Creating a draft whose name
already exists is a 409. **Finalizing**: the draft is renamed to `…_vN-<note>_<time>.gcode` (409 if
that exists), then older finals of the same model and filament are renamed into `old\`; one whose
name already exists in `old\` is left where it is, visible. Nothing is ever overwritten or deleted.
(The old "write new, then move the current file into `old\`" path is legacy — removed 2026-09-16.)

### Drafts (since 2026-09-16 — this replaced "one version per edit")

**Since 2026-09-17 Finalize also centres the part** (`api/centre.js`, before the rename): the pre-centring
text becomes a step, the shift goes to `old\v<N>-steps\align.json` (see CONTEXT-compare.md), and the
response carries `centred: {dx, dy, note, step}`. `server/centre-cli.js` does the same for older finals
(dry run by default, `--apply` writes).

The user wants one working file per version, with every step kept. Drafts are grouped by
**model, filament and layer height** (one open draft per group; the version number counts within
the group):

| Action | Result |
|---|---|
| edit a **final** vN | writes `..._v<N+1>-draft.gcode` next to it; vN stays (it is still the file to print); vN's text is saved as `old\v<N+1>-steps\00-from-<vN name>` |
| edit the **draft** | the draft's current text is saved as `old\v<N+1>-steps\NN-<note>.gcode`, then the draft is overwritten |
| edit a final that already has a draft | **409** — edit the draft or finalize it |
| `POST /api/finalize {path, note}` | draft → `..._v<N+1>-<note>_<time>.gcode`; older finals of the same model move to `old\`; steps are kept |
| `GET /api/base?path=` | the final a file is compared with: highest final below its version, same model and filament, job folder before `old\`. `null` outside the convention |
| `POST /api/app/open {path, diff}` | broadcasts SSE `open`; the app opens the file (and the diff: `diff:true` = its base, or a path) |

`server/app-cli.js` wraps these for Claude in the terminal, five commands:

```
open <file> [--diff [<base>]]
base <file>
finalize <draft> "<what changed>"
show <file> --x A:B [--y A:B] [--z A:B] [--layers A:B] --label … [--move DX[,DY]] [--to A:B] [--to-y A:B] [--no-select]
show --clear
reload
```

Thumbnails go through the same path, so adding a preview to a final also starts a draft.

**Verified** (`test/server-edit.js`): final v1 → v2 draft with step 00; a second edit → step
`01-fan-60` holding the pre-edit text; a second draft of v1 → 409; `/api/base` → v1; finalize →
`..._v2-slow-top-fan-60_<time>.gcode`, v1 in `old\`, steps kept; `/api/base` of the final → v1 in
`old\`; editing final v2 → v3 draft.

---

## Slicing — `server/api/slice.js`

```
elegoo-slicer.exe --load-settings "<machine.json>;<process.json>"
                  --load-filaments "<filament.json>"
                  --slice 0 --outputdir "<dir>" "<model.stl>"
```

Output always lands at `<dir>\plate_1.gcode`, whatever the model is called.

The binary is a GUI program but `spawn` + waiting for `'close'` works correctly. **Measured over
several runs: 1358 / 1670 / 2282 ms**, exit 0, and the output is **byte-identical** to the committed
`v1-ironed` file once the `; generated by … on <date>` line is ignored. Same 57 layers, 49m 15s,
15.10 g, 92,648 moves, 624 config keys.

Runs are **serialised** through an in-process queue — it is one GUI binary sharing a config
directory and two at once is asking for trouble. Default timeout 180 s, then the child is killed and
`timedOut: true` comes back.

Output goes to `os.tmpdir()\gcode-studio-slice-XXXXXX\`, **never into the job folder**: a slice is a
proposal, not a version. Pass `commit: true` with a `note` to write it through `commitVersion` as
the job's `…_v<N+1>-draft.gcode` (409 if a draft already exists next to that final; if the job's
highest current file *is* the draft, the slice goes into that draft with a step saved). Off by
default because of safety rule 3.

### Exit codes

Windows returns a negative exit code as unsigned 32-bit, so Node reports `4294967279` where the
slicer means `-17`. `signedExit()` normalises; the response carries both `exitCode` (signed) and
`rawExitCode`. **This is why a naive `if (code === -17)` never fires.**

| signed | raw | meaning | fix (returned as `hint`) |
|---|---|---|---|
| `0` | 0 | sliced | — |
| `-5` | 4294967291 | a profile could not be loaded (wrong kind of JSON, or malformed) | check that `--load-settings` got a machine profile then a process profile |
| `-17` | 4294967279 | profile not compatible with the printer | machine profile named exactly `Elegoo Neptune 4 Max 0.4 nozzle` with `"from": "system"`; process and filament need `compatible_printers: ["Elegoo Neptune 4 Max 0.4 nozzle"]` |
| `-51` | 4294967245 | incomplete profiles, "Add G92 E0 to layer_gcode" | the CLI does not resolve a profile's `inherits` parent — use the complete profiles in the job folder |

`-17` was **reproduced both ways** (a process profile whose `compatible_printers` names another
printer, and a machine profile with the wrong `name`) and both normalise to `-17` with the right
hint. `-51` is from the printing context, not re-reproduced here.

### Response

```js
{ ok, exitCode, rawExitCode, signal, ms, timedOut, cmd:[…],
  outPath, outDir, stdout, stderr, slicerLog, hint?, meaning?,
  inputs: { stl, machine, process, filament },
  meta,        // slimParse of the output: meta, config, layers, warnings, count, relativeE…
  validation,  // full validator result, standalone mode
  bytes, commit? }
```

`ok` requires exit 0 **and** a non-empty `plate_1.gcode` — a clean exit with no output gets its own
hint (usually the STL is outside the bed). `stdout`/`stderr` are truncated to the last 8 KB and are
**empty on every measured run, success or failure**: the slicer writes nothing to either.

**The real reason for a failure is in `slicerLog`.** ElegooSlicer drops a `00000.log` into its
*working directory*, not stderr, so the child is spawned with `cwd` set to the temp output dir (both
to find that log and to stop it littering the project root) and the file is read back into the
response. For the `-17` case it contains exactly:

```
Slic3r::CLI::run 2649: process not compatible with printer.
```

---

## A/B diff — `server/api/diff.js`

`GET /api/diff?a=&b=` → `{ a, b, settings, totals, layers, features }`.

**`settings`** — the CONFIG_BLOCK of each file reduced to only the keys whose values differ:
`{ changed:[{key, a, b, numeric:{a,b,delta,pct}|null}], onlyInA, onlyInB, counts }`. Values stay
verbatim strings, because that is how the block stores them (numbers, percentages and comma-joined
lists all included). `numeric` is filled in only when both sides parse as plain numbers.

This is the killer feature and it works. **v3-slowtop → v4-ironed on the real 16 Pro files: 5 of 624
keys differ, and they are exactly the five ironing settings** —

```
ironing_inset     "0"            -> "0.2"
ironing_pattern   "rectilinear"  -> "monotonic"
ironing_spacing   "0.12"         -> "0.25"
ironing_speed     "30"           -> "60"
ironing_type      "no ironing"   -> "top"
```

**`totals`** — `{ a, b, delta }` over `timeSec, timeText, filamentMm/G/cm3, depositedMm,
extrudedPathMm, travelMm, retracts, layerCount, maxZ, layerHeight, moves`, plus a human
`delta.timeText` (`"50m 4s -> 57m 13s (+7m 9s)"`).

**`layers`** — `{ rows, biggestTimeChanges }`, aligned **by layer index**, with
`zA/zB, timeA/timeB/dTime, filamentA/B/dFilament, lengthA/B, maxFanA/B` and `onlyIn:'a'|'b'|null`.
Index alignment is the only thing that means anything when the layer heights differ — then the Z
columns tell you the layers are not comparable and you should read `totals`.

**`features`** — per `FEATURE_NAMES` entry plus a synthetic `(travel & retract)` row (that is where
time hides), sorted by `|dTime|`: `timeA/timeB/dTime, lengthA/B/dLength, filamentA/B, movesA/B,
onlyIn`.

Measured on v3 → v4: `Ironing` appears `onlyIn: 'b'` with **10,079 moves, 16.55 m, 5m 5s**, and the
biggest single-layer change is **layer 8, +326 s** — layer 8 being the last layer of the flat base
and the only one with a top surface, exactly as the printing context describes. Cost: ~450 ms for
two cold 3.3 MB parses, ~10 ms when both are already in the parse cache.

Time comes from the parser's per-segment model, rescaled per file against that file's own slicer
estimate. Totals are therefore exact; the per-layer and per-feature split is a good approximation,
not a measurement. Diffing a file against itself is a 400.

---

## Bridge and chat — `server/api/bridge.js`, `server/chat-cli.js`

> **Legacy since 2026-09-16.** The app's mailbox panel was removed; Claude runs in the in-app
> terminal ([CONTEXT-terminal.md](CONTEXT-terminal.md)). The routes, `chat.jsonl` and `chat-cli.js`
> below still work, but nothing in the app calls them. The one bridge write the app still makes
> besides `selection`/`attach` is `index.html`'s startup-error report to `/api/bridge/request`.

```
bridge\selection.json   the current 3D selection, written by the app
bridge\requests.jsonl   append-only log of what the app asked for
bridge\chat.jsonl       append-only chat transcript, both directions
```

**There is no model, no API key and no outbound network call anywhere in this part.** The chat is a
file-backed mailbox: the UI appends a user message, a Claude session in a terminal reads it, does the
work, and appends a reply. The server makes the append safe and tells listeners the file moved.

### Format

```json
{"id":"msg-1726500000000-a1x","ts":"2026-09-16T12:34:56.000Z","role":"user","text":"…","selectionId":"sel-…|null","status":"pending"}
{"id":"msg-…","ts":"…","role":"claude","text":"markdown","replyTo":"msg-…","actions":[{"kind":"edit|slice|info","label":"…","detail":"…"}]}
```

One JSON object per line, UTF-8, `\n`-terminated. `text` ≤ 32 KB (413 above that); empty or
whitespace-only is a 400.

### Concurrency rules

- **Append only.** The whole file is never rewritten, so a concurrent appender can never lose a
  line. `fs.appendFile` opens with `O_APPEND`, which makes a line-sized write atomic against other
  appenders on Windows and POSIX alike.
- **One in-process serialising promise chain**, so this server never interleaves two of its own
  writes.
- **Reads skip malformed lines** instead of throwing, and report how many in `skipped`. A
  half-written line from an external writer, or a truncated file, must not take an endpoint down.
- **`answered` is derived, never stored back.** Rewriting a message's line to mark it answered would
  break the append-only rule, so a user message counts as answered when some claude message carries
  `replyTo` = its id. The stored `status` stays `"pending"` forever; the API returns the computed
  one.

**Verified**: 6 separate OS processes × 10 replies, concurrent with 30 appends from the server, in
~1.3 s → **91 lines on disk, 91 parsed, 0 broken, 91 distinct ids**. Nothing lost, nothing torn.

### Endpoints

- `GET /api/bridge/chat?since=<id>` — everything after that id. No `since` returns the last 200. An
  **unknown** `since` returns the tail with `sinceUnknown: true` rather than erroring, because the
  client may have been looking at a transcript that was moved aside.
- `POST /api/bridge/chat` `{text, selectionId?}` — server assigns `id`, `ts`, `role:"user"`,
  `status:"pending"` and returns the created message.
- `POST /api/bridge/chat/reply` `{text, replyTo?, actions?}` — appends a `role:"claude"` message.
  **`replyTo` defaults to the newest unanswered user message**, so a terminal can just post text.
  `actions` is capped at 20.
- `GET /api/bridge/chat/pending` — what Claude polls. Unanswered user messages with the referenced
  selection **inlined** from `selection.json` when `selectionId` matches, plus `currentSelection`.
  Self-contained on purpose: a terminal session can act without a second call.

Every new message is pushed on `/api/watch` as `event: chat`. `bridge\` is watched with `fs.watch`
(debounced 120 ms), so messages appended **externally** by Claude are picked up and pushed too —
that is the normal case for replies, and it is verified by the test (the app no longer listens for it).

### The CLI

```
node server/chat-cli.js pending [--json]     unanswered messages + inlined selection
node server/chat-cli.js reply "<text>" [--to <msg-id>]
node server/chat-cli.js log [n]
node server/chat-cli.js watch                print new messages as they arrive
node server/chat-cli.js stats
```

It imports `bridge.js` and therefore uses the **same** append discipline, so it works whether or not
the HTTP server is running — and works correctly when it is running and appending at the same time.
`pending` prints the selection summary (moves, layers, Z range, features, length, speed, line
ranges) so a reply can be written without opening any other file.

---

## Performance, measured

| | |
|---|---|
| 17 Pro parse (2.9 MB, 92,648 moves) | 136–199 ms cold, **5–6 ms** cached |
| `/api/diff` on two 3.3 MB files | ~450 ms cold (two parses), ~10 ms warm |
| `/api/edit` dry run (two parses + validate) | ~250–600 ms |
| `/api/versions` for 4 versions (3–5 MB each) | a few ms — tail reads, not parses |
| `/api/slice` | 1358 / 1670 / 2282 ms measured, exit 0 |
| chat: 91 concurrent appends from 7 writers | ~1.3 s, zero loss |

Parse cache: 4 entries, LRU, keyed on path + mtime + size.

---

## Limitations — be honest about these

1. **Predicted time is a model, not a measurement.** `preview.after.timeSec` and the rewritten footer
   come from the parser's trapezoidal model ratio. It ignores jerk, lookahead and Klipper's input
   shaper. Direction and rough magnitude are trustworthy; the exact seconds are not. Only a re-slice
   gives a real number. The UI must label it.
2. **State ops cover a span, not a selection.** `setFan`/`setTemp`/`setAccel`/`setZOffset` with a
   sparse selection also affect unselected moves inside the span. `coverage` tells you how bad; the
   UI should surface it. There is no per-run mode yet — it would emit thousands of `M106` lines.
3. **`insertPause` with `mode:'park'` assumes a Klipper `PAUSE`/`RESUME` macro exists.** It has not
   been tested on the printer. `M600` is the default and is backed by `machine.json`.
4. **`deleteRegion` deletes extrusions, not geometry.** A large delete will trip
   `FILAMENT_IMPLAUSIBLE` (>30 %) and be blocked — by design: removing a third of the material is a
   re-slice, not an edit.
5. **Ops compose only loosely.** They are applied in order against the *original* parse; two ops
   targeting the same lines conflict and the later one wins. The response does not detect that.
6. **G2/G3 arcs are drawn as chords** (≤0.02 mm) since 2026-09-16. Each chord keeps the arc's
   source line, so edits touch the line once. An arc with no usable centre is drawn straight and
   warned about.
7. **The sandbox applies to profile paths too**, so `/api/slice` cannot point at the system profiles
   in `%APPDATA%\ElegooSlicer\`. That is deliberate and harmless — those are the `-51` case anyway.
   A job should still carry its own complete profiles (that is what makes an old version reproducible);
   a job that has none falls back to `profiles\default\`.
8. **`fs.watch` recursive is Windows/macOS only.** On Linux the G-code hot-reload would silently do
   nothing. Not a problem here; worth knowing.
9. **The parse cache is per-process and holds 4 entries.** Diffing five files in a loop re-parses.
10. **Token auth, no rate limiting, bound to 127.0.0.1.** The token keeps out other web pages, not
    other programs running as you — anything that can read `.gcs-token` can drive the API and the
    terminal. Do not expose the port.
11. **Slices get no preview automatically.** CLI slicing writes no thumbnail; add one afterwards
    with `POST /api/thumbnail` / `server/thumbnail-cli.js`.
12. **`layers.length` is one more than the real layer count** (see `/api/meta`). Parser behaviour,
    not a server bug, but every consumer trips on it once.

---

## Tests

```
node test/server-all.js      # runs all six, sequentially -- all 6 files pass
node test/server-smoke.js    # routes, sandbox, jobs, meta, versions, bridge, chat, SSE
node test/server-edit.js     # every op, byte fidelity, the flow cap, versioning, drafts, old\
node test/server-diff.js     # v3 vs v4 and v1 vs v4 on the real 16 Pro files
node test/server-chat.js     # 7 concurrent writers, external append -> SSE, torn lines
node test/server-terminal.js # token/Host/Origin/CORS, meta tag, dot paths, attach, PTY ws
node test/server-slice.js    # a real ElegooSlicer run, reproducibility, exit -17
```

Run them **only when the user asks** — they start a test server and the slice test runs the slicer.

They run against the **real** job folders but never modify them: anything that writes copies into
its own `…\Archive\gcode-studio-scratch-{edit,slice,watch}\` first and removes it afterwards (one
per test file, so two running at once cannot delete each other's). Every server test imports
`test/_isolate.js` first, which points `GCS_BRIDGE_DIR` at `%TEMP%\gcs-test-bridge-<pid>` and
`GCS_TOKEN_FILE` at a temp file, so no test touches the live `bridge\` files or the live token.
(`server-chat.js` still moves its chat file aside, but that is now the temp one.) Each test binds port 5199 (`GCS_TEST_PORT`), which is why
`server-all.js` runs them one at a time.

The helpers (`test/server-helpers.js`) send `X-GCS-Token` from `getToken()` and point
`GCS_TOKEN_FILE` at the temp dir. `server-terminal.js` never runs real Claude: `GCS_TERM_CMD`
(a JSON array) replaces the command, and attach writes go to `bridge\attached-test-<pid>\`
(`GCS_ATTACH_DIR`, must be inside the Archive) so the real `attached\` is never pruned.

---

## Update 2026-09-16

- **`POST /api/thumbnail`** `{path, png?, dryRun = true}` → `{ok, dryRun, written, file, outPath, source, bytesAdded, commit?}`.
  Writes the preview into the job's draft (`…_v<N+1>-draft.gcode`, step saved in
  `old\v<N+1>-steps\`; the final stays), broadcasts a `gcode` event. 409 if the file already has a preview and no `png` was given. Details in
  [CONTEXT-thumbnail.md](CONTEXT-thumbnail.md).
- `server/chat-cli.js pending` prints feature counts from both the old `{name: count}` and the new
  `{name: {count, lengthMm, timeSec}}` selection shape.
- **Tests no longer pin "current" file names.** Byte-exact checks use the frozen files in `old\`;
  the job checks assert the versioning rules (one current file, newer than every archived one,
  v1–v3 still present) instead of today's counts. They were breaking every time a version was added.
- The SSE `chat` event carries `{messages: [...]}` and the file event is named `gcode` — the
  frontend client had both wrong until today (see `../BUGS.md`, fixed).

---

## Update 2026-09-16 — access control and the terminal

- **B9 fixed**: token + Host + Origin checks, CORS headers removed (section *Access control*).
  Anything that calls the API without the token now gets 401 — the frontend client, the Vite
  dev plugin and `index.html`'s startup-error report are the frontend's side of this.
  `scripts/dev.js`'s readiness probe still works (it accepts any status < 500).
- **`server/terminal.js`**: one `node-pty` PTY per server running `claude.exe` (resolved from PATH
  on every start; the npm `claude.cmd` shim is bypassed for the real exe), cwd = Archive root,
  Claude session env vars stripped, 256 KB scrollback, output coalesced every 8 ms.
  Uses `useConptyDll: true` (node-pty's bundled `conpty.dll`/`OpenConsole.exe`): with the inbox
  ConPTY, `kill()` forks a helper that crashes with "AttachConsole failed" when the server has a
  console. Measured: both modes kill a grandchild process. `GCS_CONPTY=inbox` switches back.
  The PTY is killed by `stop()` and on SIGINT/SIGTERM; when the server process dies outright the
  PTY goes with it (observed once, by accident).
- **Verified with real Claude** (port 5198, server started from inside a Claude session so the
  session env vars were present): `claude.exe` drew its UI ("Claude Code" in the output), no
  "Transcript saving is off", two Ctrl+C → `state {running:false, exitCode:0}`, no
  "Terminate batch job".
- **`POST /api/bridge/attach`** and **`GET /api/term/state`** added to the route list.
