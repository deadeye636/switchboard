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
    favorited INTEGER DEFAULT 0,
    autoHidden INTEGER DEFAULT 0,
    autoHideResetAt TEXT
  )
`);
// Idempotently add the auto-hide columns to project_meta tables created before
// the #57 auto-hide feature (the CREATE TABLE above already has them for fresh
// installs). autoHidden marks a hide that was set automatically (vs. manual);
// autoHideResetAt restarts the inactivity timer (grace after unhide / re-add).
try { db.exec('ALTER TABLE project_meta ADD COLUMN autoHidden INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE project_meta ADD COLUMN autoHideResetAt TEXT'); } catch {}

// Bookmarks — flag individual transcript messages, anchored by {sessionId, entryIndex}.
// deadeye JSONL has no per-message uuid, so the position index is the stable anchor;
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

// Tasks — a local task/note system. Every task is scoped: to a project only, to a
// whole session, or to a specific transcript message (sessionId + entryIndex). No
// UNIQUE anchor — several tasks may point at the same place. projectPath is
// denormalized on insert so project-filtering stays reliable if the cache changes.
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectPath TEXT,
    sessionId TEXT,
    entryIndex INTEGER,
    scope TEXT NOT NULL,
    title TEXT NOT NULL,
    note TEXT,
    quote TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(projectPath)');
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(sessionId)');

// Session tags — colored labels, many per session, shown as sidebar chips.
db.exec(`
  CREATE TABLE IF NOT EXISTS session_tags (
    sessionId TEXT NOT NULL,
    tag TEXT NOT NULL,
    color TEXT,
    PRIMARY KEY (sessionId, tag)
  )
`);

// Project tags — colored labels, many per project, shown as sidebar filter chips.
// Mirrors session_tags (same shape) but keyed by projectPath (#98).
db.exec(`
  CREATE TABLE IF NOT EXISTS project_tags (
    projectPath TEXT NOT NULL,
    tag TEXT NOT NULL,
    color TEXT,
    PRIMARY KEY (projectPath, tag)
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
    insertTemplate TEXT DEFAULT '',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    lastUsedAt TEXT
  )
`);
// Idempotently add insertTemplate to DBs created before the insert-template
// feature (the CREATE TABLE above already has it for fresh installs).
try { db.exec("ALTER TABLE saved_variables ADD COLUMN insertTemplate TEXT DEFAULT ''"); } catch {}
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
  // #138: tags become entities. Until now a tag was only a by-product of an
  // assignment — its name and colour lived on the project_tags / session_tags row,
  // so it could not exist unassigned, could not be renamed, and its colour had to
  // be written across every row that happened to use it.
  //
  // `kind` is part of the key: project tags and session tags are separate
  // vocabularies, so the same name may exist in both with different colours.
  //
  // Seeded from whatever is already assigned; the first colour seen for a name
  // wins, which is exactly the rule the sidebar chips used to apply at read time.
  // The assignment tables keep their `color` column for now — stage 2 stops reading
  // it, and dropping it is left to a later migration so a rollback stays possible.
  (db) => {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS tag_defs (
        kind     TEXT NOT NULL,
        name     TEXT NOT NULL,
        color    TEXT,
        hidden   INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (kind, name)
      )`);
      db.exec(`
        INSERT OR IGNORE INTO tag_defs (kind, name, color)
        SELECT 'project', tag, MIN(color) FROM project_tags WHERE tag IS NOT NULL GROUP BY tag
      `);
      db.exec(`
        INSERT OR IGNORE INTO tag_defs (kind, name, color)
        SELECT 'session', tag, MIN(color) FROM session_tags WHERE tag IS NOT NULL GROUP BY tag
      `);
    } catch {}
  },
  // #138 follow-up: colour and state now live on tag_defs, so the per-assignment
  // `color` column on project_tags / session_tags is dead weight. Drop it. Runs
  // after the seed migration above, which is the last thing that reads it.
  (db) => {
    try { db.exec('ALTER TABLE project_tags DROP COLUMN color'); } catch {}
    try { db.exec('ALTER TABLE session_tags DROP COLUMN color'); } catch {}
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
  // Project path lifecycle (#55): remap moves these rows, hard delete removes them.
  projectMetaDelete: db.prepare('DELETE FROM project_meta WHERE projectPath = ?'),
  projectMetaRename: db.prepare('UPDATE project_meta SET projectPath = ? WHERE projectPath = ?'),
  // Auto-hide (#57): mark/clear the automatic-hide flag and (re)start the grace timer.
  projectMetaSetAutoHidden: db.prepare(`
    INSERT INTO project_meta (projectPath, autoHidden) VALUES (?, ?)
    ON CONFLICT(projectPath) DO UPDATE SET autoHidden = excluded.autoHidden
  `),
  projectMetaResetAutoHide: db.prepare(`
    INSERT INTO project_meta (projectPath, autoHidden, autoHideResetAt) VALUES (?, 0, ?)
    ON CONFLICT(projectPath) DO UPDATE SET autoHidden = 0, autoHideResetAt = excluded.autoHideResetAt
  `),
  projectMetaAutoHidden: db.prepare('SELECT projectPath FROM project_meta WHERE autoHidden = 1'),
  settingsByPrefix: db.prepare('SELECT key, value FROM settings WHERE key LIKE ?'),
  // Bookmarks (toggle by {sessionId, entryIndex} anchor)
  bookmarkGet: db.prepare('SELECT id FROM bookmarks WHERE sessionId = ? AND entryIndex = ?'),
  bookmarkInsert: db.prepare('INSERT INTO bookmarks (sessionId, entryIndex, timestamp, label, createdAt) VALUES (?, ?, ?, ?, ?)'),
  bookmarkDeleteByAnchor: db.prepare('DELETE FROM bookmarks WHERE sessionId = ? AND entryIndex = ?'),
  bookmarkDeleteById: db.prepare('DELETE FROM bookmarks WHERE id = ?'),
  bookmarkListAll: db.prepare('SELECT * FROM bookmarks ORDER BY createdAt DESC'),
  bookmarkListBySession: db.prepare('SELECT * FROM bookmarks WHERE sessionId = ? ORDER BY entryIndex ASC'),
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
  handoffInsert: db.prepare('INSERT INTO project_handoffs (projectPath, label, content, createdAt) VALUES (?, ?, ?, ?)'),
  handoffListByProject: db.prepare('SELECT id, label, content, createdAt FROM project_handoffs WHERE projectPath = ? ORDER BY createdAt DESC'),
  handoffDeleteById: db.prepare('DELETE FROM project_handoffs WHERE id = ?'),
  // Project path lifecycle (#55). Handoffs are a list, so a remap lets them accrue
  // to the destination rather than conflicting.
  projectHandoffsRename: db.prepare('UPDATE project_handoffs SET projectPath = ? WHERE projectPath = ?'),
  projectHandoffsDeleteAll: db.prepare('DELETE FROM project_handoffs WHERE projectPath = ?'),
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
  settingsGet: db.prepare('SELECT value FROM settings WHERE key = ?'),
  settingsUpsert: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
  settingsDelete: db.prepare('DELETE FROM settings WHERE key = ?'),
  // Remap moves the `project:<path>` blob to the new key (#55).
  settingsRename: db.prepare('UPDATE settings SET key = ? WHERE key = ?'),
  // Saved variables (Saved Variables panel)
  // insertTemplate is NOT a secret (it only describes how to insert, not the
  // value) so it is safe to carry in the list statements; `value` stays excluded.
  savedVariablesList: db.prepare(`
    SELECT id, name, secret, scope, projectPath, tags, insertTemplate, createdAt, updatedAt, lastUsedAt
    FROM saved_variables
    WHERE scope = 'global' OR (scope = 'project' AND projectPath = ?)
    ORDER BY LOWER(name), updatedAt DESC
  `),
  // Every variable regardless of scope/project — used by the Variables admin tab
  // which needs the full CRUD list (not just the ones applicable to one project).
  savedVariablesListAll: db.prepare(`
    SELECT id, name, secret, scope, projectPath, tags, insertTemplate, createdAt, updatedAt, lastUsedAt
    FROM saved_variables
    ORDER BY LOWER(name), updatedAt DESC
  `),
  savedVariableGet: db.prepare('SELECT * FROM saved_variables WHERE id = ?'),
  savedVariableUpsert: db.prepare(`
    INSERT INTO saved_variables
      (id, name, value, valueEncoding, secret, scope, projectPath, tags, insertTemplate, createdAt, updatedAt, lastUsedAt)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      value = excluded.value,
      valueEncoding = excluded.valueEncoding,
      secret = excluded.secret,
      scope = excluded.scope,
      projectPath = excluded.projectPath,
      tags = excluded.tags,
      insertTemplate = excluded.insertTemplate,
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

// --- Auto-hide meta (#57) ---
// Raw project_meta row (or null) — used by applyAutoHide to read autoHideResetAt.
function getProjectMeta(projectPath) {
  return stmts.projectMetaGet.get(projectPath) || null;
}

// Mark/clear the automatic-hide flag for a project (distinguishes auto from manual hide).
function setProjectAutoHidden(projectPath, autoHidden) {
  runWithBusyRetry(() => stmts.projectMetaSetAutoHidden.run(projectPath, autoHidden ? 1 : 0));
}

// Reset the auto-hide grace timer to now and clear the auto-hidden flag. Called on
// unhide and on add/re-add so a just-restored stale project isn't re-hidden immediately.
function resetProjectAutoHide(projectPath) {
  runWithBusyRetry(() => stmts.projectMetaResetAutoHide.run(projectPath, new Date().toISOString()));
}

// Set of projectPaths whose current hide was set automatically — consumed by the
// hidden-projects UI to show an "auto" badge.
function getAutoHiddenProjects() {
  const set = new Set();
  for (const row of stmts.projectMetaAutoHidden.all()) set.add(row.projectPath);
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

// --- Tasks (scoped task/note system) ---

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

// --- Project path lifecycle (#55) ---
// Everything Switchboard keys by projectPath: project_meta (favorite, auto-hide),
// project_tags, project_handoffs, and the `project:<path>` settings blob (display
// name, permission mode, worktree prefs, AFK timeout).
//
// A remap moves the project to a new path; a hard delete removes it for good.
// Neither used to touch any of this, so a remap silently dropped the project's
// favorite/tags/settings and left the old path behind as a phantom.

// Move every reference from oldPath to newPath. Where the destination already
// carries data of its own, the destination wins and the source row is dropped —
// remapping onto a folder that is already a known project must never clobber it.
const renameProjectRefsTx = db.transaction((oldPath, newPath) => {
  const destMeta = stmts.projectMetaGet.get(newPath);
  if (destMeta) stmts.projectMetaDelete.run(oldPath);
  else stmts.projectMetaRename.run(newPath, oldPath);

  // Tags merge: a tag the destination already has keeps its own colour.
  stmts.projectTagsMerge.run(newPath, oldPath);
  stmts.projectTagDeleteAll.run(oldPath);

  // Handoffs are a list, so they simply accrue to the destination.
  stmts.projectHandoffsRename.run(newPath, oldPath);

  const destSettings = stmts.settingsGet.get('project:' + newPath);
  if (destSettings) stmts.settingsDelete.run('project:' + oldPath);
  else stmts.settingsRename.run('project:' + newPath, 'project:' + oldPath);
});

function renameProjectRefs(oldPath, newPath) {
  if (!oldPath || !newPath || oldPath === newPath) return;
  runWithBusyRetry(() => renameProjectRefsTx(oldPath, newPath));
}

// Drop every trace of a project. Only for a hard delete — a plain "hide" must
// keep this data so unhiding restores the project intact.
const deleteProjectRefsTx = db.transaction((projectPath) => {
  stmts.projectMetaDelete.run(projectPath);
  stmts.projectTagDeleteAll.run(projectPath);
  stmts.projectHandoffsDeleteAll.run(projectPath);
  stmts.settingsDelete.run('project:' + projectPath);
});

function deleteProjectRefs(projectPath) {
  if (!projectPath) return;
  runWithBusyRetry(() => deleteProjectRefsTx(projectPath));
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
  // A late cache refresh can fire during shutdown after the DB is closed —
  // return null instead of throwing "connection is not open" (#90).
  if (!db.open) return null;
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
    insertTemplate: row.insertTemplate || '',
  };
}

function listSavedVariables(projectPath = null) {
  return stmts.savedVariablesList.all(projectPath || '').map(normalizeSavedVariableRow);
}

function listAllSavedVariables() {
  return stmts.savedVariablesListAll.all().map(normalizeSavedVariableRow);
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
    insertTemplate: typeof variable.insertTemplate === 'string' ? variable.insertTemplate : '',
    createdAt,
    updatedAt: now,
    lastUsedAt: existing?.lastUsedAt || null,
  };
  runWithBusyRetry(() => stmts.savedVariableUpsert.run(
    row.id, row.name, row.value, row.valueEncoding, row.secret, row.scope,
    row.projectPath, row.tags, row.insertTemplate, row.createdAt, row.updatedAt, row.lastUsedAt
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
  getProjectMeta, setProjectAutoHidden, resetProjectAutoHide, getAutoHiddenProjects,
  renameProjectRefs, deleteProjectRefs,
  toggleBookmark, removeBookmark, listBookmarks,
  createTask, listTasks, getTask, updateTask, removeTask, openTaskCountsBySession, openTaskCountsByProject,
  saveProjectHandoff, listProjectHandoffs, deleteProjectHandoff,
  getSessionTags, setSessionTags, listAllTags, getAllSessionTags,
  getProjectTags, setProjectTags, listAllProjectTags, getAllProjectTags,
  listTagDefs, createTagDef, renameTagDef, setTagDefColor, setTagDefFlags, deleteTagDef,
  isCachePopulated, getAllCached, getCachedByFolder, getCachedByParent, getCachedFolder, getCachedSession, upsertCachedSessions,
  deleteCachedSession, deleteCachedFolder,
  replaceSessionMetrics,
  getFolderMeta, getAllFolderMeta, setFolderMeta,
  upsertSearchEntries, updateSearchTitle, deleteSearchSession, deleteSearchFolder, deleteSearchType,
  searchByType, isSearchIndexPopulated, searchFtsRecreated,
  getSetting, setSetting, deleteSetting,
  listSavedVariables, listAllSavedVariables, getSavedVariable, saveSavedVariable, deleteSavedVariable, touchSavedVariable,
  getDailyActivity,
  getDailyMetrics, getDailyModelTokens, getModelUsage, getTotalCounts,
  closeDb,
  // Exported so main.js can pass the resolved path to the search-query worker
  // without re-deriving the SWITCHBOARD_DATA_DIR logic in a second place.
  DB_PATH,
};
