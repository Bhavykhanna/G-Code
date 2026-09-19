# Git — repository, remote, what is tracked

Last updated: 2026-09-19. Part of [G-code Studio](../CONTEXT.md). Owns `.git\`, `.gitignore`.

**Claude may not run `git add`, `git commit` or `git push` in this repo without being asked for that
run** (user, 2026-09-19: "do not commit you are not allowed to in this repo, or push anything, dont
even do git add with out permission"). Reading state (`status`, `log`, `ls-remote`) is fine.

## Where the repo is

Repo root is **`Archive\gcode-studio\`**, not the Archive root. Remote (since 2026-09-19):
`https://github.com/bhavy-wilyer/G-Code.git`, the account this PC is already logged in to
(`bhavy`), so pushing needs no extra login and no stored token. **First commit pushed 2026-09-19**
(`e603ebf`, 123 files, ~13 MB): the app, the context and memory files, the default profile and the
demo job.

| Option that was rejected | Why |
|---|---|
| Whole Archive with ignores | `ElegooSlicer_Windows_Installer_V1.3.0.11.exe` is **103 MB** — over GitHub's hard 100 MB per-file limit. Archive is 1.1 GB; the job folders are print files, not source |
| Whole Archive, text only | G-code and STL versions would not be backed up anyway, and the repo is the app |

Because the root is the app folder, **everything Claude reads was moved into it** on 2026-09-19:
`context\` now holds `preferences.md`, `versions.md`, `printer.md`, `profiles.md`, `slicing.md`,
`context-local\archive-map.md`, `context-local\OPEN-DECISIONS.md` and `context-local\memory\` (the memory files, moved out of
`%USERPROFILE%\.claude\projects\…\memory\`, which now only holds a pointer). `Archive\CLAUDE.md`
stays at the Archive root — Claude Code loads a `CLAUDE.md` by location — but it only points here.

## Earlier setup, removed

Until 2026-09-19 the remote was a repo on a **different** GitHub account,
so the repo carried `--local` overrides (its own identity, its own credential store, the system
Credential Manager bypassed). The remote moved to this PC's own account, so all of those were
unset: identity now comes from the global config (`bhavy`), credentials from the system Git
Credential Manager. Nothing global or system-wide was ever changed.

## The repo is public

The user's choice (2026-09-19: "yes we keep it public"). What that means in practice:

- **No credentials are in it.** Audited 2026-09-19: no tokens, keys or passwords in any tracked
  file; the per-start API token (`.gcs-token`) is ignored and its value appears nowhere.
- **No model content.** No G-code, STL or 3MF — those extensions are ignored outright, and the five
  app screenshots in `scripts\shots\` were excluded too because they render the enclosure.
- **The context and memory files are public**: the user's working rules, the job names and their
  measurements, the pen drive, and quotes from the user. That is known and accepted.

## What is ignored (`.gitignore`)

| Ignored | Size | Why |
|---|---|---|
| `node_modules/` | 129 MB | dependencies, `npm ci` rebuilds them |
| `dist/` | 5.1 MB | build output (`npm run build`) |
| `.app-profile/` | 482 MB | the app's own Edge profile (cookies, logins) |
| `.server.log` | — | runtime log |
| **`.gcs-token`** | — | **secret**: the per-start API token for the local server |
| `bridge/` | 13 MB | live hand-over between app and Claude, not source |
| `backup/` | 22 MB | local snapshots taken before risky changes |
| `scripts/shots/` | 1.1 MB | app screenshots — they show the model |
| `*.gcode` `*.stl` `*.3mf` `*.obj` `*.step` `*.exe` | — | model and binary content, wherever it appears |

## Commit identity — read this before committing

`user.email` is set **`--local`** to `268623527+bhavy-wilyer@users.noreply.github.com`, so a
command-line commit does not publish the real address. The global config still holds the real one, and
**a GUI client (GitHub Desktop and friends) commits with its own configured e-mail and ignores the repo
setting** — that is how the first commit came to carry the account's real address instead of the alias.
Rewriting it was offered and declined (2026-09-19), and that history was later dropped anyway when the
repo was recreated.
Commit from the command line, or set the alias inside the GUI client, and nothing new carries it.

## Still open (2026-09-19)

1. `gh` (GitHub CLI) is **not installed** on this PC, so nothing here uses it.
2. Claude still does not `add` / `commit` / `push` without being asked for that run.
