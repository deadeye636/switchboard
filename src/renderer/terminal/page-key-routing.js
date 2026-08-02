(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // null = not a bare page key, so the rest of the terminal key handler still gets a say.
  // true = xterm may forward it to the PTY. false = Switchboard consumed it for the viewport.
  function handleTerminalPageKeyEvent(event, target, scrollPages) {
    if (!event || (event.key !== 'PageUp' && event.key !== 'PageDown')
        || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return null;

    // Unknown/invalid declarations are application input. Swallowing a TUI key is the destructive default.
    if (target !== 'viewport') return true;

    if (event.type === 'keydown') {
      event.preventDefault();
      scrollPages(event.key === 'PageUp' ? -1 : 1);
    }
    return false;
  }

  return { handleTerminalPageKeyEvent };
});
