// Pure helper: decide which buttons the handoff dialog shows, given the session
// context. Replaces the old (now-deleted) handoff-flow state machine as the
// unit-testable seam — the dialog button matrix is exactly where recent bugs were.
// Electron-free.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // A handoff is a PACKET: a summary of the actual state of the work, written by an agent. There are two
  // ways to get one, and which one you want is a real choice — so it is asked, not guessed:
  //
  //   'this'  — THIS session's agent summarises what it is already holding. Best content (it knows), but
  //             it must be running; if it is not, it can be resumed for a single turn (that spends
  //             tokens, so it is confirmed).
  //   'new'   — a FRESH agent reads the old session's transcript and writes the packet itself. Nothing is
  //             resumed and the old session costs nothing; the new one does the reading.
  //
  // What used to happen instead: with no live agent, the app quietly saved a "starter" — a metadata
  // skeleton telling the next session to work the state out for itself. It looked like a handoff in the
  // library and contained no summary at all. That is now named for what it is, and never stored.
  //
  // Input: { canAskRunning, hasProject, canReadTranscript } (booleans).
  // Output: { producers: [...], starter: bool } — what the dialog may offer.
  function computeHandoffActions({ canAskRunning, hasProject, canReadTranscript } = {}) {
    const producers = [];

    // The old agent can always be asked — running, or resumed for one turn.
    producers.push({
      id: 'this',
      label: canAskRunning ? 'This session’s agent' : 'This session’s agent (resume it)',
      detail: canAskRunning
        ? 'It summarises the state it is already holding. Best content; spends tokens here.'
        : 'It is not running: it will be resumed for one turn to write the packet, then closed again. Spends tokens.',
      spendsTokens: true,
      needsResume: !canAskRunning,
    });

    // A fresh agent can only read a transcript that exists (and that it can reach).
    if (hasProject && canReadTranscript) {
      producers.push({
        id: 'new',
        label: 'A new session (reads this one)',
        detail: 'A fresh agent reads this session’s transcript and writes the handoff itself. Nothing is resumed.',
        spendsTokens: true,
        needsResume: false,
      });
    }

    return {
      producers,
      // The local skeleton stays reachable — for pasting somewhere. It is NOT a handoff and never goes
      // into the library.
      starter: true,
      hasProject: !!hasProject,
    };
  }

  return { computeHandoffActions };
});
