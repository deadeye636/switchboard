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

  // An optional opt-in switch inside the dialog, for a confirm whose SCOPE the user still gets to pick
  // (archive-all: include the running sessions, or leave them alone — #251). Absent unless a caller asks
  // for it, so every existing dialog is unchanged.
  function normalizeControlDialogCheckbox(checkbox) {
    if (!checkbox || !checkbox.label) return null;
    return { label: String(checkbox.label), checked: !!checkbox.checked };
  }

  function normalizeControlDialogOptions(options = {}) {
    return {
      title: String(options.title || ''),
      message: String(options.message || ''),
      // A checkbox that changes what the action covers changes the button that names it, so the label may
      // be a function of the checkbox state. Without a checkbox it is a plain string, as before.
      confirmLabel: typeof options.confirmLabel === 'function'
        ? options.confirmLabel
        : String(options.confirmLabel || 'Confirm'),
      // A confirm that would do nothing in the current state says so by being unavailable, rather than
      // accepting the click and quietly returning. Also a function of the checkbox state.
      confirmDisabled: typeof options.confirmDisabled === 'function'
        ? options.confirmDisabled
        : () => !!options.confirmDisabled,
      checkbox: normalizeControlDialogCheckbox(options.checkbox),
      cancelLabel: String(options.cancelLabel || 'Cancel'),
      secondaryLabel: String(options.secondaryLabel || ''),
      tertiaryLabel: String(options.tertiaryLabel || ''),
      tone: KNOWN_TONES.has(options.tone) ? options.tone : 'default',
      details: formatControlDialogDetails(options.details),
      // Can a click on the backdrop dismiss this? For a "are you sure?" it is a convenience — nothing is
      // lost by closing it. For a dialog holding WORK — a handoff packet an agent just spent tokens and
      // minutes producing — a stray click beside it throws that away, unrecoverably. Those opt out.
      dismissible: options.dismissible !== false,
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

  // The confirm button's text, for the current checkbox state.
  function controlDialogConfirmText(normalized, checked) {
    return typeof normalized.confirmLabel === 'function'
      ? String(normalized.confirmLabel(checked))
      : normalized.confirmLabel;
  }

  // ...and whether it can be pressed at all in that state.
  function controlDialogConfirmDisabled(normalized, checked) {
    return typeof normalized.confirmDisabled === 'function'
      ? !!normalized.confirmDisabled(checked)
      : false;
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

      let checked = normalized.checkbox ? normalized.checkbox.checked : false;

      dialog.innerHTML = `
        <div class="control-dialog-kicker">${normalized.tone === 'danger' ? 'Destructive Action' : 'Confirm Action'}</div>
        <h3 id="control-dialog-title">${escapeHtml(normalized.title)}</h3>
        ${normalized.message ? `<p>${escapeHtml(normalized.message)}</p>` : ''}
        ${detailRows ? `<div class="control-dialog-details">${detailRows}</div>` : ''}
        ${normalized.checkbox ? `
        <label class="control-dialog-checkbox">
          <input type="checkbox"${checked ? ' checked' : ''}>
          <span>${escapeHtml(normalized.checkbox.label)}</span>
        </label>` : ''}
        <div class="control-dialog-actions">
          ${normalized.cancelLabel ? `<button type="button" class="control-dialog-cancel">${escapeHtml(normalized.cancelLabel)}</button>` : ''}
          ${normalized.secondaryLabel ? `<button type="button" class="control-dialog-secondary">${escapeHtml(normalized.secondaryLabel)}</button>` : ''}
          ${normalized.tertiaryLabel ? `<button type="button" class="control-dialog-tertiary">${escapeHtml(normalized.tertiaryLabel)}</button>` : ''}
          <button type="button" class="control-dialog-confirm"${controlDialogConfirmDisabled(normalized, checked) ? ' disabled' : ''}>${escapeHtml(controlDialogConfirmText(normalized, checked))}</button>
        </div>
      `;

      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      const cancelBtn = dialog.querySelector('.control-dialog-cancel');
      const secondaryBtn = dialog.querySelector('.control-dialog-secondary');
      const tertiaryBtn = dialog.querySelector('.control-dialog-tertiary');
      const confirmBtn = dialog.querySelector('.control-dialog-confirm');
      const checkboxInput = dialog.querySelector('.control-dialog-checkbox input');

      if (checkboxInput) {
        checkboxInput.addEventListener('change', () => {
          checked = checkboxInput.checked;
          confirmBtn.textContent = controlDialogConfirmText(normalized, checked);
          confirmBtn.disabled = controlDialogConfirmDisabled(normalized, checked);
        });
      }

      // A dialog with a checkbox answers TWO questions, so it resolves with both. Without one the result
      // stays the bare true/false/'secondary'/'tertiary' every existing caller reads.
      function close(result) {
        closeControlDialog(overlay, onKey, normalized.checkbox ? { confirmed: result, checked } : result, resolve);
      }

      function onKey(event) {
        // Escape throws the dialog away exactly like a backdrop click does, so a dialog that holds work
        // has to be safe from both. It is not "one is deliberate and the other is not": Escape is a
        // reflex, and the packet it discards took an agent minutes and tokens to write. An explicit
        // button is the only way out of those.
        if (event.key === 'Escape' && normalized.dismissible) close(false);
        // Enter is the confirm button, so a disabled button disables Enter too — otherwise the keyboard
        // walks straight past the state the button is greyed out for.
        if (event.key === 'Enter' && !event.target.matches('textarea,input') && !confirmBtn.disabled) close(true);
      }

      if (cancelBtn) cancelBtn.addEventListener('click', () => close(false));
      if (secondaryBtn) secondaryBtn.addEventListener('click', () => close('secondary'));
      if (tertiaryBtn) tertiaryBtn.addEventListener('click', () => close('tertiary'));
      confirmBtn.addEventListener('click', () => close(true));
      if (normalized.dismissible) {
        overlay.addEventListener('click', event => {
          if (event.target === overlay) close(false);
        });
      }
      document.addEventListener('keydown', onKey);
      // A disabled confirm cannot take focus, and the dialog must not open with focus nowhere. The
      // checkbox is what makes it pressable, so that is where the user is put.
      if (confirmBtn.disabled && checkboxInput) checkboxInput.focus();
      else confirmBtn.focus();
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

    let stack = document.getElementById('control-toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'control-toast-stack';
      document.body.appendChild(stack);
    }
    stack.appendChild(toast);
    timeoutId = setTimeout(() => toast.remove(), timeoutMs);
    return toast;
  }

  return {
    normalizeControlDialogOptions,
    controlDialogToneClass,
    controlDialogConfirmText,
    controlDialogConfirmDisabled,
    formatControlDialogDetails,
    showControlDialog,
    showControlMessage,
    showControlToast,
  };
});
