const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Invoke (request-response)
  getPlans: () => ipcRenderer.invoke('get-plans'),
  readPlan: (filename) => ipcRenderer.invoke('read-plan', filename),
  savePlan: (filePath, content) => ipcRenderer.invoke('save-plan', filePath, content),
  getStats: () => ipcRenderer.invoke('get-stats'),
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
  // Multi-LLM backends + user Axis-A profiles (Phase 1 T-1.5, Phase 2 T-2.1).
  backends: {
    list: () => ipcRenderer.invoke('backends-list'),
    canFork: (sessionId) => ipcRenderer.invoke('backend-can-fork', sessionId),
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
  openSettingsWindow: () => ipcRenderer.send('open-settings-window'),
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
  getScheduleCreatorCommand: () => ipcRenderer.invoke('get-schedule-creator-command'),
  createScheduleSession: (projectPath) => ipcRenderer.invoke('create-schedule-session', projectPath),
  runScheduleNow: (filePath) => ipcRenderer.invoke('run-schedule-now', filePath),
  getShellProfiles: () => ipcRenderer.invoke('get-shell-profiles'),
  listSavedVariables: (projectPath) => ipcRenderer.invoke('list-saved-variables', projectPath),
  listAllSavedVariables: () => ipcRenderer.invoke('list-all-saved-variables'),
  getSavedVariable: (id) => ipcRenderer.invoke('get-saved-variable', id),
  saveSavedVariable: (variable) => ipcRenderer.invoke('save-saved-variable', variable),
  deleteSavedVariable: (id) => ipcRenderer.invoke('delete-saved-variable', id),
  useSavedVariables: (ids) => ipcRenderer.invoke('use-saved-variables', ids),
  getShellType: (projectPath) => ipcRenderer.invoke('get-shell-type', projectPath),
  resolveVariableInsert: (id, shellType, sessionId) => ipcRenderer.invoke('resolve-variable-insert', id, shellType, sessionId),

  browseFolder: () => ipcRenderer.invoke('browse-folder'),
  addProject: (projectPath) => ipcRenderer.invoke('add-project', projectPath),
  removeProject: (projectPath) => ipcRenderer.invoke('remove-project', projectPath),
  setProjectAutoAdd: (enabled) => ipcRenderer.invoke('set-project-auto-add', enabled),
  getHiddenProjects: () => ipcRenderer.invoke('get-hidden-projects'),
  unhideProject: (projectPath) => ipcRenderer.invoke('unhide-project', projectPath),
  remapProject: (oldPath, newPath) => ipcRenderer.invoke('remap-project', oldPath, newPath),
  getProjectsAdmin: () => ipcRenderer.invoke('get-projects-admin'),
  // Trust is per BACKEND (#171): Claude keeps it in ~/.claude.json, Codex in its own config.toml, and
  // Pi/Hermes have no such gate at all. The backend that owns the answer writes it.
  setProjectTrust: (projectPath, backendId, trusted) =>
    ipcRenderer.invoke('set-project-trust', projectPath, backendId, trusted),
  deleteProjectSessions: (projectPath) => ipcRenderer.invoke('delete-project-sessions', projectPath),
  removeProjectConfig: (projectPath) => ipcRenderer.invoke('remove-project-config', projectPath),
  getZoomLevel: () => ipcRenderer.invoke('get-zoom-level'),
  nudgeZoom: (delta) => ipcRenderer.invoke('nudge-zoom', delta),
  onZoomChanged: (cb) => ipcRenderer.on('zoom-changed', (_e, level) => cb(level)),
  deleteWorktree: (worktreePath) => ipcRenderer.invoke('delete-worktree', worktreePath),
  worktreeStatus: (worktreePath) => ipcRenderer.invoke('worktree-status', worktreePath),
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
    ipcRenderer.on('cli-busy-state', (_event, sessionId, busy) => callback(sessionId, busy));
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
  // Windows OS build number — fed to xterm's windowsPty option so it tracks
  // ConPTY's reflow/wrapping correctly (fixes cursor jumps + stale cell fragments
  // in multi-line TUI redraws). 0 on non-Windows. Fetched synchronously from the
  // main process: the sandboxed preload's require('os') is a polyfill whose
  // os.release() doesn't carry the real build, so it must come from main.
  windowsBuildNumber: (() => {
    try { return ipcRenderer.sendSync('get-windows-build') || 0; } catch { return 0; }
  })(),

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
