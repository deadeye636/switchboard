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
      id: 'action:' + action.id,
      title: action.title,
      subtitle: action.group || 'Action',
      keywords: action.keywords || '',
      // An action beats a session that scored the same: the user typed a verb, and there are far more
      // sessions than actions for a stray match to hide behind.
      kindRank: 3,
      recency: 0,
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
  filter: (rows, query) => ((typeof rankEntries === 'function') ? rankEntries(rows, query) : rows),
  groups: null,                         // one ranked list: the ranking IS the grouping here
  rowKey: (row) => row.id,
  row: (row) => {
    const meta = row.kind === 'session'
      ? (row.running ? 'Session · running' : 'Session') + (row.subtitle ? ' · ' + row.subtitle : '')
      : (row.kind === 'project' ? 'Project' : row.subtitle);
    return {
      main: row.title,
      meta,
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
