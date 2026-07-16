// Bookmarks, tags and tag definitions — everything a user labels something with (#217 step 7).
//
// Four stores that are one subject: a bookmark marks a place in a session, session tags and project tags
// attach names to a session or a project, and tag_defs is the registry behind both (colour, hidden,
// disabled). Session and project tags are deliberate MIRRORS of each other, keyed differently — that
// symmetry is easier to keep honest with both in one file than with the pair split apart.
//
// The tag_defs statements reach across that mirror on purpose: renaming or deleting a definition must
// rewrite BOTH tag tables, which is why renameTagDefTx / deleteTagDefTx touch projectTags* and
// sessionTags* together, in one transaction.
//
// `stmts` is exported for project-refs.js, which merges a project's tags into another project's inside
// its own cross-domain transaction — raw, because the retry the functions carry does not belong there.
'use strict';

const { db } = require('./connection');
const { runWithBusyRetry } = require('./sqlite-busy-retry');

const stmts = {
  // Bookmarks (toggle by {sessionId, entryIndex} anchor)
  bookmarkGet: db.prepare('SELECT id FROM bookmarks WHERE sessionId = ? AND entryIndex = ?'),
  bookmarkInsert: db.prepare('INSERT INTO bookmarks (sessionId, entryIndex, timestamp, label, createdAt) VALUES (?, ?, ?, ?, ?)'),
  bookmarkDeleteByAnchor: db.prepare('DELETE FROM bookmarks WHERE sessionId = ? AND entryIndex = ?'),
  bookmarkDeleteById: db.prepare('DELETE FROM bookmarks WHERE id = ?'),
  bookmarkListAll: db.prepare('SELECT * FROM bookmarks ORDER BY createdAt DESC'),
  bookmarkListBySession: db.prepare('SELECT * FROM bookmarks WHERE sessionId = ? ORDER BY entryIndex ASC'),
  // Session tags
  // Colour and state live on the tag def (#138). An assignment with no matching def
  // is a stray — it should not happen, since assigning a tag creates its def — so it
  // just reads as colourless rather than being special-cased.
  tagsGet: db.prepare(`
    SELECT s.tag, d.color AS color, COALESCE(d.hidden, 0) AS hidden, COALESCE(d.disabled, 0) AS disabled
    FROM session_tags s LEFT JOIN tag_defs d ON d.kind = 'session' AND d.name = s.tag
    WHERE s.sessionId = ? ORDER BY s.tag
  `),
  tagInsert: db.prepare('INSERT OR REPLACE INTO session_tags (sessionId, tag) VALUES (?, ?)'),
  tagDeleteAll: db.prepare('DELETE FROM session_tags WHERE sessionId = ?'),
  // Suggestions come from the defs, not from what happens to be assigned (#138).
  tagListAll: db.prepare(`
    SELECT name AS tag, color, hidden, disabled FROM tag_defs
    WHERE kind = 'session' ORDER BY name COLLATE NOCASE
  `),
  tagAllRows: db.prepare(`
    SELECT s.sessionId, s.tag, d.color AS color, COALESCE(d.hidden, 0) AS hidden, COALESCE(d.disabled, 0) AS disabled
    FROM session_tags s LEFT JOIN tag_defs d ON d.kind = 'session' AND d.name = s.tag
    ORDER BY s.tag
  `),
  // A tag carries one colour across every project and session that uses it (#134).
  // Project tags (#98) — mirror of the session-tag statements, keyed by projectPath.
  projectTagsGet: db.prepare(`
    SELECT p.tag, d.color AS color, COALESCE(d.hidden, 0) AS hidden, COALESCE(d.disabled, 0) AS disabled
    FROM project_tags p LEFT JOIN tag_defs d ON d.kind = 'project' AND d.name = p.tag
    WHERE p.projectPath = ? ORDER BY p.tag
  `),
  projectTagInsert: db.prepare('INSERT OR REPLACE INTO project_tags (projectPath, tag) VALUES (?, ?)'),
  projectTagDeleteAll: db.prepare('DELETE FROM project_tags WHERE projectPath = ?'),
  // Remap (#55) folds the source project's tag assignments into the destination;
  // OR IGNORE drops a duplicate the destination already has. Colour is on the def
  // now, shared by both, so nothing colour-related to carry.
  projectTagsMerge: db.prepare(
    'INSERT OR IGNORE INTO project_tags (projectPath, tag) SELECT ?, tag FROM project_tags WHERE projectPath = ?'
  ),
  projectTagListAll: db.prepare(`
    SELECT name AS tag, color, hidden, disabled FROM tag_defs
    WHERE kind = 'project' ORDER BY name COLLATE NOCASE
  `),
  projectTagAllRows: db.prepare(`
    SELECT p.projectPath, p.tag, d.color AS color, COALESCE(d.hidden, 0) AS hidden, COALESCE(d.disabled, 0) AS disabled
    FROM project_tags p LEFT JOIN tag_defs d ON d.kind = 'project' AND d.name = p.tag
    ORDER BY p.tag
  `),

  // --- Tag definitions (#138) — the tag itself, independent of any assignment ---
  tagDefGet: db.prepare('SELECT kind, name, color, hidden, disabled FROM tag_defs WHERE kind = ? AND name = ?'),
  tagDefInsert: db.prepare('INSERT OR IGNORE INTO tag_defs (kind, name, color) VALUES (?, ?, ?)'),
  tagDefRename: db.prepare('UPDATE tag_defs SET name = ? WHERE kind = ? AND name = ?'),
  tagDefSetColor: db.prepare('UPDATE tag_defs SET color = ? WHERE kind = ? AND name = ?'),
  tagDefSetFlags: db.prepare('UPDATE tag_defs SET hidden = ?, disabled = ? WHERE kind = ? AND name = ?'),
  tagDefDelete: db.prepare('DELETE FROM tag_defs WHERE kind = ? AND name = ?'),
  // Usage counts come from the assignment tables, so a def never drifts from reality.
  tagDefsProject: db.prepare(`
    SELECT d.name, d.color, d.hidden, d.disabled,
           (SELECT COUNT(*) FROM project_tags p WHERE p.tag = d.name) AS usageCount
    FROM tag_defs d WHERE d.kind = 'project' ORDER BY d.name COLLATE NOCASE
  `),
  tagDefsSession: db.prepare(`
    SELECT d.name, d.color, d.hidden, d.disabled,
           (SELECT COUNT(*) FROM session_tags s WHERE s.tag = d.name) AS usageCount
    FROM tag_defs d WHERE d.kind = 'session' ORDER BY d.name COLLATE NOCASE
  `),
  // Rename / delete have to carry the assignments with them.
  projectTagsRename: db.prepare('UPDATE OR REPLACE project_tags SET tag = ? WHERE tag = ?'),
  sessionTagsRename: db.prepare('UPDATE OR REPLACE session_tags SET tag = ? WHERE tag = ?'),
  projectTagsDeleteByTag: db.prepare('DELETE FROM project_tags WHERE tag = ?'),
  sessionTagsDeleteByTag: db.prepare('DELETE FROM session_tags WHERE tag = ?'),
};


// Toggle a bookmark on a transcript message. Returns { bookmarked } reflecting
// the new state. timestamp/label are stored for display in the bookmark overlay.
function toggleBookmark(sessionId, entryIndex, timestamp, label) {
  const idx = Number(entryIndex);
  if (!sessionId || !Number.isFinite(idx)) return { bookmarked: false };
  const existing = stmts.bookmarkGet.get(sessionId, idx);
  if (existing) {
    runWithBusyRetry(() => stmts.bookmarkDeleteByAnchor.run(sessionId, idx));
    return { bookmarked: false };
  }
  runWithBusyRetry(() => stmts.bookmarkInsert.run(sessionId, idx, timestamp || null, label || null, Date.now()));
  return { bookmarked: true };
}

function removeBookmark(id) {
  runWithBusyRetry(() => stmts.bookmarkDeleteById.run(Number(id)));
}

// All bookmarks (newest first) or just one session's (in transcript order).
function listBookmarks(sessionId) {
  return sessionId ? stmts.bookmarkListBySession.all(sessionId) : stmts.bookmarkListAll.all();
}

// --- Session tags ---

function getSessionTags(sessionId) {
  return sessionId ? stmts.tagsGet.all(sessionId) : [];
}

// Replace a session's full tag set in one transaction. tags: [{ tag, color }].
const setSessionTagsTx = db.transaction((sessionId, tags) => {
  stmts.tagDeleteAll.run(sessionId);
  for (const t of tags) {
    if (!t || !t.tag) continue;
    const name = String(t.tag);
    // Tagging from the quick editor also creates the def (#138) — a tag typed there
    // must become a first-class tag, not just an assignment. Existing defs keep
    // their colour; recolouring goes through setTagDefColor.
    stmts.tagDefInsert.run('session', name, t.color || null);
    if (t.color) stmts.tagDefSetColor.run(t.color, 'session', name);
    stmts.tagInsert.run(sessionId, name);
  }
});

function setSessionTags(sessionId, tags) {
  if (!sessionId) return [];
  runWithBusyRetry(() => setSessionTagsTx(sessionId, Array.isArray(tags) ? tags : []));
  return stmts.tagsGet.all(sessionId);
}

// Distinct tags across all sessions — for the sidebar tag filter.
function listAllTags() {
  return stmts.tagListAll.all();
}

// Every (sessionId, tag, color) row — the renderer builds a per-session map so
// sidebar chips render synchronously during morphdom reconciliation.
function getAllSessionTags() {
  return stmts.tagAllRows.all();
}

// --- Project tags (#98) — mirror of the session-tag functions, keyed by projectPath ---

function getProjectTags(projectPath) {
  return projectPath ? stmts.projectTagsGet.all(projectPath) : [];
}

// Replace a project's full tag set in one transaction. tags: [{ tag, color }].
const setProjectTagsTx = db.transaction((projectPath, tags) => {
  stmts.projectTagDeleteAll.run(projectPath);
  for (const t of tags) {
    if (!t || !t.tag) continue;
    const name = String(t.tag);
    // See setSessionTagsTx: the quick editor creates defs as a side effect (#138).
    stmts.tagDefInsert.run('project', name, t.color || null);
    if (t.color) stmts.tagDefSetColor.run(t.color, 'project', name);
    stmts.projectTagInsert.run(projectPath, name);
  }
});

function setProjectTags(projectPath, tags) {
  if (!projectPath) return [];
  runWithBusyRetry(() => setProjectTagsTx(projectPath, Array.isArray(tags) ? tags : []));
  return stmts.projectTagsGet.all(projectPath);
}

// --- Tag definitions (#138) ---
// A tag exists in its own right: it can be created before it is used, renamed,
// recoloured, hidden, disabled, and deleted. `kind` separates the two vocabularies
// ('project' | 'session'), so the same name in both is two independent tags.

const TAG_KINDS = new Set(['project', 'session']);

function assertKind(kind) {
  if (!TAG_KINDS.has(kind)) throw new Error('Unknown tag kind: ' + kind);
}

function listTagDefs(kind) {
  assertKind(kind);
  const rows = kind === 'project' ? stmts.tagDefsProject.all() : stmts.tagDefsSession.all();
  return rows.map(r => ({
    name: r.name,
    color: r.color || null,
    hidden: !!r.hidden,
    disabled: !!r.disabled,
    usageCount: r.usageCount || 0,
  }));
}

// Idempotent: assigning a tag from the quick editor calls this, and re-tagging a
// project must not fail just because the def already exists.
function createTagDef(kind, name, color) {
  assertKind(kind);
  const tag = String(name || '').trim();
  if (!tag) return { ok: false, error: 'Tag name is empty' };
  runWithBusyRetry(() => stmts.tagDefInsert.run(kind, tag, color || null));
  return { ok: true };
}

// Renaming onto an existing name is rejected rather than merged: a merge is
// irreversible and almost never what was meant.
const renameTagDefTx = db.transaction((kind, oldName, newName) => {
  stmts.tagDefRename.run(newName, kind, oldName);
  if (kind === 'project') stmts.projectTagsRename.run(newName, oldName);
  else stmts.sessionTagsRename.run(newName, oldName);
});

function renameTagDef(kind, oldName, newName) {
  assertKind(kind);
  const from = String(oldName || '').trim();
  const to = String(newName || '').trim();
  if (!from || !to) return { ok: false, error: 'Tag name is empty' };
  if (from === to) return { ok: true };
  if (!stmts.tagDefGet.get(kind, from)) return { ok: false, error: 'Tag not found' };
  if (stmts.tagDefGet.get(kind, to)) return { ok: false, error: 'A tag with that name already exists' };
  runWithBusyRetry(() => renameTagDefTx(kind, from, to));
  return { ok: true };
}

function setTagDefColor(kind, name, color) {
  assertKind(kind);
  if (!stmts.tagDefGet.get(kind, name)) return { ok: false, error: 'Tag not found' };
  runWithBusyRetry(() => stmts.tagDefSetColor.run(color || null, kind, name));
  return { ok: true };
}

function setTagDefFlags(kind, name, { hidden, disabled } = {}) {
  assertKind(kind);
  const def = stmts.tagDefGet.get(kind, name);
  if (!def) return { ok: false, error: 'Tag not found' };
  const h = hidden === undefined ? def.hidden : (hidden ? 1 : 0);
  const d = disabled === undefined ? def.disabled : (disabled ? 1 : 0);
  runWithBusyRetry(() => stmts.tagDefSetFlags.run(h, d, kind, name));
  return { ok: true };
}

// Deleting a tag takes its assignments with it — the caller is expected to have
// confirmed against the usage count first.
const deleteTagDefTx = db.transaction((kind, name) => {
  stmts.tagDefDelete.run(kind, name);
  if (kind === 'project') stmts.projectTagsDeleteByTag.run(name);
  else stmts.sessionTagsDeleteByTag.run(name);
});

function deleteTagDef(kind, name) {
  assertKind(kind);
  if (!stmts.tagDefGet.get(kind, name)) return { ok: false, error: 'Tag not found' };
  runWithBusyRetry(() => deleteTagDefTx(kind, name));
  return { ok: true };
}

// Distinct tags across all projects — for the sidebar tag filter chip list.
function listAllProjectTags() {
  return stmts.projectTagListAll.all();
}

// Every (projectPath, tag, color) row — the renderer builds a per-project map so
// the sidebar tag filter can match projects synchronously during a refresh.
function getAllProjectTags() {
  return stmts.projectTagAllRows.all();
}

module.exports = {
  toggleBookmark, removeBookmark, listBookmarks,
  getSessionTags, setSessionTags, listAllTags, getAllSessionTags,
  getProjectTags, setProjectTags, listAllProjectTags, getAllProjectTags,
  listTagDefs, createTagDef, renameTagDef, setTagDefColor, setTagDefFlags, deleteTagDef,
  // For project-refs.js's cross-domain transactions only — see the header.
  stmts,
};
