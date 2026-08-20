/**
 * file-watch.js — keeping an open document live while something else rewrites it (#452).
 *
 * Every viewer panel watches the file it shows. That was a footnote while the only writer was the user;
 * it is the whole feature now that the common case is an agent rewriting a document for twenty minutes
 * while the user reads it. Three things were wrong with the version in main.js, and each of them is a
 * silent failure — nothing errors, the document simply stops being true:
 *
 *   - **One recipient.** The change went to the main window and nowhere else, while a view file can be
 *     routed to a window of its own. Push the document onto the second monitor — exactly what one does
 *     while an agent works on it — and it froze.
 *   - **No refcount.** Watchers were keyed by path, and a second requester got `{ ok: true }` and no
 *     watch at all; an unwatch from either closed it for both. Two panels on one file, or a main window
 *     and a detached one, and whichever closed first took the other's liveness with it.
 *   - **`rename` discarded.** A writer that writes a temporary file and renames it over the target emits
 *     `rename`, not `change`. The old handler dropped it, and on Linux the watch then followed the
 *     orphaned inode: permanently dead, no error, no way to notice.
 *
 * So an entry holds SUBSCRIBERS, not a single flag, and each subscriber is remembered with the path
 * string it asked with. Two panels may name one file differently — `~/x.md` and the resolved path both
 * arrive here — and each has to be answered in its own terms, because that string is the identity the
 * panel compares against.
 *
 * A window that goes away takes its subscriptions with it. That is not tidiness: a WebContents that has
 * been destroyed throws on `send`, and the entry would otherwise keep an FSWatcher alive for a reader
 * that no longer exists.
 *
 * The rename fix had the same shape of hole one level down (#455): re-establishing the watch on the path
 * is right, looking exactly once and then never again is not. An entry that stopped trying kept its
 * subscribers and reported `watching: false`, which is also what a brand-new entry reports — so nothing,
 * from the outside, could tell a watch that is coming back from one that is over. Hence `state`.
 */

'use strict';

const fs = require('fs');
const { readableError } = require('./readable-error');

let ctx = null;

/**
 * @typedef {'watching'|'waiting'|'gave-up'} WatchState
 *   watching  an FSWatcher is live on this path
 *   waiting   the name stopped pointing at what we held, and we are looking for it to come back
 *   gave-up   it did not come back inside the window, and nothing is scheduled any more
 *
 * @type {Map<string, {
 *   watcher: fs.FSWatcher|null,
 *   state: WatchState,
 *   retryTimer: any,
 *   retryDelay: number,
 *   retryUntil: number,
 *   subscribers: Map<number, {wc: any, paths: Set<string>}>,
 * }>}
 */
const entries = new Map();

// One change can arrive as several events (a truncate then a write, an editor's save dance), and a panel
// that reloads three times shows three flashes. Long enough to coalesce a write, short enough that the
// document does not visibly lag the agent writing it.
const DEBOUNCE_MS = 300;

// Looking for a file that was renamed away, until it comes back (#455).
//
// A rename is not atomic from the watcher's side: the old name is gone and the new one may not be
// visible yet. This used to look exactly ONCE, 120 ms later, and give up for good — leaving an entry
// with subscribers and no watcher, which reads as "watched" from every angle. A writer that renames a
// temporary file over the target beats 120 ms; one that deletes, works, and writes back does not, nor
// does anything behind a scanner or a network share. The document then goes stale in silence, which is
// the exact failure this module exists to prevent.
//
// So it keeps looking, backing off so a file that is genuinely gone costs almost nothing, and it stops
// after a bounded window rather than holding a timer for the life of the app. Stopping is a STATE, not
// a return: `watchStats()` reports it, and a fresh `watchFile` for the same path revives the entry —
// which is what happens when the user reopens the document.
const REWATCH_MS = 120;
const REWATCH_MAX_MS = 2000;
const REWATCH_WINDOW_MS = 30000;

// How long the app is willing to keep looking. Overridable through `init` for one reason only: a test
// for "it eventually stops" cannot wait thirty seconds, and a test that never proves the stop is the
// test this feature most needs.
let rewatchWindowMs = REWATCH_WINDOW_MS;

function init(context) {
  ctx = context;
  rewatchWindowMs = (context && Number(context.rewatchWindowMs)) || REWATCH_WINDOW_MS;
}

function now() { return Date.now(); }

function notify(resolved) {
  const entry = entries.get(resolved);
  if (!entry) return;
  for (const [id, sub] of entry.subscribers) {
    // A subscriber is told in the words it used. `file-changed` carries a path, and the panel matches it
    // against the one it passed to `watch-file` — answering with the resolved path would silently stop
    // matching for every caller that asked with `~/…`.
    if (!sub.wc || sub.wc.isDestroyed()) { entry.subscribers.delete(id); continue; }
    for (const asked of sub.paths) {
      try { sub.wc.send('file-changed', asked); } catch { /* the window went while we were talking to it */ }
    }
  }
  if (entry.subscribers.size === 0) closeEntry(resolved);
}

/** Stop whatever retry is pending. Safe on an entry that has none. */
function cancelRetry(entry) {
  if (entry.retryTimer) clearTimeout(entry.retryTimer);
  entry.retryTimer = null;
}

/**
 * Look for a file that was renamed away, again, until it comes back or the window closes.
 *
 * Backing off matters more than the first delay does: the common case is back within a frame, and the
 * uncommon one is a file that is never coming back, which must not cost a wakeup every 120 ms for half
 * a minute.
 */
function scheduleRetry(resolved, entry) {
  cancelRetry(entry);
  if (now() >= entry.retryUntil) {
    // Bounded on purpose — an entry nobody closed would otherwise hold a timer for the life of the app.
    // The subscribers stay: they are still showing the document, and `watchFile` revives this on reopen.
    entry.state = 'gave-up';
    return;
  }
  entry.state = 'waiting';
  const delay = Math.min(entry.retryDelay, REWATCH_MAX_MS, Math.max(1, entry.retryUntil - now()));
  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = null;
    const live = entries.get(resolved);
    if (!live || live !== entry) return;          // closed, or replaced by a fresh entry
    if (live.watcher) { live.state = 'watching'; return; }
    if (!fs.existsSync(resolved)) {
      live.retryDelay = Math.min(live.retryDelay * 2, REWATCH_MAX_MS);
      scheduleRetry(resolved, live);
      return;
    }
    // It is back. Whatever is there now is not what the subscribers were shown, so they are told —
    // re-attaching without notifying is how a rewritten file reads as unchanged.
    if (attach(resolved, live).ok) notify(resolved);
    else scheduleRetry(resolved, live);
  }, delay);
  if (entry.retryTimer && typeof entry.retryTimer.unref === 'function') entry.retryTimer.unref();
}

function attach(resolved, entry) {
  let debounce = null;
  const fire = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => notify(resolved), DEBOUNCE_MS);
  };

  let watcher;
  try {
    watcher = fs.watch(resolved, (eventType) => {
      if (eventType === 'change') { fire(); return; }
      // `rename` means the name no longer points at what this watcher holds — replaced, moved or deleted.
      // Following the old inode is what makes the watch quietly useless, so the watch is re-established on
      // the PATH rather than on what we were holding.
      try { watcher.close(); } catch { /* already gone */ }
      entry.watcher = null;
      entry.retryDelay = REWATCH_MS;
      entry.retryUntil = now() + rewatchWindowMs;
      scheduleRetry(resolved, entry);
    });
  } catch (err) {
    entry.watcher = null;
    entry.state = 'waiting';
    // This answer goes back to the renderer, so it must not be the errno's own words — they name the
    // file (#457). The panel only checks `ok`; the reason is for whoever reads it next.
    return { ok: false, error: readableError(err, 'That file could not be watched for changes.', ctx && ctx.log) };
  }
  cancelRetry(entry);
  entry.watcher = watcher;
  entry.state = 'watching';
  return { ok: true };
}

function closeEntry(resolved) {
  const entry = entries.get(resolved);
  if (!entry) return;
  cancelRetry(entry);
  try { if (entry.watcher) entry.watcher.close(); } catch { /* best effort */ }
  entries.delete(resolved);
}

/** Every subscription a window holds, dropped. Called when its WebContents dies or navigates away. */
function releaseWebContents(wc) {
  if (!wc) return;
  const id = wc.id;
  for (const [resolved, entry] of [...entries]) {
    if (!entry.subscribers.has(id)) continue;
    entry.subscribers.delete(id);
    if (entry.subscribers.size === 0) closeEntry(resolved);
  }
}

function watchFile(wc, filePath) {
  const resolved = ctx.resolvePanelFilePath(filePath);
  if (ctx.isSensitivePath(resolved)) return { ok: false, error: 'access to sensitive path denied' };

  let entry = entries.get(resolved);
  if (!entry) {
    entry = { watcher: null, state: 'waiting', retryTimer: null, retryDelay: REWATCH_MS, retryUntil: 0, subscribers: new Map() };
    entries.set(resolved, entry);
    const started = attach(resolved, entry);
    if (!started.ok) { entries.delete(resolved); return started; }
  } else if (!entry.watcher) {
    // An entry that is waiting, or one that gave up, gets another go — reopening the document is exactly
    // the moment to try again, and the second subscriber of a dead entry used to be handed `{ ok: true }`
    // and no watch at all. A failure here is not fatal: the existing subscribers keep their entry and the
    // retry window is restarted rather than the whole thing torn down under them.
    entry.retryDelay = REWATCH_MS;
    entry.retryUntil = now() + rewatchWindowMs;
    if (!attach(resolved, entry).ok) scheduleRetry(resolved, entry);
  }

  const id = wc.id;
  let sub = entry.subscribers.get(id);
  if (!sub) {
    sub = { wc, paths: new Set() };
    entry.subscribers.set(id, sub);
    // Once per WebContents, not once per file: `destroyed` fires whatever it was watching.
    if (!wc.__sbFileWatchBound) {
      wc.__sbFileWatchBound = true;
      wc.once('destroyed', () => releaseWebContents(wc));
      // A reload re-runs `watch-file` from scratch, so the old subscriptions are stale the moment the
      // navigation starts — and a panel that was open before the reload is not open after it.
      wc.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) releaseWebContents(wc);
      });
    }
  }
  sub.paths.add(filePath);
  return { ok: true };
}

function unwatchFile(wc, filePath) {
  const resolved = ctx.resolvePanelFilePath(filePath);
  const entry = entries.get(resolved);
  if (!entry) return { ok: true };
  const sub = wc ? entry.subscribers.get(wc.id) : null;
  if (sub) {
    sub.paths.delete(filePath);
    // The subscriber goes only when it has no name left for this file. A panel that opened `~/x.md` and
    // another that opened the resolved path are one subscriber with two names, and one closing must not
    // silence the other.
    if (sub.paths.size === 0) entry.subscribers.delete(wc.id);
  }
  if (entry.subscribers.size === 0) closeEntry(resolved);
  return { ok: true };
}

/**
 * For tests and teardown: how many files are watched, by how many windows, and in what state.
 *
 * `watching` stays what it was — a boolean about an FSWatcher. `state` is the thing that could not be
 * asked before (#455): an entry with no watcher was indistinguishable from one that had quietly stopped
 * trying, and both reported the same `watching: false`.
 */
function watchStats() {
  return [...entries].map(([path, e]) => ({
    path,
    subscribers: e.subscribers.size,
    watching: !!e.watcher,
    state: e.state,
  }));
}

function closeAll() {
  for (const resolved of [...entries.keys()]) closeEntry(resolved);
}

function registerIpc(ipcMain) {
  ipcMain.handle('watch-file', (event, filePath) => watchFile(event.sender, filePath));
  ipcMain.handle('unwatch-file', (event, filePath) => unwatchFile(event.sender, filePath));
}

module.exports = { init, registerIpc, watchFile, unwatchFile, releaseWebContents, watchStats, closeAll };
