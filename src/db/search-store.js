// Full-text search — the FTS5 index, its two backing tables, and every query against them
// (#217 step 11).
//
// THE DDL IS HERE, NOT IN schema.js, AND THE ORDER IS WHY. Migration v6 DROPS search_fts and
// search_content to rebuild them contentless; the statements below then recreate whatever is missing. So
// this must run AFTER the migrations, while schema.js runs BEFORE them. db.js requires this module below
// runMigrations, which is what keeps that sequence — moving these CREATEs into schema.js would have them
// recreate the tables that v6 is about to drop, on the one run where v6 fires.
//
// THE EXTERNAL-CONTENT PROTOCOL is the thing to understand before touching anything here. search_fts
// stores ONLY the trigram index; it holds no copy of title/body and reads them from search_content at
// query time via content='search_content'. That is what removed the ~14x size amplification of the old
// plain fts5 table. The cost is that the two tables are no longer kept in sync by SQLite: every write has
// to touch search_content AND search_fts, in the right order, or snippet() reads a row that is not there.
// search_map is the third leg — id/type/folder per rowid — so a delete can find its rows without scanning.
//
// db.js re-exports these names unchanged; nothing outside src/db/ knows this file exists.
'use strict';

const { db } = require('./connection');
const { runWithBusyRetry } = require('./sqlite-busy-retry');

//
// Body is capped at FTS_BODY_MAX_CHARS before being stored. This bounds the
// content table size independently of raw transcript length, while keeping
// enough text for useful snippet() previews.
const FTS_BODY_MAX_CHARS = 32768; // 32 768 JS characters (UTF-16 code units); surrogate-pair split at the boundary is negligible for ASCII transcripts

// Query length cap + MATCH building shared with the search worker — rationale
// lives in search-query-util.js (#79).
const { buildFtsMatch } = require('./search-query-util');

// search_content holds the plaintext the fts5 index reads columns from.
// It is the single authoritative copy: title is full-length; body is
// truncated to FTS_BODY_MAX_CHARS. Keeping this separate from search_map
// (which stores only id/type/folder) lets us JOIN on rowid cheaply.
db.exec(`
  CREATE TABLE IF NOT EXISTS search_content (
    rowid INTEGER PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    body  TEXT NOT NULL DEFAULT ''
  )
`);

// search_fts is an external-content fts5 table: it stores only the trigram
// index, not a copy of title/body. snippet()/highlight() work by reading
// the corresponding row from search_content at query time (zero extra copy).
// This eliminates the ~14x amplification of the old plain fts5 table.
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    title, body,
    content='search_content',
    tokenize='trigram case_sensitive 0'
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS search_map (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    folder TEXT
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_search_map_type_id ON search_map(type, id)');

const stmts = {
  // FTS search statements
  // External-content protocol: search_content is the authoritative column store;
  // search_fts holds only the trigram index and reads columns from search_content
  // at query time. Delete/insert must keep both tables in sync.
  searchDeleteContentBySession: db.prepare('DELETE FROM search_content WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND id = ?)'),
  searchDeleteBySession: db.prepare('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND id = ?)'),
  searchMapDeleteBySession: db.prepare('DELETE FROM search_map WHERE type = \'session\' AND id = ?'),
  searchDeleteContentByFolder: db.prepare('DELETE FROM search_content WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND folder = ?)'),
  searchDeleteByFolder: db.prepare('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND folder = ?)'),
  searchMapDeleteByFolder: db.prepare('DELETE FROM search_map WHERE type = \'session\' AND folder = ?'),
  searchDeleteContentByType: db.prepare('DELETE FROM search_content WHERE rowid IN (SELECT rowid FROM search_map WHERE type = ?)'),
  searchDeleteByType: db.prepare('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = ?)'),
  searchMapDeleteByType: db.prepare('DELETE FROM search_map WHERE type = ?'),
  // Insert: search_content row first (external-content protocol requires the
  // content row to exist before the fts5 shadow row is written).
  searchInsertContent: db.prepare('INSERT OR REPLACE INTO search_content(rowid, title, body) VALUES (?, ?, ?)'),
  searchInsertFts: db.prepare('INSERT OR REPLACE INTO search_fts(rowid, title, body) VALUES (?, ?, ?)'),
  searchInsertMap: db.prepare('INSERT OR REPLACE INTO search_map(id, type, folder) VALUES (?, ?, ?)'),
  searchMapLookup: db.prepare('SELECT rowid FROM search_map WHERE id = ? AND type = ?'),
  searchMapCountByType: db.prepare('SELECT COUNT(*) as cnt FROM search_map WHERE type = ?'),
  // Title update: patches search_content (the authoritative column store) and
  // immediately removes the old fts5 shadow row via the 'delete' command then
  // reinserts it with the new title. See updateSearchTitle() for the full
  // two-step delete + reinsert protocol — the index is NOT lazily rebuilt.
  searchUpdateTitle: db.prepare('UPDATE search_content SET title = ? WHERE rowid = (SELECT rowid FROM search_map WHERE id = ? AND type = ?)'),
  searchDeleteContentByRowid: db.prepare('DELETE FROM search_content WHERE rowid = ?'),
  searchDeleteByRowid: db.prepare('DELETE FROM search_fts WHERE rowid = ?'),
  searchMapDeleteByRowid: db.prepare('DELETE FROM search_map WHERE rowid = ?'),
  searchContentGet: db.prepare('SELECT title, body FROM search_content WHERE rowid = ?'),
  // fts5 external-content delete command: removes the shadow row by its old
  // column values. Used before reinserting with updated title.
  searchFtsDeleteRow: db.prepare("INSERT INTO search_fts(search_fts, rowid, title, body) VALUES('delete', ?, ?, ?)"),
  searchFtsInsertRow: db.prepare('INSERT INTO search_fts(rowid, title, body) VALUES(?, ?, ?)'),
  // Settings statements
  searchQuery: db.prepare(`
    SELECT search_map.id, snippet(search_fts, 1, '<mark>', '</mark>', '...', 40) as snippet
    FROM search_fts
    JOIN search_map ON search_fts.rowid = search_map.rowid
    WHERE search_map.type = ? AND search_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `),
};


const upsertSearchEntriesBatch = db.transaction((entries) => {
  for (const e of entries) {
    // Delete any existing FTS + content rows for this (id, type) pair before
    // inserting. search_map uses INSERT OR REPLACE which deletes the old row
    // and creates a new one with a new rowid, but the orphaned search_fts and
    // search_content rows keyed to the old rowid would never be cleaned up —
    // causing duplicate search results and unbounded table growth.
    const existing = stmts.searchMapLookup.get(e.id, e.type);
    if (existing) {
      stmts.searchDeleteByRowid.run(existing.rowid);
      stmts.searchDeleteContentByRowid.run(existing.rowid);
      stmts.searchMapDeleteByRowid.run(existing.rowid);
    }
    const result = stmts.searchInsertMap.run(e.id, e.type, e.folder || null);
    const rid = result.lastInsertRowid;
    const title = e.title || '';
    // Truncate body to FTS_BODY_MAX_CHARS: bounds search_content size and
    // keeps the fts5 index compact without sacrificing meaningful snippets
    // (the first 32 KB of a transcript covers the most-relevant content).
    const body = (e.body || '').slice(0, FTS_BODY_MAX_CHARS);
    // External-content protocol: search_content row must exist before the
    // fts5 shadow row so that fts5 can read columns for snippet() at insert.
    stmts.searchInsertContent.run(rid, title, body);
    stmts.searchInsertFts.run(rid, title, body);
  }
});

function deleteSearchSession(sessionId) {
  // External-content FTS5 protocol: delete from search_fts FIRST while
  // search_content rows still exist. SQLite reads search_content to locate the
  // trigram entries to remove from the shadow tables; if content is gone first,
  // those entries are never cleaned up and accumulate as ghost trigrams.
  // search_map is deleted last because the rowid sub-select in the two DELETE
  // stmts above still needs to resolve. Kept in runWithBusyRetry (HaydnG) for
  // SQLITE_BUSY resilience under concurrent writers.
  runWithBusyRetry(() => {
    stmts.searchDeleteBySession.run(sessionId);
    stmts.searchDeleteContentBySession.run(sessionId);
    stmts.searchMapDeleteBySession.run(sessionId);
  });
}

// `scope` (optional, multi-LLM): restrict the wipe to one backend's sessions. search_map has no
// backendId of its own, so the scope resolves through session_cache. The membership test is phrased
// so it does NOT depend on the caller's delete order: with { except: [...] } an entry survives only
// while a session_cache row explicitly owns it for an excluded backend — an orphaned entry (no cache
// row) is still cleaned up, exactly as the unscoped call would.
function deleteSearchFolder(folder, scope) {
  if (!scope) {
    // Same external-content FTS5 ordering: FTS delete before content delete.
    runWithBusyRetry(() => {
      stmts.searchDeleteByFolder.run(folder);
      stmts.searchDeleteContentByFolder.run(folder);
      stmts.searchMapDeleteByFolder.run(folder);
    });
    return;
  }

  // Both scope kinds resolve to the same shape: list the sessions of a SET of backends, then keep or
  // drop the search entries whose id is in that set.
  //   { only:   [a,b] } -> delete the entries OF a,b            -> id IN     (sessions of {a,b})
  //   { except: [a,b] } -> delete everything BUT a,b's entries  -> id NOT IN (sessions of {a,b})
  const ids = Array.isArray(scope.only) ? scope.only : scope.except;
  const op = Array.isArray(scope.only) ? 'IN' : 'NOT IN';
  const c = backendScopeClause({ only: ids }, 'sc.backendId');
  const sub = 'SELECT sc.sessionId FROM session_cache sc WHERE 1 = 1' + c.sql;
  const mapSel = "SELECT rowid FROM search_map WHERE type = 'session' AND folder = ?"
    + ` AND id ${op} (${sub})`;

  runWithBusyRetry(() => {
    prepScoped(`DELETE FROM search_fts WHERE rowid IN (${mapSel})`).run(folder, ...c.params);
    prepScoped(`DELETE FROM search_content WHERE rowid IN (${mapSel})`).run(folder, ...c.params);
    prepScoped(`DELETE FROM search_map WHERE rowid IN (${mapSel})`).run(folder, ...c.params);
  });
}

function deleteSearchType(type) {
  // Same external-content FTS5 ordering: FTS delete before content delete.
  runWithBusyRetry(() => {
    stmts.searchDeleteByType.run(type);
    stmts.searchDeleteContentByType.run(type);
    stmts.searchMapDeleteByType.run(type);
  });
}

function upsertSearchEntries(entries) {
  runWithBusyRetry(() => upsertSearchEntriesBatch(entries));
}

function updateSearchTitle(id, type, title) {
  // For an external-content fts5 table, updating search_content is the
  // authoritative change (snippet() reads columns from there). The fts5 index
  // is also patched: delete the old shadow row then re-insert with the new
  // title so trigram search on title reflects the rename immediately.
  try {
    runWithBusyRetry(() => {
      const mapRow = stmts.searchMapLookup.get(id, type);
      if (!mapRow) return;
      const rid = mapRow.rowid;
      const contentRow = stmts.searchContentGet.get(rid);
      if (!contentRow) return;
      // Update the content table first.
      stmts.searchUpdateTitle.run(title, id, type);
      // Patch the fts5 index: external-content delete + reinsert.
      // The 'delete' command removes the old shadow row without touching the
      // content table; the plain insert adds the updated shadow row.
      stmts.searchFtsDeleteRow.run(rid, contentRow.title, contentRow.body);
      stmts.searchFtsInsertRow.run(rid, title, contentRow.body);
    });
  } catch {}
}

function searchByType(type, query, limit = 50, titleOnly = false) {
  try {
    // Truncation + quoting + title: filter — see search-query-util.js for the
    // trigram-phrase rationale behind the length cap.
    return stmts.searchQuery.all(type, buildFtsMatch(query, titleOnly), limit);
  } catch {
    return [];
  }
}

function isSearchIndexPopulated() {
  const row = stmts.searchMapCountByType.get('session');
  return row.cnt > 0;
}

// --- Settings functions ---

module.exports = {
  upsertSearchEntries, updateSearchTitle, deleteSearchSession, deleteSearchFolder, deleteSearchType,
  searchByType, isSearchIndexPopulated,
};
