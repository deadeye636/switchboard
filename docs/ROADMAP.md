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
| #39 | P3 | **"Dismiss All" für Notifications** _(Quelle: supacode)_ — ein Button/Aktion, die alle offenen In-App-Notifications / Attention-Marker auf einmal quittiert. Ergänzt die Attention-Inbox (#13). Klein, reiner Renderer + evtl. State-Reset. | — |
| #38 | P3 | **Branch-Rename aus Sidebar + Command-Palette** _(Quelle: supacode)_ — Git-Branch einer Session/eines Projekts direkt umbenennen (Kontextmenü Sidebar; optional Command-Palette). `git branch -m` via neuem IPC (`execFile`, kein Shell-Interp.). Nicht verwechseln mit Projekt-**Display**-Name (#16, rein kosmetisch) — hier echter Git-Rename. | — |
| #37 | P3 | **Per-Session/Projekt Farbe + eigener Titel** _(Quelle: supacode)_ — pro Session/Projekt-Zeile frei wählbare Akzentfarbe + optionaler Kurztitel für schnelle visuelle Trennung bei vielen parallelen Sessions. Abgrenzung: `customizing-colors.md` ist globales Theming, hier **pro Eintrag**. Nutzt evtl. bestehende Favoriten/Gruppen-Infrastruktur. | — |
| #36 | P3 | **Worktree-/Session-History-Navigation** _(Quelle: supacode)_ — Hotkey (z. B. Alt+←/→) durch die zuletzt gewählten Sessions/Projekte vor/zurück steppen (MRU-Stack). Passt zum Porting-Workflow mit vielen Worktrees/Branches. Reine Renderer-Nav über bestehenden Session-Wechsel. | — |
| #35 | P2 | **Zentrale Bookmark-Ansicht ("Bookmarks"-Tab)** — Bookmarks aktuell nur über Overlay (Ctrl+Shift+B) als flache Liste. Neu: **Icon oben rechts neben Work-Files** (`#sidebar-tabs`, neben Projects-Tab) → Großraum-Liste **aller** Bookmarks **session-/projektübergreifend** mit **Filtern** (Text/Label, Projekt, Session, Typ Session-Level vs. Nachricht, Sortierung; optional Gruppierung Projekt→Session). Klick springt zur Transcript-Stelle (Reuse `bookmarksTags`/`openSessionAt`). `bookmarks`-Tabelle hat kein `projectPath` → Auflösung via Session-Cache in neuem Aggregat-IPC `get-bookmarks-admin`. Overlay bleibt als Schnellzugriff. Neu: `public/bookmarks-view.js`. Dateien: `main.js`, `preload.js`, `index.html`, `app.js`, `plans-memory-view.js`, `style.css`. | [Plan](bookmarks-view-plan.md) |

---

## 🟢 Erledigt

| ID | Aufgabe | Detail |
|----|---------|--------|
| #34 | **Zoom-Schaltflächen in der Statusbar** — unten rechts zwei Buttons: **xterm-Zoom** (Terminal-Schriftgröße) + **Electron-Zoom** (UI), je Live-Anzeige + Popover (`−`/Wert/`+`/`⟲`) und Mausrad-über-Button. Electron-Zoom jetzt **persistent** (`electronZoomLevel`, Startup-Restore, Tastatur-Shortcuts Ctrl +/−/0 speichern + broadcasten via `zoom-changed`); xterm-Zoom war schon persistent. Range Level ±3 @ 0.5 (≈58–173 %). Neu: `public/statusbar-zoom.js`, IPCs `get-zoom-level`/`nudge-zoom`, Helfer `applyMainZoom`/`clampZoomLevel` (main.js), Event `terminal-font-changed` + Getter in `terminal-manager`. Tests: `test/statusbar-zoom.test.js`. Dateien: `main.js`, `preload.js`, `terminal-manager.js`, `index.html`, `style.css`. | [Plan](statusbar-zoom-plan.md) |
| #33 | **Settings-UI Redesign (nur Global-Scope)** — Global-Settings von einer langen Einspalten-Form (8 Sektionen, ~45 Felder) auf **Zwei-Spalten-Layout**: linke **Kategorie-Navi** mit 7 Gruppen (Sessions & CLI · Terminal · Layout & Tabs · Projects & Sidebar · Usage & Notifications · Shortcuts · Handoff), **Live-Suche** über alle Felder, **„?"-Aufklapp** je Langtext (Kurzsatz sichtbar, Volltext inline via `.settings-more`), **Advanced-Disclosure** für Nischenschalter (GPU, Live-Render, Attention-Hooks). Alte „Application"-Sammelsektion aufgeteilt auf Terminal/Layout/Usage; Beschreibungstexte gekürzt (humanizer), aktive Labels; Usage-Felder mit Farb-Swatch. **Nur der Global-Zweig** in `settings-panel.js` (eigener `if (isProject)`-Split); **Save-/IPC-Logik und Projekt-Rendering unverändert** — ID-Diff alt↔neu = 0 entfernt. Tests grün (479/0). Dateien: `public/settings-panel.js`, `public/style.css`. | — |
| #32 | **Projekt-Verwaltung („Projects"-Tab)** — neuer Sidebar-Tab neben Work-Files → Großraum-Tabelle aller Projekte (inkl. hidden + config-only). Pro Projekt: **Trust** entfernen/setzen (setzen hinter Warn-Confirm) via atomarem RMW auf `~/.claude.json` (`.bak`, nur `hasTrustDialogAccepted`), Hidden/Favorit/Allowlist-Toggles, Inline-Rename, Remap, Remove + read-only Info-Spalten (Sessions, Last activity, MCP/allowedTools/cost). **Remove** mit optionalem Hard-Delete (Session-History auf Disk und/oder `~/.claude.json`-Eintrag). **Remap** zieht den `~/.claude.json`-Block (Trust/MCP/cost) mit um. Alte Hide/Restore-UI bleibt parallel. Neu: `claude-config.js`, `session-cache.buildProjectsAdmin`, `public/projects-admin.js`, IPCs `get-projects-admin`/`set-project-trust`/`delete-project-sessions`/`remove-project-config`. Tests: `test/claude-config.test.js`. | [Plan](projects-admin-plan.md) |
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
| #23 | **Bug-Fix: integrierter Terminal zeigt Müllzeile.** Der Plain-Terminal-Shim (`claude()`-Override) war Bash-Syntax und wurde auf Windows wörtlich ins pwsh geschrieben → Müllzeile 2. Jetzt **je Shell-Typ** (`main.js`): bash/zsh/sh/wsl → `ENV`/`BASH_ENV` + `printf`-Shim; **PowerShell** → `function claude { Write-Host … }; Clear-Host`; **cmd** → `doskey` + `cls`. | — |
| #24 | **Feature: External Terminal + File Explorer + Terminal-Close-Verhalten.** (a) Neue Aktion **„External Terminal"** im Neue-Session-Popover → `openExternalTerminal(cwd)` (`main.js`): Windows `wt.exe -d` (Fallback cmd), macOS `open -a Terminal`, Linux `gnome-terminal`/Fallbacks; `execFile`, launch-and-forget (kein Monitoring). (b) Neue Aktion **„Open in File Explorer"** → `shell.openPath` via bestehendes `openPath`. (c) Setting **`terminalCloseBehavior`** (Kill on close / Keep running, Default **kill**) — nur für Plain-Terminals, entkoppelt von `tabCloseBehavior` (#21); verdrahtet in `session-tabs.js` `closeTab`. Dateien: `main.js`, `preload.js`, `public/dialogs.js`, `public/settings-panel.js`, `public/session-tabs.js`. | — |
| #31 | **Setting: Projekte automatisch hinzufügen vs. manuell.** `projectAutoAdd` (Default **an** = alle `~/.claude/projects` entdecken). **Aus (manuell):** `buildProjectsFromCache` filtert auf Allowlist `addedProjects`; beim Umschalten auf aus werden die aktuell sichtbaren Projekte eingefroren (Seed). Allowlist wächst durch „+ Add project" **und** aus Switchboard gestartete Sessions (`open-terminal` → `ensureProjectAdded`); externe Claude-Sessions bleiben draußen. Remove entfernt auch aus der Allowlist. Wieder **an** → Allowlist ignoriert, alles zurück. Neuer IPC `set-project-auto-add` (Flag + Seed + `projects-changed`). Manuelle Add-/Remove-UI + `hiddenProjects` waren bereits vorhanden. Dateien: `session-cache.js`, `main.js`, `preload.js`, `public/settings-panel.js`. | — |
| #30 | **Statusbar-Usage neu dargestellt.** Statt reinem Text jetzt pro Fenster **Mini-Progressbar + Wert** (`5h [▓] 17% · 7d [▓] 7% · Quota …`). **Quota** = monatliches Extra-Usage/Overage-Budget (`extraUsage`), **nur angezeigt wenn >0%**. **Farbe** (Bar-Fill + Wert) grün→orange→rot, **Schwellen einstellbar pro Fenster** (Settings `usage5hWarn/Crit` Default 60/80, `usage7dWarn/Crit` Default 75/90; Quota nutzt 7d). **Tooltip** mehrzeilig: 5h/7d/Sonnet/Opus mit Reset-Zeit (24h, `formatResetTime`) + Quota-$ (Used/Limit). Neue pure Helfer `usageLevel3`/`getUsageBars`/`getUsageTooltip` (getestet). Dateien: `public/usage-status.js`, `public/app.js` (`renderUsageStatus`, `usageThresholds`), `public/settings-panel.js`, `public/style.css`. | — |
| #28 | **Bug-Fix: Stop/Archiv löste irreführenden Exit-Banner + Auto-Switch aus.** Bewusstes Stoppen/Archivieren beendet den Prozess → `onProcessExited` schrieb „exited (code 1) — re-click to relaunch" + startete den 5-s-Auto-Close (#21), der auf einen Nachbar-Tab wechselte. Beides ist für **selbst endende** Sessions gedacht. Fix: Set `userStoppedSessions` (+ `window._markUserStopped`), markiert an Stop-Button (`confirmAndStopSession`) und allen 3 Archiv-Pfaden (`sidebar.js`). Für markierte Sessions: **kein Banner, kein Auto-Close** — stattdessen sofortiges sauberes Schließen via `window.closeTabNow` (Tabs → `performClose`; Grid/Legacy no-op). Natürlicher Exit unverändert. Dateien: `public/app.js`, `public/session-tabs.js`, `public/sidebar.js`. | — |
| #29 | **Bug-Fix (vorbestehend): Timeline-Viewer überlappte Grid/xterm.** `showGridView` versteckte plan/stats/memory/settings/jsonl, aber **nicht** den `timelineViewer` — bei offener Timeline + (Re-)Anzeige des Grids blieb die Timeline sichtbar und wurde unten vom Terminal abgeschnitten. Fix: `timelineViewer.style.display='none'` in `showGridView` (`grid-view.js`) ergänzt. | — |
| #27 | **Resize-Flicker deutlich reduziert.** Ursache: (a) inhärenter xterm-Reflow beim Umbrechen (Spaltenänderung) — unvermeidbar; (b) **Settle-Repaint** (ConPTY `cols+1→cols`-Nudge nach Resize) = sichtbarer Voll-Redraw, im Grid pro Session → alle Cards flashten (Hauptübeltäter). Fit-Debounce brachte nichts (verworfen). Fix: Settle-Repaint **deaktiviert** (`RESIZE_SETTLE_ENABLED=false`, `main.js`) — „Text-Move" nach Resize fast weg. Trade-off: der Cursor-nach-Resize-Fix in mehrzeiligen TUIs (Commit `87c3efc`) entfällt (akzeptiert). Zusätzlich als Kill-Switch reaktivierbar; dann greift die neue **Fokus-Gating** (`settle`-Flag via `terminal-resize`, nur fokussierte Session nudgen → keine Grid-Card-Flashes). Dateien: `main.js`, `preload.js`, `terminal-manager.js`. | — |
| #26 | **Bug (vorbestehend, entschärft): Grid-Übersicht + Toolbar erschienen nicht.** Ursache war ein **`gridViewActive`-Desync** — der State hing stale auf `true`, also nahm der Overview-Klick den Hide- statt Show-Zweig (`toggleGridView`, `grid-view.js:1637`), `showGridView` wurde nie erreicht. Behoben durch: localStorage-Reset (`gridViewActive`), Startup-Grid-Restore mit `!display-mode-tabs`-Guard (`app.js`), expliziter `returnToTerminal()` beim Tab→Grid-Wechsel (`session-tabs.js`). Nach Tab↔Grid-Roundtrip wieder konsistent. **Falls ohne manuellen Reset erneut** → verbleibende Desync-Pfade härten (jede Stelle, die `gridViewActive`/`grid-layout` ohne Gegenstück setzt). | — |
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
