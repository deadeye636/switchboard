// --- The attention/activity engine (#218, #228) ---
//
// The dispatcher that turns a raw activity/attention signal into rendered state: setActivity (busy/idle
// edges), applyAttention (the single funnel for the OSC-9 heuristic and Claude Code hooks),
// announceAttentionSummary (the screen-reader live region), and the synthesized attention chime
// (playAttentionSound / maybePlayAttentionSound). Came out of app.js.
//
// Recording and raising are separate here, and the split carries the two window rules:
//   recordActivityEdge      the status map + the timeline for a busy/idle edge. Raises nothing.
//   recordAttentionSignal   the record-only twin of applyAttention, for a window that RENDERS a session
//                           without owning the inbox (#395). session-ipc.js calls it from
//                           onTimelineSignal, a channel the main window never receives.
//   raisesAttention         the one answer to "may THIS window announce" — read by the chime here and by
//                           native-notifications.js for the badge, the tray and the notification (#390).
//
// It is FEATURE code, not the wiring app.js keeps. What stays in app.js is the STATE it works on and the
// wiring it drives — because half the renderer reads those, not because they belong together:
//   attentionSessions / responseReadySessions   Sets, 15 external readers each (session-status,
//                                                session-tabs, native-notifications). Mutated in place
//                                                here — a const Set write through the shared scope, never
//                                                a rebind.
//   refreshSessionStatusViews                    wiring, 7 external readers; this engine CALLS it, app.js
//                                                keeps it. getAllKnownSessionsForStatus likewise.
//
// A PLAIN CLASSIC SCRIPT that LOADS BEFORE app.js. That is the opposite of search-bar.js /
// native-notifications.js and it is deliberate: this file is pure function declarations with NO
// parse-time side effects (no listener, no IIFE, no top-level read), so loading it early is free — and it
// buys the thing those two had to guard for. app.js reaches in only for announceAttentionSummary (via
// refreshSessionStatusViews). The callers of applyAttention / setActivity are elsewhere: the IPC
// callbacks in shell/session-ipc.js (onTerminalNotification, onAttentionSignal, onCliBusyState) drive
// both, onTimelineSignal drives recordAttentionSignal, shell/detach-window.js calls setActivity when a
// window takes a session that is busy mid-turn (#395), and views/grid-bulk-actions.js restores a
// previous ready set through markResponseReady rather
// than writing the Set itself — that guard is the whole point of the function (#252). All are call-time.
// Loaded BEFORE app.js, every one of those names is already declared when app.js parses, so none of
// them needs the `typeof` / `?.` guard native-notifications.js forced. The two `let`s it owns (lastAnnouncedAttentionSummary,
// _attentionAudioCtx) have no reader outside the engine, so they move with it; everything else it touches
// it reads or mutates at call time, when app.js is long parsed.
//
// What it reaches into, by file (all at call time):
//   app.js   attentionSessions, responseReadySessions (mutate), refreshSessionStatusViews,
//            getAllKnownSessionsForStatus, recordTimelineEvent, appLiveRegion, sessionBusyState,
//            activeSessionId, appGlobalSettings, finishedAt, attentionReason,
//            window.sessionRuntimeState (the one snapshot builder, #260 — announceAttentionSummary
//            reads the status maps through it now, not by naming activePtyIds/openSessions/lastActivityTime)
//   session/session-status.js   getStatusCounts (UMD → window/global)
//   shared/attention-source.js  reduceAttention (UMD → window/global)
//   shell/alert-sound.js        shouldPlayAttentionSound (UMD → window/global)
//   sidebar.js (via window)     window._setSubagentLive, typeof-guarded

let lastAnnouncedAttentionSummary = '';

function announceAttentionSummary() {
  if (!appLiveRegion || typeof getStatusCounts !== 'function') return;
  // The one runtime snapshot builder (window.sessionRuntimeState, #260) — this was a fourth inline copy.
  const counts = getStatusCounts(getAllKnownSessionsForStatus(), window.sessionRuntimeState());
  const parts = [];
  if (counts.attention) parts.push(`${counts.attention} need${counts.attention === 1 ? 's' : ''} attention`);
  if (counts.ready) parts.push(`${counts.ready} ready`);
  if (counts.active) parts.push(`${counts.active} running`);
  const next = parts.length ? `Agent status: ${parts.join(', ')}.` : '';
  if (next === lastAnnouncedAttentionSummary) return;
  lastAnnouncedAttentionSummary = next;
  appLiveRegion.textContent = next;
}

// --- Attention alert sound (synthesized, no bundled binary) ---
let _attentionAudioCtx = null;

function playAttentionSound() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    _attentionAudioCtx = _attentionAudioCtx || new Ctx();
    if (_attentionAudioCtx.state === 'suspended') _attentionAudioCtx.resume();
    const ctx = _attentionAudioCtx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    // Two-tone rising chime.
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.setValueAtTime(1175, now + 0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.15, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.34);
  } catch {
    // Audio is best-effort; never let it break status handling.
  }
}

// Announcing is the MAIN window's job and only its own (#390). Every window that loads the shell runs
// this engine, so a window of its own reaches the badge, the tray and the chime exactly as readily —
// and `set-badge` / `set-tray-summary` ignore which window sent them, so the last writer wins. Its
// attention sets are always empty today, so all it does is silently reset what main just set; the
// moment such a window learns about a waiting session (#395) it would announce it a second time.
//
// A function, not a value: `window.isDetachedWindow` comes from detach-window.js, which loads AFTER
// this file, so the answer has to be read at call time.
const raisesAttention = () => !(typeof window.isDetachedWindow === 'function' && window.isDetachedWindow());

function maybePlayAttentionSound(prevAttention, nextAttention) {
  if (!raisesAttention()) return;
  if (typeof shouldPlayAttentionSound !== 'function') return;
  const settings = {
    sound: !!(appGlobalSettings.notifications && appGlobalSettings.notifications.sound),
  };
  if (shouldPlayAttentionSound({ prev: prevAttention, next: nextAttention, settings })) {
    playAttentionSound();
  }
}

// "Ready" and "Working" describe the same session at the same moment and cannot both be true. This is
// the only door into responseReadySessions from outside the engine — it refuses a session that is
// working, so a caller restoring a previous set cannot recreate a state the engine keeps impossible.
// Returns whether the session is now ready.
function markResponseReady(sessionId) {
  if (!sessionId || sessionBusyState.get(sessionId)) return false;
  responseReadySessions.add(sessionId);
  return true;
}

/**
 * The RECORD half of a busy/idle edge: this window's own status map and its own timeline, and nothing
 * that announces anything to anyone.
 *
 * It is its own function because a window that merely RENDERS a session runs exactly this and no more
 * (#395). Such a window needs the status to draw its tabs — a session visibly producing output must not
 * be drawn as idle — and it needs the events for its recap. What it must not gain is an inbox.
 *
 * Returns the edge, so the caller does not recompute it.
 */
function recordActivityEdge(sessionId, active) {
  const wasActive = sessionBusyState.get(sessionId) || false;
  sessionBusyState.set(sessionId, active);

  if (active && !wasActive) {
    // New work started → any earlier "finished" stamp is stale.
    finishedAt.delete(sessionId);
  } else if (wasActive && !active) {
    // busy→idle edge: stamp the finish time. Unfocused sessions become response-ready in the caller;
    // for the focused-then-left case this stamp is what lets the configurable running-inbox
    // (after-finish / until-read) surface it.
    finishedAt.set(sessionId, Date.now());

    // RECORDING that the turn ended is a fact about the session, and it does not depend on where the
    // user was looking (#391). The away recap reads exactly this event to answer "was anything waiting
    // for me", so tying the record to focus meant the commonest case of all — walk away from the
    // session you are working in, come back — produced a recap that said nothing was.
    recordTimelineEvent(sessionId, 'response-ready', 'Ready for review', 'Agent stopped producing output.');
  }

  if (wasActive !== active) {
    recordTimelineEvent(sessionId, active ? 'busy' : 'idle', active ? 'Agent working' : 'Agent idle', active ? 'Claude activity started.' : 'Claude activity stopped.');
  }
  return { changed: wasActive !== active, wasActive };
}

function setActivity(sessionId, active) {
  // A ready session ignores an OSC "busy" guess: the heuristic fires on spinner frames, and a session
  // waiting to be read should not flicker back to Working because of one. A hook `busy` signal is
  // exact, and applyAttention clears ready before it gets here.
  //
  // The GUARD IS ON THE BUSY EDGE ONLY. It used to cover both, which made the contradictory state
  // unrecoverable: with ready and busy somehow both set, the busy→idle edge that would have cleared
  // busy was itself swallowed, and nothing short of the PTY dying got the session out (#252).
  if (active && responseReadySessions.has(sessionId)) {
    return;
  }

  const { changed, wasActive } = recordActivityEdge(sessionId, active);

  // RAISING the end of a turn stays exactly as focus-dependent as it was: a session the user is looking
  // at needs no inbox flag, no ready class and no badge.
  if (wasActive && !active && sessionId !== activeSessionId) {
    // Through the same door as every other caller. sessionBusyState was set to false above, so this
    // always takes — the point is that there is one place where "ready" can be set.
    markResponseReady(sessionId);
    for (const item of sessionRowEls(sessionId)) {
      item.classList.remove('cli-busy');
      item.classList.add('response-ready');
    }
    refreshSessionStatusViews();
  }

  // Sync cli-busy class (only if not response-ready)
  if (!responseReadySessions.has(sessionId)) {
    for (const item of sessionRowEls(sessionId)) item.classList.toggle('cli-busy', active);
  }
  if (changed) refreshSessionStatusViews();
}

/**
 * The record-only twin of applyAttention, for a window that RENDERS a session without owning the inbox
 * (#395). Same normalized vocabulary, arriving on a channel the main window never receives.
 *
 * What it deliberately does NOT do: touch `attentionSessions` / `responseReadySessions`, keep a reason,
 * paint an attention or ready class, or reach the chime. So "Ready for review" — a statement that
 * something is waiting for the user — stays a main-window statement, while "Working" appears wherever
 * the session is drawn.
 */
function recordAttentionSignal(sessionId, signal) {
  if (!sessionId || !signal) return;
  const { kind, reason } = signal;

  if (kind === 'needs-attention') {
    recordTimelineEvent(sessionId, 'needs-attention', 'Needs human attention', reason || '');
  } else if (kind === 'ready' || kind === 'idle') {
    recordActivityEdge(sessionId, false);
  } else if (kind === 'busy') {
    recordActivityEdge(sessionId, true);
  } else {
    // Subagent lifecycle and anything else this window has no surface for.
    return;
  }

  // This window's own tabs read the status map, so they have to be repainted. It reaches the announce
  // funnel like every other refresh does, and finds nothing to announce: the sets above stayed empty,
  // and #390 gates the four OS-facing surfaces on top of that.
  refreshSessionStatusViews();
}

// Single funnel for both attention sources (OSC-9 heuristic + Claude Code hooks).
// `signal` is the normalized output of classifyAttentionSignal: { kind, reason, source }.
function applyAttention(sessionId, signal) {
  if (!signal) return;
  const { kind, reason, source } = signal;

  if (kind === 'needs-attention') {
    const winner = reduceAttention(attentionReason.get(sessionId) || null, { reason, source });
    // Recorded whether or not the user is looking (#391) — "the agent asked me something" is part of
    // what happened while they were away even when the session was the one in front. Reducing without
    // storing keeps the focused case free of side effects: no reason kept, no set written.
    recordTimelineEvent(sessionId, 'needs-attention', 'Needs human attention', winner.reason);

    // A focused session needs no inbox flag — the user is already looking at it.
    if (sessionId === activeSessionId) return;
    attentionReason.set(sessionId, winner);
    const wasAttention = attentionSessions.has(sessionId);
    const prevAttention = new Set(attentionSessions);
    attentionSessions.add(sessionId);
    for (const item of sessionRowEls(sessionId)) item.classList.add('needs-attention');
    if (!wasAttention) {
      refreshSessionStatusViews();
      maybePlayAttentionSound(prevAttention, attentionSessions);
    }
  } else if (kind === 'ready' || kind === 'idle') {
    // Agent finished / went idle → response-ready when unfocused (handled by setActivity).
    setActivity(sessionId, false);
  } else if (kind === 'busy') {
    // A new turn started → clear any stale "ready" so the session flips to Working
    // even if it was left ready-but-unfocused (setActivity ignores busy while
    // response-ready is set).
    if (responseReadySessions.has(sessionId)) {
      responseReadySessions.delete(sessionId);
      for (const item of sessionRowEls(sessionId)) item.classList.remove('response-ready');
    }
    setActivity(sessionId, true);
  } else if (kind === 'subagent-live-start' || kind === 'subagent-live-stop') {
    // Exact subagent edges from the SubagentStart/SubagentStop hooks (#119). The
    // JSONL scan writes to the same set, so a subagent seen twice counts once.
    if (signal.agentId && typeof window._setSubagentLive === 'function') {
      window._setSubagentLive(sessionId, signal.agentId, kind === 'subagent-live-start', 'hook');
    }
  }
}
