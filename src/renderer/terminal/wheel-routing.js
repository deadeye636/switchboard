(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // The mouse wheel over a CLI that draws on the ALTERNATE screen and scrolls its own history (#775).
  //
  // Such a CLI asks the terminal for mouse reports (`?1000h` … `?1006h`) and reads the wheel as SGR reports.
  // On Windows that request never reaches xterm: ConPTY consumes it — measured with a child that only writes
  // the request, the system ConPTY and the bundled conpty.dll alike. xterm therefore believes nobody wants the
  // mouse and, on the alternate screen, turns each wheel step into a cursor key, which the CLI reads as
  // history recall in its composer. The REPORT direction does work: an SGR wheel report written to the PTY
  // reaches the CLI and scrolls it, because ConPTY took the CLI's request for its own and translates.
  //
  // So the backend declares that its CLI reads SGR wheel reports on the alternate screen
  // (`altScreenWheel: 'sgr'`), and this writes them. It steps aside whenever xterm already reports the mouse
  // itself (no ConPTY in between, or a future ConPTY that passes the request on), so a report is never sent
  // twice, and on the normal buffer, where the wheel scrolls xterm's own scrollback.
  //
  // `state` keeps the fraction of a line a trackpad's pixel deltas have not yet made whole, per terminal.
  // Returns the reports to send, or null to leave the event to xterm.
  const MAX_REPORTS_PER_EVENT = 10;

  function terminalWheelReports(event, ctx, state) {
    if (!event || !event.deltaY || event.ctrlKey || event.metaKey) return null;
    if (!ctx || ctx.declared !== 'sgr') return null;
    if (ctx.bufferType !== 'alternate') return null;
    if (ctx.mouseTracking && ctx.mouseTracking !== 'none') return null;

    let lines;
    if (event.deltaMode === 1) lines = event.deltaY;                                // DOM_DELTA_LINE
    else if (event.deltaMode === 2) lines = event.deltaY * (ctx.rows || 1);         // DOM_DELTA_PAGE
    else lines = event.deltaY / (ctx.cellHeight > 0 ? ctx.cellHeight : 16);         // DOM_DELTA_PIXEL
    // A fraction left over from the other direction is dropped, so the first step after a reversal counts.
    const prev = state && typeof state.acc === 'number' ? state.acc : 0;
    const acc = (prev * lines < 0 ? 0 : prev) + lines;
    const whole = acc < 0 ? Math.ceil(acc) : Math.floor(acc);
    if (state) state.acc = acc - whole;
    // The event is answered even when it adds up to less than a line, so xterm does not turn it into a key.
    if (!whole) return [];

    // Chromium on Windows turns Shift+wheel into a horizontal scroll (deltaY 0), so the Shift bit rarely
    // arrives there; Alt does, and Pi reads it as a five-times-larger step.
    const button = (whole < 0 ? 64 : 65) + (event.shiftKey ? 4 : 0) + (event.altKey ? 8 : 0);
    const col = Math.max(1, Math.floor(ctx.col || 1));
    const row = Math.max(1, Math.floor(ctx.row || 1));
    const report = '\x1b[<' + button + ';' + col + ';' + row + 'M';
    return new Array(Math.min(Math.abs(whole), MAX_REPORTS_PER_EVENT)).fill(report);
  }

  return { terminalWheelReports };
});
