// Terminal I/O: what a live session's PTY is told from the renderer — keystrokes, size, redraws, flow
// control, and the detach that closes a tab.
//
// The whole file is a lesson in one thing: a PTY can die between the guard that checks `exited` and the
// call on the next line, because its exit event has not been processed yet. node-pty then throws
// SYNCHRONOUSLY — and an uncaught throw here takes the main process with it. Every call below is wrapped
// for that reason, not out of habit.
//
// Needs no electron (registerIpc takes the ipc object) and no DB.
'use strict';

let ctx = null;

/**
 * @param {object} context
 * @param {Map} context.activeSessions
 * @param {object} context.log
 */
function init(context) {
  ctx = context;
}

// #27: the post-resize settle-repaint (ConPTY cols+1->cols nudge) is disabled — it
// caused a visible full-screen redraw ("text moves") after every resize, which was
// the dominant resize flicker. Trade-off: it existed to fix the cursor landing on the
// wrong row after xterm reflows a multi-line TUI input on resize (commit 87c3efc).
// That niche cursor glitch is accepted in favour of a calm resize. Flip back to true
// to restore the cursor fix; the per-session gating below then limits it to the
// focused session so background/grid cards don't flash.
const RESIZE_SETTLE_ENABLED = false;

/**
 * @param {Electron.IpcMain} ipc  passed in, not required — see the header.
 */
function registerIpc(ipc) {
  ipc.on('terminal-input', (_event, sessionId, data) => {
    const session = ctx.activeSessions.get(sessionId);
    if (session && !session.exited) {
      // Covers the synchronous failure path (e.g. the pty was disposed between the
      // guard and the write). An async EAGAIN completes later and is caught by the
      // process-level guard in main.js. Either way the same bytes are delivered, so tabs
      // mode is unaffected.
      try {
        session.pty.write(data);
      } catch (err) {
        ctx.log.warn(`[terminal-input] write failed for session=${sessionId}: ${err.code || err.message}`);
      }
    }
  });

  // --- IPC: pause/resume-session-output (PTY flow control, #74) ---
  // The renderer pauses the PTY while xterm's write buffer is saturated so an
  // output firehose backs up in the OS pipe instead of flooding IPC; resume is
  // called once xterm has drained. Guarded: pause/resume are optional in the
  // node-pty API surface.
  ipc.handle('pause-session-output', (_event, sessionId) => {
    const session = ctx.activeSessions.get(sessionId);
    if (!session || session.exited || typeof session.pty.pause !== 'function') return { ok: false };
    try { session.pty.pause(); } catch { return { ok: false }; }
    return { ok: true };
  });

  ipc.handle('resume-session-output', (_event, sessionId) => {
    const session = ctx.activeSessions.get(sessionId);
    if (!session || session.exited || typeof session.pty.resume !== 'function') return { ok: false };
    try { session.pty.resume(); } catch { return { ok: false }; }
    return { ok: true };
  });

  // --- IPC: terminal-resize (fire-and-forget) ---
  ipc.on('terminal-resize', (_event, sessionId, cols, rows, settle) => {
    if (!RESIZE_SETTLE_ENABLED) settle = false;
    const session = ctx.activeSessions.get(sessionId);
    if (session && !session.exited) {
      // Track the newest requested size and cancel any in-flight redraw nudge.
      // The nudge timers below otherwise restore the cols/rows FROZEN at their
      // scheduling time — during startup restore the layout keeps settling for
      // ~100 ms after the first size push, so a stale nudge re-applied an
      // outdated size and the TUI prompt landed rows off (over- or under-shot)
      // until a manual window resize delivered a fresh, nudge-free resize.
      session._lastCols = cols;
      session._lastRows = rows;
      clearTimeout(session._nudgeTimer);
      clearTimeout(session._nudgeTimer2);

      // For plain terminals, suppress buffering during resize to avoid
      // accumulating prompt redraws that pollute reattach replay
      if (session.isPlainTerminal) session._suppressBuffer = true;

      // The PTY can exit between the !session.exited check above and this call
      // (the exit event hasn't been processed yet). node-pty then throws
      // "Cannot resize a pty that has already exited" — synchronously, which would
      // crash the main process. Swallow it: a dead PTY can't be resized anyway.
      try {
        session.pty.resize(cols, rows);
      } catch (e) {
        ctx.log.warn('[terminal-resize] resize on exited pty ignored:', e?.message || String(e));
        return;
      }

      if (session.isPlainTerminal) {
        setTimeout(() => { session._suppressBuffer = false; }, 200);
      }

      // First resize: nudge to force TUI redraw on reattach (skip for plain terminals — causes duplicate prompts)
      if (session.firstResize && !session.isPlainTerminal) {
        session.firstResize = false;
        session._nudgeTimer = setTimeout(() => {
          try {
            session.pty.resize(session._lastCols + 1, session._lastRows);
            session._nudgeTimer2 = setTimeout(() => {
              try { session.pty.resize(session._lastCols, session._lastRows); } catch {}
            }, 50);
          } catch {}
        }, 50);
      } else if (settle && !session.isPlainTerminal) {
        // Subsequent resizes: ConPTY repaints, but xterm's own buffer reflow of
        // wrapped lines can leave the cursor on the wrong row (e.g. navigating a
        // multi-line input after a resize). Once the resize settles, nudge the PTY
        // (cols±1) so ConPTY emits a clean full frame that overwrites the
        // mis-reflowed cells and repositions the cursor — mirroring how Windows
        // Terminal relies on ConPTY's repaint instead of its own reflow.
        // #27: only for the focused session (settle=true) — nudging background/grid
        // cards made every visible card flash on a window resize.
        clearTimeout(session._resizeSettleTimer);
        session._resizeSettleTimer = setTimeout(() => {
          try {
            session.pty.resize(session._lastCols + 1, session._lastRows);
            session._nudgeTimer2 = setTimeout(() => { try { session.pty.resize(session._lastCols, session._lastRows); } catch {} }, 50);
          } catch {}
        }, 150);
      }
    }
  });

  // --- IPC: terminal-redraw (fire-and-forget) ---
  // Force one clean TUI frame by nudging the PTY (cols±1 and back), the same trick
  // the settle-repaint above uses. Shrinking a terminal leaves xterm's reflowed,
  // wrapped cells mis-drawn until the TUI repaints of its own accord — typing fixes
  // it, which is no way to leave the screen.
  //
  // This is deliberately NOT the `settle` path: that one is disabled globally
  // (RESIZE_SETTLE_ENABLED, #27) because it fired on every window resize and made
  // every visible grid card flash. This channel is only ever called for a single
  // card that the user just resized on purpose, so the one repaint is wanted.
  ipc.on('terminal-redraw', (_event, sessionId) => {
    const session = ctx.activeSessions.get(sessionId);
    if (!session || session.exited || session.isPlainTerminal) return;
    // Nothing to nudge back to until terminal-resize has recorded a size.
    if (!session._lastCols || !session._lastRows) return;
    clearTimeout(session._redrawTimer);
    clearTimeout(session._redrawTimer2);
    session._redrawTimer = setTimeout(() => {
      try {
        session.pty.resize(session._lastCols + 1, session._lastRows);
        session._redrawTimer2 = setTimeout(() => {
          try { session.pty.resize(session._lastCols, session._lastRows); } catch {}
        }, 50);
      } catch { /* PTY died between the guard and here */ }
    }, 50);
  });

  // --- IPC: close-terminal ---
  // The tab is gone from the renderer; the session is not. It keeps running (and buffering) so it can be
  // reattached. Only an already-dead one is dropped here — the live ones die with the window, or when
  // stop-session kills them.
  ipc.on('close-terminal', (_event, sessionId) => {
    const session = ctx.activeSessions.get(sessionId);
    if (session) {
      session.rendererAttached = false;
      if (session.exited) {
        ctx.activeSessions.delete(sessionId);
      }
    }
  });
}

module.exports = { init, registerIpc, RESIZE_SETTLE_ENABLED };
