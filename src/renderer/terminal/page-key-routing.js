(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // null = not a bare page key, so the rest of the terminal key handler still gets a say.
  // true = xterm may forward it to the PTY. false = Switchboard consumed it for the viewport.
  //
  // `canPage` answers whether there is a viewport to page RIGHT NOW — the terminal is on the normal
  // buffer, where xterm holds the scrollback. On the alternate screen `baseY` is 0 and `scrollPages()`
  // cannot move anything, so consuming the key there swallows it for nothing: no scroll, and the TUI
  // that owns the screen never sees it either (#558). A backend declaring 'viewport' declares what it
  // does with the key, not what its CLI's renderer is doing this minute — Claude switches buffers on a
  // setting of its own, so the same descriptor is right in both states only if this is asked live.
  // Omitted (undefined) means "assume there is", which keeps the four backends that never leave the
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
