<!--
  Detailplan für die zentrale Bookmark-Ansicht (#35). Von Hand gepflegt.
  Wird über ROADMAP.md (#35) verlinkt; roadmap.html + dieses .html-Generat via
  `npm run docs:build` (pre-commit). Das *.html ist Generat — nicht editieren.
-->

# Plan: Zentrale Bookmark-Ansicht ("Bookmarks"-Tab)

**Status:** Backlog #35 · Bearbeitung später · Scope mit User abgestimmt

## Kontext / Ziel

Bookmarks sind aktuell nur über den **Overlay** (Ctrl+Shift+B aus Sidebar/Hauptbereich,
oder Button im Transcript-Viewer) erreichbar — eine flache Liste ohne Filter. Ziel: eine
**zentrale, session- und projektübergreifende Bookmark-Ansicht**:

- **Icon oben rechts neben Work-Files** in `#sidebar-tabs` (neben dem Projects-Tab #32).
- Öffnet eine **Großraum-Liste aller Bookmarks** (Muster wie Projects-Tab / Stats-Viewer).
- **Filtermethoden**: Text/Label, Projekt, Session, Typ (Session-Level vs. Nachricht),
  Zeitraum; Sortierung; optional Gruppierung nach Projekt → Session.
- Klick auf einen Eintrag **springt** zur Transcript-Stelle (wie bisher im Overlay).

## Befund (geprüft am Code)

- **Sidebar-Tabs** (`#sidebar-tabs`, `data-tab`) + Großraum-Viewer-Muster vorhanden; der
  Projects-Tab (#32) sitzt bereits neben Work-Files — neuer Tab fügt sich exakt daneben ein.
- **Bookmark-Storage** (`db.js`): Tabelle `bookmarks(id, sessionId, entryIndex, timestamp,
  label, createdAt)`, `UNIQUE(sessionId, entryIndex)`, `entryIndex = -1` = Session-Level.
  IPCs: `bookmarkList(sessionId|null)`, `bookmarkToggle`, `bookmarkRemove` (`preload`).
  `listBookmarks(null)` liefert **alle** (newest first).
- **Kein `projectPath` in der Tabelle** → muss pro Bookmark über `sessionId` aufgelöst
  werden (Session-Cache / `cache_meta`: projectPath, Session-Name/Summary).
- **Vorhandene Sprung-Logik** in `public/bookmarks-tags.js`: `openSessionAt(sessionId,
  entryIndex)` → `showJsonlViewer` + `scrollToJsonlEntry` (bzw. ans Ende bei -1). Overlay-
  Render + Löschen ebenfalls dort. Wiederverwendbar.

## Design

### Datenquelle — aggregierter IPC
Neu **`get-bookmarks-admin`** (main.js): nimmt alle Bookmarks (`listBookmarks(null)`) und
reichert je Eintrag an:
- `projectPath`, `projectDisplayName` (aus Session-Cache via `sessionId`)
- `sessionName`/`summary`/`aiTitle` (Anzeigename der Session)
- `isSessionLevel` (`entryIndex === -1`)
- Rohfelder `id`, `sessionId`, `entryIndex`, `label`, `timestamp`, `createdAt`
Sessions, die nicht mehr im Cache sind → „unknown project"/Fallback auf `sessionId`.
Rückgabe nur aggregierte Felder (keine Roh-Transcripts).

### UI
- **Sidebar-Tab-Button** neben Work-Files/Projects: `data-tab="bookmarks"` (Bookmark-/Flag-
  Icon) in `public/index.html`.
- **Viewer** `#bookmarks-viewer` (Großraum): oben **Filterzeile** —
  - Textsuche (Label/Session-Name)
  - Projekt-Dropdown (alle / je Projekt)
  - Typ-Filter (Alle / Session-Level / Nachricht)
  - Sortierung (Neueste/Älteste)
  - optional Gruppierung nach Projekt → Session (aufklappbar)
  Darunter Liste/Tabelle: Label, Projekt, Session, Typ, Zeit, Aktionen (Springen, Löschen).
- **Neues Renderer-Modul** `public/bookmarks-view.js` (klassisches `<script>`, Muster wie
  `projects-admin.js`): lädt `get-bookmarks-admin`, rendert Filter + Liste, verdrahtet
  Sprung (Reuse `window.bookmarksTags` / `openSessionAt`) und Löschen (`bookmarkRemove`).
- **Tab-Handler** (`app.js`) + `hideAllViewers` (`plans-memory-view.js`) um
  `#bookmarks-viewer` erweitern (wie bei `#projects-viewer`).
- **`public/style.css`**: Filter-/Tabellen-Styling im bestehenden Look.

### Verhältnis zum bestehenden Overlay
- Overlay (Ctrl+Shift+B) **bleibt** als Schnellzugriff; der neue Tab ist die vollständige,
  gefilterte Ansicht. (Alternativ Overlay später auf den Tab umleiten — Entscheidung offen.)

### Session-Level-Bookmarks sichtbarer (optionaler Zusatz)
Aktuell nur im Overlay/Tab sichtbar, keine Markierung an der Session. Optional:
Bookmark-Indikator (kleines Flag) an gebookmarkten Sessions in der Sidebar — separater
Ausbau, in diesem Plan als Kann-Punkt.

## Offene Entscheidungen (beim Start klären)
1. **Einstieg:** neuer Sidebar-Tab neben Work-Files (Empfehlung, vom User gewünscht) —
   bestätigt. Overlay zusätzlich behalten oder auf den Tab umleiten?
2. **Darstellung:** flache filterbare Tabelle oder Gruppierung Projekt → Session (aufklappbar)?
3. **Filterumfang:** reichen Text/Projekt/Typ/Sortierung, oder auch Zeitraum-Filter/Tags?
4. **Session-Level-Indikator** in der Sidebar mitnehmen (Kann) — ja/nein?

## Umsetzungsschritte (später)
1. `main.js`: IPC `get-bookmarks-admin` (Aggregat aus `listBookmarks(null)` + Session-Cache-
   Auflösung projectPath/Name). `preload.js`: Binding `getBookmarksAdmin`.
2. `public/index.html`: Tab-Button (neben Work-Files/Projects) + `#bookmarks-viewer` + Script-Tag.
3. `public/bookmarks-view.js`: Viewer-Render + Filter + Sprung (Reuse `bookmarksTags`) + Löschen.
4. Tab-Handler (`app.js`) + `hideAllViewers` (`plans-memory-view.js`) erweitern.
5. `public/style.css`: Styling.
6. Tests (`test/bookmarks-view.test.js`): pure Helfer — Filter-/Gruppier-/Sortier-Logik
   (reine Funktionen, ohne DOM).

## Verifikation
- „Bookmarks"-Tab öffnet die Liste; alle Bookmarks projekt-/session-übergreifend sichtbar.
- Filter (Text/Projekt/Typ/Sortierung) wirken; Klick springt zur richtigen Transcript-Stelle
  (Session-Level → ans Ende), Löschen entfernt sofort.
- `npm test` grün.
