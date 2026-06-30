<!--
  ZENTRALES BOARD — von Hand pflegen.
  roadmap.html (und die HTML-Ansichten der Detailplaene) werden daraus generiert:
  scripts/build-docs.js, `npm run docs:build`, automatisch beim git commit.
  Die *.html sind Generate — NICHT von Hand editieren.
-->

# Switchboard — Roadmap

**Stand:** 2026-06-30 · **Branch:** `<old-codename>` · Tests grün (`npm test`)

Zentrales Board für alles Geplante, Laufende und Erledigte. Eine Aufgabe lebt **genau
einmal** — Status entscheidet, in welcher Sektion sie steht. Detailpläne stehen in eigenen
Dateien und werden hier nur verlinkt.

**Legende:** 🟡 In Arbeit · 🔵 Backlog · 🟢 Erledigt
**Priorität:** P1 (als Nächstes) · P2 (danach) · P3 (irgendwann)

---

## 🟡 In Arbeit

> Aktuell kein Feature aktiv. Nächster Kandidat siehe Backlog (P2: #17).

---

## 🔵 Backlog

| ID | Prio | Aufgabe | Detail |
|----|------|---------|--------|
| #02 | P1 | Session-Display **Phase 3 — Detach** (abkoppelbare Fenster) | [Plan](session-display-plan.html) |
| #17 | P2 | **Projekte manuell sortierbar** — per Setting aktivierbar vs. Standard-Sortierung; Ist-Verhalten erst klären | [Plan](project-sidebar-plan.md#17-projekte-manuell-sortieren) |
| #03 | P2 | **One-Click-Handoff** — „Handoff empfohlen" von Rat zu Aktion machen | [Roadmap §Phase 3](productivity-roadmap.md) |
| #04 | P2 | **Flexibles Grid-Layout** (Karten-Resize / Drag-Reorder, 5B) | [Roadmap §Phase 5B](productivity-roadmap.md) |
| #05 | P3 | **Attention-Erkennung härten** via Claude-Code-Hooks + Bulk-Aktionen | [Roadmap §Phase 4](productivity-roadmap.md) |

---

## 🟢 Erledigt

| ID | Aufgabe | Detail |
|----|---------|--------|
| #18 | **Bug-Fix:** Windows-TrayIcon leer — Icon ins Paket (`build.files`) + 16px + Logging statt stillem Fallback | [Plan](windows-tray-fix-plan.md) |
| #16 | **Projektname umbenennen** (Reichweite A) — Display-Name im Projekt-Settings, leer = Verzeichnis; Sidebar (Directory + Folder-First), Settings-Titel, Plans/Memory | [Plan](project-sidebar-plan.md#16-projektname-umbenennen) |
| #15 | **Favoriten-Icon vor Projektnamen** — vorhandenen Favorit-Button vor den Namen verschoben (Hover-Reveal, gold bei Favorit) | [Plan](project-sidebar-plan.md#15-favoriten-icon-vor-dem-projektnamen) |
| #01 | **JBR-Feature-Übernahme** — 36 portiert, 6 Skip; Rest (5.1–5.4) Dev-Infra, bewusst Skip (kein CI/Hosting, <old-codename> ohne eslint) | [Katalog](jbr-uebernahme-katalog.html) |
| #06 | Session-Display **Phase 1 — Tabs** (Setting legacy/tabs, Tab-Leiste, Overflow, Single-View) | [Plan](session-display-plan.html) |
| #07 | Session-Display **Phase 2 — Settings-Fenster** (eigenes Fenster, Live-Apply, sticky Save-Bar) | [Plan](session-display-plan.html) |
| #08 | **Native Notifications + Taskbar-Badge + Tray** (Produktivität Phase 1) | [Roadmap](productivity-roadmap.md) |
| #09 | **„Während du weg warst"-Zusammenfassung** (Produktivität Phase 2) | [Roadmap](productivity-roadmap.md) |
| #10 | **Session-Gruppen** (5A — `groups-model.js`, Sidebar + Grid) | [Roadmap §Phase 5A](productivity-roadmap.md) |
| #11 | **Sidebar Folder-First-Ansicht** (Gruppen top-level, umschaltbar) | [Plan](sidebar-folder-first-view-plan.md) |
| #12 | **Sidebar Gruppen-Interaktionen** (Drag in Gruppe, neue Session aus Gruppe, Doppelklick-Rename) | [Plan](sidebar-group-interactions-plan.md) |
| #13 | **Agent-Supervision UX** Phase 1–6 (Attention-Inbox, Status-Chips, Grid-Filter, A11y, Dialoge, Timeline) | [Plan](agent-supervision-ux-plan.md) |
| #14 | **Sidebar-Polish** — Klappzustand-Default, „letzter Stand" merkt Projekt-Header, Settings-i18n | — |

---

## Pflege

- Neue Aufgabe → Zeile in **Backlog** (nächste freie `#nr`, Prio setzen).
- Start → Zeile nach **In Arbeit** verschieben.
- Fertig → Zeile nach **Erledigt** verschieben.
- Detailplan (großes Feature) → eigene `*-plan.md` Datei, hier verlinken (auf die `.md`;
  in der HTML-Ansicht wird der Link automatisch auf das `.html`-Generat umgebogen).
- Generat nie von Hand anfassen: `roadmap.html` + die `*-plan.html`/`*-roadmap.html` werden
  per `npm run docs:build` (und pre-commit) aus den `.md` erzeugt.
