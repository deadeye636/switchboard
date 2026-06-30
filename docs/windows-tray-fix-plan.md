# Windows-TrayIcon-Fix — Plan

> **[← Roadmap](ROADMAP.md)** · Stand 2026-06-30 · Status: 🔵 Backlog (#18) · Prio P1 (Bug)

**Symptom:** Unter Windows zeigt das Tray-Icon **nichts** (leerer Platz im Tray).
Menü/Tooltip funktionieren, nur das Bild fehlt.

## Ist-Zustand

- `createTray()` lädt das Icon: `main.js:429`
  `nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'))`, dann
  `resize({width:18,height:18})` (`main.js:430`), Fallback `createEmpty()` (`:432`).
- Tray-Instanz: `main.js:435`. Aufruf `createTray()`: `main.js:2309`.
- Keine `process.platform`-Verzweigung, kein Template-Image — Code ist plattform-neutral.
- Assets existieren im Repo: `build/icon.png`, `build/icon.ico`, `build/icons/16x16.png` u.a.

## Root Cause (Ranking)

1. **`build/` wird nicht ins Paket aufgenommen** (Hauptursache).
   `package.json` → `build.files` (`package.json:63–68`) listet nur
   `*.js`, `workers/**`, `public/**`, `node_modules/**` — **nicht** `build/**`.
   - Dev: `__dirname` = Projektwurzel → `build/icon.png` da → Icon sichtbar.
   - Gepackt (ASAR): `__dirname` = `…/resources/app(.asar)` → `build/icon.png`
     **fehlt** → `createFromPath` liefert leeres Image → `createEmpty()`-Fallback →
     **leerer Tray**.
2. **18×18 ungewöhnlich** für Windows (erwartet 16×16 oder 32×32) — sekundär.
3. **`.png` statt `.ico`** — unter Windows konventionell `.ico`, aber PNG geht meist.

## Fix

**Kern (löst #1):** Icon mit ins Paket nehmen.

- Option A (empfohlen): `package.json` → `build.files` um `"build/icon.*"` (oder
  `"build/**/*"`) ergänzen. Damit liegt das Icon im ASAR, `__dirname/build/icon.png`
  resolved auch gepackt.
- Option B: `build.extraResources` für `build/icon.png` + im Code Pfad über
  `process.resourcesPath` auflösen (mehr Code, nicht nötig wenn A reicht).

**Robustheit (löst #2/#3, klein):**

- Windows gezielt `build/icon.ico` (oder `build/icons/16x16.png`) laden; `resize` auf
  16×16 statt 18×18.
- Nach dem Laden `trayImage.isEmpty()` prüfen und **loggen**, statt still auf
  `createEmpty()` zu fallen — macht künftige Fehlpfade sichtbar (`main.js:431`).

## Schritte

1. `package.json:63` `files` um `"build/icon.*"` erweitern.
2. `main.js:429` plattform-bewusst: Windows → `icon.ico`/16×16, sonst wie bisht;
   `resize` 16×16; bei leerem Image `log.error` statt stillem Fallback.
3. `npm run build:win` (per CLAUDE.md: `unset NoDefaultCurrentDirectoryInExePath`),
   Installer ausführen, Tray prüfen.

## Verify

- **Gepackt** (entscheidend, nicht nur `npm start`): Installer aus `dist/` starten →
  Tray zeigt Icon, Tooltip/Menü ok.
- `npm test` bleibt grün (keine Test-Logik betroffen).
- Regression macOS/Linux: Tray weiterhin sichtbar (Pfad-Änderung darf dort nicht brechen).
