'use strict';
// Stopping a running session on purpose (#130, #396), shared by the `stop-session` IPC handler in main.js and the
// review runner (spec 39), which ends the review session it started. Only the reason the timeline records differs.
//
// Electron-free and db-free: the session and the timeline arrive as arguments.

/**
 * -> { ok: true } | { ok: false, error: 'not running' }
 * `reason` is the sentence the timeline records ("Stopped by the user.", "Stopped: the review ended.").
 */
function stopSession(session, sessionId, { timeline, reason } = {}) {
  if (!session || session.exited) return { ok: false, error: 'not running' };
  // Mark it dead here, not only in ptyProcess.onExit: kill() is asynchronous (very
  // visibly so under ConPTY), and until onExit lands, get-active-sessions would keep
  // reporting the session as running. The renderer's 3s poll would then re-add it to
  // activePtyIds and the grid's auto-mount would "reattach" it — resuming a fresh
  // process for a session the user just stopped (#130). onExit still fires and does
  // the real cleanup; setting this twice is harmless.
  session.exited = true;
  // Recorded HERE and not in the exit handler: this is the one place that knows the process did not
  // simply end, someone ended it (#396). The exit that follows says the process is gone; only this
  // says why.
  // Required, as it always was here: a stop without its line in the timeline is a stop nobody can explain later.
  timeline.recordLifecycle(session.realSessionId || sessionId, 'stopped', 'Session stopped', reason);
  try { session.pty.kill(); } catch { /* already gone — the flag is what matters */ }
  return { ok: true };
}

module.exports = { stopSession };
