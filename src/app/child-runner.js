'use strict';
// child-runner.js — the machinery a running agent session uses to start ANOTHER session and follow it (spec 39, spec 41).
//
// Shared by the review runner (`review-runner.js`: a read-only second opinion) and the task runner (`task-runner.js`: a
// writing task in a worktree of its own). One runner per own-server registration (the caller's session). `start` opens a
// session on a target through the ordinary spawn path, follows it with `agentRpc.observe` (no view, no tab), sends one
// turn, takes the last assistant text when that turn ends, and stops the session; `result` answers what became of it.
// The caller polls (spec 37 O2: one blocking call is not safe on every CLI).
//
// What differs between the kinds is a POLICY: the sentences, the caps, the preamble, the launch options, what happens to
// an ask, what has to be prepared before the spawn (a worktree) and what a result carries. Everything else — the id
// table, the per-caller and app-wide caps, the timers, the end of a turn, the stop path, the caller ending — is here once.
//
// Electron-free and db-free, and it names no backend: the targets, their options and every effect arrive through `ctx`
// (`listTargets`, `openTerminal`, `agentRpc`, `activeSessions`, `stopSession`, `timeline`, `linkSession`, `storedModel`,
// `notifyProjectsChanged`, `getAppQuitting`, `now`, `setTimer`, `clearTimer`, `defer`, `log`), so `node --test` drives it
// with fakes.

const crypto = require('crypto');
const { cutText } = require('../session/turn-view');

const MAX_PROMPT = 16000;
const MAX_TEXT = 32768;           // code points (spec 39 O21)
const POLL_AFTER_SECONDS = 30;
const KEEP_RESULTS = 8;
const KEEP_MS = 60 * 60 * 1000;

const TERMINAL = new Set(['done', 'failed', 'timeout', 'stopped']);

/**
 * policy: {
 *   name         the log prefix ('review', 'task')
 *   maxMs        the time cap from the moment a start is accepted
 *   appCap       how many of this kind run over all callers
 *   running      a Set: the ids of this kind running anywhere in the app (one per kind, shared by its runners)
 *   sentences    the fixed sentences; `alreadyRunning(id)` and `timeoutAfter(seconds)` are functions
 *   preamble(rec)            text sent before the caller's prompt
 *   launchOptions(rec)       options merged after the target's profile and the model (the depth marker is added here)
 *   linkKind                 what the stored link calls the child ('review', 'task')
 *   prepare(rec, scope)      optional, async: work before the spawn -> { ok: true, cwd } | { ok: false, error }
 *   discard(rec)             optional, async: undo `prepare` for a start that is refused
 *   observer(rec, api)       optional: members that replace or add to the shared observer (`onAsk`, `onAskSettled`, ...)
 *   onFinish(rec)            optional: called once when a child ends, before its session is stopped
 *   project(rec, base)       optional: the result a poll answers, from the shared one
 *   keepText(state)          optional: which end states carry the text in `result` besides done and timeout
 * }
 * deps: { projectPath, callerTag, callerIsChild, maxMs, ctx }. `maxMs` is a test seam for the cap (spec 39, M7): it only
 * shortens it, to one second at the least; anything that is not a number below the policy's cap keeps the cap.
 * -> { targets(), start({ backend, prompt }), result(id), release() }
 */
function createChildRunner(policy, { projectPath, callerTag, callerIsChild = false, maxMs, ctx } = {}) {
  const S = policy.sentences;
  const capMs = Number.isFinite(maxMs) && maxMs > 0 && maxMs < policy.maxMs ? Math.max(1000, Math.floor(maxMs)) : policy.maxMs;
  // The timeout sentence names the cap that applied, so a shortened one for a measurement does not name the full cap.
  const timeoutSentence = capMs === policy.maxMs ? S.timeout : S.timeoutAfter(Math.ceil(capMs / 1000));
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
  const tag = `[${policy.name}]`;

  const records = new Map(); // child id -> record, oldest first
  let released = false;

  // The session's id NOW, found by its tag: a backend that adopts its runtime's id re-keys the session.
  function idOfTag(t) {
    if (!t || !ctx || !ctx.activeSessions) return null;
    for (const [id, s] of ctx.activeSessions) if (s && s._terminalTag === t) return id;
    return null;
  }
  const callerId = () => idOfTag(callerTag);
  const sessionIdOf = (rec) => (rec.session ? idOfTag(rec.session._terminalTag) || rec.sessionId : rec.sessionId);

  function targets() {
    try { return (ctx && typeof ctx.listTargets === 'function' ? ctx.listTargets() : []) || []; } catch (err) {
      log.warn(`${tag} the targets could not be listed: ${err.message}`);
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

  // The one way a child ends. Clears its timer, leaves the app-wide count, cuts the text and stops the session once.
  function finish(rec, state, reason) {
    if (TERMINAL.has(rec.state)) return;
    clearTimer(rec.timer);
    rec.timer = null;
    policy.running.delete(rec.id);
    rec.state = state;
    rec.reason = reason || null;
    rec.endedAt = now();
    // A child cut off mid-reply keeps what was streaming: newer than the last finished entry, when there is one.
    const raw = state === 'done' ? (rec.lastText || rec.planText) : (rec.partialText || rec.lastText);
    if (raw) {
      rec.truncated = Array.from(raw).length > MAX_TEXT;
      rec.text = cutText(raw, MAX_TEXT);
    }
    if (typeof policy.onFinish === 'function') {
      try { policy.onFinish(rec); } catch (err) { log.warn(`${tag} ending ${rec.id} failed: ${err.message}`); }
    }
    log.info(`${tag} ${rec.id} ${state}${rec.refusedActions ? ` (${rec.refusedActions} action(s) refused)` : ''}`);
    // The app's own shutdown ends every session; nothing is called into a closing app.
    if (rec.session && !quitting() && !rec.session.exited) {
      try {
        ctx.stopSession(rec.session, sessionIdOf(rec), { timeline: ctx.timeline, reason: S.stopReason });
      } catch (err) { log.warn(`${tag} the ${policy.name} session could not be stopped: ${err.message}`); }
    }
    prune();
  }

  // What a policy's own observer members may reach. Nothing here is a second way to end a child.
  const api = {
    finish, quitting, setTimer, clearTimer, defer, log,
    sessionIdOf,
    answerAsk: (rec, requestId, answer) => {
      const id = sessionIdOf(rec);
      if (!id || !ctx.agentRpc || typeof ctx.agentRpc.answerAsk !== 'function') return { ok: false };
      try { return ctx.agentRpc.answerAsk(id, requestId, answer) || { ok: false }; } catch { return { ok: false }; }
    },
  };

  function observerFor(rec) {
    const shared = {
      onBusy(busy, outcome) {
        if (busy) { rec.sawBusy = true; return; }
        // An idle before the turn began is the start settling, not the end of the child's turn.
        if (!rec.sawBusy || rec.state !== 'running') return;
        defer(() => {
          if (rec.state !== 'running') return;
          if (quitting()) { finish(rec, 'stopped', S.appQuitting); return; }
          // A turn somebody stopped is no answer: what it said before the Stop is kept, never returned as `done`.
          if (outcome === 'stopped') { finish(rec, 'stopped', S.sessionStopped); return; }
          // A turn that ended in a failed model call is no answer, whatever it said on the way.
          if (rec.turnFailed || outcome === 'failed') finish(rec, 'failed', S.noReply);
          else if (rec.lastText || rec.planText) finish(rec, 'done');
          else finish(rec, 'failed', S.noReply);
        });
      },
      onPartial(text) {
        rec.partialText = typeof text === 'string' && text.trim() ? text : null;
      },
      onEntry(entry, text) {
        // `_failed` is the neutral mark a backend's decoder puts on a failed model call (spec 39, "Detect the end of the turn").
        if (entry && entry._failed) { rec.turnFailed = true; return; }
        if (typeof text === 'string' && text.trim()) rec.lastText = text;
      },
      onExit() {
        if (rec.state !== 'running') return;
        defer(() => finish(rec, 'stopped', quitting() ? S.appQuitting : S.sessionStopped));
      },
    };
    const own = typeof policy.observer === 'function' ? policy.observer(rec, api) : {};
    return { ...shared, ...own };
  }

  function onTimeout(rec) {
    if (rec.state !== 'running') return;
    if (quitting()) { finish(rec, 'stopped', S.appQuitting); return; }
    const id = sessionIdOf(rec);
    if (id && ctx.agentRpc && typeof ctx.agentRpc.abortTurn === 'function') {
      Promise.resolve(ctx.agentRpc.abortTurn(id)).catch(() => {});
    }
    finish(rec, 'timeout', timeoutSentence);
  }

  /** -> { ok: true, accepted } | { ok: false, error } */
  async function start({ backend, prompt } = {}) {
    if (released) return { ok: false, error: S.callerEnded };
    if (callerIsChild) return { ok: false, error: S.callerIsChild };
    if (quitting()) return { ok: false, error: S.quitting };
    const text = typeof prompt === 'string' ? prompt : '';
    if (!text.trim()) return { ok: false, error: S.emptyPrompt };
    if (text.length > MAX_PROMPT) return { ok: false, error: S.longPrompt };
    const target = targets().find((t) => t && t.id === backend);
    if (!target) return { ok: false, error: S.noTarget };
    const mine = [...records.values()].find((r) => r.state === 'running');
    if (mine) return { ok: false, error: S.alreadyRunning(mine.id) };
    if (policy.running.size >= policy.appCap) return { ok: false, error: S.appCap };
    // The depth marker names the caller; a caller no longer running has nobody to answer to.
    const caller = callerId();
    if (!caller) return { ok: false, error: S.callerEnded };

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
      partialText: null,
      turnFailed: false,
      planText: null,
      text: null,
      truncated: false,
      refusedActions: 0,
      reason: null,
    };
    // Counted from here, before the first await, so two starts at once cannot both pass the caps.
    records.set(rec.id, rec);
    policy.running.add(rec.id);
    rec.timer = setTimer(() => onTimeout(rec), capMs);

    let prepared = false;
    const refuse = async (error) => {
      clearTimer(rec.timer);
      policy.running.delete(rec.id);
      records.delete(rec.id);
      if (prepared && typeof policy.discard === 'function') {
        try { await policy.discard(rec); } catch (err) { log.warn(`${tag} undoing the preparation failed: ${err.message}`); }
      }
      return { ok: false, error };
    };

    let cwd = projectPath;
    if (typeof policy.prepare === 'function') {
      let ready = null;
      try { ready = await policy.prepare(rec, { target, projectPath }); } catch (err) {
        log.warn(`${tag} the preparation threw: ${err.message}`);
        ready = { ok: false, error: S.notStarted };
      }
      prepared = true;
      if (rec.state !== 'running') return refuse(rec.reason || S.notStarted);
      if (quitting()) return refuse(S.quitting);
      if (!ready || ready.ok !== true) return refuse((ready && ready.error) || S.notStarted);
      cwd = ready.cwd || projectPath;
    }

    // The profile wins over the stored defaults: session options are merged last (spec 39, "Design", step 1). `buildLaunch`
    // reads these options as sent, so the model is named here: the one the user set for the target in Switchboard
    // (owner, 2026-10-29), because Claude in plan mode ignores its own settings' model and falls back to Opus
    // (measured; it raises Haiku to Sonnet either way). None set sends an empty `model`, and the CLI decides (O15).
    // `spawnedBy` keeps the child from getting a group of the app's own server (depth 1).
    let model = '';
    try { model = typeof ctx.storedModel === 'function' ? String(ctx.storedModel(target.id, projectPath) || '') : ''; } catch { model = ''; }
    const sessionOptions = {
      backendId: target.id,
      ...(target.options || {}),
      model,
      ...policy.launchOptions(rec),
      spawnedBy: caller,
    };
    let opened = null;
    try { opened = await ctx.openTerminal(rec.sessionId, cwd, true, sessionOptions); } catch (err) {
      log.warn(`${tag} the ${policy.name} session threw on start: ${err.message}`);
      opened = { ok: false };
    }
    if ((!opened || opened.ok !== true) && quitting()) return refuse(S.quitting);
    if (!opened || opened.ok !== true) {
      if (opened && opened.error === 'no window') return refuse(S.noWindow);
      if (opened && opened.untrusted) return refuse(S.untrusted);
      log.info(`${tag} the ${policy.name} session did not start: ${(opened && opened.error) || 'no answer'}`);
      return refuse(rec.state === 'running' ? S.notStarted : (rec.reason || S.notStarted));
    }
    rec.session = ctx.activeSessions ? ctx.activeSessions.get(rec.sessionId) || null : null;
    if (rec.state !== 'running') {
      // Ended while the session was starting (the cap, the caller gone): the session that did start is stopped too.
      if (rec.session && !quitting() && !rec.session.exited) {
        try { ctx.stopSession(rec.session, rec.sessionId, { timeline: ctx.timeline, reason: S.stopReason }); } catch { /* gone */ }
      }
      return refuse(rec.reason || S.notStarted);
    }
    if (!rec.session) { finish(rec, 'failed', S.notStarted); return refuse(S.notStarted); }
    if (quitting()) { finish(rec, 'stopped', S.appQuitting); return refuse(S.quitting); }
    let observed = false;
    try { observed = ctx.agentRpc.observe(sessionIdOf(rec), observerFor(rec)); } catch { observed = false; }
    if (!observed) {
      finish(rec, 'failed', S.notStarted);
      return refuse(S.notStarted);
    }
    // Both ends as they are NOW: the child may have adopted its runtime's id, and the caller may have been re-keyed (a
    // fork, a /clear) while the session started, which the re-key's own follow-up could not see yet.
    const parentNow = callerId() || caller;
    if (rec.session) rec.session._spawnedBy = parentNow;
    if (typeof ctx.linkSession === 'function') {
      try { ctx.linkSession(sessionIdOf(rec), parentNow, policy.linkKind); } catch (err) {
        log.warn(`${tag} the ${policy.name} session could not be linked to its caller: ${err.message}`);
      }
    }
    // The sidebar learns of a session main started only when it reloads its projects (spec 39, O2): ask it to, so
    // the child's row appears under its caller now, from the live snapshot, not when the scan reads its transcript.
    if (typeof ctx.notifyProjectsChanged === 'function') {
      try { ctx.notifyProjectsChanged(); } catch { /* the window may be gone */ }
    }
    let sent = null;
    try { sent = await ctx.agentRpc.sendTurn(sessionIdOf(rec), { text: policy.preamble(rec) + text, mode: 'prompt' }); } catch { sent = null; }
    if (rec.state === 'running' && quitting()) { finish(rec, 'stopped', S.appQuitting); return refuse(S.quitting); }
    if (rec.state === 'running' && (!sent || sent.ok !== true)) finish(rec, 'failed', S.notSent);
    if (rec.state === 'failed') return refuse(S.notSent);
    const accepted = {
      id: rec.id,
      backend: rec.backend,
      state: 'running',
      startedAt: new Date(rec.startedAt).toISOString(),
      maxMinutes: capMs / 60000,
      pollAfterSeconds: POLL_AFTER_SECONDS,
    };
    return { ok: true, accepted: typeof policy.accepted === 'function' ? policy.accepted(rec, accepted) : accepted };
  }

  /** -> { ok: true, result } | { ok: false, error } — an unknown, expired or foreign id answers one sentence. */
  function result(id) {
    prune();
    const rec = typeof id === 'string' ? records.get(id) : null;
    if (!rec) return { ok: false, error: S.unknownId };
    const elapsedMs = (rec.endedAt || now()) - rec.startedAt;
    const sessionId = sessionIdOf(rec);
    let base;
    switch (rec.state) {
      case 'running':
        base = { id: rec.id, state: 'running', elapsedMs, pollAfterSeconds: POLL_AFTER_SECONDS, note: S.running };
        break;
      case 'done':
        base = { id: rec.id, state: 'done', text: rec.text || '', truncated: rec.truncated, refusedActions: rec.refusedActions, sessionId, elapsedMs };
        break;
      case 'timeout':
        base = { id: rec.id, state: 'timeout', reason: rec.reason, text: rec.text || '', truncated: rec.truncated, sessionId };
        break;
      default:
        base = { id: rec.id, state: rec.state, reason: rec.reason, ...(rec.session ? { sessionId } : {}) };
        if (typeof policy.keepText === 'function' && policy.keepText(rec.state)) {
          base.text = rec.text || '';
          base.truncated = rec.truncated;
        }
    }
    return { ok: true, result: typeof policy.project === 'function' ? policy.project(rec, base) : base };
  }

  /** The caller's registration ended: a running child is stopped and every result is dropped (spec 39 O6, O7). */
  function release() {
    released = true;
    for (const rec of records.values()) {
      if (rec.state === 'running') finish(rec, 'stopped', quitting() ? S.appQuitting : S.callerEnded);
    }
    records.clear();
  }

  return { targets, start, result, release };
}

module.exports = { createChildRunner, MAX_TEXT, MAX_PROMPT, POLL_AFTER_SECONDS, TERMINAL };
