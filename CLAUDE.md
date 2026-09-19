# G-code Studio — loaded when working in this folder

@context/README.md
@context/preferences.md

**Those two are all that is loaded up front.** `context\README.md` is the index: it says what every other
context file decides and **when to read it** — read the rest only when the work calls for it, not in advance.
`preferences.md` is the how-to-work rules, which apply to everything.

Read when the work calls for it (the index has the full table):

| Before you | Read |
|---|---|
| touch app code | [`CONTEXT.md`](CONTEXT.md) — the app's own index — then `docs\CONTEXT-<part>.md` for the part you touch |
| start or finish app work | [`context-local\TODO.md`](context-local/TODO.md), [`BUGS.md`](BUGS.md) |
| build, edit or finalize a print file | [`context\versions.md`](context/versions.md) |
| slice a new model | [`profiles\README.md`](profiles/README.md), [`context\slicing.md`](context/slicing.md) |
| touch anything about the machine | [`context\printer.md`](context/printer.md) |
| start, restart or reload the app | [`docs\CONTEXT-running.md`](docs/CONTEXT-running.md) — and never do it unasked |

**At the start of every session, read every file in [`context-local\memory\`](context-local/memory/)** — not
just its `MEMORY.md` index. They hold the user's rules and where each job stands. That folder is git-ignored:
**anything with a job, customer or model name in it belongs there, not in `context\`.**

**When a task is done, update the context**: the job's README, the part's `docs\CONTEXT-<part>.md`,
`context-local\TODO.md` (local) / `BUGS.md`, and the context files themselves. [`context\README.md`](context/README.md) §4 says
which file takes what.
