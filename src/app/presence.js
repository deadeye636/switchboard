// Is the user at the machine? (#386)
//
// "While you were away" used to answer this per session — when did this session last take focus — and
// called everything since then "away". So it fired when you switched sessions while sitting right
// there, and stayed silent when you left the desk with the window in front. The recap is for coming
// BACK to the machine; while you are working, the attention inbox is the surface that says what needs
// you. Two surfaces, two questions.
//
// So presence is ONE GLOBAL FACT, not a per-window one. Any window focused, or any window receiving
// input, means you are here. That is why it lives in main: every renderer has its own `windowFocused`,
// and none of them can see the others. Each window reports; this module is the only place that knows
// the answer for the app.
//
// It reports an ABSENCE, not a state. Nothing asks "are you there" — main tells the windows "you were
// gone, from T, for D" the moment activity comes back after a gap. The recap needs the gap, not the
// flag, and a flag would have to be polled to be turned into one.
//
// It also KEEPS that absence until it is thrown away (#422). The record behind the recap has survived a
// reload since #396; the fact that an absence just ended did not, because it arrived as one event in one
// renderer — so a reload dropped the recap while the data it was built from was still sitting there.
// Both halves have to live here, and together: keeping only the absence would bring the entry back after
// every reload INCLUDING the ones the user dismissed it in, which is worse than losing it.
//
// No DB, no Electron at module load: `BrowserWindow` and the windows arrive through ctx, so the pure
// half below runs in `node --test`.
'use strict';

// Below this, an absence is not worth reporting: it is the gap between putting a coffee down and
// picking the mouse back up, and a recap for it would be noise on top of what you just watched happen.
const MIN_ABSENCE_MS = 60_000;

const DEFAULT_IDLE_MINUTES = 10;

/**
 * Resolve the idle threshold from settings, in ms.
 *
 * The floor is deliberate rather than defensive: a threshold under a minute makes every pause for
 * thought an absence, and the recap then fires constantly — which is the failure the whole issue is
 * about, arrived at from the other side.
 */
function resolveIdleMs(stored) {
  const n = Number(stored);
  const minutes = Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_IDLE_MINUTES;
  return minutes * 60_000;
}

/**
 * Pure: did an absence just end, and what was it?
 *
 * `lastActivityAt` is when the app last saw a sign of life anywhere, `now` is this sign. Answers null
 * when the gap is not an absence — no previous activity (the app just started, and "away since boot"
 * is not something anyone was away FROM), a gap under the threshold, or under the floor.
 *
 * Returns `{ awaySince, awayMs }`: the absence STARTED at the last activity, which is the point the
 * recap should list events from. Everything before it happened while the user was present.
 */
function absenceEnded({ lastActivityAt, now, idleMs }) {
  if (!Number.isFinite(lastActivityAt) || !Number.isFinite(now)) return null;
  const gap = now - lastActivityAt;
  if (!(gap > 0)) return null;
  if (gap < Math.max(MIN_ABSENCE_MS, idleMs)) return null;
  return { awaySince: lastActivityAt, awayMs: gap };
}

let ctx = null;
// When the app last saw focus or input in ANY window. Null until the first report — see `absenceEnded`.
let lastActivityAt = null;
// The absence that has been reported and not yet thrown away — what a window that reloads asks for
// (#422). Exactly one, and always the NEWEST: a second absence replaces the first for the same reason
// the renderer's recap does, because an entry about an absence that ended two absences ago is wrong
// rather than merely old.
let pendingAbsence = null;

function init(context) {
  ctx = context;
  lastActivityAt = null;
  pendingAbsence = null;
}

/** Every window that should hear about an absence: the main one plus every window of its own. */
function liveWindows() {
  const out = [];
  const main = ctx && typeof ctx.getMainWindow === 'function' ? ctx.getMainWindow() : null;
  if (main && !main.isDestroyed()) out.push(main);
  const others = ctx && typeof ctx.getDetachedWindows === 'function' ? ctx.getDetachedWindows() : [];
  for (const win of others || []) {
    if (win && !win.isDestroyed() && win !== main) out.push(win);
  }
  return out;
}

function idleMsFromSettings() {
  if (!ctx || typeof ctx.getSetting !== 'function') return resolveIdleMs(undefined);
  try {
    const global = ctx.getSetting('global') || {};
    return resolveIdleMs(global.awayIdleMinutes);
  } catch { return resolveIdleMs(undefined); }
}

/**
 * A window saw focus or input. Answers the absence this ended, or null.
 *
 * Separate from the IPC handler so the state machine can be driven from a test without Electron.
 */
function recordActivity(now = Date.now()) {
  const absence = absenceEnded({ lastActivityAt, now, idleMs: idleMsFromSettings() });
  lastActivityAt = now;
  if (absence) pendingAbsence = absence;
  return absence;
}

/** The absence a window that just loaded still has to report, or null. */
function pendingRecapAbsence() {
  return pendingAbsence;
}

/**
 * The user threw the recap away — so the absence goes too, and stays gone across a reload.
 *
 * Keyed on WHICH absence was discarded rather than clearing whatever is held: a newer absence can end
 * between the click and this call, and dropping that one would lose a recap the user has not seen. An
 * answer of false means the discard was about an absence that is no longer the current one, which is
 * exactly the case where nothing should happen.
 */
function discardRecapAbsence(awaySince) {
  if (!pendingAbsence) return false;
  if (Number(awaySince) !== pendingAbsence.awaySince) return false;
  pendingAbsence = null;
  return true;
}

function registerIpc(ipc) {
  // Fire-and-forget on purpose: this is the hot path — every keystroke and every pointer move in
  // every window would otherwise be a round trip. The renderer throttles; nothing waits for an answer.
  ipc.on('presence-activity', () => {
    const absence = recordActivity();
    if (!absence) return;
    if (ctx && ctx.log && typeof ctx.log.info === 'function') {
      ctx.log.info(`[presence] back after ${Math.round(absence.awayMs / 1000)}s away`);
    }
    for (const win of liveWindows()) {
      try { win.webContents.send('presence-returned', absence); } catch { /* a window on its way out */ }
    }
  });

  // What a window asks for once it has loaded — the absence it may have missed the announcement of
  // (#422). Every window may ask; which one is allowed to ACT on it is the renderer's own one-inbox
  // rule (`raisesAttention`), the same answer that gates the live announcement.
  ipc.handle('presence:pending-absence', () => pendingAbsence);

  // …and the other half: the user discarded the recap, so the absence must not come back on the next
  // reload. Carries the absence it means — see `discardRecapAbsence`.
  ipc.handle('presence:discard-absence', (_event, awaySince) => discardRecapAbsence(awaySince));
}

module.exports = {
  init,
  registerIpc,
  recordActivity,
  pendingRecapAbsence,
  discardRecapAbsence,
  // Pure, for the suite.
  absenceEnded,
  resolveIdleMs,
  MIN_ABSENCE_MS,
  DEFAULT_IDLE_MINUTES,
};
