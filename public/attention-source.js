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
      case 'SubagentStop':
        return { kind: 'ready', reason: message || 'Agent finished responding' };
      case 'UserPromptSubmit':
        // Turn start = the agent begins working. Drives the "Working" status for
        // full-screen TUI sessions that don't emit the OSC-0 spinner title.
        return { kind: 'busy', reason: message || 'Agent working' };
      case 'PreToolUse':
        // A Task tool call = the main agent delegates to a subagent and waits.
        // Scoped by the hook matcher to Task, but guard on tool_name too (#112).
        return hook.tool_name === 'Task'
          ? { kind: 'delegating-start', reason: 'Delegating to subagent' }
          : null;
      case 'PostToolUse':
        return hook.tool_name === 'Task'
          ? { kind: 'delegating-end', reason: '' }
          : null;
      default:
        return null;
    }
  }

  // Unified entry point used by both ingest paths.
  //   classifyAttentionSignal({ source: 'osc9', payload: '<message string>' })
  //   classifyAttentionSignal({ source: 'hook', payload: <raw hook JSON object> })
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
      return { kind: sig.kind, reason: sig.reason, source: 'hook' };
    }

    return null;
  }

  // Precedence when two signals compete for the same session: a structured hook
  // signal beats the OSC-9 heuristic. Same-source → the latest wins.
  function reduceAttention(prev, next) {
    if (!prev) return next || null;
    if (!next) return prev;
    if (next.source === 'hook' && prev.source === 'osc9') return next;
    if (next.source === 'osc9' && prev.source === 'hook') return prev;
    return next;
  }

  return {
    OSC9_ATTENTION_REGEX,
    OSC9_WAITING_REGEX,
    describeNotification,
    classifyHookEvent,
    classifyAttentionSignal,
    reduceAttention,
  };
});
