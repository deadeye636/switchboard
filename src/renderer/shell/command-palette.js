// --- The command palette (#274): one keystroke to reach a session, a project or an action ---
//
// A DESCRIPTION, like every other picker in this app: palette-core.js owns the popover, the keyboard
// loop, the focus recovery and the listbox semantics, and this file says what to load, how to filter,
// what a row looks like and what Enter does. What it needs on top of the three insert pickers is that it
// belongs to no terminal — it is centred, modal, and openable with nothing running — which the core
// answers through `centered` rather than through a second popover implementation.
//
// Where the rows come from, and why none of it is fetched: sessions and projects are already in this
// window (`sessionMap`, `cachedAllProjects`), and the actions are whatever their owners registered in
// command-actions.js. So the palette opens on data it has, at the first keystroke, without an IPC round
// trip — which is the whole difference from the sidebar's search (trigram FTS, three-character floor,
// sessions only).
//
// Reaches at CALL time, all of them free globals of other classic scripts: `sessionMap`,
// `cachedAllProjects`, `activePtyIds`, `lastActivityTime`, `openSession`, `setProjectCollapsed`,
// `refreshSidebar` and `window.projectDisplayNameForSession` (app.js); `rankEntries`
// (command-palette-rank.js); `listCommandActions` (command-actions.js); `openPalette`
// (palette-core.js); `cleanDisplayName` (lib/utils.js). Guarded where a boot could reach here first.

// The chord an action also answers to, printed on its row so the palette teaches the hotkey rather than
// competing with it (#489). Guarded on every side: `formatBinding` lives in shortcuts.js, `appShortcuts`
// in session-nav.js and `isMac` in terminal-manager.js, and a boot that reaches here first must produce a
// row without a chord rather than no row at all.
function commandPaletteChord(shortcutId) {
  if (!shortcutId || typeof formatBinding !== 'function') return '';
  try {
    return formatBinding(
      shortcutId,
      typeof isMac !== 'undefined' ? isMac : false,
      typeof appShortcuts !== 'undefined' ? appShortcuts : null,
    ) || '';
  } catch { return ''; }
}

// A session row's recency, the same value the sidebar sorts by.
function commandPaletteSessionTime(session) {
  const live = (typeof lastActivityTime !== 'undefined' && lastActivityTime.get(session.sessionId)) || null;
  const t = live || session.modified;
  const ms = t ? new Date(t).getTime() : 0;
  return Number.isFinite(ms) ? ms : 0;
}

// Everything the palette can offer right now, as rank-able entries. Built per open, never cached: a
// session that ended, a project that was hidden and an action that stopped applying must all be gone the
// next time the palette opens.
function commandPaletteEntries() {
  const entries = [];

  for (const action of (typeof listCommandActions === 'function' ? listCommandActions() : [])) {
    entries.push({
      kind: 'action',
      group: 'Commands',
      id: 'action:' + action.id,
      title: action.title,
      subtitle: action.group || 'Action',
      keywords: action.keywords || '',
      // An action beats a session that scored the same: the user typed a verb, and there are far more
      // sessions than actions for a stray match to hide behind.
      kindRank: 3,
      recency: 0,
      shortcut: commandPaletteChord(action.shortcutId),
      run: action.run,
    });
  }

  const projects = (typeof cachedAllProjects !== 'undefined' && Array.isArray(cachedAllProjects))
    ? cachedAllProjects : [];
  for (const project of projects) {
    if (!project || !project.projectPath) continue;
    // The user's own name for the project when there is one — the same answer the sidebar header shows,
    // asked through the session helper because that is the seam app.js exposes.
    const custom = (typeof window.projectDisplayNameForSession === 'function')
      ? window.projectDisplayNameForSession({ projectPath: project.projectPath, sessionId: null }) : '';
    const tail = project.projectPath.split(/[\\/]/).filter(Boolean).slice(-2).join('/');
    entries.push({
      kind: 'project',
      group: 'Projects',
      id: 'project:' + project.projectPath,
      title: custom || tail,
      subtitle: project.projectPath,
      keywords: 'project folder',
      kindRank: 1,
      recency: 0,
      projectPath: project.projectPath,
    });
  }

  const sessions = (typeof sessionMap !== 'undefined') ? [...sessionMap.values()] : [];
  for (const session of sessions) {
    if (!session || !session.sessionId) continue;
    if (session.archived) continue;               // archived rows are hidden in the sidebar; hide them here too
    if (session.parentSessionId) continue;        // a subagent is not something you jump to
    const name = (typeof cleanDisplayName === 'function')
      ? (cleanDisplayName(session.name || session.aiTitle || session.summary) || session.sessionId)
      : (session.name || session.sessionId);
    const running = (typeof activePtyIds !== 'undefined') && activePtyIds.has(session.sessionId);
    const tail = (session.projectPath || '').split(/[\\/]/).filter(Boolean).slice(-2).join('/');
    entries.push({
      kind: 'session',
      group: 'Sessions',
      id: 'session:' + session.sessionId,
      title: name,
      subtitle: tail,
      keywords: running ? 'running session' : 'session',
      // A running session outranks an idle one on an equal match — it is the one being worked in.
      kindRank: running ? 2 : 0,
      recency: commandPaletteSessionTime(session),
      session,
      running,
    });
  }

  return entries;
}

// Taking a project row scrolls its group into view and unfolds it — there is no "open a project" in this
// app, the sidebar IS the project view, and a project the palette jumped to that stayed folded would look
// like nothing had happened. The fold is written through the same store a manual toggle uses, so the
// answer survives the next render exactly as if it had been clicked (#278's explicit-wins rule).
function revealProjectFromPalette(projectPath) {
  if (typeof setProjectCollapsed === 'function') setProjectCollapsed(projectPath, false);
  if (typeof refreshSidebar === 'function') refreshSidebar();
  const group = document.querySelector(`.project-group[data-project-path="${CSS.escape(projectPath)}"]`);
  if (!group) return;
  group.querySelector('.project-header')?.classList.remove('collapsed');
  group.scrollIntoView({ block: 'center' });
  group.classList.add('palette-revealed');
  setTimeout(() => group.classList.remove('palette-revealed'), 1200);
}

// What an empty palette shows, in this order (#488). Every command — the set is small and bounded, and
// it is the answer to "what can this app do" — then the sessions you were last in, then a few projects.
// The per-group slices are what stop the longest group from eating the list: 40 rows of sessions is
// exactly what made the commands invisible.
const EMPTY_QUERY_GROUPS = [
  { group: 'Commands', limit: Infinity },
  { group: 'Sessions', limit: 14 },
  { group: 'Projects', limit: 6 },
];

// The headings the core draws. Ordered by FIRST APPEARANCE in the ranked list rather than by a fixed
// order, which is what keeps the best match at the top once something is typed: a query that finds a
// session best puts Sessions first and leaves the ranking intact inside it.
function commandPaletteGroups(rows) {
  const order = [];
  const byLabel = new Map();
  for (const row of rows || []) {
    const label = (row && row.group) || 'Other';
    if (!byLabel.has(label)) { byLabel.set(label, []); order.push(label); }
    byLabel.get(label).push(row);
  }
  return order.map(label => ({ label, rows: byLabel.get(label) }));
}

const COMMAND_PALETTE = {
  id: 'command',
  centered: true,                       // no terminal: centred on the window, with a backdrop (#274)
  shortcut: 'commandPalette',
  placeholder: 'Jump to a session, a project, or run a command…',
  ariaLabel: 'Command palette',
  listLabel: 'Sessions, projects and commands',
  enterLabel: 'run',
  failedText: 'Could not build the command list.',
  load: () => ({ rows: commandPaletteEntries(), extra: null }),
  filter: (rows, query) => ((typeof rankEntries === 'function')
    ? rankEntries(rows, query, { emptyGroups: EMPTY_QUERY_GROUPS })
    : rows),
  groups: (rows) => commandPaletteGroups(rows),
  rowKey: (row) => row.id,
  row: (row) => {
    const meta = row.kind === 'session'
      ? (row.running ? 'Session · running' : 'Session') + (row.subtitle ? ' · ' + row.subtitle : '')
      : (row.kind === 'project' ? 'Project' : row.subtitle);
    return {
      main: row.title,
      // The chord rides in the meta line rather than in a column of its own: the row shape is the
      // core's, shared with four other pickers, and a key hint is not worth changing it for all of them.
      meta: row.shortcut ? `${meta} · ${row.shortcut}` : meta,
      metaClass: row.kind === 'action' ? 'vpal-meta-action' : '',
    };
  },
  emptyText: () => 'Nothing to jump to yet.',
  noMatchText: (query) => `Nothing matches “${query}”.`,
  pick: async (row) => {
    if (row.kind === 'action') {
      await row.run();
      return;
    }
    if (row.kind === 'session') {
      if (typeof openSession === 'function') await openSession(row.session);
      return;
    }
    if (row.kind === 'project') revealProjectFromPalette(row.projectPath);
  },
};

// No terminal, no session id — that is what makes the core centre it, give it a backdrop, and hand the
// focus back to whatever had it rather than to an xterm.
function openCommandPalette() {
  if (typeof openPalette !== 'function') return;
  openPalette(COMMAND_PALETTE, null, null);
}
