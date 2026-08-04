// live-owners.js — which sessions a process OUTSIDE Switchboard is currently running (#172).
//
// Two surfaces need the same answer, and only a CLI can give it:
//
//   the spawn guard   refuses a resume that cannot succeed — it reads the backend's CACHE, never spawns
//   the sidebar       marks a row as running elsewhere, so two identically named rows can be told apart
//
// The second is what pays for this module. A badge has to be right without being clicked, so the list has
// to be fetched periodically — and that is a recurring child process the app did not have before. It is
// therefore kept as narrow as it can be:
//
//   - only backends that DECLARE the hook are asked (today: Claude),
//   - only while a window exists and at least one of them is visible — a minimised app answers nobody,
//   - never during quit,
//   - one interval for every backend, not one per backend.
//
// WHAT IS FILTERED OUT, and it is not cosmetic: a session THIS app is running appears in that list like
// any other. Marking it "running elsewhere" would be the app lying about its own window, and the guard
// would refuse to reattach to a tab the user is looking at. `activeSessions` is the answer to "ours", so
// everything in it is dropped before the list is published.
'use strict';

let ctx = null;
let timer = null;
// The last published list, so a window that opens (or reloads) does not have to wait for the next tick.
let snapshot = [];
// Has a poll ever completed? Only so the first answer can be logged even when it is empty — see poll().
let answered = false;

// Long enough that the child process is invisible in a profile, short enough that a session someone
// started in another terminal is marked before they have finished wondering why they cannot resume it.
//
// PAIRED WITH THE BACKEND'S CACHE TTL, which must be longer than this. The spawn guard reads that cache
// and never fetches, so a TTL below this interval leaves it cold for most of every interval — measured,
// with a real resume of a live background agent spawning anyway (`live-agents.js` carries the other half
// of this note).
const POLL_MS = 45000;
// The first fetch waits for the app to finish starting: the cold-start scan is the busiest moment there
// is, and nothing on screen needs this answer during it.
const FIRST_DELAY_MS = 8000;

function init(context) {
  ctx = context;
  snapshot = [];
  answered = false;
}

/** Every backend that can answer "is a live process holding this session?". */
function answeringBackends() {
  if (!ctx || !ctx.backends || typeof ctx.backends.list !== 'function') return [];
  let all = [];
  try { all = ctx.backends.list() || []; } catch { return []; }
  return all.filter((b) => b && typeof b.refreshLiveOwners === 'function'
    && (!ctx.backends.isLaunchable || ctx.backends.isLaunchable(b.id)));
}

/** Is anyone looking? A minimised or closed app has nobody to show a badge to. */
function anyoneWatching() {
  const wins = [];
  const main = ctx.getMainWindow ? ctx.getMainWindow() : null;
  if (main) wins.push(main);
  const others = ctx.getDetachedWindows ? ctx.getDetachedWindows() : [];
  for (const w of others || []) if (w && w !== main) wins.push(w);
  return wins.some((w) => {
    try { return !w.isDestroyed() && w.isVisible() && !w.isMinimized(); } catch { return false; }
  });
}

function broadcast(owners) {
  const main = ctx.getMainWindow ? ctx.getMainWindow() : null;
  const targets = [];
  if (main && !main.isDestroyed()) targets.push(main);
  for (const w of (ctx.getDetachedWindows ? ctx.getDetachedWindows() : []) || []) {
    if (w && w !== main && !w.isDestroyed()) targets.push(w);
  }
  for (const w of targets) {
    try { w.webContents.send('live-owners', owners); } catch { /* a window on its way out */ }
  }
}

/**
 * Ask every answering backend, publish the result.
 *
 * A backend that cannot answer contributes nothing rather than emptying the list — otherwise one CLI
 * hiccup would un-mark every row and the badge would flicker on a timer.
 */
async function poll() {
  const backends = answeringBackends();
  if (!backends.length) return snapshot;

  const collected = [];
  for (const backend of backends) {
    let entries = null;
    try { entries = await backend.refreshLiveOwners(); } catch { entries = null; }
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      if (!e || !e.sessionId) continue;
      // Ours is not "elsewhere". Both keys, because a session that re-identified mid-flight is in the map
      // under the id it ended up with, and the CLI names that one.
      if (ctx.activeSessions && ctx.activeSessions.has(e.sessionId)) continue;
      collected.push({ ...e, backendId: backend.id });
    }
  }

  // A transition, not a heartbeat: the count only moves when a session starts or ends somewhere else, and
  // that is exactly the fact the sidebar mark and the refused resume both come from. A tick that found the
  // same answer says nothing at info (it says it at debug, where a firehose belongs).
  const changed = collected.length !== snapshot.length
    || collected.some((e, i) => !snapshot[i] || snapshot[i].sessionId !== e.sessionId);
  snapshot = collected;
  if (ctx.log) {
    const line = `[live-owners] ${collected.length} session(s) are running outside Switchboard`;
    // The FIRST answer is always said out loud, even when it is zero. Otherwise "the poller found
    // nothing" and "the poller never ran" are the same silence — which is what an isolation check ran
    // into: an isolated instance correctly reporting none looked exactly like a poller that was gated
    // off, and the measurement could not tell them apart.
    if (changed || !answered) ctx.log.info(line); else ctx.log.debug(line);
  }
  answered = true;
  broadcast(snapshot);
  return snapshot;
}

function tick() {
  if (!ctx || (ctx.getAppQuitting && ctx.getAppQuitting())) return;
  if (!anyoneWatching()) return;
  poll().catch(() => { /* fail open: the badge is a hint, never a blocker */ });
}

/** Start the interval. Idempotent, so a re-init cannot leave two of them running. */
function start() {
  stop();
  const first = setTimeout(() => { tick(); }, FIRST_DELAY_MS);
  if (typeof first.unref === 'function') first.unref();
  timer = setInterval(tick, POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

function registerIpc(ipc) {
  // What a window asks for when it opens or reloads. The snapshot, never a fetch: a reload must not be
  // able to spawn a CLI, or a reload loop becomes a fork bomb with a 0.4 s fuse.
  ipc.handle('live-owners:get', () => snapshot);
}

module.exports = {
  init,
  registerIpc,
  start,
  stop,
  // For tests, and for anything that wants the answer without waiting for a tick.
  poll,
  current: () => snapshot,
  POLL_MS,
  // For tests: the gates live in `tick`, and a gate that stops working is invisible — the app simply
  // does less, correctly, forever. (Measured once from the other side: a window started hidden made the
  // poller do nothing at all, and the run looked like the feature was broken.)
  _tick: tick,
};
