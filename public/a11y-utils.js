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

  return {
    isKeyboardActivation,
    handleKeyboardActivation,
    makeButtonLike,
    syncTitleToAriaLabel,
  };
});
