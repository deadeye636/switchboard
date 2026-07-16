// The migrations — ONE ordered array, in ONE file, append-only (#217 step 3).
//
// READ THIS BEFORE TOUCHING THE ARRAY.
//
// `migrations.length` IS the schema version. It is read from the user's database, the entries from that
// index onward are run, and the new length is written back. So the array's LENGTH and the ORDER of its
// entries are data, not code layout:
//
//   - Append to the END. Never insert, never reorder, never delete an entry -- each would silently
//     re-number every migration after it, and an existing database would then skip or re-run steps
//     according to a version that no longer means what it meant when it was written.
//   - Never split this array across files, and never build it from pieces. One array, one place. A
//     concatenation is a re-numbering waiting for someone to change an import order.
//   - A retired migration becomes a no-op `() => {}` in place (see v1). It does not get removed.
//
// Getting this wrong is not a failing test: it is a corrupted database on someone's machine, discovered
// the next time the installed app starts.
//
// Migrations run AFTER schema.js has created the tables, and they must tolerate running against a
// database that already has the change -- hence the try/catch around each ALTER. They also run on a FRESH
// database, where schema.js has just created the final shape: a migration that assumes an old shape must
// still not throw.
'use strict';

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
  // VACUUM cannot run inside a SQLite transaction. The migrations loop (in
  // runMigrations, below) is NOT wrapped in a transaction, so calling db.exec('VACUUM') here
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
  // v10 (multi-LLM): which backend produced this session. This column is the AUTHORITATIVE
  // backend provenance (00-architecture §5.7) — the scanner sets it by merging the launch-time
  // overlay (session-backends.json) into the row, because an Axis-A profile shares Claude's store
  // and cannot be told apart from a plain Claude session by its files alone. Existing rows are
  // Claude by definition, hence the DEFAULT; no cache clear is needed (the backfill is exact).
  (db) => {
    try { db.exec("ALTER TABLE session_cache ADD COLUMN backendId TEXT DEFAULT 'claude'"); } catch {}
    try { db.exec("UPDATE session_cache SET backendId = 'claude' WHERE backendId IS NULL"); } catch {}
  },
  // v11 (multi-LLM T-4.2): the absolute session file behind a row. Claude rows can RECONSTRUCT their
  // path from folder + sessionId (read-session-file.js resolveJsonlPath), because the folder name IS
  // the encoded project path and the file name IS the session id. A Codex rollout lives in a
  // date-bucketed tree under its own root (sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl) — there is
  // nothing to reconstruct it from. So the scanner stores the path for every non-Claude row and readers
  // prefer it whenever present. Stays NULL for Claude rows (reconstruction keeps working unchanged).
  (db) => {
    try { db.exec('ALTER TABLE session_cache ADD COLUMN filePath TEXT'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_session_cache_backend ON session_cache(backendId)'); } catch {}
  },
  // v12 (multi-LLM Phase 5 — Hermes, the first NON-FILE backend):
  //
  //  - changeMarker: a file-store row is re-read when its mtime changes. A DB-store session has no
  //    file, and Hermes' schema has no `updated_at`, so its backend synthesises a marker (ended_at +
  //    last message + message count). It cannot ride in `modified`, which is the timestamp the UI
  //    actually shows. Stays NULL for file-backed rows.
  //
  //  - cost: Hermes is the only backend that reports USD. `estimatedCostUsd` is its PRIMARY figure;
  //    `actualCostUsd` is often null and `costStatus` may say 'n/a' — so the two are stored separately
  //    and the UI must label an estimate AS an estimate, never as billing truth.
  //
  //  - lineageParentId: Hermes sessions have a parent (`parent_session_id`). This deliberately does NOT
  //    reuse `parentSessionId`, which this app already uses for Claude SUBAGENT transcripts — putting a
  //    Hermes parent there would make its child sessions render as subagents of it.
  (db) => {
    try { db.exec('ALTER TABLE session_cache ADD COLUMN changeMarker TEXT'); } catch {}
    try { db.exec('ALTER TABLE session_cache ADD COLUMN estimatedCostUsd REAL'); } catch {}
    try { db.exec('ALTER TABLE session_cache ADD COLUMN actualCostUsd REAL'); } catch {}
    try { db.exec('ALTER TABLE session_cache ADD COLUMN costStatus TEXT'); } catch {}
    try { db.exec('ALTER TABLE session_cache ADD COLUMN lineageParentId TEXT'); } catch {}
  },

  // v13 (#148): a handoff records the backend it came from.
  //
  // A handoff is a packet of context, not a Claude artifact — it can be produced by any backend and
  // resumed into any backend. Resuming one starts a NEW session (it is not a continuation), so unlike
  // resuming an existing session it may legitimately change binary: the user picks. Remembering where
  // it came from is what lets that picker default to the obvious answer.
  // NULL = a handoff saved before this existed, i.e. Claude's.
  (db) => {
    try { db.exec('ALTER TABLE project_handoffs ADD COLUMN backendId TEXT'); } catch {}
  },

  // v14 (#159 + #152) — the Stats rework. Three changes that only work together:
  //
  //  - `hour` joins the metrics key, so the day is no longer the finest bucket we have (an activity
  //    grid needs the hour, and a session that spans midnight can finally be split at the right edge).
  //    It changes the PRIMARY KEY, which SQLite cannot ALTER — hence a fresh table.
  //
  //  - cost per bucket. Cost used to live only on the session row, so any cost-over-time chart had to
  //    book a whole session on a single day. Hermes is the only backend that reports USD, and even it
  //    cannot attribute cost per message (its message rows carry no tokens) — it books on the bucket of
  //    its last activity, and the UI says so. `estimated` and `actual` stay SEPARATE and NULLABLE:
  //    "reported nothing" is not "cost 0", and an estimate must never be presentable as a bill.
  //
  //  - `parserVersion` on the session row (#152). This is what makes the other two arrive at all. The
  //    scan skips a session whose change marker is unchanged — and a parser change does not move a file's
  //    mtime, so a schema like this one would land in an empty table and stay there. v8 assumed a
  //    cold-start rebuild would backfill it; there is no cold start once the cache is populated, which is
  //    why the charts have been Claude-only-and-stale for every existing user until they found the manual
  //    Rebuild button. Now: the row records the parser that wrote it, the gate compares it to the parser
  //    that would read it, and a bumped parser re-reads its sessions by itself.
  //
  // DROP rather than migrate the old rows: every parser is bumped in this same change, so every row is
  // about to be rewritten with an hour and a cost anyway. Keeping them would mean carrying rows with a
  // sentinel hour that no chart could honestly place.
  (db) => {
    try {
      db.exec('DROP TABLE IF EXISTS session_metrics');
      db.exec(`CREATE TABLE session_metrics (
        sessionId TEXT NOT NULL,
        date TEXT NOT NULL,
        hour INTEGER NOT NULL DEFAULT -1,
        model TEXT NOT NULL DEFAULT '',
        messageCount INTEGER DEFAULT 0,
        toolCallCount INTEGER DEFAULT 0,
        inputTokens INTEGER DEFAULT 0,
        outputTokens INTEGER DEFAULT 0,
        cacheReadTokens INTEGER DEFAULT 0,
        cacheCreationTokens INTEGER DEFAULT 0,
        estimatedCostUsd REAL,
        actualCostUsd REAL,
        PRIMARY KEY (sessionId, date, hour, model)
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_session_metrics_date ON session_metrics(date)');
      db.exec('ALTER TABLE session_cache ADD COLUMN parserVersion INTEGER');
    } catch {}
  },
  // Seed the project REGISTER from the list that was implicit until now (#167).
  //
  // ONE RULE: the sidebar must show exactly what it showed the day before. The old list was not one list
  // but two, and which one you got depended on the mode:
  //
  //   auto mode   -> everything derivable from the store, minus hiddenProjects
  //   manual mode -> `addedProjects`, and nothing else (it was a SUBTRACTIVE filter over the derivation)
  //
  // So the seed depends on the mode too. Seeding a manual-mode install from the derivation would flood
  // its sidebar with every project it had spent months not showing.
  //
  //   hidden = hiddenProjects, EXCEPT the ones that are only hidden because they went stale — those
  //            already carry autoHidden, and conflating the two is the bug this feature fixes.
  //
  // `registeredAt` is left NULL for a seeded project. It is the recency an EMPTY project sorts by, and
  // stamping it with the migration time would send every session-less project — every empty store folder,
  // every stale cache_meta mapping — to the top of the sidebar as if it were brand new. A project that is
  // put on the list from here on gets a real one; these were already there.
  //
  // No tombstones: nothing has been removed yet under the new meaning of the word.
  (db) => {
    try {
      const seed = db.prepare(
        'INSERT INTO project_meta (projectPath, registered) VALUES (?, 1)'
        + ' ON CONFLICT(projectPath) DO UPDATE SET registered = 1'
      );

      let global = {};
      try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'global'").get();
        if (row && row.value) global = JSON.parse(row.value) || {};
      } catch { global = {}; }

      const paths = new Set();
      if (global.projectAutoAdd === false && Array.isArray(global.addedProjects)) {
        // Manual mode: the allowlist WAS the list.
        for (const p of global.addedProjects) paths.add(p);
      } else {
        // Auto mode: everything the sidebar could derive — sessions in the cache, plus the store folders
        // that resolve to a path (cache_meta is exactly that mapping). A folder that has since been
        // deleted leaves its cache_meta row behind, and seeding it would resurrect the project as a
        // `missing` row that was not in yesterday's sidebar; so only folders that are still there.
        for (const r of db.prepare('SELECT DISTINCT projectPath FROM session_cache WHERE projectPath IS NOT NULL').all()) {
          paths.add(r.projectPath);
        }
        // Claude's store — the same path main.js derives, spelled out here because db.js is loaded before
        // it and must not depend on it.
        const store = path.join(os.homedir(), '.claude', 'projects');
        for (const r of db.prepare('SELECT folder, projectPath FROM cache_meta WHERE projectPath IS NOT NULL').all()) {
          try {
            if (fs.existsSync(path.join(store, r.folder))) paths.add(r.projectPath);
          } catch { /* unreadable store: leave it out rather than invent a project */ }
        }
        // ...and anything explicitly added by hand, whichever mode it was added in.
        for (const p of global.addedProjects || []) paths.add(p);
      }

      for (const p of paths) seed.run(p);

      // The manual hides. An auto-hidden project stays merely auto-hidden: it is on the list and comes
      // back by itself on activity, which a manual hide must never do.
      const autoHidden = new Set(
        db.prepare('SELECT projectPath FROM project_meta WHERE autoHidden = 1').all().map(r => r.projectPath)
      );
      const hide = db.prepare(
        'INSERT INTO project_meta (projectPath, hidden, registered) VALUES (?, 1, 1)'
        + ' ON CONFLICT(projectPath) DO UPDATE SET hidden = 1'
      );
      for (const p of global.hiddenProjects || []) {
        if (autoHidden.has(p)) continue;
        hide.run(p);
      }
    } catch {}
  },
];

/**
 * Bring `db` up to the current schema version, running only the migrations it has not seen.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ searchFtsRecreated: boolean, from: number, to: number }} `searchFtsRecreated` tells main.js
 *   a migration dropped search_fts, so the caller must trigger a full repopulate. It is a snapshot of what
 *   THIS run did -- db.js captures it at load and re-exports the value, which is what callers have always
 *   received.
 */
function runMigrations(db) {
  // Report what THIS call did, not what a previous one did. Production calls this exactly once, at db.js's
  // load, so the reset changes nothing observable there — but the moment the function became exported it
  // also became callable twice, and a second call on an up-to-date database would otherwise still report
  // the first run's `true` and send main.js off to repopulate the whole search index for nothing.
  searchFtsRecreated = false;

  const currentDbVersion = (() => {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'db_version'").get();
      return row ? JSON.parse(row.value) : 0;
    } catch { return 0; }
  })();

  for (let i = currentDbVersion; i < migrations.length; i++) {
    migrations[i](db);
  }
  // Only write when something ran: an unchanged version must not touch the row.
  if (migrations.length > currentDbVersion) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', ?)").run(JSON.stringify(migrations.length));
  }

  return { searchFtsRecreated, from: currentDbVersion, to: migrations.length };
}

module.exports = {
  migrations,
  runMigrations,
  // The schema version IS the array's length. Derived here, never written down as a literal -- a hardcoded
  // number is a second source of truth that can disagree with the array.
  SCHEMA_VERSION: migrations.length,
};
