<!--
  Detailplan — von Hand pflegen. xterm-bottom-row-clip-plan.html ist Generat
  (scripts/build-docs.js, `npm run docs:build`, pre-commit). Das .html NICHT editieren.
-->

# Plan #59 — Bug: xterm Bottom-Row-Clip (letzte Zeile abgeschnitten)

**Status:** Erledigt · **Prio:** P3 · **Branch:** `fix/xterm-bottom-row-clip`

## Symptom

Die unterste xterm-Zeile ist gelegentlich horizontal abgeschnitten (nur oberer Teil
sichtbar). Ein Electron-Fensterresize behebt es sofort. Tritt sporadisch/timing-abhängig
auf, nicht deterministisch reproduzierbar.

## Ursache

**Row-Overshoot:** xterm hält eine Reihe mehr, als in die Content-Box des
`.terminal-container` passt → `overflow:hidden` clippt die letzte Reihe. Ein Resize
triggert den ResizeObserver → frischer `safeFit` → korrekt.

Es gibt bereits Gegenmittel (`clampRowsToContentBox` + `safeFit`,
`public/terminal-manager.js:190` / `:198`), das den bekannten +16 px-Padding-Overshoot
klemmt. Zwei **Rest-Fenster** bleiben:

1. **Unmeasured-Cache** (`safeFit`, `terminal-manager.js:219–242`): Läuft ein Fit, solange
   `rsCellH` (render-service Cell-Höhe) noch `0` ist (Font-Metrik/Paint nicht gesettled),
   ist der Clamp ein No-op → der Overshoot wird als `_fitW/_fitH` **gecacht**. Der
   rAF-Refit ist auf **5 Versuche** gecappt (`_refitTries <= 5`, `:238`). Settlen die
   Metriken erst später (busy Main-Thread, großes Scrollback, GPU-Last), korrigiert sich
   der Zustand **nie selbst** — erst der nächste Resize heilt.
2. **`REFIT_TOL = 8`** (`:897`, in `showSession`/Tab-Switch): Container-Höhenänderungen
   < 8 px lösen **keinen** Re-fit aus. Ein Sub-8px-Overshoot (Statusbar-/Usage-Bar-Reflow,
   fraktionale DPI) bleibt hängen.

Passt zum Bild „sporadisch + Resize heilt".

## Fix

Zwei Bausteine, gemeinsam robust:

### A — Measure-settle statt harter 5-Cap (`terminal-manager.js:232–243`)
- Den rAF-Refit nicht nach 5 Versuchen aufgeben, sondern **weiterlaufen lassen, bis
  `rsCellH > 0`** — zeit-/framebudget-begrenzt (z. B. bis ~500 ms oder ~30 Frames, dann
  stop), damit ein nie-paintender Hidden-Grid-Card nicht ewig spinnt.
- Schließt Ursache 1 (der Overshoot wird korrigiert, sobald die Cell-Höhe real ist).

### B — Self-Heal-Guard (ursachen-agnostisches Sicherheitsnetz)
- Neuer Helfer `isBottomRowClipped(entry)`: vergleicht die tatsächlich gerenderte
  `.xterm`-Höhe (bzw. `rows * cellHeight`) gegen die Container-Content-Box
  (`clientHeight − verticalPadding`). Clippt es (> ~1 px Überstand) → `safeFit(entry)`.
- Aufrufen an den günstigen Punkten, an denen ohnehin schon etwas passiert:
  `drainReplayBuffer`/nach PTY-Write-Flush und `showSession`-Focus. Kein neuer Timer/Poll —
  nur eine billige Messung an bestehenden Hooks.
- Trifft das Symptom direkt, egal welche Ursache (auch der Sub-`REFIT_TOL`-Fall aus 2,
  ohne `REFIT_TOL` senken zu müssen → kein ±1-Row-Jitter-Regress).

### Bewusst nicht
- `REFIT_TOL` senken (Option C) — würde den Tab-Switch-Jitter (±1 Row) zurückbringen, den
  `= 8` gerade vermeidet. Nur nachziehen, falls A+B nicht reicht.

## Tests (`test/xterm-fit.test.js` bzw. bestehende Fit-Tests erweitern)
- `clampRowsToContentBox` bleibt grün (Regressionsschutz).
- `isBottomRowClipped`: Content-Box exakt N Reihen → false; N+0.4 Reihen gerendert → true;
  cellHeight 0 (unmeasured) → false (kein Fehlalarm).
- Pure-Funktionen ohne DOM/Electron testbar (Projekt fährt `node --test`).

## Dateien
`public/terminal-manager.js` (A: Refit-Settle-Loop; B: `isBottomRowClipped` + Aufrufe in
`safeFit`-Nachlauf / `showSession` / Drain), neu/erweitert `test/xterm-fit.test.js`.

## Umsetzung (2026-07-03)

- **Pure-Funcs ausgelagert:** `clampRowsToContentBox` + neu `bottomRowClipped` in neues
  UMD-Modul `public/terminal-fit.js` (Muster wie `grid-layout.js`), als `<script>` **vor**
  `terminal-manager.js` in `index.html` geladen → Browser-Globals, `node --test`-fähig.
- **A:** Refit-Settle-Budget in `safeFit` von 5 auf **30 Frames** (~500 ms) angehoben — der
  rAF-Refit läuft weiter bis `rsCellH > 0`, aber gedeckelt (nie-paintender Hidden-Card
  spinnt nicht ewig).
- **B:** `isBottomRowClipped(entry)` (DOM-Wrapper um `bottomRowClipped`, liest Cell-Höhe aus
  dem Render-Service) → `safeFit` an zwei bestehenden Hooks: `drainReplayBuffer`-Write-Flush
  und `showSession`-Tabs-Zweig (der Sub-`REFIT_TOL`-Fall). Kein neuer Timer/Poll.
- **Tests** `test/xterm-fit.test.js` (+11): `clampRowsToContentBox`-Regression +
  `bottomRowClipped` (exakt N → false, N+Overshoot → true, 1px-Slack, unmeasured → false,
  Padding).

**Verifikation:** Manuell schwer erzwingbar (timing) — bewusst über die Pure-Func-Tests +
Regressionssuite abgesichert; der Self-Heal-Guard ist ein ursachen-agnostisches Sicherheitsnetz.
Live-Beobachtung unter Busy-Session (großes Scrollback) offen — Clip sollte sich jetzt ohne
Resize selbst heilen.
