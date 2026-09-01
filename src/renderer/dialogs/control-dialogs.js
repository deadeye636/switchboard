(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const KNOWN_TONES = new Set(['default', 'danger', 'warning', 'success']);
  const KNOWN_FOCUS_TARGETS = new Set(['confirm', 'secondary', 'tertiary', 'cancel']);
  // One counter per page, so every dialog's ids are its own (#503).
  let controlDialogSeq = 0;

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

  // The text input, when a caller wants an answer rather than a yes. Refused alongside a checkbox:
  // that one already owns the two-value result shape, and a dialog answering three questions is a form.
  function normalizeControlDialogPrompt(prompt, checkbox) {
    if (!prompt || checkbox) return null;
    return {
      value: String(prompt.value || ''),
      placeholder: String(prompt.placeholder || ''),
      maxLength: Number(prompt.maxLength) > 0 ? Math.floor(Number(prompt.maxLength)) : 60,
    };
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
      // A single line of text the dialog asks FOR rather than about (#352: naming a layout preset).
      // Absent unless a caller asks, so every existing dialog is unchanged — and a dialog cannot have
      // both this and a checkbox, because the two want to resolve with different shapes.
      prompt: normalizeControlDialogPrompt(options.prompt, options.checkbox),
      cancelLabel: String(options.cancelLabel || 'Cancel'),
      secondaryLabel: String(options.secondaryLabel || ''),
      tertiaryLabel: String(options.tertiaryLabel || ''),
      tone: KNOWN_TONES.has(options.tone) ? options.tone : 'default',
      details: formatControlDialogDetails(options.details),
      // Which button the dialog OPENS on, and therefore what Enter does (#501). The confirm is the right
      // answer for a two-button "are you sure?", where it is also the only thing to say yes to. It is the
      // wrong one where the confirm is deliberately the WIDEST of several answers — the archive scope
      // dialog confirms "All" beside a "Single", and a reflexive Enter would take the whole thread. A
      // caller naming a button the dialog does not render falls back to the confirm rather than leaving
      // focus nowhere, so this can never make a dialog unusable by the keyboard.
      initialFocus: KNOWN_FOCUS_TARGETS.has(options.initialFocus) ? options.initialFocus : 'confirm',
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

  // Everything an overlay with the control-dialog look owes the keyboard, in ONE place (#503, #505):
  // the Tab cycle inside it, and the caret handed back to whoever had it when the dialog goes away.
  //
  // It is exported because `showControlDialog` is not the only dialog wearing these classes — the
  // remove-project confirm builds its own markup, for checkbox lists this API has no shape for, and the
  // "topmost overlay" rule below is only true while EVERY `.control-dialog-overlay` traps. One that does
  // not is a hole in the other's promise, not just in its own.
  //
  // Call it once the overlay is in the document; call the returned release when it comes out.
  function trapControlDialogFocus(overlay, dialog) {
    const previouslyFocused = document.activeElement;

    function onTabKey(event) {
      if (event.key !== 'Tab') return;
      // `aria-modal="true"` tells assistive technology to ignore everything behind this dialog — but it
      // does not move focus, so Tab past the last button walked into a page the screen reader had just
      // been told is not there. The list is queried per press rather than captured: a confirm can be
      // disabled and become pressable while the dialog is open (the archive-all checkbox), and a captured
      // list would keep offering yesterday's answer.
      //
      // `contains` answers false for null and for a node in another tree, so it needs no type test — and
      // `Element` is not in the renderer lint environment's globals anyway.
      const inThisDialog = !!event.target && dialog.contains(event.target);
      // Only the TOP dialog pulls stray focus back, or two open dialogs fight over it.
      const overlays = document.querySelectorAll('.control-dialog-overlay');
      if (!inThisDialog && overlays[overlays.length - 1] !== overlay) return;
      const focusables = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled])')];
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!inThisDialog) { event.preventDefault(); (event.shiftKey ? last : first).focus(); return; }
      if (!event.shiftKey && event.target === last) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && event.target === first) { event.preventDefault(); last.focus(); }
    }

    document.addEventListener('keydown', onTabKey);

    return function releaseControlDialogFocus() {
      document.removeEventListener('keydown', onTabKey);
      // Closing used to leave focus on <body>: the focused button is removed with the overlay and nothing
      // claims it. That strands the caret outside every dialog — including one still open UNDERNEATH this
      // one, whose trap cannot pull it back until the next Tab press.
      const returnTo = previouslyFocused && previouslyFocused.isConnected
        && !overlay.contains(previouslyFocused) && typeof previouslyFocused.focus === 'function'
        ? previouslyFocused
        : null;
      if (returnTo) returnTo.focus();
    };
  }

  function showControlDialog(options = {}) {
    const normalized = normalizeControlDialogOptions(options);
    // Ids are per DIALOG, not per file (#503). The title used to carry a fixed `control-dialog-title`,
    // so two dialogs open at once pointed both `aria-labelledby`s at the first one's heading.
    const uid = ++controlDialogSeq;
    const titleId = `control-dialog-title-${uid}`;
    const messageId = `control-dialog-message-${uid}`;
    const detailsId = `control-dialog-details-${uid}`;

    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'control-dialog-overlay';

      const dialog = document.createElement('div');
      dialog.className = `control-dialog ${controlDialogToneClass(normalized.tone)}`;
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', titleId);
      // …and the dialog says what it is ASKING ABOUT, not only what it is called (#503). The title alone
      // is "Archive Session"; the sentence and the detail rows carry the scope and the counts the answer
      // rests on. Only ids that exist are referenced — a dangling one reads as nothing at all, which is
      // how a description silently disappears.
      const describedBy = [normalized.message ? messageId : '', normalized.details.length ? detailsId : ''].filter(Boolean);
      if (describedBy.length) dialog.setAttribute('aria-describedby', describedBy.join(' '));

      const detailRows = normalized.details.map(({ label, value }) => `
        <div class="control-dialog-detail-row">
          <span class="control-dialog-detail-label">${escapeHtml(label)}</span>
          <span class="control-dialog-detail-value">${escapeHtml(value)}</span>
        </div>
      `).join('');

      let checked = normalized.checkbox ? normalized.checkbox.checked : false;

      dialog.innerHTML = `
        <div class="control-dialog-kicker">${normalized.tone === 'danger' ? 'Destructive Action' : 'Confirm Action'}</div>
        <h3 id="${titleId}">${escapeHtml(normalized.title)}</h3>
        ${normalized.message ? `<p id="${messageId}">${escapeHtml(normalized.message)}</p>` : ''}
        ${detailRows ? `<div class="control-dialog-details" id="${detailsId}">${detailRows}</div>` : ''}
        ${normalized.prompt ? `
        <input type="text" class="control-dialog-input" maxlength="${normalized.prompt.maxLength}"
               placeholder="${escapeHtml(normalized.prompt.placeholder)}" value="${escapeHtml(normalized.prompt.value)}">` : ''}
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
      // The Tab cycle and the "give the keyboard back" promise, from the one place that owns them.
      const releaseFocus = trapControlDialogFocus(overlay, dialog);

      const cancelBtn = dialog.querySelector('.control-dialog-cancel');
      const secondaryBtn = dialog.querySelector('.control-dialog-secondary');
      const tertiaryBtn = dialog.querySelector('.control-dialog-tertiary');
      const confirmBtn = dialog.querySelector('.control-dialog-confirm');
      const checkboxInput = dialog.querySelector('.control-dialog-checkbox input');
      const textInput = dialog.querySelector('.control-dialog-input');

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
        // A prompt resolves with the TEXT, or null when it was dismissed — a caller that asked for a
        // name has nothing to do with `true`. Everything else keeps the shape it always had.
        if (normalized.prompt) {
          const text = result === true && textInput ? textInput.value.trim() : '';
          closeControlDialog(overlay, onKey, text || null, resolve);
        } else {
          closeControlDialog(overlay, onKey, normalized.checkbox ? { confirmed: result, checked } : result, resolve);
        }
        releaseFocus();
      }

      function onKey(event) {
        // Tab is the shared trap's (`trapControlDialogFocus`, above), on its own listener.
        if (event.key === 'Tab') return;
        // Escape throws the dialog away exactly like a backdrop click does, so a dialog that holds work
        // has to be safe from both. It is not "one is deliberate and the other is not": Escape is a
        // reflex, and the packet it discards took an agent minutes and tokens to write. An explicit
        // button is the only way out of those.
        if (event.key === 'Escape' && normalized.dismissible) close(false);
        // Enter on ANOTHER of the dialog's buttons answers with THAT button, not the confirm (#501). The
        // button's own activation already does it; this handler runs first, so without the bail-out a
        // dialog opened on "Single" would still answer "All" and `initialFocus` would be decoration.
        if (event.key === 'Enter' && (event.target === secondaryBtn || event.target === tertiaryBtn || event.target === cancelBtn)) return;
        // Enter is the confirm button, so a disabled button disables Enter too — otherwise the keyboard
        // walks straight past the state the button is greyed out for.
        // …and Enter INSIDE the prompt confirms it, which is what a one-field dialog is for. The
        // general rule still stands for every other input: Enter in a form field is not a submit.
        if (event.key === 'Enter' && textInput && event.target === textInput && !confirmBtn.disabled) close(true);
        else if (event.key === 'Enter' && !event.target.matches('textarea,input') && !confirmBtn.disabled) close(true);
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
      // A prompt opens with the cursor in the field — the dialog exists to be typed into, and putting
      // focus on the confirm button would make Enter answer with an empty string.
      // …and a caller may name a different button (#501), which is read LAST: the two rules above are
      // about a dialog that would otherwise be unusable, and a preference does not outrank that.
      const requestedFocus = { secondary: secondaryBtn, tertiary: tertiaryBtn, cancel: cancelBtn }[normalized.initialFocus];
      if (textInput) { textInput.focus(); textInput.select(); }
      else if (confirmBtn.disabled && checkboxInput) checkboxInput.focus();
      else if (requestedFocus) requestedFocus.focus();
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
    trapControlDialogFocus,
    showControlToast,
  };
});
