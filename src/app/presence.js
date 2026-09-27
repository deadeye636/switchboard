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
// "Here" means at the MACHINE, not in Switchboard (#673). Input in the app's own windows was the only
// source until then, so an hour in an IDE or a browser with the app on the other monitor read as an hour
// away, and the recap fired for time the user spent working. So main also asks the operating system how
// long the machine has been idle (`powerMonitor.getSystemIdleTime()`) every `SYSTEM_IDLE_POLL_MS`, and
// counts input ANYWHERE as a sign of life, dated when it happened rather than when the poll saw it. The
// renderer's reports stay as the fast path: a return that starts in a Switchboard window is announced on
// the keystroke, not on the next poll. Deliberately not handled: a lock or a suspend as the start of an
// absence — the last input is the start either way. Where the OS cannot answer (some Wayland sessions
// report 0), every poll reads as present, which is the safe direction.
//
// No DB, no Electron at module load: `BrowserWindow`, the windows and the idle-time reader arrive through
// ctx, so the pure half below runs in `node --test`.
'use strict';

// Below this, an absence is not worth reporting: it is the gap between putting a coffee down and
// picking the mouse back up, and a recap for it would be noise on top of what you just watched happen.
const MIN_ABSENCE_MS = 60_000;

const DEFAULT_IDLE_MINUTES = 10;

// How often main asks the OS for its idle time (#673). The answer only matters in minutes — the threshold
// floor is one — so a return noticed up to this late is still the same absence, dated from the input.
const SYSTEM_IDLE_POLL_MS = 20_000;

// A window report arrives within a moment of the input that caused it — the renderer sends on the event.
// When the OS says the machine has been idle for longer than this at the moment of the report, the report
// was not input: a focus the app caused itself (#673).
const WINDOW_REPORT_TOLERANCE_MS = 5_000;

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

/**
 * Pure: when did the last input anywhere on the machine happen, from the OS's idle time (#673)?
 *
 * `idleSeconds` is what `powerMonitor.getSystemIdleTime()` answered at `now`. Answers null when the
 * reading is not a non-negative number.
 */
function lastInputFromIdle({ idleSeconds, now }) {
  if (typeof idleSeconds !== 'number' || !Number.isFinite(idleSeconds) || idleSeconds < 0) return null;
  if (!Number.isFinite(now)) return null;
  return now - idleSeconds * 1000;
}

/**
 * Pure: can this gap be trusted as an absence, given what the OS last vouched for (#673)?
 *
 * The OS idle time answers only "how long since the LAST input". Input between two readings that is
 * followed by more input is never seen — so when activity comes back, the return may really have begun
 * anywhere after the previous reading. What is KNOWN is that nothing happened from the last sign of life
 * up to that reading (`lastReadingAt`), and while the reading `vouches`, that span alone must reach the
 * threshold. Without this, nine and a half minutes of reading, a line typed in an IDE just after a poll
 * and a switch to Switchboard before the next one report ten minutes away — the switch is input too, so
 * by then the OS answers 0 and the IDE line is gone. The same rule vetoes a wall clock that jumps forward
 * while the user works elsewhere: the span the last reading covered is seconds, whatever the clock says.
 * The price: an absence within one poll interval of the threshold may go unreported.
 *
 * A reading that does not vouch — missing, older than the last sign of life, stale, or taken before the
 * machine slept (see `readingVouches`) — says nothing, and the gap stands as measured, which is exactly
 * the behaviour before #673.
 */
function gapIsConfirmed({ lastActivityAt, lastReadingAt, idleMs, vouches }) {
  if (!vouches || !Number.isFinite(lastReadingAt) || !Number.isFinite(lastActivityAt)) return true;
  if (lastReadingAt < lastActivityAt) return true;
  return lastReadingAt - lastActivityAt >= Math.max(MIN_ABSENCE_MS, idleMs);
}

// Gaps are measured in WALL time, because a suspend is time away: the monotonic clocks stop while a Mac or
// a Linux machine sleeps, so an eight-hour night would measure as a minute on one. The monotonic clock is
// used for one question only — did the poll keep firing since the last reading (`readingVouches`). Both
// clocks are injectable through ctx (`now`, `monotonicNow`). Every entry point below takes `(now, mono)`:
// with neither, both clocks are read; with only `now` (the suite), that one value serves as both.
function wallNow() {
  return ctx && typeof ctx.now === 'function' ? ctx.now() : Date.now();
}
function monotonicNow() {
  return ctx && typeof ctx.monotonicNow === 'function' ? ctx.monotonicNow() : performance.now();
}
function clocks(now, mono) {
  if (now === undefined) return [wallNow(), monotonicNow()];
  return [now, mono === undefined ? now : mono];
}

let ctx = null;
// When the app last saw a sign of life — focus or input in ANY window, or input anywhere on the machine.
// Null until the first one — see `absenceEnded`.
let lastActivityAt = null;
// The absence that has been reported and not yet thrown away — what a window that reloads asks for
// (#422). Exactly one, and always the NEWEST: a second absence replaces the first for the same reason
// the renderer's recap does, because an entry about an absence that ended two absences ago is wrong
// rather than merely old.
let pendingAbsence = null;
// The OS idle poll (#673): its interval, when it started (wall), when the OS last answered (wall and
// monotonic), and whether the machine resumed from a suspend since then.
let pollTimer = null;
let pollStartedAt = null;
let lastReadingAt = null;
let lastReadingMono = null;
let resumedSinceReading = false;
// The 'resume' subscription (#673), held so it can be taken back: ctx.onSystemResume / offSystemResume.
let resumeSubscription = null;

function init(context) {
  stopSystemIdlePoll();
  ctx = context;
  lastActivityAt = null;
  pendingAbsence = null;
  lastReadingAt = null;
  lastReadingMono = null;
  resumedSinceReading = false;
}

/**
 * Does the last OS reading still speak for the time since it (#673)?
 *
 * Only while the poll kept firing: less than two intervals on the monotonic clock since the reading, and
 * no resume from a suspend in between. A reading older than that means the OS stopped answering, or the
 * machine slept — on Windows the monotonic clock runs on through a suspend, on a Mac or Linux it stops,
 * which is why the resume is asked for rather than inferred. Either way the wall-clock gap is real.
 */
function readingVouches(mono) {
  if (!Number.isFinite(lastReadingMono) || resumedSinceReading) return false;
  return mono - lastReadingMono <= 2 * SYSTEM_IDLE_POLL_MS;
}

/**
 * The machine woke from a suspend (`powerMonitor` 'resume'): the reading before it vouches for nothing.
 * It says only that the time asleep was real — it neither starts nor ends an absence. Subscribed while the
 * poll runs, through `ctx.onSystemResume` / `ctx.offSystemResume`, so this is the one place to remove it.
 */
function noteSystemResume() {
  resumedSinceReading = true;
}

function subscribeResume() {
  if (resumeSubscription || !ctx || typeof ctx.onSystemResume !== 'function') return;
  const listener = () => noteSystemResume();
  ctx.onSystemResume(listener);
  resumeSubscription = { ctx, listener };
}

function unsubscribeResume() {
  if (!resumeSubscription) return;
  const { ctx: owner, listener } = resumeSubscription;
  resumeSubscription = null;
  try { if (typeof owner.offSystemResume === 'function') owner.offSystemResume(listener); } catch { /* going anyway */ }
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
 * A sign of life at wall time `now`, judged at monotonic time `mono`. Answers the absence this ended, or
 * null. Separate from the IPC handler so the state machine can be driven from a test without Electron.
 */
function recordActivity(now, mono) {
  [now, mono] = clocks(now, mono);
  const idleMs = idleMsFromSettings();
  const gap = absenceEnded({ lastActivityAt, now, idleMs });
  const confirmed = gap
    && gapIsConfirmed({ lastActivityAt, lastReadingAt, idleMs, vouches: readingVouches(mono) });
  const absence = confirmed ? gap : null;
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

/** Tell every window an absence ended — whichever source noticed the return. */
function announceAbsence(absence, source) {
  if (!absence) return;
  if (ctx && ctx.log && typeof ctx.log.info === 'function') {
    ctx.log.info(`[presence] back after ${Math.round(absence.awayMs / 1000)}s away (${source})`);
  }
  for (const win of liveWindows()) {
    try { win.webContents.send('presence-returned', absence); } catch { /* a window on its way out */ }
  }
}

/** Ask the OS. The idle seconds, or null when there is no reader, it throws or it answers nonsense. */
function readSystemIdle() {
  const read = ctx && ctx.getSystemIdleSeconds;
  if (typeof read !== 'function') return null;
  let idleSeconds;
  try { idleSeconds = read(); } catch { return null; }
  if (typeof idleSeconds !== 'number' || !Number.isFinite(idleSeconds) || idleSeconds < 0) return null;
  return idleSeconds;
}

/**
 * One reading of the OS idle time (#673). Answers `{ idleSeconds, absence }`, or null for no reading.
 *
 * The input it finds is recorded at the moment it HAPPENED, and only when it is newer than the last sign
 * of life — a renderer report usually got there first, and moving the last sign backwards would let the
 * next report measure a gap that was never an absence. Two more things it does not record:
 *   - input from before the poll started while nothing has been recorded yet. An untouched relaunch (a
 *     crash restart, an update) would otherwise stamp the start as a sign of life, and the first return
 *     would be "away since the app started" — which `absenceEnded` refuses for a reason.
 *   - a reading that throws or answers nonsense. That is no reading at all, never a sign of life, never
 *     an absence, and it vouches for nothing (see `gapIsConfirmed`).
 */
function takeReading(now, mono) {
  const idleSeconds = readSystemIdle();
  if (idleSeconds === null) return null;
  const at = lastInputFromIdle({ idleSeconds, now });
  let absence = null;
  const beforeStart = lastActivityAt === null && Number.isFinite(pollStartedAt) && at < pollStartedAt;
  if (!beforeStart && (lastActivityAt === null || at > lastActivityAt)) {
    absence = recordActivity(at, mono);
    announceAbsence(absence, 'system idle time');
  }
  // Only now: the decision above is judged against what the PREVIOUS reading vouched for.
  lastReadingAt = now;
  lastReadingMono = mono;
  resumedSinceReading = false;
  return { idleSeconds, absence };
}

/** The timer's poll, and the suite's. Answers the absence a reading ended, or null. */
function pollSystemIdle(now, mono) {
  const reading = takeReading(...clocks(now, mono));
  return reading ? reading.absence : null;
}

/**
 * Start asking the OS. Called from the boot, after `app` is ready — `powerMonitor` cannot be read
 * before that. Unref'd, so the poll never holds the process open; stopped in the teardown.
 */
function startSystemIdlePoll({ now = wallNow(), intervalMs = SYSTEM_IDLE_POLL_MS } = {}) {
  if (pollTimer || !ctx || typeof ctx.getSystemIdleSeconds !== 'function') return false;
  pollStartedAt = now;
  pollTimer = setInterval(() => { pollSystemIdle(); }, intervalMs);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();
  subscribeResume();
  return true;
}

function stopSystemIdlePoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  pollStartedAt = null;
  unsubscribeResume();
}

function isPollingSystemIdle() {
  return pollTimer !== null;
}

/**
 * A window saw focus or input. The OS is asked FIRST, for two reasons:
 *   - input elsewhere since its last reading is newer than the last sign of life, and has to be recorded
 *     before this report measures a gap from it.
 *   - a report the OS contradicts is not input. A focus the app caused itself (a detached window
 *     closing hands the main one the focus) reaches here while nobody touched anything. Counted as `now`,
 *     it would end an absence with nobody there — the real return would then get no recap — or, below the
 *     threshold, date the last sign of life late, so a later absence would start late. So when the fresh
 *     reading says the machine has been idle longer than `WINDOW_REPORT_TOLERANCE_MS`, the report adds
 *     nothing: the reading's own input time, recorded above, is the last sign of life.
 */
function recordWindowActivity(now, mono) {
  [now, mono] = clocks(now, mono);
  const reading = takeReading(now, mono);
  if (reading && reading.idleSeconds * 1000 > WINDOW_REPORT_TOLERANCE_MS) {
    return reading.absence;
  }
  const fromWindow = recordActivity(now, mono);
  announceAbsence(fromWindow, 'window input');
  return (reading && reading.absence) || fromWindow;
}

function registerIpc(ipc) {
  // Fire-and-forget on purpose: this is the hot path — every keystroke and every pointer move in
  // every window would otherwise be a round trip. The renderer throttles; nothing waits for an answer.
  ipc.on('presence-activity', () => { recordWindowActivity(); });

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
  recordWindowActivity,
  pendingRecapAbsence,
  discardRecapAbsence,
  pollSystemIdle,
  startSystemIdlePoll,
  stopSystemIdlePoll,
  isPollingSystemIdle,
  noteSystemResume,
  // Pure, for the suite.
  absenceEnded,
  lastInputFromIdle,
  gapIsConfirmed,
  resolveIdleMs,
  MIN_ABSENCE_MS,
  DEFAULT_IDLE_MINUTES,
  SYSTEM_IDLE_POLL_MS,
};
