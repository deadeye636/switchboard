# Switchboard — Roadmap

The board now lives in **GitHub Issues** — not in this file.

- **Open tasks:** <https://github.com/deadeye636/switchboard/issues>
  or the generated read-only mirror **[docs/BACKLOG.md](BACKLOG.md)** for fast in-context grepping.
- **Done:** closed issues + `git log`.

## Maintenance

- New task → `gh issue create` (labels: prio `P1`/`P2`/`P3`, type `bug`/`feature`/`port`/`chore`,
  optionally `source:jbr`/`brianstanley`/`supacode`/`kreaddis`).
- **Body = the requirement only.** Plan/design and implementation go in **comments** (normal issue
  timeline). Done → an implementation comment (with commit refs) + close the issue.
- Refresh the mirror: `node scripts/build-backlog.js` → `docs/BACKLOG.md`.

> **History:** The former ROADMAP and its detailed plans were migrated to GitHub Issues on 2026-07-03
> — **issue number = old `#nr` (1:1)**, contiguous #1–#62. Plan content now lives in the respective
> issues (body = requirement, comments = plan + implementation). The old `*-plan.md`/`*.html` files
> were removed; their content lives in the issues and, via `git log`, in history.
