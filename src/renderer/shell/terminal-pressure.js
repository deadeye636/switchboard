// How full this window is, counted in live terminals (#352).
//
// Every open session keeps an xterm alive, and in tabs and single mode each of those can hold a WebGL
// context of its own. Past roughly 32 contexts Chromium starts dropping the oldest, and a dropped
// context looks like a terminal going blank for no reason at all — the hardest kind of symptom to
// trace back to "too many tabs".
//
// The LRU does NOT bound this, and is not meant to: `lruEvictOne` skips every session with a live PTY
// on purpose, because discarding a running session's scrollback is a visible loss rather than a cache
// decision. Panes mode is saved by its own rule (two visible terminals means every terminal renders on
// the DOM, #320); tabs mode has nothing. So the number is SHOWN rather than enforced, and this file is
// the whole of that decision — where the thresholds sit and what the user is told at each one.
//
// Pure, so the thresholds and the wording are testable without a window.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Well below the point where contexts start dying: the warning has to arrive while closing a few
  // tabs is still a small decision, not after the damage.
  const TERMINAL_PRESSURE_WARN = 24;
  const TERMINAL_PRESSURE_HIGH = 30;

  /**
   * @param {number} count  live terminals in this window (`openSessions.size`)
   * @returns {{level: 'none'|'warn'|'high', label: string, title: string}}
   *   `level` drives the colour, `label` is the status-bar segment, `title` its tooltip. At `none`
   *   both strings are empty: below the threshold this is not information, it is clutter.
   */
  function terminalPressure(count) {
    const n = Number(count);
    const open = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    if (open < TERMINAL_PRESSURE_WARN) return { level: 'none', label: '', title: '' };
    // Say the count, the consequence and the way out — a coloured number with no explanation is a
    // warning the user cannot act on.
    const title = `${open} terminals open in this window. Past about 32, the browser starts dropping `
      + 'GPU contexts and terminals blank out. Closing tabs you are done with frees them; the session '
      + 'and its history stay either way.';
    return {
      level: open >= TERMINAL_PRESSURE_HIGH ? 'high' : 'warn',
      label: `${open} terminals`,
      title,
    };
  }

  return { TERMINAL_PRESSURE_WARN, TERMINAL_PRESSURE_HIGH, terminalPressure };
});
