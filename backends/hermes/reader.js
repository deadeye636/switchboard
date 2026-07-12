// backends/hermes/reader.js — the DB-MODE adapter (the first non-file backend).
//
// Hermes keeps its history in SQLite (%LOCALAPPDATA%\hermes\state.db), not in files. This is the whole
// reason the discovery seam is dual-mode: `discoverSessions()` yields {kind:'db'} handles instead of
// {kind:'file'} ones, and `parseSession(handle)` reads a row instead of a JSONL.
//
// Hard rules (upstream issue #2914 — a reader must never block Hermes writing):
//   - open READ-ONLY, with `PRAGMA query_only` on top,
//   - short-lived connections (open, read, close) — never hold one across a scan,
//   - WAL-aware: the DB runs in `journal_mode=wal`, so a commit can sit in `state.db-wal` without
//     touching the main file's mtime. Never gate a re-read on state.db's mtime alone.
//
// Live schema (docs/plans/research/hermes-format.md, dumped from a real install): `sessions` has 33
// columns incl. a real `cwd`, a full token breakdown, `parent_session_id` lineage, and USD cost
// (`estimated_cost_usd` / `actual_cost_usd` / `cost_status` / `cost_source` / `pricing_version`).
// There is NO `updated_at` column, so the change marker is built from `ended_at` / message activity.
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

// Bump on ANY behavioural change here — persisted parse-state keyed on it is then dropped (§5.10).
const PARSER_SCHEMA_VERSION = 1;

let _home = null;

// The store root. Windows-native is %LOCALAPPDATA%\hermes (CONFIRMED on a real install — `~/.hermes`
// does NOT exist there); Linux/WSL uses ~/.hermes. HERMES_HOME overrides both. Never hardcode ~/.hermes.
function hermesHome() {
  if (_home) return _home;
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'hermes');
  }
  return path.join(os.homedir(), '.hermes');
}

function setHome(dir) { _home = dir || null; }

function dbPath() { return path.join(hermesHome(), 'state.db'); }

function dbExists() {
  try { return fs.statSync(dbPath()).isFile(); } catch { return false; }
}

// --- SQLite driver ---
//
// Two drivers, one tiny interface. `better-sqlite3` is what the app already ships (and is what runs in
// production), but it is compiled against Electron's ABI and cannot be loaded by a plain `node --test`
// process. Node 22 ships `node:sqlite`, which can — so the reader falls back to it. That keeps this
// backend testable in the normal suite instead of untested, and makes the reader work even where the
// native module is unavailable.
//
// The wrapper normalises the two APIs down to what we actually use: prepare().all/get, a pragma read,
// and close.
function loadDriver() {
  try {
    const Database = require('better-sqlite3');
    // require() alone proves nothing: better-sqlite3 loads its native binding LAZILY, on first open.
    // Under a plain `node` process that binding is the wrong ABI (it is built for Electron) and only
    // blows up here. Probe it for real, so we can fall through to node:sqlite instead of silently
    // returning "no sessions".
    new Database(':memory:').close();
    return {
      open(file) {
        const db = new Database(file, { readonly: true, fileMustExist: true });
        db.pragma('query_only = 1');   // belt and braces: we can never write, even by mistake
        return {
          all: (sql, ...p) => db.prepare(sql).all(...p),
          get: (sql, ...p) => db.prepare(sql).get(...p),
          pragma: (name) => db.pragma(name, { simple: true }),
          close: () => db.close(),
        };
      },
    };
  } catch { /* fall through */ }

  try {
    const { DatabaseSync } = require('node:sqlite');
    return {
      open(file) {
        const db = new DatabaseSync(file, { readOnly: true });
        return {
          all: (sql, ...p) => db.prepare(sql).all(...p),
          get: (sql, ...p) => db.prepare(sql).get(...p),
          pragma: (name) => {
            const row = db.prepare(`PRAGMA ${name}`).get();
            return row ? Object.values(row)[0] : null;
          },
          close: () => db.close(),
        };
      },
    };
  } catch { /* no driver at all */ }

  return null;
}

let _driver;
function driver() {
  if (_driver === undefined) _driver = loadDriver();
  return _driver;
}

// Open a short-lived READ-ONLY connection. Returns null when the DB isn't there (Hermes installed but
// never run, or a degraded-mode install writing JSON instead — a known gap, not a crash), or when it is
// momentarily unreadable. NEVER throws: a reader must not take Hermes down with it.
function openDb() {
  if (!dbExists()) return null;
  const d = driver();
  if (!d) return null;
  try {
    return d.open(dbPath());
  } catch {
    return null;                   // locked/corrupt -> degrade quietly, never block Hermes (#2914)
  }
}

// Per-session change marker. Hermes has no `updated_at`, so we synthesise one from what does change:
// the session's end time and its latest message. A running session's `ended_at` is null, so the
// message timestamp is what moves.
const MARKER_SQL = `
  COALESCE(s.ended_at, 0) || ':' ||
  COALESCE((SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id), 0) || ':' ||
  COALESCE(s.message_count, 0)
`;

// Default ingest: only sessions the user actually drove from the CLI. The `source` column is
// cli | gateway | … — Telegram/cron/gateway chats are not coding sessions and would be noise.
function sourceFilter(includeAll) {
  return includeAll ? '' : " WHERE s.source = 'cli'";
}

/**
 * DB-mode discovery: one {kind:'db'} handle per session row. The handle carries the id and the change
 * marker, so the scanner can skip unchanged sessions without re-reading the row.
 */
function discoverSessions({ includeAll = false } = {}) {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db.all(
      `SELECT s.id AS id, ${MARKER_SQL} AS marker FROM sessions s${sourceFilter(includeAll)}`
    );
    const ref = dbPath();
    return rows.map(r => ({
      kind: 'db',
      ref,                 // which store this came from
      sessionId: String(r.id),
      marker: String(r.marker),   // the scanner's change gate (stands in for a file mtime)
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

// Hermes stores times as REAL unix epoch seconds, not ISO strings.
function toIso(epochSeconds) {
  if (epochSeconds == null) return null;
  const ms = Number(epochSeconds) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  try { return new Date(ms).toISOString(); } catch { return null; }
}

/**
 * Read one session row -> our normalised shape. The id is taken from the `id` column verbatim and
 * NEVER parsed (its format is inconsistent across Hermes' own docs).
 */
function parseSession(handle) {
  if (!handle || handle.kind !== 'db' || !handle.sessionId) return null;
  const db = openDb();
  if (!db) return null;
  try {
    const s = db.get('SELECT * FROM sessions WHERE id = ?', handle.sessionId);
    if (!s) return null;

    // Body for our FTS index: Hermes has its own FTS tables, but we feed OUR search, so pull the
    // message text. Bounded — a long session's transcript can be large and this runs per scan.
    let title = s.title || '';
    let textContent = '';
    let firstPrompt = '';
    let lastMessageMs = 0;
    try {
      const msgs = db.all(
        "SELECT role, content, timestamp FROM messages WHERE session_id = ? AND content IS NOT NULL AND content <> '' ORDER BY id LIMIT 500",
        handle.sessionId
      );
      const parts = [];
      for (const m of msgs) {
        const text = typeof m.content === 'string' ? m.content : '';
        if (!text) continue;
        if (!firstPrompt && m.role === 'user') firstPrompt = text.slice(0, 500);
        parts.push(text);
      }
      textContent = parts.join('\n').slice(0, 200000);
    } catch { /* messages unreadable -> still index the session row itself */ }

    // Last activity is asked SEPARATELY, over all messages. Deriving it from the capped read above
    // would freeze it at message #500 — and busy/idle rides on it (state.js), so a long agent session
    // (tool-call rows add up fast) would be declared idle while it is still working.
    try {
      const last = db.get('SELECT MAX(timestamp) AS t FROM messages WHERE session_id = ?', handle.sessionId);
      if (last && last.t) lastMessageMs = Number(last.t) * 1000;
    } catch { /* leave it at 0 -> deriveState falls back to the session row's own timestamps */ }

    // Per-(date, model) metrics for the Stats charts (#154).
    //
    // Hermes is the one backend that cannot do this exactly: its `messages` rows carry timestamps but
    // NO per-message tokens — the token counts exist only on the session row. So the message counts are
    // per day (asked over ALL messages, not the capped read), while the token totals are booked on the
    // day of the session's last activity. For a session that spans midnight, the tokens land on the day
    // it finished rather than being split. That is an approximation, and it is the honest one available:
    // the alternative would be to invent a distribution.
    const dailyMetrics = [];
    try {
      const perDay = db.all(
        "SELECT strftime('%Y-%m-%d', timestamp, 'unixepoch', 'localtime') AS date, COUNT(*) AS n" +
        ' FROM messages WHERE session_id = ? AND timestamp IS NOT NULL GROUP BY date',
        handle.sessionId
      );
      const model = s.model || '';
      const bookTokensOn = lastMessageMs
        ? new Date(lastMessageMs).toISOString().slice(0, 10)
        : (toIso(s.started_at) || '').slice(0, 10);

      for (const row of perDay) {
        if (!row.date) continue;
        dailyMetrics.push({
          date: row.date,
          model,
          messageCount: Number(row.n || 0),
          toolCallCount: Number(s.tool_call_count || 0) && row.date === bookTokensOn ? Number(s.tool_call_count) : 0,
          inputTokens: row.date === bookTokensOn ? Number(s.input_tokens || 0) : 0,
          outputTokens: row.date === bookTokensOn ? Number(s.output_tokens || 0) : 0,
          cacheReadTokens: row.date === bookTokensOn ? Number(s.cache_read_tokens || 0) : 0,
          cacheCreationTokens: row.date === bookTokensOn ? Number(s.cache_write_tokens || 0) : 0,
        });
      }
    } catch { /* metrics are a nice-to-have: never fail the session read over them */ }

    const summary = title || firstPrompt || '';
    const startedAt = toIso(s.started_at);
    // A RUNNING session has no `ended_at`. Falling back to `started_at` would freeze its `modified`
    // stamp at launch time, so a busy session would sort and display as untouched while it works —
    // every file backend's mtime moves here. Its last message is the equivalent signal.
    const lastEntryAt = toIso(s.ended_at)
      || (lastMessageMs ? new Date(lastMessageMs).toISOString() : null)
      || startedAt;
    const activeMinutes = (s.started_at && s.ended_at)
      ? Math.max(0, Math.round((Number(s.ended_at) - Number(s.started_at)) / 60))
      : 0;

    return {
      sessionId: String(s.id),
      backendId: 'hermes',
      // A real cwd column EXISTS (contrary to the original plan). Gateway/cron sessions may still have
      // none — those fall into the backend bucket, they are not forced under a project (§5.9).
      cwd: s.cwd || null,
      summary,
      firstPrompt: firstPrompt || summary,
      textContent,
      created: startedAt,
      modified: lastEntryAt,
      startedAt,
      lastEntryAt,
      activeMinutes,
      messageCount: Number(s.message_count || 0),
      userMessageCount: 0,      // not tracked separately by Hermes
      largestUserPromptWords: 0,
      slug: null, customTitle: null, aiTitle: null,
      model: s.model || null,
      // Token breakdown (richer than Claude's).
      inputTokens: Number(s.input_tokens || 0),
      outputTokens: Number(s.output_tokens || 0),
      cacheReadTokens: Number(s.cache_read_tokens || 0),
      cacheCreationTokens: Number(s.cache_write_tokens || 0),
      reasoningTokens: Number(s.reasoning_tokens || 0),
      // Cost — Hermes is the only backend that reports USD. `estimated_cost_usd` is the PRIMARY field;
      // `actual_cost_usd` is often null and `cost_status` may be 'n/a', so the UI must label an
      // estimate AS an estimate and never present it as billing truth (T-5.5).
      estimatedCostUsd: s.estimated_cost_usd == null ? null : Number(s.estimated_cost_usd),
      actualCostUsd: s.actual_cost_usd == null ? null : Number(s.actual_cost_usd),
      costStatus: s.cost_status || null,
      // Lineage.
      parentSessionId: s.parent_session_id || null,
      toolCallCount: Number(s.tool_call_count || 0),
      // Busy/idle inputs (state.js): Hermes has no OSC title and no shipped status file, so the DB row
      // IS the signal — a running turn has no `ended_at`, and its last message keeps moving.
      isEnded: s.ended_at != null,
      lastActivityMs: lastMessageMs || (s.started_at ? Number(s.started_at) * 1000 : 0),
      // Feeds session_metrics -> the Stats charts (#154). See the note above: message counts are exact
      // per day, token totals are booked on the session's last active day.
      dailyMetrics,
      _marker: handle.marker || null,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * STORE-level watch target: the DB file. A `kind:'db'` target means "poll this file AND its `-wal`" —
 * the watcher appends the `-wal` itself (main.js), because a WAL commit can leave state.db's mtime
 * untouched. Do NOT also return the `-wal` here or it gets watched twice.
 */
function watchTargets() {
  const p = dbPath();
  return [{ kind: 'db', path: p }];
}

/**
 * The session's messages, in the shape the transcript viewer and the handoff extractor speak.
 *
 * Hermes has no transcript FILE, which used to mean two things silently did not work for it: "View
 * messages" showed "there is nothing to show here", and a handoff could not pre-fill the packet the
 * agent had just written (#148) — the user had to retype it. Its messages are right there in the DB.
 *
 * Bounded: this is a viewer, not a scan.
 */
function readMessages(sessionId, { limit = 2000 } = {}) {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db.all(
      "SELECT role, content, timestamp FROM messages WHERE session_id = ? AND content IS NOT NULL AND content <> ''"
      + ' ORDER BY id LIMIT ?',
      sessionId, limit
    );
    return rows.map(r => ({
      type: 'message',
      timestamp: r.timestamp ? new Date(Number(r.timestamp) * 1000).toISOString() : null,
      message: { role: r.role || null, content: typeof r.content === 'string' ? r.content : '' },
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

module.exports = {
  PARSER_SCHEMA_VERSION,
  hermesHome, setHome, dbPath, dbExists,
  discoverSessions, parseSession, watchTargets, readMessages,
  openDb,
};
