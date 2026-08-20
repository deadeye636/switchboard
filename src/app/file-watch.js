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
 */

'use strict';

const fs = require('fs');

let ctx = null;

/** @type {Map<string, {watcher: fs.FSWatcher|null, subscribers: Map<number, {wc: any, paths: Set<string>}>}>} */
const entries = new Map();

// One change can arrive as several events (a truncate then a write, an editor's save dance), and a panel
// that reloads three times shows three flashes. Long enough to coalesce a write, short enough that the
// document does not visibly lag the agent writing it.
const DEBOUNCE_MS = 300;

// How long to wait before looking for a renamed-over file again. A rename is not atomic from the
// watcher's side: the old entry is gone and the new one may not be visible yet.
const REWATCH_MS = 120;

function init(context) {
  ctx = context;
}

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
      // the PATH. If the file is gone the entry keeps its subscribers and no watcher: a later re-open
      // through `watchFile` picks it up again, and nothing pretends to be watching in the meantime.
      try { watcher.close(); } catch { /* already gone */ }
      entry.watcher = null;
      setTimeout(() => {
        const live = entries.get(resolved);
        if (!live || live.watcher) return;
        if (!fs.existsSync(resolved)) return;
        attach(resolved, live);
        notify(resolved);
      }, REWATCH_MS);
    });
  } catch (err) {
    entry.watcher = null;
    return { ok: false, error: err.message };
  }
  entry.watcher = watcher;
  return { ok: true };
}

function closeEntry(resolved) {
  const entry = entries.get(resolved);
  if (!entry) return;
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
    entry = { watcher: null, subscribers: new Map() };
    entries.set(resolved, entry);
    const started = attach(resolved, entry);
    if (!started.ok) { entries.delete(resolved); return started; }
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

/** For tests and teardown: how many files are watched, and by how many windows. */
function watchStats() {
  return [...entries].map(([path, e]) => ({ path, subscribers: e.subscribers.size, watching: !!e.watcher }));
}

function closeAll() {
  for (const resolved of [...entries.keys()]) closeEntry(resolved);
}

function registerIpc(ipcMain) {
  ipcMain.handle('watch-file', (event, filePath) => watchFile(event.sender, filePath));
  ipcMain.handle('unwatch-file', (event, filePath) => unwatchFile(event.sender, filePath));
}

module.exports = { init, registerIpc, watchFile, unwatchFile, releaseWebContents, watchStats, closeAll };
