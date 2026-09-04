---
paths:
  - "docs/**"
  - "README.md"
---

# Where a document goes

| Kind | Home |
|---|---|
| **Design record** for a feature ("why is it like this", decisions, as-built + known gaps) | `docs/specs/NN-<feature>.md` + a row in `docs/specs/README.md` |
| **User-facing guide** ("how do I use it") | `docs/<feature>.md`, linked from the README's **"What it does"** |
| **Reference** (formats, build gotchas, colors) | `docs/<topic>.md` (e.g. `backend-formats.md`, `build-windows.md`, `settings-reference.md`) |
| **How a human builds, runs, tests or packages it** | `docs/development.md`. The README links there and keeps only the build-from-source block the security section needs. |
| **Agent-facing procedure** (release, porting, running, driving) | `docs/ai/<topic>.md` + a row in the CLAUDE.md router |
| **Fork feature list** | `README.md` **"What it does"** (the reader-facing paragraph) **and** `docs/fork-features.md` (the per-feature record) — a new fork feature goes in **both**. The section was called "What this fork adds" when this rule was written; naming a heading that no longer exists is how a rule quietly stops being followed |
| **Backlog** | GitHub Issues. `docs/BACKLOG.md` / `.jsonl` are **generated** (`node scripts/build-backlog.js`) and **gitignored** — never hand-edit, never commit, and never link to them from a doc (they do not exist in the public repo) |
| **Planning scaffolding** (task lists, state trackers, agent prompts, mockups) | `docs/plans/<issue-nr>-<slug>/` — `PLAN.md` for the working plan, `mockups/` for HTML/image mockups. This tree is **gitignored** (local only), so it never reaches the public repo. Once the work lands, its lasting parts belong in a spec; the rest is noise, and stale plan text next to a correct spec is worse than no plan text. **Do not** drop plans in `.claude/scratchpad/` or a system temp dir — `docs/plans/<slug>/` is the one home. |

## A setting changed → `docs/settings-reference.md`

A setting added, renamed, re-scoped or given a different default. That page lists every key with its
**real code default**, which scope it lives in, and what a backend's `configFields` default means. A
change that leaves it stale is worse than no page: the whole point is that it beats reading the
settings screen, which shows what the UI falls back to rather than what applies.

Same for a new `SWITCHBOARD_*` env var or a new script — they are on that page too. When a documented
conflict is decided (#237, #239), the entry **moves** from "known conflict" to the table with the
decision, rather than being deleted.

## New fork feature → document it

A feature unique to this fork (not inherited from upstream) goes in the README's **"What it does"**
section **and** in `docs/fork-features.md`. Terse, matched to the existing style. (The heading was
"What this fork adds" when this rule was written — the table above already records that, and this
sentence had kept the old name anyway.)

## A path you write in a doc is checked; a count you write is not

`test/doc-refs.test.js` fails when a backticked repo path in `CLAUDE.md`, `README.md`,
`.claude/rules/**` or `docs/**` does not exist. Naming a dead path on purpose (a removal record, a
plan option not taken) means an entry in `DELIBERATE` in `scripts/check-doc-refs.js` **with the
reason** — and the guard reports an exemption whose path came back, so the list cannot rot.

**Nothing checks a number, a caller count or "the last place X is still open".** Those went stale in
four docs at once and no test could see it: `.claude/rules/renderer.md` said the backend-id guard ran
over eleven renderer files while `ALLOWED_BINDINGS` held far more, two `src/app/` modules were missing from
both enumerations that list them, and spec 09 called #211 open in one paragraph and closed in another.
So **do not write the number** — name the list, the test or the directory that holds the answer. If
you must write one, write what you compared it against.

## Language & privacy

- All docs, code comments and user-facing UI text are **English**. Commit messages too.
- **No personal or local identifiers.** Never write absolute paths, local machine references
  (`C:\Users\<name>`, drive letters, home dirs), or personal names/emails into issues, commit
  messages, code, or docs — use generic placeholders (`~`, `<project>`, `<user>`). This repo is
  public: issues, issue **edit history**, and git history are all world-readable.
