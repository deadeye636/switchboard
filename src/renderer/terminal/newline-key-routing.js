(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // Shift+Enter (and Ctrl+Enter on Windows/Linux, matching the PowerShell convention) means "newline,
  // not submit" — but WHICH bytes say that is the CLI's answer, not ours. Claude reads the kitty
  // keyboard protocol's CSI 13;2u; Codex ignores it and takes ESC CR instead. The backend descriptor
  // declares its own sequence, and this decides nothing else.
  //
  // null = not a newline chord, so the rest of the terminal key handler still gets a say.
  // false = Switchboard answered the chord; xterm must not also act on it.
  //
  // A backend that declares NO sequence has its chord swallowed and nothing sent. That is the opposite
  // default from the page keys, on purpose: there, letting the key through was the safe half, because a
  // swallowed PageUp only fails to scroll. Here, letting it through means xterm sends CR and the CLI
  // SUBMITS a half-written prompt, which nobody gets back. An inert chord is the recoverable failure.
  function handleTerminalNewlineKeyEvent(event, sequence, sendInput, isMac) {
    if (!event || event.key !== 'Enter' || event.altKey || event.metaKey) return null;
    const shiftEnter = event.shiftKey && !event.ctrlKey;
    const ctrlEnter = !isMac && event.ctrlKey && !event.shiftKey;
    if (!shiftEnter && !ctrlEnter) return null;

    if (event.type === 'keydown' && sequence) sendInput(sequence);
    return false;
  }

  return { handleTerminalNewlineKeyEvent };
});
