# Projekt-Sidebar — Pläne

> **[← Roadmap](ROADMAP.md)** · Stand 2026-06-30 · Status: #15 ✅ erledigt · #16/#17 🔵 Backlog

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

**Umsetzung:**

- **Persistenz:** Projekt-scoped Settings-Blob nutzen — Key z.B.
  `project:<path>` → Feld `displayName` (kein DB-Migration-Risiko; Pattern existiert,
  `main.js:1411–1416`, `db.js:769–781`). Alternativ Spalte `displayName` an
  `project_meta` per **angehängter** Migration (`db.js`), falls Blob unpraktisch.
  Empfehlung: Settings-Blob (non-schema, schnell).
- **UI:** im Settings-Viewer (`settings-panel.js`, `openSettingsViewer('project', …)`)
  ein Textfeld „Anzeigename (leer = Verzeichnis)" ergänzen; Save schreibt/löscht den
  Wert (leer → Key entfernen → Default greift).
- **Render:** `sidebar.js:944` →
  `const display = project.displayName?.trim() || shortName;` und in `:946` `display`
  statt `shortName` verwenden. `project.displayName` muss in den Projekt-Datensatz
  gelangen (Cache-Build `session-cache.js:buildProjectsFromCache`, analog `favorited`
  via `getFavoritedProjects`).
- Tooltip/Title am Header weiterhin den echten Pfad zeigen (Disambiguierung).

**Tests:** Pure-Mapping „displayName || shortName" als Helper testbar; sonst Smoke
(setzen, leeren, Persistenz über Neustart).

**Offen:** Custom-Name auch in **Grid**-Karten und Tab-Titeln spiegeln? (Konsistenz —
empfohlen, aber separater kleiner Schritt.)

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
