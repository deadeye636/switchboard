// The BASELINE schema — every CREATE TABLE / CREATE INDEX, and nothing else (#217 step 2).
//
// This is NOT the final shape of the database, and assuming it is will mislead you. It is the baseline
// the migrations then finish. `db.js` runs applySchema and THEN runMigrations, on every start and on
// EVERY database — including a brand-new one, whose db_version is 0, so all of them run. Both paths, fresh
// and upgraded, therefore converge on the same shape by the same route.
//
// That is why the two files disagree, on purpose and harmlessly. Measured, not assumed: session_cache is
// missing eight columns here that migrations add (backendId, filePath, parserVersion, the cost fields…);
// session_metrics and tag_defs are created ONLY by a migration and never appear below; and project_tags
// and session_tags are created here WITH a `color` column that a later migration removes again when
// colours moved to tag_defs. Every one of those ends correctly, because the migrations always run after
// this file.
//
// So: a column a new migration adds does NOT have to be repeated in the CREATE TABLE here. Adding it is
// optional tidiness, and the codebase does it both ways. What is NOT optional is that everything here
// stays IF NOT EXISTS / try-wrapped, so it can run against a database that already has the final shape
// and change nothing.
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
  // getCachedByProjectPath ran as a full SCAN until #224 — and projects.js calls it ONCE PER PROJECT
  // (registry build, auto-hide, rename, delete), so the cost is projects x sessions. Measured on a real
  // store (34 projects / 735 sessions): 2.70 ms -> 1.02 ms per full pass, and on the same store blown up
  // 10x: 25.7 ms -> 9.9 ms. The write side is what an index has to pay for, and it is nearly free here:
  // the hot path is a single-row upsert per JSONL append (+12 us at 10x, noise below that), a full folder
  // re-upsert costs +6..12%, and a full reindex is unchanged. +28 KB on disk today.
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_cache_projectPath ON session_cache(projectPath)');
}

module.exports = { applySchema };
