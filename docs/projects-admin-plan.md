<!--
  Detailplan für die Projekt-Verwaltung ("Projects"-Tab). Von Hand gepflegt.
  Wird über ROADMAP.md (#32) verlinkt; roadmap.html + dieses .html-Generat via
  `npm run docs:build` (pre-commit). Das *.html ist Generat — nicht editieren.
-->

# Plan: Projekt-Verwaltung ("Projects"-Tab)

**Status:** Backlog #32 · geplant für eine **neue Session** · Scope mit User abgestimmt (voll)

## Kontext / Ziel

Eine zentrale **Projekt-Verwaltung** in Switchboard: neues Sidebar-Tab-Symbol **rechts
neben Work-Files**, öffnet eine **Liste im großen Viewport-Bereich** (Muster wie
Stats/Plans/Memory-Viewer). Dort kann der User pro Projekt **Trust entfernen**, den
**Hidden**-Status sehen/ändern, und weitere Verwaltung machen (voll).

## Machbarkeit (geprüft)

- **Infrastruktur vorhanden:** Sidebar-Tabs (`#sidebar-tabs`, `data-tab` in
  `public/index.html`) + Großraum-Viewer (Stats/Plans/Memory/Work-Files füllen den
  Hauptbereich, Umschalten via `hideAllViewers()` + Viewer `display`). Neuer Tab +
  `#projects-viewer` fügt sich exakt ins Muster.
- **Trust liegt in `~/.claude.json`** (Claude Codes Hauptconfig, ~160 KB):
  `projects["<pfad>"].hasTrustDialogAccepted` (boolean). Geprüft an echter Datei:
  **54 Projekte, 45 true / 9 false, nur dieses eine Trust-Feld** (keine Varianten).
  Editierbar per read-modify-write.
- **ACHTUNG — Secrets:** `~/.claude.json` enthält `oauthAccount`, `userID`, `machineID`,
  Token-/Feature-Caches. **Niemals dumpen/loggen**, nur das **eine Feld** chirurgisch
  ändern, **atomar** schreiben (Temp + Rename), Rest 1:1 erhalten, `.bak` anlegen.
- **Weitere Per-Projekt-Daten in `~/.claude.json`** (optional anzeigbar):
  `mcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers`, `allowedTools`,
  `lastCost`, `lastTotalInputTokens`/`lastTotalOutputTokens`, `lastLinesAdded`/
  `lastLinesRemoved`, `hasCompletedProjectOnboarding`, `lastSessionId`.
- **Bestehende Projekt-IPCs (main.js):** `add-project`, `browse-folder`,
  `remove-project` (=hide, setzt `hiddenProjects`), `get-hidden-projects`,
  `unhide-project`, `remap-project`, `toggleProjectFavorite` (via db), Display-Name
  (rename, #16), `set-project-auto-add` + `addedProjects`-Allowlist (#31).

## Design

### Datenquelle — ein aggregierter IPC (vom User gewählt)
Neu **`get-projects-admin`** (main.js) liefert pro Projekt in einem Rutsch:
- `projectPath`, `displayName`, `sessionCount`, `lastActivity`, `onDisk`/`missing`
- `trusted` (aus `~/.claude.json` `hasTrustDialogAccepted`)
- `hidden` (in `hiddenProjects`)
- `favorite` (`getFavoritedProjects`)
- `inAllowlist` (`addedProjects`; relevant wenn `projectAutoAdd === false`)
- optional: `mcpServersCount`, `allowedToolsCount`, `lastCost`, Tokens

Quelle = Vereinigung aus `~/.claude.json` `projects` **∪** `~/.claude/projects`-Ordnern
(Switchboard-Cache). **Pfad-Normalisierung** nötig: `~/.claude.json`-Keys sind
Forward-Slashes — mit Switchboards `projectPath` matchen.

### Aktionen (IPCs)
- **Neu `set-project-trust(projectPath, trusted)`** — atomares RMW auf `~/.claude.json`.
  Eigenes Modul **`claude-config.js`** (safe read/parse/modify/atomic-write + `.bak`).
- Vorhanden wiederverwenden: hide/unhide, favorite, rename (Display-Name), `remap-project`,
  `add-project`/`browse-folder`, Allowlist (add/remove über `add-project`/`remove-project`
  bzw. direkt `addedProjects`).

### UI
- **Sidebar-Tab-Button** rechts neben Work-Files: `<button class="sidebar-tab"
  data-tab="projects" title="Projects">…icon…</button>` in `public/index.html`.
- **Viewer** `#projects-viewer` (Großraum) — Liste/Tabelle, eine Zeile pro Projekt:
  Name/Pfad, **Trust**-Toggle, **Hidden**-Toggle, **Favorit**, **Allowlist**, Aktionen
  (rename inline / remap / remove), Info (Sessions, ggf. last cost / MCP-Count). Oben
  Such-/Filterzeile + „Add project"-Button.
- Neues Renderer-Modul **`public/projects-admin.js`** (klassisches `<script>`, Muster wie
  `plans-memory-view.js` / Stats-Viewer): baut den Viewer, lädt `get-projects-admin`,
  verdrahtet Aktionen. Tab-Handler: bei `data-tab="projects"` → `hideAllViewers()` +
  `#projects-viewer` zeigen (und `hideAllViewers` um den neuen Viewer ergänzen).

## Entscheidungen (mit User geklärt, 2026-07-02)

1. **Trust setzen (auf `true`)** — **erlaubt, aber hinter Warn-Confirm** (danger-Dialog
   mit Sicherheitswarnung). Entfernen (`false`) direkt ohne Confirm. Umgesetzt in
   `projects-admin.js` (`showControlDialog`, tone `danger`).
2. **MCP-Server / allowedTools / last-cost** — **voll anzeigen** (read-only Info-Spalte:
   MCP-Count, allowedTools-Count, last cost; Tokens via IPC verfügbar). Aus
   `~/.claude.json` (`getProjectClaudeMeta`).
3. **Bestehende Hide/Restore-UI** — **beide behalten**. Neuer Projects-Tab läuft parallel
   zur alten Restore-UI; kein Entfernen der alten UI in diesem Zug.

## Umsetzungsschritte (für die neue Session)

1. `claude-config.js`: `readClaudeConfig()`, `setProjectTrust(path, trusted)` (atomar,
   `.bak`, nur `hasTrustDialogAccepted` ändern, Pfad-Normalisierung), `getProjectTrustMap()`.
2. `main.js`: IPC `get-projects-admin` (Aggregat aus Cache + Trust-Map + hidden/favorite/
   allowlist) und `set-project-trust`.
3. `preload.js`: Bindings `getProjectsAdmin`, `setProjectTrust`.
4. `public/index.html`: Tab-Button (neben Work-Files) + `#projects-viewer` + Script-Tag.
5. `public/projects-admin.js`: Viewer-Render + Aktionen + Such-/Filter.
6. Tab-Handler (in `app.js`/`sidebar.js` wo `data-tab` behandelt wird) + `hideAllViewers`
   (in `plans-memory-view.js`) um `#projects-viewer` erweitern.
7. `public/style.css`: Tabellen-/Zeilen-Styling.

## Sicherheit / Robustheit

- `~/.claude.json` **atomar** schreiben (temp file + `fs.renameSync`), vorher `.bak`.
- Nur `hasTrustDialogAccepted` je Projekt anfassen; **alle** anderen Keys/Werte erhalten.
- Concurrent-Write mit laufendem Claude möglich → RMW **unmittelbar** vor dem Schreiben,
  last-writer-wins akzeptieren, `.bak` als Sicherung.
- Secrets der Datei **nie** an den Renderer/Log geben — `get-projects-admin` gibt nur die
  aggregierten Projekt-Felder zurück, nicht die Rohdatei.
- Pfad-Matching robust (Forward-/Backslash, Trailing-Slash, Case auf Windows).

## Verifikation

- „Projects"-Tab öffnet die Liste; Projekte + Trust/Hidden/Favorit/Allowlist korrekt.
- „Remove trust" → in `~/.claude.json` steht `hasTrustDialogAccepted:false`; nächster
  Claude-Start im Projekt zeigt wieder den Trust-Prompt; andere Keys unverändert (`.bak`
  vergleichen).
- Hide/Unhide/Favorit/Rename/Remap/Remove wirken wie in der bestehenden UI.
- `npm test` grün (pure Helfer, z.B. Pfad-Normalisierung / Aggregation, testen).
