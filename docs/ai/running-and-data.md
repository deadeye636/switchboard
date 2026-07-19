# Running the app, and where the data actually is

Read this before verifying anything against a database, isolating a run, or debugging "my instance
won't start".

## Both start commands can REFUSE, on purpose (#220)

| What you see | Why | What to do |
|---|---|---|
| `[lifecycle] another instance is already running on this userData … — quitting` | Every build takes the single-instance lock now. A dev run is already up — often a leftover with no window, whose launcher was killed. | `npm run stop:dev`, then start again. |
| `Debug port 9222 is already in use` and `start:debug` exits | Electron does **not** fail on an unbindable debug port — it starts silently *without* one, and `drive-app.js` then reports on the **old** process. So the launch refuses instead. | `npm run stop:dev`, then start again. |

`npm run stop:dev` stops **this checkout's** dev Electron run. It filters on this repo's
`node_modules`, so it never touches the user's installed Switchboard or another checkout. Never
`taskkill /IM electron.exe`.

## Two dev builds at once (parallel agent sessions in this repo)

The lock makes the second launch quit, which is usually what you want. If you genuinely need two,
one of them needs **its own everything** — `SWITCHBOARD_DATA_DIR` alone is **not** enough, because
`userData` is a separate switch and the lock is scoped to `userData` (measured, not assumed):

```
SWITCHBOARD_DATA_DIR=C:/temp/switchboard/s2 SWITCHBOARD_USER_DATA=C:/temp/switchboard/s2-ud npm start
```

`SWITCHBOARD_ALLOW_MULTIPLE_INSTANCES=1` also works, but then both instances share one dev DB and
one Chromium cache and fight over them — that is the thing #216 removed. Prefer the two paths above.

## Two databases

Look at the wrong one and you will "verify" against a store that has not moved in weeks — including
a schema the migrations never touched (`no such column: parserVersion` is what that looks like).

| Running as | `DATA_DIR` | DB |
|---|---|---|
| `npm start` / `npm run start:debug` (dev, unpackaged) | `~/.switchboard-dev` | `~/.switchboard-dev/switchboard.db` |
| the installed app (packaged) | `~/.switchboard` | `~/.switchboard/switchboard.db` |
| a test sandbox / agent run | `$SWITCHBOARD_DATA_DIR` | there |

Set in `src/main.js` (~L82): unpackaged **and** no explicit `SWITCHBOARD_DATA_DIR` →
`~/.switchboard-dev`, so a dev instance never races the installed app on `session_cache`.
`src/db/connection.js` resolves `DATA_DIR` at module load (db.js requires it on its first line), which
is why the env var must be set **before** anything requires db.js. `test/main-modules-no-db.test.js`
guards both halves.

**A fix confirmed under `npm start` is confirmed in the DEV database only.** The installed app runs
its own migration + reindex the next time *it* starts.

`SWITCHBOARD_DATA_DIR` alone does not separate a sandbox from a dev run. It moves the DB; `userData`
is a **separate** switch (`SWITCHBOARD_USER_DATA`), and without it a sandbox lands on
`~/.switchboard-dev/userData` — the same one `npm start` uses. Since #220 every build takes the
single-instance lock and Electron scopes it to `userData`, so such a sandbox is **refused** while a
dev instance is running. Give a sandbox **both** vars.

Log file: the installed app writes `%APPDATA%/switchboard/logs/main.log`; a **dev** build writes
`~/.switchboard-dev/userData/logs/main.log`. Reading the wrong one looks exactly like "my log line
never fired".

## The source stores are shared by both

They belong to the CLIs, not to us: `~/.claude/projects/**`, `%LOCALAPPDATA%\hermes\state.db`,
`(CODEX_HOME|~/.codex)/sessions`, `~/.pi/agent/sessions`.

### Isolating them — one env var per backend (#227)

Each backend's scan root is overridable with a unified `SWITCHBOARD_STORE_<BACKEND>` var, ahead of
the CLI's own home env: `SWITCHBOARD_STORE_CLAUDE` (the projects dir — resolved at `src/main.js`
`PROJECTS_DIR`; Claude's plans + global memory derive from its parent, so they isolate too),
`SWITCHBOARD_STORE_CODEX`, `SWITCHBOARD_STORE_HERMES`, `SWITCHBOARD_STORE_PI`,
`SWITCHBOARD_STORE_AGY`.

Set all five plus `SWITCHBOARD_DATA_DIR` + `SWITCHBOARD_USER_DATA` and a dev run scans ONLY the
isolated stores. Without the override a dev build always scans the real `~/.claude/projects` (the
store root was hardcoded before #227), so a DB clean alone can never give "only the demo" — the real
projects re-appear on the next scan.

**That override moves where Switchboard LOOKS. Where the CLI WRITES is a second thing (#241)** —
`cliHomeEnv()`, see `.claude/rules/main-process.md`. Credentials live in the CLI's home, so an
isolated CLI starts logged out: `npm run demo:auth` copies them over (separate command on purpose).

`npm run demo:start` (`scripts/demo-start.js` + `scripts/seed-demo.js`) does all of this against a
seeded demo layout under `C:\temp\switchboard` — see `docs/demo-env.md`.

## The attention hook is OFF in a dev build (#219)

Enabling the toggle returns `{ devBlocked: true }` and writes nothing; attention falls back to the
OSC-9 heuristic. To work on the hook itself:
`SWITCHBOARD_DEV_ATTENTION_HOOK=1 npm run start:debug`. Why, and what it protects:
`.claude/rules/main-process.md`.
