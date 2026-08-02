(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const HIDE_CURSOR = '\x1b[?25l';
  const SHOW_CURSOR = '\x1b[?25h';
  const CURSOR_VISIBILITY_RE = /\x1b\[\?25([hl])/g;

  // Some TUIs write a visible cursor at an animation/update cell, then restore the input cursor in a
  // separate PTY chunk. xterm paints both complete chunks, which turns the hardware cursor into a red
  // tracer. Keep it hidden while output is arriving, then restore the application's final visibility.
  function createCursorStabilizer({ settleMs = 80, setTimer = setTimeout, clearTimer = clearTimeout, writeControl }) {
    let wantedVisible = true;
    let timer = null;
    let disposed = false;

    function cancelPending() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    }

    function wrap(data) {
      if (disposed) return data;
      cancelPending();
      CURSOR_VISIBILITY_RE.lastIndex = 0;
      let match;
      while ((match = CURSOR_VISIBILITY_RE.exec(data)) !== null) wantedVisible = match[1] === 'h';
      // The trailing hide is outside any DEC-2026 transaction in `data`, so even a chunk that ends by
      // showing its update cursor cannot leave that intermediate cursor visible for the next frame.
      return HIDE_CURSOR + data + HIDE_CURSOR;
    }

    function parsed() {
      if (disposed) return;
      cancelPending();
      timer = setTimer(() => {
        timer = null;
        if (!disposed) writeControl(wantedVisible ? SHOW_CURSOR : HIDE_CURSOR);
      }, settleMs);
    }

    function dispose() {
      disposed = true;
      cancelPending();
    }

    return { wrap, parsed, dispose, wantedVisible: () => wantedVisible };
  }

  return { createCursorStabilizer, HIDE_CURSOR, SHOW_CURSOR };
});
