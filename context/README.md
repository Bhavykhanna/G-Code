# Context — read this file first

Last updated: 2026-09-19. **This is the index. Read it at the start of a session; read anything else only
when the work calls for it** — each row says exactly when. Nothing else has to be read up front.

## The split: two folders, one rule

| Folder | What | In git |
|---|---|---|
| **`context\`** (here) | everything needed to do the work — rules, conventions, the profile, the findings — written **without job, customer or model names** | **yes, public** |
| **`context-local\`** | the same work with its names on: the memory notes, the open errands, the map of the print archive, and the key from the generic wording back to the real jobs | **no, git-ignored** |

**The rule: if a sentence needs a name, that sentence goes in `context-local\`, and the public file gets the
generic version of it.** Nothing is lost, nothing leaks, and it does not have to be thought about again. The
repo is public; this is what keeps the work shareable and the jobs private.
[`..\context-local\README.md`](../context-local/README.md) holds the name key.

---

## 1. Always loaded

`CLAUDE.md` imports **this index and [`preferences.md`](preferences.md)**, and nothing else — about 14 KB at
the start instead of the ~72 KB that used to be pulled in. Do not re-read these two.

| File | What it decides |
|---|---|
| **this index** | which file to read, and when |
| [`preferences.md`](preferences.md) | how to work: change only what was asked, preview in the app first, ask before touching a print or model file, never launch or restart anything unasked, travel 300 / retraction 0.4, run the print check |

## 2. Read at the start of every session

| File | Why |
|---|---|
| [`..\context-local\memory\`](../context-local/memory/) — **every file, not just `MEMORY.md`** | the standing rules and where each job stands. `MEMORY.md` is only an index |

## 3. Read when the work calls for it

| Read this | When |
|---|---|
| [`versions.md`](versions.md) | **before building, editing or finalizing any print file**: names, drafts, steps, Finalize, same-name replacements, and a worked example of one model going v1 → v2 → v3 |
| [`..\profiles\README.md`](../profiles/README.md) | **before slicing a new model**: the default profile, every value in it and why (infill pattern, cooling, speeds), and the geometry rules that survive it |
| [`findings.md`](findings.md) | what has been measured and learned — the numbers to trust and the mistakes not to repeat |
| [`how-we-work.md`](how-we-work.md) | before designing something new, or when a fix has needed three patches |
| [`printer.md`](printer.md) | anything about the machine: bed size, filament, the pen drive, the slicer install, the printer-screen preview |
| [`profiles.md`](profiles.md) | the tuning history: the first settings, the second round, and the corner-lift post-mortem |
| [`slicing.md`](slicing.md) | running the ElegooSlicer CLI by hand: the exact command, and the exit codes that bite |
| a job's own `README.md` (and its `CONTEXT-chat.md`) | **before touching that job's files.** Its folder's `CLAUDE.md` loads it as soon as you work there |
| [`..\CONTEXT.md`](../CONTEXT.md) → `docs\CONTEXT-<part>.md` | app work. `CONTEXT.md` is the app's index: parser, renderer, server, UI, bridge, thumbnails, compare, terminal, running, git |
| [`..\BUGS.md`](../BUGS.md) + [`..\context-local\TODO.md`](../context-local/TODO.md) | before starting app work, and again when it is finished |
| [`..\demo\README.md`](../demo/README.md) | a finished job ships with the app — use it to try a feature without touching the print archive |
| [`..\context-local\README.md`](../context-local/README.md) | when you need the real name behind a generic one, or the map of the print archive |

## 4. Keeping the context up to date — the standing rule

**"Update the context" means all of these files, not just the job's own notes.** When a task is finished,
before saying it is done, update whatever it changed — the lesson into the public file, the names into
`context-local\`:

| What happened | Public (`context\`, `..\BUGS.md`, `docs\`) | Private (`context-local\`) |
|---|---|---|
| A print file was built, changed or finalized | a rule or a finding, if it taught one | the job's `README.md`, `memory\`, file names and checksums |
| Something was learned about how to print | [`profiles.md`](profiles.md) / [`..\profiles\README.md`](../profiles/README.md), [`findings.md`](findings.md) | which job and file it came from |
| A rule about how to work was given or corrected | [`preferences.md`](preferences.md) or [`how-we-work.md`](how-we-work.md) | the matching note in `memory\` |
| A versioning decision was made | [`versions.md`](versions.md) — into the worked example if it teaches something | |
| App code changed | the part's `docs\CONTEXT-<part>.md`, plus `..\CONTEXT.md` if the shared contract moved | |
| App work finished, or a defect found | [`..\BUGS.md`](../BUGS.md), written generically | `TODO.md`, and `BUGS-local.md` for which job it was |
| A file moved, or a new context file was written | **this index** | `context-local\README.md`, if the private half changed |
| Something needs the user's yes | | `OPEN-DECISIONS.md` |

How to write in them, matching what is already there:

- terse and factual, tables where they help, and always the **why** — including what is unverified;
- a fact lives in exactly one file; everywhere else links to it;
- tick items off with a date instead of deleting them, so the history survives;
- keep the `Last updated:` line right;
- small factual fixes: just make them. Rewriting rules, or dropping a section: ask first
  ([`preferences.md`](preferences.md)).

## 5. The whole map

```
Archive\                         the print archive (not in git)
  CLAUDE.md                      a pointer into this repo — holds no rules of its own
  <job folders>                  G-code, STLs, build scripts; each with its README + CLAUDE.md
  gcode-studio\                  THE REPO
    CLAUDE.md                    loads context\README.md + context\preferences.md, nothing else
    CONTEXT.md  BUGS.md          the app: what it is, known defects (no names)
    docs\CONTEXT-<part>.md       one per part of the app
    context\                     PUBLIC — you are here
      README.md                  this index
      preferences.md             always loaded (how to work)
      versions.md                before building or finalizing a print file
      profiles.md  printer.md  slicing.md  findings.md  how-we-work.md
    context-local\               PRIVATE, git-ignored
      README.md                  what is in here, and the generic-to-real name key
      memory\                    read every file at the start of a session
      TODO.md  BUGS-local.md  archive-map.md  OPEN-DECISIONS.md
    profiles\default\            the profile a new model is sliced with (+ README: every value and why)
    demo\                        a finished job shipped with the app
    src\  server\  test\         the app itself (test\fixtures.local.js is private)
```
