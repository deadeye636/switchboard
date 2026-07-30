// Detached session windows (#2): a session moved into an OS window of its own, so it can live on a
// second monitor while the main window carries the rest.
//
// The PTY never moves. It stays in `activeSessions` exactly as before; what changes is **which window
// receives its byte stream**. That is the whole mechanism, and it is why detach is cheap here:
//
//   terminal-data                        -> the OWNING window (this module decides)
//   session-detached / session-reattached -> the window that must let go / take over. Main by default;
//                                           since #316 either end can be a detached window.
//   everything else                      -> the main window (the sidebar, the attention inbox and the
//                                           badges live there, and they must keep updating for a
//                                           detached session too)
//
// Get that separation wrong and the symptom is subtle: attention badges stop appearing for the one
// session the user pushed to the other screen — the one they are least likely to be watching.
//
// The detached window loads the SAME `index.html` with `?detached=<sessionId>`. It therefore inherits
// every terminal fix (ConPTY quirks, paste, mouse reporting, right-click, WebGL fallback) instead of
// growing a second, quietly diverging renderer. The cost is one full renderer per detached WINDOW —
// since #316 a window can hold several sessions — which is accepted for a power feature.
//
// Needs no DB, and `BrowserWindow` arrives through ctx rather than a top-level require — that is what
// keeps the routing and the detach/reattach state machine loadable in `node --test`
// (test/detach-routing.test.js), which is the half that decides where a session's bytes go.
'use strict';

const path = require('path');

let ctx = null;

// sessionId -> BrowserWindow. A session appears here for exactly as long as its window lives.
const detachedWindows = new Map();

/**
 * @param {object} context
 * @param {() => Electron.BrowserWindow|null} context.getMainWindow  a GETTER — see the ctx rule.
 * @param {() => boolean} context.getAppQuitting
 * @param {Map} context.activeSessions
 * @param {object} context.log
 * @param {typeof Electron.BrowserWindow} context.BrowserWindow  through ctx — see the header.
 * @param {Electron.Screen} [context.screen]  optional: which display a detach opens on (#362). Absent
 *   in `node --test`, where placement falls back to the pre-#362 offset from the main window.
 */
function init(context) {
  ctx = context;
}

/** The window that renders this session's output: its own if it has one, else the main window. */
function windowForSession(sessionId) {
  const win = detachedWindows.get(sessionId);
  if (win && !win.isDestroyed()) return win;
  return ctx.getMainWindow();
}

// A window is addressed by id: 'main', or the BrowserWindow id as a string. A detached window may own
// SEVERAL sessions since #316 — the map is keyed by session, so one window can appear under many keys.
const MAIN_WINDOW_ID = 'main';

function windowIdOf(win) {
  return win && !win.isDestroyed() ? String(win.id) : null;
}

/** Every session currently rendered by this window. */
function sessionsInWindow(win) {
  const ids = [];
  for (const [sessionId, w] of detachedWindows) {
    if (w === win) ids.push(sessionId);
  }
  return ids;
}

/**
 * Convert a point the ASKING renderer measured into the screen coordinates `getBounds()` speaks (#360).
 *
 * The renderer reports CSS pixels in its own frame; a zoom factor scales those, and the OS's DIPs do
 * not move with it. Both boxes describe the same window, so their ratio is exactly the conversion —
 * no zoom factor has to be fetched, and a wrong guess about how zoom behaves cannot creep in.
 *
 * Falls through to the point as given when there is nothing to compare against: a caller that sends no
 * box, a box with no extent, or a window that is gone. Being slightly off beats refusing to answer.
 */
function toScreenPoint(win, point, box) {
  if (!win || win.isDestroyed() || !box) return point;
  const w = Number(box.width);
  const h = Number(box.height);
  if (!(w > 0) || !(h > 0)) return point;
  const bounds = win.getBounds();
  return {
    x: bounds.x + ((point.x - Number(box.x || 0)) * (bounds.width / w)),
    y: bounds.y + ((point.y - Number(box.y || 0)) * (bounds.height / h)),
  };
}

function detachedWindowById(windowId) {
  for (const win of detachedWindows.values()) {
    if (!win.isDestroyed() && String(win.id) === String(windowId)) return win;
  }
  return null;
}

/**
 * The windows a session can be moved to (#316): the main window, plus every detached one. Named by
 * what they show, because "window 3" means nothing to the user.
 *
 * With a `sessionId`, the window that currently holds it is marked `current` — the renderer cannot
 * work that out on its own. A detached window's own set is not in its renderer, and "not detached"
 * meaning "in main" is only true when asked from the main window.
 */
function listSessionWindows(sessionId) {
  const holder = sessionId ? detachedWindows.get(sessionId) : null;
  const holderLive = holder && !holder.isDestroyed() ? holder : null;
  const out = [{
    id: MAIN_WINDOW_ID,
    title: 'Main window',
    isMain: true,
    // NOT an empty set — main renders everything this map does not claim, and answering that here
    // would mean walking the renderer's state from the main process. `null` says "not knowable from
    // here"; an empty array would read as "holds nothing", which is the opposite of true.
    sessionIds: null,
    current: !!sessionId && !holderLive,
  }];
  const seen = new Set();
  for (const win of detachedWindows.values()) {
    if (win.isDestroyed() || seen.has(win.id)) continue;
    seen.add(win.id);
    out.push({
      id: windowIdOf(win),
      title: win.getTitle() || 'Session window',
      isMain: false,
      sessionIds: sessionsInWindow(win),
      current: win === holderLive,
    });
  }
  return out;
}

/** Is this session currently rendered in a window of its own? */
function isDetached(sessionId) {
  const win = detachedWindows.get(sessionId);
  return !!(win && !win.isDestroyed());
}

/** Every detached session id — the renderer asks on boot so its tabs can show the state. */
function detachedSessionIds() {
  return [...detachedWindows.keys()].filter(isDetached);
}

function sendToMain(channel, ...args) {
  const main = ctx.getMainWindow();
  if (main && !main.isDestroyed()) main.webContents.send(channel, ...args);
}

/**
 * Does this session still have a process? Sent along with every `session-reattached`, because the
 * window taking it must not resume a CLI the user stopped — and the renderer's own answer is a
 * POLLED snapshot, up to 30 s stale in an idle window. Here it is the authoritative map.
 */
function isRunning(sessionId) {
  return !!ctx.activeSessions.get(sessionId);
}

function sendAdopt(win, sessionId) {
  const running = isRunning(sessionId);
  if (win) win.webContents.send('session-reattached', sessionId, running);
  else sendToMain('session-reattached', sessionId, running);
}

/**
 * Where a detached window goes on a given display (#362).
 *
 * Pure so `node --test` can exercise the multi-monitor cases, which are exactly the ones a machine
 * with one screen can never show. `workArea` is the target display's usable box (taskbar already
 * subtracted) and `source` is the window being detached FROM, both in screen DIPs.
 *
 * The size is a fraction of the source window, but never larger than the display it is going to — a
 * window torn off a 4K screen onto a laptop panel would otherwise open bigger than the panel.
 *
 * The offset exists so a detach never lands exactly on top of what it came from. That anchor only
 * means something while both are on the same display; across displays it would place the window by
 * the coordinates of a screen it is leaving, so the target's own origin is used instead. Either way
 * the result is clamped into the work area, because a window half off the edge is worse than one
 * sitting a little off where the user aimed.
 */
function detachWindowBounds(workArea, source) {
  // The display has the last word, minimum size included: a work area smaller than the minimum is
  // rare but real (a small secondary panel, a scaled display), and flooring to 640x400 there would
  // hang the window off two edges of the screen it was just placed on. Better a window smaller than
  // the minimum than one the user cannot reach.
  const width = Math.min(Math.max(640, Math.round(source.width * 0.6)), workArea.width);
  const height = Math.min(Math.max(400, Math.round(source.height * 0.8)), workArea.height);
  const sourceOnTarget = source.x >= workArea.x && source.x < workArea.x + workArea.width
    && source.y >= workArea.y && source.y < workArea.y + workArea.height;
  const anchorX = (sourceOnTarget ? source.x : workArea.x) + 60;
  const anchorY = (sourceOnTarget ? source.y : workArea.y) + 60;
  const clamp = (v, lo, hi) => Math.round(Math.max(lo, Math.min(v, hi)));
  return {
    width,
    height,
    x: clamp(anchorX, workArea.x, workArea.x + workArea.width - width),
    y: clamp(anchorY, workArea.y, workArea.y + workArea.height - height),
  };
}

/**
 * The work area of the display the user pointed at, or null when that cannot be answered — no
 * `screen` module (the module is loadable without Electron on purpose) or a point nobody sent.
 * A null answer means "place it the way it was always placed", never a guessed display.
 */
function workAreaForPoint(point) {
  const screen = ctx && ctx.screen;
  if (!screen) return null;
  try {
    const at = (point && Number.isFinite(point.x) && Number.isFinite(point.y))
      ? { x: Math.round(point.x), y: Math.round(point.y) }
      : screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(at);
    return (display && display.workArea) || null;
  } catch {
    return null; // an unusable screen module must not stop a detach
  }
}

function createDetachWindow(sessionId, title, screenPoint) {
  const main = ctx.getMainWindow();
  const source = main && !main.isDestroyed() ? main.getBounds() : { width: 1100, height: 700, x: 80, y: 80 };
  const workArea = workAreaForPoint(screenPoint);
  const bounds = workArea ? detachWindowBounds(workArea, source) : {
    width: Math.max(640, Math.round(source.width * 0.6)),
    height: Math.max(400, Math.round(source.height * 0.8)),
    // Offset from the main window so a detach never lands exactly on top of it.
    x: source.x + 60,
    y: source.y + 60,
  };
  const win = new ctx.BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    title: title || 'Switchboard — Session',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    show: false,
    backgroundColor: '#111118', // index.html's body background — no white first frame
    // NOT `parent: main`: a child window is always on top of its parent, which defeats the point of
    // moving a session to another monitor and looking at the main window on this one.
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false, // a background monitor must keep painting its terminal
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { detached: sessionId } });
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.show();
    win.focus();
  });

  // Closing the window hands the session back rather than ending it: the PTY ran through the whole
  // detour and the user closed a VIEW, not a process. Skip on quit — everything is going away anyway.
  win.on('closed', () => {
    // Every session this window still owns comes back — since #316 that can be more than the one it
    // was opened for. A session whose entry was already removed (the explicit reattach and the move
    // path both delete BEFORE destroying, precisely so this does not fire a second notification) is
    // not in the list, so the main window never reopens anything twice.
    const owned = sessionsInWindow(win);
    for (const id of owned) detachedWindows.delete(id);
    if (!owned.length || ctx.getAppQuitting()) return;
    ctx.log.info(`[detach] window closed, ${owned.length} session(s) return to the main window`);
    for (const id of owned) sendAdopt(null, id);
  });

  return win;
}

/**
 * A live session moved onto a new id (a fork, an accepted plan). Its window has to follow, or the
 * output — sent under the new id from that moment on — routes to the main window while the detached
 * one, still registered under the old id, goes quiet with no sign of why.
 */
function rekey(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;
  const win = detachedWindows.get(fromId);
  if (!win) return;
  detachedWindows.delete(fromId);
  if (!win.isDestroyed()) {
    detachedWindows.set(toId, win);
    // The window knows itself by the id in its URL; tell it the id changed so its own tab and its
    // reattach follow along.
    win.webContents.send('detached-session-rekeyed', fromId, toId);
  }
  sendToMain('session-detach-rekeyed', fromId, toId);
}

/** Close every detached window — the main window is going, so its sessions have nowhere to be. */
function closeAll() {
  // Clear FIRST, then destroy: the `closed` handler decides by "am I still the registered window?",
  // and this path must not ask the main window to take anything back. It runs from the main window's
  // own close, where `appQuitting` is still false on the plain Alt+F4 path — so the quit check alone
  // would let a reattach fire into a renderer that is being torn down.
  const windows = [...detachedWindows.values()];
  detachedWindows.clear();
  for (const win of windows) {
    if (win && !win.isDestroyed()) win.destroy();
  }
}

/**
 * @param {Electron.IpcMain} ipc  passed in, not required — see the header.
 */
function registerIpc(ipc) {
  // `at` (#362) is optional and carries where the user aimed: `{ point, box }` in the ASKING
  // renderer's coordinates, the same pair `window-at-screen-point` takes and for the same reason —
  // only the ratio of the two boxes converts CSS pixels into the DIPs `screen` speaks. Absent (a menu
  // or keyboard detach, an older renderer) the display under the pointer is used instead.
  ipc.handle('detach-session', (event, sessionId, title, at) => {
    if (!sessionId) return { ok: false, error: 'no session' };
    // Already in a window of its own? Then this is nothing to do, and focusing it is the honest
    // answer. But "detached" is not the same as "alone" since #316: a detached window can hold
    // several sessions, and tearing one out of THAT (#363) is a real request — the session does not
    // have a window of its own yet, it is sharing one. So only the window holding it alone
    // short-circuits; a shared one falls through and the session gets its own.
    const holder = detachedWindows.get(sessionId);
    const holderLive = holder && !holder.isDestroyed() ? holder : null;
    if (holderLive && sessionsInWindow(holderLive).length <= 1) {
      holderLive.focus();
      return { ok: true, already: true, windowId: windowIdOf(holderLive) };
    }
    // A session with no process may go too (#319). The refusal used to live here because the new
    // window mounts by calling openTerminal, and with nothing running that lands in the SPAWN branch
    // — so detaching a dead session opened a window and silently started a CLI. What changed is the
    // renderer: since #318 a session without a process is shown with a Launch button instead of being
    // started by the act of opening it, and the detached window now does the same. The guard that
    // mattered ("a detach never spawns") therefore moved to where it belongs — the window does not
    // mount what has no process.
    const running = !!ctx.activeSessions.get(sessionId);
    const sender = event && event.sender;
    const asking = sender ? ctx.BrowserWindow.fromWebContents(sender) : null;
    const aimedAt = (at && at.point) ? toScreenPoint(asking, at.point, at.box) : null;
    const win = createDetachWindow(sessionId, title, aimedAt);
    detachedWindows.set(sessionId, win);
    ctx.log.info(`[detach] session moved to its own window: ${sessionId}${running ? '' : ' (not running)'}`);
    // Whoever holds it now releases its terminal; the PTY keeps running, and the new window attaches
    // to it. Two renderers on one PTY would double every keystroke's echo. Addressed to the window
    // that actually has it (#363) — main for the ordinary case, the sharing detached window when the
    // session was torn out of one. Telling main to let go of a session it never held releases
    // nothing, and the old window would keep drawing a session that had moved away.
    if (holderLive) holderLive.webContents.send('session-detached', sessionId);
    else sendToMain('session-detached', sessionId);
    // The id of the window just made, so the caller can send more sessions after it (#340). Moving a
    // whole pane is "detach the first tab, move the rest to where it went", and without this the
    // renderer would have to identify that window by guessing at `listSessionWindows` — by the title
    // it was given, which is a session name and need not be unique.
    return { ok: true, windowId: windowIdOf(win) };
  });

  // `reattach-session` used to live here. It is `move-session-to-window(id, 'main')` with a window
  // destroy hard-coded instead of "close it if it is now empty" — every caller went through the move
  // handler once #316 landed, so keeping both would have left two paths to the same handover, one of
  // them wrong for a window holding more than one session.

  /**
   * Move a session between windows (#316) — main → a detached window, detached → main, detached →
   * another detached window. Same handover the detach path uses: the giving window releases its
   * terminal (the PTY runs on), then the taking window attaches. The order matters — release first,
   * or two renderers hold one PTY for the length of an IPC round trip and echo every keystroke twice.
   */
  ipc.handle('move-session-to-window', (_event, sessionId, targetWindowId) => {
    if (!sessionId) return { ok: false, error: 'no session' };
    // A session with no process moves too (#332). The refusal that stood here predated #319: back then
    // the taking window mounted whatever it was given, and mounting a session with no PTY spawns one —
    // so a move resumed a CLI the user had stopped (#315). That rule now lives where the mount does.
    // The renderer gates on it three times over (the boot reconcile, `adoptOwnedSessions` and
    // `adoptSession`), each from the authoritative answer `sendAdopt` carries rather than its own poll.
    // A second copy of the rule here is what stranded a dormant session in a window it shared: the menu
    // entry was disabled and this call refused it, so closing the whole window was the only way out —
    // which handed back every live session the window held as well.
    const target = String(targetWindowId) === MAIN_WINDOW_ID ? null : detachedWindowById(targetWindowId);
    if (String(targetWindowId) !== MAIN_WINDOW_ID && !target) return { ok: false, error: 'window is gone' };

    const source = detachedWindows.get(sessionId) || null;
    const sourceLive = source && !source.isDestroyed() ? source : null;
    if (sourceLive === target) return { ok: true, already: true };

    // Release. The main window answers `session-detached`; a detached one answers the same channel,
    // so both sides of the move run the same code path.
    if (sourceLive) sourceLive.webContents.send('session-detached', sessionId);
    else sendToMain('session-detached', sessionId);

    // Re-register before telling the target to take it: `windowForSession` decides where the PTY's
    // bytes go, and the replay the target is about to ask for must already route to it.
    if (target) detachedWindows.set(sessionId, target);
    else detachedWindows.delete(sessionId);

    if (target) {
      sendAdopt(target, sessionId);
      if (target.isMinimized()) target.restore();
      target.focus();
    } else {
      sendAdopt(null, sessionId);
    }
    // A detached window that just gave away its last session has nothing left to show, and no chrome
    // to pick a new one with — the sidebar lives in the main window. So it goes. Its entries are
    // already out of the map, so `closed` hands nothing back.
    if (sourceLive && !sessionsInWindow(sourceLive).length) sourceLive.destroy();
    ctx.log.info(`[detach] session moved to ${target ? 'window ' + target.id : 'the main window'}: ${sessionId}`);
    return { ok: true };
  });

  ipc.handle('list-session-windows', (_event, sessionId) => listSessionWindows(sessionId));

  /**
   * "Which of my windows is at this point on the screen?" (#360)
   *
   * Asked when a tab is dragged OUT of a window. HTML5 drag and drop ends at the window boundary —
   * two windows are two renderer processes with no shared drag context, so the far side never sees a
   * `drop` and the near side only knows the pointer left its own box. Which window it left it FOR is
   * a question only this process can answer, because only it has the windows in screen coordinates.
   *
   * `box` is the asking window as its own renderer measured it (`window.screenX/outerWidth`, …). It is
   * not redundant with `getBounds()`: the renderer's numbers are CSS pixels in its frame and can carry
   * a zoom factor, while bounds are DIPs in the OS's. The ratio between the two boxes converts the
   * point exactly, whatever the zoom is, and without it a zoomed window would hit-test its neighbours
   * at the wrong place. A caller that sends no box is trusted as-is.
   *
   * Answers with the id `move-session-to-window` takes, or null for "no window of ours is there".
   */
  ipc.handle('window-at-screen-point', (event, point, box) => {
    const x = Number(point && point.x);
    const y = Number(point && point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const sender = event && event.sender;
    const asking = sender ? ctx.BrowserWindow.fromWebContents(sender) : null;
    const screenPoint = toScreenPoint(asking, { x, y }, box);

    const main = ctx.getMainWindow();
    const candidates = [];
    if (main && !main.isDestroyed()) candidates.push({ id: MAIN_WINDOW_ID, win: main });
    const seen = new Set();
    for (const win of detachedWindows.values()) {
      if (win.isDestroyed() || seen.has(win.id)) continue;
      seen.add(win.id);
      candidates.push({ id: windowIdOf(win), win });
    }
    for (const candidate of candidates) {
      // The asking window is skipped by IDENTITY rather than geometry: it is the one window whose own
      // box the caller has already ruled out, and re-deciding that here from different numbers could
      // only disagree with it.
      if (asking && candidate.win === asking) continue;
      const b = candidate.win.getBounds();
      if (screenPoint.x < b.x || screenPoint.x > b.x + b.width) continue;
      if (screenPoint.y < b.y || screenPoint.y > b.y + b.height) continue;
      // First match wins. Electron exposes no z-order, so with two windows stacked under the pointer
      // the topmost one cannot be identified — this is the known limit of the answer, not an oversight.
      return candidate.id;
    }
    return null;
  });

  /**
   * "What do I hold?", asked by a detached window about ITSELF (#326, #331).
   *
   * The window cannot answer this on its own. Its URL names the session it was opened for, and that
   * is all it knows: sessions moved in later live only in this map, and a session moved in while the
   * window was still booting was announced to a renderer that had no session list yet to mount it
   * from. Both end the same way — main routes a session's bytes to a window that draws it nowhere.
   *
   * So main answers, addressed by the ASKER rather than by an id the renderer would have to guess.
   * The main window is not in the map and correctly gets an empty list: what it shows is its own
   * business, and everything not in this map is already its.
   */
  ipc.handle('sessions-in-my-window', (event) => {
    const sender = event && event.sender;
    if (!sender) return [];
    const win = ctx.BrowserWindow.fromWebContents(sender);
    if (!win || win.isDestroyed()) return [];
    return sessionsInWindow(win);
  });

  /**
   * "I cannot render this one" — the taking window gives a claim back (#331).
   *
   * An adopt can fail on the renderer's side: the session record never arrives, or the process ended
   * while the window was waiting for it. Main would otherwise keep routing that session's bytes to a
   * window that draws it nowhere, and `listSessionWindows` would keep offering it as held. So the
   * claim falls here, and the main window is told to take it — its own adopt then decides whether
   * there is still a process worth mounting.
   *
   * Only the window that HOLDS the session may give it up: a stale message from a window that has
   * since handed it on must not un-register the new owner.
   */
  ipc.handle('release-session-claim', (event, sessionId) => {
    const sender = event && event.sender;
    const holder = sessionId ? detachedWindows.get(sessionId) : null;
    if (!holder || holder.isDestroyed() || !sender || holder.webContents !== sender) return { ok: false };
    // Same order as a move — release, re-register, adopt. The release leg looks redundant (the caller
    // reaches this because it mounted NOTHING) but it is what makes the handover safe rather than
    // dependent on the caller being right about itself: if anything did get mounted meanwhile, this
    // tears it down before the main window attaches, instead of leaving two renderers on one PTY.
    holder.webContents.send('session-detached', sessionId);
    detachedWindows.delete(sessionId);
    ctx.log.info(`[detach] window ${holder.id} could not render ${sessionId}; the claim returns to the main window`);
    sendAdopt(null, sessionId);
    return { ok: true };
  });

  ipc.handle('is-session-detached', (_event, sessionId) => isDetached(sessionId));
  ipc.handle('detached-session-ids', () => detachedSessionIds());

  // A detached window asks who it is. The query string already says so; this is the answer for code
  // that would rather not parse a URL.
  ipc.handle('focus-detached-window', (_event, sessionId) => {
    const win = detachedWindows.get(sessionId);
    if (!win || win.isDestroyed()) return { ok: false };
    if (win.isMinimized()) win.restore();
    win.focus();
    return { ok: true };
  });
}

module.exports = {
  init,
  registerIpc,
  rekey,
  detachWindowBounds,
  windowForSession,
  isDetached,
  detachedSessionIds,
  listSessionWindows,
  sessionsInWindow,
  closeAll,
  detachedWindows,
};
