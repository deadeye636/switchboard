// --- The attention/activity engine (#218, #228) ---
//
// The dispatcher that turns a raw activity/attention signal into rendered state: setActivity (busy/idle
// edges), applyAttention (the single funnel for the OSC-9 heuristic and Claude Code hooks),
// announceAttentionSummary (the screen-reader live region), and the synthesized attention chime
// (playAttentionSound / maybePlayAttentionSound). Came out of app.js.
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
// both, and views/grid-bulk-actions.js restores a previous ready set through markResponseReady rather
// than writing the Set itself — that guard is the whole point of the function (#252). All are call-time.
// Loaded BEFORE app.js, every one of those names is already declared when app.js parses, so none of
// them needs the `typeof` / `?.` guard native-notifications.js forced. The two `let`s it owns (lastAnnouncedAttentionSummary,
// _attentionAudioCtx) have no reader outside the engine, so they move with it; everything else it touches
// it reads or mutates at call time, when app.js is long parsed.
//
// What it reaches into, by file (all at call time):
//   app.js   attentionSessions, responseReadySessions (mutate), refreshSessionStatusViews,
//            getAllKnownSessionsForStatus, recordTimelineEvent, appLiveRegion, activePtyIds,
//            sessionBusyState, openSessions, lastActivityTime, activeSessionId, appGlobalSettings,
//            finishedAt, attentionReason
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

function maybePlayAttentionSound(prevAttention, nextAttention) {
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

  const wasActive = sessionBusyState.get(sessionId) || false;
  sessionBusyState.set(sessionId, active);

  if (active && !wasActive) {
    // New work started → any earlier "finished" stamp is stale.
    finishedAt.delete(sessionId);
  } else if (wasActive && !active) {
    // busy→idle edge: stamp the finish time. Unfocused sessions become
    // response-ready below; for the focused-then-left case this stamp is what
    // lets the configurable running-inbox (after-finish / until-read) surface it.
    finishedAt.set(sessionId, Date.now());
  }

  if (wasActive && !active) {
    // Activity ended → response-ready if user isn't looking at this session
    if (sessionId !== activeSessionId) {
      // Through the same door as every other caller. sessionBusyState was set to false above, so this
      // always takes — the point is that there is one place where "ready" can be set.
      markResponseReady(sessionId);
      recordTimelineEvent(sessionId, 'response-ready', 'Ready for review', 'Agent stopped producing output while this session was not focused.');
      const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
      if (item) {
        item.classList.remove('cli-busy');
        item.classList.add('response-ready');
      }
      refreshSessionStatusViews();
    }
  }

  // Sync cli-busy class (only if not response-ready)
  if (!responseReadySessions.has(sessionId)) {
    const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
    if (item) item.classList.toggle('cli-busy', active);
  }
  if (wasActive !== active) {
    recordTimelineEvent(sessionId, active ? 'busy' : 'idle', active ? 'Agent working' : 'Agent idle', active ? 'Claude activity started.' : 'Claude activity stopped.');
  }
  if (wasActive !== active) refreshSessionStatusViews();
}

// Single funnel for both attention sources (OSC-9 heuristic + Claude Code hooks).
// `signal` is the normalized output of classifyAttentionSignal: { kind, reason, source }.
function applyAttention(sessionId, signal) {
  if (!signal) return;
  const { kind, reason, source } = signal;

  if (kind === 'needs-attention') {
    // Focused session needs no inbox flag — the user is already looking at it.
    if (sessionId === activeSessionId) return;
    const winner = reduceAttention(attentionReason.get(sessionId) || null, { reason, source });
    attentionReason.set(sessionId, winner);
    const wasAttention = attentionSessions.has(sessionId);
    const prevAttention = new Set(attentionSessions);
    attentionSessions.add(sessionId);
    recordTimelineEvent(sessionId, 'needs-attention', 'Needs human attention', winner.reason);
    const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
    if (item) item.classList.add('needs-attention');
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
      const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
      if (item) item.classList.remove('response-ready');
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
