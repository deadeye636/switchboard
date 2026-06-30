(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const KNOWN_TONES = new Set(['default', 'danger', 'warning', 'success']);

  function formatControlDialogDetails(details) {
    if (!details) return [];
    if (Array.isArray(details)) {
      return details
        .filter(item => item && item.value !== undefined && item.value !== null && String(item.value) !== '')
        .map(item => ({ label: String(item.label || ''), value: String(item.value) }));
    }
    return Object.entries(details)
      .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
      .map(([label, value]) => ({ label: String(label), value: String(value) }));
  }

  function normalizeControlDialogOptions(options = {}) {
    return {
      title: String(options.title || ''),
      message: String(options.message || ''),
      confirmLabel: String(options.confirmLabel || 'Confirm'),
      cancelLabel: String(options.cancelLabel || 'Cancel'),
      secondaryLabel: String(options.secondaryLabel || ''),
      tertiaryLabel: String(options.tertiaryLabel || ''),
      tone: KNOWN_TONES.has(options.tone) ? options.tone : 'default',
      details: formatControlDialogDetails(options.details),
    };
  }

  function controlDialogToneClass(tone) {
    return `control-dialog-${KNOWN_TONES.has(tone) ? tone : 'default'}`;
  }

  function closeControlDialog(overlay, keyHandler, result, resolve) {
    document.removeEventListener('keydown', keyHandler);
    overlay.remove();
    resolve(result);
  }

  function showControlDialog(options = {}) {
    const normalized = normalizeControlDialogOptions(options);

    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'control-dialog-overlay';

      const dialog = document.createElement('div');
      dialog.className = `control-dialog ${controlDialogToneClass(normalized.tone)}`;
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'control-dialog-title');

      const detailRows = normalized.details.map(({ label, value }) => `
        <div class="control-dialog-detail-row">
          <span class="control-dialog-detail-label">${escapeHtml(label)}</span>
          <span class="control-dialog-detail-value">${escapeHtml(value)}</span>
        </div>
      `).join('');

      dialog.innerHTML = `
        <div class="control-dialog-kicker">${normalized.tone === 'danger' ? 'Destructive Action' : 'Confirm Action'}</div>
        <h3 id="control-dialog-title">${escapeHtml(normalized.title)}</h3>
        ${normalized.message ? `<p>${escapeHtml(normalized.message)}</p>` : ''}
        ${detailRows ? `<div class="control-dialog-details">${detailRows}</div>` : ''}
        <div class="control-dialog-actions">
          ${normalized.cancelLabel ? `<button type="button" class="control-dialog-cancel">${escapeHtml(normalized.cancelLabel)}</button>` : ''}
          ${normalized.secondaryLabel ? `<button type="button" class="control-dialog-secondary">${escapeHtml(normalized.secondaryLabel)}</button>` : ''}
          ${normalized.tertiaryLabel ? `<button type="button" class="control-dialog-tertiary">${escapeHtml(normalized.tertiaryLabel)}</button>` : ''}
          <button type="button" class="control-dialog-confirm">${escapeHtml(normalized.confirmLabel)}</button>
        </div>
      `;

      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      const cancelBtn = dialog.querySelector('.control-dialog-cancel');
      const secondaryBtn = dialog.querySelector('.control-dialog-secondary');
      const tertiaryBtn = dialog.querySelector('.control-dialog-tertiary');
      const confirmBtn = dialog.querySelector('.control-dialog-confirm');

      function onKey(event) {
        if (event.key === 'Escape') closeControlDialog(overlay, onKey, false, resolve);
        if (event.key === 'Enter' && !event.target.matches('textarea,input')) closeControlDialog(overlay, onKey, true, resolve);
      }

      if (cancelBtn) cancelBtn.addEventListener('click', () => closeControlDialog(overlay, onKey, false, resolve));
      if (secondaryBtn) secondaryBtn.addEventListener('click', () => closeControlDialog(overlay, onKey, 'secondary', resolve));
      if (tertiaryBtn) tertiaryBtn.addEventListener('click', () => closeControlDialog(overlay, onKey, 'tertiary', resolve));
      confirmBtn.addEventListener('click', () => closeControlDialog(overlay, onKey, true, resolve));
      overlay.addEventListener('click', event => {
        if (event.target === overlay) closeControlDialog(overlay, onKey, false, resolve);
      });
      document.addEventListener('keydown', onKey);
      confirmBtn.focus();
    });
  }

  function showControlMessage(options = {}) {
    return showControlDialog({
      ...options,
      confirmLabel: options.confirmLabel || 'OK',
      cancelLabel: '',
    });
  }

  function showControlToast({ message, actionLabel, onAction, timeoutMs = 8000 } = {}) {
    const toast = document.createElement('div');
    toast.className = 'control-toast';

    const text = document.createElement('span');
    text.textContent = message || '';
    toast.appendChild(text);

    let timeoutId = null;
    if (actionLabel && onAction) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = actionLabel;
      button.addEventListener('click', async () => {
        if (timeoutId) clearTimeout(timeoutId);
        toast.remove();
        await onAction();
      });
      toast.appendChild(button);
    }

    document.body.appendChild(toast);
    timeoutId = setTimeout(() => toast.remove(), timeoutMs);
    return toast;
  }

  return {
    normalizeControlDialogOptions,
    controlDialogToneClass,
    formatControlDialogDetails,
    showControlDialog,
    showControlMessage,
    showControlToast,
  };
});
