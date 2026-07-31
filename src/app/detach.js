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

// Every window this module made, whatever it holds (#370).
//
// The map above answers "where do this session's bytes go" and is keyed by SESSION — which made it
// the list of windows too, for as long as every window had one. A window holding nothing but a view
// has no key in it, and a window absent from the only list there is is invisible to the move menu,
// to the drop hit-test and to the quit teardown: it cannot be moved to, cannot be dropped on, and
// survives the app it belongs to. So the two questions are two collections now, and everything that
// asks "which windows are there" reads THIS one.
const detachedWins = new Set();

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
  for (const win of detachedWins) {
    if (!win.isDestroyed() && String(win.id) === String(windowId)) return win;
  }
  return null;
}

/** Every live detached window, in the order they were made. */
function liveDetachedWindows() {
  const out = [];
  for (const win of detachedWins) {
    if (win.isDestroyed()) detachedWins.delete(win);
    else out.push(win);
  }
  return out;
}

/**
 * The windows a session can be moved to (#316): the main window, plus every detached one. Named by
 * what they show, because "window 3" means nothing to the user.
 *
 * With a `sessionId`, the window that currently holds it is marked `current` — the renderer cannot
 * work that out on its own. A detached window's own set is not in its renderer, and "not detached"
 * meaning "in main" is only true when asked from the main window.
 *
 * `asking` marks the window the question came FROM, as `isSelf`. A caller with a session in hand can
 * read that off `current`, but a view has no session to ask about — and a window holding only a view
 * (#370) has no session to identify itself by either, so without this it would offer itself as a
 * place to move its own view to.
 */
function listSessionWindows(sessionId, asking) {
  const holder = sessionId ? detachedWindows.get(sessionId) : null;
  const holderLive = holder && !holder.isDestroyed() ? holder : null;
  const main = ctx.getMainWindow();
  const out = [{
    id: MAIN_WINDOW_ID,
    title: 'Main window',
    isMain: true,
    // NOT an empty set — main renders everything this map does not claim, and answering that here
    // would mean walking the renderer's state from the main process. `null` says "not knowable from
    // here"; an empty array would read as "holds nothing", which is the opposite of true.
    sessionIds: null,
    current: !!sessionId && !holderLive,
    isSelf: !!asking && asking === main,
  }];
  for (const win of liveDetachedWindows()) {
    out.push({
      id: windowIdOf(win),
      title: win.getTitle() || 'Session window',
      isMain: false,
      sessionIds: sessionsInWindow(win),
      current: win === holderLive,
      isSelf: !!asking && win === asking,
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
 * Tell the window that RENDERS a session what that session is doing, so its own timeline knows — and
 * nothing more (#395).
 *
 * The main window already hears every one of these on its own channels (`cli-busy-state`,
 * `terminal-notification`, `attention-signal`) and records them there, so this deliberately sends
 * NOTHING when the owner is main: it would double-record, and main is not what was missing.
 *
 * The channel is the guarantee. Its receiver calls a record-only entry point, so a window of its own
 * cannot grow an inbox out of this — the announcing surfaces are gated separately (#390), but a gate is
 * a behaviour and this is a structure. Everything that raises stays addressed to main.
 *
 * A signal sent to a window that is still loading is dropped, and that is fine here: what the taking
 * window needs is the STATE, and that travels with `session-reattached` instead. Deferring a stale edge
 * onto a window that has since been told the truth would be worse than losing it.
 */
function sendTimelineSignal(sessionId, signal) {
  if (!sessionId || !signal) return false;
  const main = ctx.getMainWindow();
  const owner = detachedWindows.get(sessionId);
  if (!owner || owner === main || owner.isDestroyed()) return false;
  try { owner.webContents.send('timeline-signal', sessionId, signal); } catch { return false; }
  return true;
}

/**
 * Does this session still have a process? Sent along with every `session-reattached`, because the
 * window taking it must not resume a CLI the user stopped — and the renderer's own answer is a
 * POLLED snapshot, up to 30 s stale in an idle window. Here it is the authoritative map.
 */
function isRunning(sessionId) {
  return !!ctx.activeSessions.get(sessionId);
}

/**
 * Is the agent working right NOW? Carried alongside `running` for the same reason (#395): a session
 * that is busy and STAYS busy sends no new edge, so a window taking one mid-turn would have nothing to
 * learn from and would draw a visibly working session as idle until the turn happened to end.
 *
 * Two sources, because busy has two: the PTY heuristics latch it on the session record, and the
 * backends that name their own sessions have it derived from their store instead (`watch/adopt.js`
 * owns that map). ctx supplies the second one; absent, the first still answers.
 */
function isBusy(sessionId) {
  const session = ctx.activeSessions.get(sessionId);
  if (session && session._cliBusy) return true;
  return !!(ctx.isSessionBusy && ctx.isSessionBusy(sessionId));
}

/**
 * `placement` (#375) is where in the taking window the session goes — the pane and zone that window
 * itself highlighted while the drag was over it. Absent for every other path, and the renderer then
 * does what it always did: the active pane.
 */
function sendAdopt(win, sessionId, placement) {
  const running = isRunning(sessionId);
  const busy = running && isBusy(sessionId);
  if (win) win.webContents.send('session-reattached', sessionId, running, placement || null, busy);
  else sendToMain('session-reattached', sessionId, running, placement || null, busy);
}

// --- Which window hosts one of the app's own views (#364) ---
//
// Memory, Plans and Work files are steered from the SIDEBAR, and a detached window has none — spec 17
// §2 puts the sidebar in the main window on purpose. So when one of those views sits in another
// window, the click that picks a file happens here and the effect has to be delivered there.
//
// Deliberately NOT the same thing as `detachedWindows`. That map answers "where do this session's
// bytes go" and is verified constantly by output the user can see. This one answers a rarer question
// and its staleness is invisible, so every entry is dropped the moment the window says so, or the
// window dies — never inferred, never repaired by guessing.
// BrowserWindow -> what that window last reported holding: `{ views, layout }`, where views is
// `[{ kind, ref, file }]` in tab order and layout is the serialised pane tree (#372) — null from the
// main window, which keeps its own in localStorage.
//
// One registry, four readers — which window a sidebar click is routed to (#364), whether a window has
// anything left to show once its last session leaves (#370), and what a window's views (#371) and
// arrangement (#372) have to be when it is restored.
//
// A per-WINDOW snapshot rather than a kind->window map, because three of those four questions are
// about a window rather than about a kind, and a second registry answering "what does this window
// hold" would be a copy of this one that goes stale where nobody looks.
const windowContent = new Map();

/** The views a window says it is showing. */
function viewsInWindow(win) {
  const held = windowContent.get(win);
  return (win && !win.isDestroyed() && held && Array.isArray(held.views)) ? held.views : [];
}

/** The pane arrangement a window says it has, or null — only a detached window reports one. */
function layoutInWindow(win) {
  const held = windowContent.get(win);
  return (win && !win.isDestroyed() && held && held.layout) ? held.layout : null;
}

/**
 * The window a sidebar click for this kind belongs to, or null for "here".
 *
 * The MAIN window wins whenever it shows the kind itself: it has the sidebar, so a view there is
 * steered locally and routing it away would send a click the user made in this window to another
 * one. Otherwise the first other window that says it shows it.
 */
function viewHost(kind) {
  const main = ctx.getMainWindow();
  if (main && viewsInWindow(main).some((v) => v.kind === kind)) return null;
  for (const win of windowContent.keys()) {
    if (win === main || win.isDestroyed()) continue;
    if (viewsInWindow(win).some((v) => v.kind === kind)) return win;
  }
  return null;
}

/**
 * Every DETACHED window showing this kind — who else has to hear that the data changed (#382).
 *
 * Deliberately not `viewHost`: that answers "which ONE window steers this kind" and gives the main
 * window precedence, which is the right question for a click and the wrong one for a notification.
 * A change is interesting to everything showing the view, and the main window is told by its own
 * sender either way — it has the sidebar, so it is never absent from that list.
 *
 * The main window is excluded here rather than at the call sites, so nothing can double-send to it.
 */
function detachedWindowsShowingView(kind) {
  if (!kind) return [];
  const main = ctx && typeof ctx.getMainWindow === 'function' ? ctx.getMainWindow() : null;
  const out = [];
  for (const win of windowContent.keys()) {
    if (win === main || win.isDestroyed()) continue;
    if (viewsInWindow(win).some((v) => v.kind === kind)) out.push(win);
  }
  return out;
}

/** Send one message to every detached window showing `kind`. A window on its way out is skipped. */
function notifyViewWindows(kind, channel, ...args) {
  for (const win of detachedWindowsShowingView(kind)) {
    try { win.webContents.send(channel, ...args); } catch { /* a window on its way out */ }
  }
}

/** Forget everything a window claimed. Called when it goes, whichever way it goes. */
function dropViewHost(win) {
  windowContent.delete(win);
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

/**
 * Make a window of our own.
 *
 * `sessionId` names the session it opens on, and is **null for a window that holds only a view**
 * (#370) — `view` names that kind instead. Everything below is the same either way: a window is a
 * frame around `index.html`, and what it shows is decided by the query it is loaded with. The URL
 * therefore carries a marker of its own (`win=detached`) rather than letting the session id be it —
 * the renderer's "am I a detached window" is an identity question, and a window with no session
 * still has to answer yes.
 */
// --- Bringing the windows back on the next launch (#371) ---
//
// A session in a window of its own used to come back NOWHERE. The main window saves the set it
// renders and a detached session was released from it, so it was in no saved set at all — and the
// windows themselves only ever existed in this process's memory. Quit with three windows on two
// monitors, reopen to one.
//
// The state lives HERE rather than in the renderer's storage, and that is forced: every window loads
// the same origin, so a detached window writing `localStorage` would replace the main window's whole
// restorable set with its own (spec 17 §4). Bounds and the window set are this process's facts anyway.

const RESTORE_DEBOUNCE_MS = 500;
let persistTimer = null;
// Set while `closeAll` is tearing the windows down. Their `closed` handlers run during it, and a
// persist from one of those would write the emptied list over the very state the next launch needs.
let closingAll = false;
let restoreDone = false;
// win -> what a restored window still has to be given, until it asks. PULLED by the renderer rather
// than pushed at it: a push has to pick a moment, and every moment is wrong — `did-finish-load` can
// beat the renderer's own boot, and a later one races the reconcile that mounts what main owns.
const pendingRestore = new Map();

// Saved windows this launch cannot show, kept whole until one can (#378).
//
// The app's own views live in panes mode. A saved window holding nothing but views has no target in
// grid: it came up as an empty frame with no title and no explanation, and — worse — the next state
// write drops a window that holds neither sessions nor views, so the entry was gone for good and
// going back to panes did not bring it back. Held here instead: not opened, not forgotten, written
// back unchanged, and restored the next time the mode can fill it.
const deferredWindows = [];

// Which stored values mean grid. The renderer resolves this in `views/grid-layout.js`
// (`resolveSessionDisplayMode`) and that is the source of truth — since #374 only an EXPLICIT grid
// choice is grid, so anything unrecognised, and above all nothing stored at all, is panes.
// `test/detach-routing.test.js` pins this list to that one, because a spelling added there and not
// here would silently start opening empty frames again.
const GRID_SPELLINGS = ['grid', 'legacy'];
const storedModeIsGrid = (stored) => GRID_SPELLINGS.includes(stored);

// --- Asking a window a question and waiting for its answer (#375) ---
//
// `ipcMain.handle` is renderer→main. This is the other direction, which Electron gives no request/
// response for: main sends with a ticket, the renderer answers on `drop-probe-answer` quoting it, and
// the ticket resolves the promise. Bounded by a timeout, because a renderer that is busy or gone must
// not leave a drag waiting on it — a probe that does not come back is "nowhere", which is the same
// answer as a point over no window of ours, and the caller already refuses to guess from that.
const PROBE_TIMEOUT_MS = 250;
let nextProbeId = 1;
const probes = new Map();

function askForPlacement(win, at, bounds) {
  if (!win || win.isDestroyed()) return Promise.resolve(null);
  const id = nextProbeId++;
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; probes.delete(id); resolve(value); } };
    probes.set(id, finish);
    // NOT unref'd. A quarter of a second is not a leak, and an unref'd timer does not keep the loop
    // alive — so a probe nobody answers would never settle at all, which is a hung drag rather than a
    // fast "nowhere".
    setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    try {
      win.webContents.send('probe-drop-point', id, at, bounds);
    } catch { finish(null); }
  });
}

function clearRemoteHint(win) {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send('clear-drop-hint'); } catch { /* a window on its way out */ }
}

/**
 * Where a saved window goes when it comes back.
 *
 * Pure, and separate from `detachWindowBounds` because it answers a different question: not "where
 * does a new window go" but "is where this one was still a place". `workAreas` are the attached
 * displays' usable boxes and `primary` is the fallback, both in screen DIPs.
 *
 * **A display that is gone must not take the window with it.** The saved position is kept only when
 * a display still covers it — the same ±100 tolerance the main window's restore uses, so a window
 * nudged slightly off an edge still counts as being there. Otherwise it starts at the primary
 * display's origin: the coordinates it had describe a screen that no longer exists, and honouring
 * them puts the window where the user cannot reach it.
 */
function restoreWindowBounds(saved, workAreas, primary) {
  const width = Math.max(320, Math.round(Number(saved && saved.width) || 0) || 900);
  const height = Math.max(240, Math.round(Number(saved && saved.height) || 0) || 700);
  const x = Math.round(Number(saved && saved.x));
  const y = Math.round(Number(saved && saved.y));
  const placed = Number.isFinite(x) && Number.isFinite(y);
  const covers = (area) => placed
    && x >= area.x - 100 && x < area.x + area.width
    && y >= area.y - 100 && y < area.y + area.height;
  const host = (workAreas || []).find(covers) || primary || null;
  if (!host) return { x: placed ? x : 0, y: placed ? y : 0, width, height };
  // Never bigger than the screen it lands on — a window saved on a 4K panel and restored onto a
  // laptop one would otherwise open larger than the display.
  const w = Math.min(width, host.width);
  const h = Math.min(height, host.height);
  const startX = covers(host) ? x : host.x;
  const startY = covers(host) ? y : host.y;
  const clamp = (v, lo, hi) => Math.round(Math.max(lo, Math.min(v, hi)));
  return {
    width: w,
    height: h,
    x: clamp(startX, host.x, host.x + host.width - w),
    y: clamp(startY, host.y, host.y + host.height - h),
  };
}

function placeRestored(saved) {
  const screen = ctx && ctx.screen;
  if (!saved) return null;
  if (!screen) return { ...saved }; // no display module (node --test): take the box as saved
  try {
    const areas = screen.getAllDisplays().map((d) => d.workArea).filter(Boolean);
    const primary = (screen.getPrimaryDisplay() || {}).workArea || null;
    return restoreWindowBounds(saved, areas, primary);
  } catch {
    return { ...saved }; // an unusable screen module must not cost the user their windows
  }
}

/** What each of our windows holds, in the shape the next launch takes. */
function snapshotWindows() {
  const out = [];
  for (const win of liveDetachedWindows()) {
    const sessions = sessionsInWindow(win);
    const views = viewsInWindow(win);
    // A window holding neither is one mid-handover — it is about to close, and saving it would
    // reopen an empty frame next launch.
    if (!sessions.length && !views.length) continue;
    let bounds = null;
    try { bounds = win.getBounds(); } catch { bounds = null; }
    out.push({
      bounds: bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null,
      sessions,
      views,
      layout: layoutInWindow(win),
    });
  }
  // The windows this launch held back (#378). They were never opened, so nothing above can see them —
  // and the loop's own "holds neither" rule is exactly what would erase them. Written back unchanged.
  out.push(...deferredWindows);
  return out;
}

function writeWindowState(list) {
  if (!ctx || typeof ctx.getSetting !== 'function' || typeof ctx.setSetting !== 'function') return;
  try {
    const global = ctx.getSetting('global') || {};
    global.detachedWindows = list;
    ctx.setSetting('global', global);
  } catch { /* a settings write that fails must not take a window with it */ }
}

/**
 * Remember the windows as they are now. Debounced, because the events that change them arrive in
 * bursts — a drag fires `move` per frame, and a pane move detaches one session and moves three more.
 */
function persistWindows() {
  if (closingAll) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeWindowState(snapshotWindows());
  }, RESTORE_DEBOUNCE_MS);
  if (typeof persistTimer.unref === 'function') persistTimer.unref();
}

/** Write the state NOW — the debounce cannot be trusted to fire while the app is going away. */
function persistWindowsNow() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  writeWindowState(snapshotWindows());
}

/**
 * Open the windows the last run left behind. Answers how many it made.
 *
 * Once per process: `createWindow` runs again on macOS `activate`, and a second pass would open a
 * duplicate of every window rather than reveal the ones already standing.
 *
 * The sessions are registered against their window BEFORE it loads, for the same reason a move
 * re-registers before it adopts — `windowForSession` decides where the bytes go, and the window is
 * about to ask for a terminal.
 */
function restoreWindows() {
  if (restoreDone) return 0;
  restoreDone = true;
  if (!ctx || typeof ctx.getSetting !== 'function') return 0;
  let global = null;
  try { global = ctx.getSetting('global') || {}; } catch { return 0; }
  // The user turned restore off. Then it is off for these windows too — reopening an empty frame on
  // a second monitor is exactly the surprise the setting exists to prevent.
  if (global.restoreSessionsOnLaunch === false) return 0;
  const saved = Array.isArray(global.detachedWindows) ? global.detachedWindows : [];
  const gridMode = storedModeIsGrid(global.sessionDisplayMode);
  let made = 0;
  for (const entry of saved) {
    const sessions = Array.isArray(entry && entry.sessions) ? entry.sessions.filter(Boolean) : [];
    const views = Array.isArray(entry && entry.views) ? entry.views.filter((v) => v && v.kind) : [];
    if (!sessions.length && !views.length) continue;
    // Views only, and no panes to put them in (#378). A window with sessions is unaffected: grid
    // shows those, and it is only the view half that has nowhere to go.
    if (!sessions.length && gridMode) { deferredWindows.push(entry); continue; }
    const win = createDetachWindow({ bounds: placeRestored(entry.bounds) });
    for (const id of sessions) detachedWindows.set(id, win);
    pendingRestore.set(win, { sessions, views, layout: (entry.layout && entry.layout.tree) ? entry.layout : null });
    made++;
  }
  if (made) ctx.log.info(`[detach] restoring ${made} window(s) from the last run`);
  if (deferredWindows.length) {
    ctx.log.info(`[detach] ${deferredWindows.length} saved window(s) hold only views and stay closed in grid mode`);
  }
  return made;
}

function createDetachWindow({ sessionId = null, title = '', at = null, view = null, bounds: given = null } = {}) {
  const screenPoint = at;
  const main = ctx.getMainWindow();
  const source = main && !main.isDestroyed() ? main.getBounds() : { width: 1100, height: 700, x: 80, y: 80 };
  const workArea = given ? null : workAreaForPoint(screenPoint);
  // A restored window brings its own box (#371) — where it was is the whole point, and deriving a
  // fresh one from the main window would put every restored window in the same place instead.
  const bounds = given || (workArea ? detachWindowBounds(workArea, source) : {
    width: Math.max(640, Math.round(source.width * 0.6)),
    height: Math.max(400, Math.round(source.height * 0.8)),
    // Offset from the main window so a detach never lands exactly on top of it.
    x: source.x + 60,
    y: source.y + 60,
  });
  const win = new ctx.BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    title: title || (sessionId ? 'Switchboard — Session' : 'Switchboard'),
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
  detachedWins.add(win);
  // `win=detached` is the identity; `detached=<id>` and `view=<kind>` are what it opens ON, and a
  // window can have neither yet (a restore fills it afterwards). Query values are strings, so an
  // absent one is left out rather than sent as "null".
  const query = { win: 'detached' };
  if (sessionId) query.detached = sessionId;
  if (view) query.view = view;
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query });
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.show();
    win.focus();
  });
  // Where it is, so it comes back there (#371). The same debounce the main window's own bounds use:
  // a drag fires one of these per frame.
  if (typeof win.on === 'function') {
    win.on('move', persistWindows);
    win.on('resize', persistWindows);
  }

  // A RELOAD takes the review down without a `closed` event (#393). The instanced diff view cannot be
  // rebuilt from the restored state, so the CLI would wait out the full ten-minute timeout for a view
  // that is already gone. Answering on the navigation makes a reload cost a rejected diff instead of
  // ten minutes of silence — and reloading a second window is a likelier gesture than reloading main.
  if (win.webContents && typeof win.webContents.on === 'function') {
    win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isInPlace || isMainFrame === false) return; // an anchor or a sub-frame is not a teardown
      if (ctx.rejectPendingDiffsForWindow) ctx.rejectPendingDiffsForWindow(win);
    });
  }

  // Closing the window hands the session back rather than ending it: the PTY ran through the whole
  // detour and the user closed a VIEW, not a process. Skip on quit — everything is going away anyway.
  win.on('closed', () => {
    detachedWins.delete(win);
    // A review this window was showing dies with it, and the CLI that asked for it is still waiting on
    // an answer (#393). Rejecting is the honest one: the user closed the window instead of deciding,
    // and the alternative is ten minutes of silence. FIRST, before anything else here — the handover
    // below can take a while and the CLI is blocked meanwhile.
    if (ctx.rejectPendingDiffsForWindow) ctx.rejectPendingDiffsForWindow(win);
    // Whatever views it claimed are no longer anywhere (#364). Dropped before the session handover so
    // a sidebar click landing in the same tick routes locally rather than at a window that is gone.
    dropViewHost(win);
    // Every session this window still owns comes back — since #316 that can be more than the one it
    // was opened for. A session whose entry was already removed (the explicit reattach and the move
    // path both delete BEFORE destroying, precisely so this does not fire a second notification) is
    // not in the list, so the main window never reopens anything twice.
    const owned = sessionsInWindow(win);
    for (const id of owned) detachedWindows.delete(id);
    pendingRestore.delete(win);
    // A window closed by hand does not come back next launch (#371). `closingAll` is what tells this
    // apart from the app going away, where every window closes and all of them must come back.
    persistWindows();
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
  persistWindows(); // #371 — the window holds a different id now, and that is what comes back
}

/** Close every detached window — the main window is going, so its sessions have nowhere to be. */
function closeAll() {
  // Save what is standing BEFORE any of it goes (#371). This is the app going away, and everything
  // it takes down has to come back on the next launch — so the write happens first and the flag is
  // set before the first `closed` handler runs, or one of those would persist the half-emptied list
  // over the answer.
  persistWindowsNow();
  closingAll = true;
  // Clear FIRST, then destroy: the `closed` handler decides by "am I still the registered window?",
  // and this path must not ask the main window to take anything back. It runs from the main window's
  // own close, where `appQuitting` is still false on the plain Alt+F4 path — so the quit check alone
  // would let a reattach fire into a renderer that is being torn down.
  //
  // Over the SET, not the session map: a window holding only a view has no entry there and would
  // otherwise outlive the app (#370).
  const windows = [...detachedWins];
  ctx.log.info(`[detach] the app is going: ${windows.length} window(s) close with it`);
  detachedWindows.clear();
  detachedWins.clear();
  windowContent.clear(); // #364 — nothing holds anything once the windows are going
  pendingRestore.clear();
  for (const win of windows) {
    if (win && !win.isDestroyed()) win.destroy();
  }
  closingAll = false;
  // Nothing is standing any more, so "already restored" has stopped being true. On macOS the app
  // outlives its windows: reopening it comes back through `createWindow`, and the windows the user
  // just had are what they expect to find.
  restoreDone = false;
  // The held-back set is rebuilt from the settings the write above just made (#378). Keeping it would
  // append a second copy of every deferred window on that second pass.
  deferredWindows.length = 0;
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
    const win = createDetachWindow({ sessionId, title, at: aimedAt });
    detachedWindows.set(sessionId, win);
    persistWindows(); // #371 — this window has to come back on the next launch
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
  ipc.handle('move-session-to-window', (_event, sessionId, targetWindowId, placement) => {
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
      sendAdopt(target, sessionId, placement);
      if (target.isMinimized()) target.restore();
      target.focus();
    } else {
      sendAdopt(null, sessionId, placement);
    }
    // A detached window that just gave away its last session has nothing left to show, and no chrome
    // to pick a new one with — the sidebar lives in the main window. So it goes. Its entries are
    // already out of the map, so `closed` hands nothing back.
    //
    // Unless it still holds a VIEW (#370). "Nothing left to show" was the same statement as "no
    // sessions left" only for as long as a window could hold nothing else; a window whose Memory tab
    // is the reason it exists must survive a session passing through it.
    //
    // And unless it still holds an unanswered REVIEW (#393). `viewsInWindow` does not see one: it is
    // fed by the panes layout, and a window in grid mode reports no views at all — so without this the
    // window would be destroyed out from under a diff the user is in the middle of, in grid mode only.
    // Its `closed` handler would still answer the CLI, but a review vanishing mid-decision is the thing
    // to avoid, not the thing to recover from.
    const holdsReview = !!(ctx.hasPendingDiffsForWindow && ctx.hasPendingDiffsForWindow(sourceLive));
    if (sourceLive && !sessionsInWindow(sourceLive).length && !viewsInWindow(sourceLive).length
        && !holdsReview) {
      sourceLive.destroy();
    }
    persistWindows(); // #371 — both windows hold something different now
    ctx.log.info(`[detach] session moved to ${target ? 'window ' + target.id : 'the main window'}: ${sessionId}`);
    return { ok: true };
  });

  ipc.handle('list-session-windows', (event, sessionId) => {
    const sender = event && event.sender;
    const asking = sender ? ctx.BrowserWindow.fromWebContents(sender) : null;
    return listSessionWindows(sessionId, asking);
  });

  /**
   * A window reporting which of the app's own views it is showing (#364, #370, #371).
   *
   * Reported rather than inferred: only the renderer knows whether the tab is really up, and the
   * alternative — main guessing from what it last sent — is exactly the stale registry this is meant
   * not to become. The whole list every time, not a per-kind delta: a delta is a thing that can be
   * missed, and one missed message leaves a window claiming a view it closed for the rest of its life.
   *
   * The MAIN window reports too, which it did not have to when this only answered routing. It is how
   * "the view is HERE" is stated — see `viewHost` — and stating it is cheaper than inferring it from
   * the absence of a claim.
   */
  ipc.handle('window-views-changed', (event, views, layout) => {
    const sender = event && event.sender;
    const win = sender ? ctx.BrowserWindow.fromWebContents(sender) : null;
    if (!win || win.isDestroyed()) return { ok: false };
    const list = Array.isArray(views) ? views.filter((v) => v && v.kind) : [];
    windowContent.set(win, {
      views: list.map((v) => ({
        kind: String(v.kind),
        ref: v.ref == null ? null : v.ref,
        file: v.file == null ? null : v.file,
      })),
      // Kept as sent (#372). What a pane tree means belongs to the renderer that draws it; main only
      // has to give the same bytes back, and validating a shape it does not own would be a second
      // definition of it to keep in step.
      layout: (layout && layout.tree) ? { tree: layout.tree, activeLeafId: layout.activeLeafId || null } : null,
    });
    persistWindows(); // #371 — the views are half of what a restored window has to be given back
    return { ok: true };
  });

  /**
   * "Was I restored, and with what?" (#371)
   *
   * Pulled by the renderer on boot rather than pushed at it. A push has to choose a moment and every
   * moment is wrong: `did-finish-load` can land before the renderer's own boot has a session list to
   * mount from, and anything later races the reconcile. Asking is the one order that cannot be got
   * wrong — the window asks when it is ready to act on the answer.
   *
   * One-shot. A renderer RELOAD must not restore a second time: by then the sessions are running and
   * `adoptOwnedSessions` is what puts them back, mounting rather than launching.
   */
  ipc.handle('my-window-restore', (event) => {
    const sender = event && event.sender;
    const win = sender ? ctx.BrowserWindow.fromWebContents(sender) : null;
    if (!win || !pendingRestore.has(win)) return null;
    const payload = pendingRestore.get(win);
    pendingRestore.delete(win);
    return payload;
  });

  /**
   * "I clicked a file in the sidebar — who should show it?" (#364)
   *
   * Answers `{ routed: false }` when the view is here, and the caller then does exactly what it did
   * before. Only a view that has been pushed to another window is delivered, and the answer carries
   * that window's title so the click can say where it went — a click whose effect lands on another
   * monitor and says nothing reads as a click that did nothing.
   */
  ipc.handle('route-view-file', (event, kind, payload) => {
    const host = viewHost(kind);
    if (!host) return { routed: false };
    const sender = event && event.sender;
    const asking = sender ? ctx.BrowserWindow.fromWebContents(sender) : null;
    if (asking && asking === host) return { routed: false }; // it is already where the click happened
    host.webContents.send('open-view-file', kind, payload);
    host.focus();
    return { routed: true, windowTitle: host.getTitle() || 'the other window' };
  });

  /**
   * "Is this view already somewhere else, and if so, go there" (#381).
   *
   * The file-driven views ask `route-view-file` on every pick, so a Plan or a Memory opened from the
   * sidebar lands in the window that holds the viewer. Projects, Variables and Activity are opened by
   * a sidebar TAB with no file to route, so nothing asked — and the main window built a second copy
   * of a view it could see was elsewhere. Every window has its own `#projects-viewer` (see below), so
   * the duplicate is not an error state; it is just two surfaces onto one set of data, which is what
   * the user then has to keep straight.
   *
   * Same authority as the routing, deliberately: `viewHost` gives the main window precedence when it
   * shows the kind ITSELF, so this can never send a click away from the window it was made in.
   */
  ipc.handle('focus-view-window', (event, kind) => {
    if (!kind) return { focused: false };
    const host = viewHost(kind);
    if (!host) return { focused: false };
    const sender = event && event.sender;
    const asking = sender ? ctx.BrowserWindow.fromWebContents(sender) : null;
    if (asking && asking === host) return { focused: false }; // already the window that has it
    // Raising the WINDOW is only half of it: that window has tabs of its own, and the view may not be
    // the one in front. Then the click raises a window showing something else, which is the same "it
    // did nothing" one step on. `open-view` is the message that already knows how to answer this —
    // `openViewTab` finds the existing tab and makes it active rather than adding a second one.
    try { host.webContents.send('open-view', kind, null, null); } catch { /* a window on its way out */ }
    // And a window on another monitor may well be minimized, where focus raises nothing at all.
    if (host.isMinimized()) host.restore();
    host.focus();
    return { focused: true, windowTitle: host.getTitle() || 'the other window' };
  });

  /**
   * Open one of the app's own views in ANOTHER window (#364).
   *
   * Nothing is moved. Every window loads the same `index.html`, so each one already has its own
   * `#jsonl-viewer`, `#projects-viewer` and the rest — the "singleton" is per window, not per app.
   * What travels is the fact that the view is open: the target opens its own, the asker closes its
   * own. That is why this is a message and not a handover, and why it needs none of the
   * release/re-register/adopt ordering a session move does.
   *
   * `ref` is the instanced kinds' key (#311) — a file path for a preview, a diff id for a diff — and
   * is undefined for the singletons. `file` is what a SINGLETON needs instead: the sidebar-driven views
   * have no ref to carry their open file in, so it travels beside the kind or the view arrives empty.
   * Both are passed through untouched — what they mean belongs to the renderer that opens them.
   */
  ipc.handle('open-view-in-window', (_event, windowId, kind, ref, file) => {
    if (!kind) return { ok: false, error: 'no kind' };
    const win = String(windowId) === MAIN_WINDOW_ID ? ctx.getMainWindow() : detachedWindowById(windowId);
    if (!win || win.isDestroyed()) return { ok: false, error: 'no such window' };
    // A window made by the same gesture is still loading, and `send` to a renderer that does not
    // exist yet is DROPPED — silently, by Electron. The caller has already let go of its own tab by
    // then, so the view would simply be gone. Waiting for the load is the only place this can be
    // fixed: no amount of retrying in the target renderer helps when nothing ever reaches it.
    const deliver = () => {
      if (win.isDestroyed()) return;
      win.webContents.send('open-view', kind, ref, file);
      // The move answers a drag; a window that does not come forward looks like nothing happened.
      win.focus();
    };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', deliver);
    else deliver();
    return { ok: true };
  });

  /**
   * Open one of the app's own views in a window of its OWN (#370).
   *
   * The same message `open-view-in-window` sends, addressed to a window made for it. What is new is
   * that the window has no session: it is a frame around a view, and it stays open with nothing but
   * that view in it. Until now a window was built around a session — the URL named one, the map was
   * keyed by one, the title came from one, and closing handed one back — so "detach Memory on its
   * own" had nowhere to go.
   *
   * `at` is the drop point, in the same `{ point, box }` pair every other placement takes, so a view
   * dragged onto a second monitor opens there.
   */
  ipc.handle('open-view-in-new-window', (event, kind, ref, file, at) => {
    if (!kind) return { ok: false, error: 'no kind' };
    const sender = event && event.sender;
    const asking = sender ? ctx.BrowserWindow.fromWebContents(sender) : null;
    const aimedAt = (at && at.point) ? toScreenPoint(asking, at.point, at.box) : null;
    const win = createDetachWindow({ view: kind, at: aimedAt });
    // Always loading — the window was made one statement ago — but the check is kept rather than
    // assumed: a `send` that lands before the renderer exists is dropped silently by Electron, and
    // the caller has already let go of its own tab by the time it would notice.
    const deliver = () => { if (!win.isDestroyed()) win.webContents.send('open-view', kind, ref, file); };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', deliver);
    else deliver();
    ctx.log.info(`[detach] view moved to a window of its own: ${kind}`);
    return { ok: true, windowId: windowIdOf(win) };
  });

  /**
   * "Where would a drop at this point land, over there?" (#375)
   *
   * A drag never crosses a renderer process — the far window sees no `dragover` at all — so the near
   * window asks, and main relays the question to whichever window is under the pointer. That window
   * answers with a placement AND draws the hint for it, in one go: what it highlights and what a drop
   * would do must be the same decision, or it shows one thing and does another.
   *
   * Its bounds travel with the question, because converting a screen point into that renderer's own
   * coordinates needs the ratio between the box it measures for itself and the box the OS has for it —
   * the same conversion `toScreenPoint` performs in the other direction, done at the far end because
   * only that renderer knows its own zoom.
   *
   * Answers null for "nowhere of ours" — the point is over the desktop or another application.
   *
   * A window that IS under the pointer always answers something (#377): a pane and zone when it has
   * one to offer, otherwise `{ kind: 'window' }`, which it draws as a frame around itself. The only
   * remaining `placement: null` beside a window id is a renderer that did not reply inside
   * `PROBE_TIMEOUT_MS` — a window that cannot draw cannot announce, and the drop then lands in its
   * active pane the way it did before any of this existed.
   */
  ipc.handle('probe-drop-point', async (event, point, box) => {
    const sender = event && event.sender;
    const asking = sender ? ctx.BrowserWindow.fromWebContents(sender) : null;
    const at = toScreenPoint(asking, point, box);
    const main = ctx.getMainWindow();
    const candidates = [];
    if (main && !main.isDestroyed()) candidates.push({ id: MAIN_WINDOW_ID, win: main });
    for (const win of liveDetachedWindows()) candidates.push({ id: windowIdOf(win), win });
    for (const candidate of candidates) {
      if (asking && candidate.win === asking) continue; // its own drag, its own handlers
      const b = candidate.win.getBounds();
      if (at.x < b.x || at.x > b.x + b.width || at.y < b.y || at.y > b.y + b.height) continue;
      const placement = await askForPlacement(candidate.win, at, b);
      // Every OTHER window drops whatever it was showing — the pointer is here now.
      for (const other of candidates) if (other.win !== candidate.win) clearRemoteHint(other.win);
      return placement ? { windowId: candidate.id, placement } : { windowId: candidate.id, placement: null };
    }
    for (const candidate of candidates) clearRemoteHint(candidate.win);
    return null;
  });

  // The drag ended, wherever it ended: nothing should still be highlighting a drop that is not coming.
  ipc.handle('clear-remote-drop-hints', () => {
    const main = ctx.getMainWindow();
    if (main && !main.isDestroyed()) clearRemoteHint(main);
    for (const win of liveDetachedWindows()) clearRemoteHint(win);
    return { ok: true };
  });

  ipc.on('drop-probe-answer', (event, id, placement) => {
    const pending = probes.get(id);
    if (!pending) return;
    probes.delete(id);
    pending(placement || null);
  });

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
    // Every window, not every window with a session in it: a view-only window is a drop target like
    // any other (#370).
    for (const win of liveDetachedWindows()) candidates.push({ id: windowIdOf(win), win });
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
  restoreWindowBounds,
  restoreWindows,
  windowForSession,
  sendTimelineSignal,
  isDetached,
  detachedSessionIds,
  listSessionWindows,
  sessionsInWindow,
  viewsInWindow,
  detachedWindowsShowingView,
  notifyViewWindows,
  closeAll,
  detachedWindows,
};
