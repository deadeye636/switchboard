# Windows-Build (NSIS-Installer)

Anleitung zum Bauen des Windows-Installers für Switchboard auf dieser Maschine
(VS 2026 / Visual Studio Build Tools, x64). Stand: 2026-06-28.

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
  `better-sqlite3`, `node-pty`/winpty).
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

node-pty/winpty fordern in ihren `.gyp`-Dateien `SpectreMitigation: 'Spectre'`.
Sind die Spectre-gehärteten MSVC-Runtime-Libs nicht installiert → Build bricht mit
**MSB8040** ab. Wir bauen ohne Spectre-Mitigation (Desktop-App, lokales PTY — kein
relevantes Spectre-Angriffsmodell).

**Lösung (durable):** `patches/node-pty+1.1.0.patch` setzt an drei Stellen
`SpectreMitigation: 'false'`:
- `node_modules/node-pty/binding.gyp` (1×)
- `node_modules/node-pty/deps/winpty/src/winpty.gyp` (2×)

Der Patch wird durch den **`postinstall`-Hook** automatisch reappliziert:
```json
"scripts": { "postinstall": "patch-package && node scripts/postinstall.js" }
```
→ überlebt jedes `npm install`. **Patch und postinstall-Hook nicht entfernen.**

Verifizieren, dass node_modules aktuell gepatcht ist:
```bash
grep -c "false" node_modules/node-pty/binding.gyp node_modules/node-pty/deps/winpty/src/winpty.gyp
# erwartet: binding.gyp:1  winpty.gyp:2
```

Patch nach node-pty-Update neu erzeugen (falls Version wechselt → neuer
Patch-Dateiname `node-pty+<neue-version>.patch`):
```bash
# node_modules/node-pty/*.gyp von Hand auf SpectreMitigation:'false' setzen, dann:
npx patch-package node-pty
git add patches/ && # commit
```

### 3. `NoDefaultCurrentDirectoryInExePath` (per-Shell, nicht patchbar)

Ist diese Env-Variable gesetzt, schlägt winptys gyp-`.bat`-Zwischenschritt fehl
(findet relativ aufgerufene Tools nicht im CWD). Das ist eine Laufzeit-Env, kein
Datei-Patch → muss pro Shell vor dem Build entfernt werden:

```bash
unset NoDefaultCurrentDirectoryInExePath && npm run build:win
```

(Bewusst **nicht** ins `build:win`-Script gezogen: `unset` ist bash-Syntax, npm
führt Scripts auf Windows je nach Konfiguration in cmd/sh aus — der Wrapper wäre
nicht zuverlässig portabel. Manuelles Voranstellen ist robuster.)

## Build-Schritte im Detail

`npm run build:win` =
1. `npm run bundle:codemirror` — esbuild bündelt `public/codemirror-setup.js` →
   `public/codemirror-bundle.js` (gitignored).
2. `electron-builder --win` — native Module gegen Electron-ABI rebuilden
   (node-gyp 13 + gepatchte node-pty-gyps), dann NSIS-Installer packen.

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
