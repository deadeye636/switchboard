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
