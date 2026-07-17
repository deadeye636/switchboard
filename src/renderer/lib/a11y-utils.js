(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function isKeyboardActivation(event) {
    if (!event) return false;
    if (event.key === 'Enter') return event.type === 'keydown';
    if (event.key === ' ' || event.key === 'Spacebar') return event.type === 'keyup';
    return false;
  }

  function handleKeyboardActivation(event, callback) {
    if (!isKeyboardActivation(event)) return false;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    callback(event);
    return true;
  }

  // The ARIA half of makeButtonLike, without the per-node keyboard listeners: mark a non-<button>
  // element as a button (role + focusability + label). Use this when a delegated listener on a stable
  // ancestor supplies the click/keyboard activation, so nothing has to be re-bound after a morphdom patch
  // (#218 opt6). A real <button> keeps its native semantics — do not call this on one.
  function ariaButton(element, label) {
    if (!element) return element;
    element.setAttribute('role', 'button');
    if (element.tabIndex < 0) element.tabIndex = 0;
    if (label && !element.getAttribute('aria-label')) element.setAttribute('aria-label', label);
    return element;
  }

  function makeButtonLike(element, callback, label) {
    if (!element) return element;
    element.setAttribute('role', 'button');
    if (element.tabIndex < 0) element.tabIndex = 0;
    if (label && !element.getAttribute('aria-label')) {
      element.setAttribute('aria-label', label);
    }
    if (element._buttonLikeKeydown && typeof element.removeEventListener === 'function') {
      element.removeEventListener('keydown', element._buttonLikeKeydown);
      element.removeEventListener('keyup', element._buttonLikeKeyup);
    }
    element._buttonLikeKeydown = event => handleKeyboardActivation(event, callback);
    element._buttonLikeKeyup = event => handleKeyboardActivation(event, callback);
    element.addEventListener('keydown', element._buttonLikeKeydown);
    element.addEventListener('keyup', element._buttonLikeKeyup);
    return element;
  }

  function syncTitleToAriaLabel(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    root.querySelectorAll('button[title]:not([aria-label])').forEach(button => {
      if (button.title) button.setAttribute('aria-label', button.title);
    });
  }

  function syncTitleToTooltip(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    root.querySelectorAll('button[title]:not([data-tooltip])').forEach(button => {
      if (button.title) button.setAttribute('data-tooltip', button.title);
    });
  }

  return {
    isKeyboardActivation,
    handleKeyboardActivation,
    makeButtonLike,
    ariaButton,
    syncTitleToTooltip,
    syncTitleToAriaLabel,
  };
});
