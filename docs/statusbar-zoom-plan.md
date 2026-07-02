<!--
  Detailplan für die Zoom-Schaltflächen in der Statusbar (#34). Von Hand gepflegt.
  Wird über ROADMAP.md (#34) verlinkt; roadmap.html + dieses .html-Generat via
  `npm run docs:build` (pre-commit). Das *.html ist Generat — nicht editieren.
-->

# Plan: Zoom-Schaltflächen in der Statusbar ("#34")

**Status:** Backlog #34 · Bearbeitung später · Scope mit User abgestimmt

## Kontext / Ziel

Unten rechts in der Statusbar (`#status-bar`) **zwei Zoom-Schaltflächen**:

1. **xterm-Zoom** — spiegelt die Terminal-Schriftgröße wider.
2. **Electron-Zoom** — spiegelt den UI-Zoom (ganze App) wider.

Zweck: Der User **sieht auf einen Blick**, was aktuell eingestellt ist, und kann direkt
verstellen. Beide Buttons zeigen den **aktuellen Wert live** und bieten +/−/Reset.

## Befund (geprüft am Code)

- **Statusbar** existiert: `#status-bar` mit `#status-bar-info` / `#status-bar-usage` /
  `#status-bar-activity` (`public/index.html:128`). Neue Buttons fügen sich rechts ein.
- **xterm-Zoom = persistent ✅** — `terminalFontSize` im global-Blob (Default 12, Range
  8–28). Speichern beim Zoomen (`persistTerminalFontSize`, `terminal-manager.js`), Restore
  beim Start (`app.js:2203`/`2322`), Zahlenfeld in Settings. Setter/Nudge vorhanden:
  `window._setTerminalFontSize`, `window._nudgeTerminalFontSize(delta)` (delta 0 = Reset).
  Zusätzlich Ctrl+Wheel / Ctrl +/−/0.
- **Electron-Zoom = NICHT persistent ❌** — nur Tastatur (`main.js:305–313`,
  `wc.setZoomLevel(±0.5)`, `0` = Reset). Nirgends gespeichert, kein Startup-Restore →
  springt bei jedem Neustart auf 0. Electron-Zoomfaktor = `1.2 ** zoomLevel`.

## Design

### A) Electron-Zoom persistent machen (Voraussetzung, damit Button 2 sinnvoll spiegelt)
- **Setting** `global.electronZoomLevel` (Default 0).
- **Startup-Restore** (`main.js`, nach Fenster-/Settings-Load): `wc.setZoomLevel(level)`.
- **Persistenz + Broadcast bei jeder Änderung** — der bestehende Tastatur-Handler
  (`main.js:305–313`) speichert nach `setZoomLevel` in `global.electronZoomLevel` und
  sendet `zoom-changed` an den Renderer (damit der Button auch bei Tastatur-Zoom aktuell
  bleibt). Gemeinsamer Helfer `applyZoomLevel(level)` (clamp + set + persist + broadcast).
- **IPC** `get-zoom-level()` → Level; `set-zoom-level(delta|absolute)` bzw. `nudge-zoom(delta)`
  (delta 0 = Reset) → nutzt `applyZoomLevel`. Bindings in `preload.js`.
- **Clamp** sinnvoll (z.B. Level −3…+3 ⇒ ~58 %…173 %), Step 0.5 wie Tastatur.

### B) Statusbar-UI (zwei Buttons, unten rechts)
- **`public/index.html`** — im `#status-bar` ein Container `#status-bar-zoom` mit zwei
  Buttons (`#zoom-xterm-btn`, `#zoom-electron-btn`) **rechts** von usage/activity.
- **Neues Renderer-Modul** `public/statusbar-zoom.js` (klassisches `<script>`, Script-Tag
  vor `app.js`): rendert beide Buttons, hält sie aktuell, verdrahtet Interaktion.
  - **xterm-Button:** Label z.B. `⤢ 12` (px). Klick → kleines **Popover** mit `−` /
    Wert / `+` / **Reset**. `+`/`−` → `window._nudgeTerminalFontSize(±1)`; Reset →
    `_nudgeTerminalFontSize(0)`. Live-Update: kleiner Notify-Hook aus terminal-manager
    (Callback/CustomEvent `terminal-font-changed`) — der auch bei Ctrl+Wheel feuert —
    damit der Button-Wert immer stimmt.
  - **electron-Button:** Label z.B. `100 %` (`Math.round(1.2**level*100)`). Klick →
    Popover `−`/Wert/`+`/Reset → `window.api.nudgeZoom(±0.5 / 0)`. Live-Update via
    `zoom-changed`-Event (deckt auch Tastatur-Zoom ab).
- **Konsistente Interaktion:** beide Buttons gleiches Popover-Muster (`−` / Wert / `+` /
  Reset). Optional zusätzlich Mausrad über dem Button = zoom.
- **`public/style.css`** — Button-/Popover-Styling im Statusbar-Look.

## Offene Entscheidungen (beim Start klären)
1. **Interaktion:** Popover mit `−`/Wert/`+`/Reset (Empfehlung) — bestätigt. Zusätzlich
   Mausrad-über-Button? (nice-to-have)
2. **Electron-Zoom-Range/Step:** Level ±3 @ 0.5-Schritten (≈58–173 %) ok, oder anders?
3. **Beschriftung/Icon:** xterm `⤢ 12` vs. `A 12px`; electron `100 %` — Wording festlegen.
4. **Settings-Feld** für `electronZoomLevel` zusätzlich zum Button — nötig oder Button reicht?

## Umsetzungsschritte (später)
1. `main.js`: `applyZoomLevel(level)` (clamp+set+persist+broadcast), Startup-Restore,
   Tastatur-Handler darauf umstellen, IPC `get-zoom-level`/`nudge-zoom`.
2. `preload.js`: Bindings `getZoomLevel`, `nudgeZoom`; Listener `onZoomChanged`.
3. `terminal-manager.js`: Notify-Hook (`terminal-font-changed`) in `_setTerminalFontSize`
   (feuert auch für Ctrl+Wheel/Shortcuts).
4. `public/index.html`: `#status-bar-zoom` + zwei Buttons + Script-Tag `statusbar-zoom.js`.
5. `public/statusbar-zoom.js`: Render + Popover + Live-Update (beide Quellen).
6. `public/style.css`: Styling.
7. Tests (`test/statusbar-zoom.test.js`): pure Helfer — Level→Prozent-Umrechnung, Clamp,
   Label-Format.

## Verifikation
- Beide Buttons zeigen initial den korrekten Wert (auch nach Neustart: xterm + electron).
- `+`/`−`/Reset wirken sofort; Tastatur-Zoom (Ctrl +/−/0) aktualisiert die Buttons.
- Electron-Zoom übersteht Neustart (Restore aus `global.electronZoomLevel`).
- `npm test` grün.
