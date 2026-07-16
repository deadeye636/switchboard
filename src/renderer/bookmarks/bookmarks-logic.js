// --- Bookmarks: pure logic ---
// Scope/label/filter/sort helpers for the scope-filtered bookmark views (#68),
// free of DOM/browser APIs so the renderer (bookmarks-view.js, bookmarks-tags.js)
// and node tests share one implementation.
//
// Loaded as a classic <script> in the renderer (exposes globals) AND require()-d
// by node tests (module.exports). Keep this file free of DOM references.

// entryIndex === -1 marks a session-level bookmark (made from the live terminal,
// no per-message granularity).
const BOOKMARK_SESSION_ANCHOR = -1;

const BOOKMARK_SCOPES = ['session', 'project', 'global'];
const BOOKMARK_SCOPE_LABELS = {
  session: 'Session',
  project: 'Project',
  global: 'Global',
};

function bookmarkScopeLabel(scope) {
  return BOOKMARK_SCOPE_LABELS[scope] || scope || '';
}

// Display label for a bookmark row: the stored label, else a message/session marker.
function bookmarkLabel(b) {
  if (!b) return '';
  if (b.label) return b.label;
  return b.entryIndex === BOOKMARK_SESSION_ANCHOR ? 'Session bookmark' : `Message #${b.entryIndex}`;
}

// Translate a scope + context into the { sessionId } | { projectPath } | {} filter
// the bookmark-list-admin IPC expects. Session/project need the matching context id;
// global (or a missing id) means "everything".
function bookmarkScopeFilter(scope, ctx) {
  const c = ctx || {};
  if (scope === 'session' && c.sessionId) return { sessionId: c.sessionId };
  if (scope === 'project' && c.projectPath) return { projectPath: c.projectPath };
  return {};
}

// Case-insensitive substring filter over label, session and project names.
function filterBookmarks(rows, opts) {
  const text = ((opts || {}).text || '').trim().toLowerCase();
  if (!text) return (rows || []).slice();
  return (rows || []).filter((b) => {
    const hay = [bookmarkLabel(b), b.sessionName, b.projectDisplayName]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.includes(text);
  });
}

// Sort a copy. 'newest' (default) / 'oldest' by createdAt.
function sortBookmarks(rows, mode) {
  const list = (rows || []).slice();
  const created = (a, b) => (a.createdAt || 0) - (b.createdAt || 0);
  if (mode === 'oldest') list.sort(created);
  else list.sort((a, b) => created(b, a));
  return list;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BOOKMARK_SESSION_ANCHOR,
    BOOKMARK_SCOPES,
    BOOKMARK_SCOPE_LABELS,
    bookmarkScopeLabel,
    bookmarkLabel,
    bookmarkScopeFilter,
    filterBookmarks,
    sortBookmarks,
  };
}
