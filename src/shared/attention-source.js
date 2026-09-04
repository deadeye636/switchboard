// attention-source.js — single source of truth for "does this signal need attention?"
//
// Pure + Electron-free (UMD) so both the Node main process (hook ingest) and the
// browser renderer (OSC-9 + hook IPC) classify signals identically and it can be
// unit-tested without a window. See docs/specs/05-hook-attention-detection.md.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // The historical OSC-9 heuristic, moved verbatim out of app.js so there is one
  // place that decides attention. Matches the four Claude CLI notification types:
  //   "needs your attention" / "needs your approval for the plan" /
  //   "needs your permission to use {tool}" / "wants to enter plan mode".
  const OSC9_ATTENTION_REGEX = /attention|approval|permission|needs your|wants to enter/i;
  const OSC9_WAITING_REGEX = /waiting for your input/i;

  // Human-readable reason for a Notification matcher when the hook omits a message.
  function describeNotification(matcher) {
    switch (String(matcher || '').toLowerCase()) {
      case 'permission_prompt':
        return 'Claude needs permission';
      case 'elicitation_dialog':
      case 'elicitation_response':
        return 'Claude needs input';
      case 'idle_prompt':
        return 'Waiting for your input';
      default:
        return 'Claude needs your attention';
    }
  }

  // Map a raw Claude Code hook event payload (the JSON it POSTs / pipes to a hook)
  // to a normalized { kind, reason } or null when the event isn't attention-relevant.
  // kind ∈ { needs-attention, busy, idle, ready }.
  function classifyHookEvent(hook) {
    if (!hook || typeof hook !== 'object') return null;
    const event = hook.hook_event_name || hook.event || '';
    const message = hook.message != null ? String(hook.message) : '';
    // Notification matcher arrives as `matcher`; some payloads expose it as the type.
    const matcher = hook.matcher || hook.notification_type || '';

    switch (event) {
      case 'Notification': {
        // idle_prompt = "Claude is waiting for your input" → terminal/ready, not a blocker.
        if (/idle/i.test(matcher)) {
          return { kind: 'ready', reason: message || describeNotification(matcher) };
        }
        return { kind: 'needs-attention', reason: message || describeNotification(matcher) };
      }
      case 'PermissionRequest':
        return { kind: 'needs-attention', reason: message || 'Claude needs permission' };
      case 'Stop':
        return { kind: 'ready', reason: message || 'Agent finished responding' };
      case 'UserPromptSubmit':
        // Turn start = the agent begins working. Drives the "Working" status for
        // full-screen TUI sessions that don't emit the OSC-0 spinner title.
        return { kind: 'busy', reason: message || 'Agent working' };
      // Subagent lifecycle (#119). Both events carry the PARENT `session_id` plus the
      // subagent's `agent_id`, and SubagentStop fires at the subagent's real end.
      // SubagentStop must NOT map to `ready` — that would flip the parent to
      // "finished" mid-turn, while it is still generating.
      case 'SubagentStart':
        return { kind: 'subagent-live-start', reason: 'Subagent started', agentId: hook.agent_id || null, agentType: hook.agent_type || null };
      case 'SubagentStop':
        return { kind: 'subagent-live-stop', reason: 'Subagent finished', agentId: hook.agent_id || null };
      default:
        return null;
    }
  }

  // What a terminal-bound extension is waiting for, when it is waiting on the USER (#529).
  //
  // Pi 0.84.4 separates active agent work from time spent on a blocking `ctx.ui` prompt (`ui_prompt_start`
  // / `ui_prompt_end`), which is the difference between a session that is thinking and one that is
  // waiting — indistinguishable before, and reported as busy, so a session sat "Working" while it was
  // actually blocked on an unanswered question.
  //
  // The wording comes from a CLOSED vocabulary, never from a title the CLI supplies. A prompt title is
  // arbitrary text from whatever the agent is running, and this reason is rendered in the inbox; the kind
  // of prompt is enough to say what is wanted.
  const BIND_PROMPT_REASONS = {
    select: 'Waiting for you to choose',
    confirm: 'Waiting for you to confirm',
    input: 'Waiting for your input',
    editor: 'Waiting for you in an editor',
    custom: 'Waiting for your answer',
  };

  // A terminal binding's own lifecycle edge (#303). The route that receives these knows nothing about
  // WHICH backend sent them — it trusts the per-spawn URL and token — so the vocabulary is neutral and a
  // backend that has no notion of one of these simply never sends it.
  function classifyBindEvent(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const kind = payload.kind;
    if (kind === 'busy' || kind === 'idle') return { kind, reason: 'terminal binding' };
    if (kind === 'waiting') {
      const promptKind = String(payload.prompt_kind || payload.promptKind || '').toLowerCase();
      // `hasOwnProperty`, not a plain lookup: `constructor` and `__proto__` are keys on every object
      // literal, and either of them would put a function or a prototype where a sentence belongs. The
      // payload comes off a socket, and an unclonable `reason` throws inside `webContents.send` — the
      // attention would be lost to a catch rather than raised.
      const known = Object.prototype.hasOwnProperty.call(BIND_PROMPT_REASONS, promptKind);
      return {
        kind: 'needs-attention',
        reason: known ? BIND_PROMPT_REASONS[promptKind] : BIND_PROMPT_REASONS.custom,
        // The edge the row needs, kept apart from `kind`: this is attention AND it is the end of being
        // busy, and a caller that only read `kind` would leave the session spinning.
        busy: false,
      };
    }
    return null;
  }

  // Unified entry point used by both ingest paths.
  //   classifyAttentionSignal({ source: 'osc9', payload: '<message string>' })
  //   classifyAttentionSignal({ source: 'hook', payload: <raw hook JSON object> })
  //   classifyAttentionSignal({ source: 'bind', payload: <terminal-binding JSON object> })
  // Returns { kind, reason, source } or null.
  function classifyAttentionSignal(input) {
    if (!input) return null;
    const source = input.source;

    if (source === 'osc9') {
      const payload = input.payload == null ? '' : String(input.payload);
      if (OSC9_ATTENTION_REGEX.test(payload)) {
        return { kind: 'needs-attention', reason: payload, source: 'osc9' };
      }
      if (OSC9_WAITING_REGEX.test(payload)) {
        return { kind: 'ready', reason: 'Waiting for your input', source: 'osc9' };
      }
      return null;
    }

    if (source === 'hook') {
      const sig = classifyHookEvent(input.payload);
      if (!sig) return null;
      // Spread so event-specific fields (agentId, agentType) survive (#119).
      return { ...sig, source: 'hook' };
    }

    if (source === 'bind') {
      const sig = classifyBindEvent(input.payload);
      if (!sig) return null;
      // Spread so `busy` survives (#529) — see classifyBindEvent.
      return { ...sig, source: 'bind' };
    }

    return null;
  }

  // Precedence when two signals compete for the same session: a STRUCTURED signal beats the OSC-9
  // heuristic. Same-source → the latest wins.
  //
  // Structured means anything the CLI stated about itself — a hook, or a terminal-bound extension's own
  // lifecycle edge (#529). Written as "is it osc9" rather than as a list of the structured sources,
  // because a new one of those must not silently lose to a spinner frame the day it is added.
  function reduceAttention(prev, next) {
    if (!prev) return next || null;
    if (!next) return prev;
    if (next.source !== 'osc9' && prev.source === 'osc9') return next;
    if (next.source === 'osc9' && prev.source !== 'osc9') return prev;
    return next;
  }

  return {
    OSC9_ATTENTION_REGEX,
    OSC9_WAITING_REGEX,
    describeNotification,
    classifyHookEvent,
    classifyBindEvent,
    classifyAttentionSignal,
    reduceAttention,
  };
});
