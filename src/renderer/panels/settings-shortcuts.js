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
// once every tag has parsed. Script order cannot break them, and index.html does in fact load shortcuts.js
// AFTER this file. Both index.html and settings.html load it.

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

    // `stopShortcutCapture` is returned because TWO paths outside this section call it — persistSettings
    // and the Cancel button — so that leaving the panel by either route ends a capture that is still
    // running, rather than leaving a button stuck on "Press keys…" and a live capture behind.
    //
    // These two calls are what this section is tied to the rest of settings-panel.js by, and the tie does
    // not announce itself: the first draft of this file simply left the function behind, and BOTH paths
    // then threw `ReferenceError: stopShortcutCapture is not defined`. Not a broken shortcut section — a
    // dead Save for every setting in the panel, and a dead Cancel. All 1488 tests were green; only
    // pressing Save found it. Opening the panel would not have.
    return { initShortcutSection, stopShortcutCapture };
  }

  window.settingsShortcuts = { create };
})();
