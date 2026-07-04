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
    return decodeURIComponent(new URL(uri).pathname);
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
function buildTerminalMenuItems({ linkUri, hasSelection, variableGroups = null }) {
  const items = [];
  const link = classifyLinkUri(linkUri);
  if (link.kind === 'file') {
    items.push({ id: 'open-panel', label: 'Open in panel' });
    items.push({ id: 'open-system', label: 'Open in system editor' });
    items.push({ id: 'copy-path', label: 'Copy path' });
  } else if (link.kind === 'url') {
    items.push({ id: 'open-browser', label: 'Open in browser' });
    items.push({ id: 'copy-link', label: 'Copy link' });
  }
  if (items.length) items.push(null); // separator before the generic actions
  if (hasSelection) items.push({ id: 'copy', label: 'Copy' });
  items.push({ id: 'paste', label: 'Paste' });
  items.push({ id: 'select-all', label: 'Select all' });
  if (hasSelection) {
    items.push(null);
    items.push({ id: 'create-task', label: 'Create task from selection' });
  }
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
      // template (raw value, temp-file path, or shell ref); fall back to
      // clipboard for shells without inline-ref support.
      const shellType = await (window.variablesInsert?.resolveShellType?.(ctx.projectPath) ?? Promise.resolve('unknown'));
      const res = await window.api.resolveVariableInsert(varId, shellType, sessionId);
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
      if (terminal.hasSelection() && window.tasksView) {
        window.tasksView.createFromSource({ sessionId, quote: terminal.getSelection() });
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

  // Synchronous base render; the bookmark toggle label and Variables submenu are
  // filled in a tick later once their DB lookups resolve (enhanceTerminalMenu).
  const menu = document.createElement('div');
  menu.className = 'popover terminal-context-menu';
  renderMenuItems(menu, buildTerminalMenuItems({ linkUri: ctx.linkUri, hasSelection }), fullCtx);
  document.body.appendChild(menu);
  positionTerminalMenu(menu, event.clientX, event.clientY);

  activeTerminalMenu = menu;
  activeTerminalMenuSessionId = ctx.sessionId;
  // Defer listener registration so the originating event doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('mousedown', onTerminalMenuClickOutside, true);
    document.addEventListener('keydown', onTerminalMenuKey, true);
  }, 0);

  enhanceTerminalMenu(menu, fullCtx, { hasSelection, linkUri: ctx.linkUri, x: event.clientX, y: event.clientY });
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
    linkUri: base.linkUri, hasSelection: base.hasSelection, variableGroups,
  }), ctx);
  positionTerminalMenu(menu, base.x, base.y);
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
    // 'menu' (default)
    showTerminalContextMenu(e, {
      terminal,
      sessionId: getSessionId(),
      linkUri: getHoveredLinkUri(),
    });
  }, { capture: true });
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
