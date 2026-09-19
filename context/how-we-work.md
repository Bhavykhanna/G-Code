# How this project is worked on

Last updated: 2026-09-19. Part of the context set — **index: [`README.md`](README.md), read that first**.
The engineering habits this project is built with. [`preferences.md`](preferences.md) covers the print-side
rules (change only what was asked, preview first, ask before touching a file); this one is about how the
work itself is done, and it is where the durable lessons from earlier sessions were collected.

## Judge the idea before building it

When something is proposed, assess it critically first — including the parts that do not work — instead of
agreeing and starting. **Measure before judging**: parse the real file, time the real command, and lead with
the numbers.

This is not a formality. The critique is what made this app buildable: it caught that "select a wall and
double its width" cannot be expressed in G-code at all, because G-code is extruded paths, not geometry. That
one observation produced the two-lane design the whole app rests on ([`..\CONTEXT.md`](../CONTEXT.md)).

Say plainly which part of an idea does not survive contact, why, and what does work instead — and say when a
feature duplicates software that is already installed. Then build the whole thing; the critique is not an
excuse to quietly narrow the scope.

## When a fix needs a third patch, redo the part

If an approach needs tweak after tweak to behave, stop. Find the real cause, name the flawed assumption,
and rewrite that part cleanly with tests for the real cases — then say what the new design is and why.

Worked example: the diff matcher was tuned three times (cell size, neighbour slack, direction bins) and
still showed moved holes as unchanged. The rewrite — compare plastic per layer, walls by direction, smooth
the paths, treat sparse infill as neutral — fixed it properly and is what ships
([`..\docs\CONTEXT-compare.md`](../docs/CONTEXT-compare.md)).

## Documentation shape

One context file per part, plus a main file that links them all — not one large document, and not scattered
notes. That applies to the app (`..\CONTEXT.md` → `docs\CONTEXT-<part>.md`) and to this folder
(`README.md` → the rest).

- the file for a part is written by whoever builds that part;
- terse and factual, tables where they help, and always the **why** — including what is weak or unverified;
- a fact lives in exactly one file; everywhere else links to it;
- [`..\context-local\TODO.md`](../context-local/TODO.md) and [`..\BUGS.md`](../BUGS.md) are kept next to the main file and updated when
  work finishes — tick items off with a date instead of deleting them, so the history survives;
- when a task is done, update the context before saying so ([`README.md`](README.md) §4 says which file).

## Verify on the real thing

Claims get checked against a real file, not an argument: the parser was accepted because deposited filament
matched the slicer's own footer to 0.0001 %; the compare, align and print-check rules each ship with a test
that runs on real G-code (`npm run check`). A number in these docs should be one that was measured — and if
it was only reasoned about, the doc says so.

Two standing traps that cost time before:

- **Tests must never write into the live `bridge\` folder** — a test run once made the running app look
  stuck. They use their own folder (`test\_isolate.js`).
- **Nothing that touches the machine or the window is started unasked**: no browser launch, no headless
  screenshot run, no server restart. Refresh with `app-cli.js reload` instead
  ([`..\docs\CONTEXT-running.md`](../docs/CONTEXT-running.md)).

## Parallel work

Splitting work across parallel agents is welcome for speed, **but only once the contracts are written
down** — the shared data shapes in `..\CONTEXT.md`, and the part's own context file. Without that, parallel
work produces parts that do not meet.
