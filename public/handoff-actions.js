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
  // Input: { canAskRunning, handoffLibrary, hasProject } (booleans).
  // Output: { mode, confirm, secondary, tertiary } — labels (null = button hidden).
  //   mode 'running' = live agent available → guided handoff offered.
  //   mode 'local'   = no live agent → local starter packet only.
  function computeHandoffActions({ canAskRunning, handoffLibrary, hasProject } = {}) {
    // The guided flow needs both a live agent and a project to launch into.
    if (canAskRunning && hasProject) {
      return {
        mode: 'running',
        confirm: 'Hand off (guided)',
        secondary: 'Copy Packet',
        tertiary: 'New session', // hasProject is true here
      };
    }
    return {
      mode: 'local',
      confirm: 'Copy Handoff',
      // Saving + seeding both need a project; "Save to library" also needs the system on.
      secondary: handoffLibrary && hasProject ? 'Save to library' : null,
      tertiary: hasProject ? 'New session' : null,
    };
  }

  return { computeHandoffActions };
});
