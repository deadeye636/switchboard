// --- Plan palette: the keyboard-driven plan picker on the insertPlan hotkey (#453) ---
//
// Handing a plan to a running CLI meant finding the file in the sidebar, copying its path and typing a
// sentence around it. The app knows the plans and knows which project the terminal belongs to, so this is
// two keystrokes.
//
// Deliberately the SAME shape as the saved-variable palette (#207): anchored to the lower half of its
// terminal, filter focused on open, arrows move, Enter inserts, Escape closes. Someone who knows one
// knows the other, and the geometry, the focus recovery and the outside-click rules there were paid for
// in bugs — a second, subtly different popover would have to pay for them again. It reuses that palette's
// CSS classes for the same reason a new control reuses an existing button class: a picker with its own
// stylesheet drifts from the one beside it.
//
// What it inserts is a REFERENCE, never the plan itself. A plan runs to hundreds of lines; it belongs in
// the agent's context through the agent's own file tools, not pasted into a prompt.
//
// Free globals it reaches for, all at CALL time so tag order does not decide them — guarded anyway:
//   `insertResolvedText`, `closeTerminalContextMenu`, `closeSelectionBar` (terminal-context-menu.js)
//   `sessionMap` (app.js) · `escapeHtml` (lib/utils.js) · `matchShortcut`, `isMac`, `appShortcuts`
//   (shell/shortcuts.js) · `window.showControlToast` (dialogs/control-dialogs.js)
//   `window.api.getPlans` / `.getEffectiveSettings` (preload.js)
//
// Callers into this file: terminal-manager.js — the hotkey (`openPlanPalette`) and destroySession
// (`closePlanPaletteForSession`) — and app.js's setActiveSession (`closePlanPalette`), because the
// palette is anchored to ONE terminal's rectangle and a session switch moves it out from under the anchor.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // --- Pure logic (unit-tested in test/plan-palette.test.js) ---

  const DEFAULT_PLAN_INSERT_TEMPLATE = 'Follow the plan at {path}';

  /**
   * Case-insensitive substring over the title AND the filename.
   *
   * Both, because the two answer different questions: the title is what the plan is about, the filename
   * is what a generated slug happens to be called — and the slug is the only handle someone has who saw
   * the file on disk rather than in this list.
   */
  function filterPlans(rows, query) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    const q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return list;
    return list.filter(p => String(p.title || '').toLowerCase().includes(q)
      || String(p.filename || '').toLowerCase().includes(q));
  }

  /** Move the highlight by `delta`, wrapping. An empty list has no highlight, so Enter inserts nothing. */
  function nextIndex(current, count, delta) {
    if (!count || count < 1) return -1;
    const from = Number.isInteger(current) && current >= 0 ? current : 0;
    return ((from + delta) % count + count) % count;
  }

  /**
   * The groups, in the order they are drawn: this terminal's project first, then every other project,
   * then the plans nothing could be attributed to.
   *
   * This project first is the whole point of the picker — someone reaching for a plan while a session
   * runs wants that session's plan, and any other order makes them hunt for it. The rest stay reachable
   * rather than being filtered away: a plan written in one project is often exactly what you want to hand
   * to another, and a plan whose session is gone is still a plan.
   */
  function groupForList(rows, projectPath) {
    const mine = [];
    const others = new Map();
    const orphans = [];
    for (const plan of rows) {
      if (!plan) continue;
      if (!plan.projectPath) { orphans.push(plan); continue; }
      if (projectPath && plan.projectPath === projectPath) { mine.push(plan); continue; }
      if (!others.has(plan.projectPath)) others.set(plan.projectPath, []);
      others.get(plan.projectPath).push(plan);
    }
    const label = (plan) => plan.displayName || plan.shortName || plan.projectPath;
    const groups = [];
    if (mine.length) groups.push({ key: 'project', label: 'This project', plans: mine });
    // `proj:` and not `p:` — a one-letter prefix in front of a path is indistinguishable from a Windows
    // drive letter, to a reader and to anything that scans for paths.
    for (const [path, plans] of others) groups.push({ key: 'proj:' + path, label: label(plans[0]), plans });
    if (orphans.length) groups.push({ key: 'orphans', label: 'No session on record', plans: orphans });
    return groups;
  }

  // The list the arrow keys walk MUST be the list the eye reads — the rows arrive sorted by date while
  // the groups render project-first, so walking the raw order would make the highlight jump around.
  function displayOrder(rows, projectPath) {
    return groupForList(rows, projectPath).flatMap(g => g.plans);
  }

  /**
   * The text that goes into the prompt.
   *
   * A template rather than a fixed sentence, for the same reason a saved variable has one: what a CLI
   * should be told about a plan is a matter of taste and of which CLI it is. A template that resolves to
   * nothing falls back to the default — a hotkey that inserts an empty string is indistinguishable from
   * one that is broken.
   */
  function planInsertText(plan, template) {
    if (!plan) return '';
    const raw = (typeof template === 'string' && template.trim()) ? template : DEFAULT_PLAN_INSERT_TEMPLATE;
    const text = raw
      .replace(/\{path\}/g, plan.filePath || '')
      .replace(/\{title\}/g, plan.title || '')
      .replace(/\{filename\}/g, plan.filename || '');
    return text.trim() ? text : (plan.filePath || '');
  }

  // --- The palette itself ---

  let palette = null;
  let paletteState = null;  // { rows, shown, index, terminal, sessionId, projectPath, template, loaded }
  let openEpoch = 0;
  let lastInsideMouseDown = 0;

  function esc(value) {
    return typeof escapeHtml === 'function' ? escapeHtml(String(value ?? '')) : String(value ?? '');
  }

  function onWindowFocus() {
    if (!palette) return;
    const input = palette.querySelector('.vpal-input');
    if (input && document.activeElement !== input) input.focus();
  }

  function closePlanPalette({ refocus = true } = {}) {
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
    if (palette && !palette.contains(event.target)) closePlanPalette();
  }

  function onWindowResize() {
    if (palette && paletteState) position(paletteState.terminal);
  }

  /** The palette holds the terminal for its insert, so it must go before the xterm is disposed. */
  function closePlanPaletteForSession(sessionId) {
    if (paletteState && paletteState.sessionId === sessionId) closePlanPalette({ refocus: false });
  }

  // The geometry is the variable palette's, called through rather than copied: two popovers that place
  // themselves by almost the same rule is how they end up placing themselves by different ones.
  function position(terminal) {
    let rect = null;
    try { rect = terminal && terminal.element && terminal.element.getBoundingClientRect(); } catch {}
    if (!rect || !rect.width || !rect.height) {
      rect = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    }
    const g = window.paletteGeometry(rect, window.innerHeight);
    palette.style.position = 'fixed';
    palette.style.left = g.left + 'px';
    palette.style.width = g.width + 'px';
    palette.style.top = g.top + 'px';
    palette.style.height = g.height + 'px';
  }

  function rowId(i) { return 'ppal-row-' + i; }

  function rowHtml(plan, i, active) {
    return `
      <div class="vpal-row${active ? ' active' : ''}" id="${rowId(i)}" data-path="${esc(plan.filePath)}" role="option" aria-selected="${active ? 'true' : 'false'}">
        <span class="vpal-name">${esc(plan.title || plan.filename)}</span>
        <span class="vpal-secret ppal-file">${esc(plan.filename)}</span>
      </div>`;
  }

  // PLAIN TEXT ONLY — one caller below puts the user's own query in here.
  function setStatus(text) {
    const el = palette.querySelector('.vpal-status');
    el.textContent = text || '';
    el.style.display = text ? '' : 'none';
  }

  function renderList() {
    const listEl = palette.querySelector('.vpal-list');
    const countEl = palette.querySelector('.vpal-count');
    const { rows, shown, index } = paletteState;
    countEl.textContent = (!paletteState.loaded || paletteState.failed) ? ''
      : shown.length === rows.length ? String(rows.length)
        : `${shown.length} of ${rows.length}`;

    const inputEl = palette.querySelector('.vpal-input');
    inputEl.removeAttribute('aria-activedescendant');
    inputEl.setAttribute('aria-expanded', shown.length ? 'true' : 'false');

    listEl.innerHTML = '';
    // "None" means "not yet" until the rows arrive; saying "no plans" here would be a lie.
    if (!paletteState.loaded) { setStatus('Loading…'); return; }
    if (paletteState.failed) { setStatus('Could not load plans.'); return; }
    if (!rows.length) { setStatus('No plans yet.'); return; }
    if (!shown.length) {
      // Stay open and keep what was typed — closing would throw the query away.
      setStatus(`No plan matches “${inputEl.value}”.`);
      return;
    }
    setStatus('');
    let html = '';
    let i = 0; // `shown` is already in render order, so this IS the highlight index
    for (const group of groupForList(shown, paletteState.projectPath)) {
      // A listbox may own options only — a heading has to say it is decoration.
      html += `<div class="vpal-group" role="presentation">${esc(group.label)}</div>`;
      for (const p of group.plans) { html += rowHtml(p, i, i === index); i++; }
    }
    listEl.innerHTML = html;
    const active = listEl.querySelector('.vpal-row.active');
    if (active) {
      active.scrollIntoView({ block: 'nearest' });
      inputEl.setAttribute('aria-activedescendant', active.id);
    }
  }

  function applyFilter(query) {
    paletteState.shown = displayOrder(filterPlans(paletteState.rows, query), paletteState.projectPath);
    paletteState.index = paletteState.shown.length ? 0 : -1;
    renderList();
  }

  function move(delta) {
    paletteState.index = nextIndex(paletteState.index, paletteState.shown.length, delta);
    renderList();
  }

  /** Insert the highlighted plan's reference, plus one trailing space and no newline — never submitted. */
  function insertActive() {
    if (!paletteState || !paletteState.loaded || paletteState.failed) return;
    const plan = paletteState.shown[paletteState.index];
    if (!plan) return;
    const { terminal, sessionId, template } = paletteState;
    closePlanPalette({ refocus: false });
    const text = planInsertText(plan, template);
    if (text && typeof insertResolvedText === 'function') {
      insertResolvedText(terminal, sessionId, text, { trailing: ' ' });
    }
    try { terminal.focus(); } catch {}
  }

  // While the palette is open its keys are ITS keys — otherwise the document-level handler in app.js
  // still sees them and grid move mode steps a card on the same arrow that moves the highlight.
  function claim(event) {
    event.preventDefault();
    event.stopPropagation();
    event._handled = true;
  }

  function onKey(event) {
    if (event.isComposing || event.keyCode === 229) return;
    // The open chord again = close. Once the palette holds the focus the terminal's handler no longer
    // sees the hotkey, so without this a second press is silently dead.
    if (typeof matchShortcut === 'function'
        && matchShortcut('insertPlan', event, typeof isMac !== 'undefined' ? isMac : false,
          typeof appShortcuts !== 'undefined' ? appShortcuts : null)) {
      claim(event);
      closePlanPalette();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return; // a chord — not ours to interpret
    if (event.key === 'Escape') { claim(event); closePlanPalette(); return; }
    if (event.key === 'ArrowDown') { claim(event); move(1); return; }
    if (event.key === 'ArrowUp') { claim(event); move(-1); return; }
    if (event.key === 'Enter') { claim(event); insertActive(); }
  }

  async function openPlanPalette(terminal, sessionId) {
    closePlanPalette({ refocus: false });
    if (typeof closeTerminalContextMenu === 'function') closeTerminalContextMenu();
    if (typeof closeSelectionBar === 'function') closeSelectionBar();
    const epoch = ++openEpoch;
    const projectPath = (typeof sessionMap !== 'undefined' && sessionId)
      ? (sessionMap.get(sessionId)?.projectPath || null) : null;

    palette = document.createElement('div');
    palette.className = 'popover variable-palette plan-palette';
    palette.innerHTML = `
      <div class="vpal-filter">
        <span class="vpal-glyph" aria-hidden="true">⌕</span>
        <input class="vpal-input" type="text" placeholder="Filter plans…" aria-label="Filter plans" role="combobox" aria-expanded="false" aria-controls="ppal-listbox" autocomplete="off" spellcheck="false">
        <span class="vpal-count"></span>
      </div>
      <div class="vpal-status" role="status"></div>
      <div class="vpal-list" id="ppal-listbox" role="listbox" aria-label="Plans"></div>
      <div class="vpal-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>Enter</kbd> insert</span>
        <span><kbd>Esc</kbd> close</span>
      </div>`;
    document.body.appendChild(palette);
    position(terminal);

    paletteState = { rows: [], shown: [], index: -1, terminal, sessionId, projectPath, template: null, loaded: false };
    renderList(); // paint "Loading…" now — the list would otherwise be blank until the IPC returns
    const input = palette.querySelector('.vpal-input');
    input.addEventListener('keydown', onKey);
    input.addEventListener('input', () => applyFilter(input.value));

    palette.addEventListener('mousedown', (event) => {
      lastInsideMouseDown = Date.now();
      if (event.target === input) return;
      const t = event.target;
      const isListScrollbar = t === palette.querySelector('.vpal-list')
        && t.scrollHeight > t.clientHeight
        && event.offsetX > t.clientWidth;
      if (!isListScrollbar) event.preventDefault();
    });
    // Every key handler hangs off the input, so a real focus loss would strand the palette open with no
    // keyboard way out — Escape included. Only a REAL one: an Alt-Tab must not close it, and a scrollbar
    // grab drops the focus to <body> without the user having left.
    input.addEventListener('focusout', () => {
      setTimeout(() => {
        if (!palette || !document.hasFocus()) return;
        if (palette.contains(document.activeElement)) return;
        if (document.activeElement === document.body && Date.now() - lastInsideMouseDown < 500) {
          palette.querySelector('.vpal-input').focus();
          return;
        }
        closePlanPalette({ refocus: false });
      }, 0);
    });
    window.addEventListener('focus', onWindowFocus);
    window.addEventListener('resize', onWindowResize);
    setTimeout(() => {
      if (epoch === openEpoch && palette) document.addEventListener('mousedown', onOutsideClick, true);
    }, 0);
    input.focus();

    palette.querySelector('.vpal-list').addEventListener('mousedown', (event) => {
      const row = event.target.closest('.vpal-row');
      if (!row || !paletteState) return;
      event.preventDefault();
      const i = paletteState.shown.findIndex(p => p.filePath === row.dataset.path);
      if (i >= 0) { paletteState.index = i; insertActive(); }
    });

    let rows = [];
    let template = null;
    let failed = false;
    try {
      // Both at once: the template is a setting, the plans are a disk read, and neither waits on the other.
      const [plansRes, settings] = await Promise.all([
        window.api.getPlans(),
        window.api.getEffectiveSettings ? window.api.getEffectiveSettings(projectPath) : Promise.resolve(null),
      ]);
      rows = (plansRes && plansRes.plans) || [];
      template = settings && settings.planInsertTemplate;
    } catch { failed = true; }
    // Closed, or superseded by a later open — either way these rows are not ours to write.
    if (epoch !== openEpoch || !palette || !paletteState) return;
    paletteState.rows = Array.isArray(rows) ? rows.filter(Boolean) : [];
    paletteState.failed = failed || !Array.isArray(rows);
    paletteState.template = template;
    paletteState.loaded = true;
    applyFilter(input.value);
    position(terminal);
  }

  return {
    filterPlans, nextIndex, groupForList, displayOrder, planInsertText, DEFAULT_PLAN_INSERT_TEMPLATE,
    openPlanPalette, closePlanPalette, closePlanPaletteForSession,
  };
});
