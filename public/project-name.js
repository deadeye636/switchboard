// Pure helper: pick the label shown for a project.
// Custom displayName wins (trimmed); empty/whitespace falls back to the
// directory-derived shortName. Electron-free so it can be unit-tested.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function projectDisplayLabel(displayName, shortName) {
    const custom = typeof displayName === 'string' ? displayName.trim() : '';
    return custom || shortName;
  }
  return { projectDisplayLabel };
});
