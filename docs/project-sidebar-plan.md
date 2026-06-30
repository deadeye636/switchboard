# Projekt-Sidebar — Pläne

> **[← Roadmap](ROADMAP.md)** · Stand 2026-06-30 · Status: #15 ✅ · #16 ✅ (Reichweite A) · #17 ✅ (v1 Directory-Sidebar)

Drei zusammenhängende Verbesserungen an den **Projekt-Headern** der Sidebar. Alle
betreffen `public/sidebar.js` (Header-Render ab Zeile 941) plus Persistenz in
`db.js`. Reihenfolge unabhängig umsetzbar.

**Gemeinsamer Kontext (Ist-Zustand):**

- Projekt-Header-Render: `public/sidebar.js:941–972`. Name-Span: `sidebar.js:946`
  (`<span class="project-name">${shortName}</span>`), `shortName` aus
  `project.projectPath` (letzte 2 Pfad-Segmente, `sidebar.js:944`).
- Header-Action-Buttons rechts: schedule / settings (gear) / **favorite** / archive /
  hide (`sidebar.js:948–977`).
- Projekt-Settings öffnen: gear → `openSettingsViewer('project', project.projectPath)`
  (`sidebar.js:1325`), Scope `project:`-Settings-Blob.
- Projekt-Persistenz: Tabelle `project_meta(projectPath, favorited)` (`db.js:102–106`);
  Settings-Blob `settings(key,value)` mit `getSetting/setSetting` (`db.js:769–781`,
  IPC `main.js:1411–1416`), Projekt-scoped geladen via `project:`-Präfix.

---

## 15 Favoriten-Icon vor dem Projektnamen

> ✅ **Erledigt.** Statt eines zweiten Icons wurde der **vorhandene** Favorit-Button vor
> den Namen verschoben (`sidebar.js` `insertBefore(... '.project-name')`); Default
> unsichtbar, Hover-Reveal, gold-persistent bei Favorit (`style.css` `.project-favorite-btn`).

**Ist:** Favorisieren ist **fertig** — Toggle-Stern als rechter Action-Button
(`.project-favorite-btn`, `sidebar.js:960–966`, Klick `sidebar.js:1327–1335`,
`toggleProjectFavorite` → `db.js:487–491`, Sortierung „favorisiert zuerst"
`session-cache.js:342`). Der Stern ist aber nur **rechts als Hover-Aktion**; vor dem
Namen gibt es **keinen** dauerhaften Favoriten-Indikator.

**Ziel:** Bei favorisiertem Projekt ein gefülltes Stern-Icon **direkt vor dem
Projektnamen** anzeigen (analog `missingIcon`, `sidebar.js:945`).

**Umsetzung (klein, reines Frontend):**

- In `sidebar.js:946` vor `<span class="project-name">` ein bedingtes
  `favIcon = project.favorited ? '<svg class="project-fav-icon" …filled star…> ' : ''`
  einsetzen (gleiches Polygon wie der gefüllte Stern aus `sidebar.js:964`).
- CSS `.project-fav-icon` in `style.css` (Farbe = Akzent/Gold, Größe 14, vertikal
  zentriert), Muster wie `.project-missing-icon`.
- Der rechte Toggle-Button bleibt unverändert (Steuerung), der Leading-Star ist nur
  Anzeige. morphdom-Update unkritisch (innerHTML wird neu gebaut).

**Tests:** kein Pure-Helper nötig; visuell im Electron-Smoke (favorisiert → Stern vor
Name, entfernt → weg).

**Offen:** soll der Leading-Star **klickbar** sein (zweiter Toggle) oder rein
dekorativ? Empfehlung: dekorativ, Toggle bleibt der rechte Button.

---

## 16 Projektname umbenennen

**Ist:** Anzeigename ist **immer** aus dem Pfad abgeleitet (`shortName`,
`sidebar.js:944`). Kein Override, keine Persistenz für einen Custom-Namen.

**Ziel:** Feld in den **Projekteinstellungen** (gear → Settings-Viewer, Scope
`project`), in dem ein Anzeigename gesetzt wird. **Leer = aktueller Default**
(`shortName`).

> ✅ **Erledigt (Reichweite A).** Storage = Settings-Blob `project:<path>.displayName`;
> `getProjectDisplayNames()` (db.js) → `proj.displayName` injiziert (session-cache + main.js
> get-memories/get-work-files); Pure-Helper `public/project-name.js` `projectDisplayLabel`;
> Settings-Feld „Project → Display name"; Render in Sidebar (Directory + Folder-First via
> `projectDisplayMap`), Settings-Titel, Plans/Memory. B/C unten weiterhin offen/ausgeschlossen.

**Reichweite-Entscheidung (2026-06-30):** v1 = **nur A (Projekt-Ebene)**. B (Session-Ebene)
ist bewusst zurückgestellt, alle Infos unten vermerkt. C (Worktrees) bleibt ausgeschlossen.

**Persistenz:** Projekt-scoped Settings-Blob — Key `project:<path>` → Feld `displayName`
(kein DB-Migration-Risiko; Pattern existiert, `main.js:1411–1416`, `db.js:769–781`).
Empfehlung bestätigt: Settings-Blob (non-schema, schnell). Alternative `project_meta`-Spalte
verworfen, weil der Settings-Viewer Blobs schreibt → Spalte bräuchte separates IPC.

**Ins Render-Objekt:** `project.displayName` analog `project.favorited` injizieren — in
`session-cache.js buildProjectsFromCache` **eine** Batch-Query
`SELECT key,value FROM settings WHERE key LIKE 'project:%'`, displayName pro Pfad anhängen
(Muster von `getFavoritedProjects`, kein N+1).

**UI:** im Settings-Viewer (`settings-panel.js`, `openSettingsViewer('project', …)`) neue
Sektion „Project" mit Textfeld „Display name (leer = Verzeichnis)" (Projekt-only, kein
„Use global"). Save: `settings.displayName = wert.trim()` bzw. Key **löschen** wenn leer.

### A — Reichweite v1 (Projekt-Ebene)

Helper `displayName?.trim() || shortName`, Tooltip/`title` = echter Pfad. Stellen:

| Stelle | Ref | Quelle |
|--------|-----|--------|
| Sidebar Directory-Header | `sidebar.js:944/946` | `project`-Objekt |
| Sidebar Folder-First-Header | `sidebar.js:1274/1275` (`.ff-project-name`) | `projectPath` → Map nötig¹ |
| Settings-Viewer-Titel | `settings-panel.js:36/39` | `projectPath` → aus geladenem Blob direkt |
| Plans/Memory-Gruppen | `plans-memory-view.js:146/352-353` (`proj.shortName`) | `proj`-Objekt² |
| Work-Files / Command-Palette-Label | `main.js:1208/1359` (`p.shortName`) | `p`-Objekt² |

¹ Folder-First-Header bekommt nur `projectPath` (`sidebar.js:1274`) — entweder Projekt-Objekt
durchreichen oder dieselbe Pfad→Name-Map nutzen.
² `proj.shortName` / `p.shortName` werden in `main.js` (`:1086/1131/1314`) gebildet — dort
`displayName` mit aufnehmen, dann tragen Plans/Memory + Work-Files automatisch.

**Tests:** Pure-Helper „displayName || shortName" Electron-frei; sonst Smoke (setzen, leeren,
Neustart-Persistenz).

### B — Session-Ebene (zurückgestellt, später aktivierbar)

Diese Stellen leiten den Namen **direkt aus `session.projectPath`** ab (nicht aus dem
Projekt-Objekt). Um sie abzudecken: eine **Pfad→displayName-Map** im Renderer bereitstellen
(z.B. aus den geladenen Projekten) und an diesen Stellen `mapDisplayName(path) || shortName`
verwenden.

| Stelle | Ref | Sichtbar als |
|--------|-----|--------------|
| Grid-Karten | `grid-view.js:141`, `grid-view.js:473` | Projekt-Label pro Karte |
| Session-Detail „Project:" | `app.js:1344`, `dialogs.js:49`, `sidebar.js:1758` | Info-Feld |
| New-Session-Dialog-Titel | `dialogs.js:371` | „New Session — X" |
| Suche (Match) | `app.js:1258` | matcht `shortName` — Custom-Name mitsuchen |

**⚠ Achtung Gruppierung:** `sidebar.js:37` und `session-cleanup.js:54` bilden mit demselben
`shortName`-Muster einen **Gruppier-/Fallback-Key**, **nicht** nur Anzeige. Dort den
Custom-Name **nicht** einsetzen — sonst ändert sich die Gruppierung. Nur reine
Anzeige-Stellen umstellen.

### C — Worktrees (ausgeschlossen)

Bleibt draußen. Worktree-Namen folgen einem **eigenen** Muster (letztes Segment /
Worktree-Regex), nicht dem 2-Segment-`shortName`: `sidebar.js:1026`, `sidebar.js:1457`,
`sidebar.js:1477`, `sidebar.js:1494`. Kein Custom-Name hier — separates Konzept, würde
Worktree-Identifikation verwässern.

---

## 17 Projekte manuell sortieren

> **Design bestätigt (2026-06-30), in Umsetzung.** Setting **„Eigene Favoritenliste"**
> (`favoritesOwnList`, Default **aus**): aus = Favoriten **oben angeheftet** im Standard-View
> (Block + Trenner), an = Favoriten nur als **eigene Liste** über den Stern-Toggle (nicht
> angeheftet). Plus wählbare **Sortierung** `projectSortMode` (Aktivität/Alpha/Manuell).
> State via `localStorage` (render-synchron, wie `sidebarViewMode`); Sortier-Control in der
> Filterzeile, `favoritesOwnList` als Checkbox im Settings-Dialog. Scope v1: Directory-Sidebar.

**Ist:** Eine **globale, hardcodierte** Sortierung (`session-cache.js:342–355`):
1. favorisiert zuerst, 2. fehlende zuletzt, 3. leere zuletzt, 4. Recency. Der Stern-Toggle
(`showFavoritedProjectsOnly`, `app.js:1045`, `sidebar.js:928`) schaltet die **Ansicht**:
**AUS** = alle Projekte (Favoriten oben + Rest), **AN** = nur Favoriten. Kein manueller Order,
keine Sortier-Wahl. (`sortedOrder` in `app.js`/`sidebar.js` ist Item-Order **innerhalb** eines
Projekts, nicht die Projekt-Order.)

**Ziel:** „Favoriten oben" **so lassen**, nur die **Sortierung** wählbar machen — innerhalb der
jeweiligen Ansicht.

### Modell (schlank)

- **Kein neues Setting für „Favoriten oben"** — bleibt der AUS-Zustand des vorhandenen
  Stern-Toggles. Favorisiert-zuerst bleibt.
- **Standard-Sortierung** `projectSortMode = 'activity' | 'alpha' | 'manual'` (global Blob,
  Default `activity` = heutige Recency, non-breaking):
  - `activity`: nach letzter Session-Änderung (heute).
  - `alpha`: nach Anzeigename (`displayName || shortName`, #16).
  - `manual`: nach `projectOrder`-Index.
- **Wirkungsbereich je Ansicht:**

  | Stern-Toggle | Inhalt | Sortierung wirkt auf |
  |---|---|---|
  | **AUS** | Favoriten-Block + Rest-Block (mit **Trenner**) | jeden Block **getrennt** nach Modus |
  | **AN** | nur Favoriten | die eine Gruppe nach Modus |

- **Manueller Order** `projectOrder = [projectPath, …]` (global Blob). **Eine** Liste über alle
  Projekte; Favoriten-Block / Rest-Block sind nur **Partitionen** davon (Reihenfolge bleibt).
  Neue/unbekannte Projekte ans Ende. Favorisieren/Entfavorisieren wechselt nur den Block, der
  `projectOrder`-Index bleibt → Position „passend zur Sortierung" fällt von selbst richtig.

### Sort-Logik (`session-cache.js:342` umbauen)

1. `missing` / leer → wie bisher ans Ende.
2. favorisiert-zuerst-Split **beibehalten** (Favoriten-Block oben, Rest unten).
3. **Innerhalb** jedes Blocks nach `projectSortMode` sortieren (statt fix Recency).
4. `activity`/`alpha` automatisch; `manual` nach `projectOrder`.

### Trenner

In der **AUS**-Ansicht zwischen Favoriten-Block und Rest eine **Trennzeile „Favoriten"**
(`.project-favorites-divider`, Stil wie bestehende Section-Header) — nur wenn **beide** Blöcke
nicht leer sind. Render in `sidebar.js` (Directory-Render-Loop) an der Stelle, wo `favorited`
von true→false kippt. In der **AN**-Ansicht (nur Favoriten) kein Trenner.

### Interaktion / UI

- **Sortier-Wahl** als kleines Control in der Sidebar-Filterzeile (`#session-filters`, neben
  Stern-Toggle + View-Mode-Toggle) — Cycle-Button oder Mini-Dropdown `activity/alpha/manual`.
- **Drag-Handle pro Header** `.project-drag-handle` (Zieh-Symbol ⠿), **nur sichtbar wenn
  `manual`** — via Sidebar-Klasse `sort-manual` (CSS schaltet ein/aus). Drag startet am Handle
  (Pointer-Drag wie `startSidebarSessionDrag`), Drop schreibt `projectOrder` + `loadProjects()`.
  In `activity`/`alpha` kein Handle, kein Drag.
- Drag bleibt **innerhalb** seines Blocks (Favoriten nicht in den Rest ziehbar ohne
  Entfavorisieren) — reordnet nur die Block-internen `projectOrder`-Mitglieder.

### Persistenz

Globaler Settings-Blob (kein Schema-Eingriff): `projectSortMode`, `projectOrder`. Mapping in den
Projekt-Datensatz analog `favorited`/`displayName` (`session-cache.js buildProjectsFromCache`),
bzw. Order direkt in der Sort-Logik.

### Tests

Pure-Sort-Helper Electron-frei (`*-status.js`-Muster): Eingabe = Projekte (+favorited, +modified,
+displayName) + `{projectSortMode, projectOrder}` → erwartete Reihenfolge. Fälle:
activity/alpha/manual, favorisiert-zuerst bleibt, neue Projekte ans Ende, Favorisieren behält
manuelle Position.

### Scope v1 / später

- **v1:** Directory-Sidebar. **Folder-First** (`sidebar-folder-first-view-plan.md`) + **Grid**
  später (eigene Header-Pfade).
- Folder-First sortiert intern Projekte je Ordner — `projectSortMode` dort nachziehen, wenn v1 steht.
