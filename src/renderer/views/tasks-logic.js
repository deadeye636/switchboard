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

// A case-insensitive text substring over a forge issue's number, title, author, labels and description (#816), and
// since #830 an exact label. The second argument is the text alone, or `{ text, label }`.
function filterIssues(issues, filter) {
  const f = filter && typeof filter === 'object' ? filter : { text: filter };
  const needle = (typeof f.text === 'string' ? f.text : '').trim().toLowerCase();
  const label = typeof f.label === 'string' ? f.label : '';
  if (!needle && !label) return issues || [];
  return (issues || []).filter((i) => {
    if (label && !(i.labels || []).includes(label)) return false;
    if (!needle) return true;
    return ['#' + i.number, i.title, i.author, i.body, ...(i.labels || [])]
      .filter(Boolean).join(' ').toLowerCase().includes(needle);
  });
}

// --- Issue filters (#830, spec 42) ---
// The stored half of a project's issue filter: what goes to the CLI (state, the two "me" toggles) and the label.
// The free text is never stored. It lives in its own settings row, `forgeIssueFilter:<owner>`, outside the project
// blob: the project settings window replaces that blob on Save and would erase it, and a filter is view state, not
// a setting that cascades. `<owner>` is `settingsOwnerPath`, so a worktree shares its project's filter.
const ISSUE_FILTER_KEY_PREFIX = 'forgeIssueFilter:';
// The window event a view sends after it wrote the filter, so the other view in the SAME window follows. Another
// window reads the row when its list next loads; a settings broadcast would rerun every window's global settings
// for a click on a filter.
const ISSUE_FILTER_EVENT = 'switchboard:issue-filter';
const ISSUE_FILTER_STATES = ['open', 'closed', 'all'];
// Above any provider's own limit (GitLab allows 255). A longer value is dropped, never cut: a cut label would match
// nothing after the next read.
const ISSUE_LABEL_MAX = 1024;

function issueFilterKey(ownerPath) {
  return typeof ownerPath === 'string' && ownerPath ? ISSUE_FILTER_KEY_PREFIX + ownerPath : '';
}

function normalizeIssueFilter(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    state: ISSUE_FILTER_STATES.includes(v.state) ? v.state : 'open',
    assignee: v.assignee === true,
    author: v.author === true,
    label: typeof v.label === 'string' && v.label.length <= ISSUE_LABEL_MAX ? v.label : '',
  };
}

// What main is asked for; the label and the text stay in the window.
function issueQueryOf(filter) {
  const f = normalizeIssueFilter(filter);
  return { state: f.state, assignee: f.assignee, author: f.author };
}

// The labels to offer: those of the issues that were read, sorted, once each. A stored label the list no longer
// carries is kept in front, so the choice the list is filtered by is always on screen and can be taken back.
function issueLabels(issues, keep) {
  const set = new Set();
  for (const i of issues || []) for (const l of i.labels || []) if (typeof l === 'string' && l) set.add(l);
  const list = [...set].sort((a, b) => a.localeCompare(b));
  if (typeof keep === 'string' && keep && !set.has(keep)) list.unshift(keep);
  return list;
}

// Reading and changing that row. `api` is `window.api` in the renderer and a fake in a test; `ownerPath` is the
// caller's `settingsOwnerPath(projectPath)`. A read that fails is the default filter, never an error on screen.
async function readIssueFilter(api, ownerPath) {
  const key = issueFilterKey(ownerPath);
  if (!key || !api || typeof api.getSetting !== 'function') return normalizeIssueFilter(null);
  try { return normalizeIssueFilter(await api.getSetting(key)); } catch { return normalizeIssueFilter(null); }
}

// A change of some fields only, merged in main (`merge-setting` reads and writes in one handler), so a window holding
// an older copy of the row cannot write that copy back over another window's change. Answers the row as stored.
function issueFilterPatch(patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const clean = normalizeIssueFilter(p);
  const out = {};
  for (const k of ['state', 'assignee', 'author', 'label']) if (Object.prototype.hasOwnProperty.call(p, k)) out[k] = clean[k];
  return out;
}
async function patchIssueFilter(api, ownerPath, patch) {
  const key = issueFilterKey(ownerPath);
  const clean = issueFilterPatch(patch);
  if (!key || !api || typeof api.mergeSetting !== 'function') return normalizeIssueFilter(clean);
  await api.mergeSetting(key, clean);
  return readIssueFilter(api, ownerPath);
}

// "N of M": how many match out of how many were read, with a "+" when the read hit the cap and there may be more.
function issueCountLabel(shown, read, limit) {
  const capped = Number.isFinite(limit) && limit > 0 && read >= limit;
  return `${shown} of ${read}${capped ? '+' : ''}`;
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
    filterIssues,
    ISSUE_FILTER_KEY_PREFIX,
    ISSUE_FILTER_EVENT,
    issueFilterKey,
    normalizeIssueFilter,
    issueQueryOf,
    issueLabels,
    issueCountLabel,
    readIssueFilter,
    issueFilterPatch,
    patchIssueFilter,
    sortTasks,
  };
}
