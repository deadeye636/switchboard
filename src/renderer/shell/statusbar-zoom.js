// Statusbar zoom buttons (#34) — bottom-right of #status-bar: two indicators the user
// can click to see and change the current zoom.
//   1. xterm zoom  → terminal font size (persistent via terminalFontSize)
//   2. Electron zoom → whole-UI zoom (persistent via electronZoomLevel, main process)
// Each button shows the current value and opens a small popover with −/value/+/reset.
// Mouse wheel over a button also nudges it. Labels update live from the source events
// (terminal-font-changed / zoom-changed), so keyboard zoom keeps them in sync too.
//
// UMD: pure helpers are exported (and testable in node); DOM wiring only runs in a
// browser context where document exists.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const ZOOM_LEVEL_MIN = -3;
  const ZOOM_LEVEL_MAX = 3;

  function clampZoomLevel(level) {
    const v = Number(level);
    if (!Number.isFinite(v)) return 0;
    return Math.max(ZOOM_LEVEL_MIN, Math.min(ZOOM_LEVEL_MAX, v));
  }

  // Electron zoom factor = 1.2 ** level → percentage for display.
  function zoomToPercent(level) {
    const v = Number(level);
    if (!Number.isFinite(v)) return 100;
    return Math.round(Math.pow(1.2, v) * 100);
  }

  function xtermLabel(size) {
    return 'A ' + Math.round(Number(size) || 0);
  }

  function electronLabel(level) {
    return zoomToPercent(level) + '%';
  }

  // --- DOM wiring (browser only) ---
  function initDom() {
    const container = document.getElementById('status-bar-zoom');
    if (!container) return;

    let openPopover = null;
    function closePopover() {
      if (openPopover) { openPopover.remove(); openPopover = null; }
    }

    // Build one zoom control (button + popover). `sub(cb)` wires live updates.
    function makeControl({ title, format, initial, onMinus, onPlus, onReset, sub }) {
      let current = initial;

      const btn = document.createElement('button');
      btn.className = 'statusbar-zoom-btn';
      btn.title = title;
      const label = document.createElement('span');
      label.className = 'statusbar-zoom-label';
      btn.appendChild(label);
      container.appendChild(btn);

      let popLabel = null;
      function render() {
        label.textContent = format(current);
        if (popLabel) popLabel.textContent = format(current);
      }
      render();

      function openPop() {
        closePopover();
        const pop = document.createElement('div');
        pop.className = 'zoom-popover';
        const minus = document.createElement('button');
        minus.className = 'zoom-popover-btn';
        minus.textContent = '−';
        minus.title = 'Smaller';
        const val = document.createElement('span');
        val.className = 'zoom-popover-value';
        const plus = document.createElement('button');
        plus.className = 'zoom-popover-btn';
        plus.textContent = '+';
        plus.title = 'Bigger';
        const reset = document.createElement('button');
        reset.className = 'zoom-popover-btn zoom-popover-reset';
        reset.textContent = '⟲';
        reset.title = 'Reset';
        pop.appendChild(minus);
        pop.appendChild(val);
        pop.appendChild(plus);
        pop.appendChild(reset);
        document.body.appendChild(pop);
        popLabel = val;
        render();

        // Position above the button, right-aligned to it.
        const r = btn.getBoundingClientRect();
        pop.style.bottom = (window.innerHeight - r.top + 6) + 'px';
        pop.style.right = (window.innerWidth - r.right) + 'px';

        minus.addEventListener('click', (e) => { e.stopPropagation(); onMinus(); });
        plus.addEventListener('click', (e) => { e.stopPropagation(); onPlus(); });
        reset.addEventListener('click', (e) => { e.stopPropagation(); onReset(); });
        openPopover = pop;
      }

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (openPopover && popLabel && document.body.contains(popLabel)) closePopover();
        else openPop();
      });
      btn.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (e.deltaY < 0) onPlus(); else onMinus();
      }, { passive: false });

      // Live updates from the source of truth.
      sub((value) => { current = value; render(); });
    }

    // xterm terminal-font control
    makeControl({
      title: 'Terminal font size (click to change)',
      format: xtermLabel,
      initial: (typeof window._getTerminalFontSize === 'function' ? window._getTerminalFontSize() : 12),
      onMinus: () => window._nudgeTerminalFontSize?.(-1),
      onPlus: () => window._nudgeTerminalFontSize?.(1),
      onReset: () => window._nudgeTerminalFontSize?.(0),
      sub: (cb) => window.addEventListener('terminal-font-changed', (e) => cb(e.detail)),
    });

    // Electron UI-zoom control
    makeControl({
      title: 'UI zoom (click to change)',
      format: electronLabel,
      initial: 0,
      onMinus: () => window.api.nudgeZoom(-0.5),
      onPlus: () => window.api.nudgeZoom(0.5),
      onReset: () => window.api.nudgeZoom(0),
      sub: (cb) => {
        window.api.onZoomChanged?.((level) => cb(level));
        // Seed the current value once.
        window.api.getZoomLevel?.().then((level) => cb(level)).catch(() => {});
      },
    });

    // Dismiss popover on outside click / Escape.
    document.addEventListener('click', () => closePopover());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopover(); });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initDom);
    } else {
      initDom();
    }
  }

  return { clampZoomLevel, zoomToPercent, xtermLabel, electronLabel };
});
