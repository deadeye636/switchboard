# Demo environment

A permanent, fully isolated demo you can relaunch at any time — realistic-but-fake sessions the app can be
shown against without ever touching real data.

```
npm run demo:start          # seed (idempotent) + launch, isolated
npm run demo:start -- --debug   # same, with DevTools on port 9222 (mirrors start:debug)
npm run demo:seed           # just (re)seed the stores, no launch
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

## What is seeded

`scripts/seed-demo.js` writes valid, minimal transcripts for the **file** backends (Claude, Codex, Pi) —
two project working dirs (`demo-alpha`, `demo-beta`, each with a `README.md` + `CLAUDE.md` + `AGENTS.md`),
two Claude sessions under demo-alpha (the second a **fork** of the first, so the lineage thread shows), one
Codex session under demo-beta, and one Pi session under demo-alpha.

- **Hermes and agy stores are created empty on purpose** — no `state.db`, no `.db` files. An absent/empty
  store must degrade gracefully; the seed does not fabricate a SQLite schema for them.
- **Idempotent.** Timestamps come from a fixed base constant and ids are fixed, so every run lands on the
  same paths — an existing file is never overwritten. Rerun `demo:seed` freely; hand-edits to the demo
  transcripts survive.
