// --- Terminal right-click context menu ---
//
// xterm's built-in `contextmenu` handler (rightClickHandler in @xterm/xterm)
// moves the hidden helper textarea under the cursor and fills it with the
// current selection — on Linux this surfaces as a stray "paste" into the
// prompt. xterm's link service also fires link `activate` on ANY mouseup
// (no button guard), so a right-click over a file link re-opens it. We
// intercept `contextmenu` in capture phase (see setupTerminalContextMenu in
// terminal-manager.js) so neither default runs, then apply the user's chosen
// behavior.
//
// Behavior is gated by the global `terminalRightClickMode`, persisted as the
// `terminalRightClick` global setting and pushed live via
// window._applyTerminalRightClick:
//   'menu'       → show this context menu (default)
//   'copy-paste' → copy the selection, or paste when nothing is selected
//   'copy'       → copy the selection (no paste)
//   'paste'      → right-click pastes the clipboard (PuTTY-style), no menu
//   'default'    → leave xterm's native right-click behavior untouched
//   'none'       → right-click does nothing
//
// Depends on globals: openFileInPanel (file-panel.js), window.api.
// Pure helpers (fileUriToPath / classifyLinkUri / buildTerminalMenuItems) are
// unit-tested; showTerminalContextMenu does the DOM rendering.

let terminalRightClickMode = 'menu';

// Convert a file:// URI to a filesystem path, or null if it isn't one.
function fileUriToPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
  try {
    let p = decodeURIComponent(new URL(uri).pathname);
    // Windows: URL().pathname keeps a leading slash before the drive letter
    // ("/D:/x"); strip it so shell.openPath/execFile get a valid path. Mirrors
    // openTerminalFileUri in terminal-manager.js — without it "Open in system
    // editor" / "Copy path" silently failed on Windows (#69).
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    return p;
  } catch {
    return null;
  }
}

// Classify the link (if any) under the cursor into the actions we can offer.
function classifyLinkUri(uri) {
  if (typeof uri !== 'string' || !uri) return { kind: null };
  if (uri.startsWith('file://')) {
    const path = fileUriToPath(uri);
    return path ? { kind: 'file', path } : { kind: null };
  }
  if (/^https?:\/\//i.test(uri)) return { kind: 'url', url: uri };
  return { kind: null };
}

// Build the ordered list of menu items for a right-click. Returns an array of
// entries; a `null` entry marks a separator. An entry may carry `children` (a
// nested item array) to render a flyout submenu. Pure — the caller
// (runTerminalMenuAction) maps each leaf id to an effect.
//
// `isBookmarked` toggles the bookmark label add↔remove. `variableGroups` (when
// provided as an array of { key, label, vars:[{id,name,secret}] }) appends the
// Variables submenu; omit it (null) to leave the menu unchanged (e.g. tests).
function buildTerminalMenuItems({ linkUri, hasSelection, variableGroups = null, externalEditor = false }) {
  const items = [];
  const link = classifyLinkUri(linkUri);
  if (link.kind === 'file') {
    items.push({ id: 'open-panel', label: 'Open in panel' });
    items.push({ id: 'open-system', label: 'Open in system editor' });
    if (externalEditor) items.push({ id: 'open-editor', label: 'Open in external editor' });
    items.push({ id: 'copy-path', label: 'Copy path' });
  } else if (link.kind === 'url') {
    items.push({ id: 'open-browser', label: 'Open in browser' });
    items.push({ id: 'copy-link', label: 'Copy link' });
  }
  if (items.length) items.push(null); // separator before the generic actions
  if (hasSelection) items.push({ id: 'copy', label: 'Copy' });
  items.push({ id: 'paste', label: 'Paste' });
  items.push({ id: 'select-all', label: 'Select all' });
  items.push(null);
  items.push({ id: 'create-task', label: 'Create task' });
  if (Array.isArray(variableGroups)) {
    const children = [];
    for (const group of variableGroups) {
      if (!group || !group.vars || !group.vars.length) continue;
      children.push({
        id: `varscope:${group.key}`,
        label: group.label,
        children: group.vars.map(v => ({
          id: `insert-variable:${v.id}`,
          label: v.secret ? `${v.name}  ·secret` : v.name,
        })),
      });
    }
    if (children.length) {
      children.push(null);
      children.push({ id: 'manage-variables', label: 'Manage variables…' });
      items.push(null); // separator before the Variables submenu
      items.push({ id: 'variables', label: 'Variables', children });
    }
  }
  return items;
}

// Paste `text` into the terminal. For a MULTILINE paste while the program has
// bracketed-paste mode on (e.g. Claude Code), send the bracketed sequence
// ourselves with \n preserved. xterm's terminal.paste() normalizes every newline
// to \r, which makes a pasted multiline block render as one wrapping unit that
// merges lines on resize (a real terminal keeps \n). Single-line pastes and
// non-bracketed programs fall back to terminal.paste() unchanged.
function pasteIntoTerminal(terminal, sessionId, text) {
  if (typeof text !== 'string' || !text) return;
  const bracketed = !!(terminal && terminal.modes && terminal.modes.bracketedPasteMode);
  if (bracketed && sessionId && /[\r\n]/.test(text)) {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    window.api.sendInput(sessionId, '\x1b[200~' + normalized + '\x1b[201~');
    return;
  }
  if (terminal && typeof terminal.paste === 'function') terminal.paste(text);
}

// Fetch saved variables for the session's project and group them by scope for
// the Variables submenu. Returns [] on any error (submenu then shows Manage only).
async function fetchVariableGroups(projectPath) {
  let rows;
  try { rows = await window.api.listSavedVariables(projectPath || null); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  const project = rows.filter(r => r.scope === 'project');
  const global = rows.filter(r => r.scope !== 'project');
  const groups = [];
  if (global.length) groups.push({ key: 'global', label: 'Global', vars: global });
  if (project.length) groups.push({ key: 'project', label: 'Project', vars: project });
  return groups;
}

// Execute the effect for a chosen menu item.
async function runTerminalMenuAction(id, ctx) {
  const { terminal, sessionId, linkUri } = ctx;
  const link = classifyLinkUri(linkUri);
  if (id === 'manage-variables') {
    window.openVariablesTab?.();
    return;
  }
  if (typeof id === 'string' && id.startsWith('insert-variable:')) {
    const varId = id.slice('insert-variable:'.length);
    try {
      // SECURITY: never type a secret's plaintext. Main resolves the insert-
      // template (raw value, temp-file path, or shell ref) and reads the shell
      // family off the session itself; fall back to clipboard for shells
      // without inline-ref support.
      const res = await window.api.resolveVariableInsert(varId, sessionId);
      if (res && res.ok && typeof res.text === 'string') {
        pasteIntoTerminal(terminal, sessionId, res.text);
      } else if (res && res.fallback === 'copy') {
        await window.api.writeClipboard(res.value || '');
        window.showControlToast?.({ message: "Secret copied — paste manually (shell doesn't support inline refs)", timeoutMs: 3000 });
      }
    } catch { /* variable gone / decrypt failed — no-op */ }
    try { terminal.focus(); } catch {}
    return;
  }
  switch (id) {
    case 'open-panel':
      if (link.kind === 'file' && typeof openFileInPanel === 'function') {
        openFileInPanel(sessionId, link.path);
      }
      break;
    case 'open-system':
      if (link.kind === 'file') window.api.openPath(link.path);
      break;
    case 'open-editor':
      if (link.kind === 'file') window.api.openInEditor(link.path);
      break;
    case 'copy-path':
      if (link.kind === 'file') window.api.writeClipboard(link.path);
      break;
    case 'open-browser':
      if (link.kind === 'url') window.api.openExternal(link.url);
      break;
    case 'copy-link':
      if (link.kind === 'url') window.api.writeClipboard(link.url);
      break;
    case 'copy':
      if (terminal.hasSelection()) window.api.writeClipboard(terminal.getSelection());
      break;
    case 'paste':
      try {
        const text = await window.api.readClipboard();
        if (text) pasteIntoTerminal(terminal, sessionId, text);
      } catch { /* clipboard unavailable — no-op */ }
      break;
    case 'select-all':
      terminal.selectAll();
      break;
    case 'create-task':
      if (window.tasksView) {
        // No selection → a plain session task; with a selection → include the quote.
        window.tasksView.createFromSource({ sessionId, quote: terminal.hasSelection() ? terminal.getSelection() : undefined });
      }
      break;
  }
  // Restore focus to the terminal for in-terminal actions — the menu button
  // took focus and the right-click never focused the terminal itself.
  if (id === 'paste' || id === 'copy' || id === 'select-all') {
    try { terminal.focus(); } catch {}
  }
}

// --- Menu DOM (single instance at a time) ---
let activeTerminalMenu = null;
let activeTerminalMenuSessionId = null;

function onTerminalMenuClickOutside(e) {
  if (activeTerminalMenu && !activeTerminalMenu.contains(e.target)) closeTerminalContextMenu();
}
function onTerminalMenuKey(e) {
  if (e.key === 'Escape') closeTerminalContextMenu();
}

function closeTerminalContextMenu() {
  if (activeTerminalMenu) {
    activeTerminalMenu.remove();
    activeTerminalMenu = null;
    activeTerminalMenuSessionId = null;
  }
  document.removeEventListener('mousedown', onTerminalMenuClickOutside, true);
  document.removeEventListener('keydown', onTerminalMenuKey, true);
}

// Close the menu if it belongs to a session being torn down — otherwise its
// button closures would call paste()/selectAll() on a disposed xterm instance.
// Called from destroySession (terminal-manager.js).
function closeTerminalContextMenuForSession(sessionId) {
  if (activeTerminalMenu && activeTerminalMenuSessionId === sessionId) closeTerminalContextMenu();
}

// Render items into a container, recursing into `children` as flyout submenus.
// Submenu parents are divs (not buttons) so they can hold a nested popover; leaf
// entries are buttons. Show/hide is pure CSS (:hover/:focus-within).
// Show `sub` next to its parent option, clamped inside the viewport: open to the
// right by default, flip left if it would overflow, and shift up off the bottom.
function openSubmenu(parentEl, sub) {
  sub.style.position = 'fixed';
  sub.style.display = 'block';
  const pr = parentEl.getBoundingClientRect();
  const sw = sub.offsetWidth;
  const sh = sub.offsetHeight;
  let left = pr.right - 2;
  if (left + sw > window.innerWidth - 2) left = pr.left - sw + 2; // flip leftward
  if (left < 2) left = 2;
  let top = pr.top - 4;
  if (top + sh > window.innerHeight - 2) top = Math.max(2, window.innerHeight - sh - 2);
  sub.style.left = left + 'px';
  sub.style.top = top + 'px';
}

function closeSubmenu(sub) {
  sub.style.display = 'none';
  // Reset any nested flyouts so they don't reappear without a fresh hover.
  sub.querySelectorAll('.terminal-context-submenu').forEach(s => { s.style.display = 'none'; });
}

function renderMenuItems(container, items, ctx) {
  for (const item of items) {
    if (item === null) {
      const sep = document.createElement('div');
      sep.className = 'popover-separator';
      container.appendChild(sep);
      continue;
    }
    if (item.children && item.children.length) {
      const parent = document.createElement('div');
      parent.className = 'popover-option has-submenu';
      parent.setAttribute('tabindex', '0');
      const label = document.createElement('span');
      label.textContent = item.label;
      const arrow = document.createElement('span');
      arrow.className = 'submenu-arrow';
      arrow.textContent = '›';
      parent.appendChild(label);
      parent.appendChild(arrow);
      const sub = document.createElement('div');
      sub.className = 'popover terminal-context-submenu';
      renderMenuItems(sub, item.children, ctx);
      parent.appendChild(sub);
      // Position the flyout in JS so it stays inside the viewport (pure-CSS
      // left:100% runs off-screen near the edges). mouseleave doesn't fire when
      // moving into `sub` (a DOM descendant), so open-on-enter/close-on-leave is
      // enough. `sub` is position:fixed, so it isn't clipped by any ancestor.
      parent.addEventListener('mouseenter', () => openSubmenu(parent, sub));
      parent.addEventListener('focusin', () => openSubmenu(parent, sub));
      parent.addEventListener('mouseleave', () => closeSubmenu(sub));
      container.appendChild(parent);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = 'popover-option';
    btn.textContent = item.label;
    btn.addEventListener('click', () => {
      closeTerminalContextMenu();
      runTerminalMenuAction(item.id, ctx);
    });
    container.appendChild(btn);
  }
}

// Clamp the menu inside the viewport and pick the submenu open-direction.
function positionTerminalMenu(menu, px, py) {
  menu.style.position = 'fixed';
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let x = px;
  let y = py;
  if (x + mw > window.innerWidth) x = Math.max(0, window.innerWidth - mw - 4);
  if (y + mh > window.innerHeight) y = Math.max(0, window.innerHeight - mh - 4);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

function showTerminalContextMenu(event, ctx) {
  closeTerminalContextMenu();
  const hasSelection = !!(ctx.terminal && ctx.terminal.hasSelection && ctx.terminal.hasSelection());
  const sessionId = ctx.sessionId;
  const projectPath = ctx.projectPath
    || (typeof sessionMap !== 'undefined' && sessionId ? (sessionMap.get(sessionId)?.projectPath || null) : null);
  const fullCtx = { ...ctx, projectPath };
  // Offer "Open in external editor" only when the user has configured one (#69).
  const externalEditor = typeof appGlobalSettings !== 'undefined'
    && !!(appGlobalSettings.externalEditorCommand && String(appGlobalSettings.externalEditorCommand).trim());

  // Synchronous base render; the bookmark toggle label and Variables submenu are
  // filled in a tick later once their DB lookups resolve (enhanceTerminalMenu).
  const menu = document.createElement('div');
  menu.className = 'popover terminal-context-menu';
  renderMenuItems(menu, buildTerminalMenuItems({ linkUri: ctx.linkUri, hasSelection, externalEditor }), fullCtx);
  document.body.appendChild(menu);
  positionTerminalMenu(menu, event.clientX, event.clientY);

  activeTerminalMenu = menu;
  activeTerminalMenuSessionId = ctx.sessionId;
  // Defer listener registration so the originating event doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('mousedown', onTerminalMenuClickOutside, true);
    document.addEventListener('keydown', onTerminalMenuKey, true);
  }, 0);

  enhanceTerminalMenu(menu, fullCtx, { hasSelection, linkUri: ctx.linkUri, externalEditor, x: event.clientX, y: event.clientY });
}

// Fill in the Variables submenu once the async DB lookup resolves, if the same
// menu is still open. No-op when there are no variables (e.g. the api bindings
// are absent under test).
async function enhanceTerminalMenu(menu, ctx, base) {
  let variableGroups = [];
  try {
    variableGroups = await fetchVariableGroups(ctx.projectPath);
  } catch { return; }
  if (activeTerminalMenu !== menu) return; // closed or replaced while awaiting
  const hasVars = Array.isArray(variableGroups) && variableGroups.some(g => g && g.vars && g.vars.length);
  if (!hasVars) return;
  menu.replaceChildren();
  renderMenuItems(menu, buildTerminalMenuItems({
    linkUri: base.linkUri, hasSelection: base.hasSelection, externalEditor: base.externalEditor, variableGroups,
  }), ctx);
  positionTerminalMenu(menu, base.x, base.y);
}

// --- Variable-insert picker (hotkey, #89) ---
// Best-effort caret pixel point for the picker; falls back to the terminal
// element center, then the viewport center. Reads xterm internals defensively.
function terminalCaretPoint(terminal) {
  try {
    const el = terminal.element;
    const rect = el.getBoundingClientRect();
    const dims = terminal._core && terminal._core._renderService && terminal._core._renderService.dimensions;
    const cell = dims && (dims.css ? dims.css.cell : dims);
    const buf = terminal.buffer && terminal.buffer.active;
    if (rect && cell && cell.width && cell.height && buf) {
      return {
        x: rect.left + Math.min((buf.cursorX + 1) * cell.width, rect.width),
        y: rect.top + Math.min((buf.cursorY + 1) * cell.height + 4, rect.height),
      };
    }
    if (rect) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  } catch { /* internal API shape changed — fall through */ }
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

// Open the saved-variable picker for a focused terminal. Reuses the context-menu
// renderer + secret-safe insert action, so it works in every right-click mode
// (incl. 'action-bar', where the generic menu no longer appears). Registered as
// the active context menu so outside-click / Esc / session-teardown close it.
async function openTerminalVariablePicker(terminal, sessionId) {
  closeTerminalContextMenu();
  const projectPath = (typeof sessionMap !== 'undefined' && sessionId)
    ? (sessionMap.get(sessionId)?.projectPath || null) : null;
  const ctx = { terminal, sessionId, projectPath };
  let groups = [];
  try { groups = await fetchVariableGroups(projectPath); } catch { groups = []; }
  // Flat list (faster to pick than nested scope flyouts); scope shown as a suffix
  // only when a name exists in more than one scope, to disambiguate.
  const names = {};
  for (const g of groups) for (const v of (g.vars || [])) names[v.name] = (names[v.name] || 0) + 1;
  const items = [];
  for (const g of groups) {
    for (const v of (g.vars || [])) {
      const scopeSuffix = names[v.name] > 1 ? `  ·${g.label.toLowerCase()}` : '';
      const secretSuffix = v.secret ? '  ·secret' : '';
      items.push({ id: `insert-variable:${v.id}`, label: `${v.name}${scopeSuffix}${secretSuffix}` });
    }
  }
  if (items.length) items.push(null);
  items.push({ id: 'manage-variables', label: items.length > 1 ? 'Manage variables…' : 'No variables — manage…' });
  const menu = document.createElement('div');
  menu.className = 'popover terminal-context-menu';
  renderMenuItems(menu, items, ctx);
  document.body.appendChild(menu);
  const pt = terminalCaretPoint(terminal);
  positionTerminalMenu(menu, pt.x, pt.y);
  activeTerminalMenu = menu;
  activeTerminalMenuSessionId = sessionId;
  setTimeout(() => {
    document.addEventListener('mousedown', onTerminalMenuClickOutside, true);
    document.addEventListener('keydown', onTerminalMenuKey, true);
  }, 0);
}

// --- Selection action bar (mode 'action-bar', #88) ---
// A small floating toolbar that appears above a fresh text selection (Office-
// style), offering the selection actions. Reuses runTerminalMenuAction, so no
// duplicated effect logic. Right-click still pastes (over a link → the menu),
// wired in setupTerminalContextMenu.
let activeSelectionBar = null;
let activeSelectionBarSessionId = null;

function closeSelectionBar() {
  if (activeSelectionBar) {
    activeSelectionBar.remove();
    activeSelectionBar = null;
    activeSelectionBarSessionId = null;
  }
}
// Called from destroySession so a torn-down terminal's bar can't act on a
// disposed xterm instance.
function closeSelectionBarForSession(sessionId) {
  if (activeSelectionBar && activeSelectionBarSessionId === sessionId) closeSelectionBar();
}

// Icon-only buttons; labels are tooltips. Actions dispatch through
// runTerminalMenuAction with the same ctx shape the context menu uses.
const SELECTION_BAR_ACTIONS = [
  { id: 'copy', label: 'Copy', svg: '<path d="M9 9h9v9H9z"/><path d="M6 15H4V4h11v2"/>' },
  { id: 'create-task', label: 'Create task', svg: '<path d="M9 11l3 3L20 6"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>' },
];

function showSelectionBar(px, py, ctx) {
  closeSelectionBar();
  const bar = document.createElement('div');
  bar.className = 'terminal-selection-bar';
  for (const a of SELECTION_BAR_ACTIONS) {
    const btn = document.createElement('button');
    btn.className = 'terminal-selection-bar-btn';
    btn.title = a.label;
    btn.setAttribute('aria-label', a.label);
    btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${a.svg}</svg>`;
    // mousedown default would blur the terminal and drop the selection before
    // the action reads it — prevent it so getSelection() still works on click.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => { runTerminalMenuAction(a.id, ctx); closeSelectionBar(); });
    bar.appendChild(btn);
  }
  document.body.appendChild(bar);
  // Position centered above the selection end, clamped; flip below if no room.
  const bw = bar.offsetWidth;
  const bh = bar.offsetHeight;
  let x = px - bw / 2;
  let y = py - bh - 8;
  if (x < 4) x = 4;
  if (x + bw > window.innerWidth - 4) x = window.innerWidth - bw - 4;
  if (y < 4) y = py + 16;
  bar.style.left = x + 'px';
  bar.style.top = y + 'px';
  activeSelectionBar = bar;
  activeSelectionBarSessionId = ctx.sessionId;
}

// Wire a terminal container's right-click to the configured behavior. Called
// from createTerminalEntry. getHoveredLinkUri returns the URI of the link the
// cursor is currently over (tracked via the link hover/leave callbacks), or
// null.
function setupTerminalContextMenu(container, terminal, getSessionId, getHoveredLinkUri) {
  // Swallow the right mouse BUTTON itself (mousedown/mouseup/auxclick) in the
  // capture phase so xterm never processes it. Two bugs otherwise:
  //   1. xterm clears the active selection on the right-button mousedown, so the
  //      context menu sees hasSelection()===false and omits "Copy".
  //   2. with application mouse-reporting on (Claude's TUI), xterm forwards the
  //      right button to the program, which surfaces as a stray paste — the
  //      native behavior runs even though our menu is shown.
  // stopPropagation (no preventDefault) keeps xterm's descendant handlers from
  // firing while still letting the OS emit the `contextmenu` event we handle
  // below. 'default' mode leaves xterm's native handling untouched.
  const swallowRightButton = (e) => {
    if (e.button !== 2) return;
    if (terminalRightClickMode === 'default') return;
    e.stopPropagation();
  };
  container.addEventListener('mousedown', swallowRightButton, { capture: true });
  container.addEventListener('mouseup', swallowRightButton, { capture: true });
  container.addEventListener('auxclick', swallowRightButton, { capture: true });

  container.addEventListener('contextmenu', (e) => {
    if (terminalRightClickMode === 'default') return; // let xterm handle it natively
    // Capture-phase preventDefault + stopPropagation: xterm's contextmenu
    // listener is on a descendant element, so stopping here keeps it from
    // running (and suppresses any native menu).
    e.preventDefault();
    e.stopPropagation();
    if (terminalRightClickMode === 'none') return;
    // Copy-on-right-click modes (Windows/PuTTY convention). The right-button
    // mousedown was swallowed above, so the selection is still intact here.
    if (terminalRightClickMode === 'copy' || terminalRightClickMode === 'copy-paste') {
      if (terminal.hasSelection && terminal.hasSelection()) {
        window.api.writeClipboard(terminal.getSelection());
        if (terminal.clearSelection) terminal.clearSelection();
      } else if (terminalRightClickMode === 'copy-paste') {
        window.api.readClipboard().then((t) => { if (t) pasteIntoTerminal(terminal, getSessionId(), t); }).catch(() => {});
      }
      terminal.focus(); // the swallowed right-button never focused the terminal
      return;
    }
    if (terminalRightClickMode === 'paste') {
      window.api.readClipboard().then((t) => { if (t) pasteIntoTerminal(terminal, getSessionId(), t); }).catch(() => {});
      terminal.focus();
      return;
    }
    // 'action-bar' (#88): right-click over a link → the context menu (so file/URL
    // actions stay reachable); otherwise paste. Selection actions live in the
    // floating bar wired below.
    if (terminalRightClickMode === 'action-bar') {
      const linkUri = getHoveredLinkUri();
      if (linkUri) {
        showTerminalContextMenu(e, { terminal, sessionId: getSessionId(), linkUri });
        return;
      }
      window.api.readClipboard().then((t) => { if (t) pasteIntoTerminal(terminal, getSessionId(), t); }).catch(() => {});
      terminal.focus();
      return;
    }
    // 'menu' (default)
    showTerminalContextMenu(e, {
      terminal,
      sessionId: getSessionId(),
      linkUri: getHoveredLinkUri(),
    });
  }, { capture: true });

  // Selection action bar (#88): on a left-button mouseup that leaves a selection,
  // pop the bar above the release point. Only in 'action-bar' mode.
  container.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || terminalRightClickMode !== 'action-bar') return;
    const px = e.clientX;
    const py = e.clientY;
    // Defer so xterm has finalized the selection for this mouseup.
    setTimeout(() => {
      if (terminal.hasSelection && terminal.hasSelection() && terminal.getSelection().trim()) {
        showSelectionBar(px, py, { terminal, sessionId: getSessionId() });
      }
    }, 0);
  });
  // Hide the bar when the selection is cleared (new click, deselect, program clear).
  if (typeof terminal.onSelectionChange === 'function') {
    terminal.onSelectionChange(() => {
      if (activeSelectionBar && (!terminal.hasSelection || !terminal.hasSelection())) closeSelectionBar();
    });
  }
  // Hide on scroll — the anchor point would otherwise drift off the selection.
  if (typeof terminal.onScroll === 'function') terminal.onScroll(() => closeSelectionBar());
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    fileUriToPath,
    classifyLinkUri,
    buildTerminalMenuItems,
    pasteIntoTerminal,
    runTerminalMenuAction,
    showTerminalContextMenu,
    closeTerminalContextMenu,
    closeTerminalContextMenuForSession,
    setupTerminalContextMenu,
    // Test seam: in the renderer the mode is a shared global set by app.js's
    // window._applyTerminalRightClick; under require() it's module-scoped.
    _setTerminalRightClickMode: (m) => { terminalRightClickMode = m; },
  };
}
