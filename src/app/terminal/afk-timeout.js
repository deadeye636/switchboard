// Pure helpers for the per-session AskUserQuestion timeout (#51).
// UMD-wrapped so main.js can require it and node --test can exercise the logic.
//
// WHAT THIS CONTROLS TODAY, measured against the installed CLI 2.1.266 (#559). The ground under #51 has
// moved twice, and the second move inverted what our own "off" value does:
//
//   - The CLI no longer auto-continues an AskUserQuestion dialog by default. It carries its own setting
//     for it — `askUserQuestionTimeout` ("60s" | "5m" | "10m" | "never", default "never", the /config row
//     "Question auto-continue timeout"). `dialogExpiry` is NOT that setting: it bounds how long a dialog
//     forwarded to a REMOTE client stays parked, which is a different question.
//   - `CLAUDE_AFK_TIMEOUT_MS` is still read, and it still wins: the timeout resolves as
//     `env.CLAUDE_AFK_TIMEOUT_MS ?? <the setting> ?? <default>`.
//   - But the timer's ENABLE gate also asks whether the variable is defined at all, so a NUMERIC value
//     switches auto-continue ON even where the setting says "never". No number we could send means
//     "off"; only the absence of the variable does. (A non-numeric value reads as absent too — the CLI
//     parses it with an int reader that answers `undefined` — but sending garbage to mean something is
//     not a contract. And the gate has a third clause this reading could not resolve, so "any value
//     turns it on" is the behaviour observed, not a proof about every context.)
//
// So the sentinel this file used to emit for `0` (`2147483647`, "never" as 24.8 days) enabled the very
// timer it was meant to disable. `0` now sends nothing instead.
//
// WHAT THAT TAKES AWAY, because it is not nothing: the sentinel also OVERRODE the user's own
// `askUserQuestionTimeout`. Someone who set that to "60s" in their CLI and `0` here used to get no
// auto-continue at all; now their own CLI setting applies and the dialog continues after a minute. That
// is the app no longer overruling a setting the user made somewhere else, which is the right way round —
// but for that person it is a change, not a no-op.
//
// What is left for this field is the OPPOSITE of what #51 added it for: turning auto-continue ON for one
// session, which the CLI can only do globally. That is why it stays.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Convert a RESOLVED value (seconds) to the CLAUDE_AFK_TIMEOUT_MS env string, or null when the
  // variable must be left unset and the CLI's own setting stands.
  //   '' / undefined / null            → null  (nothing chosen at any scope — the CLI decides)
  //   0                                → null  (off — and off is spelled by NOT setting the variable)
  //   positive number of seconds       → String(sec * 1000)
  //   negative / non-numeric           → null  (invalid → the CLI decides)
  //
  // `0` and `''` end up in the same place HERE and are not the same setting: the cascade below runs
  // first, and `0` stops it while `''` falls through. So `0` at a scope means "no auto-continue for
  // this session, whatever a wider scope says", and `''` means "ask the wider scope".
  function afkTimeoutToEnvMs(raw) {
    if (raw === undefined || raw === null) return null;
    const s = String(raw).trim().toLowerCase();
    if (s === '') return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return null;
    // 0 is kept as an input (the header says why it can no longer be a value): an env value of any kind
    // ENABLES auto-continue, so the only way to ask for none of it is to send nothing.
    if (n === 0) return null;
    return String(Math.round(n * 1000));
  }

  // Cascade: first non-empty of session > project > global wins; '' / undefined /
  // null means "inherit" at that scope. Returns '' when nothing is set (default).
  // `0` is NOT empty and therefore wins its scope — that is what makes "off here" expressible while a
  // wider scope holds a positive value.
  function resolveAfkTimeoutSec(sessionVal, projectVal, globalVal) {
    for (const v of [sessionVal, projectVal, globalVal]) {
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
    return '';
  }

  // `normalizeAfkInput` used to sit here and nothing ever called it: the settings screen stores what the
  // control holds, through `valueOfInput` (`src/renderer/panels/backends-panel.js`). #559 asked whether
  // this module can go; for the two exports above the answer is no, and for that third one it was yes.

  return { afkTimeoutToEnvMs, resolveAfkTimeoutSec };
});
