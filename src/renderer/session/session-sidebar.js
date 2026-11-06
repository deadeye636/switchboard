// session/session-sidebar.js — the collapsible sidebar on a session's right (#817, spec 43).
//
// One per session, not one per window: it lives inside the session's `.terminal-container`, so it moves with the
// session between panes and windows, and a pane can have it open while the one beside it does not. Grid cards hide
// it through their `.grid-mode` class.
//
// How a terminal makes room, and why it is not a wrapper element: FitAddon measures the container and subtracts the
// `.xterm` element's own padding (see `safeFit`, terminal-manager.js). So the open sidebar is that padding, a CSS
// variable on the container, and the fit needs no change. A conversation view pads the container itself.
//
// Free globals it reads at CALL time: escapeHtml, formatDate (lib/utils.js), openSessions, sessionMap (app.js),
// fitAndScroll (terminal/terminal-manager.js), insertResolvedText (terminal/terminal-context-menu.js),
// openTasksView (views/tasks-view.js), sessionBackendId (backends/backend-registry.js), window.api.
//
// Callers into this file: createTerminalEntry and createConversationEntry (`sessionSidebarMount`), the two session
// toolbars (`sessionSidebarToggle`, `sessionSidebarIsOpen`), the re-key (`rekeySessionSidebar`), and the conversation
// view's `context` op (`sessionSidebarContextChanged`).

const SESSION_SIDEBAR_KEY = 'sessionSidebar';
const SESSION_SIDEBAR_WIDTH = { min: 200, default: 280, max: 560 };
const SESSION_SIDEBAR_KEEP = 300;
// What a session shows before anyone has chosen: the cheap ones. Handoffs and connectors each read something.
const SESSION_SIDEBAR_OPEN_GROUPS = ['tasks', 'context'];
const SESSION_SIDEBAR_ROWS = 30;

// --- The stored state: pure, and exported at the end for the tests. ---

function sidebarStateOf(map, sessionId) {
  const s = (map && map[sessionId]) || {};
  return {
    open: s.open === true,
    width: clampSidebarWidth(s.width),
    groups: Array.isArray(s.groups) ? s.groups.filter((g) => typeof g === 'string') : SESSION_SIDEBAR_OPEN_GROUPS.slice(),
  };
}

function clampSidebarWidth(width) {
  const n = Number(width);
  if (!Number.isFinite(n)) return SESSION_SIDEBAR_WIDTH.default;
  return Math.max(SESSION_SIDEBAR_WIDTH.min, Math.min(SESSION_SIDEBAR_WIDTH.max, Math.round(n)));
}

// The newest stay: this is one row per session anyone ever opened a sidebar in, and nothing else removes one.
function withSidebarState(map, sessionId, state, now) {
  const next = { ...(map || {}), [sessionId]: { ...state, at: now } };
  const ids = Object.keys(next);
  if (ids.length > SESSION_SIDEBAR_KEEP) {
    ids.sort((a, b) => (next[b].at || 0) - (next[a].at || 0));
    for (const id of ids.slice(SESSION_SIDEBAR_KEEP)) delete next[id];
  }
  return next;
}

function rekeySidebarState(map, oldId, newId) {
  if (!map || !map[oldId]) return map;
  const next = { ...map, [newId]: map[newId] || map[oldId] };
  delete next[oldId];
  return next;
}

function openTaskRows(tasks) {
  return (tasks || []).filter((t) => t && (t.status === 'open' || t.status === 'in_progress'));
}

// The figures both kinds of session can answer, in one shape. A running conversation asks its CLI; a terminal has
// what the core read from the transcript. Nothing means nothing was measured, never zero.
function sidebarContextFigures(conversationContext, contextFill, lastModel) {
  const c = conversationContext;
  if (c && Number.isFinite(c.percent)) return { percent: c.percent, tokens: c.tokens, window: c.window, model: c.model || '' };
  const f = contextFill;
  if (f && Number.isFinite(Number(f.percent))) {
    return { percent: Number(f.percent), tokens: f.tokens ?? f.usedTokens, window: f.windowTokens, model: lastModel || '' };
  }
  return null;
}

// What room a sidebar takes in a box this wide. A pane can get narrower than a stored width, and a padding past the
// box would make FitAddon answer its minimum of two columns and rewrap the buffer. Zero is a hidden box: the stored
// width stands until it has a size.
function sidebarShownWidth(width, available) {
  return available > 0 ? Math.min(width, Math.floor(available * 0.6)) : width;
}

// `agent.servers` answers `{ ok, list: { title, rows } }`. Null when the session could not say.
function sidebarServerRows(answer) {
  const rows = answer && answer.ok && answer.list && answer.list.rows;
  return Array.isArray(rows) ? rows : null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    sidebarStateOf, clampSidebarWidth, withSidebarState, rekeySidebarState, openTaskRows, sidebarContextFigures, sidebarServerRows, sidebarShownWidth,
    SESSION_SIDEBAR_KEEP, SESSION_SIDEBAR_WIDTH,
  };
}

// --- The surface. ---

function readSidebarStates() {
  try { return JSON.parse(localStorage.getItem(SESSION_SIDEBAR_KEY)) || {}; } catch { return {}; }
}
// Read fresh on every write: a detached window shares this storage and writes its own session's row.
function writeSidebarState(sessionId, patch) {
  const map = readSidebarStates();
  const next = withSidebarState(map, sessionId, { ...sidebarStateOf(map, sessionId), ...patch }, Date.now());
  try { localStorage.setItem(SESSION_SIDEBAR_KEY, JSON.stringify(next)); } catch { /* the state is a convenience */ }
}

// In view and able to show it: a grid card holds the session but hides its sidebar.
function sidebarInView(entry) {
  return entry.element.classList.contains('visible') && !entry.element.classList.contains('grid-mode');
}

// One CLI start per project at a time, and for a short while after. Several panes can show one project, and this
// starts a process that talks to a server. The reload button asks again.
const SIDEBAR_ISSUES_MS = 30000;
const sidebarIssues = new Map();
function sidebarIssuesFor(projectPath, force) {
  const held = sidebarIssues.get(projectPath);
  if (held && !force && Date.now() - held.at < SIDEBAR_ISSUES_MS) return held.answer;
  const answer = window.api.forgeIssuesList(projectPath);
  sidebarIssues.set(projectPath, { at: Date.now(), answer });
  return answer;
}

function sidebarSessionFocus(entry) {
  const surface = entry.terminal || entry.conversation;
  if (surface && surface.focus) surface.focus();
}

function sidebarSessionOf(entry) {
  const id = entry.session.sessionId;
  return (typeof sessionMap !== 'undefined' && sessionMap.get(id)) || entry.session;
}

function sidebarRow(main, meta, attrs = '') {
  return `<button type="button" class="ssb-row" ${attrs}><span class="ssb-row-main">${escapeHtml(main)}</span>`
    + `${meta ? `<span class="ssb-row-meta">${escapeHtml(meta)}</span>` : ''}</button>`;
}
const sidebarNote = (text) => `<div class="ssb-note">${escapeHtml(text)}</div>`;

// Each group reads when it is open and in view, and answers markup. All of it is escaped: a task title, an issue and
// a skill name are all text somebody else may have written.
const SESSION_SIDEBAR_GROUPS = [
  {
    id: 'tasks',
    label: 'Tasks & notes',
    async load(entry, draw, force) {
      const projectPath = sidebarSessionOf(entry).projectPath;
      if (!projectPath) return sidebarNote('This session has no project.');
      const res = await window.api.taskList({ projectPath });
      const rows = openTaskRows(res && res.tasks);
      let html = rows.length
        ? rows.slice(0, SESSION_SIDEBAR_ROWS).map((t) => sidebarRow(t.title, t.status === 'in_progress' ? 'In progress' : '', 'data-ssb="tasks"')).join('')
        : sidebarNote('No open tasks.');
      const settings = await window.api.getEffectiveSettings(projectPath);
      if (settings && settings.forgeIssuesEnabled === true) {
        html += `<div class="ssb-subhead">Issues · read-only</div>`;
        // The tasks are local and the CLI can take its timeout, so they do not wait for it.
        draw(html + sidebarNote('Loading…'));
        const issues = await sidebarIssuesFor(projectPath, force);
        if (!issues || !issues.ok) html += sidebarNote((issues && issues.message) || 'The issues could not be read.');
        else if (!issues.issues.length) html += sidebarNote('No open issues.');
        else html += issues.issues.slice(0, SESSION_SIDEBAR_ROWS).map((i) => sidebarRow(`#${i.number} ${i.title}`, '', i.url ? `data-ssb="url" data-url="${escapeHtml(i.url)}"` : 'disabled')).join('');
      }
      return html;
    },
  },
  {
    id: 'handoffs',
    label: 'Handoffs',
    async load(entry) {
      const projectPath = sidebarSessionOf(entry).projectPath;
      if (!projectPath) return sidebarNote('This session has no project.');
      const rows = await window.api.listHandoffs(projectPath);
      if (!rows || !rows.length) return sidebarNote('No handoffs in this project.');
      return rows.slice(0, SESSION_SIDEBAR_ROWS).map((h) => {
        const when = h.modified || h.createdAt;
        const meta = when && typeof formatDate === 'function' ? formatDate(new Date(when)) : '';
        return sidebarRow(h.title || h.label || h.filename, meta, `data-ssb="insert" data-text="${escapeHtml(h.filePath || '')}" title="Insert the path"`);
      }).join('');
    },
  },
  {
    id: 'context',
    label: 'Context',
    async load(entry) {
      const fromView = entry.conversation && entry.conversation.context ? entry.conversation.context() : null;
      const session = sidebarSessionOf(entry);
      const figures = sidebarContextFigures(fromView, session.contextFill, session.lastModel);
      if (!figures) return sidebarNote('No figure for this session yet.');
      const percent = Math.max(0, Math.min(100, figures.percent));
      const tokens = Number.isFinite(Number(figures.tokens)) && Number.isFinite(Number(figures.window))
        ? `${Number(figures.tokens).toLocaleString()} of ${Number(figures.window).toLocaleString()} tokens` : '';
      return `<div class="ssb-meter"><i style="width:${percent}%"></i></div>`
        + `<div class="ssb-figure">${Math.round(figures.percent)} % used</div>`
        + (tokens ? `<div class="ssb-note">${escapeHtml(tokens)}</div>` : '')
        + (figures.model ? `<div class="ssb-note">${escapeHtml(figures.model)}</div>` : '');
    },
  },
  {
    id: 'connectors',
    label: 'Connectors',
    async load(entry) {
      const session = sidebarSessionOf(entry);
      let html = '';
      // Only a session driven over a pipe can be asked which servers it holds, so a terminal leaves this out.
      if (entry.conversation && !entry.conversation.exited?.()) {
        const rows = sidebarServerRows(await window.api.agent.servers(session.sessionId).catch(() => null));
        if (rows) {
          html += `<div class="ssb-subhead">MCP servers</div>`;
          html += rows.length
            ? rows.map((s) => sidebarRow(s.name, s.state || '', `disabled data-tone="${escapeHtml(s.tone || '')}"`)).join('')
            : sidebarNote('None.');
        }
      }
      const backendId = typeof sessionBackendId === 'function' ? sessionBackendId(session) : null;
      const res = await window.api.getSkills(session.projectPath || null, backendId);
      const skills = (res && res.skills) || [];
      html += `<div class="ssb-subhead">Skills</div>`;
      html += skills.length
        ? skills.slice(0, SESSION_SIDEBAR_ROWS).map((s) => sidebarRow(s.name, '', 'disabled')).join('')
        : sidebarNote('None.');
      return html;
    },
  },
];

// The group's own dirty mark and a token, so a late answer for a closed sidebar or an older read draws nothing.
function loadSidebarGroup(entry, group, section, force = false) {
  const body = section.querySelector('.ssb-group-body');
  const token = (section._token || 0) + 1;
  section._token = token;
  section._stale = false;
  if (!body.firstChild) body.innerHTML = sidebarNote('Loading…');
  const draw = (html) => { if (section._token === token) body.innerHTML = html; };
  Promise.resolve().then(() => group.load(entry, draw, force)).then((html) => {
    if (section._token === token) body.innerHTML = html;
  }).catch(() => {
    if (section._token === token) body.innerHTML = sidebarNote('Could not be read.');
  });
}

function loadOpenSidebarGroups(entry, force = false) {
  const root = entry.sidebar;
  if (!root) return;
  // Not on screen: a restart can bring back several sessions with an open sidebar, and only the one in view reads.
  if (!sidebarInView(entry)) {
    for (const section of root.querySelectorAll('.ssb-group')) section._stale = true;
    return;
  }
  for (const group of SESSION_SIDEBAR_GROUPS) {
    const section = root.querySelector(`.ssb-group[data-group="${group.id}"]`);
    if (section && section.open) loadSidebarGroup(entry, group, section, force);
  }
}

function applySidebarWidth(entry, width) {
  entry.sidebarWidth = width;
  const shown = sidebarShownWidth(width, entry.element.clientWidth);
  entry.element.style.setProperty('--session-sidebar-width', `${shown}px`);
}

// Once, after the box has settled: every changed width is a PTY resize. Not `scheduleObservedRefit`: that one skips
// a container whose box has not changed, and the container keeps its box here. Only the padding inside it moved.
function refitForSidebar(entry) {
  if (entry.terminal && typeof fitAndScroll === 'function') fitAndScroll(entry);
}

function buildSidebar(entry) {
  const sessionId = () => entry.session.sessionId;
  const state = sidebarStateOf(readSidebarStates(), sessionId());
  const root = document.createElement('aside');
  root.className = 'session-sidebar';
  root.setAttribute('aria-label', 'Session sidebar');
  root.innerHTML = `
    <div class="ssb-resize" title="Drag to resize"></div>
    <div class="ssb-head">
      <span>Session</span>
      <button type="button" class="ssb-head-btn" data-ssb="refresh" title="Reload" aria-label="Reload">⟳</button>
      <button type="button" class="ssb-head-btn" data-ssb="close" title="Close" aria-label="Close">&times;</button>
    </div>
    <div class="ssb-body">${SESSION_SIDEBAR_GROUPS.map((g) => `
      <details class="ssb-group" data-group="${g.id}"${state.groups.includes(g.id) ? ' open' : ''}>
        <summary>${escapeHtml(g.label)}</summary>
        <div class="ssb-group-body"></div>
      </details>`).join('')}
    </div>`;

  root.addEventListener('toggle', (e) => {
    const section = e.target;
    if (!section.classList || !section.classList.contains('ssb-group')) return;
    const open = [...root.querySelectorAll('.ssb-group')].filter((s) => s.open).map((s) => s.dataset.group);
    writeSidebarState(sessionId(), { groups: open });
    // A group drawn open fires this once by itself, and `showSidebar` has already read it.
    if (!section.open) section._closedOnce = true;
    else if (section._closedOnce && sidebarInView(entry)) {
      loadSidebarGroup(entry, SESSION_SIDEBAR_GROUPS.find((g) => g.id === section.dataset.group), section);
    } else if (section._closedOnce) section._stale = true;
  }, true);

  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-ssb]');
    if (!el) return;
    const session = sidebarSessionOf(entry);
    switch (el.dataset.ssb) {
      case 'close':
        sessionSidebarToggle(sessionId());
        sidebarSessionFocus(entry);
        break;
      case 'refresh': loadOpenSidebarGroups(entry, true); break;
      case 'url': window.api.openExternal(el.dataset.url); break;
      case 'tasks':
        if (typeof openTasksView === 'function') openTasksView({ projectPath: session.projectPath }, 'Session project');
        break;
      case 'insert':
        if (el.dataset.text && typeof insertResolvedText === 'function') {
          insertResolvedText(entry.terminal, sessionId(), el.dataset.text, { trailing: ' ' });
          // Or Enter, meant for the session, presses this row again.
          sidebarSessionFocus(entry);
        }
        break;
      default:
    }
  });

  const handle = root.querySelector('.ssb-resize');
  handle.addEventListener('pointerdown', (down) => {
    down.preventDefault();
    handle.setPointerCapture(down.pointerId);
    const startX = down.clientX;
    const startWidth = root.getBoundingClientRect().width;
    let width = startWidth;
    const move = (e) => {
      width = clampSidebarWidth(startWidth + (startX - e.clientX));
      root.style.width = `${width}px`;
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      root.style.width = '';
      writeSidebarState(sessionId(), { width });
      applySidebarWidth(entry, width);
      refitForSidebar(entry);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });

  entry.element.appendChild(root);
  entry.sidebar = root;
  // The cap follows the box. The terminal's own refit comes from its resize observer, after this.
  entry.sidebarResizeObserver = new ResizeObserver(() => applySidebarWidth(entry, entry.sidebarWidth));
  entry.sidebarResizeObserver.observe(entry.element);
  // A session coming into view reads what it skipped while hidden.
  entry.sidebarObserver = new MutationObserver(() => {
    if (!sidebarInView(entry)) return;
    for (const group of SESSION_SIDEBAR_GROUPS) {
      const section = root.querySelector(`.ssb-group[data-group="${group.id}"]`);
      if (section && section.open && section._stale) loadSidebarGroup(entry, group, section);
    }
  });
  entry.sidebarObserver.observe(entry.element, { attributes: true, attributeFilter: ['class'] });
  return root;
}

function showSidebar(entry, width) {
  if (!entry.sidebar) buildSidebar(entry);
  applySidebarWidth(entry, width);
  entry.element.classList.add('sidebar-open');
  loadOpenSidebarGroups(entry);
  refitForSidebar(entry);
}

function hideSidebar(entry) {
  entry.element.classList.remove('sidebar-open');
  if (entry.sidebarObserver) entry.sidebarObserver.disconnect();
  if (entry.sidebarResizeObserver) entry.sidebarResizeObserver.disconnect();
  entry.sidebarObserver = null;
  entry.sidebarResizeObserver = null;
  if (entry.sidebar) entry.sidebar.remove();
  entry.sidebar = null;
  refitForSidebar(entry);
}

// A session that had it open comes back with it open.
function sessionSidebarMount(entry) {
  if (!entry || !entry.session) return;
  const state = sidebarStateOf(readSidebarStates(), entry.session.sessionId);
  if (state.open) showSidebar(entry, state.width);
}

function sessionSidebarIsOpen(sessionId) {
  const entry = openSessions.get(sessionId);
  return !!(entry && entry.element.classList.contains('sidebar-open'));
}

function sessionSidebarToggle(sessionId) {
  const entry = openSessions.get(sessionId);
  if (!entry) return false;
  const open = !sessionSidebarIsOpen(sessionId);
  writeSidebarState(sessionId, { open });
  if (open) showSidebar(entry, sidebarStateOf(readSidebarStates(), sessionId).width);
  else hideSidebar(entry);
  for (const btn of document.querySelectorAll(`[data-sidebar-session="${CSS.escape(sessionId)}"]`)) btn.classList.toggle('active', open);
  return open;
}

function sessionSidebarContextChanged(sessionId) {
  const entry = openSessions.get(sessionId);
  const section = entry && entry.sidebar && entry.sidebar.querySelector('.ssb-group[data-group="context"]');
  if (section && section.open) loadSidebarGroup(entry, SESSION_SIDEBAR_GROUPS.find((g) => g.id === 'context'), section);
}

function rekeySessionSidebar(oldId, newId) {
  const map = readSidebarStates();
  const next = rekeySidebarState(map, oldId, newId);
  if (next === map) return;
  try { localStorage.setItem(SESSION_SIDEBAR_KEY, JSON.stringify(next)); } catch { /* the state is a convenience */ }
}
