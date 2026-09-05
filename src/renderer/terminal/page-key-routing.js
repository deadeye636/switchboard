(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // null = not a bare page key, so the rest of the terminal key handler still gets a say.
  // true = xterm may forward it to the PTY. false = Switchboard consumed it for the viewport.
  //
  // `canPage` answers whether the conversation is in OUR scrollback right now — the terminal is on the
  // normal buffer. On the alternate screen `baseY` is 0, so `scrollPages()` cannot move anything, and
  // the CLI drawing there is the one holding the history: for Claude's fullscreen renderer PageUp and
  // PageDown are its own documented scroll keys. Consuming them would be the worse half of both
  // outcomes — nothing scrolls here, and the only way that user pages their conversation is gone (#558,
  // which is #410's mistake wearing a new disguise).
  //
  // A backend declares what it does with the key, not which renderer its CLI happens to be running:
  // Claude has two, and it switches to the classic one BY ITSELF after two fullscreen sessions fail to
  // start. So the same descriptor is right in both states only if this is asked at the press.
  // Omitted (undefined) means "assume it is ours", which keeps the four backends that never leave the
  // normal buffer exactly as they were.
  function handleTerminalPageKeyEvent(event, target, scrollPages, canPage) {
    if (!event || (event.key !== 'PageUp' && event.key !== 'PageDown')
        || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return null;

    // Unknown/invalid declarations are application input. Swallowing a TUI key is the destructive default.
    if (target !== 'viewport') return true;

    // Same default, for the same reason: nothing to page means the key belongs to the application.
    if (canPage === false) return true;

    if (event.type === 'keydown') {
      event.preventDefault();
      scrollPages(event.key === 'PageUp' ? -1 : 1);
    }
    return false;
  }

  return { handleTerminalPageKeyEvent };
});
