// --- Task/note system: pure logic ---
// Filtering, sorting and status/scope helpers, free of DOM/browser APIs so the
// renderer (tasks-view.js) and node tests share one implementation.
//
// Loaded as a classic <script> in the renderer (exposes globals) AND require()-d
// by node tests (module.exports). Keep this file free of DOM references.

// Status order doubles as the "next status" cycle used by the badge toggle.
const TASK_STATUS_ORDER = ['open', 'in_progress', 'done', 'dropped'];
const TASK_STATUS_LABELS = {
  open: 'Open',
  in_progress: 'In progress',
  done: 'Done',
  dropped: 'Dropped',
};
const TASK_SCOPE_LABELS = {
  project: 'Project',
  session: 'Session',
  message: 'Message',
};

function taskStatusLabel(status) {
  return TASK_STATUS_LABELS[status] || status || 'Open';
}

function taskScopeLabel(scope) {
  return TASK_SCOPE_LABELS[scope] || scope || '';
}

// Cycle to the next status (badge click): open → in_progress → done → dropped → open.
function nextTaskStatus(status) {
  const i = TASK_STATUS_ORDER.indexOf(status);
  return TASK_STATUS_ORDER[(i + 1) % TASK_STATUS_ORDER.length];
}

// Filter by status ('all' or a specific status) and a case-insensitive text
// substring over title, note, quote, project and session names.
function filterTasks(tasks, opts) {
  const o = opts || {};
  const status = o.status && o.status !== 'all' ? o.status : null;
  const text = (o.text || '').trim().toLowerCase();
  return (tasks || []).filter((t) => {
    if (status && t.status !== status) return false;
    if (!text) return true;
    const hay = [t.title, t.note, t.quote, t.projectDisplayName, t.sessionName]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.includes(text);
  });
}

// Sort a copy of the list. Modes:
//   'newest' (default) / 'oldest'         — by createdAt
//   'updated' / 'updated_oldest'          — by updatedAt
//   'status'                              — open first (TASK_STATUS_ORDER), newest within a status
function sortTasks(tasks, mode) {
  const list = (tasks || []).slice();
  const created = (a, b) => (a.createdAt || 0) - (b.createdAt || 0);
  const updated = (a, b) => (a.updatedAt || 0) - (b.updatedAt || 0);
  if (mode === 'oldest') {
    list.sort(created);
  } else if (mode === 'updated') {
    list.sort((a, b) => updated(b, a));
  } else if (mode === 'updated_oldest') {
    list.sort(updated);
  } else if (mode === 'status') {
    list.sort((a, b) => {
      const d = TASK_STATUS_ORDER.indexOf(a.status) - TASK_STATUS_ORDER.indexOf(b.status);
      return d !== 0 ? d : (b.createdAt || 0) - (a.createdAt || 0);
    });
  } else {
    list.sort((a, b) => created(b, a));
  }
  return list;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TASK_STATUS_ORDER,
    TASK_STATUS_LABELS,
    TASK_SCOPE_LABELS,
    taskStatusLabel,
    taskScopeLabel,
    nextTaskStatus,
    filterTasks,
    sortTasks,
  };
}
