<!--
  Detailplan — von Hand pflegen. auto-hide-projects-plan.html ist Generat
  (scripts/build-docs.js, `npm run docs:build`, pre-commit). Das .html NICHT editieren.
-->

# Plan #57 — Auto-Hide stale Projekte (ersetzt den stillen Altersfilter)

**Status:** In Umsetzung · **Prio:** P2 · **Branch:** `feat/auto-hide-projects` · löst #54

## Problem

Der Sidebar-Altersfilter (`public/sidebar.js:677`, `sessionMaxAgeDays`) blendet Sessions aus,
die älter als N Tage sind. Nebeneffekt (#54): ein Projekt, dessen Sessions **alle** älter als N
Tage sind, hat 0 sichtbare Sessions → `shouldRenderProjectGroup` rendert die Gruppe nicht
(empty-placeholder greift nur bei `older.length===0`). Das Projekt verschwindet **ohne
Rückmeldung** — verwirrend, besonders bei manuell hinzugefügten Projekten.

## Idee

Statt eines stillen Render-Filters ein **explizites Auto-Hide**: nach X Tagen Inaktivität wird
der **Hide-Flag automatisch gesetzt**. Das Projekt landet **sichtbar** in „Hidden" und ist per
Unhide zurückholbar — Status-Änderung statt heimlichem Filter.

## Design

### Setting
- **`autoHideDays`** (Zahl, Default **0 = aus**): „Projekte ohne Session-Aktivität seit N Tagen
  automatisch ausblenden." UI in Global-Settings (Kategorie „Projects & Sidebar").

### Zustand (`project_meta`)
`project_meta` pro Projekt um zwei Spalten erweitern (idempotenter `ALTER … ADD COLUMN`):
- **`autoHidden` INTEGER DEFAULT 0** — Marker, dass der Hide-Flag **automatisch** gesetzt wurde
  (unterscheidet von manuellem Hide → Badge, und getrennte Behandlung).
- **`autoHideResetAt` TEXT** — Zeitstempel, ab dem der Auto-Hide-Timer neu läuft (Grace).

Der Hide-Flag selbst bleibt die bestehende `hiddenProjects`-Liste (Setting) — Auto-Hide fügt
dort hinzu, manuell wie bisher.

### Auswertung
**Effektive Aktivität** eines Projekts = `max(neueste Session-Aktivität, autoHideResetAt)`.
Auto-Hide feuert für ein Projekt, wenn **alle** gelten:
- `autoHideDays > 0`
- `now − effektiveAktivität > autoHideDays·86400000`
- Projekt ist **nicht** bereits in `hiddenProjects`
- keine **laufende** Session (laufende = frische Aktivität, fällt eh raus)

Ein `applyAutoHide()`-Pass im **Main-Prozess** (schreibt `hiddenProjects` + `project_meta`),
ausgeführt **beim App-Start** und beim **throttled Projekt-Refresh** (nicht im Renderer). Setzt
für betroffene Projekte `hiddenProjects += path` und `project_meta.autoHidden=1`, sendet
`projects-changed`.

### Reset des Timers
`autoHideResetAt = now` **und** `autoHidden=0` **und** Entfernen aus `hiddenProjects` bei:
- **Unhide** (`unhideProject`) — verhindert sofortiges Re-Hide eines alten Projekts.
- **Add-Project / Re-Add** (`ensureProjectAdded` / `add-project`).
Neue Session-Aktivität braucht keinen expliziten Reset — sie fließt in „neueste Aktivität".

### Stiller Filter entfällt
- **`shouldRenderProjectGroup`** (`sidebar.js`): **nicht-hidden** Projekte werden **immer**
  gerendert (auch bei 0 sichtbaren Sessions → als „older"/Platzhalter). Kein stilles Killen mehr.
- **`sessionMaxAgeDays`** bleibt nur noch **Session-Fold-Schwelle** (jüngste sichtbar, ältere
  eingeklappt), ohne Projekt-Effekt.

### Hidden-Liste UI
In der Add-Project-Hidden-Liste (bzw. Projekt-Verwaltung #32) ein kleines **„auto"-Badge** für
`autoHidden`-Einträge, damit klar ist, *warum* ein Projekt weg ist.

## Dateien
`public/settings-panel.js` (`autoHideDays`), `db.js` (`project_meta`-Spalten + ALTER, Getter/Setter),
`main.js`/`session-cache.js` (`applyAutoHide`, Reset in `unhideProject`/`add-project`, Start-/Refresh-Hook),
`public/sidebar.js` (`shouldRenderProjectGroup` immer rendern; `sessionMaxAgeDays` fold-only),
`public/dialogs.js`/Projekt-Verwaltung (auto-Badge). Reiner Helfer `shouldAutoHide(effAtMs, nowMs, days)` testbar.

## Tests
`test/*`: `shouldAutoHide` (aus/an, Grenzen, Reset-Grace), `project_meta`-Roundtrip der neuen Spalten.
`npm test` grün halten.

## Bewusst nicht (v1)
- Kein Auto-**Unhide** (nur Auto-Hide; Unhide bleibt manuell + Reset).
- Kein per-Projekt-eigenes `autoHideDays` (nur global) — evtl. Folgeschritt.
- #55 (verwaiste `hiddenProjects` gegen `.claude.json` prunen) bleibt separat.
