<!--
  Detailplan — von Hand pflegen. afk-timeout-setting-plan.html ist Generat
  (scripts/build-docs.js, `npm run docs:build`, pre-commit). Das .html NICHT editieren.
-->

# Plan #51 — AFK-Timeout je Session steuern (`CLAUDE_AFK_TIMEOUT_MS`)

**Status:** Erledigt · **Prio:** P3 · **Branch:** `feat/afk-timeout-setting`

> **Umsetzungs-Abweichung vom Plan:** Statt der Worte `off`/`never` ist **`0` = never**
> (→ `2147483647`). Leer = erben/Default (60 s), negativ/ungültig = leer. Die Kaskade
> (leer=erben) wird **direkt beim PTY-Spawn** in `main.js` aufgelöst (nicht über den
> generischen `get-effective-settings`-Merge, der leere Projekt-Werte fälschlich
> überschrieben und andere String-Keys getroffen hätte). Pure Helfer in `afk-timeout.js`
> (`afkTimeoutToEnvMs`/`resolveAfkTimeoutSec`/`normalizeAfkInput`), Tests
> `test/afk-timeout.test.js`. UI-Feld global+projekt (`settings-panel.js`) + Per-Session
> im Configure-Dialog (`dialogs.js`, `#nsd-afk-timeout`). `[afk]`-Log bei Injection.

## Ziel

Den AskUserQuestion-Auto-Continue von Claude Code (Timeout, nach dem der Agent ohne
Antwort „mit best judgment" weiterläuft) pro **aus Switchboard gestarteter** Session
steuerbar machen — mit Kaskade **Global → Projekt → Session**. Umgesetzt über die
Env-Var `CLAUDE_AFK_TIMEOUT_MS`, die Switchboard beim PTY-Spawn in die Claude-Session
injiziert.

## Hintergrund

- Claude Code (ab v2.1.198) bricht `AskUserQuestion` nach **60 s** (Default `60000` ms)
  automatisch ab und läuft ohne Nutzerantwort weiter.
- Steuerbar nur über zwei **undokumentierte** Env-Vars: `CLAUDE_AFK_TIMEOUT_MS` (ms bis
  Auto-Continue) und `CLAUDE_AFK_COUNTDOWN_MS` (ms vorher für das Banner). Kein
  `/config`-Runtime-Schalter (laut Maintainer erst später, Default dann aus).
- Env nicht gesetzt → Claude-Default 60 s. `0` schaltet **nicht** ab, sondern feuert
  sofort. „Nie" = großer Int, praktisch `2147483647`.

Switchboard spawnt Claude-Sessions selbst per node-pty und setzt heute schon Env je
Session (`FORCE_COLOR`, `CLAUDE_CODE_SSE_PORT` etc.) — genau der Hebel, um den Timeout
**per Session** zu setzen, was ein Shell-Export nicht zuverlässig kann.

## Kaskade & Semantik

Ein Wert je Scope, engster gewinnt. **Leer = erben** (kein Scope gesetzt → Claude-Default).

| Scope | Speicher | Leer bedeutet |
|-------|----------|---------------|
| Global | `settings`-Tabelle, Key `global` | Claude-Default (60 s) |
| Projekt | Key `project:<projectPath>` | Global-Wert erben |
| Session | `sessionOptions.afkTimeoutMs` (New-Session-Popover) | Projekt/Global erben |

Wert-Bedeutung (ein Feld):

| UI-Eingabe | Env-Wirkung |
|------------|-------------|
| leer | `CLAUDE_AFK_TIMEOUT_MS` **nicht gesetzt** → Claude-Default 60 s |
| Zahl (Sekunden, z. B. `120`) | `CLAUDE_AFK_TIMEOUT_MS=120000` |
| „Off / never" | `CLAUDE_AFK_TIMEOUT_MS=2147483647` |
| `0` | **nicht anbieten** (feuert sofort) — UI blockt/normalisiert |

## Umsetzung

### 1. Setting-Key + Default (`main.js`)
- `SETTING_DEFAULTS` (main.js:1829) um `afkTimeoutSec: ''` (leer = erben/Default) ergänzen.
  Speicherung in **Sekunden** (nutzerfreundlich), Umrechnung auf ms erst bei der Injection.
- `get-effective-settings` (main.js:1849) merged bereits pro Key defaults→global→project —
  **kein Merge-Code nötig**, Key wird automatisch mitgezogen.

### 2. Per-Session-Override (`public/dialogs.js`, `preload.js`)
- `resolveDefaultSessionOptions()` (dialogs.js:7) zieht `afkTimeoutSec` aus den effective
  settings in `sessionOptions`.
- New-Session-Popover: optionales Feld „AFK timeout" (leer = inherit) → überschreibt für
  diese eine Session. Feld reiht sich in die bestehenden `sessionOptions` ein
  (type/permissionMode/… , main.js:2084) — keine neue IPC-Binding nötig.

### 3. Env-Injection beim Spawn (`main.js`)
- Reiner Helfer `afkTimeoutToEnvMs(sec)` → `string | null` (leer/ungültig → `null`;
  `'off'`/`'never'` → `'2147483647'`; Zahl → `sec*1000`). **Testbar, ohne Electron.**
- Im Claude-`ptyEnv` (main.js:2289): resolved Wert = Session-Override ?? effective(global/
  project). Wenn `!= null`: `ptyEnv.CLAUDE_AFK_TIMEOUT_MS = value`. Sonst **nicht setzen**.
- **`cleanPtyEnv`-Basis härten** (main.js:32): `CLAUDE_AFK_TIMEOUT_MS` (und
  `CLAUDE_AFK_COUNTDOWN_MS`) aus dem geerbten `process.env` strippen, damit ein Shell-Leak
  der Switchboard-Umgebung nicht heimlich durchschlägt → Switchboard-Setting ist autoritativ,
  „leer" heißt wirklich Claude-Default.

### 4. UI (`public/settings-panel.js`, `public/style.css`)
- Feld in Gruppe **„Sessions & CLI"**, für Global- **und** Projekt-Scope (bestehende
  `isProject`-Zweige, Scope-Read settings-panel.js:32, Save :1121).
- Label EN: „AskUserQuestion timeout (seconds)", Placeholder „inherit / default (60)",
  Kurzhilfe: leer = Claude default, „off" = never auto-continue. `0` normalisieren/verbieten.
- Optional später: zweites Feld für `CLAUDE_AFK_COUNTDOWN_MS` (Banner-Vorlauf) — **out of
  scope** für v1.

### 5. Tests (`test/afk-timeout.test.js`)
- `afkTimeoutToEnvMs`: leer→null, `'120'`→`'120000'`, `'off'`/`'never'`→`'2147483647'`,
  `'0'`→null (oder Fehler), Nicht-Zahl→null.
- Kaskaden-Resolution Session-Override ?? project ?? global ?? leer.

## Dateien

`main.js` (SETTING_DEFAULTS, cleanPtyEnv, ptyEnv-Injection, Helfer), `public/dialogs.js`
(sessionOptions), `public/settings-panel.js` + `public/style.css` (Feld global+project),
ggf. `preload.js` (nur falls sessionOptions-Passthrough erweitert werden muss), neu
`test/afk-timeout.test.js`.

## Bewusst nicht

- Kein Schreiben in `~/.claude/settings.json` (globaler `env`-Block) — Switchboard steuert
  nur die von ihm **selbst** gestarteten Sessions; extern gestartete Claude-Prozesse bleiben
  unberührt. (Wer global will, trägt `env.CLAUDE_AFK_TIMEOUT_MS` selbst in die settings.json.)
- Kein `/config`-Runtime-Toggle (in Claude Code noch nicht vorhanden).
- `CLAUDE_AFK_COUNTDOWN_MS` (Banner-Vorlauf) erst in einem Folgeschritt.

## Risiken / Nuancen

- **Nur Switchboard-Sessions** betroffen — extern gestartete nicht (by design).
- Teilt sich den **PTY-Env-Injection-Hebel** mit #50 (Per-Session API-Key-Override,
  `ANTHROPIC_API_KEY` in `open-terminal`/`ptyEnv`) — gemeinsame Stelle `main.js:2289`.
  Beide Features gleichartig verdrahten; bei paralleler Umsetzung Merge-Konflikt an dieser
  Stelle erwartbar.
- Der bekannte Env-vs-settings.json-Precedence-Bug (CC Issue #8500) ist hier **irrelevant**:
  wir setzen die Prozess-Env der PTY direkt, es gibt keinen konkurrierenden settings.json-
  `env`-Block in dieser Session.
- Werte sind versionsabhängig (undokumentierte Env-Var) — bei künftigem `/config`-Support
  ggf. auf offiziellen Schalter umstellen.
