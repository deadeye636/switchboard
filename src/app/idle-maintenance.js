'use strict';
// Idle maintenance (spec 45, #827): the schedule that keeps a pipe-driven session's prompt cache warm, or compacts it, while
// it sits idle. Each action is a real model turn, so the default is off and every idle period is bounded.
//
// It names no backend and no format. A session arrives as the handle `src/app/agent-rpc.js` gives it (`maintain`, `open`,
// `usage`, `busy`), what the backend can do is its `idleMaintenance()` answer, and the settings come through `ctx`. Keyed on
// the handle's tag. Electron-free and database-free, like everything `ctx` hands in.
//
// The plan is read again before every action, so a setting changed meanwhile applies before anything is spent.

const REFRESH_LIMIT_CEILING = 10;      // whatever a settings file says, no idle period sends more refreshes than this
const CEILING_MINUTES_CEILING = 1440;  // ...and none runs later than this after the last turn
const BLOCKED_RETRY_MS = 15000;        // a tick the gate refused looks again this soon, within its bound
const BOUND_SLACK_MS = 20000;          // a timer may run this late; later than that (a machine asleep) the cache is presumed cold
const WARM_RATIO = 0.9;                // Pi's measured hits read at least 0.998 of the previous prompt, and its misses 0

let ctx = null;
let stopped = false;
const sessions = new Map();  // tag -> the session's schedule, see `sessionFor`

function init(context) {
  ctx = context;
  stopped = false;
}

const now = () => (ctx.now ? ctx.now() : Date.now());
const cancel = (timer) => { if (timer) (ctx.clearTimer || clearTimeout)(timer); };
function later(fn, ms) {
  if (ctx.setTimer) return ctx.setTimer(fn, ms);
  const timer = setTimeout(fn, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

const promptOf = (u) => (u ? (u.input || 0) + (u.read || 0) + (u.write || 0) : 0);

/**
 * What a refresh found (spec 45, "Hit check"): `warm`, `cold` or `unknown`. A backend whose miss was never measured says so
 * through `callsCold: false`, and its low reads stay `unknown` rather than stopping the maintenance.
 */
function hitVerdict(before, after, callsCold) {
  // The same figures as before: the turn ended with no new model call, so it found nothing out.
  if (!after || after === before) return 'unknown';
  if (callsCold && !after.read) return 'cold';
  const prompt = promptOf(before);
  if (!prompt) return 'unknown';
  return (after.read || 0) / prompt >= WARM_RATIO ? 'warm' : 'unknown';
}

function bounded(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// The schedule as of now: the effective settings, each field overridden by the running session's own value (`overrides`, which
// writes nothing back), against what the backend answers.
function planFor(session) {
  const answer = ctx.capabilityOf ? ctx.capabilityOf(session.handle) : null;
  const eff = { ...(ctx.effectiveSettings ? ctx.effectiveSettings(session.handle.projectPath) : {}), ...session.overrides };
  const mode = eff.idleMaintenanceMode || 'off';
  if (!answer) return { mode: 'off', declined: true, warm: false, compact: false };
  const wantsWarm = mode === 'warm' || mode === 'warm-compact';
  const wantsCompact = mode === 'compact' || mode === 'warm-compact';
  const minutes = bounded(eff.idleMaintenanceRefreshMinutes, 0, 0, CEILING_MINUTES_CEILING);
  const refused = wantsWarm && minutes * 60000 > answer.maxRefreshMs
    ? `A refresh every ${minutes} minutes would arrive after the cache has gone cold.`
    : null;
  return {
    mode,
    warm: wantsWarm && answer.warm && !refused,
    compact: wantsCompact && answer.compact && !refused,
    refused,
    callsCold: answer.callsCold === true,
    maxRefreshMs: answer.maxRefreshMs,
    intervalMs: minutes ? minutes * 60000 : answer.maxRefreshMs,
    limit: bounded(eff.idleMaintenanceRefreshLimit, 3, 1, REFRESH_LIMIT_CEILING),
    idleMs: bounded(eff.idleMaintenanceIdleMinutes, 10, 1, CEILING_MINUTES_CEILING) * 60000,
    ceilingMs: bounded(eff.idleMaintenanceCeilingMinutes, 180, 1, CEILING_MINUTES_CEILING) * 60000,
    bestEffortCompact: eff.idleMaintenanceBestEffortCompact === true,
  };
}

function say(session) {
  if (ctx.onStateChanged) ctx.onStateChanged(stateOf(session));
}

function record(session, label, detail) {
  const id = session.handle.sessionId();
  if (id && ctx.recordLifecycle) ctx.recordLifecycle(id, 'maintenance', label, detail);
}

function clear(session) {
  cancel(session.timer);
  session.timer = null;
  session.nextAction = null;
  session.nextAt = null;
}

function arm(session, action, at) {
  clear(session);
  session.nextAction = action;
  session.nextAt = at;
  session.timer = later(() => {
    tick(session, action).catch((err) => { if (ctx.log) ctx.log.warn(`[idle-maintenance] an action failed: ${err.message}`); });
  }, Math.max(0, at - now()));
  say(session);
}

function endPeriod(session, why) {
  clear(session);
  session.running = null;
  session.ended = why;
  if (ctx.log) ctx.log.info(`[idle-maintenance] session=${session.handle.sessionId()} period ended: ${why}`);
  say(session);
}

// What comes next in a period, from where it stands. Nothing is sent from here: `tick` decides again when the time comes.
function armNext(session) {
  const { plan } = session;
  // A cold cache is never kept warm, and compacting it takes the user's say-so.
  if (session.verdict === 'cold') {
    if (plan.compact && plan.bestEffortCompact) arm(session, 'compact', now());
    else endPeriod(session, 'cold');
    return;
  }
  if (plan.warm && session.refreshes < plan.limit) arm(session, 'warm', Math.max(now(), session.lastTurnAt + plan.intervalMs));
  else if (plan.compact) arm(session, 'compact', plan.warm ? now() : Math.max(now(), session.clockAt + plan.idleMs));
  else if (plan.warm) endPeriod(session, 'limit');
  else { clear(session); say(session); }
}

// A real turn of the user's ended: a new idle period, with its own count and its own clock.
function startPeriod(session) {
  session.clockAt = now();
  session.lastTurnAt = session.clockAt;
  session.refreshes = 0;
  session.verdict = null;
  session.ended = null;
  session.running = null;
  session.gaveUpAtLine = null;
  session.plan = planFor(session);
  armNext(session);
}

// Has a kept-warm cache gone cold by now? Only a period that sent a refresh has a warm cache to lose.
const pastBoundAt = (session, at) => at - session.lastTurnAt > session.plan.maxRefreshMs + BOUND_SLACK_MS;

function retryOrEnd(session, action) {
  const { plan } = session;
  const retryAt = now() + BLOCKED_RETRY_MS;
  // A refresh that cannot go out before the cache expires would only rebuild it, which this feature must not do. A compaction
  // after refreshes is the same unless the user allowed a best-effort one.
  const pastBound = (action === 'warm' && retryAt - session.lastTurnAt > plan.maxRefreshMs)
    || (action === 'compact' && session.refreshes > 0 && !plan.bestEffortCompact && pastBoundAt(session, retryAt));
  if (pastBound || retryAt - session.clockAt > plan.ceilingMs) { endPeriod(session, 'blocked'); return; }
  arm(session, action, retryAt);
}

async function tick(session, action) {
  session.timer = null;
  if (stopped || session.gone) return;
  session.plan = planFor(session);
  const { plan } = session;
  session.nextAction = null;
  session.nextAt = null;
  if (session.verdict === 'cold' || !plan[action]) {
    if (session.verdict !== 'cold' || !(action === 'compact' && plan.compact && plan.bestEffortCompact)) { armNext(session); return; }
  }
  if (now() - session.clockAt > plan.ceilingMs) { endPeriod(session, 'ceiling'); return; }
  // The machine slept, or the override came long after the last turn: the cache has gone, and a refresh would rebuild it.
  if (action === 'warm' && pastBoundAt(session, now())) { endPeriod(session, 'late'); return; }
  const lateCompact = action === 'compact' && session.refreshes > 0 && pastBoundAt(session, now());
  if (lateCompact && !plan.bestEffortCompact) { endPeriod(session, 'late'); return; }
  if (lateCompact) session.verdict = 'unknown';
  if (!session.handle.open()) { retryOrEnd(session, action); return; }
  if (action === 'warm') session.usageBefore = session.handle.usage();
  session.running = action;
  const period = session.clockAt;
  const res = await session.handle.maintain({ action });
  if (stopped || session.gone) return;
  if (res && res.ok && ctx.recordMaintenance) {
    // A record that cannot be written must not take the outcome with it.
    try {
      ctx.recordMaintenance({ sessionId: session.handle.sessionId(), kind: action, key: res.key || null, text: res.text || null, at: now() });
    } catch (err) {
      if (ctx.log) ctx.log.warn(`[idle-maintenance] a turn was not recorded: ${err.message}`);
    }
  }
  if (session.clockAt !== period || session.running !== action) return; // something has moved the period on meanwhile
  // A line still in the pipe, or an action its idle edge ends, goes on at that edge or at `maintenance-ended`.
  if (res && res.inPipe && res.endsBy !== 'answer') return;
  if (!res || !res.ok) {
    if (action === 'compact') record(session, 'Compaction skipped', String((res && res.reason) || ''));
    endPeriod(session, 'refused');
    return;
  }
  if (action === 'compact' && res.endsBy === 'answer') afterCompact(session);
}

function afterCompact(session) {
  // Best effort unless a hit was observed, which a compaction with no refresh before it never has.
  const bestEffort = session.verdict !== 'warm';
  record(session, bestEffort ? 'Compacted while idle (best effort)' : 'Compacted while idle', '');
  endPeriod(session, 'compacted');
}

// A warm turn ended: judge it, and decide what comes next from the plan as it now stands.
function afterWarm(session) {
  session.running = null;
  session.plan = planFor(session);
  const { plan } = session;
  session.refreshes += 1;
  session.lastTurnAt = now();
  session.verdict = hitVerdict(session.usageBefore, session.handle.usage(), plan.callsCold);
  record(session, 'Refresh', session.verdict);
  if (session.verdict === 'cold') {
    // Keeping a cold cache warm would be rebuilding it. Compacting would read the whole context at full price, so it
    // takes the user's say-so.
    if (plan.compact && plan.bestEffortCompact) arm(session, 'compact', now());
    else endPeriod(session, 'cold');
    return;
  }
  if (!plan.warm && !plan.compact) { endPeriod(session, 'off'); return; }
  armNext(session);
}

function sessionFor(handle) {
  let session = sessions.get(handle.tag);
  if (!session) {
    session = { handle, overrides: {}, timer: null, nextAction: null, nextAt: null, refreshes: 0, plan: null, verdict: null, ended: null, running: null, clockAt: 0, lastTurnAt: 0, usageBefore: null, atBusy: null, gone: false };
    sessions.set(handle.tag, session);
  }
  return session;
}

// What `src/app/agent-rpc.js` reports about a session it drives. A quiet edge is a maintenance turn's own.
function track({ edge, handle, quiet }) {
  if (!ctx || stopped) return;
  const session = sessionFor(handle);
  switch (edge) {
    case 'start':
      return;
    case 'exit':
      clear(session);
      session.gone = true;
      sessions.delete(handle.tag);
      return;
    case 'rekey':
      // Another conversation now: nothing planned for the last one applies to it.
      clear(session);
      session.running = null;
      session.clockAt = 0;
      session.ended = null;
      session.verdict = null;
      session.refreshes = 0;
      // A `/clear` moves in the middle of its own turn, whose end must not count as a turn of the new conversation.
      session.atBusy = handle.busy() ? { usage: handle.usage(), ended: null, refreshes: 0, clockAt: 0, lastTurnAt: 0 } : null;
      say(session);
      return;
    case 'maintenance-ended':
      // It ended with no turn to report it: refused, or a turn that was promised and never began.
      // A compaction's outcome comes with `maintain`'s answer, which `tick` is still waiting for.
      if (session.running === 'warm') {
        // A warm turn that was only slow can still begin. Its edges are then no longer quiet, and no line of anyone's explains
        // them: remember where the count stood.
        session.gaveUpAtLine = handle.linesSent();
        endPeriod(session, 'refused');
      }
      return;
    case 'busy':
      if (quiet) return;
      if (session.gaveUpAtLine !== null && session.gaveUpAtLine !== undefined && session.gaveUpAtLine === handle.linesSent()) {
        session.lateTurn = true;
        return;
      }
      clear(session);
      session.running = null;
      session.atBusy = { usage: handle.usage(), ended: session.ended, refreshes: session.refreshes, clockAt: session.clockAt, lastTurnAt: session.lastTurnAt };
      session.clockAt = -1;
      say(session);
      return;
    case 'idle':
      break;
    default:
      return;
  }
  if (quiet) {
    if (session.running === 'warm') afterWarm(session);
    else if (session.running === 'compact') afterCompact(session);
    return;
  }
  if (session.lateTurn) { session.lateTurn = false; return; } // a warm turn given up on, which began after all: it starts nothing
  if (handle.busy()) return; // a held prompt has already gone out; its turn's end is the one that counts
  // A line that reached no model (a local command such as a cost report) is not a turn: the clock stays where it was.
  const before = session.atBusy;
  session.atBusy = null;
  if (before && before.usage === handle.usage()) {
    session.ended = before.ended;
    session.refreshes = before.refreshes;
    session.clockAt = before.clockAt;
    session.lastTurnAt = before.lastTurnAt;
    if (session.clockAt > 0 && !session.ended) { session.plan = planFor(session); armNext(session); } else say(session);
    return;
  }
  startPeriod(session);
}

function stateOf(session) {
  const plan = session.plan || planFor(session);
  return {
    sessionId: session.handle.sessionId(),
    mode: plan.mode,
    declined: Boolean(plan.declined),
    refused: plan.refused || null,
    nextAction: session.nextAction,
    nextAt: session.nextAt,
    running: session.running,
    refreshes: session.refreshes,
    limit: plan.limit || 0,
    verdict: session.verdict,
    ended: session.ended,
    overrides: { ...session.overrides },
  };
}

function find(sessionId) {
  for (const s of sessions.values()) if (s.handle.sessionId() === sessionId) return s;
  return null;
}

/**
 * The running session's own values; a null removes one. Nothing here is written to the settings (spec 45, O2). It re-plans
 * only a period still waiting: one that has ended stays ended until the user's next turn, so a change here can neither
 * compact a second time nor rebuild a cold cache.
 */
function setOverride(sessionId, patch) {
  const session = find(sessionId);
  if (!session) return null;
  for (const [key, value] of Object.entries(patch || {})) {
    if (!key.startsWith('idleMaintenance')) continue;
    if (value === null || value === undefined) delete session.overrides[key];
    else session.overrides[key] = value;
  }
  session.plan = planFor(session);
  if (session.clockAt > 0 && !session.running && !session.ended) armNext(session);
  return stateOf(session);
}

function getState(sessionId) {
  const session = find(sessionId);
  return session ? stateOf(session) : null;
}

/** Before the database closes (main-process.md, #76): set synchronously, so a tick already on its way does nothing. */
function stop() {
  stopped = true;
  for (const session of sessions.values()) clear(session);
  sessions.clear();
}

function registerIpc(ipc) {
  ipc.handle('idle-maintenance-state', (_event, sessionId) => getState(sessionId));
  ipc.handle('idle-maintenance-set', (_event, sessionId, patch) => setOverride(sessionId, patch));
}

module.exports = { init, registerIpc, track, stop, getState, setOverride, hitVerdict, REFRESH_LIMIT_CEILING };
