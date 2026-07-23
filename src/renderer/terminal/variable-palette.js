// --- Variable palette: the keyboard-driven picker on the insertVariable hotkey (#207) ---
//
// Ctrl/Cmd+Shift+V used to open the terminal context menu at the CARET: no filter, no arrow keys, and
// in a different place on every invocation, so the eye had to find it before the hand could use it.
// This is its replacement — anchored to the LOWER HALF of the terminal it belongs to, so it is always
// in the same place, with a filter that has focus the moment it opens.
//
// Deliberately NOT a merge: the terminal-header quick-pick (variables-panel.js) and the right-click
// Variables submenu (terminal-context-menu.js) keep their own design and are untouched.
//
// No value preview. `list-saved-variables` serializes without the value (`includeValue = false` in
// src/app/variables.js), and that is the right default — the renderer has no business holding a
// secret's plaintext. Rows show the name, the scope group and a secret marker.
//
// SECURITY: Enter never TYPES a plaintext secret. It goes through the same main-process path the other
// two pickers use — `resolveVariableInsert` returns an insert template (raw value, temp-file path or a
// shell ref). The one exception is main's own consent path: for shells with no inline-ref support it
// answers `{fallback:'copy', value}`, and that value IS plaintext in the renderer for the length of a
// clipboard write. Identical to what the context menu and the quick-pick already do.
//
// Free globals it reaches for, all at CALL time, so tag order does not decide them — guarded anyway:
//   `pasteIntoTerminal`, `closeTerminalContextMenu`, `closeSelectionBar` (terminal-context-menu.js)
//   `sessionMap` (app.js) · `escapeHtml` (lib/utils.js)
//   `window.showControlToast` (dialogs/control-dialogs.js) · `window.openVariablesTab` (app.js)
//   `window.api.listSavedVariables` / `.resolveVariableInsert` / `.writeClipboard` (preload.js)
//
// Callers into this file: terminal-manager.js — the hotkey (`openVariablePalette`), destroySession
// (`closeVariablePaletteForSession`) — app.js's setActiveSession, and grid-view.js's toggleGridView
// and showGridView (all three `closeVariablePalette`). The last two are there because the palette is
// anchored to ONE terminal's rectangle and a view change moves it out from under the anchor.
//
// `closeVariablePaletteForSession` is called by terminal-manager.js's destroySession, beside the two
// existing teardowns: this palette holds the terminal, so it has to close before the xterm is disposed.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // --- Pure logic (unit-tested in test/variable-palette.test.js) ---

  // Case-insensitive substring over the NAME, order preserved. A blank query keeps everything, so
  // opening the palette shows the full list rather than nothing.
  function filterVariables(rows, query) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    const q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return list;
    return list.filter(v => String(v.name || '').toLowerCase().includes(q));
  }

  // Move the highlight by `delta`, wrapping at both ends. An empty list has no highlight (-1), which
  // is what keeps Enter from inserting anything when nothing matches.
  function nextIndex(current, count, delta) {
    if (!count || count < 1) return -1;
    const from = Number.isInteger(current) && current >= 0 ? current : 0;
    return ((from + delta) % count + count) % count;
  }

  // Global first, then project — the same order the other pickers use.
  function groupForList(rows) {
    const global = rows.filter(v => v.scope !== 'project');
    const project = rows.filter(v => v.scope === 'project');
    return [
      { key: 'global', label: 'Global', vars: global },
      { key: 'project', label: 'Project', vars: project },
    ].filter(g => g.vars.length);
  }

  // The list the arrow keys walk MUST be the list the eye reads. The rows arrive sorted by name with
  // the scopes interleaved, while the groups render global-then-project — so walking the raw order
  // made the highlight jump around the screen. Everything downstream uses this flattened order.
  function displayOrder(rows) {
    return groupForList(rows).flatMap(g => g.vars);
  }

  // --- The palette itself ---

  let palette = null;      // the live element, or null
  let paletteState = null; // { rows, shown, index, terminal, sessionId }
  // Ctrl/Cmd+Shift+V fires a native paste alongside the keydown that opens us. terminal-manager
  // already swallows that paste for the TERMINAL, but the filter input now holds the focus, so the
  // clipboard landed in the query box instead. Swallow exactly the one paste the opening chord
  // caused; a deliberate paste into the filter afterwards still works.
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

  // Coming back to the window (Alt-Tab back, closing DevTools) does not necessarily put the caret
  // back in the filter — and every key handler hangs off it, so the palette would be open and
  // keyboard-dead. Take the focus back.
  function onWindowFocus() {
    if (!palette) return;
    const input = palette.querySelector('.vpal-input');
    if (input && document.activeElement !== input) input.focus();
  }

  function closeVariablePalette({ refocus = true } = {}) {
    if (!palette) return;
    document.removeEventListener('mousedown', onOutsideClick, true);
    window.removeEventListener('focus', onWindowFocus);
    window.removeEventListener('resize', onWindowResize);
    palette.remove();
    palette = null;
    const term = paletteState && paletteState.terminal;
    paletteState = null;
    if (refocus && term) { try { term.focus(); } catch {} }
  }

  function onOutsideClick(event) {
    if (palette && !palette.contains(event.target)) closeVariablePalette();
  }

  // The anchor is the terminal's rectangle, which moves with the window.
  function onWindowResize() {
    if (palette && paletteState) position(paletteState.terminal);
  }

  // Called from destroySession: the palette holds the terminal for its insert, so it must go before
  // the xterm is disposed — otherwise it floats over the app pointing at a dead instance.
  function closeVariablePaletteForSession(sessionId) {
    if (paletteState && paletteState.sessionId === sessionId) closeVariablePalette({ refocus: false });
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

  // Falls back to the viewport if xterm has no element yet — the palette must still be reachable,
  // just less precisely placed.
  function position(terminal) {
    let rect = null;
    try { rect = terminal && terminal.element && terminal.element.getBoundingClientRect(); } catch {}
    if (!rect || !rect.width || !rect.height) {
      rect = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    }
    const g = paletteGeometry(rect, window.innerHeight);
    palette.style.position = 'fixed';
    palette.style.left = g.left + 'px';
    palette.style.width = g.width + 'px';
    palette.style.top = g.top + 'px';
    palette.style.height = g.height + 'px';
  }

  // Position-based, not id-based: sanitising an id into a DOM id can collapse two distinct ids onto
  // one, and a duplicate id makes aria-activedescendant point at whichever came first.
  function rowId(i) {
    return 'vpal-row-' + i;
  }

  function rowHtml(variable, i, active) {
    return `
      <div class="vpal-row${active ? ' active' : ''}" id="${rowId(i)}" data-id="${esc(variable.id)}" role="option" aria-selected="${active ? 'true' : 'false'}">
        <span class="vpal-name">${esc(variable.name)}</span>
        ${variable.secret ? '<span class="vpal-secret">secret</span>' : ''}
      </div>`;
  }

  // The status line lives OUTSIDE the listbox: a listbox may own options only, and a "Loading…" or
  // "no match" node in there is either dropped or read out as a choosable row.
  // PLAIN TEXT ONLY. One of the callers below puts the user's own query in this line, so an
  // innerHTML here is a single careless caller away from being an XSS sink — CodeQL flagged the
  // path even though every present caller escapes. textContent cannot be talked into markup, which
  // means the next caller cannot get it wrong either.
  function setStatus(text) {
    const el = palette.querySelector('.vpal-status');
    el.textContent = text || '';
    el.style.display = text ? '' : 'none';
  }

  // The one message that wants markup in the middle of it — a <kbd> around the key to press. It
  // builds the element instead of writing a string, so the exception does not reopen the sink.
  function setStatusWithKey(before, key, after) {
    const el = palette.querySelector('.vpal-status');
    const kbd = document.createElement('kbd');
    kbd.textContent = key;
    el.replaceChildren(before, kbd, after);
    el.style.display = '';
  }

  function renderList() {
    const listEl = palette.querySelector('.vpal-list');
    const countEl = palette.querySelector('.vpal-count');
    const { rows, shown, index } = paletteState;
    // A "0" while the rows are still in flight reads as "you have none", which is the one thing it
    // does not mean.
    countEl.textContent = (!paletteState.loaded || paletteState.failed) ? ''
      : shown.length === rows.length ? String(rows.length)
      : `${shown.length} of ${rows.length}`;
    // Cleared up front: the empty branches below return early, and a stale pointer to a row that no
    // longer exists is worse for a screen reader than none. `aria-expanded` follows the same truth —
    // hard-coding it to true would claim options exist while the list says otherwise.
    const inputEl = palette.querySelector('.vpal-input');
    inputEl.removeAttribute('aria-activedescendant');
    inputEl.setAttribute('aria-expanded', shown.length ? 'true' : 'false');

    listEl.innerHTML = '';
    // Until the rows arrive, "none" means "not yet" — saying "no variables" here would be a lie, and
    // acting on it (Enter → Variables tab) actively wrong.
    if (!paletteState.loaded) { setStatus('Loading…'); return; }
    // A failed lookup is not an empty one: offering "press Enter to add some" would send the user
    // off to a tab because an IPC call happened to fail.
    if (paletteState.failed) { setStatus('Could not load variables.'); return; }
    if (!rows.length) {
      // The picker this replaced offered "No variables — manage…" as a real menu item, so the hotkey
      // must not become a dead end when there is nothing to insert (#207 / the old #89 behaviour).
      setStatusWithKey('No variables yet. Press ', 'Enter', ' to open the Variables tab.');
      return;
    }
    if (!shown.length) {
      // Stay open and keep what was typed — closing here would throw the query away.
      // No esc() — setStatus writes textContent, so escaping here would show the entities literally.
      setStatus(`No variable matches “${palette.querySelector('.vpal-input').value}”.`);
      return;
    }
    setStatus('');
    let html = '';
    let i = 0; // shown is already in render order (displayOrder), so this IS the highlight index
    for (const group of groupForList(shown)) {
      // A listbox may only contain options — the scope headings are decoration and must say so,
      // or assistive tech either drops them or reports them as choosable rows.
      html += `<div class="vpal-group" role="presentation">${esc(group.label)}</div>`;
      for (const v of group.vars) { html += rowHtml(v, i, i === index); i++; }
    }
    listEl.innerHTML = html;
    const active = listEl.querySelector('.vpal-row.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
    // The focus stays in the input, so this is the only way assistive tech learns which row is
    // highlighted — the visual highlight alone says nothing to a screen reader.
    if (active) palette.querySelector('.vpal-input').setAttribute('aria-activedescendant', active.id);
  }

  function applyFilter(query) {
    paletteState.shown = displayOrder(filterVariables(paletteState.rows, query));
    paletteState.index = paletteState.shown.length ? 0 : -1;
    renderList();
  }

  function move(delta) {
    paletteState.index = nextIndex(paletteState.index, paletteState.shown.length, delta);
    renderList();
  }

  // Insert the highlighted variable: resolved value plus ONE trailing space and no newline, so the
  // line is never submitted by accident and the next word does not run into the value.
  async function insertActive() {
    if (!paletteState.loaded || paletteState.failed) return; // in flight, or the lookup failed
    // Nothing stored at all → Enter is the way to go add some, not a no-op.
    if (!paletteState.rows.length) {
      closeVariablePalette({ refocus: false });
      window.openVariablesTab?.();
      return;
    }
    const variable = paletteState.shown[paletteState.index];
    if (!variable) return;
    const { terminal, sessionId } = paletteState;
    closeVariablePalette({ refocus: false });
    try {
      const res = await window.api.resolveVariableInsert(variable.id, sessionId);
      if (res && res.ok && typeof res.text === 'string') {
        // An empty value would insert a lone space — say so instead of pretending something happened.
        if (!res.text) {
          window.showControlToast?.({ message: `“${variable.name}” is empty`, timeoutMs: 3000 });
        } else if (typeof pasteIntoTerminal === 'function') {
          pasteIntoTerminal(terminal, sessionId, res.text + ' ');
        }
      } else if (res && res.fallback === 'copy') {
        await window.api.writeClipboard(res.value || '');
        window.showControlToast?.({ message: "Secret copied — paste manually (shell doesn't support inline refs)", timeoutMs: 3000 });
      } else {
        // A malformed/undefined result must not fail silently — same fallback the quick-pick uses.
        window.showControlToast?.({ message: res?.error || 'Could not resolve variable', timeoutMs: 3000 });
      }
    } catch { /* variable gone / decrypt failed — no-op, same as the context menu */ }
    try { terminal.focus(); } catch {}
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
    // Mid-composition Enter commits an IME candidate; it is not a request to insert a variable.
    if (event.isComposing || event.keyCode === 229) return;
    // The open chord again = close. Once the palette has the focus the terminal's handler no longer
    // sees the hotkey, so without this a second press is silently dead.
    if (typeof matchShortcut === 'function'
        && matchShortcut('insertVariable', event, typeof isMac !== 'undefined' ? isMac : false,
          typeof appShortcuts !== 'undefined' ? appShortcuts : null)) {
      claim(event);
      closeVariablePalette();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return; // a chord — not ours to interpret
    if (event.key === 'Escape') { claim(event); closeVariablePalette(); return; }
    if (event.key === 'ArrowDown') { claim(event); move(1); return; }
    if (event.key === 'ArrowUp') { claim(event); move(-1); return; }
    if (event.key === 'Enter') { claim(event); insertActive(); }
  }

  async function openVariablePalette(terminal, sessionId) {
    closeVariablePalette({ refocus: false });
    // The picker this replaced opened THROUGH the context menu, so it closed it by construction.
    // Nothing does that now — without this a right-click menu (and its selection bar) stays on
    // screen behind the palette, and its Escape handler is in the capture phase, so one Escape
    // would close both.
    if (typeof closeTerminalContextMenu === 'function') closeTerminalContextMenu();
    if (typeof closeSelectionBar === 'function') closeSelectionBar();
    const epoch = ++openEpoch;
    const projectPath = (typeof sessionMap !== 'undefined' && sessionId)
      ? (sessionMap.get(sessionId)?.projectPath || null) : null;

    palette = document.createElement('div');
    palette.className = 'popover variable-palette';
    palette.innerHTML = `
      <div class="vpal-filter">
        <span class="vpal-glyph" aria-hidden="true">⌕</span>
        <input class="vpal-input" type="text" placeholder="Filter variables…" aria-label="Filter variables" role="combobox" aria-expanded="false" aria-controls="vpal-listbox" autocomplete="off" spellcheck="false">
        <span class="vpal-count"></span>
      </div>
      <div class="vpal-status" role="status"></div>
      <div class="vpal-list" id="vpal-listbox" role="listbox" aria-label="Saved variables"></div>
      <div class="vpal-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>Enter</kbd> insert</span>
        <span><kbd>Esc</kbd> close</span>
      </div>`;
    document.body.appendChild(palette);
    position(terminal);

    paletteState = { rows: [], shown: [], index: -1, terminal, sessionId, loaded: false };
    renderList(); // paint "Loading…" now — otherwise the list is blank until the IPC returns
    const input = palette.querySelector('.vpal-input');
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
      const isListScrollbar = t === palette.querySelector('.vpal-list')
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
          palette.querySelector('.vpal-input').focus();
          return;
        }
        closeVariablePalette({ refocus: false });
      }, 0);
    });
    window.addEventListener('focus', onWindowFocus);
    window.addEventListener('resize', onWindowResize);
    // Registered NOW, not after the load: during the IPC round-trip a click outside would otherwise
    // go unnoticed, and the focus-recovery below would read it as "still working in here".
    setTimeout(() => {
      if (epoch === openEpoch && palette) document.addEventListener('mousedown', onOutsideClick, true);
    }, 0);
    swallowOpeningPaste = true;
    setTimeout(() => { swallowOpeningPaste = false; }, 0); // clear it if no paste follows
    input.focus();

    palette.querySelector('.vpal-list').addEventListener('mousedown', (event) => {
      const row = event.target.closest('.vpal-row');
      if (!row || !paletteState) return;
      event.preventDefault();
      const i = paletteState.shown.findIndex(v => v.id === row.dataset.id);
      if (i >= 0) { paletteState.index = i; insertActive(); }
    });

    let rows = [];
    let failed = false;
    try { rows = await window.api.listSavedVariables(projectPath); } catch { failed = true; }
    // Closed, or superseded by a later open — either way these rows are not ours to write.
    if (epoch !== openEpoch || !palette || !paletteState) return;
    paletteState.rows = Array.isArray(rows) ? rows.filter(Boolean) : [];
    paletteState.failed = failed || !Array.isArray(rows);
    paletteState.loaded = true;
    applyFilter(input.value);
    position(terminal);
  }

  return {
    filterVariables, nextIndex, groupForList, displayOrder, paletteGeometry,
    openVariablePalette, closeVariablePalette, closeVariablePaletteForSession,
  };
});
