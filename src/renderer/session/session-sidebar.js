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
// openTasksView (views/tasks-view.js), sessionBackendId (backends/backend-registry.js), openFileInPanel
// (views/file-panel.js), openSessionServers (session/servers-dialog.js), skillInsertText (the skill picker), window.showControlToast, window.api,
// appGlobalSettings (app.js), moveVariableInOrder, stepVariableInOrder, sameVariableOrder (lib/variable-order.js),
// SESSION_SIDEBAR_GROUP_NAMES, hiddenSidebarGroups, withSidebarGroupHidden (lib/sidebar-groups.js, #835),
// and for the issue filters (#830) settingsOwnerPath (shared/worktree-path.js), filterIssues, normalizeIssueFilter,
// issueQueryOf, issueLabels, issueCountLabel, readIssueFilter, patchIssueFilter, ISSUE_FILTER_EVENT, and since #874
// filterTasks, sortTasks, issuePreviewMarkdown (views/tasks-logic.js, loaded after this file: every reference is inside a
// function; the window listener spells the event name itself), and openTextInPanel (views/file-panel.js, #874).
// The Changes group (#870, spec 47) reads changesHeadFigure, changesRowModel, changesRowIndex, changesModelHtml and
// changesClearedText (lib/session-changes-rows.js, loaded before this file).
//
// Read from outside: `SESSION_SIDEBAR_GROUP_MIME` by `isPaneTabDrag` (terminal/terminal-manager.js), and
// `sidebarUnfollowVcs`, `sidebarUnfollowChanges` and `sidebarUnfollowIssues` by the tab teardown in the same file (the
// subscriptions hold the entry), and `sessionSidebarActiveChanged` by `setActiveSession` (app.js).
//
// Callers into this file: createTerminalEntry and createConversationEntry (`sessionSidebarMount`), the two session
// toolbars (`sessionSidebarToggle`, `sessionSidebarIsOpen`), the re-key (`rekeySessionSidebar`), the conversation
// view's `context` op (`sessionSidebarContextChanged`), its session line's tooltip (`contextLineDetails`) and
// `reapplyGlobalSettings` in app.js (`sessionSidebarOrderChanged`, #829; `sessionSidebarHiddenChanged`, #835;
// `sessionSidebarSharedChanged`, #892) and
// `loadProjects` in app.js after it refreshed the session objects (`sessionSidebarSessionsChanged`, #840).

const SESSION_SIDEBAR_KEY = 'sessionSidebar';
const SESSION_SIDEBAR_WIDTH = { min: 200, default: 280, max: 560 };
const SESSION_SIDEBAR_KEEP = 300;
// What a session shows before anyone has chosen: the cheap ones. Handoffs, instructions and connectors each read something.
// The repository costs a filesystem walk and, when the poller does not hold the directory, one status run (#821).
const SESSION_SIDEBAR_OPEN_GROUPS = ['repository', 'tasks', 'context'];
const SESSION_SIDEBAR_ROWS = 30;

// --- The stored state: pure, and exported at the end for the tests. ---

// `defaultOpen` (#831) answers only for a session with no stored row; a stored row, closed or not, keeps its own.
function sidebarStateOf(map, sessionId, defaultOpen) {
  const row = map && map[sessionId];
  const s = row || {};
  return {
    open: row ? s.open === true : defaultOpen === true,
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

// One write: the session's state as it reads now, the default included (#831), with the patch on top. Without the
// default, a width or section change in a session the default opened would store it closed.
function patchSidebarState(map, sessionId, patch, defaultOpen, now) {
  return withSidebarState(map, sessionId, { ...sidebarStateOf(map, sessionId, defaultOpen), ...patch }, now);
}

function rekeySidebarState(map, oldId, newId) {
  if (!map || !map[oldId]) return map;
  const next = { ...map, [newId]: map[newId] || map[oldId] };
  delete next[oldId];
  return next;
}

// The shared state (#892): one row for every session while `sessionSidebarShared` is on, kept as the global setting
// `sessionSidebarSharedState`. Anything that is not an object is no state yet (null), so a caller knows to fall back to
// the session's own row until one is written. A stored one reads like a stored row: its own `open`, never the default.
function sidebarSharedStateOf(shared) {
  if (!shared || typeof shared !== 'object' || Array.isArray(shared)) return null;
  return sidebarStateOf({ shared }, 'shared');
}

// The open groups as a set: a list read off the DOM follows the section order (#829), a stored one may not.
function sameSidebarState(a, b) {
  if (!a || !b) return false;
  const groups = new Set(a.groups);
  return a.open === b.open && a.width === b.width && groups.size === new Set(b.groups).size && b.groups.every((g) => groups.has(g));
}

// The groups' order (#829): one global setting, `sessionSidebarOrder`, a list of group ids. An id this version does not
// know is dropped, a repeat counts once, and a group the saved list does not name (one added in a later version) goes in
// at its default place: right after the nearest group that comes before it by default, or first when none does.
// Anything that is not a list is the default.
function orderSidebarGroups(defaultIds, savedIds) {
  const known = new Set(defaultIds);
  const order = [];
  for (const id of Array.isArray(savedIds) ? savedIds : []) {
    if (known.has(id) && !order.includes(id)) order.push(id);
  }
  defaultIds.forEach((id, i) => {
    if (order.includes(id)) return;
    const before = defaultIds.slice(0, i).reverse().find((prev) => order.includes(prev));
    order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, id);
  });
  return order;
}

// What a group's `toggle` means. A group drawn OPEN fires one toggle by itself, and `showSidebar` has already read it, so
// that one reads nothing. A group drawn CLOSED has never been closed by anybody, yet its first real open must read: it
// starts with `closedOnce` set (`buildSidebar`), so its first open is a load.
function sidebarToggleAction({ open, closedOnce, inView }) {
  if (!open) return 'closed';
  if (!closedOnce) return 'none';
  return inView ? 'load' : 'stale';
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

function sidebarTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

// A category's share of the window. Deferred tools are not in the context, so they have none.
function sidebarCategoryShare(category, window) {
  if (category.kind === 'deferred' || !(Number(window) > 0)) return '';
  return `${((category.tokens / window) * 100).toFixed(1)} %`;
}

// What the bar draws: what is used, then the reserved buffer. The rest of the track is the free space.
function sidebarBarSegments(breakdown, window) {
  if (!(Number(window) > 0)) return [];
  return breakdown.categories.filter((c) => (c.kind === 'used' || c.kind === 'buffer') && c.tokens > 0)
    .map((c) => ({ ...c, width: Math.min(100, (c.tokens / window) * 100) }));
}

// The Instructions group's rows (#823, spec 44): the files that apply to this session, global and project, for its
// CLI. Main answers `{ rows: [{ id, label, scope, section, path }], declined }`; a row is opened read-only in the
// preview panel. Split by scope, in the order main sent them; `declined` is the sentence for a CLI with none.
function instructionGroups(answer) {
  const rows = answer && answer.ok && Array.isArray(answer.rows) ? answer.rows.filter((r) => r && typeof r.path === 'string' && r.path) : [];
  return [['global', 'Global'], ['project', 'Project']]
    .map(([scope, label]) => ({ scope, label, rows: rows.filter((r) => r.scope === scope) }))
    .filter((g) => g.rows.length);
}

// One file row. Shared with #822's Context group, whose memory files open the same way: `data-ssb="open-file"` and the
// path in `data-path`, all of it escaped. `meta` is optional (a size, a section).
function instructionRow(row, meta = '') {
  return sidebarRow(row.label || row.name || '', meta, `data-ssb="open-file" data-path="${escapeHtml(row.path)}" title="Open read-only"`);
}

const CONTEXT_BASELINE_NOTE = 'Nothing has been sent yet. This is about what the first request will carry.';
const CONTEXT_LINE_FILES = 3;

// The session line's tooltip, in lines: the baseline's sentence, what is used, and where a user can save.
function contextLineDetails(context) {
  const c = context || {};
  const lines = c.baseline ? [CONTEXT_BASELINE_NOTE] : [];
  const b = c.breakdown;
  if (!b || !Array.isArray(b.categories) || !Array.isArray(b.lists)) return lines;
  if (lines.length) lines.push('');
  for (const row of b.categories) {
    if (row.kind === 'used' && row.tokens > 0) lines.push(`${row.label}: ${row.tokens.toLocaleString()}`);
  }
  const memory = b.lists.find((l) => l.id === 'memory');
  if (memory) {
    lines.push('', 'Largest memory files:');
    for (const row of memory.rows.slice(0, CONTEXT_LINE_FILES)) lines.push(`${row.name}: ${row.tokens.toLocaleString()}`);
  }
  return lines;
}

// --- One row pattern (#822, spec 43): a click inserts into the session's prompt, hover buttons do the rest. ---
//
// What a row offers is decided by its kind and nothing else. `open` and `copy` and `edit` are the only buttons, and
// a row gets only those it can honour (an issue without a url has no `open`, a skill without an id has no `edit`).
const SIDEBAR_ROW_ACTIONS = { task: ['open', 'copy'], issue: ['preview', 'open', 'copy'], handoff: ['open', 'copy'], skill: ['edit'] };
const SIDEBAR_ACTION_FACE = { preview: ['◫', 'Preview'], open: ['↗', 'Open'], copy: ['⧉', 'Copy'], edit: ['✎', 'Edit'] };

const SIDEBAR_KIND_GROUP = { task: 'tasks', issue: 'tasks', handoff: 'handoffs', skill: 'connectors' };

function sidebarRowActions(kind, src) {
  const s = src || {};
  return (SIDEBAR_ROW_ACTIONS[kind] || []).filter((a) => {
    if (kind === 'issue' && a === 'open') return !!s.url;
    if (kind === 'issue' && a === 'preview') return s.number != null;
    if (kind === 'handoff') return !!s.filePath;
    if (kind === 'skill' && a === 'edit') return !!s.id;
    return true;
  });
}

// What the row inserts. A handoff is its path (no template on a click, owner decision on #822); the skill and task
// texts are the pickers' own functions, template included. A skill has no plain form, so Shift changes nothing there;
// a task's plain form is its bare title.
function sidebarInsertText(kind, src, { plain = false, template = '', helpers = {} } = {}) {
  if (!src) return '';
  const h = {
    skillInsertText: typeof skillInsertText === 'function' ? skillInsertText : undefined,
    taskInsertText: typeof taskInsertText === 'function' ? taskInsertText : undefined,
    ...helpers,
  };
  switch (kind) {
    case 'task': return h.taskInsertText ? h.taskInsertText(src, template, plain) : String(src.title || '').trim();
    case 'issue': return src.number != null ? `#${src.number}` : '';
    case 'handoff': return src.filePath || '';
    case 'skill': return h.skillInsertText ? h.skillInsertText(src, template) : (src.invocation || '');
    default: return '';
  }
}

// What the copy button puts on the clipboard: the bare thing, never a template.
function sidebarCopyText(kind, src) {
  if (!src) return '';
  switch (kind) {
    case 'task': return String(src.title || '').trim();
    case 'issue': return src.number != null ? `#${src.number}` : '';
    case 'handoff': return src.filePath || '';
    default: return '';
  }
}

// The row as data: the key it is found under at click time, its two texts, a tooltip and the buttons it offers.
function sidebarRowModel(kind, src, meta = '', index = 0) {
  const s = src || {};
  switch (kind) {
    case 'task': return { kind, key: `task:${s.id}`, main: s.title || '', meta: meta || (s.status === 'in_progress' ? 'In progress' : ''), tip: 'Insert the task', actions: sidebarRowActions(kind, s) };
    case 'issue': return { kind, key: `issue:${s.number}`, main: `#${s.number} ${s.title || ''}`, meta, tip: 'Insert the issue id', actions: sidebarRowActions(kind, s) };
    case 'handoff': return { kind, key: `handoff:${s.filePath || ''}`, main: s.title || s.label || s.filename || '', meta, tip: 'Insert the path', actions: sidebarRowActions(kind, s) };
    case 'skill': return { kind, key: `skill:${s.filePath || `#${index}`}`, main: s.name || '', meta, tip: 'Insert the skill', actions: sidebarRowActions(kind, s) };
    default: return null;
  }
}

// The markup of a row with its buttons. Every value is escaped; the buttons are siblings of the row button, never inside it.
function sidebarItemHtml(model) {
  const row = sidebarRow(model.main, model.meta, `data-ssb="row" data-key="${escapeHtml(model.key)}" title="${escapeHtml(model.tip)}"`);
  if (!model.actions.length) return row;
  const buttons = model.actions.map((a) => {
    const [glyph, label] = SIDEBAR_ACTION_FACE[a];
    return `<button type="button" class="ssb-head-btn ssb-act" data-ssb="act" data-act="${a}" data-key="${escapeHtml(model.key)}" `
      + `title="${label}" aria-label="${escapeHtml(`${label} ${model.main}`)}">${glyph}</button>`;
  }).join('');
  return `<div class="ssb-item">${row}<span class="ssb-acts">${buttons}</span></div>`;
}

// The Repository group's rows (#821, spec 43), from main's `vcsDescribe` answer: the repository, the branch with what
// it is ahead or behind, and the worktree when the session runs in one. Null for a directory under no VCS: the group
// then says so instead of drawing rows. Each row is `{ main, meta, title }`.
function repositoryRows(answer) {
  if (!answer || !answer.ok || !answer.vcs) return null;
  const rows = [];
  if (answer.repo) rows.push({ main: answer.repo.name, meta: 'repository', title: answer.repo.path });
  const counts = [answer.ahead > 0 ? `↑${answer.ahead}` : '', answer.behind > 0 ? `↓${answer.behind}` : ''].filter(Boolean).join(' ');
  const busy = answer.state && answer.state !== 'detached' ? answer.state : '';
  if (answer.branch) rows.push({ main: answer.branch, meta: [counts, busy].filter(Boolean).join(' · ') || 'branch', title: `${answer.vcs} branch` });
  // A rebase detaches HEAD, so it arrives with no branch and the state `rebasing`; a plain detached HEAD says `detached`.
  else if (answer.state) rows.push({ main: 'detached HEAD', meta: busy || 'branch', title: `${answer.vcs}: no branch is checked out` });
  if (answer.worktree) rows.push({ main: answer.worktree.name, meta: 'worktree', title: answer.worktree.path });
  return rows;
}

// A row that shows and does nothing: not a button, so its tooltip shows (a disabled button's would not).
// What the Repository group draws from a status, as one string: a poll that brings the same string leaves the group be.
function repositorySignature(s) {
  return s ? [s.branch, s.state, s.ahead, s.behind].map((v) => (v == null ? '' : v)).join('|') : '';
}

function repositoryRowHtml(row) {
  return `<div class="ssb-row ssb-row-info" title="${escapeHtml(row.title || '')}"><span class="ssb-row-main">${escapeHtml(row.main)}</span>`
    + `<span class="ssb-row-meta">${escapeHtml(row.meta || '')}</span></div>`;
}

// The Processes group (#834, spec 43), from main's `processUsage` answer for one session: a total, then the session's
// process tree from its root, one row per process with its depth. `{ note }` when there is nothing to draw. CPU is a
// share of all cores; before a second sample on macOS and Linux there is none, and the row says nothing rather than 0.
function sidebarCpu(cpu) {
  if (!Number.isFinite(cpu)) return '';
  return cpu > 0 && cpu < 0.1 ? '<0.1 %' : `${cpu.toFixed(1)} %`;
}
function sidebarBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}
function processRows(answer, sessionId) {
  if (!answer || !answer.ok) return { note: 'The processes could not be read.' };
  if (!answer.supported) return { note: answer.message || 'Processes cannot be measured on this machine.' };
  const s = answer.sessions && answer.sessions[sessionId];
  if (!s || !s.running) return { note: 'This session has no running process.' };
  const meta = (cpu, memory) => [sidebarCpu(cpu), sidebarBytes(memory)].filter(Boolean).join(' · ');
  return {
    // The overview: the three figures a glance wants, one row each (#845). The tree sits folded below it.
    total: [
      { key: 'count', main: 'Processes', meta: String(s.total.count) },
      { key: 'cpu', main: 'CPU', meta: sidebarCpu(s.total.cpu) },
      { key: 'memory', main: 'Memory', meta: sidebarBytes(s.total.memory) },
    ],
    rows: s.rows.map((r) => ({ key: String(r.pid), main: r.name, meta: meta(r.cpu, r.memory), title: `pid ${r.pid}`, depth: Math.min(r.depth, 8) })),
    truncated: s.truncated === true,
    // Beside the fold: the rows it holds, and of how many when the list is cut, so it agrees with the overview.
    treeCount: s.truncated === true ? `${s.rows.length} of ${s.total.count}` : String(s.rows.length),
  };
}

function processRowHtml(row) {
  return `<div class="ssb-row ssb-row-info ssb-proc-row" data-pid="${escapeHtml(row.key)}" title="${escapeHtml(row.title)}" style="padding-left:${4 + row.depth * 10}px">`
    + `<span class="ssb-row-main">${escapeHtml(row.main)}</span><span class="ssb-row-meta">${escapeHtml(row.meta)}</span></div>`;
}
// The overview first, then the tree in a fold of the Context breakdown's kind (`.ssb-sublist`), closed unless `treeOpen`:
// a redraw passes the state the fold had, so a poll or a reload never closes a tree the user opened.
function processesHtml(model, treeOpen = false) {
  if (model.note) return sidebarNote(model.note);
  return model.total.map((t) => `<div class="ssb-row ssb-row-info ssb-proc-total" data-total="${t.key}">`
    + `<span class="ssb-row-main">${escapeHtml(t.main)}</span><span class="ssb-row-meta">${escapeHtml(t.meta)}</span></div>`).join('')
    + `<details class="ssb-sublist ssb-proc-tree" data-list="processes"${treeOpen ? ' open' : ''}>`
    + `<summary><span class="ssb-row-main">Process tree</span><span class="ssb-row-meta">${escapeHtml(model.treeCount)}</span></summary>`
    + `<div class="ssb-proc-list">${model.rows.map(processRowHtml).join('')}</div>`
    + (model.truncated ? sidebarNote('Only the first processes are listed.') : '')
    + '</details>';
}

// The figure a collapsed group shows in its header (#840): the session's total CPU, the share of the context window in
// use. No figure is an empty string, never `0 %`, the same rule the group's body follows.
function processHeadFigure(answer, sessionId) {
  const s = answer && answer.ok && answer.supported && answer.sessions ? answer.sessions[sessionId] : null;
  return s && s.running && s.total ? sidebarCpu(s.total.cpu) : '';
}
function contextHeadFigure(figures) {
  return figures && Number.isFinite(Number(figures.percent)) ? `${Math.round(Number(figures.percent))} %` : '';
}

// The small bar beside it in the collapsed header (#876): the open group's stacked bar where the session answered a
// breakdown, a plain fill at the percentage otherwise, nothing without a figure. Only numbers and the backend's own
// kind and slot words reach the markup, and those are escaped.
function contextHeadBarHtml(figures, breakdown) {
  if (!figures || !Number.isFinite(Number(figures.percent))) return '';
  const segments = breakdown && Array.isArray(breakdown.categories) ? sidebarBarSegments(breakdown, figures.window) : [];
  if (segments.length) {
    return segments.map((s) => `<i${Number.isInteger(s.slot) ? ` data-slot="${s.slot}"` : ''} data-kind="${escapeHtml(s.kind)}" style="width:${s.width}%"></i>`).join('');
  }
  const width = Math.max(0, Math.min(100, Number(figures.percent)));
  return `<i class="ssb-head-fill" style="width:${width}%"></i>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    sidebarStateOf, sidebarSharedStateOf, sameSidebarState, sidebarToggleAction, clampSidebarWidth, withSidebarState, patchSidebarState, rekeySidebarState, orderSidebarGroups, openTaskRows, sidebarContextFigures, sidebarServerRows, sidebarShownWidth,
    instructionGroups, instructionRow, repositoryRows, repositorySignature, repositoryRowHtml, processRows, sidebarCpu, sidebarBytes, processHeadFigure, contextHeadFigure,
    contextHeadBarHtml, sidebarRowActions, sidebarRowModel, sidebarInsertText, sidebarCopyText, sidebarItemHtml,
    sidebarTokens, sidebarCategoryShare, sidebarBarSegments, contextLineDetails,
    SESSION_SIDEBAR_KEEP, SESSION_SIDEBAR_WIDTH,
  };
}

// --- The surface. ---

function readSidebarStates() {
  try { return JSON.parse(localStorage.getItem(SESSION_SIDEBAR_KEY)) || {}; } catch { return {}; }
}
// The global start state for a session with no row (#831). Read at the call, so a changed setting applies to the next mount.
function sidebarDefaultOpen() {
  return typeof appGlobalSettings !== 'undefined' && !!appGlobalSettings && appGlobalSettings.sessionSidebarDefault === 'open';
}
// #892: is one state shared by every session, and that state when one has been written (null until then).
function sidebarSharedOn() {
  return typeof appGlobalSettings !== 'undefined' && !!appGlobalSettings && appGlobalSettings.sessionSidebarShared === true;
}
function sidebarSharedState() {
  return sidebarSharedOn() ? sidebarSharedStateOf(appGlobalSettings.sessionSidebarSharedState) : null;
}
// What a session shows now: the shared state while it is on and written, else the session's own row.
function currentSidebarState(sessionId) {
  const shared = sidebarSharedState();
  if (shared) sidebarSharedApplied = true;
  return shared || sidebarStateOf(readSidebarStates(), sessionId, sidebarDefaultOpen());
}
// Read fresh on every write: a detached window shares this storage and writes its own session's row. While the state is
// shared, the write goes to the shared state instead and the session's own row is left as it was, so switching the
// setting off brings each session's own state back.
function writeSidebarState(sessionId, patch) {
  if (sidebarSharedOn()) {
    commitSidebarSharedState({ ...currentSidebarState(sessionId), ...patch }, openSessions.get(sessionId));
    return;
  }
  const map = readSidebarStates();
  const next = patchSidebarState(map, sessionId, patch, sidebarDefaultOpen(), Date.now());
  try { localStorage.setItem(SESSION_SIDEBAR_KEY, JSON.stringify(next)); } catch { /* the state is a convenience */ }
}

// One shared write: this window's cache first and its other sidebars (`broadcastSettingsChanged` skips the sender,
// renderer.md #146), then a key-scoped merge and the broadcast to the other windows. An unchanged state writes nothing:
// a sidebar drawn with groups open reports them once by itself, and every write is a broadcast to every window.
// `except` is the entry that made the change and already shows it.
function commitSidebarSharedState(state, except) {
  const cache = typeof appGlobalSettings !== 'undefined' && appGlobalSettings ? appGlobalSettings : null;
  if (!cache) return;
  const next = sidebarSharedStateOf(state);
  if (sameSidebarState(next, sidebarSharedStateOf(cache.sessionSidebarSharedState))) return;
  const previous = cache.sessionSidebarSharedState;
  cache.sessionSidebarSharedState = next;
  sessionSidebarApplyShared(except);
  const api = window.api;
  if (!api || typeof api.mergeSetting !== 'function') return;
  Promise.resolve(api.mergeSetting('global', { sessionSidebarSharedState: next }))
    .then(() => { if (typeof api.notifySettingsChanged === 'function') api.notifySettingsChanged(); })
    .catch(() => {
      // Only while nothing newer replaced it, so a later write that worked is not undone.
      if (cache.sessionSidebarSharedState === next) {
        cache.sessionSidebarSharedState = previous;
        sessionSidebarApplyShared(null);
      }
      window.showControlToast?.('The session sidebar state could not be saved.');
    });
}

// In view and able to show it: a grid card holds the session but hides its sidebar.
function sidebarInView(entry) {
  return entry.element.classList.contains('visible') && !entry.element.classList.contains('grid-mode');
}

// --- The issue filters (#830, spec 42). ---
// Main holds one answer per project and query for a while, shared by every pane and window, so this asks it directly;
// the reload button passes `force`. The stored half of the filter (state, the two toggles, the label) is the project's
// row `forgeIssueFilter:<owner>`, shared with the Tasks view; the text is this sidebar's own and never stored. Per entry:
// `sidebarIssueOwner`, `sidebarIssueFilter`, `sidebarIssueAnswer`, `sidebarIssueText`, `sidebarIssuePopOpen`.
const SIDEBAR_ISSUE_STATES = [['open', 'Open'], ['closed', 'Closed'], ['all', 'Open and closed']];

function sidebarIssueOwner(projectPath) {
  return typeof settingsOwnerPath === 'function' ? settingsOwnerPath(projectPath) : projectPath;
}

function sidebarIssueQueryMoved(a, b) {
  const x = issueQueryOf(a);
  const y = issueQueryOf(b);
  return x.state !== y.state || x.assignee !== y.assignee || x.author !== y.author;
}

// The sort choices of the bar (#874), the modes of `sortTasks`, for the tasks and the issues alike.
const SIDEBAR_SORTS = [['newest', 'Newest'], ['oldest', 'Oldest'], ['updated', 'Recently updated'], ['updated_oldest', 'Least recently updated']];

// The local tasks after the bar's text and order (#874). `entry.sidebarTaskRows` is what the last read found.
function sidebarTaskListHtml(entry) {
  const all = entry.sidebarTaskRows || [];
  const filter = entry.sidebarIssueFilter || normalizeIssueFilter(null);
  const rows = sortTasks(filterTasks(all, { text: entry.sidebarIssueText || '' }), filter.sort);
  if (!rows.length) return sidebarNote(all.length ? 'No tasks match the filter.' : 'No open tasks.');
  return rows.slice(0, SESSION_SIDEBAR_ROWS).map((t) => sidebarItem(entry, 'task', t)).join('');
}

// The rows and the count; a keystroke in the text field redraws only these.
function sidebarIssueListParts(entry) {
  const answer = entry.sidebarIssueAnswer;
  const filter = entry.sidebarIssueFilter || normalizeIssueFilter(null);
  if (!answer) return { count: '', list: sidebarNote('Loading…') };
  if (!answer.ok) return { count: '', list: sidebarNote(answer.message || 'The issues could not be read.') };
  const rows = sortTasks(filterIssues(answer.issues, { text: entry.sidebarIssueText || '', label: filter.label }), filter.sort);
  const word = filter.state === 'all' ? '' : ` ${filter.state}`;
  const count = issueCountLabel(rows.length, answer.issues.length, answer.limit) + word;
  const none = filter.state === 'closed' ? 'No closed issues.' : filter.state === 'all' ? 'No issues.' : 'No open issues.';
  const list = rows.length
    ? rows.slice(0, SESSION_SIDEBAR_ROWS).map((i) => sidebarItem(entry, 'issue', i, i.state === 'closed' && filter.state !== 'open' ? 'closed' : '')).join('')
    : sidebarNote(answer.issues.length ? 'No issues match the filter.' : none);
  return { count, list };
}

// The bar under the group's headline (#874): one text field and one order for the tasks and the issues; the Filter
// button and its popover (state, label, the two "me" toggles) only while issues are on, because they are issue-only.
// A toggle the provider cannot answer is not drawn.
function sidebarIssueBarHtml(entry) {
  const issuesOn = entry.sidebarIssuesOn === true;
  const filter = entry.sidebarIssueFilter || normalizeIssueFilter(null);
  const answer = entry.sidebarIssueAnswer;
  const supports = (answer && answer.ok && answer.supports) || entry.sidebarIssueSupports || {};
  const labels = issueLabels(answer && answer.ok ? answer.issues : [], filter.label);
  const active = (filter.state !== 'open' ? 1 : 0) + (filter.assignee ? 1 : 0) + (filter.author ? 1 : 0) + (filter.label ? 1 : 0);
  const open = entry.sidebarIssuePopOpen === true;
  // A stored "on" the provider can no longer answer stays visible, so it can be seen and switched off.
  const toggle = (field, label) => (supports[field] === true || filter[field]
    ? `<button type="button" class="ssb-head-btn ssb-issue-toggle" data-ssb="issue-toggle" data-field="${field}" data-ssb-focus="issue-${field}" aria-pressed="${filter[field] ? 'true' : 'false'}"${supports[field] === true ? '' : ' title="The provider cannot tell this right now, so the list is not filtered by it. Click to switch it off."'}>${label}</button>`
    : '');
  return `
    <div class="ssb-issue-bar">
      <input type="text" class="ssb-issue-search" data-ssb-focus="issue-search" placeholder="${issuesOn ? 'Filter tasks and issues…' : 'Filter tasks…'}" aria-label="${issuesOn ? 'Filter tasks and issues' : 'Filter tasks'}" value="${escapeHtml(entry.sidebarIssueText || '')}">
      <select class="ssb-sort" data-ssb-focus="sort" aria-label="Order" title="Order of the tasks and issues">${SIDEBAR_SORTS.map(([v, l]) => `<option value="${v}"${v === filter.sort ? ' selected' : ''}>${l}</option>`).join('')}</select>
      ${issuesOn ? `<button type="button" class="ssb-head-btn ssb-issue-filter-btn" data-ssb="issue-filter" data-ssb-focus="issue-filter" aria-haspopup="true" aria-expanded="${open ? 'true' : 'false'}" title="State, label and the issues that are yours">Filter${active ? ` · ${active}` : ''}</button>
      <div class="ssb-issue-pop"${open ? '' : ' hidden'}>
        <select class="ssb-issue-state" data-ssb-focus="issue-state" aria-label="Issue state">${SIDEBAR_ISSUE_STATES.map(([v, l]) => `<option value="${v}"${v === filter.state ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <select class="ssb-issue-label" data-ssb-focus="issue-label" aria-label="Label"><option value="">All labels</option>${labels.map((l) => `<option value="${escapeHtml(l)}"${l === filter.label ? ' selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select>
        ${toggle('assignee', 'Assigned to me')}
        ${toggle('author', 'Opened by me')}
      </div>` : ''}
    </div>`;
}

// The forge's own pages (#874): the issue list and a new issue, as two icons. Only for an answer that named them, so a
// project without a known forge has none.
const FORGE_ICON_LIST = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>';
const FORGE_ICON_NEW = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>';
function sidebarForgeButtonsHtml(entry) {
  const answer = entry.sidebarIssueAnswer;
  // A refusal after the remote was read still names the pages (a missing or logged-out CLI).
  const web = answer && answer.web;
  if (!web) return '';
  const name = escapeHtml(answer.provider || 'the forge');
  return '<span class="ssb-forge-btns">'
    + (web.issues ? `<button type="button" class="ssb-head-btn ssb-forge-btn" data-ssb="forge-web" data-which="issues" title="Open the issue list on ${name}" aria-label="Open the issue list on ${name}">${FORGE_ICON_LIST}</button>` : '')
    + (web.newIssue ? `<button type="button" class="ssb-head-btn ssb-forge-btn" data-ssb="forge-web" data-which="newIssue" title="New issue on ${name}" aria-label="New issue on ${name}">${FORGE_ICON_NEW}</button>` : '')
    + '</span>';
}

// Reads only the issues again (#882), through the same button style as the head's other controls.
const FORGE_ICON_REFRESH = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>';

function sidebarIssueHeadHtml(entry, parts = sidebarIssueListParts(entry)) {
  return `<div class="ssb-subhead ssb-issue-head"><span>Issues · read-only</span><span class="ssb-issue-count">${escapeHtml(parts.count)}</span>`
    + `<button type="button" class="ssb-head-btn ssb-forge-btn" data-ssb="issues-refresh" data-ssb-focus="issue-refresh" title="Reload the issues" aria-label="Reload the issues">${FORGE_ICON_REFRESH}</button>`
    + `${sidebarForgeButtonsHtml(entry)}</div>`;
}

function sidebarIssuesBlockHtml(entry) {
  const parts = sidebarIssueListParts(entry);
  return sidebarIssueHeadHtml(entry, parts) + `<div class="ssb-issue-list">${parts.list}</div>`;
}

// The whole group (#874): the bar, the tasks, and the issues while they are on.
function sidebarTasksGroupHtml(entry) {
  return sidebarIssueBarHtml(entry)
    + `<div class="ssb-task-list">${sidebarTaskListHtml(entry)}</div>`
    + (entry.sidebarIssuesOn === true ? sidebarIssuesBlockHtml(entry) : '');
}

// The tasks and the issues after a keystroke or another order, without the bar (it holds the caret).
function sidebarRedrawIssueList(entry) {
  const root = entry.sidebar;
  const tasks = root && root.querySelector('.ssb-task-list');
  if (tasks) tasks.innerHTML = sidebarTaskListHtml(entry);
  const list = root && root.querySelector('.ssb-issue-list');
  if (!list) return;
  const parts = sidebarIssueListParts(entry);
  list.innerHTML = parts.list;
  const count = root.querySelector('.ssb-issue-count');
  if (count) count.textContent = parts.count;
}

function sidebarReloadTasksGroup(entry) {
  const root = entry.sidebar;
  const section = root && root.querySelector('.ssb-group[data-group="tasks"]');
  if (!section || !section.open) return;
  if (!sidebarInView(entry)) { section._stale = true; return; }
  loadSidebarGroup(entry, SESSION_SIDEBAR_GROUPS.find((g) => g.id === 'tasks'), section);
}

// --- The issues list follows main's refresh timer while it is open and shown (#882, spec 42). ---
// The Tasks & notes group follows only while it is open, not hidden, its sidebar in view and the window not hidden; any
// other state unfollows, so main starts nothing for it. Each follow says how closely it is watched: `focused` (the window
// has focus and this is the active session) or `visible`; main picks the fastest of its followers and sends
// `forge-issues-updated` when it read, and this window then asks for the list again (main's cache answers: one CLI start
// however many sidebars). Becoming visible or active reads again when the last read is older than 2 minutes. The
// follower id is the entry's own, so a re-key moves nothing. Per entry: `sidebarIssueFollowerId`, `sidebarIssuesReadAt`.
const SIDEBAR_ISSUES_REREAD_MS = 2 * 60 * 1000;
const sidebarIssueFollowers = new Map();   // entry -> { sig, projectPath, query }
let sidebarIssuesOff = null;
let sidebarIssueFollowerCount = 0;

function sidebarIssuesDesired(entry) {
  const root = entry.sidebar;
  const section = root && root.querySelector('.ssb-group[data-group="tasks"]');
  if (!section || !section.open || sidebarSectionHidden(section) || !sidebarInView(entry)) return null;
  if (entry.sidebarIssuesOn !== true || document.hidden) return null;
  const id = sidebarSessionOf(entry).sessionId;
  if (openSessions.get(id) !== entry) return null;
  const projectPath = sidebarSessionOf(entry).projectPath;
  if (!projectPath) return null;
  const focused = typeof document.hasFocus === 'function' && document.hasFocus()
    && typeof activeSessionId !== 'undefined' && activeSessionId === id;
  return { projectPath, query: issueQueryOf(entry.sidebarIssueFilter), tier: focused ? 'focused' : 'visible' };
}

function sidebarIssuesRelease() {
  if (!sidebarIssueFollowers.size && sidebarIssuesOff) { sidebarIssuesOff(); sidebarIssuesOff = null; }
}

function sidebarUnfollowIssues(entry) {
  if (!sidebarIssueFollowers.has(entry)) return;
  sidebarIssueFollowers.delete(entry);
  if (window.api && typeof window.api.forgeIssuesUnfollow === 'function') window.api.forgeIssuesUnfollow(entry.sidebarIssueFollowerId);
  sidebarIssuesRelease();
}

// Follow, change the tier or the query, or unfollow: whatever the entry's state asks for now. Asking main again with
// the same record sends nothing.
function sidebarIssuesSync(entry) {
  const want = sidebarIssuesDesired(entry);
  if (!want) { sidebarUnfollowIssues(entry); return; }
  if (!window.api || typeof window.api.forgeIssuesFollow !== 'function') return;
  const sig = JSON.stringify([want.projectPath, want.query, want.tier]);
  const have = sidebarIssueFollowers.get(entry);
  if (have && have.sig === sig) return;
  if (!entry.sidebarIssueFollowerId) entry.sidebarIssueFollowerId = `issues-${++sidebarIssueFollowerCount}`;
  const record = { sig, projectPath: want.projectPath, query: want.query };
  sidebarIssueFollowers.set(entry, record);
  // Subscribed before the ask, so a notice that follows the answer is not missed; given back when nothing follows.
  if (!sidebarIssuesOff && typeof window.api.onForgeIssuesUpdated === 'function') {
    const off = window.api.onForgeIssuesUpdated(sidebarOnIssuesUpdated);
    sidebarIssuesOff = typeof off === 'function' ? off : null;
  }
  // Main may refuse: then nothing claims a follow that does not exist.
  const refused = () => { if (sidebarIssueFollowers.get(entry) === record) { sidebarIssueFollowers.delete(entry); sidebarIssuesRelease(); } };
  Promise.resolve(window.api.forgeIssuesFollow(entry.sidebarIssueFollowerId, want.projectPath, want.query, want.tier))
    .then((res) => { if (!res || res.ok !== true) refused(); }, refused);
}

function sidebarOnIssuesUpdated(payload) {
  if (!payload) return;
  for (const [entry, record] of [...sidebarIssueFollowers]) {
    if (record.projectPath !== payload.projectPath || JSON.stringify(record.query) !== JSON.stringify(issueQueryOf(payload.query))) continue;
    if (!sidebarIssuesDesired(entry)) { sidebarIssuesSync(entry); continue; }
    sidebarReadIssues(entry, false);
  }
}

// Reads ONLY the issues and redraws only their head and list; the tasks, the bar and the group's other reads stay.
// `force` is the refresh control (main's cache is skipped); a notice asks without it and is answered from main's one read.
// `background` marks a re-read the window made on its own (not the user's click or a notice): main starts no CLI for it
// while the user is away and answers what it holds, or nothing (null), which leaves the list as it is.
async function sidebarReadIssues(entry, force, background = false) {
  if (!entry.sidebar || entry.sidebarIssuesOn !== true) return;
  const projectPath = sidebarSessionOf(entry).projectPath;
  if (!projectPath) return;
  const owner = entry.sidebarIssueOwner;
  const token = (entry.sidebarIssueReadToken || 0) + 1;
  entry.sidebarIssueReadToken = token;
  const readAtBefore = entry.sidebarIssuesReadAt;
  entry.sidebarIssuesReadAt = Date.now();   // at the start too: a burst of class changes must not queue reads
  let issues;
  try {
    issues = await window.api.forgeIssuesList(projectPath, issueQueryOf(entry.sidebarIssueFilter), background ? { force: false, background: true } : { force: force === true });
  } catch {
    issues = { enabled: true, ok: false, message: 'The issues could not be read.' };
  }
  // Declined (null), or a background read that failed: the list on screen and the read time stay as they were, so the
  // next becoming-active still re-reads. An answer main marks `held` (an old one, handed over while the user is away)
  // is drawn, but is not a read: the read time stays too.
  if (entry.sidebarIssueReadToken === token && (issues === null || (background && !(issues && issues.enabled && issues.ok)))) {
    entry.sidebarIssuesReadAt = readAtBefore;
    return;
  }
  const heldOnly = !!(issues && issues.held === true);
  if (entry.sidebarIssueReadToken !== token || !entry.sidebar || entry.sidebarIssueOwner !== owner || entry.sidebarIssuesOn !== true) return;
  entry.sidebarIssueAnswer = issues && issues.enabled ? issues : { ok: false, message: 'The issues could not be read.' };
  if (entry.sidebarIssueAnswer.ok && entry.sidebarIssueAnswer.supports) entry.sidebarIssueSupports = entry.sidebarIssueAnswer.supports;
  entry.sidebarIssuesReadAt = heldOnly ? readAtBefore : Date.now();
  const root = entry.sidebar;
  const head = root.querySelector('.ssb-issue-head');
  const list = root.querySelector('.ssb-issue-list');
  if (!head || !list) return;
  const mark = sidebarFocusMark(root);
  const parts = sidebarIssueListParts(entry);
  head.outerHTML = sidebarIssueHeadHtml(entry, parts);
  list.innerHTML = parts.list;
  if (mark) sidebarRestoreFocus(root, mark);
}

// Becoming visible or active: read again only when the last read is older than 2 minutes.
function sidebarIssuesRereadIfOld(entry) {
  if (!sidebarIssuesDesired(entry)) return;
  if (Date.now() - (entry.sidebarIssuesReadAt || 0) >= SIDEBAR_ISSUES_REREAD_MS) sidebarReadIssues(entry, false, true);
}

// Every sidebar's tier is asked again; only the ACTIVE session's sidebar may re-read (the others did not become active).
function sidebarIssuesRefreshAll(becameActive) {
  if (typeof openSessions === 'undefined') return;
  const activeId = typeof activeSessionId !== 'undefined' ? activeSessionId : null;
  for (const entry of openSessions.values()) {
    if (!entry || !entry.sidebar) continue;
    sidebarIssuesSync(entry);
    if (becameActive && activeId && sidebarSessionOf(entry).sessionId === activeId) sidebarIssuesRereadIfOld(entry);
  }
}

// The window's focus, its visibility and (from app.js, `setActiveSession`) the active session decide the tier.
function sessionSidebarActiveChanged() { sidebarIssuesRefreshAll(true); }
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => sidebarIssuesRefreshAll(true));
  window.addEventListener('blur', () => sidebarIssuesRefreshAll(false));
  document.addEventListener('visibilitychange', () => sidebarIssuesRefreshAll(!document.hidden));
}

// A filter change in this sidebar: stored, told to the rest of this window, and read again when the CLI half moved.
async function sidebarChangeIssueFilter(entry, patch) {
  const before = entry.sidebarIssueFilter || normalizeIssueFilter(null);
  const owner = entry.sidebarIssueOwner;
  let next = normalizeIssueFilter({ ...before, ...patch });
  entry.sidebarIssueFilter = next;
  let saved = false;
  try {
    // Only the changed field is written, merged in main: another window's change to another field survives.
    next = await patchIssueFilter(window.api, owner, patch);
    saved = true;
  } catch {
    if (window.showControlToast) window.showControlToast({ message: 'The issue filter could not be saved.' });
  }
  if (entry.sidebarIssueOwner !== owner) return; // the session moved to another project meanwhile
  entry.sidebarIssueFilter = next;
  // Only a stored change is announced: the other view must not show what the row does not hold.
  if (saved) window.dispatchEvent(new CustomEvent(ISSUE_FILTER_EVENT, { detail: { owner, filter: next, from: 'sidebar', sessionId: entry.session.sessionId } }));
  if (sidebarIssueQueryMoved(before, next)) sidebarReloadTasksGroup(entry);
  else {
    const bar = entry.sidebar && entry.sidebar.querySelector('.ssb-issue-bar');
    if (bar) bar.outerHTML = sidebarIssueBarHtml(entry);
    sidebarRedrawIssueList(entry);
    sidebarRestoreFocus(entry.sidebar, patch.label !== undefined ? 'issue-label' : patch.sort !== undefined ? 'sort' : null);
  }
}

// Another view in this window changed the filter: every sidebar on that project follows. Not under node: the tests
// require this file for its pure half. The event name is spelled here, not read from tasks-logic.js, because that
// file loads after this one and this line runs at parse time; `test/tasks-logic.test.js` checks the two agree.
if (typeof window !== 'undefined') window.addEventListener('switchboard:issue-filter', (e) => {
  const d = e.detail || {};
  if (typeof openSessions === 'undefined') return;
  for (const entry of openSessions.values()) {
    if (!entry.sidebar || entry.sidebarIssueOwner !== d.owner) continue;
    if (d.from === 'sidebar' && d.sessionId === entry.session.sessionId) continue;
    const before = entry.sidebarIssueFilter || normalizeIssueFilter(null);
    entry.sidebarIssueFilter = normalizeIssueFilter(d.filter);
    if (sidebarIssueQueryMoved(before, entry.sidebarIssueFilter)) { sidebarReloadTasksGroup(entry); continue; }
    const bar = entry.sidebar.querySelector('.ssb-issue-bar');
    if (bar) bar.outerHTML = sidebarIssueBarHtml(entry);
    sidebarRedrawIssueList(entry);
  }
});

// A redraw takes the caret with it; the control marked `data-ssb-focus` that had it gets it back, with its selection.
function sidebarFocusMark(root) {
  const active = document.activeElement;
  if (!root || !active || !root.contains(active) || !active.dataset || !active.dataset.ssbFocus) return null;
  return { id: active.dataset.ssbFocus, sel: typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null };
}
function sidebarRestoreFocus(root, markOrId) {
  if (!root || !markOrId) return;
  const mark = typeof markOrId === 'string' ? { id: markOrId, sel: null } : markOrId;
  const el = root.querySelector(`[data-ssb-focus="${mark.id}"]`);
  if (!el) return;
  el.focus();
  if (mark.sel) { try { el.setSelectionRange(mark.sel[0], mark.sel[1]); } catch { /* not a text field */ } }
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
// A row of one of the kinds that insert: remembered under its key, so a click finds the object without the markup
// carrying it. Keys are per kind and id, so groups drawn at different times do not collide.
function sidebarItem(entry, kind, src, meta = '', index = 0) {
  const model = sidebarRowModel(kind, src, meta, index);
  if (!entry.sidebarRows) entry.sidebarRows = new Map();
  entry.sidebarRows.set(model.key, { kind, src });
  return sidebarItemHtml(model);
}
const sidebarNote = (text) => `<div class="ssb-note">${escapeHtml(text)}</div>`;

// The breakdown under the Context group's figures (#758, spec 43): one bar, a row per category, then the lists a
// user can save in. The group redraws with every `context` op, so a list keeps the open state it had. A list that
// nobody opened costs only its markup; the rows are text the CLI wrote, and all of it is escaped.
function sidebarBreakdownHtml(entry, breakdown, window) {
  const section = entry.sidebar && entry.sidebar.querySelector('.ssb-group[data-group="context"]');
  const open = new Set(section ? [...section.querySelectorAll('.ssb-sublist[open]')].map((d) => d.dataset.list) : []);
  const slotAttr = (c) => (Number.isInteger(c.slot) ? ` data-slot="${c.slot}"` : '');
  const bar = sidebarBarSegments(breakdown, window).map((s) => `<i${slotAttr(s)} data-kind="${escapeHtml(s.kind)}" `
    + `style="width:${s.width}%" title="${escapeHtml(`${s.label}: ${s.tokens.toLocaleString()}`)}"></i>`).join('');
  const rows = breakdown.categories.map((c) => `<div class="ssb-cat" data-kind="${escapeHtml(c.kind)}">`
    + `<span class="ssb-swatch"${slotAttr(c)} data-kind="${escapeHtml(c.kind)}"></span>`
    + `<span class="ssb-row-main">${escapeHtml(c.label)}</span>`
    + `<span class="ssb-row-meta">${escapeHtml(sidebarTokens(c.tokens))}</span>`
    + `<span class="ssb-cat-share">${escapeHtml(sidebarCategoryShare(c, window))}</span></div>`).join('');
  const lists = breakdown.lists.map((l) => `<details class="ssb-sublist" data-list="${escapeHtml(l.id)}"${open.has(l.id) ? ' open' : ''}>`
    + `<summary><span class="ssb-row-main">${escapeHtml(l.label)}</span><span class="ssb-row-meta">${l.rows.length}</span></summary>`
    + l.rows.map((r) => {
      const meta = `${sidebarTokens(r.tokens)}${r.deferred ? ' · deferred' : ''}`;
      // A memory file carries its neutral `path` (the backend's answer); `title` stays the tooltip. It opens read-only (#822).
      if (l.id === 'memory' && typeof r.path === 'string' && r.path) return instructionRow({ name: r.name, path: r.path }, meta);
      return sidebarRow(r.name, meta, `disabled${r.title ? ` title="${escapeHtml(r.title)}"` : ''}`);
    }).join('')
    + '</details>').join('');
  return `<div class="ssb-stack">${bar}</div><div class="ssb-cats">${rows}</div>${lists}`;
}

// A click on a file row: the file opens read-only in the session's preview panel, whose Edit button leads to its page
// in Settings. The sidebar keeps no path of its own beyond what the row carries, and the caret goes back to the session.
async function sessionSidebarOpenInstruction(entry, row) {
  if (!entry || !row || !row.path || typeof openFileInPanel !== 'function') return;
  const projectPath = sidebarSessionOf(entry).projectPath || null;
  try {
    await openFileInPanel(entry.session.sessionId, row.path, { readOnly: true, editInSettings: { projectPath } });
  } finally { sidebarSessionFocus(entry); }
}

// One way to put text in the prompt, the pickers' own (`insertResolvedText`), and the caret goes back to the session so
// Enter, meant for it, does not press this row again (requirement 8).
function sidebarInsert(entry, text, opts) {
  const done = typeof insertResolvedText === 'function' && text
    ? insertResolvedText(entry.terminal, entry.session.sessionId, text, { trailing: ' ', ...opts }) : false;
  sidebarSessionFocus(entry);
  return done;
}

// A click on a row of an inserting kind. The templates are settings, read when the click comes; Shift leaves them out.
async function sessionSidebarRowClick(entry, key, plain) {
  const held = entry.sidebarRows && entry.sidebarRows.get(key);
  if (!held) return;
  const { kind, src } = held;
  let settings = null;
  if (kind === 'skill' || kind === 'task') {
    try { settings = await window.api.getEffectiveSettings(sidebarSessionOf(entry).projectPath || null); } catch { settings = null; }
  }
  const template = kind === 'skill' ? settings && settings.skillInsertTemplate
    : kind === 'task' ? settings && settings.taskInsertTemplate : '';
  const text = sidebarInsertText(kind, src, { plain, template });
  if (kind === 'skill') {
    // As the skill picker: it is asked to run unless the setting says otherwise, and a text insert says so.
    const submit = !(settings && settings.submitSkillOnPick === false);
    sidebarInsert(entry, text, { trailing: submit ? '' : ' ', submit });
    if (!src.invocation) window.showControlToast?.({ message: `\u201C${src.name}\u201D inserted as text \u2014 this CLI has no skill command`, timeoutMs: 3000 });
    return;
  }
  sidebarInsert(entry, text);
}

// An issue read-only in the session's preview (#874): read on the click, never ahead of it, and drawn as Markdown.
async function sessionSidebarPreviewIssue(entry, src) {
  const session = sidebarSessionOf(entry);
  if (!session.projectPath || src.number == null || typeof openTextInPanel !== 'function') return;
  let res;
  try { res = await window.api.forgeIssueRead(session.projectPath, src.number); } catch { res = null; }
  if (!res || !res.ok || !res.issue) {
    window.showControlToast?.({ message: (res && res.message) || 'The issue could not be read.', timeoutMs: 3000 });
    return;
  }
  openTextInPanel(entry.session.sessionId, { name: `Issue #${res.issue.number}.md`, content: issuePreviewMarkdown(res.issue, res.provider) });
}

// A hover button. Open leads out of the sidebar to the kind's own view; none of these touch the prompt.
async function sessionSidebarRowAct(entry, key, act) {
  const held = entry.sidebarRows && entry.sidebarRows.get(key);
  if (!held) return;
  const { kind, src } = held;
  const session = sidebarSessionOf(entry);
  if (act === 'copy') {
    const text = sidebarCopyText(kind, src);
    if (!text) return;
    try { await window.api.writeClipboard(text); window.showControlToast?.({ message: 'Copied.', timeoutMs: 1500 }); } catch { /* nothing to copy into */ }
    return;
  }
  if (act === 'open') {
    if (kind === 'task') { if (typeof openTasksView === 'function') openTasksView({ projectPath: session.projectPath }, 'Session project'); }
    else if (kind === 'issue') window.api.openExternal(src.url);
    else if (kind === 'handoff' && typeof openFileInPanel === 'function') openFileInPanel(entry.session.sessionId, src.filePath);
    return;
  }
  if (act === 'preview' && kind === 'issue') { sessionSidebarPreviewIssue(entry, src); return; }
  if (act === 'edit' && kind === 'skill') {
    const projectPath = session.projectPath || null;
    const project = src.scope === 'project' && projectPath;
    window.api.openSettingsWindow(project ? 'project' : 'global', project ? projectPath : null, { cat: 'plugins-skills', item: src.id });
  }
}

// A click on an MCP server row: the server manager, as `/mcp` opens it in the conversation view.
async function sessionSidebarOpenServers(entry) {
  if (!entry.conversation || entry.conversation.exited?.() || typeof openSessionServers !== 'function') return;
  await openSessionServers(entry.session.sessionId, { onClose: () => sidebarSessionFocus(entry) });
}

// The Repository group follows the VCS poller (#858): main pushes a status for each directory the poller watches, and a
// push that changes what the group draws reads it again from the poller's cache. There is no timer of its own. The
// subscription lives while the group is open and shown: closing it, hiding it and closing the sidebar end it.
const sidebarVcsFollowers = new Set();   // entries whose open Repository group follows the poller

// Tells main which directories those are, so it polls them whether or not the chip is on.
function sidebarReportFollowed() {
  if (!window.api || typeof window.api.vcsFollow !== 'function') return;
  const cwds = [...sidebarVcsFollowers].map((e) => sidebarSessionOf(e).projectPath).filter(Boolean);
  window.api.vcsFollow([...new Set(cwds)]);
}

// ONE subscription per window however many sessions follow: a listener each would pass Node's limit with ten sessions.
// It is made for the first follower and removed with the last.
let sidebarVcsOff = null;

function sidebarOnVcsStatus(payload) {
  for (const entry of [...sidebarVcsFollowers]) {
    const root = entry.sidebar;
    const section = root && root.querySelector('.ssb-group[data-group="repository"]');
    if (!section || !section.open || sidebarSectionHidden(section)) { sidebarUnfollowVcs(entry); continue; }
    if (!payload || !payload.summary || payload.cwd !== sidebarSessionOf(entry).projectPath) continue;
    if (repositorySignature(payload.summary) === entry.sidebarRepoSig) continue;
    if (!sidebarInView(entry)) { section._stale = true; continue; }
    loadSidebarGroup(entry, SESSION_SIDEBAR_GROUPS.find((g) => g.id === 'repository'), section);
  }
}

function sidebarFollowVcs(entry) {
  if (sidebarVcsFollowers.has(entry) || !window.api || typeof window.api.onVcsStatusChanged !== 'function') return;
  if (!sidebarVcsFollowers.size) {
    const off = window.api.onVcsStatusChanged(sidebarOnVcsStatus);
    sidebarVcsOff = typeof off === 'function' ? off : null;
  }
  sidebarVcsFollowers.add(entry);
  sidebarReportFollowed();
}

function sidebarUnfollowVcs(entry) {
  if (!sidebarVcsFollowers.delete(entry)) return;
  if (!sidebarVcsFollowers.size && sidebarVcsOff) { sidebarVcsOff(); sidebarVcsOff = null; }
  sidebarReportFollowed();
}

// The Changes group (#870, spec 47). Rows, states and markup are lib/session-changes-rows.js (pure); this is the surface.
//
// It follows main while it is open and shown: main follows the session's folder with the poller itself and sends
// `session-changes-updated` when the status or a scan moved, so the renderer never calls `vcsFollow` for it. Closing the
// group, hiding it, closing the sidebar and destroying the tab each end the subscription. A closed group reads only the
// header figure, from the database.
const sidebarChangesFollowers = new Map();   // entry -> the session id main follows it under (a re-key unfollows the old one)
const sidebarChangesPending = new Set();     // entries whose follow is out; main may refuse it, and the group may close meanwhile
let sidebarChangesOff = null;
const sidebarChangesFigureAt = new WeakMap();   // entry -> when the figure was last asked, so a busy index asks at most so often
const SIDEBAR_CHANGES_FIGURE_MS = 2000;

function sidebarChangesGroup() {
  return SESSION_SIDEBAR_GROUPS.find((g) => g.id === 'changes');
}

// Is the group open and shown right now, with the session still this entry's? The one question every follow asks again
// after an await: a read or a follow that was out when the group closed or hid must not leave main following it.
function sidebarChangesWanted(entry) {
  const section = entry.sidebar && entry.sidebar.querySelector('.ssb-group[data-group="changes"]');
  return !!(section && section.open && !sidebarSectionHidden(section) && openSessions.get(sidebarSessionOf(entry).sessionId) === entry);
}

function sidebarOnChangesUpdated(payload) {
  const id = payload && payload.sessionId;
  for (const [entry, followedId] of [...sidebarChangesFollowers]) {
    const root = entry.sidebar;
    const section = root && root.querySelector('.ssb-group[data-group="changes"]');
    if (!section || !section.open || sidebarSectionHidden(section)) { sidebarUnfollowChanges(entry); continue; }
    // Matched against what main follows, not the entry's current id: after a re-key the old id is what is followed.
    if (!id || followedId !== id) continue;
    if (!sidebarInView(entry)) { section._stale = true; continue; }
    loadSidebarGroup(entry, sidebarChangesGroup(), section);
  }
}

async function sidebarFollowChanges(entry) {
  if (!window.api || typeof window.api.sessionChangesFollow !== 'function' || sidebarChangesPending.has(entry)) return;
  const id = sidebarSessionOf(entry).sessionId;
  if (sidebarChangesFollowers.get(entry) === id) return;
  sidebarChangesPending.add(entry);
  if (sidebarChangesFollowers.has(entry)) sidebarUnfollowChanges(entry);   // re-keyed: the old id is not this session any more
  // Subscribed before the ask, so a push that follows the answer is not missed; given back when nothing follows.
  if (!sidebarChangesOff && typeof window.api.onSessionChangesUpdated === 'function') {
    const off = window.api.onSessionChangesUpdated(sidebarOnChangesUpdated);
    sidebarChangesOff = typeof off === 'function' ? off : null;
  }
  const release = () => { if (!sidebarChangesFollowers.size && !sidebarChangesPending.size && sidebarChangesOff) { sidebarChangesOff(); sidebarChangesOff = null; } };
  let res = null;
  try { res = await window.api.sessionChangesFollow(id); } catch { res = null; }
  sidebarChangesPending.delete(entry);
  // Main refused (a session it does not know): not recorded, so nothing claims a follow that does not exist.
  if (!res || res.ok !== true) { release(); return; }
  // The group closed, hid or moved on while the ask was out: main follows now, so say it stops.
  if (!sidebarChangesWanted(entry) || sidebarSessionOf(entry).sessionId !== id) {
    if (typeof window.api.sessionChangesUnfollow === 'function') window.api.sessionChangesUnfollow(id);
    release();
    return;
  }
  sidebarChangesFollowers.set(entry, id);
}

function sidebarUnfollowChanges(entry) {
  if (!sidebarChangesFollowers.has(entry)) return;
  const id = sidebarChangesFollowers.get(entry);
  sidebarChangesFollowers.delete(entry);
  if (window.api && typeof window.api.sessionChangesUnfollow === 'function') window.api.sessionChangesUnfollow(id);
  if (!sidebarChangesFollowers.size && !sidebarChangesPending.size && sidebarChangesOff) { sidebarChangesOff(); sidebarChangesOff = null; }
}

// The collapsed header's figure: the database only, no git (V1: always "Since last review"). Asked when the sidebar is
// shown, when the sessions were refreshed and when the group comes back from hidden; not while the group is open (its
// body draws the same figure from its own answer). A sidebar out of view asks when it is revealed; a busy index asks at
// most every SIDEBAR_CHANGES_FIGURE_MS, and one trailing ask follows a call that was held back, so the last change shows.
function sidebarUpdateChangesHead(entry, force = false) {
  const section = entry.sidebar && entry.sidebar.querySelector('.ssb-group[data-group="changes"]');
  if (!section || section.open || sidebarSectionHidden(section)) return;
  if (!window.api || typeof window.api.sessionChangesSummary !== 'function') return;
  if (!sidebarInView(entry)) { entry.sidebarChangesFigureStale = true; return; }
  const now = Date.now();
  const last = sidebarChangesFigureAt.get(entry) || 0;
  if (!force && now - last < SIDEBAR_CHANGES_FIGURE_MS) {
    if (!entry.sidebarChangesFigureTimer) {
      entry.sidebarChangesFigureTimer = setTimeout(() => {
        entry.sidebarChangesFigureTimer = null;
        if (entry.sidebar) sidebarUpdateChangesHead(entry, true);
      }, SIDEBAR_CHANGES_FIGURE_MS - (now - last));
    }
    return;
  }
  sidebarChangesFigureAt.set(entry, now);
  entry.sidebarChangesFigureStale = false;
  const id = sidebarSessionOf(entry).sessionId;
  Promise.resolve(window.api.sessionChangesSummary(id)).catch(() => null).then((answer) => {
    if (entry.sidebar && sidebarSessionOf(entry).sessionId === id) sidebarSetHeadFigure(entry, 'changes', changesHeadFigure(answer));
  });
}

// A click on a row opens Details at that item (E5). The Details window is T12's: until it exists this asks for it through
// one binding and does nothing when there is none. `at` is `{ id }` of a row, or `{ pick: true }` for "Pick entries".
function sessionSidebarOpenChangesDetails(entry, at) {
  const id = sidebarSessionOf(entry).sessionId;
  if (window.api && typeof window.api.sessionChangesOpenDetails === 'function') window.api.sessionChangesOpenDetails(id, at || {});
}

// The range and the view are kept per session by main (V4); a change is written, then the group reads again.
async function sidebarChangesSetView(entry, patch) {
  const id = sidebarSessionOf(entry).sessionId;
  const current = entry.sidebarChangesRequest || { range: 'since-review', view: 'all', pickFrom: null, pickTo: null };
  if (patch.range === 'pick') {
    // The picks are made on Details' timeline strip; the select goes back to what is kept.
    sessionSidebarOpenChangesDetails(entry, { pick: true });
  } else {
    try { await window.api.sessionChangesView(id, { ...current, ...patch }); } catch { /* the group reads what is kept */ }
  }
  const section = entry.sidebar && entry.sidebar.querySelector('.ssb-group[data-group="changes"]');
  if (section && section.open) loadSidebarGroup(entry, sidebarChangesGroup(), section);
}

async function sidebarChangesClear(entry, missing) {
  const id = sidebarSessionOf(entry).sessionId;
  let res = null;
  try { res = await window.api.sessionChangesClear(id, { missing: missing === true }); } catch { res = null; }
  if (res && res.ok) window.showControlToast?.({ message: changesClearedText(entry.sidebarChangesView), timeoutMs: 2000 });
  else window.showControlToast?.({ message: 'It could not be marked as reviewed.', timeoutMs: 3000 });
  const section = entry.sidebar && entry.sidebar.querySelector('.ssb-group[data-group="changes"]');
  if (section && section.open) loadSidebarGroup(entry, sidebarChangesGroup(), section);
}

// A row of the Changes group: a click opens Details at it, Shift+click puts the path or the short SHA in the prompt (E5).
function sessionSidebarChangesRowClick(entry, key, shift) {
  const row = entry.sidebarChangeRows && entry.sidebarChangeRows.get(key);
  if (!row) return;
  if (shift) { if (row.insert) sidebarInsert(entry, row.insert); return; }
  sessionSidebarOpenChangesDetails(entry, { id: row.id });
}

async function sessionSidebarChangesRowAct(entry, key, act) {
  const row = entry.sidebarChangeRows && entry.sidebarChangeRows.get(key);
  if (!row) return;
  if (act === 'copy') {
    if (!row.copy) return;
    try { await window.api.writeClipboard(row.copy); window.showControlToast?.({ message: 'Copied.', timeoutMs: 1500 }); } catch { /* nothing to copy into */ }
    return;
  }
  if (act === 'open' && row.kind === 'file' && typeof openFileInPanel === 'function' && typeof window.api.sessionChangesOpen === 'function') {
    // Main names the file: a row's path is relative to the checkout root, which only main knows (a session may run in a
    // subfolder). A row that is no longer listed or lies outside the checkout is refused with a sentence.
    let res = null;
    try { res = await window.api.sessionChangesOpen(sidebarSessionOf(entry).sessionId, row.id); } catch { res = null; }
    if (res && res.ok && res.path) openFileInPanel(entry.session.sessionId, res.path);
    else window.showControlToast?.({ message: (res && res.error) || 'The file could not be opened.', timeoutMs: 3000 });
  }
}

// Each group reads when it is open, in view and not hidden (#835), and answers markup. All of it is escaped: a task
// title, an issue and a skill name are all text somebody else may have written. The groups' NAMES are in
// lib/sidebar-groups.js, which the settings window loads too; these ids are the same ones in the same order.
const SESSION_SIDEBAR_GROUPS = [
  {
    // First, as the owner decided (#821): where the session runs. Read from the poller's cache, else one status run.
    id: 'repository',
    async load(entry, draw, force, current = () => true) {
      const cwd = sidebarSessionOf(entry).projectPath;
      if (!cwd) return sidebarNote('This session has no project.');
      // The reload button reads the status afresh; an open reads the poller's cache when it has one.
      const answer = await window.api.vcsDescribe(cwd, { fresh: force === true });
      if (!answer || !answer.ok) return sidebarNote('The repository could not be read.');
      entry.sidebarRepoSig = repositorySignature(answer);
      // Only while this read is still the latest and the session is still open: closing the session or the sidebar
      // during the await has already unfollowed, and a late follow would never be ended.
      if (current() && entry.sidebar && openSessions.get(sidebarSessionOf(entry).sessionId) === entry) sidebarFollowVcs(entry);
      const rows = repositoryRows(answer);
      if (!rows) return sidebarNote('This project is not under version control.');
      return rows.length ? rows.map(repositoryRowHtml).join('') : sidebarNote('Nothing to show.');
    },
  },
  {
    // #870 (spec 47): what the session changed since the last review. Closed, it reads only the header figure (database);
    // open and shown, one read of main's view model, and it follows main's notices for this session.
    id: 'changes',
    async load(entry, draw, force, current = () => true) {
      const id = sidebarSessionOf(entry).sessionId;
      const view = await Promise.resolve(window.api.sessionChanges(id, force === true ? { fresh: true } : {})).catch(() => null);
      if (!current()) return '';
      entry.sidebarChangesView = view;
      if (view && view.ok && view.request) entry.sidebarChangesRequest = view.request;
      sidebarSetHeadFigure(entry, 'changes', changesHeadFigure(view));
      // Asked again here: the group may have closed or hidden while the read was out, and main must not follow it then.
      if (sidebarChangesWanted(entry)) sidebarFollowChanges(entry);
      // The split blocks keep what the user opened across a redraw; a block never drawn opens when it is the newest.
      const root = entry.sidebar;
      const drawn = root ? [...root.querySelectorAll('.ssb-group[data-group="changes"] .ssb-block')] : [];
      const model = changesRowModel(view, {
        open: new Set(drawn.filter((d) => d.open).map((d) => d.dataset.block)),
        seen: new Set(drawn.map((d) => d.dataset.block)),
      });
      entry.sidebarChangeRows = changesRowIndex(model);
      return changesModelHtml(model);
    },
  },
  {
    // #834: what the session costs the machine. Measured in main, one sample for every session, and only while the
    // sidebar is in view: the read here starts the poll, `sidebarTickProcesses` keeps it going, and a collapsed group
    // keeps it going on a slower cadence for the figure in its header (#840).
    id: 'processes',
    async load(entry, draw, force, current = () => true) {
      const sessionId = sidebarSessionOf(entry).sessionId;
      const answer = await Promise.resolve(window.api.processUsage([sessionId])).catch(() => null);
      if (current()) {
        sidebarSetHeadFigure(entry, 'processes', processHeadFigure(answer, sessionId));
        sidebarScheduleProcesses(entry);
      }
      return processesHtml(processRows(answer, sessionId), sidebarProcessTreeOpen(entry));
    },
  },
  {
    id: 'context',
    async load(entry) {
      const fromView = entry.conversation && entry.conversation.context ? entry.conversation.context() : null;
      const session = sidebarSessionOf(entry);
      const figures = sidebarContextFigures(fromView, session.contextFill, session.lastModel);
      // The header's figure and its bar (#876) are written in one place.
      sidebarUpdateContextHead(entry);
      if (!figures) return sidebarNote('No figure for this session yet.');
      const percent = Math.max(0, Math.min(100, figures.percent));
      const tokens = Number.isFinite(Number(figures.tokens)) && Number.isFinite(Number(figures.window))
        ? `${Number(figures.tokens).toLocaleString()} of ${Number(figures.window).toLocaleString()} tokens` : '';
      const breakdown = fromView && fromView.breakdown;
      return (breakdown ? '' : `<div class="ssb-meter"><i style="width:${percent}%"></i></div>`)
        + `<div class="ssb-figure">${Math.round(figures.percent)} % used</div>`
        + (tokens ? `<div class="ssb-note">${escapeHtml(tokens)}</div>` : '')
        + (figures.model ? `<div class="ssb-note">${escapeHtml(figures.model)}</div>` : '')
        + (fromView && fromView.baseline ? sidebarNote(CONTEXT_BASELINE_NOTE) : '')
        + (breakdown ? sidebarBreakdownHtml(entry, breakdown, figures.window) : '');
    },
  },
  {
    id: 'tasks',
    // `current()` says whether this read is still the group's latest: an older one must not write the entry's issue
    // state, or a later keystroke would redraw its stale answer (#830).
    async load(entry, draw, force, current = () => true) {
      const projectPath = sidebarSessionOf(entry).projectPath;
      if (!projectPath) return sidebarNote('This session has no project.');
      const res = await window.api.taskList({ projectPath });
      const settings = await window.api.getEffectiveSettings(projectPath);
      // The text and the order are the bar's for the tasks too (#874), so the stored filter row is read either way.
      const owner = sidebarIssueOwner(projectPath);
      const stored = await readIssueFilter(window.api, owner);
      if (!current()) return sidebarTasksGroupHtml(entry);
      if (entry.sidebarIssueOwner !== owner) {
        entry.sidebarIssueOwner = owner;
        entry.sidebarIssueText = '';
        entry.sidebarIssueSupports = null;
      }
      entry.sidebarTaskRows = openTaskRows(res && res.tasks);
      entry.sidebarIssueFilter = stored;
      entry.sidebarIssuesOn = !!(settings && settings.forgeIssuesEnabled === true);
      // Follows main's refresh timer while the group is open and shown, and with the query just read (#882).
      sidebarIssuesSync(entry);
      let html = sidebarTasksGroupHtml(entry);
      if (entry.sidebarIssuesOn) {
        if (entry.sidebarIssueAnswer && entry.sidebarIssueAnswer.ok && entry.sidebarIssueAnswer.supports) entry.sidebarIssueSupports = entry.sidebarIssueAnswer.supports;
        entry.sidebarIssueAnswer = null;
        // The tasks are local and the CLI can take its timeout, so they do not wait for it.
        html = sidebarTasksGroupHtml(entry);
        draw(html);
        let issues;
        try {
          issues = await window.api.forgeIssuesList(projectPath, issueQueryOf(entry.sidebarIssueFilter), { force: force === true });
        } catch (err) {
          issues = { enabled: true, ok: false, message: 'The issues could not be read.' };
        }
        if (!current()) return html;
        entry.sidebarIssueAnswer = issues && issues.enabled ? issues : { ok: false, message: 'The issues could not be read.' };
        entry.sidebarIssuesReadAt = Date.now();
        html = sidebarTasksGroupHtml(entry);
      }
      return html;
    },
  },
  {
    id: 'handoffs',
    async load(entry) {
      const projectPath = sidebarSessionOf(entry).projectPath;
      if (!projectPath) return sidebarNote('This session has no project.');
      const rows = await window.api.listHandoffs(projectPath);
      if (!rows || !rows.length) return sidebarNote('No handoffs in this project.');
      return rows.slice(0, SESSION_SIDEBAR_ROWS).map((h) => {
        const when = h.modified || h.createdAt;
        const meta = when && typeof formatDate === 'function' ? formatDate(new Date(when)) : '';
        return sidebarItem(entry, 'handoff', h, meta);
      }).join('');
    },
  },
  {
    id: 'instructions',
    async load(entry) {
      const session = sidebarSessionOf(entry);
      const backendId = typeof sessionBackendId === 'function' ? sessionBackendId(session) : null;
      const answer = await window.api.getSessionInstructions(session.projectPath || null, backendId);
      if (!answer || !answer.ok) return sidebarNote('The instruction files could not be read.');
      const groups = instructionGroups(answer);
      if (!groups.length) return sidebarNote(answer.declined || 'No instruction files apply here.');
      return groups.map((g) => `<div class="ssb-subhead">${escapeHtml(g.label)}</div>`
        + g.rows.slice(0, SESSION_SIDEBAR_ROWS).map((r) => instructionRow(r)).join('')).join('');
    },
  },
  {
    id: 'connectors',
    async load(entry) {
      const session = sidebarSessionOf(entry);
      let html = '';
      // Only a session driven over a pipe can be asked which servers it holds, so a terminal leaves this out.
      if (entry.conversation && !entry.conversation.exited?.()) {
        const rows = sidebarServerRows(await window.api.agent.servers(session.sessionId).catch(() => null));
        if (rows) {
          html += `<div class="ssb-subhead">MCP servers</div>`;
          html += rows.length
            ? rows.map((s) => sidebarRow(s.name, s.state || '', `data-ssb="servers" title="Manage the MCP servers" data-tone="${escapeHtml(s.tone || '')}"`)).join('')
            : sidebarNote('None.');
        }
      }
      const backendId = typeof sessionBackendId === 'function' ? sessionBackendId(session) : null;
      const res = await window.api.getSkills(session.projectPath || null, backendId);
      const skills = (res && res.skills) || [];
      html += `<div class="ssb-subhead">Skills</div>`;
      html += skills.length
        ? skills.slice(0, SESSION_SIDEBAR_ROWS).map((s, i) => sidebarItem(entry, 'skill', s, '', i)).join('')
        : sidebarNote('None.');
      return html;
    },
  },
];

// The group's own dirty mark and a token, so a late answer for a closed sidebar or an older read draws nothing.
// A hidden group (#835) reads nothing: this is every group's one way to read, so the rule is kept here, and the
// group is marked to read when it is shown again.
function loadSidebarGroup(entry, group, section, force = false) {
  if (sidebarSectionHidden(section)) { section._stale = true; return; }
  // The rows a group drew before go with its redraw, so the registry holds what is on screen (a kind has one group).
  if (entry.sidebarRows) for (const [k, v] of entry.sidebarRows) if (SIDEBAR_KIND_GROUP[v.kind] === group.id) entry.sidebarRows.delete(k);
  const body = section.querySelector('.ssb-group-body');
  const token = (section._token || 0) + 1;
  section._token = token;
  section._stale = false;
  if (!body.firstChild) body.innerHTML = sidebarNote('Loading…');
  // A control with the caret keeps it across a redraw (#830: the issue filter's own controls reload this group). The
  // mark is taken at each redraw, not at the start: the answer can come seconds later, after the user moved on, and
  // only a caret this redraw takes away is given back.
  const put = (html) => {
    const mark = sidebarFocusMark(body);
    body.innerHTML = html;
    if (mark) sidebarRestoreFocus(body, mark);
  };
  const draw = (html) => { if (section._token === token) put(html); };
  const current = () => section._token === token;
  Promise.resolve().then(() => group.load(entry, draw, force, current)).then((html) => {
    if (section._token === token) put(html);
  }).catch(() => {
    if (section._token === token) body.innerHTML = sidebarNote('Could not be read.');
  });
}

// --- A group's figure in its header (#840). ---
// Shown by the stylesheet only while the group is collapsed; an open group has the figure in its body.
// The figure is drawn for the eye and spoken apart from the name (#842): the drawn span is `aria-hidden`, and a
// visually hidden one beside it says what the number is, so a screen reader reads "Processes, CPU 3.2 %" rather
// than "Processes3.2 %". No figure, no spoken text.
const SIDEBAR_HEAD_FIGURE_WORDS = { processes: (t) => `CPU ${t}`, context: (t) => `${t} used`, changes: (t) => `${t} since the last review` };
function sidebarHeadFigureSpoken(groupId, text) {
  if (!text) return '';
  const words = SIDEBAR_HEAD_FIGURE_WORDS[groupId];
  return `, ${words ? words(text) : text}`;
}
function sidebarSetHeadFigure(entry, groupId, text) {
  const summary = entry.sidebar && entry.sidebar.querySelector(`.ssb-group[data-group="${groupId}"] > summary`);
  if (!summary) return;
  const el = summary.querySelector(':scope > .ssb-group-figure');
  if (el && el.textContent !== text) el.textContent = text;
  const spoken = summary.querySelector(':scope > .ssb-group-figure-sr');
  const say = sidebarHeadFigureSpoken(groupId, text);
  if (spoken && spoken.textContent !== say) spoken.textContent = say;
}

// The Context figure costs no read: it comes from what the conversation view and the session already hold.
function sidebarUpdateContextHead(entry) {
  const fromView = entry.conversation && entry.conversation.context ? entry.conversation.context() : null;
  const session = sidebarSessionOf(entry);
  const figures = sidebarContextFigures(fromView, session.contextFill, session.lastModel);
  sidebarSetHeadFigure(entry, 'context', contextHeadFigure(figures));
  // The bar beside the figure (#876), from the same answers; only a changed bar touches the DOM.
  const bar = entry.sidebar && entry.sidebar.querySelector('.ssb-group[data-group="context"] > summary > .ssb-group-bar');
  if (bar) {
    const html = contextHeadBarHtml(figures, fromView && fromView.breakdown);
    if (bar._html !== html) { bar._html = html; bar.innerHTML = html; }
    bar.hidden = !html;
  }
}

// --- The Processes group's poll (#834, #840). ---
// A timer per sidebar while the group is shown: every 4 s while it is open, every 15 s while it is collapsed, for the
// CPU figure in its header. A tick with the sidebar out of view or the window hidden measures nothing and waits; a
// hidden group (#835), a closed sidebar or a removed session ends the poll, and the group's next read starts it again.
// A read through `loadSidebarGroup` (open, reload, shown again) takes over: a tick whose token is stale stops.
const SIDEBAR_PROCESS_POLL_MS = 4000;
const SIDEBAR_PROCESS_POLL_COLLAPSED_MS = 15000;

function sidebarProcessSection(entry) {
  return entry.sidebar ? entry.sidebar.querySelector('.ssb-group[data-group="processes"]') : null;
}

function sidebarScheduleProcesses(entry, delay) {
  clearTimeout(entry.sidebarProcessTimer);
  const section = sidebarProcessSection(entry);
  const wait = Number.isFinite(delay) ? delay : (section && !section.open ? SIDEBAR_PROCESS_POLL_COLLAPSED_MS : SIDEBAR_PROCESS_POLL_MS);
  entry.sidebarProcessTimer = setTimeout(() => sidebarTickProcesses(entry), wait);
}

// A collapsed group has no read of its own to start the poll: the sidebar's show and the group's return from hidden
// start it here, with a first tick right away so the header has its figure. An open group's read starts its own.
function sidebarStartCollapsedProcesses(entry) {
  const section = sidebarProcessSection(entry);
  if (section && !section.open && !sidebarSectionHidden(section)) sidebarScheduleProcesses(entry, 0);
}

async function sidebarTickProcesses(entry) {
  entry.sidebarProcessTimer = null;
  // A session closed or moved to another window leaves this entry behind with its sidebar still in it: the poll ends
  // here, before anything is measured, or it would go on for a sidebar nobody can see.
  if (!entry.element.isConnected || openSessions.get(sidebarSessionOf(entry).sessionId) !== entry) return;
  const root = entry.sidebar;
  const section = sidebarProcessSection(entry);
  if (!section || sidebarSectionHidden(section)) return;
  if (!sidebarInView(entry) || document.hidden) {
    // Coming into view starts a collapsed group's next tick at once rather than up to one slow interval later.
    entry.sidebarProcessDue = true;
    sidebarScheduleProcesses(entry);
    return;
  }
  const token = section._token;
  const sessionId = sidebarSessionOf(entry).sessionId;
  const answer = await Promise.resolve(window.api.processUsage([sessionId])).catch(() => null);
  if (entry.sidebar !== root || section._token !== token || sidebarSectionHidden(section)) return;
  sidebarSetHeadFigure(entry, 'processes', processHeadFigure(answer, sessionId));
  if (section.open) sidebarPatchProcesses(section.querySelector('.ssb-group-body'), processRows(answer, sessionId));
  sidebarScheduleProcesses(entry);
}

// Is the Processes group's tree fold open now (#845)? Read from the DOM, so every redraw keeps what the user chose.
function sidebarProcessTreeOpen(entry) {
  const section = sidebarProcessSection(entry);
  return !!(section && section.querySelector('.ssb-proc-tree[open]'));
}

// Only what changed is touched: the overview's figures, the tree's count, a row whose text moved, a row that came or
// went. A change of shape (a note instead of rows, or back) redraws the body, with the fold as it was.
function sidebarPatchProcesses(body, model) {
  const list = body && body.querySelector('.ssb-proc-list');
  if (!body || model.note || !list) {
    const html = processesHtml(model, !!(body && body.querySelector('.ssb-proc-tree[open]')));
    if (body && body.innerHTML !== html) body.innerHTML = html;
    return;
  }
  for (const t of model.total) {
    const meta = body.querySelector(`.ssb-proc-total[data-total="${t.key}"] .ssb-row-meta`);
    if (meta && meta.textContent !== t.meta) meta.textContent = t.meta;
  }
  const count = body.querySelector('.ssb-proc-tree > summary .ssb-row-meta');
  if (count && count.textContent !== model.treeCount) count.textContent = model.treeCount;
  const old = new Map([...list.children].map((el) => [el.dataset.pid, el]));
  let at = list.firstElementChild;
  for (const row of model.rows) {
    let el = old.get(row.key);
    if (el) {
      old.delete(row.key);
      const meta = el.querySelector('.ssb-row-meta');
      if (meta.textContent !== row.meta) meta.textContent = row.meta;
      const main = el.querySelector('.ssb-row-main');
      if (main.textContent !== row.main) main.textContent = row.main;
      // A pid can move in the tree (its parent ended): its indentation follows.
      const pad = `${4 + row.depth * 10}px`;
      if (el.style.paddingLeft !== pad) el.style.paddingLeft = pad;
    } else {
      const tmp = document.createElement('div');
      tmp.innerHTML = processRowHtml(row);
      el = tmp.firstElementChild;
    }
    if (el !== at) list.insertBefore(el, at);
    else at = at.nextElementSibling;
  }
  for (const el of old.values()) el.remove();
  const tree = body.querySelector('.ssb-proc-tree');
  const cut = tree && tree.querySelector(':scope > .ssb-note');
  if (model.truncated && tree && !cut) tree.insertAdjacentHTML('beforeend', sidebarNote('Only the first processes are listed.'));
  else if (!model.truncated && cut) cut.remove();
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

// --- The groups' order (#829). One global setting; every sidebar in every window shows the same order. ---

// What a drag of a group carries. The terminal container under the sidebar lets it through (`isPaneTabDrag`,
// terminal-manager.js), or a group dropped on the terminal would be claimed as a drop to insert.
const SESSION_SIDEBAR_GROUP_MIME = 'application/x-switchboard-sidebar-group';
// The head has Reload only: the session's toolbar button opens and closes the sidebar, so a close here was a second
// button for it. The icon is the search bar's reindex icon, the app's one drawing of "read again".
const SESSION_SIDEBAR_RELOAD = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>';
// The variables manager's grip (#676), so one gesture looks one way.
const SESSION_SIDEBAR_GRIP = '<svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="3" r="1.3"/><circle cx="8.5" cy="3" r="1.3"/><circle cx="3.5" cy="7" r="1.3"/><circle cx="8.5" cy="7" r="1.3"/><circle cx="3.5" cy="11" r="1.3"/><circle cx="8.5" cy="11" r="1.3"/></svg>';

// The ids in the order to draw, from the cached global settings (app.js keeps `appGlobalSettings` current).
function sessionSidebarGroupOrder() {
  const saved = typeof appGlobalSettings !== 'undefined' && appGlobalSettings ? appGlobalSettings.sessionSidebarOrder : undefined;
  return orderSidebarGroups(SESSION_SIDEBAR_GROUPS.map((g) => g.id), saved);
}

function sidebarSlotIds(root) {
  return [...root.querySelectorAll('.ssb-slot')].map((slot) => slot.dataset.groupSlot);
}

// Moves the slots, never rebuilds them: a group keeps what it has read, whether it is open, and its marks.
function applySidebarGroupOrder(root, ids) {
  const body = root && root.querySelector('.ssb-body');
  if (!body) return;
  for (const id of ids) {
    const slot = body.querySelector(`.ssb-slot[data-group-slot="${id}"]`);
    if (slot) body.appendChild(slot);
  }
}

// Every sidebar this window holds. A closed one has no element and is drawn in the new order when it opens. Apply
// only: a settings change from another window lands here too, and must not write the setting back.
function sessionSidebarSetOrder(ids) {
  for (const entry of openSessions.values()) {
    if (entry && entry.sidebar) applySidebarGroupOrder(entry.sidebar, ids);
  }
}

// A settings change from another window: `reapplyGlobalSettings` (app.js) has just refreshed the cache this reads.
function sessionSidebarOrderChanged() {
  sessionSidebarSetOrder(sessionSidebarGroupOrder());
}

// A user's move, by drag or by key: the one place both gestures go through. This window applies it itself and updates
// its own cache, because `broadcastSettingsChanged` skips the sender (renderer.md, #146), and a sidebar opened before
// the write lands reads that cache. A key-scoped merge, so nothing else in the blob is touched, and the settings
// screen's Save re-reads the blob before it writes, so it does not put an old order back.
// A write that fails puts the order back, so this window does not show what no other window and no restart will.
function commitSidebarGroupOrder(ids) {
  const cache = typeof appGlobalSettings !== 'undefined' && appGlobalSettings ? appGlobalSettings : null;
  const previous = cache ? cache.sessionSidebarOrder : undefined;
  sessionSidebarSetOrder(ids);
  if (cache) cache.sessionSidebarOrder = ids.slice();
  const api = window.api;
  if (!api || typeof api.mergeSetting !== 'function') return;
  Promise.resolve(api.mergeSetting('global', { sessionSidebarOrder: ids.slice() }))
    .then(() => { if (typeof api.notifySettingsChanged === 'function') api.notifySettingsChanged(); })
    .catch(() => {
      if (cache) cache.sessionSidebarOrder = previous;
      sessionSidebarSetOrder(sessionSidebarGroupOrder());
      window.showControlToast?.('The order of the sections could not be saved.');
    });
}

// --- Hidden groups (#835). One global setting, `sessionSidebarHidden`; every sidebar in every window hides the same. ---
// The names and the list helpers are lib/sidebar-groups.js's (SESSION_SIDEBAR_GROUP_NAMES, hiddenSidebarGroups,
// withSidebarGroupHidden), read at call time.

const SESSION_SIDEBAR_EMPTY = 'Every section is hidden. Right-click here, or use Settings → Sessions, to show them again.';

function sidebarGroupLabel(id) {
  const name = SESSION_SIDEBAR_GROUP_NAMES.find((g) => g.id === id);
  return name ? name.label : id;
}

// The ids hidden now, from the cached global settings (app.js keeps `appGlobalSettings` current).
function sessionSidebarHiddenIds() {
  const saved = typeof appGlobalSettings !== 'undefined' && appGlobalSettings ? appGlobalSettings.sessionSidebarHidden : undefined;
  return hiddenSidebarGroups(saved);
}

function sidebarSectionHidden(section) {
  const slot = section && section.closest ? section.closest('.ssb-slot') : null;
  return !!(slot && slot.hidden);
}

// Hides and shows the slots, never rebuilds them. A group shown again that is open reads at once when the sidebar is in
// view, else when it comes into view; what it read before it was hidden may be old by now.
function applySidebarHidden(entry, ids) {
  const root = entry && entry.sidebar;
  if (!root) return;
  const hidden = new Set(ids);
  const inView = sidebarInView(entry);
  let shown = 0;
  for (const slot of root.querySelectorAll('.ssb-slot')) {
    const hide = hidden.has(slot.dataset.groupSlot);
    if (!hide) shown++;
    if (slot.hidden === hide) continue;
    slot.hidden = hide;
    const section = slot.querySelector('.ssb-group');
    // A collapsed Processes group shown again starts its slow poll for the header figure (#840).
    if (!hide && section && !section.open && section.dataset.group === 'processes') sidebarStartCollapsedProcesses(entry);
    if (hide && section && section.dataset.group === 'repository') sidebarUnfollowVcs(entry);
    if (hide && section && section.dataset.group === 'changes') sidebarUnfollowChanges(entry);
    if (hide && section && section.dataset.group === 'tasks') sidebarUnfollowIssues(entry);
    if (!hide && section && !section.open && section.dataset.group === 'changes') sidebarUpdateChangesHead(entry, true);
    if (hide || !section || !section.open) continue;
    const group = SESSION_SIDEBAR_GROUPS.find((g) => g.id === section.dataset.group);
    if (inView && group) loadSidebarGroup(entry, group, section);
    else section._stale = true;
  }
  const empty = root.querySelector('.ssb-empty');
  if (empty) empty.hidden = shown > 0;
}

// Every sidebar this window holds, and the popover when it is open. Apply only, like the order: a change from another
// window lands here too and must not write the setting back.
function sessionSidebarSetHidden(ids) {
  for (const entry of openSessions.values()) {
    if (entry && entry.sidebar) applySidebarHidden(entry, ids);
  }
  syncSidebarGroupsPop();
}

// A settings change from another window: `reapplyGlobalSettings` (app.js) has just refreshed the cache this reads.
function sessionSidebarHiddenChanged() {
  sessionSidebarSetHidden(sessionSidebarHiddenIds());
}

// A user's choice in the popover: applied here first, because `broadcastSettingsChanged` skips the sender, then
// written as a key-scoped merge. A write that fails puts the old list back.
function commitSidebarHidden(ids) {
  const cache = typeof appGlobalSettings !== 'undefined' && appGlobalSettings ? appGlobalSettings : null;
  const previous = cache ? cache.sessionSidebarHidden : undefined;
  if (cache) cache.sessionSidebarHidden = ids.slice();
  sessionSidebarSetHidden(ids);
  const api = window.api;
  if (!api || typeof api.mergeSetting !== 'function') return;
  Promise.resolve(api.mergeSetting('global', { sessionSidebarHidden: ids.slice() }))
    .then(() => { if (typeof api.notifySettingsChanged === 'function') api.notifySettingsChanged(); })
    .catch(() => {
      if (cache) cache.sessionSidebarHidden = previous;
      sessionSidebarSetHidden(sessionSidebarHiddenIds());
      window.showControlToast?.('The hidden sections could not be saved.');
    });
}

// The list of groups with a check mark (#835): opened by a right click (or the context-menu key, or Shift+F10) on a
// group's heading, its grip, the sidebar's head, or the note an empty sidebar shows. The terminal menu's surface and
// rows, so it looks like the app's other menus. One at a time; it stays open while groups are checked and unchecked.
let sidebarGroupsPop = null;

function syncSidebarGroupsPop() {
  if (!sidebarGroupsPop) return;
  const hidden = new Set(sessionSidebarHiddenIds());
  for (const btn of sidebarGroupsPop.menu.querySelectorAll('[data-group-toggle]')) {
    const on = !hidden.has(btn.dataset.groupToggle);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    btn.querySelector('.popover-option-icon').textContent = on ? '✓' : '';
  }
}

function closeSidebarGroupsPop(refocus) {
  const pop = sidebarGroupsPop;
  if (!pop) return;
  sidebarGroupsPop = null;
  document.removeEventListener('pointerdown', pop.outside, true);
  pop.menu.remove();
  if (!refocus) return;
  // The control it opened from, or, when that group is hidden now, the sidebar's own head button.
  const back = pop.returnTo && pop.returnTo.isConnected && !pop.returnTo.closest('.ssb-slot[hidden]') ? pop.returnTo : null;
  const fallback = pop.root && pop.root.isConnected ? pop.root.querySelector('.ssb-head-btn') : null;
  (back || fallback)?.focus();
}

function openSidebarGroupsPop(root, x, y, returnTo) {
  closeSidebarGroupsPop(false);
  const menu = document.createElement('div');
  menu.className = 'popover terminal-context-menu ssb-groups-pop';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Sections to show');
  const head = document.createElement('div');
  head.className = 'ssb-groups-pop-head';
  head.textContent = 'Show sections';
  menu.appendChild(head);
  for (const name of SESSION_SIDEBAR_GROUP_NAMES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'popover-option';
    btn.setAttribute('role', 'menuitemcheckbox');
    btn.dataset.groupToggle = name.id;
    const mark = document.createElement('span');
    mark.className = 'popover-option-icon';
    mark.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = name.label;
    btn.append(mark, label);
    btn.addEventListener('click', () => {
      const hide = btn.getAttribute('aria-checked') === 'true';
      commitSidebarHidden(withSidebarGroupHidden(sessionSidebarHiddenIds(), name.id, hide));
    });
    menu.appendChild(btn);
  }
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('[data-group-toggle]')];
    const at = items.indexOf(document.activeElement);
    let next = null;
    if (e.key === 'ArrowDown') next = items[(at + 1) % items.length];
    else if (e.key === 'ArrowUp') next = items[(at - 1 + items.length) % items.length];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSidebarGroupsPop(true); return; }
    else if (e.key === 'Tab') { e.preventDefault(); closeSidebarGroupsPop(true); return; }
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    next.focus();
  });
  const outside = (e) => { if (!menu.contains(e.target)) closeSidebarGroupsPop(false); };
  sidebarGroupsPop = { menu, root, returnTo, outside };
  syncSidebarGroupsPop();
  document.body.appendChild(menu);
  // Kept inside the window, the way the terminal menu is placed.
  const r = menu.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  document.addEventListener('pointerdown', outside, true);
  menu.querySelector('[data-group-toggle]')?.focus();
}

// The drag and the keys. The grip sits beside the `<details>`, not in its `<summary>`, so neither a press nor Space
// on it opens or closes the group. The list helpers are the variables manager's (#676, lib/variable-order.js): they
// work on any list of ids, and the names are theirs.
function wireSidebarGroupOrder(root) {
  const body = root.querySelector('.ssb-body');
  let armed = null;
  let dragId = null;
  const slotOf = (target) => (target && target.closest ? target.closest('.ssb-slot') : null);
  const placeOf = (slot, y) => {
    const r = slot.getBoundingClientRect();
    return y < r.top + r.height / 2 ? 'before' : 'after';
  };
  const clearMarks = () => {
    for (const el of body.querySelectorAll('.ssb-drop-before, .ssb-drop-after')) el.classList.remove('ssb-drop-before', 'ssb-drop-after');
  };
  const disarm = () => {
    if (armed) armed.removeAttribute('draggable');
    armed = null;
  };

  // Only the grip starts a drag: the slot is draggable while the pointer is down on its grip, so a press anywhere else
  // selects text as before, and a text drag out of the sidebar is not this one.
  body.addEventListener('pointerdown', (e) => {
    disarm();
    if (e.button !== 0) return;
    const grip = e.target.closest && e.target.closest('.ssb-grip');
    const slot = grip ? slotOf(grip) : null;
    if (!slot) return;
    slot.setAttribute('draggable', 'true');
    armed = slot;
    window.addEventListener('pointerup', disarm, { once: true });
  });

  body.addEventListener('dragstart', (e) => {
    const slot = slotOf(e.target);
    if (!slot || slot !== armed) return;
    e.stopPropagation();
    dragId = slot.dataset.groupSlot;
    slot.classList.add('dragging');
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(SESSION_SIDEBAR_GROUP_MIME, dragId);
    } catch { /* the drag still runs on `dragId` */ }
  });

  // While a group is in flight none of these reach the terminal container, which would mark itself as a drop target.
  body.addEventListener('dragenter', (e) => {
    if (!dragId) return;
    e.preventDefault();
    e.stopPropagation();
  });
  body.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    e.stopPropagation();
    try { e.dataTransfer.dropEffect = 'move'; } catch { /* nothing to set */ }
    clearMarks();
    const slot = slotOf(e.target);
    if (!slot || slot.dataset.groupSlot === dragId) return;
    slot.classList.add(placeOf(slot, e.clientY) === 'before' ? 'ssb-drop-before' : 'ssb-drop-after');
  });
  body.addEventListener('dragleave', (e) => {
    if (!dragId) return;
    e.stopPropagation();
    if (!body.contains(e.relatedTarget)) clearMarks();
  });
  body.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    e.stopPropagation();
    const moved = dragId;
    const slot = slotOf(e.target);
    clearMarks();
    if (!slot) return;
    const before = sidebarSlotIds(root);
    const next = moveVariableInOrder(before, moved, slot.dataset.groupSlot, placeOf(slot, e.clientY));
    if (!sameVariableOrder(before, next)) commitSidebarGroupOrder(next);
  });
  body.addEventListener('dragend', () => {
    dragId = null;
    disarm();
    clearMarks();
    for (const el of body.querySelectorAll('.ssb-slot.dragging')) el.classList.remove('dragging');
  });

  // Alt+ArrowUp / Alt+ArrowDown on a grip moves its group one place, and the focus stays on the grip.
  body.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const grip = e.target.closest && e.target.closest('.ssb-grip');
    const slot = grip ? slotOf(grip) : null;
    if (!slot) return;
    e.preventDefault();
    e.stopPropagation();
    const ids = sidebarSlotIds(root);
    // One step past the neighbouring SHOWN group (#835): a hidden one keeps its place and is not stepped over by hand.
    const shown = [...root.querySelectorAll('.ssb-slot:not([hidden])')].map((s) => s.dataset.groupSlot);
    const next = stepVariableInOrder(ids, shown, slot.dataset.groupSlot, e.key === 'ArrowUp' ? -1 : 1);
    if (!next || sameVariableOrder(ids, next)) return;
    commitSidebarGroupOrder(next);
    grip.focus();
  });
}

function buildSidebar(entry) {
  const sessionId = () => entry.session.sessionId;
  const state = currentSidebarState(sessionId());
  const hidden = sessionSidebarHiddenIds();
  const root = document.createElement('aside');
  root.className = 'session-sidebar';
  root.setAttribute('aria-label', 'Session sidebar');
  root.innerHTML = `
    <div class="ssb-resize" title="Drag to resize"></div>
    <div class="ssb-head">
      <span>Session</span>
      <button type="button" class="ssb-head-btn" data-ssb="refresh" title="Reload" aria-label="Reload">${SESSION_SIDEBAR_RELOAD}</button>
    </div>
    <div class="ssb-body">${sessionSidebarGroupOrder().map((id) => SESSION_SIDEBAR_GROUPS.find((g) => g.id === id)).map((g) => `
      <div class="ssb-slot" data-group-slot="${g.id}"${hidden.includes(g.id) ? ' hidden' : ''}>
        <details class="ssb-group" data-group="${g.id}"${state.groups.includes(g.id) ? ' open' : ''}>
          <summary><span class="ssb-group-name">${escapeHtml(sidebarGroupLabel(g.id))}</span><span class="ssb-group-figure" aria-hidden="true"></span>${g.id === 'context' ? '<span class="ssb-group-bar ssb-stack" aria-hidden="true"></span>' : ''}<span class="ssb-group-figure-sr visually-hidden"></span></summary>
          <div class="ssb-group-body"></div>
        </details>
        <button type="button" class="ssb-grip" title="Drag to reorder (Alt+Up / Alt+Down)" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          aria-label="Move the ${escapeHtml(sidebarGroupLabel(g.id))} section (Alt+Up / Alt+Down)">${SESSION_SIDEBAR_GRIP}</button>
      </div>`).join('')}
      <div class="ssb-note ssb-empty"${hidden.length < SESSION_SIDEBAR_GROUPS.length ? ' hidden' : ''}>${escapeHtml(SESSION_SIDEBAR_EMPTY)}</div>
    </div>`;

  // #835: the list of sections to show, from a heading, a grip, the head or the empty sidebar's note. A right click,
  // the context-menu key and Shift+F10 all arrive as `contextmenu`, at the point Chromium gives them (for a key, a point
  // on the focused control); one with no position opens under the control. Never on a group's rows: those are someone
  // else's text.
  root.addEventListener('contextmenu', (e) => {
    const at = e.target.closest && e.target.closest('.ssb-head, .ssb-group > summary, .ssb-grip, .ssb-empty');
    if (!at) return;
    e.preventDefault();
    e.stopPropagation();
    let x = e.clientX;
    let y = e.clientY;
    if (!x && !y) {
      const r = at.getBoundingClientRect();
      x = r.left + 8;
      y = r.bottom;
    }
    const focusable = e.target.closest('summary, button');
    openSidebarGroupsPop(root, x, y, focusable || at);
  });

  root.addEventListener('toggle', (e) => {
    const section = e.target;
    if (!section.classList || !section.classList.contains('ssb-group')) return;
    // A toggle the shared state applied (#892) is not a user's choice and writes nothing back. Compared with the value it
    // set, so a click that lands before the event and turns it back is still written.
    const applied = section._sharedApply;
    section._sharedApply = undefined;
    if (applied === undefined || applied !== section.open) writeSidebarState(sessionId(), { groups: [...root.querySelectorAll('.ssb-group')].filter((s) => s.open).map((s) => s.dataset.group) });
    // A group drawn open fires this once by itself, and `showSidebar` has already read it.
    const action = sidebarToggleAction({ open: section.open, closedOnce: !!section._closedOnce, inView: sidebarInView(entry) });
    if (!section.open && section.dataset.group === 'repository') sidebarUnfollowVcs(entry);
    if (!section.open && section.dataset.group === 'changes') { sidebarUnfollowChanges(entry); sidebarUpdateChangesHead(entry, true); }
    if (!section.open && section.dataset.group === 'tasks') sidebarUnfollowIssues(entry);
    if (action === 'closed') section._closedOnce = true;
    else if (action === 'load') loadSidebarGroup(entry, SESSION_SIDEBAR_GROUPS.find((g) => g.id === section.dataset.group), section);
    else if (action === 'stale') section._stale = true;
  }, true);
  // Drawn closed: its first open is a real one and reads (a group drawn open fires one toggle that reads nothing).
  for (const section of root.querySelectorAll('.ssb-group')) if (!section.open) section._closedOnce = true;

  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-ssb]');
    if (!el) return;
    switch (el.dataset.ssb) {
      case 'refresh': loadOpenSidebarGroups(entry, true); break;
      case 'issues-refresh': sidebarReadIssues(entry, true); break;
      case 'row': sessionSidebarRowClick(entry, el.dataset.key, e.shiftKey === true); break;
      case 'act': sessionSidebarRowAct(entry, el.dataset.key, el.dataset.act); break;
      case 'servers': sessionSidebarOpenServers(entry); break;
      case 'chg-row': sessionSidebarChangesRowClick(entry, el.dataset.key, e.shiftKey === true); break;
      case 'chg-act': sessionSidebarChangesRowAct(entry, el.dataset.key, el.dataset.act); break;
      case 'changes-details': sessionSidebarOpenChangesDetails(entry, {}); break;
      case 'changes-clear': sidebarChangesClear(entry, el.dataset.missing === '1'); break;
      case 'changes-view': if (el.getAttribute('aria-pressed') !== 'true') sidebarChangesSetView(entry, { view: el.dataset.view }); break;
      case 'open-file':
        sessionSidebarOpenInstruction(entry, { path: el.dataset.path });
        break;
      case 'issue-filter': {
        entry.sidebarIssuePopOpen = entry.sidebarIssuePopOpen !== true;
        const pop = root.querySelector('.ssb-issue-pop');
        if (pop) pop.hidden = !entry.sidebarIssuePopOpen;
        el.setAttribute('aria-expanded', entry.sidebarIssuePopOpen ? 'true' : 'false');
        if (entry.sidebarIssuePopOpen && pop) { const first = pop.querySelector('select, button'); if (first) first.focus(); }
        break;
      }
      case 'forge-web': {
        const web = entry.sidebarIssueAnswer && entry.sidebarIssueAnswer.ok && entry.sidebarIssueAnswer.web;
        const url = web && (el.dataset.which === 'newIssue' ? web.newIssue : web.issues);
        if (url) window.api.openExternal(url);
        break;
      }
      case 'issue-toggle': {
        const field = el.dataset.field;
        const filter = entry.sidebarIssueFilter || normalizeIssueFilter(null);
        if (field === 'assignee' || field === 'author') sidebarChangeIssueFilter(entry, { [field]: !filter[field] });
        break;
      }
      default:
    }
  });
  // The bar (#830, #874): the text redraws the task and issue rows only; state, label and order are stored.
  root.addEventListener('input', (e) => {
    if (!e.target.classList || !e.target.classList.contains('ssb-issue-search')) return;
    entry.sidebarIssueText = e.target.value;
    sidebarRedrawIssueList(entry);
  });
  root.addEventListener('change', (e) => {
    const t = e.target;
    if (!t.classList) return;
    if (t.classList.contains('ssb-issue-state')) sidebarChangeIssueFilter(entry, { state: t.value });
    else if (t.classList.contains('ssb-issue-label')) sidebarChangeIssueFilter(entry, { label: t.value });
    else if (t.classList.contains('ssb-changes-range')) sidebarChangesSetView(entry, { range: t.value });
    else if (t.classList.contains('ssb-sort')) sidebarChangeIssueFilter(entry, { sort: t.value });
  });
  // Escape closes the popover and hands the caret back to its button; it never reaches the session.
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !entry.sidebarIssuePopOpen || !e.target.closest || !e.target.closest('.ssb-issue-bar')) return;
    e.preventDefault();
    e.stopPropagation();
    entry.sidebarIssuePopOpen = false;
    const pop = root.querySelector('.ssb-issue-pop');
    if (pop) pop.hidden = true;
    const btn = root.querySelector('.ssb-issue-filter-btn');
    if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.focus(); }
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

  wireSidebarGroupOrder(root);

  entry.element.appendChild(root);
  entry.sidebar = root;
  // The cap follows the box. The terminal's own refit comes from its resize observer, after this.
  entry.sidebarResizeObserver = new ResizeObserver(() => applySidebarWidth(entry, entry.sidebarWidth));
  entry.sidebarResizeObserver.observe(entry.element);
  // A session coming into view reads what it skipped while hidden.
  entry.sidebarObserver = new MutationObserver(() => {
    // Out of view (another tab, a grid card) unfollows the issues; back in view follows and reads when the last read is old.
    sidebarIssuesSync(entry);
    if (!sidebarInView(entry)) return;
    const tasksSection = root.querySelector('.ssb-group[data-group="tasks"]');
    for (const group of SESSION_SIDEBAR_GROUPS) {
      const section = root.querySelector(`.ssb-group[data-group="${group.id}"]`);
      if (section && section.open && section._stale) loadSidebarGroup(entry, group, section);
    }
    if (!(tasksSection && tasksSection._stale)) sidebarIssuesRereadIfOld(entry);
    sidebarUpdateContextHead(entry);
    if (entry.sidebarChangesFigureStale) sidebarUpdateChangesHead(entry, true);
    if (entry.sidebarProcessDue) {
      entry.sidebarProcessDue = false;
      sidebarStartCollapsedProcesses(entry);
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
  sidebarUpdateContextHead(entry);
  sidebarUpdateChangesHead(entry, true);
  sidebarStartCollapsedProcesses(entry);
  refitForSidebar(entry);
}

function hideSidebar(entry) {
  sidebarUnfollowVcs(entry);
  sidebarUnfollowChanges(entry);
  sidebarUnfollowIssues(entry);
  clearTimeout(entry.sidebarChangesFigureTimer);
  entry.sidebarChangesFigureTimer = null;
  entry.sidebarChangesFigureStale = false;
  if (sidebarGroupsPop && sidebarGroupsPop.root === entry.sidebar) closeSidebarGroupsPop(false);
  clearTimeout(entry.sidebarProcessTimer);
  entry.sidebarProcessTimer = null;
  entry.sidebarProcessDue = false;
  entry.element.classList.remove('sidebar-open');
  if (entry.sidebarObserver) entry.sidebarObserver.disconnect();
  if (entry.sidebarResizeObserver) entry.sidebarResizeObserver.disconnect();
  entry.sidebarObserver = null;
  entry.sidebarResizeObserver = null;
  if (entry.sidebar) entry.sidebar.remove();
  entry.sidebar = null;
  entry.sidebarIssuePopOpen = false;
  refitForSidebar(entry);
}

// A session that had it open comes back with it open.
function sessionSidebarMount(entry) {
  if (!entry || !entry.session) return;
  const state = currentSidebarState(entry.session.sessionId);
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
  if (open) showSidebar(entry, currentSidebarState(sessionId).width);
  else {
    hideSidebar(entry);
    // The caret goes back to the session, as the head's Close did before the toolbar button became the only way to close.
    sidebarSessionFocus(entry);
  }
  sidebarMarkButtons(sessionId, open);
  return open;
}

function sidebarMarkButtons(sessionId, open) {
  for (const btn of document.querySelectorAll(`[data-sidebar-session="${CSS.escape(sessionId)}"]`)) btn.classList.toggle('active', open);
}

// #892: the shared state onto every sidebar this window holds but `except`: open or closed, the width, the open groups.
// Nothing is rebuilt: a group keeps what it has read, and one opened here reads through its own toggle. A group set here
// is marked, so its toggle writes nothing back. A close takes no caret: the user is working in another session.
function sessionSidebarApplyShared(except) {
  const state = sidebarSharedState();
  if (!state) return;
  sidebarSharedApplied = true;
  for (const entry of openSessions.values()) {
    if (entry && entry !== except) applySidebarState(entry, state);
  }
}

// Has this window drawn the shared state? Then switching the setting off puts each session's own row back on screen.
let sidebarSharedApplied = false;

function applySidebarState(entry, state) {
  if (!entry || !entry.session || !entry.element) return;
  const isOpen = entry.element.classList.contains('sidebar-open');
  if (state.open !== isOpen) {
    if (state.open) showSidebar(entry, state.width);
    else hideSidebar(entry);
    sidebarMarkButtons(entry.session.sessionId, state.open);
  }
  if (!entry.sidebar) return;
  if (entry.sidebarWidth !== state.width) {
    applySidebarWidth(entry, state.width);
    refitForSidebar(entry);
  }
  for (const section of entry.sidebar.querySelectorAll('.ssb-group')) {
    const want = state.groups.includes(section.dataset.group);
    if (section.open !== want) {
      section._sharedApply = want;
      section.open = want;
    }
  }
}

// What a session shows on screen right now, which is what the shared state starts from: its own row's width and groups
// while its sidebar is closed, since a closed sidebar shows neither.
function sidebarShownState(entry) {
  // No session in view: nothing is shown, so nothing opens, whatever `sessionSidebarDefault` says.
  if (!entry || !entry.session) return { ...sidebarStateOf({}, null), open: false };
  const own =sidebarStateOf(readSidebarStates(), entry && entry.session ? entry.session.sessionId : null, sidebarDefaultOpen());
  if (!entry || !entry.element) return own;
  const open = entry.element.classList.contains('sidebar-open');
  if (!open || !entry.sidebar) return { ...own, open };
  const groups = [...entry.sidebar.querySelectorAll('.ssb-group')].filter((s) => s.open).map((s) => s.dataset.group);
  return { open, width: clampSidebarWidth(entry.sidebarWidth), groups };
}

// A settings change from another window (`reapplyGlobalSettings`, app.js): the setting switched on or off, or the shared
// state moved. The settings screen clears the state when it switches the setting on, and the main window then starts it
// from what its active session shows; a detached window waits for that write rather than starting one of its own.
function sessionSidebarSharedChanged() {
  if (!sidebarSharedOn()) {
    if (!sidebarSharedApplied) return;
    sidebarSharedApplied = false;
    const map = readSidebarStates();
    for (const entry of openSessions.values()) {
      if (entry && entry.session) applySidebarState(entry, sidebarStateOf(map, entry.session.sessionId, sidebarDefaultOpen()));
    }
    return;
  }
  if (!sidebarSharedState()) {
    if (typeof window.isDetachedWindow === 'function' && window.isDetachedWindow()) return;
    const id = typeof activeSessionId !== 'undefined' ? activeSessionId : null;
    commitSidebarSharedState(sidebarShownState(id ? openSessions.get(id) : null), null);
    return;
  }
  sessionSidebarApplyShared(null);
}

// The index's session objects were refreshed (`loadProjects`): a terminal session's `contextFill` moves with each turn
// only there, so every sidebar's Context header follows it (#840). No read: it is the object the header reads anyway.
function sessionSidebarSessionsChanged() {
  for (const entry of openSessions.values()) {
    if (entry && entry.sidebar) { sidebarUpdateContextHead(entry); sidebarUpdateChangesHead(entry); }
  }
}

function sessionSidebarContextChanged(sessionId) {
  const entry = openSessions.get(sessionId);
  const section = entry && entry.sidebar && entry.sidebar.querySelector('.ssb-group[data-group="context"]');
  // The header's figure costs no read, so a collapsed group follows every change too (#840).
  if (section) sidebarUpdateContextHead(entry);
  if (section && !sidebarInView(entry)) { section._stale = true; return; }
  if (section && section.open) loadSidebarGroup(entry, SESSION_SIDEBAR_GROUPS.find((g) => g.id === 'context'), section);
}

function rekeySessionSidebar(oldId, newId) {
  // A followed Changes group moves to the new id. The caller re-keys `openSessions` and the session object right after
  // this returns, so the switch waits for the end of that synchronous work.
  for (const [entry, followedId] of sidebarChangesFollowers) {
    if (followedId === oldId) Promise.resolve().then(() => { if (entry.sidebar) sidebarFollowChanges(entry); });
  }
  const map = readSidebarStates();
  const next = rekeySidebarState(map, oldId, newId);
  if (next === map) return;
  try { localStorage.setItem(SESSION_SIDEBAR_KEY, JSON.stringify(next)); } catch { /* the state is a convenience */ }
}
