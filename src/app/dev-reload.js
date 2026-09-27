// app/dev-reload.js — a dev run follows an edit under `src/` (#665): a renderer file reloads the windows,
// anything else restarts the whole app, and the restart goes through the app's own quit.
//
// It replaces `electron-reloader`, which got both halves wrong, each measured on a demo run:
//
//   1. IT RESTARTED WITH `app.exit(0)`. Electron documents that `exit` emits neither `before-quit` nor
//      `will-quit`, so the ordered teardown in `lifecycle.js` never ran: no PTY was asked to stop, no
//      worker was terminated, the database stayed open. With a terminal open the old main process then
//      never finished exiting — its window gone, its debug port closed, its threads alive — and Electron's
//      relauncher, which waits for the old process to die before it starts the new one, waited for good.
//      Nothing came back until somebody killed the old process by hand; the moment they did, the relauncher
//      started the new one. `app.relaunch()` followed by `app.quit()` is the same restart through the quit
//      every user takes, so the teardown waits for the PTYs (#424) and closes what it opened (#397).
//
//   2. IT DECIDED "MAIN PROCESS" FROM A SNAPSHOT. The reloader collected `module.children` at the moment
//      it was required — near the top of `main.js` — so only the modules loaded BEFORE that line counted.
//      Most of the main process (`app/terminal/spawn.js`, `db/`, `app/windows.js`, `app/lifecycle.js`, the
//      settings, the handoffs, …) is required further down, and an edit to any of it reloaded the renderer
//      alone: the window flickered, the old main process kept running, and a click test after the edit read
//      code no longer on disk with nothing on screen to say so. The same went for a worker file, which
//      never appears in the main process's module tree at all. So the decision is by PLACE now:
//      `src/renderer/**` is the renderer's, everything else under `src/` is the main process's or loaded by
//      both (`src/shared/**`, `src/preload.js`), and a restart is the only reload that covers it.
//
// The watch is `src/` and nothing wider. The old reloader watched the whole repository, which is how it
// statted the packaged `app.asar` under `dist/` and held it open for the life of the process (#483,
// `build-dirs.js`); an edit outside `src/` reaches no running code, so there is nothing there to watch.
// `fs.watch` with `recursive` does not enumerate the tree first and stats nothing, and a build directory
// name inside `src/` is still skipped by name, so a stray `dist/` there changes nothing.
//
// Started near the top of `main.js` on purpose: a broken edit that throws while the rest of `main.js`
// loads leaves this watcher running, so the save that fixes it restarts the app.
'use strict';

const fs = require('fs');
const path = require('path');
const { isBuildDir } = require('./build-dirs');

// One save is several events (a write, a rename, an editor's temp file), and a `git` operation is
// hundreds. They are gathered for this long and answered once.
const SETTLE_MS = 300;

/**
 * What an edit at this path (relative to `src/`) asks for: `'restart'`, `'reload'`, or null for nothing.
 * Pure, so the rule is testable without Electron.
 */
function classifyChange(relPath) {
  if (typeof relPath !== 'string' || !relPath) return null;
  const parts = relPath.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return null;
  // Dotfiles and dot-directories (an editor's swap file, `.DS_Store`), generated output and fetched
  // dependencies: nothing the running app loads.
  if (parts.some((p) => p.startsWith('.') || isBuildDir(p))) return null;
  const leaf = parts[parts.length - 1];
  if (leaf.endsWith('.map') || leaf.endsWith('~')) return null;
  return parts[0] === 'renderer' ? 'reload' : 'restart';
}

/**
 * Watch `srcDir` and follow an edit. Returns `{ close() }`, or null when nothing was started (a packaged
 * build, or a platform whose `fs.watch` cannot recurse).
 *
 * ctx: { app, BrowserWindow, srcDir, log, watch?, settleMs? } — `watch` stands in for `fs.watch` in a test.
 */
function start(ctx) {
  const { app, BrowserWindow, srcDir, log } = ctx;
  // A packaged build has no source tree to follow; the old reloader had the same guard.
  if (!app || app.isPackaged) return null;
  const settleMs = ctx.settleMs ?? SETTLE_MS;

  const pending = new Set();
  let timer = null;
  let restarting = false;
  let watcher = null;

  const stop = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (watcher) { try { watcher.close(); } catch { /* already closed */ } watcher = null; }
  };

  const settle = () => {
    timer = null;
    const changed = [...pending];
    pending.clear();
    if (restarting || !changed.length) return;
    const restartFor = changed.find((p) => classifyChange(p) === 'restart');
    if (restartFor) {
      restarting = true;
      // A state change, and the line a log reader needs to tell a restart from a crash.
      log?.info?.(`[dev-reload] ${restartFor.replace(/\\/g, '/')} changed — restarting the app`);
      stop();
      app.relaunch();
      app.quit();
      return;
    }
    const wins = BrowserWindow ? BrowserWindow.getAllWindows() : [];
    log?.debug?.(`[dev-reload] ${changed.length} renderer file(s) changed — reloading ${wins.length} window(s)`);
    for (const win of wins) {
      try { if (!win.isDestroyed()) win.webContents.reloadIgnoringCache(); } catch { /* window going away */ }
    }
  };

  const onEvent = (_type, filename) => {
    if (restarting || !filename) return;
    const rel = String(filename);
    if (!classifyChange(rel)) return;
    pending.add(rel);
    if (timer) clearTimeout(timer);
    timer = setTimeout(settle, settleMs);
    if (timer.unref) timer.unref();
  };

  try {
    const dir = path.resolve(srcDir);
    const options = { recursive: true, persistent: false };
    watcher = ctx.watch ? ctx.watch(dir, options, onEvent) : fs.watch(dir, options, onEvent);
    watcher.on?.('error', (err) => {
      log?.warn?.(`[dev-reload] the watch on src/ failed and is off until the next start: ${err?.message || err}`);
      stop();
    });
  } catch (err) {
    log?.warn?.(`[dev-reload] could not watch src/ — edits will not restart the app: ${err?.message || err}`);
    return null;
  }

  // The teardown's last line says nothing of ours is left open (#397); this watch is one of ours.
  app.on?.('will-quit', stop);
  return { close: stop };
}

module.exports = { start, classifyChange, SETTLE_MS };
