// Tasks and project handoffs — the two per-project lists (#217 step 6).
//
// Tasks are the scoped task/note system (project / session / message scope). Handoffs are the Handoff
// library: a saved packet an agent wrote, belonging to a project.
//
// They share a module because they share a lifecycle, not because they are the same thing: both are
// keyed by projectPath, and both are rewritten wholesale when a project is renamed or deleted. That is
// why `stmts` is exported — project-refs.js needs projectHandoffsRename/DeleteAll RAW, inside its
// cross-domain transaction, where the runWithBusyRetry the functions carry would be wrong.
'use strict';

const { db } = require('./connection');
const { runWithBusyRetry } = require('./sqlite-busy-retry');
// createTask resolves a task's project from its session when the caller does not name one — and that IS
// the live shape: "create task from this message" sends only { sessionId, entryIndex, title, ... }. Another
// free identifier from old db.js's single scope.
const { getCachedSession } = require('./session-store');

const stmts = {
  // Tasks (scoped task/note system)
  taskInsert: db.prepare(`INSERT INTO tasks (projectPath, sessionId, entryIndex, scope, title, note, quote, status, createdAt, updatedAt)
    VALUES (@projectPath, @sessionId, @entryIndex, @scope, @title, @note, @quote, @status, @createdAt, @updatedAt)`),
  taskGet: db.prepare('SELECT * FROM tasks WHERE id = ?'),
  taskUpdateFields: db.prepare('UPDATE tasks SET title = ?, note = ?, status = ?, updatedAt = ? WHERE id = ?'),
  taskUpdateStatus: db.prepare('UPDATE tasks SET status = ?, updatedAt = ? WHERE id = ?'),
  taskDeleteById: db.prepare('DELETE FROM tasks WHERE id = ?'),
  taskListAll: db.prepare('SELECT * FROM tasks ORDER BY createdAt DESC'),
  taskListByProject: db.prepare('SELECT * FROM tasks WHERE projectPath = ? ORDER BY createdAt DESC'),
  taskListBySession: db.prepare('SELECT * FROM tasks WHERE sessionId = ? ORDER BY createdAt DESC'),
  taskOpenCountsBySession: db.prepare("SELECT sessionId, COUNT(*) AS n FROM tasks WHERE sessionId IS NOT NULL AND status IN ('open','in_progress') GROUP BY sessionId"),
  taskOpenCountsByProject: db.prepare("SELECT projectPath, COUNT(*) AS n FROM tasks WHERE projectPath IS NOT NULL AND status IN ('open','in_progress') GROUP BY projectPath"),
  // Project handoffs (Handoff library)
  handoffInsert: db.prepare('INSERT INTO project_handoffs (projectPath, label, content, createdAt, backendId) VALUES (?, ?, ?, ?, ?)'),
  handoffListByProject: db.prepare('SELECT id, label, content, createdAt, backendId FROM project_handoffs WHERE projectPath = ? ORDER BY createdAt DESC'),
  handoffDeleteById: db.prepare('DELETE FROM project_handoffs WHERE id = ?'),
  // Project path lifecycle (#55). Handoffs are a list, so a remap lets them accrue
  // to the destination rather than conflicting.
  projectHandoffsRename: db.prepare('UPDATE project_handoffs SET projectPath = ? WHERE projectPath = ?'),
  projectHandoffsDeleteAll: db.prepare('DELETE FROM project_handoffs WHERE projectPath = ?'),
};


const TASK_STATUSES = ['open', 'in_progress', 'done', 'dropped'];
const TASK_SCOPES = ['project', 'session', 'message'];

// Create a task. Scope is derived if not passed. projectPath is resolved from the
// session cache when a sessionId is given but no projectPath — so project-scoped
// filtering keeps working even if the session cache is later cleared.
function createTask(input) {
  const t = input || {};
  const sessionId = t.sessionId || null;
  const entryIndex = Number.isFinite(Number(t.entryIndex)) && Number(t.entryIndex) >= 0
    ? Number(t.entryIndex) : null;
  const scope = TASK_SCOPES.includes(t.scope)
    ? t.scope
    : (entryIndex != null ? 'message' : (sessionId ? 'session' : 'project'));
  let projectPath = t.projectPath || null;
  if (!projectPath && sessionId) {
    const cached = getCachedSession(sessionId);
    projectPath = (cached && cached.projectPath) || null;
  }
  const title = String(t.title || '').trim();
  if (!title) return null;
  const now = Date.now();
  const status = TASK_STATUSES.includes(t.status) ? t.status : 'open';
  const info = runWithBusyRetry(() => stmts.taskInsert.run({
    projectPath,
    sessionId,
    entryIndex,
    scope,
    title,
    note: t.note != null ? String(t.note) : null,
    quote: t.quote != null ? String(t.quote) : null,
    status,
    createdAt: now,
    updatedAt: now,
  }));
  return stmts.taskGet.get(info.lastInsertRowid);
}

// Tasks filtered by project OR session, else all (newest first).
function listTasks(filter) {
  const f = filter || {};
  if (f.projectPath) return stmts.taskListByProject.all(f.projectPath);
  if (f.sessionId) return stmts.taskListBySession.all(f.sessionId);
  return stmts.taskListAll.all();
}

function getTask(id) {
  return stmts.taskGet.get(Number(id)) || null;
}

// Update a task. Accepts partial { title, note, status }; a status-only change
// (from the quick badge toggle) skips the title/note write.
function updateTask(id, fields) {
  const f = fields || {};
  const existing = stmts.taskGet.get(Number(id));
  if (!existing) return null;
  const now = Date.now();
  const onlyStatus = f.title === undefined && f.note === undefined && f.status !== undefined;
  if (onlyStatus) {
    const status = TASK_STATUSES.includes(f.status) ? f.status : existing.status;
    runWithBusyRetry(() => stmts.taskUpdateStatus.run(status, now, Number(id)));
  } else {
    const title = f.title !== undefined ? String(f.title).trim() || existing.title : existing.title;
    const note = f.note !== undefined ? (f.note != null ? String(f.note) : null) : existing.note;
    const status = f.status !== undefined && TASK_STATUSES.includes(f.status) ? f.status : existing.status;
    runWithBusyRetry(() => stmts.taskUpdateFields.run(title, note, status, now, Number(id)));
  }
  return stmts.taskGet.get(Number(id));
}

function removeTask(id) {
  runWithBusyRetry(() => stmts.taskDeleteById.run(Number(id)));
}

// { sessionId: openCount } for tasks that are still open or in progress — drives
// the sidebar session-card task badge.
function openTaskCountsBySession() {
  const out = {};
  for (const r of stmts.taskOpenCountsBySession.all()) out[r.sessionId] = r.n;
  return out;
}

// { projectPath: openCount } — drives the project-header task-icon highlight.
function openTaskCountsByProject() {
  const out = {};
  for (const r of stmts.taskOpenCountsByProject.all()) out[r.projectPath] = r.n;
  return out;
}

// --- Project handoffs (Handoff library) ---
// `backendId` = where the packet came from (#148). It is a hint, not a binding: resuming a handoff
// starts a NEW session, so the user may run it on any backend — this just makes the picker default to
// the one that wrote it. NULL for handoffs saved before this existed (they are Claude's).
function saveProjectHandoff(projectPath, label, content, backendId) {
  const info = runWithBusyRetry(() =>
    stmts.handoffInsert.run(projectPath, label || null, String(content || ''), new Date().toISOString(),
      backendId || null));
  return info.lastInsertRowid;
}

function listProjectHandoffs(projectPath) {
  return projectPath ? stmts.handoffListByProject.all(projectPath) : [];
}

function deleteProjectHandoff(id) {
  runWithBusyRetry(() => stmts.handoffDeleteById.run(Number(id)));
}

module.exports = {
  createTask, listTasks, getTask, updateTask, removeTask,
  openTaskCountsBySession, openTaskCountsByProject,
  saveProjectHandoff, listProjectHandoffs, deleteProjectHandoff,
  // For project-refs.js's cross-domain transactions only — see the header.
  stmts,
};
