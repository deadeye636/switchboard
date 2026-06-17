(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Pure helpers for the "next attention" feature (spec 02): the decision of
  // whether to play the attention cue, and matching the focus-next hotkey.
  // Kept DOM/Electron-free so it can be unit tested directly.

  // Default in-app hotkey: Cmd/Ctrl+Shift+A ("Attention"). `mod` means the
  // platform command modifier (Cmd on macOS, Ctrl elsewhere) — we accept either
  // metaKey or ctrlKey here so the predicate stays platform-agnostic.
  const DEFAULT_NEXT_ATTENTION_BINDING = { key: 'a', mod: true, shift: true, alt: false };

  function toIdList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value.forEach === 'function') {
      const out = [];
      value.forEach(v => out.push(v));
      return out;
    }
    return [];
  }

  // Decide whether to play the attention cue. Returns true only when sound is
  // enabled AND at least one session id is present in `next` that was not in
  // `prev` (i.e. a session newly entered the attention set). `prev`/`next` may be
  // Sets or arrays of session ids.
  function shouldPlayAttentionSound({ prev, next, settings } = {}) {
    if (!settings || !settings.sound) return false;
    const prevIds = new Set(toIdList(prev));
    return toIdList(next).some(id => !prevIds.has(id));
  }

  // Pure predicate: does this keyboard event match the next-attention binding?
  function isNextAttentionKey(e, binding) {
    if (!e) return false;
    const b = binding || DEFAULT_NEXT_ATTENTION_BINDING;
    const wantMod = b.mod !== false;
    const hasMod = !!(e.metaKey || e.ctrlKey);
    if (wantMod !== hasMod) return false;
    if (!!b.shift !== !!e.shiftKey) return false;
    if (!!b.alt !== !!e.altKey) return false;
    const key = String(b.key || 'a').toLowerCase();
    const eventKey = String(e.key || '').toLowerCase();
    const eventCode = String(e.code || '').toLowerCase();
    return eventKey === key || eventCode === 'key' + key;
  }

  return {
    DEFAULT_NEXT_ATTENTION_BINDING,
    shouldPlayAttentionSound,
    isNextAttentionKey,
  };
});
