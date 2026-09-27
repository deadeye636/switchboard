// Making the renderer's saved state survive a hard stop (#669).
//
// The renderer keeps what a restart needs in localStorage: which sessions were open (`persistedOpenSessions`)
// and the pane layout. A re-key renames a session in both at the moment it happens (#346, #669). Chromium
// does not write localStorage to disk on `setItem`, though: it commits in batches, on a delay and a rate
// limit of its own. Measured in the demo: a session was re-keyed, the renamed state was in localStorage, the
// app was killed about fourteen seconds later — and after the restart both keys still named the old id, so
// the restore resumed the session from before the `/clear`. A quit writes everything; a kill (`npm run
// stop:dev`, a crash) loses whatever Chromium had not committed yet.
//
// So after a re-key the main process asks Chromium to commit, once, a moment later — after the renderer's own
// debounced writes (the pane layout persists 400 ms after its last change). Only at a re-key: that is the
// one change a restore cannot recover from, and a flush on every write would be the disk traffic the batching
// exists to avoid.
'use strict';

const FLUSH_DELAY_MS = 1500;

// One pending flush per window: a start that re-keys many sessions at once flushes once.
const pending = new WeakSet();

/** Ask Chromium to write `webContents`' storage to disk shortly. Safe on a window that is going away. */
function flushStorageSoon(webContents) {
  if (!webContents || typeof webContents !== 'object' || pending.has(webContents)) return;
  pending.add(webContents);
  const timer = setTimeout(() => {
    pending.delete(webContents);
    try {
      if (webContents.isDestroyed && webContents.isDestroyed()) return;
      const session = webContents.session;
      if (session && typeof session.flushStorageData === 'function') session.flushStorageData();
    } catch { /* best effort: the next commit or a clean quit writes it anyway */ }
  }, FLUSH_DELAY_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

module.exports = { flushStorageSoon, FLUSH_DELAY_MS };
