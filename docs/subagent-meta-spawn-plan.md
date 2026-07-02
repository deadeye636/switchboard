<!--
  Detailplan zu Roadmap #43. Von Hand pflegen; das HTML-Generat
  (subagent-meta-spawn-plan.html) wird via npm run docs:build erzeugt —
  NICHT von Hand editieren.
-->

# Plan #43 — Subagent-Spawn über `.meta.json` erkennen (nicht nur `.jsonl`)

> **[← Roadmap](ROADMAP.md)** · Status: **Backlog (P3)** · Umsetzung später

## Problem & Ziel

Switchboard erkennt Subagents **ausschließlich über ihr `.jsonl`-Transcript**
(`detectSubagentTransitions` + `enumerateSessionFiles` scannen nur
`<parent>/subagents/*.jsonl`). Claude Code schreibt aber **beim Spawn** sofort
`<parent>/subagents/agent-<id>.meta.json`, das `.jsonl` **erst wenn der Agent
Output produziert**. Ein Agent, der gespawnt wird, aber nicht bis zum Output
läuft (queued und dann Parent-Turn endet/unterbrochen), hat **nur `meta.json`**
→ Switchboard sieht ihn nie.

**Ziel:** Subagent-**Spawn** über die `meta.json` erkennen und den Agent
sichtbar machen (Name/Typ aus meta), bevor/ohne dass ein Transcript existiert;
sobald das `.jsonl` kommt, auf die volle Row upgraden.

## Evidenz (2026-07-02)

- Session `876c2b28` (Projekt `Z--Example-Project`), „Feldtexte W6 Gruppe 1-6".
- W6-Agents: nur `agent-<id>.meta.json`, **kein** `.jsonl` (nirgends in `~/.claude`).
- Die meta ist **strukturell identisch** zu lauffähigen W5-Agents:
  `{"agentType":"general-purpose","description":"Feldtexte W6 Gruppe 2","toolUseId":"toolu_…","spawnDepth":1}`.
- Parent-`.jsonl` zuletzt **22:26:15**, W6-Spawns **22:28-29** → Parent-Turn endete
  vor dem Lauf → Agents produzierten nie Output.
- **Kein** „Background-Agents"-Sonderformat; **kein** Datenverlust — reine Sichtbarkeit.

## Ist-Zustand (verankert)

- `read-session-file.js` `enumerateSessionFiles` → liefert `{filePath, sessionId,
  parentSessionId}` **nur** für `.jsonl` (top-level + `subagents/*.jsonl`).
- `read-session-file.js` `readSessionFile` → braucht `sidechainSeen` + ≥1 Message,
  sonst `null` (ein meta-only Agent hätte eh kein parsebares Transcript).
- `session-transitions.js` `detectSubagentTransitions` → Spawn/Complete-Signale
  aus dem Live-Watcher, `.jsonl`-basiert.
- `session-cache.js` `refreshFile`/`refreshFolder` → indexen `.jsonl` in
  `session_cache` (Subagent-Row mit `parentSessionId`, `agentId`, `subagentType`,
  `description`).
- `public/sidebar.js` → nistet Subagent-Rows per `parentSessionId` unter dem Parent.

## Design

### 1. Meta-Sidecars enumerieren
`enumerateSessionFiles` (oder eine Schwester-Funktion) zusätzlich
`subagents/*.meta.json` **ohne** passendes `agent-<id>.jsonl` ausgeben, als
`{metaPath, sessionId: sub:<parent>:<id>, parentSessionId, metaOnly:true}`.

### 2. Placeholder-Row aus meta
In `session-cache.js` einen **schlanken** Subagent-Row aus der meta bauen:
`sessionId = sub:<parent>:<id>`, `parentSessionId`, `subagentType = agentType`,
`summary/description = description`, **kein** `textContent`/`messageCount`,
Flag `status:'spawned'` (bzw. `noTranscript:true`). Kein FTS-Body (leer).

### 3. Upgrade bei `.jsonl`
Sobald das `.jsonl` erscheint, greift der bestehende `refreshFile`-Pfad und
**überschreibt** den Placeholder mit der vollen Row (gleiche `sessionId` →
Upsert = Upgrade). **Wichtig:** die aus meta abgeleitete `sub:<parent>:<agentId>`
muss **exakt** der aus dem `.jsonl` abgeleiteten entsprechen (agentId aus
Dateiname `agent-<id>` bzw. `entry.agentId`), sonst Doppel-Rows.

### 4. Aging / Abbruch
Meta-only Agents ohne `.jsonl` können **dauerhaft** existieren (abgebrochen).
Regel: meta-only älter als **N Minuten** (z. B. 10) **ohne** `.jsonl` → Status
`abandoned`, ausgegraut oder ausgeblendet (Setting?). Verhindert Geister-Clutter.

### 5. UI (`public/sidebar.js`)
Placeholder unter dem Parent zeigen: Name aus `description`, Badge
„spawned"/„empty"/„abandoned", ausgegraut. Kein Klick-Ziel-Transcript (leer) →
Klick evtl. deaktiviert oder zeigt „kein Transcript".

## Nachteile & Mitigation

| Nachteil | Mitigation |
|---|---|
| **Geister-Subagents** (spawned-never-ran, permanent) | Aging (#4): meta-only > N min → `abandoned`/hide |
| **Kein Cleanup** der meta auf Disk | nicht Switchboards Aufgabe; nur Anzeige-Aging |
| **Mehr Index-/Watcher-Last** (jeder Spawn = Row; bei Storm viele) | **nicht** `.meta.json` separat watchen → im bestehenden Folder-Refresh/Reconcile mitnehmen; Placeholder-Row ist billig (kein FTS-Body) |
| **Dedup/Upgrade** Placeholder ↔ volle Row | strikt gleiche `sub:<parent>:<agentId>`; Upsert statt Insert |
| **UX-Rauschen** (leere Agents) | Aging + ausgegraut; ggf. Setting „leere Subagents zeigen" default aus |

## Dateien

- `read-session-file.js` — `enumerateSessionFiles` (meta-only ausgeben) / Helfer.
- `session-cache.js` — Placeholder-Row bauen + upgraden (`refreshFile`/`refreshFolder`/`buildProjectsFromCache`-Subagent-Nesting).
- `session-transitions.js` — `detectSubagentTransitions` optional auf meta erweitern (Live-Spawn-Signal).
- `public/sidebar.js` — Placeholder-Rendering (Badge, ausgegraut).
- ggf. `public/settings-panel.js` — Setting „leere/abgebrochene Subagents zeigen".

## Tests

- meta-only Agent → Placeholder-Row mit `description`/`agentType`, kein Transcript.
- `.jsonl` erscheint nachträglich → Row upgradet (kein Duplikat; gleiche `sessionId`).
- meta-only > N min → `abandoned`.
- agentId-Ableitung aus `agent-<id>.meta.json` == aus `.jsonl` (Dedup-Garantie).
- Storm: viele meta gleichzeitig → keine Doppel-Rows, Index-Last vertretbar.

## Risiken / offene Fragen

- Perf-Aufschlag bei Storm-Sessions (mild) — im Blick behalten nach der
  Indexing-Hotpath-Optimierung (#Perf).
- Anzeige-Semantik: „abgebrochen" vs „läuft noch" nicht immer sicher unterscheidbar
  (nur „meta da, jsonl fehlt, X min alt").
- Braucht Claude Code irgendwann doch ein Transcript nach? Dann upgradet es sauber.
