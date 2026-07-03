# Switchboard — Roadmap

Das Board lebt jetzt in **GitHub Issues** — nicht mehr in dieser Datei.

- **Offene Aufgaben:** <https://github.com/deadeye636/switchboard/issues>
  bzw. der generierte read-only Mirror **[docs/BACKLOG.md](BACKLOG.md)** fürs schnelle In-Context-Grepping.
- **Erledigtes:** geschlossene Issues + `git log`.

## Pflege

- Neue Aufgabe → `gh issue create` (Labels: prio `P1`/`P2`/`P3`, type `bug`/`feature`/`port`/`chore`,
  ggf. `source:jbr`/`brianstanley`/`supacode`/`kreaddis`).
- **Body = nur die Anforderung.** Plan/Design und Umsetzung kommen als **Kommentare** (normaler
  Issue-Verlauf). Erledigt → Umsetzungs-Kommentar (mit Commit-Refs) + Issue schließen.
- Mirror aktualisieren: `node scripts/build-backlog.js` → `docs/BACKLOG.md`.

> **Historie:** Die frühere ROADMAP samt Detailplänen wurde am 2026-07-03 nach GitHub Issues migriert
> — **Issue-Nummer = alte `#nr` (1:1)**, lückenlos #1–#62. Plan-Inhalte stehen jetzt in den jeweiligen
> Issues (Body = Anforderung, Kommentare = Plan + Umsetzung). Die alten `*-plan.md`/`*.html` wurden
> dabei entfernt; ihr Inhalt liegt in den Issues und via `git log` in der Historie.
