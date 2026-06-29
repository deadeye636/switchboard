const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Invoke (request-response)
  getPlans: () => ipcRenderer.invoke('get-plans'),
  readPlan: (filename) => ipcRenderer.invoke('read-plan', filename),
  savePlan: (filePath, content) => ipcRenderer.invoke('save-plan', filePath, content),
  getStats: () => ipcRenderer.invoke('get-stats'),
  getStatsFromDb: () => ipcRenderer.invoke('get-stats-from-db'),
  refreshStats: () => ipcRenderer.invoke('refresh-stats'),
  getUsage: () => ipcRenderer.invoke('get-usage'),
  getMemories: () => ipcRenderer.invoke('get-memories'),
  readMemory: (filePath) => ipcRenderer.invoke('read-memory', filePath),
  saveMemory: (filePath, content) => ipcRenderer.invoke('save-memory', filePath, content),
  getWorkFiles: () => ipcRenderer.invoke('get-work-files'),
  readWorkFile: (filePath) => ipcRenderer.invoke('read-work-file', filePath),
  deleteWorkFile: (filePath) => ipcRenderer.invoke('delete-work-file', filePath),
  getProjects: (showArchived) => ipcRenderer.invoke('get-projects', showArchived),
  rebuildCache: () => ipcRenderer.invoke('rebuild-cache'),
  getActiveSessions: () => ipcRenderer.invoke('get-active-sessions'),
  getActiveTerminals: () => ipcRenderer.invoke('get-active-terminals'),
  stopSession: (id) => ipcRenderer.invoke('stop-session', id),
  toggleStar: (id) => ipcRenderer.invoke('toggle-star', id),
  toggleProjectFavorite: (projectPath) => ipcRenderer.invoke('toggle-project-favorite', projectPath),
  bookmarkToggle: (anchor) => ipcRenderer.invoke('bookmark-toggle', anchor),
  bookmarkRemove: (id) => ipcRenderer.invoke('bookmark-remove', id),
  bookmarkList: (sessionId) => ipcRenderer.invoke('bookmark-list', sessionId),
  sessionTagsGet: (sessionId) => ipcRenderer.invoke('session-tags-get', sessionId),
  sessionTagsSet: (sessionId, tags) => ipcRenderer.invoke('session-tags-set', { sessionId, tags }),
  tagsListAll: () => ipcRenderer.invoke('tags-list-all'),
  sessionTagsAll: () => ipcRenderer.invoke('session-tags-all'),
  renameSession: (id, name) => ipcRenderer.invoke('rename-session', id, name),
  archiveSession: (id, archived) => ipcRenderer.invoke('archive-session', id, archived),
  openTerminal: (id, projectPath, isNew, sessionOptions) => ipcRenderer.invoke('open-terminal', id, projectPath, isNew, sessionOptions),
  search: (type, query, titleOnly) => ipcRenderer.invoke('search', type, query, titleOnly),
  readSessionJsonl: (sessionId) => ipcRenderer.invoke('read-session-jsonl', sessionId),
  readSubagentJsonl: (parentSessionId, agentId) => ipcRenderer.invoke('read-subagent-jsonl', parentSessionId, agentId),
  listSubagents: (parentSessionId) => ipcRenderer.invoke('list-subagents', parentSessionId),
  startSubagentWatch: (parentSessionId, agentId) => ipcRenderer.invoke('start-subagent-watch', parentSessionId, agentId),
  stopSubagentWatch: (watchId) => ipcRenderer.invoke('stop-subagent-watch', watchId),

  // Settings
  getSetting: (key) => ipcRenderer.invoke('get-setting', key),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  deleteSetting: (key) => ipcRenderer.invoke('delete-setting', key),
  getEffectiveSettings: (projectPath) => ipcRenderer.invoke('get-effective-settings', projectPath),
  getScheduleCreatorCommand: () => ipcRenderer.invoke('get-schedule-creator-command'),
  createScheduleSession: (projectPath) => ipcRenderer.invoke('create-schedule-session', projectPath),
  runScheduleNow: (filePath) => ipcRenderer.invoke('run-schedule-now', filePath),
  getShellProfiles: () => ipcRenderer.invoke('get-shell-profiles'),

  browseFolder: () => ipcRenderer.invoke('browse-folder'),
  addProject: (projectPath) => ipcRenderer.invoke('add-project', projectPath),
  removeProject: (projectPath) => ipcRenderer.invoke('remove-project', projectPath),
  getHiddenProjects: () => ipcRenderer.invoke('get-hidden-projects'),
  unhideProject: (projectPath) => ipcRenderer.invoke('unhide-project', projectPath),
  remapProject: (oldPath, newPath) => ipcRenderer.invoke('remap-project', oldPath, newPath),
  deleteWorktree: (worktreePath) => ipcRenderer.invoke('delete-worktree', worktreePath),
  worktreeStatus: (worktreePath) => ipcRenderer.invoke('worktree-status', worktreePath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openPath: (filePath) => ipcRenderer.invoke('open-path', filePath),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard-write-text', text),
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),

  // Send (fire-and-forget)
  sendInput: (id, data) => ipcRenderer.send('terminal-input', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal-resize', id, cols, rows),
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

  // App version
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

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
  saveFileForPanel: (filePath, content) => ipcRenderer.invoke('save-file-for-panel', filePath, content),
  watchFile: (filePath) => ipcRenderer.invoke('watch-file', filePath),
  unwatchFile: (filePath) => ipcRenderer.invoke('unwatch-file', filePath),
  onFileChanged: (callback) => {
    ipcRenderer.on('file-changed', (_event, filePath) => callback(filePath));
  },
});
