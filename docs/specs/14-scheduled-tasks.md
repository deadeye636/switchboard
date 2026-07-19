# Spec 14 — Scheduled tasks (cron-driven headless runs)

> Read `docs/specs/README.md` first.

**Status:** **Removed (#246)** — kept as a rebuild record · **Was:** Claude-only, shipped since the fork's
early days · **Removal commit:** `f136616`

This spec is written *from the working code, before it was deleted*. It records what the feature did, the
contracts it owned (one of which is still sitting in users' project folders), why each awkward part was
awkward, and what a rebuild would have to do differently. The code itself is not reproduced here — it is
559 lines in git; `git show f136616^:src/servers/schedule-runner.js` returns it verbatim. What git
cannot give back is the *why*, so that is what this file is.

## What it did

A cron loop inside the app ran a project's prompt through Claude Code headlessly, on a schedule, without a
session being open.

1. **`startScheduler(log, runCommand)`** aligned itself to the next full minute and then ticked **every
   60 seconds**, on every boot — dev, demo and packaged alike.
2. Each tick **scanned the whole Claude store**: every folder under `~/.claude/projects/`, resolved to its
   project path (from the DB's folder→path map, falling back to reading a transcript's `cwd`), then looked
   for `<project>/.claude/commands/schedule-*.md`.
3. A file whose frontmatter carried a `cron` expression matching the current minute (and was not
   `enabled: false`) triggered a run. A task already running from a previous trigger was skipped —
   keyed on `<folder>:<slug>`, so a slow task could not pile up on itself.
4. The run **pre-created a Claude transcript** (see below), built an argv, and spawned it through the
   app's normal shell path with `FORCE_COLOR=0`.
5. The result appeared in the sidebar as an ordinary session, grouped with the task's earlier runs through
   its `slug`.

A **"Run now"** play button in the Agent Files tab did steps 4–5 on demand, and a clock button on every
project header launched a *session* that helped the user write a schedule file (`launchScheduleCreator`).

## The file format — the one contract that outlives the code

Schedule files live in the user's projects and are **not deleted** by the removal. They are ordinary Claude
slash commands, so they keep working as such; only the cron execution goes away. A rebuild that wants to
stay compatible has to read exactly this:

```markdown
---
name: Nightly test run          # display name; defaults to the filename
cron: 0 3 * * 1-5               # 5 fields, see below
enabled: true                   # only the literal string "false" disables
slug: nightly-tests             # groups repeated runs; defaults to the filename minus "schedule-"
cli:
  permission-mode: acceptEdits  # default when absent
  allowed-tools: Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch   # this exact default
  model: claude-opus-4-8        # optional
  max-budget-usd: 5             # optional, digits only — rejected otherwise
  append-system-prompt: …       # optional; newlines allowed here, other control chars are not
  add-dirs: /a,/b               # optional, comma-separated → one --add-dir each
---

The prompt body. Everything after the frontmatter, and it must not be empty.
```

- **Path**: `<project>/.claude/commands/schedule-<slug>.md`. The `schedule-` prefix is what the scan
  matches on, and what the Agent Files tab used to decide whether to draw a clock and a play button.
- **Cron**: five fields (minute hour day-of-month month day-of-week), each supporting `*`, `*/n`, comma
  lists and `a-b` ranges. Deliberately no `@daily`-style aliases and no seconds field.
- **Frontmatter parsing** was a hand-rolled `key: value` reader with one level of nesting (that is what
  `cli:` is) — not YAML. A rebuild on a real YAML parser must accept these files unchanged.

## Why the awkward parts were awkward

**The pre-seeded transcript.** A scheduled run did not simply spawn `claude -p "<prompt>"`. It first wrote
a one-line JSONL into Claude's own store — a `user` message containing `"Scheduled Task: " + prompt`, with
the `slug` field set — and then launched `claude --resume <that id> -p "Run the scheduled task"`.

The reason is `--session-id`: **only Claude lets the caller choose the session id**, and the app needed to
know the id *before* the process existed, so the row, the grouping and the sidebar could be wired up. The
detour bought two things: the run's prompt was visible in the transcript, and repeated runs shared a
`slug` and therefore folded into one group.

It is also exactly why extending this to a second backend was expensive. **Codex needs none of it**:
`codex exec` persists its own rollout and our scanner indexes it regardless of who started it. So the
generalization was never "add a flag" — it was "delete the mechanism for everyone else and rebuild the
grouping on our side", which is what #206 assessed and then declined.

**The security checks are not decoration.** A schedule file is *executable configuration*: its frontmatter
chooses the model, the permission mode and the allowed tools. Three guards existed and any rebuild needs
them again:

- `validateScheduleFilePath` (#77): a "run now" path had to be a `schedule-*.md` whose parent directory is
  `commands` and whose grandparent is `.claude`. Without it, a compromised renderer could hand over any
  path and have Claude run with attacker-chosen tools and permissions.
- Control characters (`\x00-\x08\x0B\x0C\x0E-\x1F\x7F`) were rejected in every frontmatter scalar that
  reached the argv — `append-system-prompt` excepted for `\n`, `\r`, `\t` only.
- `max-budget-usd` had to match `^\d+(\.\d+)?$`; everything else threw rather than being passed on.
- The argv was built as an **array**, never as a shell string, and the caller did the quoting
  (`quoteArgvForShell`, #76). Those quoting tests survive the removal — they were never scheduler-specific.

**The Claude-enable gate (#162).** Claude is disablable, so the runner had to check `isLaunchable('claude')`
before every spawn and refuse with a sentence instead of spawning a binary the user had turned off.

## Why it was removed

- **It only fired while Switchboard was open.** A Windows task or a cron entry fires after a reboot, with
  no desktop session, whether or not the app runs. For the single thing a scheduler exists to do, this one
  was *worse than the platform's own*.
- **A 60-second tick on every boot**, scanning the whole store, for a feature almost nobody used (at
  removal time: zero `schedule-*.md` files across 25 resolvable projects on the maintainer's machine).
- **It was Claude-hardcoded**, and #206 priced the generalization at a rewrite of both modules.
- It was one of the paths found reading and writing the user's **real** Claude home from an isolated demo
  instance (#241) — it composed `~/.claude/projects` itself instead of following the store override.
- For the backend it would have been extended to, the OS scheduler **already** produces a visible session:
  `codex exec` writes its rollout and our scanner picks it up no matter who started it.

## If it is ever rebuilt

1. **Ask first whether the app should schedule at all.** The honest alternative is a documented recipe: an
   OS task running the CLI's own headless mode, plus a sidebar that already shows the resulting sessions.
   That is strictly more reliable, and for every backend whose CLI persists its own session it is *free*.
2. If it is rebuilt anyway: **a backend-neutral store** (our own DB table: `backendId`, prompt, cron,
   per-backend option overrides), not a Claude slash-command directory — while still reading the legacy
   files above, because they are on users' disks.
3. **A `buildScheduleLaunch(...)` descriptor hook** per backend instead of a hardcoded argv, following the
   rule in `.claude/rules/backends.md`: the core stays neutral, each backend declares its own headless
   invocation and auto-approve flags, and a backend that cannot run unattended declines.
4. **Drop the pre-seed/resume dance** for backends that name their own sessions; keep a Switchboard-side
   map for run-grouping instead of relying on Claude's `slug`.
5. **Keep the three guards** from "Why the awkward parts were awkward" — path validation, control-char
   rejection, argv-not-string. They are the difference between a scheduler and a remote-execution hole.
6. **Do not tick on a timer for discovery.** Watch the store, or store schedules in the DB where a change
   is an event rather than something to be found by scanning.

## Removal — what went, what stayed

**Went:** `src/servers/schedule-runner.js`, `src/servers/schedule-ipc.js`, `makeRunScheduleCommand()` in
`src/app/lifecycle.js`, three IPC handlers (`get-schedule-creator-command` — already caller-less at
removal time — `create-schedule-session`, `run-schedule-now`) with their preload bindings, the renderer's
`launchScheduleCreator` / `resolveDefaultSessionOptions` / `SCHEDULER_BACKEND`, the project-header clock
button, the Agent Files tab's clock icon and play button, `ICONS.schedule`, their CSS, and the
`<scheduled-task name="…">` summary parsing in `session-reader.js` (dead: nothing in this repo ever wrote
that tag, and it appears in no real transcript — an upstream leftover).

**Stayed on purpose:**

- **`~/.claude/commands/create-switchboard-schedule.md`** on every machine that ever ran the app. The file
  belongs to the user's Claude installation; deleting from there is not ours to do. It becomes a slash
  command that writes a schedule file nothing executes.
- **`schedule-*.md` files in projects** — untouched, still valid slash commands, still listed in the Agent
  Files tab (without clock or play button).
- **The shell-quoting tests** from `test/schedule-injection.test.js` (#76) — they test
  `quoteArgForShell` / `quoteArgvForShell`, which are shared spawn infrastructure.

**Also removed with it:** the `binary` field on the Claude descriptor, whose only documented consumer was
"callers that build their own argv (the schedule runner)".
