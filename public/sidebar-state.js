(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function shouldRenderProjectGroup({
    visibleCount = 0,
    projectMatchedOnly = false,
  } = {}) {
    return projectMatchedOnly || visibleCount > 0;
  }

  return { shouldRenderProjectGroup };
});
