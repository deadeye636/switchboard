<!--
  Detailplan — von Hand pflegen. saved-variables-plan.html ist Generat
  (scripts/build-docs.js, `npm run docs:build`, pre-commit). Das .html NICHT editieren.
-->

# Plan #47 — Saved Variables (mit Insert-Template)

**Status:** In Umsetzung · **Quelle:** brianstanley `d1d5ef1` (Basis-Panel) · Branch `port/saved-variables`

## Ziel

Benannte, wiederverwendbare Werte (optional **secret**, verschlüsselt at-rest) zentral pflegen
und schnell in Terminal-Sessions einfügen — inkl. eines **LLM-schonenden** Wegs, Secrets zu
*referenzieren* statt sie im Klartext in den Prompt zu schreiben.

## Datenmodell (`db.js`)

Tabelle `saved_variables` (Top-Level `CREATE TABLE IF NOT EXISTS`, kein Migrations-Array):

| Spalte | Zweck |
|---|---|
| `id` TEXT PK | UUID |
| `name` TEXT | Anzeigename |
| `value` TEXT | Wert (bei secret: `safeStorage`-verschlüsselt, base64) |
| `valueEncoding` | `plain` \| `safe-storage` |
| `secret` INTEGER | 0/1 |
| `scope` TEXT | `global` \| `project` |
| `projectPath` TEXT | bei project-Scope |
| `tags` TEXT | JSON-Array |
| **`insertTemplate` TEXT** | **NEU** — bestimmt, *wie* eingefügt wird (Platzhalter, s.u.) |
| `createdAt`/`updatedAt`/`lastUsedAt` | Zeitstempel |

`insertTemplate` idempotent per `ALTER TABLE … ADD COLUMN` nachrüsten (für bereits angelegte
Dev-DBs), zusätzlich in der `CREATE TABLE`-Definition.

## Oberflächen

### Management-Tab (session-unabhängig)
Sidebar-Tab `data-tab="variables"` (`public/variables-admin.js`, Container `#variables-admin-content`):
CRUD-Tabelle aller Variablen, Scope-Dropdown (All/Global/je Projekt), Filter, New/Edit/Delete/Copy.
Secret-Wert maskiert (`-webkit-text-security`) + **Augen-Toggle**. Kein Insert/Send hier.
Formular bekommt zusätzlich **Insert-template-Feld** + **Preset-Dropdown**.

### Session-Quick-Pick + Context-Menu
Terminal-Header-Schlüssel-Icon → Quick-Pick-Popover (`public/variables-panel.js`): Liste
(Global/Project), pro Zeile **Insert / Send / Copy**. Rechtsklick-Menü `Variables ▸ Global/Project ▸ …`
fügt ebenfalls ein. „Manage…" öffnet den Tab.

## Insert-Template (Kern)

Jede Variable hat ein optionales **Insert-Template** (Freitext) mit Platzhaltern:

| Platzhalter | Ersetzt durch |
|---|---|
| `{path}` | Pfad einer 0600-Temp-Datei mit dem (entschlüsselten) Value |
| `{ref}` | shell-gerechte Substitution des Datei-Inhalts: bash/zsh `"$(cat '<path>')"`, pwsh `(Get-Content -Raw '<path>')` |
| `{value}` | Rohwert (nur sinnvoll bei nicht-secret) |

**Default bei leerem Template:** secret → `{ref}`, nicht-secret → `{value}` (= bisheriges Verhalten).

**Presets** (füllen das Feld vor, frei überschreibbar):
- SSH key → `-i '{path}'`
- MySQL → `--defaults-extra-file='{path}'`
- Postgres service → `PGSERVICEFILE='{path}' PGSERVICE=<name>`
- Postgres .pgpass → `PGPASSFILE='{path}'`
- API Bearer → `Bearer $(cat '{path}')`
- Path only → `{path}`
- Shell value → `{ref}`

**Beispiel (Postgres):** Value = libpq-Service-Datei (`[mydb]` host/user/password …),
Template `PGSERVICEFILE='{path}' PGSERVICE=mydb` → Insert liefert
`PGSERVICEFILE='C:\…\secret-refs\<uuid>' PGSERVICE=mydb`. psql liest die Creds selbst; Agent
sieht nur Pfad + Query-Ergebnis.

## Auflösung & IPC

Ein Handler löst den Insert **im Main-Prozess** auf (Klartext verlässt Main nur, wenn das
Template `{value}` nutzt):

`resolve-variable-insert(id, shellType)`:
1. Row holen, Value entschlüsseln (`decryptSavedVariableValue`).
2. Template = `insertTemplate` (getrimmt) sonst Default (`{ref}`/`{value}`).
3. Braucht das Template `{path}`/`{ref}` → Temp-Datei materialisieren (`<userData>/secret-refs/<uuid>`,
   `mode 0o600`, in `secretRefFiles` tracken).
4. `{ref}` → shell-Ref; bei **cmd/unknown/WSL** kein Inline-Ref möglich → `{ ok:false, fallback:'copy', value }`.
5. Platzhalter ersetzen, `{ ok:true, text }` zurück.

`get-shell-type(projectPath)` ermittelt den Shell-Typ (bestehend). Renderer (Quick-Pick +
Context-Menu) fügt `text` ein bzw. kopiert bei `fallback:'copy'` + Toast. **Copy** kopiert immer
den Rohwert. Ersetzt die bisherigen `materialize-secret-ref`/direkter-Rohwert-Pfade.

## Temp-Datei-Cleanup
`secretRefFiles`-Set. TTL-Sweep (30 min) bei jedem Materialize, Voll-Wipe bei **before-quit**
**und bei Startup** (`whenReady`, gegen Crash-Reste). Verzeichnis on-demand.

## Sicherheitsmodell & Grenzen
- Klartext geht nur bei `{value}`-Templates in den Prompt (bewusst, nicht-secret).
- `{path}`/`{ref}` halten den Wert aus dem eingefügten Text; das **Tool bzw. die Shell** liest die
  Datei lokal — nicht das LLM.
- **Restgrenze:** ein Agent *kann* die Datei trotzdem `cat`en → dann Leak. Prompt-Regel: „Pfad an
  das Tool geben, Datei nicht öffnen." **Harte Garantie** nur via Wrapper-Script (liest Datei selbst,
  gibt nur Ergebnis zurück) — optionaler Folgeschritt.

## Dateien
`db.js`, `main.js` (`resolve-variable-insert`, Materialize/Cleanup), `preload.js`,
`public/variables-admin.js` (Template-Feld + Presets), `public/variables-panel.js` (Quick-Pick-Insert),
`public/terminal-context-menu.js` (Insert-Pfad). Tests: `saved_variables` DB-Roundtrip, Template-Substitution
(reiner Helfer, testbar).

## Bewusst nicht (v1)
- Kein Wrapper-Script-Generator (harte Garantie) — Folgeschritt.
- Kein Env-Injection beim Session-Start (das ist #50, Per-Session API-Key-Override).
