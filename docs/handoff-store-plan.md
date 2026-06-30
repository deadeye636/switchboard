# Handoff-Store + Resume — Plan (#03-Erweiterung)

> **[← Roadmap](ROADMAP.md)** · Stand 2026-06-30 · Status: 🔵 Backlog (#03, Erweiterung)

Erweitert den **bereits vorhandenen** One-Click-Handoff um einen **speicherbaren** Handoff,
der projektbezogen in Switchboard abgelegt und später beim Start einer neuen Session wieder
aufgegriffen werden kann — als Switchboard-eigene Variante der Claude-Code-Skills
`/handoff` (erzeugen/speichern) und `/handoff-resume` (laden), die sonst an die
Claude-Umgebung gebunden sind.

## Ist-Zustand (vorhanden, bleibt Default)

- **Auslöser:** Handoff-Button + Health-Chip pro Session (wenn `health.state !== 'healthy'`,
  `sidebar.js:2032`) → `showHandoffPrompt` (`dialogs.js:38`).
- **Guided Flow** `runHandoff` (`dialogs.js:157`, Pure-State-Machine `handoff-flow.js`):
  Prompt in die laufende Session tippen (`buildHandoffRequestPrompt`, `session-health.js:163`)
  → Review-Dialog (vorbefüllt aus Session-JSONL) → **frische** Session seeded
  (`launchNewSession(project, opts, packet)`, `app.js:1616` → `seedSessionWhenReady`).
- **Copy-Pfad:** `buildHandoffTemplate` (lokal) in die Zwischenablage.

Diese Variante bleibt **unverändert** und ist **Standard**.

## Ziel der Erweiterung

Eine **per Setting aktivierbare** Variante (Default aus):

1. Anwender klickt Handoff → Handoff wird wie bisher erzeugt (Agent-Prompt + Review).
2. **Neue Abfrage:** *Gleich neue Session* **oder** *Speichern*.
   - **Neue Session:** wie heute (frische Session seeded) — unverändert.
   - **Speichern:** Handoff projektbezogen in den **Switchboard-Daten** ablegen (DB).
3. Beim Start einer neuen Session erscheint im bestehenden Menü ein neuer Punkt
   **„Claude Handoff resume"** (zwischen „Claude (Configure…)" und „Terminal") → gespeicherten
   Handoff wählen → frische Session damit seeden.

---

## Setting (Option)

Globaler Settings-Blob, **Default aus** (non-breaking). Name **noch offen** — Vorschläge:

- **„Handoff library"** (Toggle) ⭐ — kurz, trifft „speichern + später aufgreifen".
- „Save handoffs to Switchboard"
- „Persistent handoffs"

Platzierung: Settings-Gruppe (englische UI), thematisch zu „Session Display"/„Project list"
oder eine eigene Gruppe **„Handoff"**. Apply analog `_applyProjectSortSettings` bzw. einfach
beim Öffnen der Dialoge live aus dem Blob lesen.

Wirkung bei **an**:
- `showHandoffPrompt`/`runHandoff` bekommt nach dem Review die **Speichern-vs-neue-Session**-Abfrage.
- Im `showNewSessionPopover` erscheint **„Claude Handoff resume"**.

Bei **aus**: exakt heutiges Verhalten.

## Storage

Neue DB-Tabelle (Muster `bookmarks`, `db.js:111`; Basis-`CREATE TABLE IF NOT EXISTS` **oder**
angehängte Migration im `migrations`-Array `db.js:141` — nie bestehende Migration ändern):

```sql
CREATE TABLE IF NOT EXISTS project_handoffs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  projectPath TEXT NOT NULL,
  label     TEXT,
  content   TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_handoffs_project ON project_handoffs(projectPath);
```

- `content` = das **reviewte** Markdown-Packet (gleicher Text, der sonst die Session seedet).
- `label` = abgeleitet aus Session-Name/Title + Datum (editierbar im Speichern-Dialog).
- `projectPath` = Zuordnung; Liste/Resume filtert darauf.

**db.js-Funktionen** (mirror `toggleBookmark`/`listBookmarks`): `saveProjectHandoff(projectPath,
label, content)`, `listProjectHandoffs(projectPath)`, `getProjectHandoff(id)`,
`deleteProjectHandoff(id)`. Export ergänzen.

**IPC** (`main.js` Handler + `preload.js` Bindings, je CLAUDE.md-Konvention):
`save-handoff`, `list-handoffs`, `get-handoff`, `delete-handoff`.

## Flow „Speichern vs. neue Session"

In `runHandoff` nach dem Review-Schritt (`capture-packet`, `dialogs.js:172`): wenn Variante aktiv,
statt direkt zu seeden eine `showControlDialog`-Abfrage:
- **„Start fresh session"** → bestehender `seed-session`-Pfad (unverändert).
- **„Save for later"** → kleiner Dialog für Label (vorbefüllt), dann `window.api.saveHandoff(...)`,
  Toast „Handoff saved to project". Flow endet (keine neue Session, keine Tokens für Seed).

Pure-State-Machine `handoff-flow.js` ggf. um einen Zweig/Step erweitern (z.B. Action
`choose-target` nach `captured`) — bleibt Electron-frei + testbar.

## Neu-Session-Menü „Claude Handoff resume"

In `showNewSessionPopover` (`dialogs.js:245`) **zwischen** `claudeOptsBtn` und `termBtn` einen
vierten Button einfügen — **nur** wenn Variante aktiv **und** für das Projekt gespeicherte
Handoffs existieren (sonst ausblenden, kein toter Eintrag):

- Klick → Picker-Dialog: Liste der `listProjectHandoffs(project.projectPath)` (Label + Datum),
  Auswahl + optional **Löschen** je Eintrag.
- Gewählt → `launchNewSession(project, await resolveDefaultSessionOptions(project), content, groupId)`
  — seedet die frische Session mit dem gespeicherten Handoff (gleicher Mechanismus wie guided).
- Optional: nach erfolgreichem Resume den Eintrag behalten (wiederverwendbar) — **nicht**
  auto-löschen; Löschen nur manuell.

Icon: Claude-Icon wie die anderen Claude-Optionen; Label „Claude Handoff resume".

## Tests

- `db.js`-Funktionen: save/list/get/delete (Round-Trip, Projekt-Filter) — Node-Test mit
  temp-DB (Muster vorhandener db-Tests).
- `handoff-flow.js`-Erweiterung (choose-target-Zweig): Pure-Test.
- Smoke (Electron): Variante an → Handoff → Speichern → neue Session → „Claude Handoff resume" →
  Picker → frische Session seeded.

## Offene Entscheidungen

1. **Name des Settings** — „Handoff library" (Empfehlung) oder anderer.
2. **Setting-Gruppe** — eigene „Handoff"-Gruppe oder zu „Project list"/„Session Display".
3. **Label-Quelle** — Auto (Session-Title + Datum) editierbar, ja? (Empfehlung: ja.)
4. **Resume-Eintrag-Sichtbarkeit** — nur wenn gespeicherte Handoffs existieren (Empfehlung) vs.
   immer (dann leerer Picker mit Hinweis).
5. **Mehrere Handoffs pro Projekt** — Liste (ja, Empfehlung) vs. nur der letzte (überschreiben).
6. **Verwaltung** — Löschen im Picker (Empfehlung); eigene „Handoffs"-Übersicht später?

## Scope-Abgrenzung

- Aktuelle Variante bleibt unverändert + Default.
- Kein Eingriff in die Claude-Code-Skills `/handoff`/`/handoff-resume` — die neue Variante ist
  **Switchboard-eigen** (DB-gespeichert, unabhängig von der Claude-Umgebung).
