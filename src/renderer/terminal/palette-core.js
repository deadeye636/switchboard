// --- Palette core: the one keyboard-driven picker every insert hotkey opens (#462) ---
//
// There were two of these before this file existed — the saved-variable picker (#207) and the plan
// picker (#453) — and they were the same popover twice: the same geometry, the same focus recovery,
// the same outside-click and scrollbar rules, the same listbox semantics. All of that was paid for in
// bugs, and every one of those fixes had to be made twice. The third picker (skills) is what made
// paying it a third time obviously wrong.
//
// So the behaviour lives here once and a picker is a DESCRIPTION: what to load, how to filter it, what
// a row looks like, what happens on Enter. A picker file holds no DOM and no event listener.
//
// ONE palette is open at a time, across all pickers. That is not a limitation to work around — two of
// these on screen would fight over the anchor, the focus and the Escape key — and it is why `closePalette`
// takes no picker: whoever is open closes. Callers that used to close each picker in turn (app.js's
// setActiveSession, grid-view's view switches, terminal-manager's destroySession) make one call now.
//
// The config a picker hands to `openPalette`:
//   id            — short slug; row ids and the listbox id are built from it, so it must be unique
//   extraClass    — extra class on the popover, for a picker that needs its own rule
//   shortcut      — the shortcut name, so pressing the opening chord again closes it
//   placeholder / ariaLabel / listLabel — the filter box and the listbox, in this picker's words
//   failedText    — what a failed load says; "no rows" and "load failed" must not read alike
//   swallowOpeningPaste — true where the opening chord also fires a native paste (Ctrl/Cmd+Shift+V)
//   load(ctx)     — async; returns `{ rows, extra }`. `extra` is whatever else the picker needs at
//                   insert time (a template, a setting) and is handed back to `pick`
//   filter(rows, query, ctx)  — the query applied; the ORDER it returns is the order the arrows walk
//   groups(rows, ctx)         — optional; `[{ label, rows }]` to draw headings, or null for a flat list
//   rowKey(row)   — the identity a click maps back to a row
//   row(row)      — `{ main, meta, metaClass }`, all escaped here
//   emptyText(ctx)      — the status when the picker holds nothing: a string, or `{ before, key, after }`
//                         for the one case that wants a <kbd> in the middle
//   noMatchText(query)  — the status when the filter matched nothing
//   emptyEnter(ctx)     — optional; what Enter does when there is nothing to pick (the variable picker
//                         sends the user to the tab where they would add some)
//   pick(row, ctx)      — the insert. The palette is already closed and the terminal is in ctx.
//
// Free globals it reaches for, all at CALL time so tag order does not decide them — guarded anyway:
//   `closeTerminalContextMenu`, `closeSelectionBar` (terminal-context-menu.js) · `sessionMap` (app.js)
//   `escapeHtml`, `formatDate` (lib/utils.js) · `matchShortcut`, `isMac`, `appShortcuts` (shell/shortcuts.js)
//
// Callers into this file, for `openPalette`: variable-palette.js, plan-palette.js, skill-palette.js,
// handoff-palette.js and shell/command-palette.js — grep `openPalette(` rather than trusting the list;
// app.js, grid-view.js and terminal-manager.js for `closePalette` / `closePaletteForSession`.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // --- Pure logic (unit-tested in test/palette-core.test.js) ---

  // Move the highlight by `delta`, wrapping at both ends. An empty list has no highlight (-1), which
  // is what keeps Enter from inserting anything when nothing matches.
  function nextIndex(current, count, delta) {
    if (!count || count < 1) return -1;
    const from = Number.isInteger(current) && current >= 0 ? current : 0;
    return ((from + delta) % count + count) % count;
  }

  // Where the palette sits: the lower half of the terminal's rectangle. Pure, so the awkward cases
  // (a short grid card, a terminal near the viewport edge) are testable rather than eyeballed.
  //
  // Half a small grid card is all chrome and no list, so there is a floor — but the floor must not
  // let the palette spill onto the card BELOW, so a card shorter than the floor gets a palette that
  // covers it entirely rather than one that overhangs. Never leaves the viewport.
  const PALETTE_MIN_H = 190;

  function paletteGeometry(rect, viewportHeight) {
    const vh = Math.max(0, viewportHeight);
    const wanted = Math.max(Math.round(rect.height / 2), PALETTE_MIN_H);
    // Never taller than the terminal itself, and never taller than the viewport allows.
    const height = Math.max(1, Math.min(wanted, Math.round(rect.height), Math.max(1, vh - 16)));
    const bottomLimit = Math.round(rect.top + rect.height) - height; // stay inside the terminal
    const viewportLimit = vh - height - 8;                            // stay inside the viewport
    const top = Math.max(8, Math.min(Math.round(rect.top + rect.height / 2), bottomLimit, viewportLimit));
    return { left: Math.round(rect.left), width: Math.round(rect.width), top, height };
  }

  // A palette with no terminal to sit in — the command palette (#274) belongs to the app, not to a
  // session, and it is opened from anywhere including a window with nothing running. Centred near the
  // top, the place every command palette has been since the first one, and clamped so a short window
  // still gets a list rather than a sliver.
  const CENTERED_W = 620;
  const CENTERED_MIN_H = 220;

  function centeredGeometry(viewportWidth, viewportHeight) {
    const vw = Math.max(0, viewportWidth);
    const vh = Math.max(0, viewportHeight);
    const width = Math.max(280, Math.min(CENTERED_W, vw - 32));
    const height = Math.max(1, Math.min(Math.max(Math.round(vh * 0.6), CENTERED_MIN_H), Math.max(1, vh - 32)));
    const left = Math.max(8, Math.round((vw - width) / 2));
    // A sixth of the way down reads as "over the app" rather than "in the middle of it", but never so
    // far that the bottom leaves the viewport.
    const top = Math.max(8, Math.min(Math.round(vh / 6), vh - height - 8));
    return { left: Math.round(left), width: Math.round(width), top, height };
  }

  // --- The palette itself ---

  let palette = null;      // the live element, or null
  let backdrop = null;     // the modal backdrop of a `centered` palette (#274), or null
  let paletteState = null; // { config, rows, shown, index, terminal, sessionId, projectPath, extra, loaded }
  // A chord that opens the palette may also fire a native paste (Ctrl/Cmd+Shift+V). terminal-manager
  // swallows that paste for the TERMINAL, but the filter input now holds the focus, so the clipboard
  // landed in the query box instead. Swallow exactly the one paste the opening chord caused; a
  // deliberate paste into the filter afterwards still works.
  let swallowOpeningPaste = false;
  // Bumped on every open. The rows arrive after an await, and `palette` is a module-level slot — so a
  // second open during that await would let the FIRST call write its rows into the SECOND palette's
  // state. Comparing the epoch instead of "is there a palette" is what keeps them apart.
  let openEpoch = 0;
  // When a press inside the palette last happened. Distinguishes a scrollbar grab (focus falls to
  // <body>, palette must stay) from the user genuinely leaving.
  let lastInsideMouseDown = 0;

  function esc(value) {
    return typeof escapeHtml === 'function' ? escapeHtml(String(value ?? '')) : String(value ?? '');
  }

  function el(selector) { return palette.querySelector(selector); }

  // Coming back to the window (Alt-Tab back, closing DevTools) does not necessarily put the caret
  // back in the filter — and every key handler hangs off it, so the palette would be open and
  // keyboard-dead. Take the focus back.
  function onWindowFocus() {
    if (!palette) return;
    const input = el('.vpal-input');
    if (input && document.activeElement !== input) input.focus();
  }

  function closePalette({ refocus = true } = {}) {
    if (!palette) return;
    document.removeEventListener('mousedown', onOutsideClick, true);
    window.removeEventListener('focus', onWindowFocus);
    window.removeEventListener('resize', onWindowResize);
    if (backdrop) { backdrop.remove(); backdrop = null; }
    palette.remove();
    palette = null;
    const term = paletteState && paletteState.terminal;
    // A session-less palette (#274) has no terminal to hand the focus back to, so it hands it back to
    // whatever held it when the palette opened. Without this the focus falls to <body> and the app is
    // keyboard-dead until something is clicked.
    const returnTo = paletteState && paletteState.returnFocus;
    paletteState = null;
    if (!refocus) return;
    if (term) { try { term.focus(); } catch {} return; }
    if (returnTo && typeof returnTo.focus === 'function' && returnTo.isConnected !== false) {
      try { returnTo.focus(); } catch {}
    }
  }

  function onOutsideClick(event) {
    if (palette && !palette.contains(event.target)) closePalette();
  }

  // The anchor is the terminal's rectangle, which moves with the window.
  function onWindowResize() {
    if (palette && paletteState) position(paletteState.terminal);
  }

  // Is the palette that is open right now a session-less one (#274)? `setActiveSession` closes any open
  // palette on a switch, because a picker captured ONE terminal and its Enter would aim at the session
  // the user just left — but the command palette captured no terminal and has no such problem. Asked
  // here rather than reading paletteState from outside, which is this module's private slot.
  function paletteIsSessionless() {
    return !!(paletteState && !paletteState.sessionId);
  }

  // Called from destroySession: the palette holds the terminal for its insert, so it must go before
  // the xterm is disposed — otherwise it floats over the app pointing at a dead instance.
  function closePaletteForSession(sessionId) {
    if (paletteState && paletteState.sessionId === sessionId) closePalette({ refocus: false });
  }

  // Falls back to the viewport if xterm has no element yet — the palette must still be reachable,
  // just less precisely placed.
  function position(terminal) {
    const centered = paletteState && paletteState.config && paletteState.config.centered;
    let rect = null;
    try { rect = terminal && terminal.element && terminal.element.getBoundingClientRect(); } catch {}
    if (!rect || !rect.width || !rect.height) {
      rect = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    }
    const g = centered
      ? centeredGeometry(window.innerWidth, window.innerHeight)
      : paletteGeometry(rect, window.innerHeight);
    palette.style.position = 'fixed';
    palette.style.left = g.left + 'px';
    palette.style.width = g.width + 'px';
    palette.style.top = g.top + 'px';
    palette.style.height = g.height + 'px';
  }

  // Position-based, not identity-based: sanitising an id into a DOM id can collapse two distinct ids
  // onto one, and a duplicate id makes aria-activedescendant point at whichever came first.
  function rowId(i) { return paletteState.config.id + '-pal-row-' + i; }

  function rowHtml(row, i, active) {
    const { main, meta, metaClass } = paletteState.config.row(row) || {};
    const key = paletteState.config.rowKey(row);
    return `
      <div class="vpal-row${active ? ' active' : ''}" id="${rowId(i)}" data-key="${esc(key)}" role="option" aria-selected="${active ? 'true' : 'false'}">
        <span class="vpal-name">${esc(main)}</span>
        ${meta ? `<span class="vpal-secret${metaClass ? ' ' + metaClass : ''}">${esc(meta)}</span>` : ''}
      </div>`;
  }

  // The status line lives OUTSIDE the listbox: a listbox may own options only, and a "Loading…" or
  // "no match" node in there is either dropped or read out as a choosable row.
  // PLAIN TEXT ONLY. One of the callers below puts the user's own query in this line, so an
  // innerHTML here is a single careless caller away from being an XSS sink — CodeQL flagged the
  // path even though every present caller escapes. textContent cannot be talked into markup, which
  // means the next caller cannot get it wrong either.
  function setStatus(text) {
    const node = el('.vpal-status');
    node.textContent = text || '';
    node.style.display = text ? '' : 'none';
  }

  // The one message shape that wants markup in the middle of it — a <kbd> around the key to press. It
  // builds the element instead of writing a string, so the exception does not reopen the sink.
  function setStatusWithKey({ before, key, after }) {
    const node = el('.vpal-status');
    const kbd = document.createElement('kbd');
    kbd.textContent = key;
    node.replaceChildren(before || '', kbd, after || '');
    node.style.display = '';
  }

  function pickerContext() {
    const { terminal, sessionId, projectPath, extra, rows } = paletteState;
    return { terminal, sessionId, projectPath, extra, rows };
  }

  /**
   * A row's meta line with the document's date on it (#475): `<file> · <when>`.
   *
   * Here rather than in each picker, because "when was this last changed" is the same question in all of
   * them and the wording has to match the Plans list — which is `formatDate`, the app's one answer to it.
   * A date that cannot be read is left off entirely: a row saying "unknown" is worth less than the
   * filename it would push aside.
   */
  function paletteMetaWithDate(text, iso) {
    const file = String(text == null ? '' : text);
    if (!iso || typeof formatDate !== 'function') return file;
    const when = new Date(iso);
    if (Number.isNaN(when.getTime())) return file;
    let label = '';
    try { label = formatDate(when); } catch { label = ''; }
    return label ? (file ? `${file} · ${label}` : label) : file;
  }

  function renderList() {
    const listEl = el('.vpal-list');
    const countEl = el('.vpal-count');
    const inputEl = el('.vpal-input');
    const { config, rows, shown, index } = paletteState;
    // A "0" while the rows are still in flight reads as "you have none", which is the one thing it
    // does not mean.
    countEl.textContent = (!paletteState.loaded || paletteState.failed) ? ''
      : shown.length === rows.length ? String(rows.length)
        : `${shown.length} of ${rows.length}`;
    // Cleared up front: the empty branches below return early, and a stale pointer to a row that no
    // longer exists is worse for a screen reader than none. `aria-expanded` follows the same truth —
    // hard-coding it to true would claim options exist while the list says otherwise.
    inputEl.removeAttribute('aria-activedescendant');
    inputEl.setAttribute('aria-expanded', shown.length ? 'true' : 'false');

    listEl.innerHTML = '';
    // Until the rows arrive, "none" means "not yet" — saying "nothing here" would be a lie, and
    // acting on it (Enter → somewhere else) actively wrong.
    if (!paletteState.loaded) { setStatus('Loading…'); return; }
    // A failed lookup is not an empty one: offering "press Enter to add some" would send the user
    // somewhere because an IPC call happened to fail.
    if (paletteState.failed) { setStatus(config.failedText); return; }
    if (!rows.length) {
      const empty = config.emptyText(pickerContext());
      if (empty && typeof empty === 'object') setStatusWithKey(empty); else setStatus(empty);
      return;
    }
    if (!shown.length) {
      // Stay open and keep what was typed — closing here would throw the query away.
      // No esc() — setStatus writes textContent, so escaping here would show the entities literally.
      setStatus(config.noMatchText(inputEl.value));
      return;
    }
    setStatus('');
    let html = '';
    let i = 0; // `shown` is already in render order, so this IS the highlight index
    const groups = config.groups ? config.groups(shown, pickerContext()) : null;
    if (groups) {
      for (const group of groups) {
        // A listbox may only contain options — the headings are decoration and must say so, or
        // assistive tech either drops them or reports them as choosable rows.
        html += `<div class="vpal-group" role="presentation">${esc(group.label)}</div>`;
        for (const row of group.rows) { html += rowHtml(row, i, i === index); i++; }
      }
    } else {
      for (const row of shown) { html += rowHtml(row, i, i === index); i++; }
    }
    listEl.innerHTML = html;
    const active = listEl.querySelector('.vpal-row.active');
    if (active) {
      active.scrollIntoView({ block: 'nearest' });
      // The focus stays in the input, so this is the only way assistive tech learns which row is
      // highlighted — the visual highlight alone says nothing to a screen reader.
      inputEl.setAttribute('aria-activedescendant', active.id);
    }
  }

  function applyFilter(query) {
    const { config } = paletteState;
    paletteState.shown = config.filter(paletteState.rows, query, pickerContext());
    paletteState.index = paletteState.shown.length ? 0 : -1;
    renderList();
  }

  function move(delta) {
    paletteState.index = nextIndex(paletteState.index, paletteState.shown.length, delta);
    renderList();
  }

  /** Take the highlighted row: close first, then hand it to the picker with the terminal it belongs to. */
  async function pickActive() {
    if (!paletteState || !paletteState.loaded || paletteState.failed) return; // in flight, or failed
    const { config } = paletteState;
    // Nothing there at all → Enter is the way to go add some, where a picker offers that.
    if (!paletteState.rows.length) {
      if (!config.emptyEnter) return;
      const ctx = pickerContext();
      closePalette({ refocus: false });
      config.emptyEnter(ctx);
      return;
    }
    const row = paletteState.shown[paletteState.index];
    if (!row) return;
    const ctx = pickerContext();
    closePalette({ refocus: false });
    try { await config.pick(row, ctx); } catch { /* the picker reports its own failures */ }
    // closePalette has already handed the focus back (to the terminal, or to whatever held it for a
    // session-less palette). Re-focusing the terminal here would take it away from whatever the picked
    // row just opened, and there is no terminal at all for the command palette.
    if (ctx.terminal) { try { ctx.terminal.focus(); } catch {} }
  }

  // While the palette is open its keys are ITS keys. Without this the document-level handler in
  // app.js still sees them — grid move mode would step a card on the same ↑/↓ that moves the
  // highlight. `_handled` is the flag the terminal's own handler sets for exactly this.
  function claim(event) {
    event.preventDefault();
    event.stopPropagation();
    event._handled = true;
  }

  // Only these four keys are ours. Everything else — every chord, every character — belongs to the
  // filter box or to the app, untouched.
  //
  // An earlier attempt closed the palette on any Ctrl/Cmd/Alt chord to stop a session switch leaving
  // it aimed at the old terminal. That was wrong twice over: the modifier's OWN keydown reports
  // `key === 'Control'` with `ctrlKey` already true, so a bare Ctrl tap killed the palette — and on a
  // European layout AltGr IS Ctrl+Alt, so typing `@` or `\` did too. The session case is handled where
  // it actually happens, in setActiveSession (app.js).
  function onKey(event) {
    // Mid-composition Enter commits an IME candidate; it is not a request to insert anything.
    if (event.isComposing || event.keyCode === 229) return;
    // The open chord again = close. Once the palette has the focus the terminal's handler no longer
    // sees the hotkey, so without this a second press is silently dead.
    if (typeof matchShortcut === 'function' && paletteState
        && matchShortcut(paletteState.config.shortcut, event, typeof isMac !== 'undefined' ? isMac : false,
          typeof appShortcuts !== 'undefined' ? appShortcuts : null)) {
      claim(event);
      closePalette();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      // A chord is not ours to INTERPRET, but a modal palette must not let it reach the app either:
      // the document-level dispatcher in app.js answers these, so with the command palette open and
      // focused, Ctrl/Cmd+Shift+G switched the whole view and Ctrl/Cmd+Shift+B bookmarked the session
      // underneath — while the backdrop was still up. Stopped, not prevented: the editing chords the
      // filter box itself needs (copy, paste, select all) keep their native behaviour.
      if (paletteState && paletteState.config.centered) event.stopPropagation();
      return;
    }
    if (event.key === 'Escape') { claim(event); closePalette(); return; }
    if (event.key === 'ArrowDown') { claim(event); move(1); return; }
    if (event.key === 'ArrowUp') { claim(event); move(-1); return; }
    if (event.key === 'Enter') { claim(event); pickActive(); }
  }

  async function openPalette(config, terminal, sessionId) {
    closePalette({ refocus: false });
    // The picker the first of these replaced opened THROUGH the context menu, so it closed it by
    // construction. Nothing does that now — without this a right-click menu (and its selection bar)
    // stays on screen behind the palette, and its Escape handler is in the capture phase, so one
    // Escape would close both.
    if (typeof closeTerminalContextMenu === 'function') closeTerminalContextMenu();
    if (typeof closeSelectionBar === 'function') closeSelectionBar();
    const epoch = ++openEpoch;
    const projectPath = (typeof sessionMap !== 'undefined' && sessionId)
      ? (sessionMap.get(sessionId)?.projectPath || null) : null;
    const listboxId = config.id + '-pal-listbox';

    // A modal palette gets a backdrop: without one the outside click that closes it ALSO reaches the UI
    // underneath, so dismissing it could open a session on the way out. The backdrop is a sibling, added
    // first, and removed by closePalette.
    if (config.centered) {
      backdrop = document.createElement('div');
      backdrop.className = 'palette-backdrop';
      document.body.appendChild(backdrop);
    }

    palette = document.createElement('div');
    palette.className = 'popover variable-palette' + (config.centered ? ' command-palette-modal' : '') + (config.extraClass ? ' ' + config.extraClass : '');
    palette.innerHTML = `
      <div class="vpal-filter">
        <span class="vpal-glyph" aria-hidden="true">⌕</span>
        <input class="vpal-input" type="text" placeholder="${esc(config.placeholder)}" aria-label="${esc(config.ariaLabel)}" role="combobox" aria-expanded="false" aria-controls="${esc(listboxId)}" autocomplete="off" spellcheck="false">
        <span class="vpal-count"></span>
      </div>
      <div class="vpal-status" role="status"></div>
      <div class="vpal-list" id="${esc(listboxId)}" role="listbox" aria-label="${esc(config.listLabel)}"></div>
      <div class="vpal-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>Enter</kbd> ${esc(config.enterLabel || 'insert')}</span>
        <span><kbd>Esc</kbd> close</span>
      </div>`;
    document.body.appendChild(palette);

    paletteState = {
      config, rows: [], shown: [], index: -1, terminal, sessionId, projectPath, extra: null, loaded: false,
      // Where the focus goes when a session-less palette closes (#274). Captured BEFORE the filter input
      // takes it, and only useful when there is no terminal to fall back on.
      returnFocus: terminal ? null : document.activeElement,
    };
    // Positioned after paletteState exists: `position` asks the config whether this palette is anchored
    // in a terminal or centred on the window (#274).
    position(terminal);
    renderList(); // paint "Loading…" now — otherwise the list is blank until the IPC returns
    const input = el('.vpal-input');
    input.addEventListener('keydown', onKey);
    input.addEventListener('input', () => applyFilter(input.value));
    input.addEventListener('paste', (event) => {
      if (!swallowOpeningPaste) return;
      swallowOpeningPaste = false;
      event.preventDefault();
    });
    // Every key handler hangs off the input, so focus leaving it would strand the palette open with
    // no keyboard way back — Escape included. Close on a real focus loss, but only a real one:
    //   - a mousedown anywhere in the palette that is not the input keeps the focus (below), so
    //     clicking the count badge, a group heading or the footer no longer throws the query away;
    //   - `document.hasFocus()` is false for an Alt-Tab or DevTools, which must NOT close it;
    //   - the check runs a tick later because `document.activeElement` is not yet updated during
    //     focusout, and relatedTarget is null for too many benign cases to be trusted.
    palette.addEventListener('mousedown', (event) => {
      // Remember that the press came from inside, whatever it lands on. The focusout handler uses
      // this to tell "the user grabbed something in here" from "the user left".
      lastInsideMouseDown = Date.now();
      if (event.target === input) return;
      // A mousedown past the content box is the native scrollbar of the scrollable list; defaulting
      // that away would kill dragging it. Anything else keeps the focus in the filter.
      const t = event.target;
      const isListScrollbar = t === el('.vpal-list')
        && t.scrollHeight > t.clientHeight
        && event.offsetX > t.clientWidth;
      if (!isListScrollbar) event.preventDefault();
    });
    input.addEventListener('focusout', () => {
      setTimeout(() => {
        if (!palette || !document.hasFocus()) return;
        if (palette.contains(document.activeElement)) return;
        // Focus fell to <body> right after a press inside the palette — a scrollbar grab, not a
        // departure. Take it back rather than closing out from under the drag.
        if (document.activeElement === document.body && Date.now() - lastInsideMouseDown < 500) {
          el('.vpal-input').focus();
          return;
        }
        closePalette({ refocus: false });
      }, 0);
    });
    window.addEventListener('focus', onWindowFocus);
    window.addEventListener('resize', onWindowResize);
    // Registered NOW, not after the load: during the IPC round-trip a click outside would otherwise
    // go unnoticed, and the focus-recovery above would read it as "still working in here".
    setTimeout(() => {
      if (epoch === openEpoch && palette) document.addEventListener('mousedown', onOutsideClick, true);
    }, 0);
    if (config.swallowOpeningPaste) {
      swallowOpeningPaste = true;
      setTimeout(() => { swallowOpeningPaste = false; }, 0); // clear it if no paste follows
    }
    input.focus();

    el('.vpal-list').addEventListener('mousedown', (event) => {
      const row = event.target.closest('.vpal-row');
      if (!row || !paletteState) return;
      event.preventDefault();
      const i = paletteState.shown.findIndex(r => String(paletteState.config.rowKey(r)) === row.dataset.key);
      if (i >= 0) { paletteState.index = i; pickActive(); }
    });

    let loaded = null;
    let failed = false;
    try { loaded = await config.load({ projectPath, sessionId }); } catch { failed = true; }
    // Closed, or superseded by a later open — either way these rows are not ours to write.
    if (epoch !== openEpoch || !palette || !paletteState) return;
    const rows = loaded && loaded.rows;
    paletteState.rows = Array.isArray(rows) ? rows.filter(Boolean) : [];
    paletteState.failed = failed || !Array.isArray(rows);
    paletteState.extra = loaded ? loaded.extra : null;
    paletteState.loaded = true;
    applyFilter(input.value);
    position(terminal);
  }

  return {
    nextIndex, paletteGeometry, centeredGeometry, openPalette, closePalette, closePaletteForSession,
    paletteIsSessionless, paletteMetaWithDate,
  };
});
