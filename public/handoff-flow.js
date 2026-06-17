// Pure, Electron-free state machine for the guided one-click handoff flow.
// UI/IO (sendInput, dialogs, launching sessions) lives in dialogs.js / app.js;
// this module only models the ordered steps so they can be unit-tested.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Ordered, happy-path steps. Each non-terminal step has a single action the
  // orchestrator must perform before advancing to the next step.
  const HANDOFF_STEPS = ['confirm', 'requested', 'captured', 'forked', 'switched'];

  // The action the orchestrator should perform while in a given step.
  const STEP_ACTIONS = {
    confirm: 'request-packet', // ask the running agent for a handoff (spends tokens)
    requested: 'capture-packet', // read/review the agent's reply (no tokens)
    captured: 'launch-session', // start the fresh session (no tokens yet)
    forked: 'seed-session', // send the packet as the first message (spends tokens)
    switched: 'finish', // focus the new session; flow complete
  };

  function createHandoffState() {
    return { step: 'confirm', cancelled: false, done: false };
  }

  function isHandoffCancelled(state) {
    return !!(state && state.cancelled);
  }

  function isHandoffComplete(state) {
    return !!(state && state.done);
  }

  function isHandoffTerminal(state) {
    return isHandoffCancelled(state) || isHandoffComplete(state);
  }

  // Returns the next action descriptor for the current state without mutating it.
  // Cancel is reachable from any non-terminal step.
  function nextHandoffStep(state) {
    if (!state) return { action: 'none', terminal: true };
    if (isHandoffCancelled(state)) return { action: 'abort', terminal: true };
    if (isHandoffComplete(state)) return { action: 'none', terminal: true };
    return {
      action: STEP_ACTIONS[state.step] || 'none',
      step: state.step,
      terminal: false,
    };
  }

  // Advances to the next step in the happy path. From the last step ('switched')
  // it marks the flow done. No-op on a terminal state.
  function advanceHandoff(state) {
    if (isHandoffTerminal(state)) return { ...state };
    const index = HANDOFF_STEPS.indexOf(state.step);
    if (index < 0 || index >= HANDOFF_STEPS.length - 1) {
      return { ...state, done: true };
    }
    return { ...state, step: HANDOFF_STEPS[index + 1] };
  }

  // Cancel from any step. Leaves the recorded step intact for inspection/logging.
  function cancelHandoff(state) {
    const base = state || createHandoffState();
    return { ...base, cancelled: true, done: false };
  }

  // Extract the text of the most recent assistant turn from raw Claude JSONL
  // entries (as returned by window.api.readSessionJsonl(...).entries). Used to
  // prefill the review textarea so the user reviews/edits rather than retypes.
  // Pure: tolerates malformed/missing entries and returns '' when none found.
  function extractLatestAssistantText(entries) {
    if (!Array.isArray(entries)) return '';
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (!entry || entry.type !== 'assistant') continue;
      const message = entry.message || entry;
      const text = assistantContentToText(message && message.content);
      if (text) return text;
    }
    return '';
  }

  function assistantContentToText(content) {
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';
    return content
      .filter(block => block && (block.type === 'text' || typeof block.text === 'string'))
      .map(block => (typeof block.text === 'string' ? block.text : ''))
      .join('')
      .trim();
  }

  return {
    HANDOFF_STEPS,
    STEP_ACTIONS,
    createHandoffState,
    nextHandoffStep,
    advanceHandoff,
    cancelHandoff,
    isHandoffCancelled,
    isHandoffComplete,
    isHandoffTerminal,
    extractLatestAssistantText,
  };
});
