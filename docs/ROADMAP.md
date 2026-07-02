<!--
  ZENTRALES BOARD — von Hand pflegen.
  roadmap.html (und die HTML-Ansichten der Detailplaene) werden daraus generiert:
  scripts/build-docs.js, `npm run docs:build`, automatisch beim git commit.
  Die *.html sind Generate — NICHT von Hand editieren.
-->

# Switchboard — Roadmap

**Stand:** 2026-07-01 · **Branch:** `main` · Tests grün (`npm test`)

Zentrales Board für alles Geplante, Laufende und Erledigte. Eine Aufgabe lebt **genau
einmal** — Status entscheidet, in welcher Sektion sie steht. Detailpläne stehen in eigenen
Dateien und werden hier nur verlinkt.

**Legende:** 🟡 In Arbeit · 🔵 Backlog · 🟢 Erledigt
**Priorität:** P1 (als Nächstes) · P2 (danach) · P3 (irgendwann)

---

## 🟡 In Arbeit

> Aktuell kein Feature aktiv. Nächster Kandidat siehe Backlog (P1: #02 Detach).

---

## 🔵 Backlog

| ID | Prio | Aufgabe | Detail |
|----|------|---------|--------|
| #02 | P1 | Session-Display **Phase 3 — Detach** (abkoppelbare Fenster) | [Plan](session-display-plan.html) |
| #04 | P2 | **Flexibles Grid-Layout** (Karten-Resize / Drag-Reorder, 5B) | [Roadmap §Phase 5B](productivity-roadmap.md) |
| #19 | P2 | **CI / Autobuild** (GitHub Actions: Test-CI + Win/Mac/Linux-Build + Release) | [Plan](ci-autobuild-plan.md) |
| #05 | P3 | **Attention-Erkennung härten** via Claude-Code-Hooks + Bulk-Aktionen | [Roadmap §Phase 4](productivity-roadmap.md) |
| #23 | P2 | **Bug: integrierter Terminal zeigt Müllzeile.** Beim Start des Plain-Terminals (Session-Auswahl → „Terminal") steht in Zeile 2 der rohe Claude-Shim: `claude() { echo "\033[33m…"; }; export -f claude 2>/dev/null; clear`. Ursache: der Bash-Shim wird auf Windows/PowerShell wörtlich ins pwsh geschrieben (`main.js:1924` + `setTimeout`-`ptyProcess.write` `:1943`) statt als Funktion interpretiert. Fix: Shim je Shell (pwsh vs. bash/zsh) korrekt setzen oder auf Windows weglassen/ersetzen. | — |
| #24 | P2 | **Feature: Terminal integriert vs. extern + Kill-on-Close.** (a) Setting, ob der integrierte Terminal genutzt wird oder ein **externer** Terminal gelauncht wird — vorab **prüfen ob möglich** (welche Terminals, Windows/Mac/Linux, cwd/env-Übergabe, PTY-Anbindung) inkl. Vor-/Nachteilen. (b) Separate Option, ob ein Terminal **beim Schließen sofort beendet** wird — **entkoppelt** von der Claude-Session-Close-/Auto-Close-Logik (#21). Dateien: `main.js` (Spawn), `settings-panel.js`, `session-tabs.js`. | — |
| #26 | P2 | **Bug (vorbestehend): Grid-Übersicht (Mosaik) + `#grid-viewer`-Toolbar erscheinen nicht.** Im Grid-Modus zeigt der Overview-Button weder die Kachel-Ansicht noch die obere Toolbar („Reset layout" etc.). Existiert auch in älteren Versionen → **nicht** vom Flicker/Rename-Umbau. Verdacht: `gridViewActive`-**Desync** (State hängt stale auf `true`) → `toggleGridView` (`grid-view.js:1637`) nimmt den Hide- statt Show-Zweig, `showGridView` (`:1410`, setzt `gridViewer.display='block'` + mountet Cards via `wrapInGridCard`) wird nie erreicht. Diagnose live in DevTools: `gridViewActive`, `localStorage.gridViewActive`, ob `#terminals` die Klasse `grid-layout` trägt, ob der Klick den Show- oder Hide-Zweig nimmt. Mögliche weitere Desync-Quelle: Pfade, die `gridViewActive`/`grid-layout` ohne Gegenstück setzen (Trace-Agent fand u.a. den Startup-Restore, jetzt via `!display-mode-tabs`-Guard entschärft). Dateien: `grid-view.js` (`toggleGridView`/`showGridView`/`hideGridView`), `app.js` (`gridViewActive`, `returnToTerminal`). | — |
| #27 | P3 | **Resize-Flicker (Known Limitation / optionale Milderung).** Beim Fenster-Resize bricht xterm alle Zeilen neu um (Spaltenzahl ändert sich) — renderer-unabhängig, inhärent. Zusätzlich der **Settle-Repaint** (`main.js:2199-2213`, PTY-Nudge `cols+1→cols` 150 ms nach Resize) für Cursor-Korrektheit in TUIs → sichtbarer Voll-Redraw kurz nach dem Loslassen. Optionale Milderung: Fit im Resize-Handler (`app.js` `window.resize`) **debouncen** (nur bei Pause umbrechen statt jedes Event) — Trade-off: Terminal „hängt" beim Ziehen hinterher. Settle-Repaint **nicht** entfernen (sonst Cursor-Bug nach Resize). | — |

---

## 🟢 Erledigt

| ID | Aufgabe | Detail |
|----|---------|--------|
| #17 | **Projekte sortieren** — Sortierung Aktivität/Alpha/Manuell (Filterzeilen-Control) + Drag-Reorder; Setting „Eigene Favoritenliste" (Favoriten oben angeheftet + Trenner vs. eigene Liste) | [Plan](project-sidebar-plan.md#17-projekte-manuell-sortieren) |
| #03 | **Handoff-Store + Resume** — Setting **„Integrated Handoff System"** + editierbarer Prompt (Skill-fähig, `/handoff`); Handoff speicherbar (DB `project_handoffs`) statt/neben neuer Session, auch bei nicht-laufender Session („Save to library"); „Claude Handoff resume" im Neu-Session-Menü mit Picker (Liste/Löschen). Basis-One-Click-Handoff war schon da | [Plan](handoff-store-plan.md) |
| #18 | **Bug-Fix:** Windows-TrayIcon leer — Icon ins Paket (`build.files`) + 16px + Logging statt stillem Fallback | [Plan](windows-tray-fix-plan.md) |
| #16 | **Projektname umbenennen** (Reichweite A) — Display-Name im Projekt-Settings, leer = Verzeichnis; Sidebar (Directory + Folder-First), Settings-Titel, Plans/Memory | [Plan](project-sidebar-plan.md#16-projektname-umbenennen) |
| #15 | **Favoriten-Icon vor Projektnamen** — vorhandenen Favorit-Button vor den Namen verschoben (Hover-Reveal, gold bei Favorit) | [Plan](project-sidebar-plan.md#15-favoriten-icon-vor-dem-projektnamen) |
| #01 | **JBR-Feature-Übernahme** — 36 portiert, 6 Skip; Rest (5.1–5.4) Dev-Infra, bewusst Skip (kein CI/Hosting, <old-codename> ohne eslint) | [Katalog](jbr-uebernahme-katalog.html) |
| #06 | Session-Display **Phase 1 — Tabs** (Setting legacy/tabs, Tab-Leiste, Overflow, Single-View) | [Plan](session-display-plan.html) |
| #07 | Session-Display **Phase 2 — Settings-Fenster** (eigenes Fenster, Live-Apply, sticky Save-Bar) | [Plan](session-display-plan.html) |
| #21 | **Auto-Close Tab bei Session-Exit** (Tabs-Mode) — Setting Modus `Never`/`On success only`/`On success and error` (Default) + Delay in Sekunden (Default 5, `0` = sofort). Timer no-opt bei Relaunch; gemeinsamer `performClose` mit Aktiv-Tab-Fallback (Nachbar-Tab bzw. Placeholder) — behebt nebenbei die blanke Hauptfläche beim manuellen Schließen des aktiven Tabs. Dateien: `session-tabs.js`, `app.js` (`onProcessExited`, `clearActiveTerminalView`), `settings-panel.js` | [Plan](session-display-plan.html) |
| #22 | **Bug-Fix: Tab-Wechsel Flicker (Ansatz B)** — synchroner `safeFit` vor dem Paint in `showSession` (Zwischenschritt; final überholt durch #20). Datei: `terminal-manager.js` | — |
| #20 | **Bug-Fix: Tab-Wechsel Flicker — final (DOM-Renderer + z-index-Stapel).** Ursache zweiteilig: (a) xterm-**WebGL**-Glyph-Atlas rendert beim `hidden→visible` stale („Treppe", korrigiert sich erst beim nächsten Write), (b) `display:none`/`visibility:hidden` → inaktive Terminals werden nicht gepaintet, neue Zeilen erst beim Zeigen nachgezeichnet. Lösung: **DOM-Renderer als Default** (kein Atlas, kein ~16-Kontext-Limit) — WebGL nur noch **opt-in per Setting „GPU rendering (WebGL)"** (`terminalWebgl`, default aus, live via `window._setTerminalWebgl`). Tabs-Mode nutzt einen **z-index-Stapel**: alle Terminals bleiben gemountet **und gepaintet**, Wechsel promotet nur das aktive (`.visible` → z-index/pointer-events), synchron, kein `hidden→visible`-Repaint → kein Flicker auch bei neu dazugekommenen Zeilen. `REFIT_TOL` (Sub-Zeilen-Jitter), File-Panel-Breiten-Fit, Live-Render-Setting bleiben. `forceRepaint` nur noch WebGL-aktiv. **Zusätzlich:** (c) Display-Mode-Wert `legacy`→**`grid`** umbenannt (Label + Source; alte `legacy`-Werte mappen abwärtskompatibel, localStorage-Key `legacyGridPref`→`gridModePref`). (d) **Bug-Fix Tabs→Grid-Wechsel ließ Hauptbereich leer** — Grid-Single-View wurde nicht wiederhergestellt (verließ sich auf Rest-`.visible`, das der z-index-Stapel maskiert); jetzt expliziter `returnToTerminal()`-Aufruf + Startup-Grid-Restore mit `!display-mode-tabs`-Guard. Offener Rest: Resize-Reflow → #27; Grid-Overview-Mosaik-Bug (vorbestehend) → #26. Dateien: `public/terminal-manager.js`, `public/style.css`, `public/settings-panel.js`, `public/app.js`, `public/session-tabs.js` | — |
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
