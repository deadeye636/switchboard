# Demo environment

A permanent, fully isolated demo you can relaunch at any time — realistic-but-fake sessions the app can be
shown against without ever touching real data.

```
npm run demo:start          # seed (idempotent) + launch, isolated
npm run demo:start -- --debug   # same, with DevTools on port 9222 (mirrors start:debug)
npm run demo:seed           # just (re)seed the stores, no launch
npm run demo:auth           # copy your CLI logins into the demo home (once), so a LIVE session can run
```

## What is isolated

Everything the demo run reads or writes lives under `SWITCHBOARD_DEMO_DIR` (default `C:/temp/switchboard`).
`demo:start` sets **seven** env vars before boot:

| Env var | Points at | Isolates |
|---|---|---|
| `SWITCHBOARD_DATA_DIR` | `<demo>/data` | the app's own `switchboard.db` |
| `SWITCHBOARD_USER_DATA` | `<demo>/userData` | Electron userData / Chromium cache — and its **own** single-instance lock, so the demo coexists with a normal `npm start` dev run instead of being refused by it |
| `SWITCHBOARD_STORE_CLAUDE` | `<demo>/stores/claude/projects` | Claude's projects store |
| `SWITCHBOARD_STORE_CODEX` | `<demo>/stores/codex/sessions` | Codex' date-bucketed rollouts |
| `SWITCHBOARD_STORE_PI` | `<demo>/stores/pi` | Pi's sessions |
| `SWITCHBOARD_STORE_HERMES` | `<demo>/stores/hermes` | Hermes' `state.db` home |
| `SWITCHBOARD_STORE_AGY` | `<demo>/stores/agy` | agy's conversations |

So the demo never reads or writes `~/.claude`, `~/.codex`, `~/.pi`, or the real `~/.switchboard` /
`~/.switchboard-dev`. Point the base elsewhere with `SWITCHBOARD_DEMO_DIR=<path>`.

## Live sessions in the demo (#241)

Those seven variables move where **Switchboard looks**. They do not move where **a CLI writes** — each CLI
resolves its own store from its own variable — so a session actually *launched* from the demo used to land
in the user's real store, invisible to the instance that started it. That is fixed by a descriptor hook:
each backend declares its CLI home variable (`cliHomeEnv()`), and the spawn path merges the answer into the
session's environment. It sits **below** the user's and a template's env, so an explicit variable of yours
still wins.

| Backend | Variable the demo sets | Effect |
|---|---|---|
| Claude | `CLAUDE_CONFIG_DIR` = `<demo>/stores/claude` | transcripts, plans and global memory land in the demo |
| Codex | `CODEX_HOME` = `<demo>/stores/codex` | rollouts, `session_index.jsonl`, `config.toml` |
| Hermes | `HERMES_HOME` = `<demo>/stores/hermes` | its `state.db` home |
| Pi | `PI_CODING_AGENT_SESSION_DIR` = `<demo>/stores/pi` | sessions only — Pi's config/login stay real |
| agy | *(none)* | agy has **no** env var for its store, so its writes cannot be isolated — an honest gap, not a silent one |

**The login.** Credentials live in the CLI's home, so an isolated home starts out logged out. Two ways:

- `npm run demo:auth` — copies the credentials you already have (`~/.claude/.credentials.json`,
  `~/.codex/auth.json`) into the demo home. Deliberately a **separate command**: `demo:start` never reaches
  into your real credential files. The copy is a snapshot — re-run it when a demo session claims it is
  logged out, and `--force` to overwrite. Your real project history (`~/.claude.json`) is **not** copied;
  the demo stays clean.
- Or log in once inside the demo home yourself: run the CLI with `CLAUDE_CONFIG_DIR=<demo>/stores/claude`
  and follow the prompt.

Hermes has no confirmed credential file, so `demo:auth` skips it and says so; log in inside its demo home if
it asks.

**Everything that writes into Claude's home follows the override too** — it is not only the transcripts.
The scheduler (which scans for `schedule-*.md` and pre-seeds session files **on every boot**, dev and demo
included), the MCP IDE bridge's lock files, the attention hook's `settings.json` patch and the Projects
admin's `.claude.json` reader/writer all resolve their paths from `SWITCHBOARD_STORE_CLAUDE`. Before #241
each of those still pointed at the real home, so a demo instance scanned the user's real projects, wrote
into their real `~/.claude/commands`, and showed their real project catalogue in a window that promises it
touches nothing real. `test/store-isolation.test.js` is the guard.

**Known gaps, on purpose:**

- **Usage/quota is the real account's.** `src/backends/claude/usage.js` reads the CLI home from Switchboard's
  OWN environment, and the isolated home is only ever handed to the spawned session — so the status bar and
  the Usage panel show real quota even in the demo. Read-only, and the alternative (an isolated home with no
  usage history) shows nothing at all.
- **agy cannot be isolated.** Its CLI has no env var for its store, so a demo-launched agy session writes to
  the real `~/.gemini/antigravity-cli`. Its descriptor declines the hook rather than pretending.
- **One shipped DB migration reads the real `~/.claude/projects`** (`src/db/migrations.js`) to backfill
  project paths. A migration is append-only and must never be edited once shipped, so it stays as it is —
  read-only, and its result is dominated by the `session_cache` rows it seeds from.

## What is seeded

`scripts/seed-demo.js` writes valid, minimal transcripts for the **file** backends (Claude, Codex, Pi).
Each project is a working dir under `<demo>/projects/<name>/` with a `README.md` + `CLAUDE.md` + `AGENTS.md`
(so the Memory tab has content), plus its sessions in the backend stores. The **standard test projects** —
a fixed base so a scenario is always reproducible:

| Project | Sessions | What it exercises |
|---|---|---|
| **demo-alpha** | Claude ×2 (the 2nd a **fork** of the 1st) + Pi ×1; the 1st Claude session has **3 subagents** (general-purpose, explore, review) | the lineage "▶ earlier" thread; a Claude+Pi project; the **subagent** rows, their type colours and the row-layout setting (#230/#231) |
| **demo-beta** | Codex ×1 | a single-backend, non-Claude project (badge + provenance) |
| **demo-mixed** | Claude + Codex + Pi (one each, same project) | multi-backend badges + mixed provenance in ONE sidebar group |
| **demo-chain** | Claude ×3, a three-deep fork chain (C forks B forks A) | a **deeper** lineage thread — the head folds "2 earlier" |

To add a standard project, extend `IDS` and the seed blocks in `scripts/seed-demo.js` and add a row here.
Keep transcripts valid against the real parsers — seed to a scratch dir (`SWITCHBOARD_DEMO_DIR=<tmp>
node scripts/seed-demo.js`) and parse the result through `src/backends/<id>/` before relying on it.

- **Hermes and agy stores are created empty on purpose** — no `state.db`, no `.db` files. An absent/empty
  store must degrade gracefully; the seed does not fabricate a SQLite schema for them.
- **Idempotent.** Timestamps come from a fixed base constant and ids are fixed, so every run lands on the
  same paths — an existing file is never overwritten. Rerun `demo:seed` freely; hand-edits to the demo
  transcripts survive.
