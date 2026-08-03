const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Invoke (request-response)
  getPlans: () => ipcRenderer.invoke('get-plans'),
  // A full filePath now (#227): plans can live under any backend's plans dir, not just ~/.claude/plans.
  readPlan: (filePath) => ipcRenderer.invoke('read-plan', filePath),
  savePlan: (filePath, content) => ipcRenderer.invoke('save-plan', filePath, content),
  // backendId (optional): scope every figure to one backend. Omitted / 'all' = the whole corpus (#159).
  getStatsFromDb: (backendId) => ipcRenderer.invoke('get-stats-from-db', backendId),
  refreshStats: (backendId) => ipcRenderer.invoke('refresh-stats', backendId),
  getUsage: () => ipcRenderer.invoke('get-usage'),
  getMemories: () => ipcRenderer.invoke('get-memories'),
  readMemory: (filePath) => ipcRenderer.invoke('read-memory', filePath),
  saveMemory: (filePath, content) => ipcRenderer.invoke('save-memory', filePath, content),
  getWorkFiles: () => ipcRenderer.invoke('get-work-files'),
  readWorkFile: (filePath) => ipcRenderer.invoke('read-work-file', filePath),
  deleteWorkFile: (filePath) => ipcRenderer.invoke('delete-work-file', filePath),
  getProjects: (showArchived) => ipcRenderer.invoke('get-projects', showArchived),
  rebuildCache: () => ipcRenderer.invoke('rebuild-cache'),
  indexWorkerStatus: () => ipcRenderer.invoke('index-worker-status'),
  // Multi-LLM backends + user Axis-A profiles (Phase 1 T-1.5, Phase 2 T-2.1).
  backends: {
    list: () => ipcRenderer.invoke('backends-list'),
    canFork: (sessionId) => ipcRenderer.invoke('backend-can-fork', sessionId),
    listModels: (backendId, search) => ipcRenderer.invoke('backend-list-models', backendId, search),
    listResources: (backendId, projectPath) => ipcRenderer.invoke('backend-list-resources', backendId, projectPath),
    openResource: (backendId, resourcePath, projectPath) => ipcRenderer.invoke('backend-open-resource', backendId, resourcePath, projectPath),
    transcriptPath: (sessionId) => ipcRenderer.invoke('handoff-transcript-path', sessionId),
  },
  sessionBackends: {
    getAll: () => ipcRenderer.invoke('session-backends-get-all'),
  },
  profiles: {
    list: () => ipcRenderer.invoke('profiles-list'),
    save: (profile, allowSecrets) => ipcRenderer.invoke('profiles-save', { profile, allowSecrets }),
    // Check without writing — the template editor stages, Save Settings commits.
    validate: (profile, allowSecrets) => ipcRenderer.invoke('profiles-validate', { profile, allowSecrets }),
    delete: (id) => ipcRenderer.invoke('profiles-delete', id),
    setDefault: (id) => ipcRenderer.invoke('profiles-set-default', id),
  },
  // Presence-only check for $VAR env refs (never returns values).
  checkEnvRefs: (names) => ipcRenderer.invoke('env-refs-check', names),
  getActiveSessions: () => ipcRenderer.invoke('get-active-sessions'),
  getActiveTerminals: () => ipcRenderer.invoke('get-active-terminals'),
  stopSession: (id) => ipcRenderer.invoke('stop-session', id),
  toggleStar: (id) => ipcRenderer.invoke('toggle-star', id),
  toggleProjectFavorite: (projectPath) => ipcRenderer.invoke('toggle-project-favorite', projectPath),
  bookmarkToggle: (anchor) => ipcRenderer.invoke('bookmark-toggle', anchor),
  bookmarkRemove: (id) => ipcRenderer.invoke('bookmark-remove', id),
  bookmarkList: (sessionId) => ipcRenderer.invoke('bookmark-list', sessionId),
  bookmarkListAdmin: (filter) => ipcRenderer.invoke('bookmark-list-admin', filter),
  bookmarkCountsByProject: () => ipcRenderer.invoke('bookmark-counts-by-project'),
  taskCreate: (payload) => ipcRenderer.invoke('task-create', payload),
  taskList: (filter) => ipcRenderer.invoke('task-list', filter),
  taskUpdate: (payload) => ipcRenderer.invoke('task-update', payload),
  taskRemove: (id) => ipcRenderer.invoke('task-remove', id),
  taskOpenCounts: () => ipcRenderer.invoke('task-open-counts'),
  saveHandoff: (payload) => ipcRenderer.invoke('save-handoff', payload),
  listHandoffs: (projectPath) => ipcRenderer.invoke('list-handoffs', projectPath),
  deleteHandoff: (id) => ipcRenderer.invoke('delete-handoff', id),
  sessionTagsGet: (sessionId) => ipcRenderer.invoke('session-tags-get', sessionId),
  sessionTagsSet: (sessionId, tags) => ipcRenderer.invoke('session-tags-set', { sessionId, tags }),
  tagsListAll: () => ipcRenderer.invoke('tags-list-all'),
  sessionTagsAll: () => ipcRenderer.invoke('session-tags-all'),
  projectTagsGet: (projectPath) => ipcRenderer.invoke('project-tags-get', projectPath),
  projectTagsSet: (projectPath, tags) => ipcRenderer.invoke('project-tags-set', { projectPath, tags }),
  projectTagsListAll: () => ipcRenderer.invoke('project-tags-list-all'),
  projectTagsAll: () => ipcRenderer.invoke('project-tags-all'),
  // Tag definitions (#138). kind is 'project' | 'session'.
  tagDefsList: (kind) => ipcRenderer.invoke('tag-defs-list', kind),
  tagDefCreate: (kind, name, color) => ipcRenderer.invoke('tag-def-create', kind, name, color),
  tagDefRename: (kind, oldName, newName) => ipcRenderer.invoke('tag-def-rename', kind, oldName, newName),
  tagDefColor: (kind, name, color) => ipcRenderer.invoke('tag-def-color', kind, name, color),
  tagDefFlags: (kind, name, flags) => ipcRenderer.invoke('tag-def-flags', kind, name, flags),
  tagDefDelete: (kind, name) => ipcRenderer.invoke('tag-def-delete', kind, name),
  setLogLevel: (level) => ipcRenderer.invoke('set-log-level', level),
  // Settings pop-out window (Phase 2)
  // Settings always open in a window of their own (#365). `scope` is 'global' or 'project'; a project
  // scope carries the path whose settings to show.
  openSettingsWindow: (scope, projectPath) => ipcRenderer.send('open-settings-window', scope, projectPath),
  // Closing the window kills every running session. Main cancels the close, asks here — in the app's own
  // dialog, not a Windows system box — and closes again if the answer is yes.
  onConfirmClose: (cb) => ipcRenderer.on('confirm-close', (_e, warning) => cb(warning)),
  confirmCloseResult: (confirmed) => ipcRenderer.send('confirm-close-result', !!confirmed),
  // Cancel/Save in the standalone settings window. It asks main to put the window away
  // rather than calling window.close(): a renderer-initiated close DESTROYS the window
  // outright — the 'close' event never fires, so it cannot be turned into a hide — and
  // the next open would pay the full cold start again (#175).
  hideSettingsWindow: () => ipcRenderer.send('hide-settings-window'),
  // Detached session windows (#2). The PTY never moves; only the window that renders its output does,
  // so `detachSession` is a view operation and never touches the process.
  // `at` (#362) is optional: `{ point: {x, y}, box: {x, y, width, height} }` in this renderer's own
  // coordinates, so the new window opens on the display the tab was dragged to rather than on the
  // main window's. Omitted for a menu or keyboard detach — main then uses the pointer's display.
  detachSession: (sessionId, title, at) => ipcRenderer.invoke('detach-session', sessionId, title, at),
  isSessionDetached: (sessionId) => ipcRenderer.invoke('is-session-detached', sessionId),
  detachedSessionIds: () => ipcRenderer.invoke('detached-session-ids'),
  focusDetachedWindow: (sessionId) => ipcRenderer.invoke('focus-detached-window', sessionId),
  // Reveal a session wherever it lives — main asks its OWNER to show it, so a list that spans windows
  // (the recap overview, #402) can reach a session this window must not mount itself.
  revealSession: (sessionId) => ipcRenderer.invoke('reveal-session', sessionId),
  // Open one of the app's own views in another window (#364). Nothing moves — every window has its
  // own copy of the viewer elements — so the target opens its own and the caller closes its own.
  openViewInWindow: (windowId, kind, ref, file) => ipcRenderer.invoke('open-view-in-window', windowId, kind, ref, file),
  // …or in a window of its own, holding nothing else (#370).
  openViewInNewWindow: (kind, ref, file, at) => ipcRenderer.invoke('open-view-in-new-window', kind, ref, file, at),
  onOpenView: (cb) => ipcRenderer.on('open-view', (_e, kind, ref, file) => cb(kind, ref, file)),
  // A window telling main which of the app's own views it is showing (#364, #370, #371), and the
  // sidebar asking where a picked file should go. `routeViewFile` answers { routed: false } when the
  // view is in this window, and the caller then does exactly what it always did.
  // `layout` (#372) is the reporting window's pane arrangement, and only a detached window sends one:
  // it keeps no layout in localStorage (it shares the key with the main window), so main is the only
  // place its splits can be remembered for the next launch.
  windowViewsChanged: (views, layout) => ipcRenderer.invoke('window-views-changed', views, layout || null),
  routeViewFile: (kind, payload) => ipcRenderer.invoke('route-view-file', kind, payload),
  onOpenViewFile: (cb) => ipcRenderer.on('open-view-file', (_e, kind, payload) => cb(kind, payload)),
  // The same question for a view a sidebar TAB opens, which has no file to route (#381). Answers
  // { focused: false } when the view is in this window or nowhere else, and the caller then opens it
  // locally exactly as before.
  focusViewWindow: (kind) => ipcRenderer.invoke('focus-view-window', kind),
  // Move a session between windows (#316): 'main' or a detached window's id, from `listSessionWindows`.
  // `placement` (#375) is where inside that window it goes — the answer `probeDropPoint` gave.
  moveSessionToWindow: (sessionId, windowId, placement) =>
    ipcRenderer.invoke('move-session-to-window', sessionId, windowId, placement),
  // A drag held over ANOTHER window: ask what a drop there would mean, and have that window show it
  // (#375). The far window never sees the drag, so this is the only way it can answer or highlight.
  probeDropPoint: (point, box) => ipcRenderer.invoke('probe-drop-point', point, box),
  clearRemoteDropHints: () => ipcRenderer.invoke('clear-remote-drop-hints'),
  // …and the other end of the same question, in the window being asked.
  onProbeDropPoint: (cb) => ipcRenderer.on('probe-drop-point', (_e, id, at, bounds) => cb(id, at, bounds)),
  answerProbeDropPoint: (id, placement) => ipcRenderer.send('drop-probe-answer', id, placement),
  onClearDropHint: (cb) => ipcRenderer.on('clear-drop-hint', () => cb()),
  listSessionWindows: (sessionId) => ipcRenderer.invoke('list-session-windows', sessionId),
  // Which Switchboard window sits at this screen point, if any (#360). A tab dragged out of a window
  // has to know whether it landed ON another one — the far window never sees the drag at all.
  windowAtScreenPoint: (point, box) => ipcRenderer.invoke('window-at-screen-point', point, box),
  // What does THIS window hold? Asked by a detached window on boot — its URL names only the session it
  // was opened for, and main is the one that knows the rest (#326, #331).
  sessionsInMyWindow: () => ipcRenderer.invoke('sessions-in-my-window'),
  // Was this window restored from the last run, and with what (#371)? Null for a window that was
  // opened by the user. Asked rather than told: a push has to pick a moment, and the window itself
  // is the only thing that knows when it can act on the answer.
  myWindowRestore: () => ipcRenderer.invoke('my-window-restore'),
  // "I cannot render this one after all" — hands the claim back so main stops routing a session to a
  // window that shows it nowhere (#331).
  releaseSessionClaim: (sessionId) => ipcRenderer.invoke('release-session-claim', sessionId),
  // Main renderer: release your terminal for this session / take it back. Both carry the session id.
  onSessionDetached: (cb) => ipcRenderer.on('session-detached', (_e, sessionId) => cb(sessionId)),
  // `running` comes from main's own session map — the renderer's copy is polled and can be half a
  // minute stale in an idle window, and taking a dead session back would resume its CLI.
  // `placement` (#375) is where in this window the session goes, when it arrived by being dropped on
  // it. Null on every other path, and the renderer then places it the way it always did.
  // `busy` (#395) is whether the agent is working AT THIS MOMENT. A session that is busy and stays busy
  // sends no new edge, so a window taking one mid-turn would otherwise draw it as idle until the turn
  // happened to end.
  onSessionReattached: (cb) => ipcRenderer.on('session-reattached',
    (_e, sessionId, running, placement, busy) => cb(sessionId, running, placement, busy)),
  // A detached session moved onto a new id (fork, accepted plan). Both windows hear it: the detached
  // one re-points itself, the main one keeps its "this lives elsewhere" set honest.
  onDetachedSessionRekeyed: (cb) => ipcRenderer.on('detached-session-rekeyed', (_e, fromId, toId) => cb(fromId, toId)),
  onSessionDetachRekeyed: (cb) => ipcRenderer.on('session-detach-rekeyed', (_e, fromId, toId) => cb(fromId, toId)),
  notifySettingsChanged: () => ipcRenderer.send('settings-changed'),
  onSettingsChanged: (cb) => ipcRenderer.on('settings-changed', () => cb()),
  renameSession: (id, name) => ipcRenderer.invoke('rename-session', id, name),
  archiveSession: (id, archived) => ipcRenderer.invoke('archive-session', id, archived),
  openTerminal: (id, projectPath, isNew, sessionOptions) => ipcRenderer.invoke('open-terminal', id, projectPath, isNew, sessionOptions),
  search: (type, query, titleOnly) => ipcRenderer.invoke('search', type, query, titleOnly),
  readSessionJsonl: (sessionId) => ipcRenderer.invoke('read-session-jsonl', sessionId),
  readSubagentJsonl: (parentSessionId, agentId) => ipcRenderer.invoke('read-subagent-jsonl', parentSessionId, agentId),
  listSubagents: (parentSessionId) => ipcRenderer.invoke('list-subagents', parentSessionId),
  startSubagentWatch: (parentSessionId, agentId) => ipcRenderer.invoke('start-subagent-watch', parentSessionId, agentId),
  stopSubagentWatch: (watchId) => ipcRenderer.invoke('stop-subagent-watch', watchId),
  pauseSessionOutput: (sessionId) => ipcRenderer.invoke('pause-session-output', sessionId),
  resumeSessionOutput: (sessionId) => ipcRenderer.invoke('resume-session-output', sessionId),

  // Settings
  getSetting: (key) => ipcRenderer.invoke('get-setting', key),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  mergeSetting: (key, partial) => ipcRenderer.invoke('merge-setting', key, partial),
  deleteSetting: (key) => ipcRenderer.invoke('delete-setting', key),
  exportSettings: () => ipcRenderer.invoke('export-settings'),
  importSettings: () => ipcRenderer.invoke('import-settings'),
  getEffectiveSettings: (projectPath) => ipcRenderer.invoke('get-effective-settings', projectPath),
  getShellProfiles: () => ipcRenderer.invoke('get-shell-profiles'),
  listSavedVariables: (projectPath) => ipcRenderer.invoke('list-saved-variables', projectPath),
  listAllSavedVariables: () => ipcRenderer.invoke('list-all-saved-variables'),
  getSavedVariable: (id) => ipcRenderer.invoke('get-saved-variable', id),
  saveSavedVariable: (variable) => ipcRenderer.invoke('save-saved-variable', variable),
  deleteSavedVariable: (id) => ipcRenderer.invoke('delete-saved-variable', id),
  savedVariableReferences: (name) => ipcRenderer.invoke('saved-variable-references', name),
  // The set moved in ANOTHER window (#382). Never sent to the window that made the change — it has the
  // answer in its own reply, and reloading there would race its own update.
  onSavedVariablesChanged: (cb) => ipcRenderer.on('variables-changed', () => cb()),
  // Presence (#386). Every window reports focus and input; main is the only place that can tell
  // whether the USER was away, because each renderer only knows about itself. `send`, not `invoke`:
  // this is the hot path and nothing waits for an answer. `onPresenceReturned` carries the absence
  // that just ended — `{ awaySince, awayMs }` — which is what the away recap lists events from.
  reportPresenceActivity: () => ipcRenderer.send('presence-activity'),
  onPresenceReturned: (cb) => ipcRenderer.on('presence-returned', (_e, absence) => cb(absence)),
  // The same absence, asked for rather than heard (#422). A window that reloads missed the
  // announcement, and the recap it was building was in that renderer alone; this is how it gets it
  // back. `discardAbsence` is the other half — the user threw the recap away, so a reload must not
  // resurrect it. It carries the absence it means, so a newer one that arrived meanwhile survives.
  getPendingAbsence: () => ipcRenderer.invoke('presence:pending-absence'),
  discardAbsence: (awaySince) => ipcRenderer.invoke('presence:discard-absence', awaySince),
  // The session timeline (#396). Main holds it, so it survives a reload and a session moving between
  // windows; a renderer reads a session's history ONCE and is then kept current by `onTimelineAppended`.
  // Events arrive with `at` in epoch ms, newest first from the read.
  getSessionTimeline: (sessionId) => ipcRenderer.invoke('timeline:for-session', sessionId),
  onTimelineAppended: (cb) => ipcRenderer.on('timeline-appended', (_e, event) => cb(event)),
  // Everything since a point in time, across every session — the recap overview's one read (#402).
  // Answers `{ events, truncated }`; `truncated` means the record had more than the reader is allowed.
  getTimelineSince: (sinceMs) => ipcRenderer.invoke('timeline:since', sinceMs),
  // For the one class of fact main cannot see: something that happened in the UI. Main still writes it,
  // and refuses any kind a window has no business claiming.
  //
  // `detailIsSubject` says the detail NAMES what the event is about (a path) rather than describing it (a
  // reason), which is what stops two files touched in the same beat from collapsing into one (#423).
  noteTimelineEvent: (sessionId, kind, label, detail, detailIsSubject = false) =>
    ipcRenderer.invoke('timeline:note', sessionId, kind, label, detail, detailIsSubject === true),
  resolveVariableInsert: (id, sessionId) => ipcRenderer.invoke('resolve-variable-insert', id, sessionId),

  browseFolder: () => ipcRenderer.invoke('browse-folder'),
  addProject: (projectPath) => ipcRenderer.invoke('add-project', projectPath),
  // Hide: on the list, unseen. Remove: off the list, cached rows purged, tombstoned (#167).
  hideProject: (projectPath) => ipcRenderer.invoke('hide-project', projectPath),
  removeProject: (projectPath) => ipcRenderer.invoke('remove-project', projectPath),
  setProjectAutoAdd: (enabled) => ipcRenderer.invoke('set-project-auto-add', enabled),
  getHiddenProjects: () => ipcRenderer.invoke('get-hidden-projects'),
  unhideProject: (projectPath) => ipcRenderer.invoke('unhide-project', projectPath),
  remapProject: (oldPath, newPath) => ipcRenderer.invoke('remap-project', oldPath, newPath),
  getProjectsAdmin: () => ipcRenderer.invoke('get-projects-admin'),
  // Projects that have sessions and are not on the list — indexed, searchable, painted nowhere (#183).
  getUnlistedProjects: () => ipcRenderer.invoke('get-unlisted-projects'),
  // Trust is per BACKEND (#171): Claude keeps it in ~/.claude.json, Codex in its own config.toml, and
  // Pi/Hermes have no such gate at all. The backend that owns the answer writes it.
  setProjectTrust: (projectPath, backendId, trusted) =>
    ipcRenderer.invoke('set-project-trust', projectPath, backendId, trusted),
  // Deleting a project's history is per BACKEND (#171): a project's Codex and Pi transcripts used to
  // survive a "delete sessions" untouched, because only Claude's store was cleared.
  deleteProjectSessions: (projectPath, backendIds) =>
    ipcRenderer.invoke('delete-project-sessions', projectPath, backendIds),
  // Which backends this project has sessions from, and which of them can be cleared at all (Hermes'
  // store is read-only to us). The Remove dialog is built from this.
  projectDeletableBackends: (projectPath) => ipcRenderer.invoke('project-deletable-backends', projectPath),
  removeProjectConfig: (projectPath, backendId) => ipcRenderer.invoke('remove-project-config', projectPath, backendId),
  getZoomLevel: () => ipcRenderer.invoke('get-zoom-level'),
  nudgeZoom: (delta) => ipcRenderer.invoke('nudge-zoom', delta),
  onZoomChanged: (cb) => ipcRenderer.on('zoom-changed', (_e, level) => cb(level)),
  deleteWorktree: (worktreePath) => ipcRenderer.invoke('delete-worktree', worktreePath),
  worktreeStatus: (worktreePath) => ipcRenderer.invoke('worktree-status', worktreePath),
  // VCS chip (#277): the renderer reports which repo cwds are on screen; main pushes status back.
  vcsWatch: (cwds) => ipcRenderer.send('vcs-watch', cwds),
  vcsStatus: (cwd) => ipcRenderer.invoke('vcs-status', cwd),
  vcsRefresh: (cwd) => ipcRenderer.invoke('vcs-refresh', cwd),
  onVcsStatusChanged: (cb) => ipcRenderer.on('vcs-status-changed', (_e, payload) => cb(payload)),
  openChangesWindow: (cwd, label) => ipcRenderer.send('open-changes-window', { cwd, label }),
  vcsReveal: (filePath) => ipcRenderer.invoke('vcs-reveal', filePath),
  vcsDiff: (req) => ipcRenderer.invoke('vcs-diff', req),
  vcsFileVersions: (req) => ipcRenderer.invoke('vcs-file-versions', req),
  openDiffWindow: (req) => ipcRenderer.send('open-diff-window', req),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openPath: (filePath) => ipcRenderer.invoke('open-path', filePath),
  openInEditor: (filePath) => ipcRenderer.invoke('open-in-editor', filePath),
  openExternalTerminal: (cwdPath) => ipcRenderer.invoke('open-external-terminal', cwdPath),
  // Tier-3 custom launcher, runMode:'external' (T-3.10): launch-and-forget in an OS window.
  // The 'in-app' mode needs no binding of its own — it rides on openTerminal's sessionOptions.
  runCustomLauncher: (launcher, projectPath) => ipcRenderer.invoke('run-custom-launcher', { launcher, projectPath }),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard-write-text', text),
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
  saveClipboardImage: () => ipcRenderer.invoke('save-clipboard-image'),
  // An image that has no on-disk path: bytes the renderer already holds (a dropped or pasted
  // bitmap, a decoded data: URL), or the URL of an image dragged out of a web page (#307).
  saveImageBuffer: (bytes, ext) => ipcRenderer.invoke('save-image-buffer', bytes, ext),
  saveImageUrl: (url) => ipcRenderer.invoke('save-image-url', url),

  // Send (fire-and-forget)
  sendInput: (id, data) => ipcRenderer.send('terminal-input', id, data),
  resizeTerminal: (id, cols, rows, settle) => ipcRenderer.send('terminal-resize', id, cols, rows, settle),
  redrawTerminal: (id) => ipcRenderer.send('terminal-redraw', id),
  closeTerminal: (id) => ipcRenderer.send('close-terminal', id),

  // Native notifications, dock/taskbar badge, tray (Spec 01)
  notify: (payload) => ipcRenderer.send('notify', payload),
  setBadge: (count) => ipcRenderer.send('set-badge', count),
  setTraySummary: (text) => ipcRenderer.send('set-tray-summary', text),
  onFocusSession: (cb) => ipcRenderer.on('focus-session', (_e, id) => cb(id)),
  onFocusNextAttention: (cb) => ipcRenderer.on('focus-next-attention', () => cb()),

  // Listeners (main → renderer)
  onTerminalData: (callback) => {
    ipcRenderer.on('terminal-data', (_event, sessionId, data) => callback(sessionId, data));
  },
  onSessionDetected: (callback) => {
    ipcRenderer.on('session-detected', (_event, tempId, realId) => callback(tempId, realId));
  },
  onProcessExited: (callback) => {
    ipcRenderer.on('process-exited', (_event, sessionId, exitCode) => callback(sessionId, exitCode));
  },
  onTerminalNotification: (callback) => {
    ipcRenderer.on('terminal-notification', (_event, sessionId, message) => callback(sessionId, message));
  },
  onCliBusyState: (callback) => {
    ipcRenderer.on('cli-busy-state', (_event, sessionId, busy, exact) => callback(sessionId, busy, exact));
  },
  // The same facts, addressed to the window that RENDERS a session rather than to the main one (#395),
  // and RECORD-ONLY by contract: its handler writes this window's timeline and its own status, and
  // nothing else. The attention inbox, the badge, the tray and the chime stay singular, in main. This
  // channel is never sent to the main window — it hears everything on the channels above.
  onTimelineSignal: (callback) => {
    ipcRenderer.on('timeline-signal', (_event, sessionId, signal) => callback(sessionId, signal));
  },
  // A statement about the session itself, not from the CLI's output — today: "this backend has no record
  // of this session, so there is no busy/idle to show" (#151). NOT an attention signal: nothing is
  // waiting for the user, so it must not go through onTerminalNotification, which would light the row up.
  onSessionNotice: (callback) => {
    ipcRenderer.on('session-notice', (_event, sessionId, message) => callback(sessionId, message));
  },
  onAttentionSignal: (callback) => {
    ipcRenderer.on('attention-signal', (_event, signal) => callback(signal));
  },
  configureAttentionHook: (enabled) => ipcRenderer.invoke('configure-attention-hook', enabled),
  onSessionForked: (callback) => {
    ipcRenderer.on('session-forked', (_event, oldId, newId) => callback(oldId, newId));
  },
  onSubagentSpawned: (cb) => ipcRenderer.on('subagent-spawned', (_e, payload) => cb(payload)),
  onSubagentCompleted: (cb) => ipcRenderer.on('subagent-completed', (_e, payload) => cb(payload)),
  onSubagentWatchEvent: (cb) => ipcRenderer.on('subagent-watch-event', (_e, payload) => cb(payload)),
  onProjectsChanged: (callback) => {
    ipcRenderer.on('projects-changed', () => callback());
  },
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (_event, text, type) => callback(text, type));
  },

  // File drag-and-drop
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Platform
  platform: process.platform,
  isPackaged: !process.defaultApp,
  // ConPTY build-number hint for xterm's windowsPty option so it tracks ConPTY's
  // reflow/wrapping correctly (fixes cursor jumps + stale cell fragments in
  // multi-line TUI redraws). 0 on non-Windows. Takes the terminal's projectPath so
  // main can resolve the project → global conptyBackend cascade (#268). Synchronous
  // because the renderer needs it before it constructs the xterm Terminal; the
  // sandboxed preload's os.release() is a polyfill, so the real build comes from main.
  windowsBuildNumber: (projectPath) => {
    try { return ipcRenderer.sendSync('get-windows-build', projectPath || null) || 0; } catch { return 0; }
  },

  // App version
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getAboutInfo: () => ipcRenderer.invoke('get-about-info'),

  // MCP bridge (main → renderer)
  onMcpOpenDiff: (callback) => {
    ipcRenderer.on('mcp-open-diff', (_event, sessionId, diffId, data) => callback(sessionId, diffId, data));
  },
  onMcpOpenFile: (callback) => {
    ipcRenderer.on('mcp-open-file', (_event, sessionId, data) => callback(sessionId, data));
  },
  onMcpCloseAllDiffs: (callback) => {
    ipcRenderer.on('mcp-close-all-diffs', (_event, sessionId) => callback(sessionId));
  },
  onMcpCloseTab: (callback) => {
    ipcRenderer.on('mcp-close-tab', (_event, sessionId, diffId) => callback(sessionId, diffId));
  },

  // MCP bridge (renderer → main)
  mcpDiffResponse: (sessionId, diffId, action, editedContent) => {
    ipcRenderer.send('mcp-diff-response', sessionId, diffId, action, editedContent);
  },
  readFileForPanel: (filePath) => ipcRenderer.invoke('read-file-for-panel', filePath),
  readFileDataUrl: (filePath) => ipcRenderer.invoke('read-file-dataurl', filePath),
  saveFileForPanel: (filePath, content) => ipcRenderer.invoke('save-file-for-panel', filePath, content),
  watchFile: (filePath) => ipcRenderer.invoke('watch-file', filePath),
  unwatchFile: (filePath) => ipcRenderer.invoke('unwatch-file', filePath),
  onFileChanged: (callback) => {
    const listener = (_event, filePath) => callback(filePath);
    ipcRenderer.on('file-changed', listener);
    // Return an unsubscribe so callers can remove the listener on teardown
    // (issue #75) — otherwise repeated instantiation leaks listeners.
    return () => ipcRenderer.removeListener('file-changed', listener);
  },
});
