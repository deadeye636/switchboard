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
const { bucketOf, bucketFromEpochSeconds, NO_HOUR } = require('../metrics-bucket');
const { dbSignature } = require('../livestate-cache');

// Bump on ANY behavioural change here — persisted parse-state keyed on it is then dropped (§5.10), and
// (since #152) every Hermes session already in the cache is re-read, so a change like v2 reaches the
// charts by itself instead of waiting for a manual Rebuild.
//   v2: per-(date, HOUR, model) metrics in LOCAL time, with cost per bucket (#159)
const PARSER_SCHEMA_VERSION = 2;

let _home = null;

// The store root. Windows-native is %LOCALAPPDATA%\hermes (CONFIRMED on a real install — `~/.hermes`
// does NOT exist there); Linux/WSL uses ~/.hermes. HERMES_HOME overrides both. Never hardcode ~/.hermes.
function hermesHome() {
  if (_home) return _home;
  // SWITCHBOARD_STORE_HERMES isolates our scan (demo/sandbox — scripts/demo-start.js); it names the
  // home dir holding state.db, ahead of the CLI's own HERMES_HOME.
  if (process.env.SWITCHBOARD_STORE_HERMES) return process.env.SWITCHBOARD_STORE_HERMES;
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
// better-sqlite3 in Electron, node:sqlite under `node --test`. The dual driver is shared with agy (the
// other SQLite-backed backend) so the fallback logic lives in exactly one place — backends/sqlite-driver.js.
const { driver } = require('../sqlite-driver');

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
//
// The last message arrives via a GROUPED JOIN, not a correlated subquery. discoverSessions() runs on
// every WAL commit of a live session — the correlated form asked SQLite for MAX(timestamp) once PER
// SESSION ROW, i.e. a scan of `messages` per session, several times a minute, for the whole history
// (#155). One grouped pass answers all of them.
const MARKER_SQL = `
  COALESCE(s.ended_at, 0) || ':' ||
  COALESCE(m.last_ts, 0) || ':' ||
  COALESCE(s.message_count, 0)
`;

const LAST_MESSAGE_JOIN = `
  LEFT JOIN (SELECT session_id, MAX(timestamp) AS last_ts FROM messages GROUP BY session_id) m
    ON m.session_id = s.id
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
      `SELECT s.id AS id, ${MARKER_SQL} AS marker FROM sessions s${LAST_MESSAGE_JOIN}${sourceFilter(includeAll)}`
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

    // Who spoke last, and did they finish — the busy/idle signal (#165).
    const lastRow = lastMessage(db, handle.sessionId);

    // Per-(date, hour, model) metrics for the Stats charts (#154, #159).
    //
    // Hermes is the one backend that cannot do this exactly: its `messages` rows carry timestamps but NO
    // per-message tokens and no per-message cost — both exist only on the SESSION row. So the message
    // counts are exact per bucket (asked over ALL messages, not the capped read), while the tokens, the
    // tool calls and the money are booked on the bucket of the session's last activity. A session that
    // spans midnight books its tokens where it finished rather than being split. That is an
    // approximation; the alternative would be to invent a distribution, which is worse than admitting to
    // one. The UI says so.
    //
    // Everything is bucketed in LOCAL time, like every other backend (metrics-bucket.js). This used to
    // ask SQLite for `localtime` days but compute the token-booking day with `toISOString()` — i.e. UTC.
    // Whenever those two disagreed (most evenings, east of Greenwich) the booking day matched no bucket
    // at all and the session's ENTIRE token count was silently dropped from the charts.
    const dailyMetrics = [];
    try {
      const perBucket = db.all(
        "SELECT strftime('%Y-%m-%d', timestamp, 'unixepoch', 'localtime') AS date," +
        " CAST(strftime('%H', timestamp, 'unixepoch', 'localtime') AS INTEGER) AS hour," +
        ' COUNT(*) AS n' +
        ' FROM messages WHERE session_id = ? AND timestamp IS NOT NULL GROUP BY date, hour',
        handle.sessionId
      );
      const model = s.model || '';
      const bookOn = lastMessageMs
        ? bucketOf(new Date(lastMessageMs))
        : bucketFromEpochSeconds(s.started_at);
      const isBookBucket = (row) => row.date === bookOn.date && Number(row.hour) === bookOn.hour;

      // A ZERO estimate on a session that did real work means Hermes had no pricing for that model —
      // not that the work was free. Reported as 0 it would draw a $0.00 bar in the cost chart, which is
      // a made-up fact; NULL keeps the day out of the chart entirely. This is the same rule the session
      // cards already apply (stats-view.js `sessionCost`), now applied where the fact is known. A
      // SETTLED zero is a real statement and is kept.
      const est = s.estimated_cost_usd == null ? null : Number(s.estimated_cost_usd);
      const actual = s.actual_cost_usd == null ? null : Number(s.actual_cost_usd);
      const totals = () => ({
        toolCallCount: Number(s.tool_call_count || 0),
        inputTokens: Number(s.input_tokens || 0),
        outputTokens: Number(s.output_tokens || 0),
        cacheReadTokens: Number(s.cache_read_tokens || 0),
        cacheCreationTokens: Number(s.cache_write_tokens || 0),
        // Hermes is the only backend that can report a SETTLED amount. Both stay null when it reported
        // nothing — a session nobody priced did not cost zero.
        estimatedCostUsd: (est === 0 && actual == null) ? null : est,
        actualCostUsd: actual,
      });
      const empty = {
        toolCallCount: 0, inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        estimatedCostUsd: null, actualCostUsd: null,
      };

      let booked = false;
      for (const row of perBucket) {
        if (!row.date) continue;
        const carries = isBookBucket(row);
        if (carries) booked = true;
        dailyMetrics.push({
          date: row.date,
          hour: Number.isInteger(row.hour) ? row.hour : NO_HOUR,
          model,
          messageCount: Number(row.n || 0),
          ...(carries ? totals() : empty),
        });
      }

      // A session with tokens but no message rows (or whose last-activity bucket somehow isn't among
      // them) would otherwise contribute NOTHING to the charts while its totals show up in the cards.
      if (!booked && bookOn.date) {
        dailyMetrics.push({ date: bookOn.date, hour: bookOn.hour, model, messageCount: 0, ...totals() });
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
      // Hermes has no user-message column, but the rows are right there. It used to be hardcoded to 0,
      // which meant the "handoff recommended" nudge (session-health.js needs > 1) could never fire for
      // the one backend whose handoff support this all exists for.
      userMessageCount: countUserMessages(db, handle.sessionId),
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
      // Lineage (#193): Hermes' own parent link. Kept in a Hermes-specific field, NOT `parentSessionId`
      // (which is Claude's SUBAGENT link — reusing it would render a Hermes child as a subagent). The
      // Hermes descriptor's resolveLineage turns this into lineageParentId at the neutral sink.
      lineageParentRef: s.parent_session_id || null,
      toolCallCount: Number(s.tool_call_count || 0),
      // Busy/idle inputs (state.js). `ended_at` sounded like the signal and is not — on a real store it is
      // null on every session, finished or not (#165). What says whose turn it is, is the LAST row: an
      // unanswered user prompt means a turn is running; an assistant row with a `finish_reason` means it
      // is answered. Same facts the live path reads, so a cached row and a live one cannot disagree.
      isEnded: s.ended_at != null,
      lastActivityMs: lastMessageMs || (s.started_at ? Number(s.started_at) * 1000 : 0),
      lastRole: lastRow ? lastRow.role : null,
      lastFinishReason: lastRow ? lastRow.finishReason : null,
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
 * The LAST row of a session's transcript — who spoke, and whether they finished.
 *
 * This is what busy/idle actually rides on (#165). `ended_at` sounded like the signal and is not: on a
 * real store it is null on EVERY session, including ones finished the day before, so the only branch that
 * could ever say "idle" never fired and the state fell through to "wrote something recently → busy". The
 * agent's own answer is something written recently — so a session sat at "working" for the whole activity
 * window after every reply, while plainly waiting at its prompt.
 *
 * `finish_reason` is the fact that was there all along: `stop` on every assistant row, null on every user
 * row. Ordered by `id`, i.e. by insertion, so this is the newest row and not the newest timestamp.
 */
function lastMessage(db, sessionId) {
  try {
    const m = db.get(
      'SELECT role, finish_reason AS finishReason, timestamp FROM messages'
      + ' WHERE session_id = ? ORDER BY id DESC LIMIT 1',
      sessionId
    );
    if (!m) return null;
    return {
      role: m.role || null,
      finishReason: m.finishReason || null,
      timestampMs: m.timestamp ? Number(m.timestamp) * 1000 : 0,
    };
  } catch {
    return null;
  }
}

/**
 * The few facts busy/idle is made of — and nothing else.
 *
 * `liveState` runs on every WAL commit of a live session, i.e. several times a minute while the agent
 * works. It used to go through `parseSession`, which reads the whole session to build a cache row: 500
 * messages of text for our FTS index, a per-bucket metrics GROUP BY, a user-message count. All of it
 * thrown away to answer "is this turn still running?" (#155). Two small reads is the honest cost.
 */
function readLiveState(sessionId) {
  if (!sessionId) return null;
  const db = openDb();
  if (!db) return null;
  try {
    const s = db.get(
      'SELECT s.ended_at AS endedAt,'
      + ' (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id) AS lastTs'
      + ' FROM sessions s WHERE s.id = ?',
      sessionId
    );
    if (!s) return null;
    const last = lastMessage(db, sessionId);
    return {
      isEnded: s.endedAt != null,
      // No messages -> no activity. NOT the session's start time: a session nobody has spoken to yet has
      // not been active, and reading it as such is what made a freshly launched Hermes look busy.
      lastActivityMs: s.lastTs ? Number(s.lastTs) * 1000 : 0,
      lastRole: last ? last.role : null,
      lastFinishReason: last ? last.finishReason : null,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

// #282 lever 1: gate the `readLiveState` open on a cheap signature of state.db (+ its `-wal`).
// adopt.updateBackendLiveStates re-reads busy/idle for every live session on every watcher flush — including
// flushes from OTHER backends, which cannot have moved state.db at all — and each read re-opened the WAL
// database. Open only when state.db actually changed; otherwise reuse the last row (the derivation re-runs
// with a fresh `now` in state.js, so the time-based idle edge is unaffected). The signature is global to the
// store, so any Hermes write re-reads every live Hermes session — conservative but never stale.
const _liveStateCache = new Map();   // sessionId -> { sig, row }
// Bounded so the memo can't grow with every distinct session id ever read live over the app's lifetime
// (#286) — the same FIFO cap folder-parse.js puts on its `_fileReadState`. An evicted entry costs one
// re-read; live sessions are far fewer than this.
const LIVE_STATE_CACHE_MAX = 256;

function readLiveStateGated(sessionId) {
  if (!sessionId) return null;
  const sig = dbSignature(dbPath());
  const entry = _liveStateCache.get(sessionId);
  if (entry && entry.sig === sig) return entry.row;
  const row = readLiveState(sessionId);
  if (!row) return null;   // locked/absent -> retry next flush, don't cache a miss (openDb nulls under lock)
  _liveStateCache.set(sessionId, { sig, row });
  if (_liveStateCache.size > LIVE_STATE_CACHE_MAX) _liveStateCache.delete(_liveStateCache.keys().next().value);
  return row;
}

/** Test seam: drop the gate's memo so a store mutated in place is re-read. */
function _clearLiveStateCache() { _liveStateCache.clear(); }

// #283: the live-pairing candidates — just the three columns matchLiveSession needs (id, start, cwd),
// one row per session from the small `sessions` table. The old path ran discoverSessions() (a GROUP BY
// over the whole `messages` table for a marker the matching never uses) and then a FULL parseSession per
// unclaimed candidate (500-message text pull, metrics GROUP BY, user-message count) — all on the main
// thread, on every unpaired flush, to answer a three-column question. This is that question.
function listLiveCandidates({ includeAll = false } = {}) {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db.all(`SELECT s.id AS id, s.started_at AS startedAt, s.cwd AS cwd FROM sessions s${sourceFilter(includeAll)}`);
    return rows.map(r => ({
      sessionId: String(r.id),
      // Hermes stores times as REAL unix epoch seconds; matchLiveSession compares in ms.
      startedMs: r.startedAt != null ? Number(r.startedAt) * 1000 : NaN,
      cwd: r.cwd || null,
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

// #283: liveRefFor only needs to CONFIRM the row exists (resume already holds the id) — a full parse to do
// that ran the 500-message pull etc. on every flush until it answered. One indexed lookup instead.
function sessionExists(sessionId) {
  if (!sessionId) return false;
  const db = openDb();
  if (!db) return false;
  try {
    return !!db.get('SELECT 1 AS x FROM sessions WHERE id = ?', sessionId);
  } catch {
    return false;
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
function countUserMessages(db, sessionId) {
  try {
    const row = db.get("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user'", sessionId);
    return Number((row && row.n) || 0);
  } catch {
    return 0;
  }
}

function readMessages(sessionId, { limit = 2000 } = {}) {
  const db = openDb();
  if (!db) return [];
  try {
    // Take the LAST n, not the first. The two consumers both want the recent end: the handoff pre-fill
    // reads the newest assistant turn, and the viewer scrolls to the bottom. Reading the head would, on
    // exactly the long sessions this feature exists for, serve a stale mid-session turn AS the fresh
    // packet — silently wrong content, which is worse than the empty textarea it replaced.
    //
    // Only real conversation turns: Hermes also stores tool scaffolding and compacted-away rows, and an
    // assistant row whose "content" is a tool call is not the packet.
    const rows = db.all(
      "SELECT role, content, timestamp FROM messages"
      + " WHERE session_id = ? AND content IS NOT NULL AND content <> ''"
      + " AND role IN ('user', 'assistant')"
      + ' ORDER BY id DESC LIMIT ?',
      sessionId, limit
    );
    rows.reverse();   // back into chronological order for the viewer
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
  discoverSessions, parseSession, watchTargets, readMessages, readLiveState, readLiveStateGated,
  listLiveCandidates, sessionExists,
  _clearLiveStateCache,
  openDb,
};
