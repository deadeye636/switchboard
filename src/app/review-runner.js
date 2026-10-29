'use strict';
// review-runner.js — one agent asks another backend for a read-only second opinion (#507 slice 2b, spec 39).
//
// One runner per own-server registration (the caller's session). `start` opens a session on a review target through the
// ordinary spawn path, follows it with `agentRpc.observe` (no view, no tab), sends one turn, takes the last assistant
// text when that turn ends, and stops the session; `result` answers what became of it. The caller polls (spec 37 O2:
// one blocking call is not safe on every CLI). Every ask the review session raises is refused, and counted.
//
// Electron-free and db-free, and it names no backend: the targets, their read-only options and every effect arrive
// through `ctx` (`listTargets`, `openTerminal`, `agentRpc`, `activeSessions`, `stopSession`, `timeline`, `linkSession`,
// `getAppQuitting`, `now`, `setTimer`, `clearTimer`, `defer`, `log`), so `node --test` drives it with fakes.

const crypto = require('crypto');
const { cutText } = require('../session/turn-view');

const MAX_PROMPT = 16000;
const MAX_TEXT = 32768;           // code points (O21)
const MAX_MS = 10 * 60 * 1000;    // from the moment a start is accepted
const POLL_AFTER_SECONDS = 30;
const KEEP_RESULTS = 8;
const KEEP_MS = 60 * 60 * 1000;
const APP_CAP = 3;                // running reviews over all callers (O8)

// Sent before the caller's prompt (O14), so the reviewer knows what it is for and what it may not do.
const PREAMBLE = 'You are doing a read-only review for another agent. Do not edit files or run commands that change '
  + 'anything. Answer in your reply, not by planning or calling tools that write. Be concise: the answer is cut at about '
  + '32 KB.\n\n';

const SENTENCES = {
  unknownId: 'There is no review with that id for this session.',
  noTarget: 'That backend is not available for a review. Ask tools/list for the ones that are.',
  emptyPrompt: 'The prompt is empty.',
  longPrompt: `The prompt is longer than ${MAX_PROMPT} characters.`,
  callerIsReview: 'A review session cannot start another review.',
  quitting: 'The app is quitting.',
  appCap: `${APP_CAP} reviews are already running in Switchboard. Wait for one of them to finish.`,
  noWindow: 'No Switchboard window is open, so no review can start.',
  untrusted: 'The target backend does not trust this project yet. Trust it for that backend in Switchboard first.',
  notStarted: 'The review session could not start.',
  notSent: 'The review session started but did not take the prompt.',
  noReply: 'The review turn ended without a reply.',
  timeout: 'The review took longer than 10 minutes and was stopped.',
  sessionStopped: 'The review session was stopped.',
  callerEnded: 'The calling session ended.',
  appQuitting: 'The app is quitting.',
  running: `Still reviewing; do not call again for ${POLL_AFTER_SECONDS} seconds.`,
  stopReason: 'Stopped: the review ended.',
};

// Reviews running anywhere in the app, for the cap. Only ids; each runner keeps its own records.
const runningEverywhere = new Set();

const TERMINAL = new Set(['done', 'failed', 'timeout', 'stopped']);

/**
 * deps: { projectPath, callerTag, callerIsReview, ctx }
 * -> { targets(), start({ backend, prompt }), result(id), release() }
 */
function createReviewRunner({ projectPath, callerTag, callerIsReview = false, ctx } = {}) {
  const now = () => (ctx && typeof ctx.now === 'function' ? ctx.now() : Date.now());
  const quitting = () => !!(ctx && typeof ctx.getAppQuitting === 'function' && ctx.getAppQuitting());
  const setTimer = (fn, ms) => {
    const t = ctx && typeof ctx.setTimer === 'function' ? ctx.setTimer(fn, ms) : setTimeout(fn, ms);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };
  const clearTimer = (t) => { if (t) (ctx && typeof ctx.clearTimer === 'function' ? ctx.clearTimer(t) : clearTimeout(t)); };
  const defer = (fn) => (ctx && typeof ctx.defer === 'function' ? ctx.defer(fn) : setImmediate(fn));
  const log = (ctx && ctx.log) || { info() {}, warn() {}, debug() {} };

  const records = new Map(); // review id -> record, oldest first
  let released = false;

  // The session's id NOW, found by its tag: a backend that adopts its runtime's id re-keys the session.
  function idOfTag(tag) {
    if (!tag || !ctx || !ctx.activeSessions) return null;
    for (const [id, s] of ctx.activeSessions) if (s && s._terminalTag === tag) return id;
    return null;
  }
  const callerId = () => idOfTag(callerTag);
  const sessionIdOf = (rec) => (rec.session ? idOfTag(rec.session._terminalTag) || rec.sessionId : rec.sessionId);

  function targets() {
    try { return (ctx && typeof ctx.listTargets === 'function' ? ctx.listTargets() : []) || []; } catch (err) {
      log.warn(`[review] the targets could not be listed: ${err.message}`);
      return [];
    }
  }

  function prune() {
    const t = now();
    for (const [id, rec] of records) {
      if (TERMINAL.has(rec.state) && t - rec.endedAt > KEEP_MS) records.delete(id);
    }
    const ended = [...records.values()].filter((r) => TERMINAL.has(r.state));
    while (ended.length > KEEP_RESULTS) records.delete(ended.shift().id);
  }

  // The one way a review ends. Clears its timer, leaves the app-wide count, cuts the text and stops the session once.
  function finish(rec, state, reason) {
    if (TERMINAL.has(rec.state)) return;
    clearTimer(rec.timer);
    rec.timer = null;
    runningEverywhere.delete(rec.id);
    rec.state = state;
    rec.reason = reason || null;
    rec.endedAt = now();
    const raw = state === 'done' ? (rec.lastText || rec.planText) : rec.lastText;
    if (raw) {
      rec.truncated = Array.from(raw).length > MAX_TEXT;
      rec.text = cutText(raw, MAX_TEXT);
    }
    log.info(`[review] ${rec.id} ${state}${rec.refusedActions ? ` (${rec.refusedActions} action(s) refused)` : ''}`);
    // The app's own shutdown ends every session; nothing is called into a closing app.
    if (rec.session && !quitting() && !rec.session.exited) {
      try {
        ctx.stopSession(rec.session, sessionIdOf(rec), { timeline: ctx.timeline, reason: SENTENCES.stopReason });
      } catch (err) { log.warn(`[review] the review session could not be stopped: ${err.message}`); }
    }
    prune();
  }

  function observerFor(rec) {
    return {
      onBusy(busy, outcome) {
        if (busy) { rec.sawBusy = true; return; }
        // An idle before the turn began is the start settling, not the end of the review.
        if (!rec.sawBusy || rec.state !== 'running') return;
        defer(() => {
          if (rec.state !== 'running') return;
          if (quitting()) { finish(rec, 'stopped', SENTENCES.appQuitting); return; }
          // A turn somebody stopped is no answer: what it said before the Stop is kept, never returned as `done`.
          if (outcome === 'stopped') { finish(rec, 'stopped', SENTENCES.sessionStopped); return; }
          // A turn that ended in a failed model call is no answer, whatever it said on the way.
          if (rec.turnFailed || outcome === 'failed') finish(rec, 'failed', SENTENCES.noReply);
          else if (rec.lastText || rec.planText) finish(rec, 'done');
          else finish(rec, 'failed', SENTENCES.noReply);
        });
      },
      onEntry(entry, text) {
        // `_failed` is the neutral mark a backend's decoder puts on a failed model call (spec 39, "Detect the end of the turn").
        if (entry && entry._failed) { rec.turnFailed = true; return; }
        if (typeof text === 'string' && text.trim()) rec.lastText = text;
      },
      onAsk(request) {
        // Every ask is refused (spec 39, "Read-only"): no card, no inbox, nothing remembered.
        rec.refusedActions += 1;
        if (request && request.kind === 'plan' && typeof request.plan === 'string' && request.plan.trim()) {
          // The plan is the answer unless text FOLLOWS it (O11): narration written before the plan does not beat it.
          rec.planText = request.plan;
          rec.lastText = null;
        }
        return { cancelled: true };
      },
      onExit() {
        if (rec.state !== 'running') return;
        defer(() => finish(rec, 'stopped', quitting() ? SENTENCES.appQuitting : SENTENCES.sessionStopped));
      },
    };
  }

  function onTimeout(rec) {
    if (rec.state !== 'running') return;
    if (quitting()) { finish(rec, 'stopped', SENTENCES.appQuitting); return; }
    const id = sessionIdOf(rec);
    if (id && ctx.agentRpc && typeof ctx.agentRpc.abortTurn === 'function') {
      Promise.resolve(ctx.agentRpc.abortTurn(id)).catch(() => {});
    }
    finish(rec, 'timeout', SENTENCES.timeout);
  }

  /** -> { ok: true, accepted } | { ok: false, error } */
  async function start({ backend, prompt } = {}) {
    if (released) return { ok: false, error: SENTENCES.callerEnded };
    if (callerIsReview) return { ok: false, error: SENTENCES.callerIsReview };
    if (quitting()) return { ok: false, error: SENTENCES.quitting };
    const text = typeof prompt === 'string' ? prompt : '';
    if (!text.trim()) return { ok: false, error: SENTENCES.emptyPrompt };
    if (text.length > MAX_PROMPT) return { ok: false, error: SENTENCES.longPrompt };
    const target = targets().find((t) => t && t.id === backend);
    if (!target) return { ok: false, error: SENTENCES.noTarget };
    const mine = [...records.values()].find((r) => r.state === 'running');
    if (mine) return { ok: false, error: `A review is already running for this session: ${mine.id}. Poll it with reviewResult.` };
    if (runningEverywhere.size >= APP_CAP) return { ok: false, error: SENTENCES.appCap };
    // The depth marker names the caller; a caller no longer running has nobody to answer to.
    const caller = callerId();
    if (!caller) return { ok: false, error: SENTENCES.callerEnded };

    const rec = {
      id: crypto.randomUUID(),
      backend: target.id,
      sessionId: crypto.randomUUID(),
      session: null,
      state: 'running',
      startedAt: now(),
      endedAt: null,
      timer: null,
      sawBusy: false,
      lastText: null,
      turnFailed: false,
      planText: null,
      text: null,
      truncated: false,
      refusedActions: 0,
      reason: null,
    };
    // Counted from here, before the first await, so two starts at once cannot both pass the caps.
    records.set(rec.id, rec);
    runningEverywhere.add(rec.id);
    rec.timer = setTimer(() => onTimeout(rec), MAX_MS);

    // The profile wins over the stored defaults: session options are merged last (spec 39, "Design", step 1). `buildLaunch`
    // reads these options as sent, so the CLI's own model runs (O15); the empty `model` keeps the merged copy the spawn
    // path hands the extension in line with that. `reviewTools: false` and `spawnedBy` keep the review session from
    // getting a review tool of its own (depth 1).
    const sessionOptions = {
      backendId: target.id,
      ...(target.options || {}),
      model: '',
      reviewTools: false,
      spawnedBy: caller,
    };
    let opened = null;
    try { opened = await ctx.openTerminal(rec.sessionId, projectPath, true, sessionOptions); } catch (err) {
      log.warn(`[review] the review session threw on start: ${err.message}`);
      opened = { ok: false };
    }
    const refuse = (error) => {
      clearTimer(rec.timer);
      runningEverywhere.delete(rec.id);
      records.delete(rec.id);
      return { ok: false, error };
    };
    if ((!opened || opened.ok !== true) && quitting()) return refuse(SENTENCES.quitting);
    if (!opened || opened.ok !== true) {
      if (opened && opened.error === 'no window') return refuse(SENTENCES.noWindow);
      if (opened && opened.untrusted) return refuse(SENTENCES.untrusted);
      log.info(`[review] the review session did not start: ${(opened && opened.error) || 'no answer'}`);
      return refuse(rec.state === 'running' ? SENTENCES.notStarted : (rec.reason || SENTENCES.notStarted));
    }
    rec.session = ctx.activeSessions ? ctx.activeSessions.get(rec.sessionId) || null : null;
    if (rec.state !== 'running') {
      // Ended while the session was starting (the cap, the caller gone): the session that did start is stopped too.
      if (rec.session && !quitting() && !rec.session.exited) {
        try { ctx.stopSession(rec.session, rec.sessionId, { timeline: ctx.timeline, reason: SENTENCES.stopReason }); } catch { /* gone */ }
      }
      return refuse(rec.reason || SENTENCES.notStarted);
    }
    if (!rec.session) { finish(rec, 'failed', SENTENCES.notStarted); return refuse(SENTENCES.notStarted); }
    if (quitting()) { finish(rec, 'stopped', SENTENCES.appQuitting); return refuse(SENTENCES.quitting); }
    let observed = false;
    try { observed = ctx.agentRpc.observe(sessionIdOf(rec), observerFor(rec)); } catch { observed = false; }
    if (!observed) {
      finish(rec, 'failed', SENTENCES.notStarted);
      return refuse(SENTENCES.notStarted);
    }
    // Both ends as they are NOW: the review session may have adopted its runtime's id, and the caller may have been
    // re-keyed (a fork, a /clear) while the session started, which the re-key's own follow-up could not see yet.
    const parentNow = callerId() || caller;
    if (rec.session) rec.session._spawnedBy = parentNow;
    if (typeof ctx.linkSession === 'function') {
      try { ctx.linkSession(sessionIdOf(rec), parentNow, 'review'); } catch (err) {
        log.warn(`[review] the review session could not be linked to its caller: ${err.message}`);
      }
    }
    // The sidebar learns of a session main started only when it reloads its projects (spec 39, O2): ask it to, so
    // the review row appears under its caller now, from the live snapshot, not when the scan reads its transcript.
    if (typeof ctx.notifyProjectsChanged === 'function') {
      try { ctx.notifyProjectsChanged(); } catch { /* the window may be gone */ }
    }
    let sent = null;
    try { sent = await ctx.agentRpc.sendTurn(sessionIdOf(rec), { text: PREAMBLE + text, mode: 'prompt' }); } catch { sent = null; }
    if (rec.state === 'running' && quitting()) { finish(rec, 'stopped', SENTENCES.appQuitting); return refuse(SENTENCES.quitting); }
    if (rec.state === 'running' && (!sent || sent.ok !== true)) finish(rec, 'failed', SENTENCES.notSent);
    if (rec.state === 'failed') return refuse(SENTENCES.notSent);
    return {
      ok: true,
      accepted: {
        id: rec.id,
        backend: rec.backend,
        state: 'running',
        startedAt: new Date(rec.startedAt).toISOString(),
        maxMinutes: MAX_MS / 60000,
        pollAfterSeconds: POLL_AFTER_SECONDS,
      },
    };
  }

  /** -> { ok: true, result } | { ok: false, error } — an unknown, expired or foreign id answers one sentence. */
  function result(id) {
    prune();
    const rec = typeof id === 'string' ? records.get(id) : null;
    if (!rec) return { ok: false, error: SENTENCES.unknownId };
    const elapsedMs = (rec.endedAt || now()) - rec.startedAt;
    const sessionId = sessionIdOf(rec);
    switch (rec.state) {
      case 'running':
        return { ok: true, result: { id: rec.id, state: 'running', elapsedMs, pollAfterSeconds: POLL_AFTER_SECONDS, note: SENTENCES.running } };
      case 'done':
        return { ok: true, result: { id: rec.id, state: 'done', text: rec.text || '', truncated: rec.truncated, refusedActions: rec.refusedActions, sessionId, elapsedMs } };
      case 'timeout':
        return { ok: true, result: { id: rec.id, state: 'timeout', reason: rec.reason, text: rec.text || '', truncated: rec.truncated, sessionId } };
      default:
        return { ok: true, result: { id: rec.id, state: rec.state, reason: rec.reason, ...(rec.session ? { sessionId } : {}) } };
    }
  }

  /** The caller's registration ended: a running review is stopped and every result is dropped (O6, O7). */
  function release() {
    released = true;
    for (const rec of records.values()) {
      if (rec.state === 'running') finish(rec, 'stopped', quitting() ? SENTENCES.appQuitting : SENTENCES.callerEnded);
    }
    records.clear();
  }

  return { targets, start, result, release };
}

// For the tests: the app-wide count starts empty in each file.
function forgetRunning() { runningEverywhere.clear(); }

module.exports = { createReviewRunner, forgetRunning, PREAMBLE, SENTENCES, MAX_MS, MAX_TEXT, MAX_PROMPT, APP_CAP };
