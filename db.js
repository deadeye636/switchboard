const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const { runWithBusyRetry } = require('./sqlite-busy-retry');

// SWITCHBOARD_DATA_DIR lets dev/agent runs use a separate DB from the
// installed app so they don't race on session_cache. Default stays
// ~/.switchboard so existing installs keep working. Resolve env var at
// require-time (any later mutation would be ignored).
const DATA_DIR = process.env.SWITCHBOARD_DATA_DIR
  ? path.resolve(process.env.SWITCHBOARD_DATA_DIR.replace(/^~(?=$|\/)/, os.homedir()))
  : path.join(os.homedir(), '.switchboard');
const fs = require('fs');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'switchboard.db');

// Migrate from old locations if needed
const OLD_LOCATIONS = [
  path.join(os.homedir(), '.claude', 'browser', 'switchboard.db'),
  path.join(os.homedir(), '.claude', 'browser', 'session-browser.db'),
  path.join(os.homedir(), '.claude', 'session-browser.db'),
];
// Skip the legacy ~/.claude/browser/ migration when running with a custom
// DATA_DIR (typical dev/agent setup) — otherwise a fresh dev DB would steal
// the installed app's old data on first launch.
const IS_DEFAULT_DATA_DIR = !process.env.SWITCHBOARD_DATA_DIR;
if (IS_DEFAULT_DATA_DIR && !fs.existsSync(DB_PATH)) {
  for (const oldPath of OLD_LOCATIONS) {
    if (fs.existsSync(oldPath)) {
      fs.renameSync(oldPath, DB_PATH);
      try { fs.renameSync(oldPath + '-wal', DB_PATH + '-wal'); } catch {}
      try { fs.renameSync(oldPath + '-shm', DB_PATH + '-shm'); } catch {}
      break;
    }
  }
}
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
// NORMAL fsyncs only at checkpoints, not every commit — the standard WAL
// pairing; FULL adds no extra integrity in WAL mode but fsyncs every write.
db.pragma('synchronous = NORMAL');
// Bigger page cache + mmap so the hot indexing path (busy multi-agent sessions
// re-index folders on every JSONL append) reads/writes mostly in memory instead
// of hammering the disk. cache_size is negative = KiB (16 MiB); mmap_size in bytes.
db.pragma('cache_size = -16000');
db.pragma('mmap_size = 268435456'); // 256 MiB
// Keep the WAL from ballooning under sustained writes: auto-checkpoint roughly
// every ~8 MiB of WAL (2000 pages) instead of the 4 MiB default, plus a periodic
// PASSIVE checkpoint that reclaims WAL space without ever blocking writers.
db.pragma('wal_autocheckpoint = 2000');
// Only the main process runs the periodic reclaim; a worker thread that opens
// the DB (read-only search connection) must not fire its own checkpoints.
let _isMainThread = true;
try { _isMainThread = require('worker_threads').isMainThread; } catch {}
if (_isMainThread) {
  const _walCheckpointTimer = setInterval(() => {
    try { db.pragma('wal_checkpoint(PASSIVE)'); } catch {}
  }, 60000);
  if (typeof _walCheckpointTimer.unref === 'function') _walCheckpointTimer.unref();
}

db.exec(`
  CREATE TABLE IF NOT EXISTS session_meta (
    sessionId TEXT PRIMARY KEY,
    name TEXT,
    starred INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS session_cache (
    sessionId TEXT PRIMARY KEY,
    folder TEXT NOT NULL,
    projectPath TEXT,
    summary TEXT,
    firstPrompt TEXT,
    created TEXT,
    modified TEXT,
    messageCount INTEGER DEFAULT 0,
    userMessageCount INTEGER DEFAULT 0,
    inputTokens INTEGER DEFAULT 0,
    outputTokens INTEGER DEFAULT 0,
    cacheCreationTokens INTEGER DEFAULT 0,
    cacheReadTokens INTEGER DEFAULT 0,
    largestUserPromptWords INTEGER DEFAULT 0,
    startedAt TEXT,
    lastEntryAt TEXT,
    activeMinutes INTEGER DEFAULT 0,
    slug TEXT,
    aiTitle TEXT,
    parentSessionId TEXT,
    agentId TEXT,
    subagentType TEXT,
    description TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cache_meta (
    folder TEXT PRIMARY KEY,
    projectPath TEXT,
    indexMtimeMs REAL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);

// Per-project metadata, keyed by the real projectPath (NOT the encoded folder).
// Kept in its own table — cache_meta is wiped on cache-clearing migrations, but
// favorites must survive. projectPath is stable across folder re-encoding.
db.exec(`
  CREATE TABLE IF NOT EXISTS project_meta (
    projectPath TEXT PRIMARY KEY,
    favorited INTEGER DEFAULT 0
  )
`);

// Bookmarks — flag individual transcript messages, anchored by {sessionId, entryIndex}.
// <old-codename> JSONL has no per-message uuid, so the position index is the stable anchor;
// timestamp/label are denormalized for display so the overlay needs no transcript re-read.
db.exec(`
  CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sessionId TEXT NOT NULL,
    entryIndex INTEGER NOT NULL,
    timestamp TEXT,
    label TEXT,
    createdAt INTEGER NOT NULL,
    UNIQUE(sessionId, entryIndex)
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_bookmarks_session ON bookmarks(sessionId)');

// Session tags — colored labels, many per session, shown as sidebar chips.
db.exec(`
  CREATE TABLE IF NOT EXISTS session_tags (
    sessionId TEXT NOT NULL,
    tag TEXT NOT NULL,
    color TEXT,
    PRIMARY KEY (sessionId, tag)
  )
`);

// Project handoffs — saved handoff packets (markdown) per project, for the
// Handoff library: created from a running session, later seeded into a fresh one.
db.exec(`
  CREATE TABLE IF NOT EXISTS project_handoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectPath TEXT NOT NULL,
    label TEXT,
    content TEXT NOT NULL,
    createdAt TEXT NOT NULL
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_project_handoffs_project ON project_handoffs(projectPath)');

// Saved variables — named, reusable values (name+value) shown in the terminal
// Saved Variables panel. Optionally secret (value encrypted at-rest via Electron
// safeStorage), scoped global or per-project, with freeform tags.
db.exec(`
  CREATE TABLE IF NOT EXISTS saved_variables (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    valueEncoding TEXT DEFAULT 'plain',
    secret INTEGER DEFAULT 0,
    scope TEXT DEFAULT 'global',
    projectPath TEXT,
    tags TEXT DEFAULT '[]',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    lastUsedAt TEXT
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_saved_variables_scope_project ON saved_variables(scope, projectPath)');

// Index for fast folder lookups
db.exec('CREATE INDEX IF NOT EXISTS idx_session_cache_folder ON session_cache(folder)');
db.exec('CREATE INDEX IF NOT EXISTS idx_session_cache_slug ON session_cache(slug)');

// --- Migrations ---
// Each migration runs once, in order. Add new migrations to the end.
let searchFtsRecreated = false;
const migrations = [
  // v1: (superseded by v2)
  () => {},
  // v2: Clear session cache to re-index with corrected worktree paths
  (db) => {
    try { db.exec('DELETE FROM session_cache'); } catch {}
    try { db.exec('DELETE FROM cache_meta'); } catch {}
    try { db.exec('DELETE FROM search_map'); } catch {}
    try { db.exec('DROP TABLE IF EXISTS search_fts'); } catch {}
    searchFtsRecreated = true;
  },
  // v3: Add aiTitle column for AI-generated session titles. Clear cache so a
  // re-index repopulates the column. Also clear session_meta.name entries that
  // were clobbered by AI titles in v0.0.29 (when ai-title was written into the
  // user-name column). We cannot tell with certainty which names came from an
  // AI title vs a manual rename, but the safe heuristic is: drop names whose
  // value matches the JSONL aiTitle on next index. That post-index cleanup is
  // not done here — instead we accept that any pre-fix AI-title pollution
  // remains until the user renames manually, and only future indexes are clean.
  (db) => {
    try { db.exec('ALTER TABLE session_cache ADD COLUMN aiTitle TEXT'); } catch {}
    try { db.exec('DELETE FROM session_cache'); } catch {}
    try { db.exec('DELETE FROM cache_meta'); } catch {}
  },
  // v4: Add session health metrics derived from JSONL usage/timestamp data.
  (db) => {
    const columns = [
      'ALTER TABLE session_cache ADD COLUMN userMessageCount INTEGER DEFAULT 0',
      'ALTER TABLE session_cache ADD COLUMN inputTokens INTEGER DEFAULT 0',
      'ALTER TABLE session_cache ADD COLUMN outputTokens INTEGER DEFAULT 0',
      'ALTER TABLE session_cache ADD COLUMN cacheCreationTokens INTEGER DEFAULT 0',
      'ALTER TABLE session_cache ADD COLUMN cacheReadTokens INTEGER DEFAULT 0',
      'ALTER TABLE session_cache ADD COLUMN largestUserPromptWords INTEGER DEFAULT 0',
      'ALTER TABLE session_cache ADD COLUMN startedAt TEXT',
      'ALTER TABLE session_cache ADD COLUMN lastEntryAt TEXT',
      'ALTER TABLE session_cache ADD COLUMN activeMinutes INTEGER DEFAULT 0',
    ];
    for (const sql of columns) {
      try { db.exec(sql); } catch {}
    }
    try { db.exec('DELETE FROM session_cache'); } catch {}
    try { db.exec('DELETE FROM cache_meta'); } catch {}
    try { db.exec('DELETE FROM search_map'); } catch {}
    try { db.exec('DELETE FROM search_fts'); } catch {}
  },
  // v6: Convert search_fts from a plain fts5 table (which stores a full copy of
  // title+body, inflating the DB ~14x) to an external-content fts5 table backed
  // by search_content (which stores a single, truncated copy). This drops the DB
  // from ~190 MB to ~35-40 MB for a typical 13 MB raw-text corpus.
  //
  // snippet() continues to work unchanged: fts5 reads the columns from
  // search_content on demand instead of its own shadow tables. The body stored
  // in search_content is truncated to FTS_BODY_MAX_CHARS (32 KB) so the content
  // table itself stays small.
  //
  // searchFtsRecreated = true tells main.js to trigger a full repopulate via
  // populateCacheViaWorker(), which will re-insert all rows with the new schema.
  //
  // VACUUM: the DROP TABLE calls above free ~152 MB of pages (the old plain
  // search_fts shadow tables) but SQLite only adds them to the freelist — the
  // file stays at its old size. Without VACUUM the user sees "stopped growing"
  // rather than "actually shrank". A one-time VACUUM here reclaims that space
  // immediately: empirically 225 MB → 37.9 MB in ~0.5 s on a 236 MB real DB.
  // VACUUM cannot run inside a SQLite transaction. The migrations loop (lines
  // above) is NOT wrapped in a transaction, so calling db.exec('VACUUM') here
  // is legal and runs atomically against the now-empty freelist pages.
  (db) => {
    try { db.exec('DROP TABLE IF EXISTS search_fts'); } catch {}
    try { db.exec('DROP TABLE IF EXISTS search_content'); } catch {}
    try { db.exec('DELETE FROM search_map'); } catch {}
    try { db.exec('VACUUM'); } catch {}
    searchFtsRecreated = true;
  },
  // v7: Add subagent columns (appended after HaydnG's metrics+FTS migrations).
  // Subagent transcripts live under
  // <folder>/<parentSessionId>/subagents/agent-<agentId>.jsonl alongside a
  // .meta.json sidecar holding { agentType, description }. We surface them as
  // first-class rows in session_cache, keyed by sessionId = "sub:<parent>:<agentId>".
  // Clear cache so subagent rows get picked up on first re-index.
  (db) => {
    try { db.exec('ALTER TABLE session_cache ADD COLUMN parentSessionId TEXT'); } catch {}
    try { db.exec('ALTER TABLE session_cache ADD COLUMN agentId TEXT'); } catch {}
    try { db.exec('ALTER TABLE session_cache ADD COLUMN subagentType TEXT'); } catch {}
    try { db.exec('ALTER TABLE session_cache ADD COLUMN description TEXT'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_session_cache_parent ON session_cache(parentSessionId)'); } catch {}
    try { db.exec('DELETE FROM session_cache'); } catch {}
    try { db.exec('DELETE FROM cache_meta'); } catch {}
  },
  // v8: per-(session,date,model) metrics for the stats screen (tokens, tool calls,
  // messages bucketed by message timestamp). Appended after HaydnG's subagent
  // migration. Populated on next cold-start rebuild (the scan worker re-reads
  // every JSONL), so no separate backfill is needed.
  (db) => {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS session_metrics (
        sessionId TEXT NOT NULL,
        date TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        messageCount INTEGER DEFAULT 0,
        toolCallCount INTEGER DEFAULT 0,
        inputTokens INTEGER DEFAULT 0,
        outputTokens INTEGER DEFAULT 0,
        cacheReadTokens INTEGER DEFAULT 0,
        cacheCreationTokens INTEGER DEFAULT 0,
        PRIMARY KEY (sessionId, date, model)
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_session_metrics_date ON session_metrics(date)');
    } catch {}
  },
];

const currentDbVersion = (() => {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'db_version'").get();
    return row ? JSON.parse(row.value) : 0;
  } catch { return 0; }
})();

for (let i = currentDbVersion; i < migrations.length; i++) {
  migrations[i](db);
}
if (migrations.length > currentDbVersion) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', ?)").run(JSON.stringify(migrations.length));
}

// --- FTS5 full-text search (external-content table) ---
//
// Body is capped at FTS_BODY_MAX_CHARS before being stored. This bounds the
// content table size independently of raw transcript length, while keeping
// enough text for useful snippet() previews.
const FTS_BODY_MAX_CHARS = 32768; // 32 768 JS characters (UTF-16 code units); surrogate-pair split at the boundary is negligible for ASCII transcripts

// FTS_QUERY_MAX_CHARS caps the length of the query string passed to FTS5.
// A trigram-tokenized FTS5 table with tokenize='trigram' builds one trigram per
// 3-char sliding window. When the query is wrapped in double-quotes (phrase query),
// FTS5 intersects ALL trigram doclists in order — a 60-char URL produces ~58
// overlapping trigrams. Common trigrams like "://" or "git" can appear in tens of
// thousands of rows; intersecting all doclists as a contiguous phrase forces FTS5
// to scan enormous intermediate sets and blocks the SQLite main thread for ~60 s.
// Capping the query at 48 chars limits the phrase to ≤46 trigrams (safe upper bound
// for a synchronous main-thread query on a 4000+ session index) while covering any
// plausible hand-typed search string. Longer inputs (pasted URLs, long stack traces)
// are silently truncated — the first 48 chars remain actionable search terms.
const FTS_QUERY_MAX_CHARS = 48;

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
  get: db.prepare('SELECT * FROM session_meta WHERE sessionId = ?'),
  getAll: db.prepare('SELECT * FROM session_meta'),
  upsertName: db.prepare(`
    INSERT INTO session_meta (sessionId, name) VALUES (?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET name = excluded.name
  `),
  upsertStar: db.prepare(`
    INSERT INTO session_meta (sessionId, starred) VALUES (?, 1)
    ON CONFLICT(sessionId) DO UPDATE SET starred = CASE WHEN starred = 1 THEN 0 ELSE 1 END
  `),
  upsertArchived: db.prepare(`
    INSERT INTO session_meta (sessionId, archived) VALUES (?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET archived = excluded.archived
  `),
  // Project favorites (toggle on the real projectPath, analog to upsertStar)
  projectFavoriteToggle: db.prepare(`
    INSERT INTO project_meta (projectPath, favorited) VALUES (?, 1)
    ON CONFLICT(projectPath) DO UPDATE SET favorited = CASE WHEN favorited = 1 THEN 0 ELSE 1 END
  `),
  projectMetaGet: db.prepare('SELECT * FROM project_meta WHERE projectPath = ?'),
  projectMetaGetAll: db.prepare('SELECT projectPath FROM project_meta WHERE favorited = 1'),
  settingsByPrefix: db.prepare('SELECT key, value FROM settings WHERE key LIKE ?'),
  // Bookmarks (toggle by {sessionId, entryIndex} anchor)
  bookmarkGet: db.prepare('SELECT id FROM bookmarks WHERE sessionId = ? AND entryIndex = ?'),
  bookmarkInsert: db.prepare('INSERT INTO bookmarks (sessionId, entryIndex, timestamp, label, createdAt) VALUES (?, ?, ?, ?, ?)'),
  bookmarkDeleteByAnchor: db.prepare('DELETE FROM bookmarks WHERE sessionId = ? AND entryIndex = ?'),
  bookmarkDeleteById: db.prepare('DELETE FROM bookmarks WHERE id = ?'),
  bookmarkListAll: db.prepare('SELECT * FROM bookmarks ORDER BY createdAt DESC'),
  bookmarkListBySession: db.prepare('SELECT * FROM bookmarks WHERE sessionId = ? ORDER BY entryIndex ASC'),
  // Project handoffs (Handoff library)
  handoffInsert: db.prepare('INSERT INTO project_handoffs (projectPath, label, content, createdAt) VALUES (?, ?, ?, ?)'),
  handoffListByProject: db.prepare('SELECT id, label, content, createdAt FROM project_handoffs WHERE projectPath = ? ORDER BY createdAt DESC'),
  handoffDeleteById: db.prepare('DELETE FROM project_handoffs WHERE id = ?'),
  // Session tags
  tagsGet: db.prepare('SELECT tag, color FROM session_tags WHERE sessionId = ? ORDER BY tag'),
  tagInsert: db.prepare('INSERT OR REPLACE INTO session_tags (sessionId, tag, color) VALUES (?, ?, ?)'),
  tagDeleteAll: db.prepare('DELETE FROM session_tags WHERE sessionId = ?'),
  tagListAll: db.prepare('SELECT DISTINCT tag, color FROM session_tags ORDER BY tag'),
  tagAllRows: db.prepare('SELECT sessionId, tag, color FROM session_tags ORDER BY tag'),
  // Session cache statements
  cacheCount: db.prepare('SELECT COUNT(*) as cnt FROM session_cache'),
  cacheGetAll: db.prepare('SELECT * FROM session_cache'),
  cacheUpsert: db.prepare(`
    INSERT INTO session_cache (
      sessionId, folder, projectPath, summary, firstPrompt, created, modified,
      messageCount, userMessageCount, inputTokens, outputTokens, cacheCreationTokens,
      cacheReadTokens, largestUserPromptWords, startedAt, lastEntryAt, activeMinutes,
      slug, aiTitle,
      parentSessionId, agentId, subagentType, description
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET
      folder = excluded.folder, projectPath = excluded.projectPath,
      summary = excluded.summary, firstPrompt = excluded.firstPrompt,
      created = excluded.created, modified = excluded.modified,
      messageCount = excluded.messageCount,
      userMessageCount = excluded.userMessageCount,
      inputTokens = excluded.inputTokens,
      outputTokens = excluded.outputTokens,
      cacheCreationTokens = excluded.cacheCreationTokens,
      cacheReadTokens = excluded.cacheReadTokens,
      largestUserPromptWords = excluded.largestUserPromptWords,
      startedAt = excluded.startedAt,
      lastEntryAt = excluded.lastEntryAt,
      activeMinutes = excluded.activeMinutes,
      slug = excluded.slug,
      aiTitle = excluded.aiTitle,
      parentSessionId = excluded.parentSessionId,
      agentId = excluded.agentId,
      subagentType = excluded.subagentType,
      description = excluded.description
  `),
  cacheGetByParent: db.prepare('SELECT * FROM session_cache WHERE parentSessionId = ? ORDER BY created ASC'),
  cacheGetByFolder: db.prepare('SELECT sessionId, modified, parentSessionId, agentId FROM session_cache WHERE folder = ?'),
  cacheGetFolder: db.prepare('SELECT folder FROM session_cache WHERE sessionId = ?'),
  cacheGetSession: db.prepare('SELECT * FROM session_cache WHERE sessionId = ?'),
  cacheDeleteSession: db.prepare('DELETE FROM session_cache WHERE sessionId = ?'),
  cacheDeleteFolder: db.prepare('DELETE FROM session_cache WHERE folder = ?'),
  // Session metrics statements (per-(session,date,model) token/tool/message counts)
  metricsDeleteBySession: db.prepare('DELETE FROM session_metrics WHERE sessionId = ?'),
  metricsDeleteByFolder: db.prepare('DELETE FROM session_metrics WHERE sessionId IN (SELECT sessionId FROM session_cache WHERE folder = ?)'),
  metricsInsert: db.prepare(`
    INSERT INTO session_metrics
      (sessionId, date, model, messageCount, toolCallCount, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  // Cache meta statements
  metaGet: db.prepare('SELECT * FROM cache_meta WHERE folder = ?'),
  metaGetAll: db.prepare('SELECT * FROM cache_meta'),
  metaUpsert: db.prepare(`
    INSERT INTO cache_meta (folder, projectPath, indexMtimeMs)
    VALUES (?, ?, ?)
    ON CONFLICT(folder) DO UPDATE SET
      projectPath = excluded.projectPath, indexMtimeMs = excluded.indexMtimeMs
  `),
  metaDelete: db.prepare('DELETE FROM cache_meta WHERE folder = ?'),
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
  settingsGet: db.prepare('SELECT value FROM settings WHERE key = ?'),
  settingsUpsert: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
  settingsDelete: db.prepare('DELETE FROM settings WHERE key = ?'),
  // Saved variables (Saved Variables panel)
  savedVariablesList: db.prepare(`
    SELECT id, name, secret, scope, projectPath, tags, createdAt, updatedAt, lastUsedAt
    FROM saved_variables
    WHERE scope = 'global' OR (scope = 'project' AND projectPath = ?)
    ORDER BY LOWER(name), updatedAt DESC
  `),
  savedVariableGet: db.prepare('SELECT * FROM saved_variables WHERE id = ?'),
  savedVariableUpsert: db.prepare(`
    INSERT INTO saved_variables
      (id, name, value, valueEncoding, secret, scope, projectPath, tags, createdAt, updatedAt, lastUsedAt)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      value = excluded.value,
      valueEncoding = excluded.valueEncoding,
      secret = excluded.secret,
      scope = excluded.scope,
      projectPath = excluded.projectPath,
      tags = excluded.tags,
      updatedAt = excluded.updatedAt
  `),
  savedVariableDelete: db.prepare('DELETE FROM saved_variables WHERE id = ?'),
  savedVariableTouch: db.prepare('UPDATE saved_variables SET lastUsedAt = ? WHERE id = ?'),
  searchQuery: db.prepare(`
    SELECT search_map.id, snippet(search_fts, 1, '<mark>', '</mark>', '...', 40) as snippet
    FROM search_fts
    JOIN search_map ON search_fts.rowid = search_map.rowid
    WHERE search_map.type = ? AND search_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `),
};

function getMeta(sessionId) {
  return stmts.get.get(sessionId) || null;
}

function getAllMeta() {
  const rows = stmts.getAll.all();
  const map = new Map();
  for (const row of rows) map.set(row.sessionId, row);
  return map;
}

function setName(sessionId, name) {
  runWithBusyRetry(() => stmts.upsertName.run(sessionId, name));
}

function toggleStar(sessionId) {
  runWithBusyRetry(() => stmts.upsertStar.run(sessionId));
  const row = stmts.get.get(sessionId);
  return row.starred;
}

function setArchived(sessionId, archived) {
  runWithBusyRetry(() => stmts.upsertArchived.run(sessionId, archived ? 1 : 0));
}

function toggleProjectFavorite(projectPath) {
  runWithBusyRetry(() => stmts.projectFavoriteToggle.run(projectPath));
  const row = stmts.projectMetaGet.get(projectPath);
  return row ? row.favorited : 0;
}

// Set of projectPaths currently favorited — consumed by buildProjectsFromCache.
function getFavoritedProjects() {
  const set = new Set();
  for (const row of stmts.projectMetaGetAll.all()) set.add(row.projectPath);
  return set;
}

// Map projectPath -> custom displayName (only non-empty), from the per-project
// settings blobs (`project:<path>`). Consumed wherever a project name is rendered.
function getProjectDisplayNames() {
  const map = new Map();
  for (const row of stmts.settingsByPrefix.all('project:%')) {
    let val;
    try { val = JSON.parse(row.value); } catch { val = null; }
    const name = val && typeof val.displayName === 'string' ? val.displayName.trim() : '';
    if (name) map.set(row.key.slice('project:'.length), name);
  }
  return map;
}

// --- Bookmarks + session tags ---

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

// --- Project handoffs (Handoff library) ---
function saveProjectHandoff(projectPath, label, content) {
  const info = runWithBusyRetry(() =>
    stmts.handoffInsert.run(projectPath, label || null, String(content || ''), new Date().toISOString()));
  return info.lastInsertRowid;
}

function listProjectHandoffs(projectPath) {
  return projectPath ? stmts.handoffListByProject.all(projectPath) : [];
}

function deleteProjectHandoff(id) {
  runWithBusyRetry(() => stmts.handoffDeleteById.run(Number(id)));
}

function getSessionTags(sessionId) {
  return sessionId ? stmts.tagsGet.all(sessionId) : [];
}

// Replace a session's full tag set in one transaction. tags: [{ tag, color }].
const setSessionTagsTx = db.transaction((sessionId, tags) => {
  stmts.tagDeleteAll.run(sessionId);
  for (const t of tags) {
    if (t && t.tag) stmts.tagInsert.run(sessionId, String(t.tag), t.color || null);
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

// --- Session cache functions ---

function isCachePopulated() {
  return stmts.cacheCount.get().cnt > 0;
}

function getAllCached() {
  return stmts.cacheGetAll.all();
}

const upsertCachedSessionsBatch = db.transaction((sessions) => {
  for (const s of sessions) {
    stmts.cacheUpsert.run(
      s.sessionId, s.folder, s.projectPath, s.summary,
      s.firstPrompt, s.created, s.modified, s.messageCount || 0,
      s.userMessageCount || 0, s.inputTokens || 0, s.outputTokens || 0,
      s.cacheCreationTokens || 0, s.cacheReadTokens || 0,
      s.largestUserPromptWords || 0, s.startedAt || null, s.lastEntryAt || null,
      s.activeMinutes || 0,
      s.slug || null, s.aiTitle || null,
      s.parentSessionId || null, s.agentId || null,
      s.subagentType || null, s.description || null
    );
  }
});

// Replace all metric rows for a session in one transaction: delete-by-session
// then insert the fresh per-(date,model) rows. Called whenever a session is read
// in full (cold-start rebuild + NEW-file branch of the incremental refresh).
const replaceSessionMetricsBatch = db.transaction((sessionId, rows) => {
  stmts.metricsDeleteBySession.run(sessionId);
  for (const r of rows || []) {
    stmts.metricsInsert.run(
      sessionId, r.date, r.model || '',
      r.messageCount | 0, r.toolCallCount | 0,
      r.inputTokens | 0, r.outputTokens | 0,
      r.cacheReadTokens | 0, r.cacheCreationTokens | 0
    );
  }
});

function replaceSessionMetrics(sessionId, rows) {
  replaceSessionMetricsBatch(sessionId, rows);
}

function getCachedByParent(parentSessionId) {
  return stmts.cacheGetByParent.all(parentSessionId);
}

function upsertCachedSessions(sessions) {
  runWithBusyRetry(() => upsertCachedSessionsBatch(sessions));
}

function getCachedByFolder(folder) {
  return stmts.cacheGetByFolder.all(folder);
}

function getCachedFolder(sessionId) {
  const row = stmts.cacheGetFolder.get(sessionId);
  return row ? row.folder : null;
}

function getCachedSession(sessionId) {
  return stmts.cacheGetSession.get(sessionId) || null;
}

function deleteCachedSession(sessionId) {
  runWithBusyRetry(() => {
    stmts.metricsDeleteBySession.run(sessionId);
    stmts.cacheDeleteSession.run(sessionId);
  });
}

function deleteCachedFolder(folder) {
  runWithBusyRetry(() => {
    // Delete metrics first — metricsDeleteByFolder sub-selects on session_cache,
    // so it must run before the session_cache rows for this folder are gone.
    stmts.metricsDeleteByFolder.run(folder);
    stmts.cacheDeleteFolder.run(folder);
    stmts.metaDelete.run(folder);
  });
}

function getFolderMeta(folder) {
  return stmts.metaGet.get(folder) || null;
}

function getAllFolderMeta() {
  const rows = stmts.metaGetAll.all();
  const map = new Map();
  for (const row of rows) map.set(row.folder, row);
  return map;
}

function setFolderMeta(folder, projectPath, indexMtimeMs) {
  runWithBusyRetry(() => stmts.metaUpsert.run(folder, projectPath, indexMtimeMs));
}

// --- FTS search functions ---

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

function deleteSearchFolder(folder) {
  // Same external-content FTS5 ordering: FTS delete before content delete.
  runWithBusyRetry(() => {
    stmts.searchDeleteByFolder.run(folder);
    stmts.searchDeleteContentByFolder.run(folder);
    stmts.searchMapDeleteByFolder.run(folder);
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
    // Cap query length before building the FTS MATCH expression.
    // A trigram phrase query over a long input (e.g. a 60-char GitLab URL) generates
    // ~58 overlapping trigrams that FTS5 must intersect as a contiguous phrase.
    // Common trigrams ("://", "git", "/-/") have enormous doclists on a large index,
    // and the phrase-intersect blocks the SQLite main thread for up to ~60 s.
    // Truncating to FTS_QUERY_MAX_CHARS (48) limits phrase queries to ≤46 trigrams —
    // safe for a synchronous main-thread query — while preserving normal short searches.
    const bounded = query.slice(0, FTS_QUERY_MAX_CHARS);
    // Wrap in double quotes for exact substring matching with trigram tokenizer.
    // This prevents FTS5 from splitting on punctuation (e.g. "spec.md" → "spec" + "md")
    const escaped = '"' + bounded.replace(/"/g, '""') + '"';
    // FTS5 column filter: prefix with "title:" to restrict match to title column
    const match = titleOnly ? 'title:' + escaped : escaped;
    return stmts.searchQuery.all(type, match, limit);
  } catch {
    return [];
  }
}

function isSearchIndexPopulated() {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM search_map WHERE type = ?').get('session');
  return row.cnt > 0;
}

// --- Settings functions ---

function getSetting(key) {
  const row = stmts.settingsGet.get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function setSetting(key, value) {
  runWithBusyRetry(() => stmts.settingsUpsert.run(key, JSON.stringify(value)));
}

function deleteSetting(key) {
  runWithBusyRetry(() => stmts.settingsDelete.run(key));
}

// --- Saved variable functions ---

function parseSavedVariableTags(tags) {
  if (Array.isArray(tags)) return tags;
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeSavedVariableRow(row) {
  if (!row) return null;
  return {
    ...row,
    secret: !!row.secret,
    tags: parseSavedVariableTags(row.tags),
  };
}

function listSavedVariables(projectPath = null) {
  return stmts.savedVariablesList.all(projectPath || '').map(normalizeSavedVariableRow);
}

function getSavedVariable(id) {
  return normalizeSavedVariableRow(stmts.savedVariableGet.get(id));
}

function saveSavedVariable(variable) {
  const now = variable.updatedAt || new Date().toISOString();
  const existing = variable.id ? stmts.savedVariableGet.get(variable.id) : null;
  const createdAt = variable.createdAt || existing?.createdAt || now;
  const row = {
    id: variable.id,
    name: variable.name,
    value: variable.value,
    valueEncoding: variable.valueEncoding || 'plain',
    secret: variable.secret ? 1 : 0,
    scope: variable.scope || 'global',
    projectPath: variable.scope === 'project' ? (variable.projectPath || null) : null,
    tags: JSON.stringify(Array.isArray(variable.tags) ? variable.tags : []),
    createdAt,
    updatedAt: now,
    lastUsedAt: existing?.lastUsedAt || null,
  };
  runWithBusyRetry(() => stmts.savedVariableUpsert.run(
    row.id, row.name, row.value, row.valueEncoding, row.secret, row.scope,
    row.projectPath, row.tags, row.createdAt, row.updatedAt, row.lastUsedAt
  ));
  return getSavedVariable(row.id);
}

function deleteSavedVariable(id) {
  runWithBusyRetry(() => stmts.savedVariableDelete.run(id));
}

function touchSavedVariable(id) {
  runWithBusyRetry(() => stmts.savedVariableTouch.run(new Date().toISOString(), id));
}

// --- Daily activity aggregate (for stats heatmap) ---

// Returns [{date: 'YYYY-MM-DD', messageCount, sessionCount}, ...] sorted ASC.
// Aggregates ALL rows in session_cache (parent sessions + subagents) so the
// heatmap reflects real usage regardless of whether Claude rotated the parent
// JSONL files.
function getDailyActivity() {
  return db.prepare(`
    SELECT
      substr(modified, 1, 10) AS date,
      SUM(messageCount)       AS messageCount,
      COUNT(*)                AS sessionCount
    FROM session_cache
    WHERE modified IS NOT NULL
      AND length(modified) >= 10
    GROUP BY date
    ORDER BY date ASC
  `).all();
}

// --- Session metrics aggregates (for the stats screen) ---

// One row per day, summed across all models. Powers the heatmap + daily bars.
// messageCount/toolCallCount/tokens come from session_metrics (bucketed by the
// per-message timestamp, not the session mtime); sessionCount counts distinct
// sessions active that day.
// Stats statements are memoized on first use (the stats screen may never be
// opened) instead of being re-parsed on every call.
let dailyMetricsStmt;
function getDailyMetrics() {
  dailyMetricsStmt ??= db.prepare(`
    SELECT date,
           SUM(messageCount)            AS messageCount,
           SUM(toolCallCount)           AS toolCallCount,
           SUM(inputTokens + outputTokens) AS tokens,
           COUNT(DISTINCT sessionId)    AS sessionCount
    FROM session_metrics
    GROUP BY date
    ORDER BY date ASC
  `);
  return dailyMetricsStmt.all();
}

// [{date, tokensByModel: {model: tokens}}] sorted by date. Excludes the '' model
// bucket (synthetic / model-less assistant turns carry no tokens anyway).
let dailyModelTokensStmt;
function getDailyModelTokens() {
  dailyModelTokensStmt ??= db.prepare(`
    SELECT date, model, SUM(inputTokens + outputTokens) AS tokens
    FROM session_metrics
    WHERE model != ''
    GROUP BY date, model
  `);
  const rows = dailyModelTokensStmt.all();
  const byDate = new Map();
  for (const r of rows) {
    let entry = byDate.get(r.date);
    if (!entry) {
      entry = { date: r.date, tokensByModel: {} };
      byDate.set(r.date, entry);
    }
    entry.tokensByModel[r.model] = r.tokens;
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// {model: {inputTokens, outputTokens}} across all time. Excludes '' model.
let modelUsageStmt;
function getModelUsage() {
  modelUsageStmt ??= db.prepare(`
    SELECT model,
           SUM(inputTokens)  AS inputTokens,
           SUM(outputTokens) AS outputTokens
    FROM session_metrics
    WHERE model != ''
    GROUP BY model
  `);
  const rows = modelUsageStmt.all();
  const out = {};
  for (const r of rows) {
    out[r.model] = { inputTokens: r.inputTokens, outputTokens: r.outputTokens };
  }
  return out;
}

// {totalSessions, totalMessages, totalToolCalls, totalTokens}. totalSessions
// counts ONLY parent (human) sessions — subagents would otherwise inflate it.
let totalSessionsStmt, totalMetricsStmt;
function getTotalCounts() {
  totalSessionsStmt ??= db.prepare(
    'SELECT COUNT(*) AS cnt FROM session_cache WHERE parentSessionId IS NULL'
  );
  totalMetricsStmt ??= db.prepare(`
    SELECT
      SUM(messageCount)            AS totalMessages,
      SUM(toolCallCount)           AS totalToolCalls,
      SUM(inputTokens + outputTokens) AS totalTokens
    FROM session_metrics
  `);
  const sessions = totalSessionsStmt.get();
  const metrics = totalMetricsStmt.get();
  return {
    totalSessions: sessions.cnt || 0,
    totalMessages: metrics.totalMessages || 0,
    totalToolCalls: metrics.totalToolCalls || 0,
    totalTokens: metrics.totalTokens || 0,
  };
}

function closeDb() {
  // Truncate the WAL back into the main file on clean shutdown. Long-lived
  // reader connections (the scan worker) can starve SQLite's automatic
  // checkpoints, letting the -wal file grow to tens of MB and adding read
  // amplification on the next run.
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  try { db.close(); } catch {}
}

module.exports = {
  getMeta, getAllMeta, setName, toggleStar, setArchived,
  toggleProjectFavorite, getFavoritedProjects, getProjectDisplayNames,
  toggleBookmark, removeBookmark, listBookmarks,
  saveProjectHandoff, listProjectHandoffs, deleteProjectHandoff,
  getSessionTags, setSessionTags, listAllTags, getAllSessionTags,
  isCachePopulated, getAllCached, getCachedByFolder, getCachedByParent, getCachedFolder, getCachedSession, upsertCachedSessions,
  deleteCachedSession, deleteCachedFolder,
  replaceSessionMetrics,
  getFolderMeta, getAllFolderMeta, setFolderMeta,
  upsertSearchEntries, updateSearchTitle, deleteSearchSession, deleteSearchFolder, deleteSearchType,
  searchByType, isSearchIndexPopulated, searchFtsRecreated,
  getSetting, setSetting, deleteSetting,
  listSavedVariables, getSavedVariable, saveSavedVariable, deleteSavedVariable, touchSavedVariable,
  getDailyActivity,
  getDailyMetrics, getDailyModelTokens, getModelUsage, getTotalCounts,
  closeDb,
  // Exported so main.js can pass the resolved path to the search-query worker
  // without re-deriving the SWITCHBOARD_DATA_DIR logic in a second place.
  DB_PATH,
};
