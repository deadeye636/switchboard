# Projekt-Sidebar — Pläne

> **[← Roadmap](ROADMAP.md)** · Stand 2026-06-30 · Status: #15 ✅ · #16 ✅ (Reichweite A) · #17 🔵 Backlog

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

**Ist:** Projekt-Reihenfolge ist **automatisch** (`session-cache.js:342–355`):
1. favorisiert zuerst, 2. fehlende zuletzt, 3. leere zuletzt, 4. nach jüngster
Session-Änderung (Recency). **Kein** persistierter manueller Order. (`sortedOrder`
in `app.js:258`/`sidebar.js:3` ist Item-Order **innerhalb** eines Projekts, nicht die
Projekt-Order.)

**Ziel:** Anwender kann Projekte **selbst sortieren**. Per **Setting** umschaltbar
zwischen Standard-Sortierung (heute) und manueller Order.

**Umsetzung (größer — erst Design bestätigen):**

- **Setting (global):** `projectSortMode = 'auto' | 'manual'` (Default `auto`,
  non-breaking) im globalen Settings-Blob.
- **Persistenz manueller Order:** Array `projectOrder = [projectPath, …]` im globalen
  Blob, ODER Spalte `sort_order` an `project_meta` (angehängte Migration). Empfehlung:
  Blob-Array (einfacher, eine Schreiboperation beim Reorder).
- **Sort-Logik:** `session-cache.js:342` erweitern — bei `manual` nach
  `projectOrder`-Index sortieren, unbekannte/neue Projekte ans Ende (dann Recency).
  Favorisiert-zuerst als optionaler Vorrang beibehalten oder im Manual-Mode aufheben
  (Designfrage).
- **Interaktion:** Drag-to-reorder der Projekt-Header in der Sidebar (Pointer-Drag wie
  Session-Drag aus `sidebar-group-interactions-plan.md`); Drop schreibt `projectOrder`,
  `loadProjects()`.
- **UI-Hinweis:** im Auto-Mode Drag deaktiviert/ignoriert.

**Tests:** Pure-Sort-Helper (`auto` vs `manual` mit Order-Array, neue Projekte ans
Ende) Electron-frei testbar — Muster wie `*-status.js`.

**Offen (zu klären):**
- Verhält sich Favorisiert-Vorrang im Manual-Mode wie? (Vorschlag: Favoriten bleiben
  oben, Rest nach manueller Order — oder voll manuell inkl. Favoriten.)
- Reorder auch in der **Folder-First**-Ansicht (`sidebar-folder-first-view-plan.md`)
  und im **Grid**? Erstmal nur Directory-Sidebar, Rest später.
