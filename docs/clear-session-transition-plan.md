<!--
  Detailplan zu Roadmap #58. Von Hand pflegen; das HTML-Generat
  (clear-session-transition-plan.html) wird via npm run docs:build erzeugt —
  NICHT von Hand editieren.
-->

# Plan #58 — `/clear`-Session-Transition folgen (PTY-Rekey bei Clear)

> **[← Roadmap](ROADMAP.md)** · Status: **Erledigt** · Fix in `session-transitions.js`

## Problem & Ziel

`/clear` in einer aus Switchboard gestarteten Claude-Session **koppelt die UI von
der laufenden PTY ab**. Claude Code behält beim `/clear` denselben PTY-Prozess,
vergibt aber eine **neue sessionId** und startet eine neue `.jsonl` — **ohne
jegliche Lineage-Metadaten** (kein `forkedFrom`, kein `parentSessionId`, kein
`planContent`). `detectSessionTransitions` (`session-transitions.js`) folgt aber
nur **Fork** und **Plan-Accept** — beide brauchen genau solche Metadaten. Also
matcht keine Branch, die PTY bleibt in `activeSessions` auf der **alten** ID
gekeyt, und die neue Session verwaist als reiner Scanner-Eintrag.

**Verifiziert (2026-07-03):** Session `d985ef73` endete 14:02:41 (Stop +
`turn_duration`). `/clear` um 14:06 → neue Session `bc7e695e` (selbe PTY). `bc7`
hat **0×** `forkedFrom`/`parentSessionId`/`planContent`.

**Symptome:**
- Split-Brain: die **laufende PTY** (Terminal-Output, OSC-Status, Running-Indicator)
  bleibt auf `d985` gekeyt (`session.realSessionId || sessionId`, `main.js:2703`) —
  falsch. `bc7` erscheint als **eigenständige** Sidebar-Zeile über den
  `scan-projects`-Worker, **ohne** Verknüpfung zur PTY.
- `bc7` „teils nicht aktualisiert": kein PTY-getriebenes Live-Refresh, nur die
  periodischen Scanner-Pässe seiner Datei. Live-Status hängt am toten `d985`.
- **MCP-Nebeneffekt:** MCP-Server läuft auf demselben SSE-Port weiter, aber gekeyt
  unter `d985` (`startMcpServer(sessionId=d985)`, `main.js:2660`). Diffs/File-Opens
  vom `bc7`-claude kommen unter `d985`-Tag rein.

**Ziel:** `/clear` als **dritte Transition-Art** erkennen und die PTY analog zu
Fork/Plan-Accept auf die neue sessionId **rekeyen** — inkl. MCP-Rekey und
`session-forked`-IPC, damit die UI der neuen Session folgt.

## Signal

Der Kopf der neuen `.jsonl` trägt ein eindeutiges Attachment:

```json
{"type":"attachment","parentUuid":null,
 "attachment":{"type":"hook_success","hookEvent":"SessionStart","hookName":"SessionStart:clear", ...}}
```

`hookEvent === "SessionStart"` **und** `hookName` endet auf `:clear` → sicherer
Clear-Marker. Sekundär bestätigt der frühe User-Turn `<command-name>/clear`.

**Abgrenzung:** `SessionStart` feuert auch für `startup`/`resume`/`compact`. Nur
`:clear` behandeln. **`:compact` prüfen** — offen, ob Compaction ebenfalls eine
neue sessionId in derselben PTY erzeugt; falls ja, denselben Pfad nutzen (eigene
Evidenz sammeln, nicht blind annehmen).

## Ist-Zustand (verankert)

- `session-transitions.js:126` `readNewSessionSignals` — liest Kopf-Signale,
  überspringt `file-history-snapshot`, bricht am ersten `user`/`assistant`-Entry
  ab. **Attachment-Zeilen (Clear-Marker) liegen VOR dem ersten User-Turn** → im
  bestehenden Scan erreichbar, aber aktuell nicht ausgewertet.
- `session-transitions.js:183` `detectSessionTransitions` — Fork- (Z.248-259) und
  Plan-Accept-Branch (Z.266-279); bei Match: `realSessionId`/`knownJsonlFiles`
  setzen, `rekeyMcpServer`, `session-forked` senden (Z.281-295).
- `main.js:2700` PTY in `activeSessions` unter Spawn-`sessionId` gekeyt; `main.js:2703`
  attribuiert alle Live-Events an `realSessionId || sessionId`.
- `public/app.js:935` `onSessionForked(oldId,newId)` — macht bereits **vollen**
  Renderer-Rekey (openSessions, activeSession, Timeline, File-Panel, pendingSessions,
  sessionMap, Header). **Wiederverwendbar ohne Änderung.**

## Design

### 1. Clear-Marker in `readNewSessionSignals` erkennen
Zusätzlich zu den bestehenden Signalen ein `clearOrigin`-Flag setzen, wenn eine
Attachment-Zeile mit `attachment.hookEvent === 'SessionStart'` und
`attachment.hookName` endend auf `:clear` auftaucht (vor dem User-Turn-Break).
Rückgabe erweitern: `{ …, clearOrigin }`.

> Hinweis: `parentSessionId` fängt sich in diesem Fall die **eigene** neue ID
> (die `mode`-Zeile trägt `sessionId=<newId>`) — für Clear irrelevant, da wir
> nicht darüber matchen.

### 2. Clear-Branch in `detectSessionTransitions`
Nach Fork/Plan-Accept, wenn `signals.clearOrigin` und **noch nicht** gematcht:
Kandidaten-Zuordnung (siehe #3). Bei Treffer denselben Rekey-Block wie Fork
ausführen (`realSessionId=newId`, `knownJsonlFiles`, `rekeyMcpServer(oldId,newId)`,
`session-forked` senden, `break`).

### 3. Assoziation (der harte Teil)
Die Clear-Datei hat **keinen Backref** auf die alte Session. Zuordnung zur
richtigen aktiven PTY-Session heuristisch:

- **Kandidat:** aktive Session mit `!exited && !isPlainTerminal &&
  projectFolder === folder`, deren effektive ID (`realSessionId || sessionId`)
  **≠ newId** ist.
- **Common Case (eine Claude-Session pro Folder):** genau ein Kandidat → direkt
  zuordnen.
- **Disambiguierung bei mehreren:** Kandidat wählen, dessen aktuelle Datei
  (`<effId>.jsonl`) den **jüngsten mtime vor** der Erstellung von `newId` innerhalb
  eines Fensters (z. B. ≤ 5 min) hat — die gerade „stillgelegte" Session. Bleibt es
  mehrdeutig → **nicht** raten: überspringen + `log.info` (kein Fehl-Rekey).
- **Externer `/clear`** (Session **nicht** von Switchboard gestartet) → kein
  Kandidat → korrekt ignoriert.

### 4. Optional: eigenes `session-cleared`-Label
Fix funktioniert vollständig über das bestehende `session-forked`-IPC (Renderer
rekeyt komplett). Nur die Timeline-Beschriftung sagt dann „forked". Optionaler
Zusatz: neues IPC/Flag `session-cleared` → Timeline-Wording „cleared" statt
„forked" (`app.js:935` verzweigt). **Nicht** fix-kritisch, rein kosmetisch.

## Alternative Assoziation (offene Frage, bevorzugt langfristig)
Nach `/clear` reconnected **derselbe** claude auf **demselben** SSE-Port
(`CLAUDE_CODE_SSE_PORT` unverändert, `main.js:2673`) — bislang unter `d985`
gekeyt. **Prüfen, ob die MCP-`initialize` die neue sessionId re-announced.** Falls
ja: Port→PTY→**exakter** Rekey ohne jede Heuristik (kein Fenster, keine
Mehrdeutigkeit). Das wäre der saubere Weg; die Datei-Heuristik (#3) bleibt Fallback,
falls MCP nichts liefert oder MCP-Emulation deaktiviert ist.

## Nachteile & Mitigation

| Nachteil | Mitigation |
|---|---|
| **Fehl-Zuordnung** bei mehreren Claude-Sessions im selben Folder | jüngster-mtime-vor-newId + Fenster; bei Rest-Mehrdeutigkeit **skippen statt raten** (log) |
| **`SessionStart` mehrdeutig** (startup/resume/compact/clear) | strikt nur `:clear`; `:compact` separat verifizieren, nicht blind mitnehmen |
| **False positive auf neue Session** (isNew) | isNew-Datei = exakt `<sessionId>.jsonl`, kein Clear-Marker, matcht ohnehin direkt — Clear-Branch greift nicht |
| **Timeline sagt „forked"** | akzeptabel; optional `session-cleared`-Label (#4) |
| **Heuristik-Fenster** (mtime-Lücke, hier 3,5 min zw. d985-Ende und clear) | Fenster großzügig (≤ 5 min); langfristig MCP-basierte exakte Zuordnung |

## Dateien

- `session-transitions.js` — `readNewSessionSignals` (`clearOrigin`) +
  `detectSessionTransitions` (Clear-Branch + Assoziation).
- `main.js` — **nur** falls MCP-basierte Zuordnung (Alternative) gewählt wird
  (Port→PTY-Map beim MCP-Reconnect).
- `preload.js` / `public/app.js` — **nur** optional für eigenes `session-cleared`-Label.
- `test/…` — neue Fixtures + Fälle (siehe unten).

## Tests

- Alte Session-Datei + neue Datei mit `SessionStart:clear`-Attachment + passender
  aktiver PTY-Kandidat → `realSessionId=newId`, `rekeyMcpServer` aufgerufen,
  `session-forked` emittiert.
- Neue Datei mit `SessionStart:startup`/`:resume` (kein `:clear`) → **kein** Rekey.
- Clear-Marker aber **kein** aktiver PTY-Kandidat (externer Clear) → **kein** Rekey.
- Zwei aktive Sessions im selben Folder → korrekter Kandidat per mtime; bei
  Mehrdeutigkeit → skip + log, kein Fehl-Rekey.
- Fork-/Plan-Accept-Pfade unverändert grün (Regression).

## Verifikation (2026-07-03)

- **Doku bestätigt die Mechanik:** `/clear` erzeugt eine neue Session-id + neues
  `.jsonl`, alte Session verwaist — [Docs](https://code.claude.com/docs/en/sessions)
  + offenes Issue [anthropics/claude-code#37451](https://github.com/anthropics/claude-code/issues/37451)
  („/clear creates a new session instead of clearing current context").
- **Unit-Tests** (`test/session-transitions.test.js`, +5): clear-happy-path,
  `SessionStart:startup`≠clear, externer Clear ignoriert, ambig→skip, Fork-Regression.
  Volle Suite **512/512** grün.
- **Echte Clear-Datei end-to-end:** die reale `bc7e695e`-Datei (das Original-Artefakt
  aus der Diagnose) durch die **echte** `detectSessionTransitions` → sauberer Rekey
  `d985ef73 → bc7e695e (clear)`, `rekeyMcpServer` + `session-forked` gefeuert, Map
  umgekeyt. Harness: `.claude/scratchpad/verify-real-clear.js` (gitignored, bei
  Bedarf neu ausführbar).

### Live-Test-Fallstrick (WICHTIG, falls wir nochmal ran müssen)

Der Klick-durch-Live-Test in der App ließ sich **nicht** reproduzieren — aus einem
Grund, der **nichts** mit der Fix-Logik zu tun hat: **aus der Dev-Instanz
(`npm start`) gespawnte Claude-Sessions schrieben kein `.jsonl`-Transcript nach
`~/.claude/projects`** (Session `7855ae79` voll interagiert — BUSY/IDLE-Turns, MCP
verbunden — aber **keine** Datei; `session-env/<id>` wurde angelegt, das Transcript
nie). Ohne neue Datei hat der Datei-Watcher nichts zu feuern → Detektor bleibt still.
Packaged-App-Sessions (bc7, d985) schrieben ihr jsonl normal. Ursache ungeklärt
(evtl. Dev-Instanz-Quirk: separates `SWITCHBOARD_DATA_DIR`, zwei parallele Instanzen;
oder Claude Code v2.1.199 Storage-Verhalten). **Konsequenz für künftige Live-Tests:**
- entweder in der **installierten (packaged)** App testen, **oder**
- zuerst prüfen, dass die Test-Session überhaupt ein `~/.claude/projects/<folder>/<id>.jsonl`
  schreibt (`hallo` + Antwort → Datei muss erscheinen), **bevor** `/clear`;
- Session muss **dev-owned** sein (id taucht im Instanz-Log auf) — Zwei-Fenster-
  Verwechslung war die zweite Zeitsenke.
Offline-Beweis (echte Datei durch echte Funktion) war am Ende aussagekräftiger als
der blockierte Live-Klick.

## Risiken / offene Fragen

- **Zuordnungsheuristik** ist der einzige weiche Punkt — MCP-Reconnect-Announce
  (Alternative) klären, um sie langfristig zu ersetzen.
- **`/compact`**: erzeugt es eine neue sessionId in derselben PTY? Wenn ja, gleicher
  Fix; Evidenz fehlt noch.
- **`bc7`-Altlast:** bereits verwaiste, unassoziierte Clear-Sessions werden erst mit
  dem nächsten `/clear` sauber; für laufende Fehlzuordnungen ggf. einmaliger
  Reconcile beim Watcher-Start (nice-to-have, nicht Kern).
