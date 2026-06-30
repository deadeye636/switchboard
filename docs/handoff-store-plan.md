# Handoff-Store + Resume — Plan (#03-Erweiterung)

> **[← Roadmap](ROADMAP.md)** · Stand 2026-06-30 · Status: ✅ Erledigt (#03-Erweiterung)
>
> Umgesetzt: DB `project_handoffs` + IPC; Settings-Gruppe „Handoff" (Toggle + editierbarer
> Prompt, leer=Default); `runHandoff` nutzt Custom-Prompt/Skill, entkoppelt Senden/Capture bei
> aktiver Library (nicht-modale Capture-Bar); Save-vs-Session-Abfrage; „Claude Handoff resume" im
> Popover mit Picker (Liste/Löschen, disabled wenn leer). Default-Variante unverändert.

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

## Settings — eigene Gruppe „Handoff" (englische UI)

Globaler Settings-Blob. Eigene Settings-Gruppe **„Handoff"** mit:

1. **`handoffLibrary`** (Toggle, **Default aus**, non-breaking) — Name bestätigt **„Handoff library"**.
   Bei **an**:
   - `runHandoff` bekommt nach dem Review die **Speichern-vs-neue-Session**-Abfrage.
   - Im `showNewSessionPopover` erscheint **„Claude Handoff resume"**.
   Bei **aus**: exakt heutiges Verhalten.
2. **`handoffPrompt`** (Textarea, Default = aktueller `buildHandoffRequestPrompt`-Text) — siehe
   nächster Abschnitt. Gilt **immer** (auch für die Default-Variante), nicht nur bei aktiver Library.

Apply: einfach beim Öffnen der Dialoge live aus dem Blob lesen (kein Live-Reapply nötig).

## Editierbarer Handoff-Prompt (+ Skill-Option)

Maximaler Einfluss des Anwenders auf den Handoff: der **Request-Prompt** wird konfigurierbar.

- **Setting `handoffPrompt`** (Textarea in der „Handoff"-Gruppe). Die Textarea zeigt **den
  aktuellen Default-Text an** (aus `buildHandoffRequestPrompt`, `session-health.js:163`),
  vollständig editierbar. **Feld komplett leeren → Default greift wieder** (leer/whitespace =
  „use default", es wird **nie** ein leerer Prompt gesendet → kein Lock). `runHandoff` nimmt im
  `request-packet`-Schritt (`dialogs.js:167`) den getrimmten Custom-Text, sonst den Default.
- **Platzhalter** im Text erlauben (optional, simpel per Ersetzung): `{goal}`, `{project}`,
  `{sessionId}`, `{metrics}` — sonst wird der Text 1:1 getippt.
- **Globalen Skill nutzen:** Da der Prompt nur als Text in die Session getippt wird, kann der
  Anwender ihn auf einen **Skill-Aufruf** setzen, z.B. einfach `/handoff`. Dann läuft der
  globale Claude-Code-Skill; die Antwort wird wie gehabt aus dem Session-JSONL gelesen
  (`extractLatestAssistantText`) — **kein** Sonderpfad nötig. Funktioniert mit jedem Skill,
  der Markdown in den Chat schreibt.
- Optional als Komfort: ein **Preset-Hinweis/Button** „Use `/handoff` skill", der die Textarea
  mit `/handoff` füllt. Reiner Convenience, technisch identisch.

### Interaktive Skills (Rückfragen) — Senden ≠ Erfassen entkoppeln

Manche Skills **fragen interaktiv zurück** (z.B. `/handoff`: „Output Chat oder MD-Datei?").
Würde Switchboard direkt nach dem Senden den **modalen** Review-Dialog öffnen, verdeckt der das
Terminal → die Rückfrage kann nicht beantwortet werden und die Erfassung griffe die **Frage**
statt des Handoffs.

**Lösung:** Senden und Erfassen **trennen**.
- `request-packet` schickt den Prompt/Skill und zeigt nur einen Hinweis (Toast/Inline:
  „Prompt sent — answer any skill question in the terminal, then capture").
- **Kein** automatisches Öffnen des modalen Dialogs. Stattdessen erfasst der Anwender per
  **expliziter Aktion** („Capture handoff"), sobald der Agent fertig ist (und eine evtl.
  Skill-Rückfrage **im Terminal** beantwortet wurde). Erst dann öffnet der Review-Dialog und
  liest die letzte Assistant-Antwort.
- Für nicht-interaktive Prompts/Skills ist das identisch komfortabel (einmal „Capture" klicken);
  der vorhandene „Refresh from session"-Button im Review bleibt als Nachlade-Option.
- Gilt v.a. bei aktiver **Handoff library** / Custom-Skill; die heutige Default-Variante kann
  ihren bisherigen Auto-Review behalten (non-interactive Default-Prompt).

> Gilt für **beide** Varianten — der editierbare Prompt verbessert auch den heutigen
> Default-Handoff. Bei interaktiven Skills greift die Entkopplung oben.

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
vierten Button einfügen — **wenn die Library aktiv** ist. Hat das Projekt **keine** gespeicherten
Handoffs, bleibt der Eintrag **sichtbar, aber deaktiviert** (ausgegraut, `disabled`, Tooltip
„No saved handoffs for this project") — visuell erkennbar, nicht versteckt. Bei Library **aus**
erscheint der Eintrag gar nicht.

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
- `handoffPrompt`-Helfer (Pure): `customOrDefault(text)` → leer/whitespace ⇒ Default, sonst
  getrimmt; testbar.
- Smoke (Electron): Variante an → Handoff → Speichern → neue Session → „Claude Handoff resume" →
  Picker → frische Session seeded.
- Smoke: Custom-Prompt = `/handoff` → Skill läuft (Bracketed-Paste + Enter triggert Slash-Parser),
  interaktive Rückfrage im Terminal beantwortbar, danach „Capture" lädt den Handoff.

## Entscheidungen (bestätigt 2026-06-30)

1. **Setting-Name:** „Handoff library" ✅
2. **Setting-Gruppe:** eigene Gruppe „Handoff" ✅
3. **Label:** Auto-Vorschlag (Session-Title + Datum), beim Speichern **editierbar** ✅
4. **Resume-Eintrag:** bei Library-an immer **sichtbar**; ohne gespeicherte Handoffs
   **deaktiviert + ausgegraut** (nicht versteckt) ✅
5. **Mehrere Handoffs/Projekt:** Liste ✅
6. **Verwaltung:** Löschen im Picker ✅
7. **Editierbarer Handoff-Prompt** (neu): `handoffPrompt`-Textarea, Skill-Aufruf (`/handoff`)
   möglich; gilt für beide Varianten ✅
8. **Default im Feld sichtbar**, Feld leeren → Default greift (kein leerer Prompt/Lock) ✅
9. **Interaktive Skills:** Senden/Erfassen entkoppeln — kein Auto-Modal, explizite „Capture"-
   Aktion nach Terminal-Antwort ✅
10. **Beliebiger Skill:** Freitext `/<name>` (kein Dropdown, Skills nicht enumerierbar) ✅

## Scope-Abgrenzung

- Aktuelle Variante bleibt unverändert + Default.
- Kein Eingriff in die Claude-Code-Skills `/handoff`/`/handoff-resume` — die neue Variante ist
  **Switchboard-eigen** (DB-gespeichert, unabhängig von der Claude-Umgebung).
