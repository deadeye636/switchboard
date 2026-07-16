// --- OSC 9;4 progress → CLI busy flag (pure logic, #120) ---
//
// A TUI dialog (e.g. `/mcp`) emits a progress sequence, which used to latch the
// busy flag with no way to release it: `4;0` was ignored, full-screen (alternate
// screen) sessions never emit the OSC 0 idle glyph, and no `Stop` hook fires when
// no agent turn ran. The session then showed "Working" forever.
//
// Free of Electron/DOM so the decision is unit-tested (`test/osc-busy.test.js`).

// What an OSC 9;4 progress level should do to the busy flag.
//   level        — the N in `9;4;N`
//   cliBusy      — is the session currently flagged busy?
//   busySource   — what set that flag ('osc94' | 'osc0' | null)
//   hooksEnabled — are the Claude Code attention hooks registered?
// Returns 'set' | 'clear' | 'ignore'.
function decideOsc94(level, state = {}) {
  const { cliBusy = false, busySource = null, hooksEnabled = false } = state;

  if (level === '0') {
    // `4;0` doubles as a generic clear, so it may only release a latch we set
    // ourselves — never one established by OSC 0 or by a hook.
    return (cliBusy && busySource === 'osc94') ? 'clear' : 'ignore';
  }

  if (level === '1' || level === '2' || level === '3') {
    // With hooks on, UserPromptSubmit/Stop bracket the turn exactly. A progress
    // sequence from a dialog carries no turn, so honouring it here is what
    // created the stale latch — ignore it and let the hooks decide.
    if (hooksEnabled) return 'ignore';
    return cliBusy ? 'ignore' : 'set';
  }

  return 'ignore';
}

module.exports = { decideOsc94 };
