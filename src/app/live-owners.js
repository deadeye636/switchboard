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

const sessionShutdown = require('./session-shutdown');

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

/**
 * Which process, if any, may be stopped to free this owner's session (#607).
 *
 * Pure and backend-neutral: the backend's descriptor answers, the core only asks. Two callers need the
 * same answer and they stand in different modules — this poller stamps it onto every published entry so
 * the dialog knows whether to offer the button, and `terminal/spawn.js` stamps it onto the owner it
 * refuses with, because that refusal opens the same dialog by a different route. Two readings of one
 * question is how the two routes start disagreeing, which #606 had just finished fixing.
 *
 * `null` for a backend that does not declare the hook, for one that declines, and for anything thrown.
 *
 * IT ALSO ASKS WHETHER THE PROCESS IS STILL THERE. A pid out of the CLI's list is a claim about a moment
 * that can be a minute and a half old by the time anyone reads it (a 45 s poll over a 60 s cache), and a
 * button offering to stop a process that exited yesterday is a button that describes the world wrongly.
 * `process.kill(pid, 0)` is a signal-free existence test, so this costs one syscall per entry per poll
 * and nothing on the click path beyond the one entry it is asked about.
 *
 * It is not a guarantee and is not treated as one: the answer can go stale between the poll and the
 * press, which is why `stopOwner` asks again and why an already-dead pid there is a success rather than
 * an error. What this removes is the offer that was never true, not the race — that one cannot be closed
 * and does not need to be.
 *
 * `requireAlive: false` asks only the first half — CAN this backend name a process for this owner. That
 * is what `stopOwner` needs: there, "the backend names nobody" and "the process it names has exited" are
 * two different answers (a refusal and a success), and a helper that collapsed them into `null` would
 * make the second one report the first. The liveness for that path is `stopForeignPid`'s, which already
 * has to ask it anyway.
 */
function stopTargetFor(backend, owner, { isAlive = sessionShutdown.isPidAlive, requireAlive = true } = {}) {
  if (!backend || !owner || typeof backend.liveOwnerStopTarget !== 'function') return null;
  let pid = null;
  try { pid = backend.liveOwnerStopTarget(owner); } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return !requireAlive || isAlive(pid) ? pid : null;
}

/**
 * Every backend that can answer "is a live process holding this session?" — ONE PER CLI.
 *
 * The answer comes from asking a CLI about its own sessions, so a template and its base answer
 * identically: they are one binary over one store (#605). Asked separately, every foreign session was
 * collected once per identity — the snapshot listed it N+1 times, the close warning counted it N+1 times,
 * and each poll spawned N+1 child processes to learn the same thing, against this module's own rule of
 * one interval for every backend rather than one per backend. `oneAskerPerCli` is the refusal, and it
 * keeps a template that is the only launchable entry for its CLI.
 */
function answeringBackends() {
  if (!ctx || !ctx.backends || typeof ctx.backends.list !== 'function') return [];
  let all = [];
  try { all = ctx.backends.list() || []; } catch { return []; }
  const answering = all.filter((b) => b && typeof b.refreshLiveOwners === 'function'
    && (!ctx.backends.isLaunchable || ctx.backends.isLaunchable(b.id)));
  return typeof ctx.backends.oneAskerPerCli === 'function' ? ctx.backends.oneAskerPerCli(answering) : answering;
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
async function poll({ isAlive } = {}) {
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
      // `canStop` is a claim about the ENTRY, not a promise about the moment: the poll runs on a 45 s
      // interval, so by the time anyone clicks, the process may have ended on its own. It says the button
      // is worth offering; whether the pid is still there is settled at the click, in `stopOwner()`.
      collected.push({ ...e, backendId: backend.id, canStop: stopTargetFor(backend, e, isAlive ? { isAlive } : {}) !== null });
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

/**
 * End the process holding a session, so the user can resume it (#607).
 *
 * This is the one thing in the app that kills a process it did not start, and every guard on it is here
 * rather than at the caller:
 *
 *   - the OWNER comes from the published snapshot, never from the renderer. A window sends a session id;
 *     it does not get to name a pid, or the IPC surface becomes "kill anything you like".
 *   - the PID comes from the backend's descriptor (`stopTargetFor`), so which process may be ended is
 *     the CLI's own answer and no part of it is spelled in the core.
 *   - a pid that is already gone is a SUCCESS, not an error. It is the state the caller asked for, and
 *     the 45 s poll makes it an ordinary outcome rather than a rare one.
 *   - the list is REFRESHED afterwards. The backend's cache outlives this by up to a minute (its TTL is
 *     deliberately longer than the poll), and a resume immediately after the kill would otherwise be
 *     refused by the guard for a process that no longer exists.
 *
 * It never throws across the IPC boundary: every answer is `{ ok, ... }` with a sentence the caller can
 * show. A failure here leaves the user exactly where they were, with "Resume anyway" still available.
 *
 * `stopPid` is injected the way `awaitAllStopped` injects its `isAlive`/`killTree` — so `node --test` can
 * drive every branch of a function whose whole job is to kill something.
 */
async function stopOwner(sessionId, { stopPid = sessionShutdown.stopForeignPid, isAlive } = {}) {
  if (!sessionId) return { ok: false, error: 'No session was named.' };
  const owner = snapshot.find((e) => e && e.sessionId === sessionId) || null;
  // Nothing holds it — which is the state the caller asked for, so this is the `alreadyGone` answer and
  // not an error. It is an ordinary outcome rather than a rare one: the dialog can be several seconds
  // old by the time the button is pressed, and the process may have ended on its own in between.
  // Reporting it as a failure produced a message that contradicted its own title ("the session is still
  // held" over "nothing is holding this session"), and sent the user back to Resume anyway for a session
  // that was already free.
  if (!owner) return { ok: true, alreadyGone: true, pid: null };

  let backend = null;
  try { backend = ctx.backends.get(owner.backendId); } catch { backend = null; }
  // Whether the backend can NAME a process, not whether that process is still there — those are two
  // different answers here, and `stopForeignPid` below settles the second one.
  const pid = stopTargetFor(backend, owner, { ...(isAlive ? { isAlive } : {}), requireAlive: false });
  if (pid === null) {
    return { ok: false, error: `${(backend && backend.label) || 'This backend'} cannot name the process holding this session.` };
  }

  const result = await stopPid(pid);
  if (result.survived) {
    if (ctx.log) ctx.log.warn(`[live-owners] pid ${pid} survived the stop for session ${sessionId}`);
    return { ok: false, error: `The process (pid ${pid}) did not stop.` };
  }
  if (ctx.log) {
    ctx.log.info(result.alreadyGone
      ? `[live-owners] pid ${pid} had already exited — session ${sessionId} was free`
      : `[live-owners] stopped pid ${pid}, which was holding session ${sessionId}`);
  }

  // Ask the CLI again so the guard reads a list that no longer names this session. Best effort: a refresh
  // that fails leaves a stale cache, which costs the user one "Resume anyway" click and never a wrong
  // outcome. Waited on rather than fired off, because the resume follows immediately.
  try { if (typeof backend.refreshLiveOwners === 'function') await backend.refreshLiveOwners(); } catch { /* stale is survivable */ }
  await poll(isAlive ? { isAlive } : {}).catch(() => { /* the badge heals on the next tick */ });

  return { ok: true, alreadyGone: result.alreadyGone, pid };
}

function registerIpc(ipc) {
  // What a window asks for when it opens or reloads. The snapshot, never a fetch: a reload must not be
  // able to spawn a CLI, or a reload loop becomes a fork bomb with a 0.4 s fuse.
  ipc.handle('live-owners:get', () => snapshot);
  ipc.handle('live-owners:stop', (_event, sessionId) => stopOwner(sessionId));
}

module.exports = {
  init,
  registerIpc,
  start,
  stop,
  // For tests, and for anything that wants the answer without waiting for a tick.
  poll,
  stopOwner,
  current: () => snapshot,
  // The one answer to "may this owner's process be ended", shared with the spawn guard so the two routes
  // into the same dialog cannot disagree about it.
  stopTargetFor,
  POLL_MS,
  // For tests: the gates live in `tick`, and a gate that stops working is invisible — the app simply
  // does less, correctly, forever. (Measured once from the other side: a window started hidden made the
  // poller do nothing at all, and the run looked like the feature was broken.)
  _tick: tick,
};
