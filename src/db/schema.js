// The schema as it is created FRESH — every CREATE TABLE / CREATE INDEX, and nothing else (#217 step 2).
//
// This is the shape a brand-new database is born with. It is NOT the history of how an existing one got
// here — that is `migrations.js`, and the two are deliberately separate files that must stay in step:
// a column added by a migration belongs in the CREATE TABLE here too, or a fresh install and an upgraded
// one end up with different tables. Every statement is IF NOT EXISTS / try-wrapped, so this runs on every
// start against any database and changes nothing when the shape is already right.
//
// It runs BEFORE the migrations, exactly as it did when it was the top of db.js: the migrations assume
// the tables exist.
'use strict';

/**
 * Create every table and index this app needs, if they are not there already.
 * @param {import('better-sqlite3').Database} db
 */
function applySchema(db) {
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
      autoHideResetAt TEXT,
      registered INTEGER DEFAULT 0,
      registeredAt TEXT,
      hidden INTEGER DEFAULT 0,
      removedAt TEXT
    )
  `);
  // Idempotently add the auto-hide columns to project_meta tables created before
  // the #57 auto-hide feature (the CREATE TABLE above already has them for fresh
  // installs). autoHidden marks a hide that was set automatically (vs. manual);
  // autoHideResetAt restarts the inactivity timer (grace after unhide / re-add).
  try { db.exec('ALTER TABLE project_meta ADD COLUMN autoHidden INTEGER DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE project_meta ADD COLUMN autoHideResetAt TEXT'); } catch {}
  // The project REGISTER (#167). The sidebar's project list used to be derived from the transcripts on
  // disk, so a project without one could not exist — and "remove" had to be faked as a permanent hide,
  // because the very next scan would have derived the project straight back. These four make the list a
  // list: `registered` says it is on it, `hidden` is the user's manual hide OF a listed project, and
  // `removedAt` is the tombstone that stops the sessions still on disk from re-registering it.
  try { db.exec('ALTER TABLE project_meta ADD COLUMN registered INTEGER DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE project_meta ADD COLUMN registeredAt TEXT'); } catch {}
  try { db.exec('ALTER TABLE project_meta ADD COLUMN hidden INTEGER DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE project_meta ADD COLUMN removedAt TEXT'); } catch {}

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
}

module.exports = { applySchema };
