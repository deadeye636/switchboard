# Windows-Build (NSIS-Installer)

Anleitung zum Bauen des Windows-Installers für Switchboard auf dieser Maschine
(VS 2026 / Visual Studio Build Tools, x64). Stand: 2026-07-31.

## TL;DR

```bash
unset NoDefaultCurrentDirectoryInExePath && npm run build:win
```

Ergebnis: `dist/Switchboard Setup <version>.exe` (NSIS) + entpackter `dist/win-unpacked/`.

Das `unset` ist der **einzige** manuelle Schritt pro Shell. Die beiden anderen
historischen Stolpersteine (node-gyp-Version, node-pty-Spectre) sind dauerhaft im
Repo verankert und brauchen kein manuelles Zutun mehr.

## Voraussetzungen

- **Node.js** (gleiche Major wie in `package.json`/CI; Electron 41 ABI).
- **Visual Studio 2026 Build Tools** mit C++-Desktop-Workload (für native Module
  `better-sqlite3`, `node-pty`).
- **Python** (von node-gyp benötigt).
- Ziel-Architektur: **x64** (arm64-Toolchain hier nicht verfügbar).

## Die drei Stolpersteine — Ursache & Lösung

### 1. node-gyp ≥ 13 (VS 2026 = MSVC major 18)

Ältere node-gyp erkennt VS 2026 (Toolset major 18) nicht und bricht die native
Kompilierung ab.

**Lösung (durable):** in `package.json`:
```json
"overrides": { "node-gyp": "13.0.0" }
```
Erzwingt node-gyp 13 für alle transitiven Abhängigkeiten. **Nicht entfernen.**

### 2. node-pty Spectre-Mitigation (MSB8040)

node-pty fordert in `binding.gyp` `SpectreMitigation: 'Spectre'`. Sind die
Spectre-gehärteten MSVC-Runtime-Libs nicht installiert → Build bricht mit
**MSB8040** ab. Wir bauen ohne Spectre-Mitigation (Desktop-App, lokales PTY — kein
relevantes Spectre-Angriffsmodell).

**Lösung (durable):** `patches/node-pty+1.2.0-beta.14.patch` setzt an **einer** Stelle
`SpectreMitigation: 'false'`:
- `node_modules/node-pty/binding.gyp` (1×)

Seit node-pty 1.2.x ist **winpty aus dem Paket verschwunden** — die beiden früheren
Patch-Stellen in `deps/winpty/src/winpty.gyp` gibt es nicht mehr.

**Der Patch hängt am Dateinamen und damit an der exakten Version.** `package.json`
pinnt `"node-pty": "^1.2.0-beta.14"` — ein Caret auf einem Prerelease, das npm auch
mit `1.2.0` final erfüllt. Ein beiläufiges `npm update` entpatcht den Windows-Build
also **still**, und er kommt als MSB8040 zurück. Nach jedem Versionswechsel:
Patch neu erzeugen (unten) und die alte Datei löschen.

Der Patch wird durch den **`postinstall`-Hook** automatisch reappliziert:
```json
"scripts": { "postinstall": "patch-package && node scripts/postinstall.js && node scripts/ensure-conpty-dll.js" }
```
(`ensure-conpty-dll.js` kopiert node-ptys gebündelte `conpty.dll` an ihren Platz —
läuft zusätzlich als electron-builder-`beforePack`-Hook, siehe unten.)
→ überlebt jedes `npm install`. **Patch und postinstall-Hook nicht entfernen.**

Verifizieren, dass node_modules aktuell gepatcht ist:
```bash
grep -c "false" node_modules/node-pty/binding.gyp
# erwartet: 1
```

### 2b. Warum node-pty auf einem Beta-Kanal läuft

node-pty 1.1.0 greift aus dem Watcher-Thread jedes PTYs **ohne Lock** auf seine globale
Handle-Tabelle zu, während der JS-Thread anhängt. Der Vektor kann mitten in einer
Iteration umkopiert werden — und das Entfernen, das seinen eigenen Erfolg assertiert,
schlägt dann fehl: ein nativer **`Assertion failed!`**-Dialog mit Abort/Retry/Ignore,
über dem Use-after-free, vor dem er warnt.

Upstream hat das in **1.2.0-beta.13** behoben (Mutex um die Tabelle, `std::erase_if`
statt des assertierenden Entfernens). `latest` ist weiterhin 1.1.0 und liegt davor —
der Fix existiert nur im Beta-Kanal, und VS Code liefert aus demselben Grund von dort
(`"node-pty": "^1.2.0-beta.13"`).

**Kein Ausweg ist `NDEBUG`**: das Assert trägt das Entfernen als Argument, der Aufruf
fiele mit weg — aus einem lauten Absturz würde ein stiller Use-after-free plus
Handle-Leak.

Patch nach node-pty-Update neu erzeugen (falls Version wechselt → neuer
Patch-Dateiname `node-pty+<neue-version>.patch`):
```bash
# node_modules/node-pty/*.gyp von Hand auf SpectreMitigation:'false' setzen, dann:
npx patch-package node-pty
git add patches/ && # commit
```

### 3. `NoDefaultCurrentDirectoryInExePath` (per-Shell, nicht patchbar)

Ist diese Env-Variable gesetzt, schlug winptys gyp-`.bat`-Zwischenschritt fehl
(findet relativ aufgerufene Tools nicht im CWD). Das ist eine Laufzeit-Env, kein
Datei-Patch → muss pro Shell vor dem Build entfernt werden:

> **Ungeprüft seit node-pty 1.2.x:** die genannte Ursache — winptys `.bat`-Schritt —
> **existiert nicht mehr**, winpty ist aus dem Paket verschwunden und `binding.gyp`
> hat keinen solchen Zwischenschritt. Ob der Workaround noch nötig ist, beantwortet
> erst ein Build mit gesetzter Variable. Bis dahin stehen lassen: falsch-positiv
> kostet ein `unset`, falsch-negativ einen rätselhaften Buildbruch.

```bash
unset NoDefaultCurrentDirectoryInExePath && npm run build:win
```

(Bewusst **nicht** ins `build:win`-Script gezogen: `unset` ist bash-Syntax, npm
führt Scripts auf Windows je nach Konfiguration in cmd/sh aus — der Wrapper wäre
nicht zuverlässig portabel. Manuelles Voranstellen ist robuster.)

## Build-Schritte im Detail

`npm run build:win` =
1. `node scripts/gen-build-info.js` — stempelt `build-info.json` (Branch/Commit/
   dirty/Datum) für die About-Anzeige (gitignored).
2. `npm run bundle:codemirror` — esbuild bündelt `src/renderer/jsonl/codemirror-setup.js` →
   `src/renderer/codemirror-bundle.js` (gitignored).
3. `electron-builder --win` — native Module gegen Electron-ABI rebuilden
   (node-gyp 13 + gepatchte node-pty-gyps), dann NSIS-Installer packen. Der
   `beforePack`-Hook `scripts/ensure-conpty-dll.js` kopiert node-ptys gebündelte
   `conpty.dll` neben den lokalen node-pty-Build (der Rebuild beim Packen wischt
   `build/Release`, darum reicht der postinstall-Lauf allein nicht — #114).

## Troubleshooting

| Symptom | Ursache | Fix |
|---|---|---|
| `MSB8040` Spectre libs | node-pty-Patch nicht appliziert | `npx patch-package` bzw. `npm install` (postinstall) |
| gyp `.bat`-Schritt failt mit Pfad-Fehler | `NoDefaultCurrentDirectoryInExePath` gesetzt | `unset …` vor dem Build |
| node-gyp erkennt VS nicht / Toolset-Fehler | node-gyp < 13 | `overrides`-Eintrag prüfen, `npm install` |
| Patch applied nicht (Version-Mismatch) | node-pty-Version ≠ Patch-Dateiname | Patch neu erzeugen (siehe oben) |

## Offen / nicht gemacht

- **Code-Signing**: Windows-Installer wird **nicht signiert** (kein Zertifikat).
- **CI**: kein automatisierter Windows-Build (kein eigenes GitHub-Hosting; siehe
  Katalog Section 5).
