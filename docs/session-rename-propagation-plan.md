<!--
  Detailplan zu Roadmap #60. Von Hand pflegen; das HTML-Generat
  (session-rename-propagation-plan.html) wird via npm run docs:build erzeugt —
  NICHT von Hand editieren.
-->

# Plan #60 — Rename schlägt schneller & zuverlässig auf Switchboard durch

> **[← Roadmap](ROADMAP.md)** · Status: **Erledigt** · Fix in `session-cache.js` + `main.js`

## Problem

Ein Rename (Claude `/rename` → JSONL-Zeile `{"type":"custom-title",…}`) landet in
Switchboard **verspätet oder gar nicht** in der Sidebar.

Zwei Ursachen:

1. **Zwei gestapelte Debounces.** fs.watch → Watcher-Debounce (`main.js`:
   `DEBOUNCE_MS=500`, `MAX_WAIT_MS=2500`) → `flushChanges` → `refreshFile` →
   Reindex-Debounce (`session-cache.js`: `REINDEX_DEBOUNCE_MS=800`,
   `REINDEX_MAX_WAIT_MS=3000`). Stapeln sich: idle ~1,3 s, busy **bis ~5,5 s**.
2. **Fehlender Notify (der eigentliche Bug).** Das `setName(customTitle)` läuft im
   **verzögerten** `scheduleReindex`-Callback von `refreshFile`. Dieser notifizierte
   den Renderer **nicht**; `notifyRendererProjectsChanged()` feuerte vorher in
   `flushChanges` (mit noch altem Namen). Ergebnis: Name steht in der DB, aber die
   Sidebar erfährt es erst beim nächsten fremden `projects-changed` — bei einer
   idle-Session (nach Rename passiert nichts) **nie**.

**Verifiziert (2026-07-03):** Session `e85d7964` — jsonl enthält
`"customTitle":"Fix_PTY_Pos"` (der Rename ist da; CC schreibt sauber, Switchboard
liest ihn). Also reines Propagations-/Latenz-Problem, nicht CC-seitig.

## Ist-Zustand (verankert)

- **Namens-Präzedenz** (`session-cache.js` `sessionName`): `session_meta.name`
  (Switchboard-Rename **oder** promoteter customTitle) > `customTitle` (Claude
  `/rename`) > `aiTitle` (auto) > `summary` (erster User-Prompt).
- `customTitle` wird via `setName` in `session_meta.name` promotet —
  `ON CONFLICT DO UPDATE SET name=excluded.name` (`db.js:388`, bedingungsloses
  Überschreiben). Cache speichert `aiTitle`, **nicht** `customTitle`.
- **Kein CC-Rename-Hook-Event** (Events: Pre/PostToolUse, UserPromptSubmit,
  Notification, Stop, SubagentStop, SessionStart/End, PreCompact) → ein Rename lässt
  sich **nicht direkt** pushen.
- Switchboard installiert HTTP-Hooks (`main.js` `writeClaudeAttentionHook`) für
  **`Stop`** + **`Notification`** → CC POSTet bei dem Event **sofort** an
  `127.0.0.1:<port>` (opt-in `global.attentionHooks`). Das ist der einzige instantane
  Kanal.

## Fix

### 1 — Notify-Gap schließen (Pflicht)
`refreshFile`s Reindex-Callback: effektiven Namen **vor** dem Schreiben merken
(`getMeta(id).name`), nach `setName` erneut lesen; bei Änderung
`notifyRendererProjectsChanged()`. Gate auf Name-Änderung → keine Re-Render-Flut bei
Busy-Sessions (respektiert den Perf-Indexing-Fix). Damit kommt der Rename überhaupt
zuverlässig an — auch bei idle-Sessions.

### 2 — Stop-Hook Fast-Path (der „Trigger")
Der Attention-Hook-HTTP-Server (`main.js` `startAttentionHookServer`) bekommt bei
jedem Stop/Notification-POST `session_id`. Dort die Session **sofort** refreshen —
`refreshFile(folder, id+'.jsonl', { immediate:true })` — statt über beide Debounces.
`immediate` läuft den Reindex **inline** (`cancelReindex` + direkter Read/Write).
Session→Folder-Mapping über `activeSessions` (`get(id)` bzw. `realSessionId===id`).
→ Rename zeigt sich **im Moment des Turn-Endes** statt nach Sekunden.

## Grenzen (bewusst)

- Fix 2 greift nur für **Switchboard-eigene** Sessions (via `activeSessions`
  mappbar) **und** wenn Attention-Hooks an sind (opt-in).
- Ein nacktes `/rename` **ohne** Folge-Turn in einer idle-Session hat kein
  Stop-Event → bleibt beim Watcher; dank Fix 1 kommt es an, nur debounced
  (~1,3 s). Für den instant-Fall bräuchte es einen CC-Rename-Hook (existiert nicht)
  oder einen Titel-Fast-Path im Watcher (#3, optional, nicht umgesetzt).

## Dateien

- `session-cache.js` — `refreshFile`: `opts.immediate` + Notify bei Name-Änderung.
- `main.js` — Attention-Hook-Handler: Sofort-Refresh der gemappten Session.

## Offen / Folgeschritte

- **#3 (optional):** Titel-Fast-Path im Watcher — geänderte jsonl mit neuer
  `custom-title` im Tail → beide Debounces überspringen, deckt `/rename`-ohne-Turn.
- **aiTitle-Notify-Gap:** gleiche Lücke gilt für `ai-title`-only-Änderungen (kein
  Rename, niedrigere Prio) — hier bewusst nicht behandelt.
