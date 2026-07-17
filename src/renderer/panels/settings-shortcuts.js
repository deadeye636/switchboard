// --- Settings: rebinding the keyboard shortcuts (#218) ---
//
// Global-only. One button per entry in SHORTCUT_DEFS; clicking one puts it into capture, the next key
// combination becomes its binding, Escape aborts, and clicking the button that is already capturing resets
// it to the default.
//
// It came out of `openSettingsViewer` in settings-panel.js — see settings-tags.js's header for why a cut
// out of that function means handing a module what it used to close over. This one is the third.
//
// ctx: { body, isMac, getShortcuts() -> object, setShortcuts(next) }
//
// WHY ACCESSORS AND NOT A VALUE — this is the whole reason this file is worth reading:
//
//   `scShortcuts` is a `let` in openSettingsViewer, and this section is its only WRITER while
//   `persistSettings` and the HTML template are its READERS. Handing over the object would hand over a
//   snapshot: every rebind here replaces it (`{ ...scShortcuts, [id]: binding }` — a new object, not a
//   mutation), so the panel's `let` would still address the one from before the user touched anything, and
//   Save would write the old bindings back. No error, no failing test — the rebind just would not stick.
//
//   CLAUDE.md states the rule as "a const goes straight through; a let ONLY as a getter". A getter alone is
//   not enough here, because this module does not only read it: it needs the setter to be the one that
//   rebinds the panel's `let`. The `let` STAYS in settings-panel.js because the rule for where it lives is
//   to count readers, and both readers are there.
//
// `isMac` is a value, not a getter: it is settings-panel.js's `scIsMac`, decided once per open. It is
// passed rather than re-derived because the standalone settings window (settings.html) does NOT load
// terminal/terminal-manager.js, where the app's `isMac` is declared — which is why settings-panel.js reads
// it through a `typeof` guard. Re-deriving it here would mean repeating that guard, and getting it wrong in
// the settings window means every shortcut renders with the wrong modifier names.
//
// SHORTCUT_DEFS / formatBinding / captureBinding / normalizeShortcuts are NOT in the ctx: shell/shortcuts.js
// declares them at the top level of a classic script, so they live in the shared global lexical scope that
// every renderer script sees, and every reference below sits inside a function — resolved at call time,
// long after all 74 tags have parsed. Script order cannot break them. Both index.html and settings.html
// load shortcuts.js.

(function () {
  'use strict';

  function create(ctx) {
    const settingsViewerBody = ctx.body;
    const scIsMac = ctx.isMac;
    const getShortcuts = ctx.getShortcuts;
    const setShortcuts = ctx.setShortcuts;

    // Capture listeners live on the button element itself (not on document), so
    // they can never leak app-wide: losing focus (incl. the settings viewer being
    // dismissed by ANY path) fires `blur` → stops capture, and re-opening the
    // viewer replaces settingsViewerBody, discarding the old listeners with it.
    let capturingBtn = null;
    function stopShortcutCapture() {
      if (capturingBtn) {
        capturingBtn.classList.remove('capturing');
        capturingBtn.textContent = formatBinding(capturingBtn.dataset.scId, scIsMac, getShortcuts());
        capturingBtn = null;
      }
    }

    function initShortcutSection() {
      settingsViewerBody.querySelectorAll('.settings-shortcut-btn').forEach(btn => {
        const id = btn.dataset.scId;
        const def = SHORTCUT_DEFS.find(d => d.id === id);
        btn.addEventListener('click', () => {
          // Clicking the button that is already capturing resets it to default.
          if (capturingBtn === btn) {
            setShortcuts({ ...getShortcuts(), [id]: normalizeShortcuts(null)[id] });
            stopShortcutCapture();
            btn.blur();
            return;
          }
          stopShortcutCapture();
          capturingBtn = btn;
          btn.classList.add('capturing');
          btn.textContent = 'Press keys…';
          btn.focus();
        });
        // keydown only acts while THIS button is the one capturing.
        btn.addEventListener('keydown', (e) => {
          if (capturingBtn !== btn) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Escape') { stopShortcutCapture(); btn.blur(); return; }
          const binding = captureBinding(e, def, scIsMac);
          if (!binding) return; // chord incomplete — keep listening
          setShortcuts({ ...getShortcuts(), [id]: binding });
          stopShortcutCapture();
          btn.blur();
        });
        // Losing focus (click elsewhere, panel dismissed, tab switch) cancels capture.
        btn.addEventListener('blur', () => {
          if (capturingBtn === btn) stopShortcutCapture();
        });
      });
    }

    // `stopShortcutCapture` is returned because the SAVE path calls it: persistSettings ends a capture
    // that is still running, so a Save pressed while a button says "Press keys…" leaves no button stuck
    // mid-capture and no live capture behind the settings it just wrote. That call is the one dependency
    // of this section that does not live in this section — and leaving it out is not a broken shortcut
    // section, it is a dead Save for EVERY setting. It cost exactly that during #218, found by clicking.
    return { initShortcutSection, stopShortcutCapture };
  }

  window.settingsShortcuts = { create };
})();
