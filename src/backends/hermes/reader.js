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
// Live schema (docs/plans/multi_llm/research/hermes-format.md, dumped from a real install): `sessions`
// carries a real `cwd`, a full token breakdown, `parent_session_id` lineage, and USD cost
// (`estimated_cost_usd` / `actual_cost_usd` / `cost_status` / `cost_source` / `pricing_version`). The
// column COUNT that stood here belonged to one machine's schema version — 33 then, 48 and 58 at the two
// versions #535 measured. Nothing in this file depends on it, and a number that moves is a number to
// leave out.
// There is no `updated_at` column, so the change marker is built from `ended_at` / message activity.
// (0.21.0's schema — version 30 — does add `last_activity_at`, but it is a rate-limited heartbeat that
// Hermes' own code says never to trust alone, and a store only reaches that schema once 0.21.0 has opened
// it. The synthesised marker stays.)
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
//   v3: `recovered` sessions are ingested — a session Hermes repaired after a crash (#551)
//   v4: imported sessions are ingested, and the row records what they were imported from (#552)
//   v5: a 0.23 store's soft-deleted (rewound / compaction-archived) and hidden scaffolding rows no longer
//       reach the first prompt, search body, user count, last-activity stamp or busy/idle (#864)
const PARSER_SCHEMA_VERSION = 5;

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

// What we ingest: the session kinds that are somebody's coding work, named one by one.
//
// **`source` is an OPEN set, and that is the point of an allow-list** (#535, corrected). `hermes --source
// <anything>` sets it through `HERMES_SESSION_SOURCE`, and every gateway platform contributes its own
// name, so it cannot be enumerated — an earlier version of this comment tried and was wrong twice over.
// Hermes' own two lists disagree with each other, which is the shortest proof: `KNOWN_SOURCES` in
// `hermes_cli/session_lost_and_found.py` names `recovered`, `subagent` and `acp` but not `claude-code`,
// `codex-cli`, `bot_room` or `api_server`, while its desktop app's `session-source.ts` names those last
// two and not the first three. An allow-list holds out whatever neither list has heard of.
//
// INGESTED, with the reason each one is here:
//
//   `cli` — a session the user drove from a terminal. Ours (`hermes_cli/cli_session_mixin.py` writes
//   `HERMES_SESSION_SOURCE` or falls back to this).
//
//   `recovered` — a session row Hermes rebuilt from orphaned messages (`session_recovery.py`,
//   `session_lost_and_found.py`). A crash mid-session is the ordinary way to get one, so these are
//   exactly the sessions a user goes looking for, and the messages are real. The stub carries NO `cwd`
//   (its INSERT names id/source/started_at/title/message_count and nothing else) — which is not a new
//   problem: a cwd-less session lands in the backend-scoped bucket the gateway/cron chats already use
//   (`sessionBucketPath` in ../hermes/index.js, §5.9) instead of being forced under a project (#551).
//
//   `claude-code` / `codex-cli` — a Claude Code or Codex CLI transcript brought into Hermes' own store
//   by `hermes sessions import` (`hermes_cli/foreign_sessions.py`, `_SOURCE_DB_NAMES`). Real coding
//   work, and the import copies the cwd the foreign transcript recorded, so these group under a project
//   like any other session. **The duplicate is real and accepted**: Switchboard also reads the Claude and
//   Codex stores directly, so the same work can appear twice, once under each backend. The row says
//   where it came from (`importedFrom`, below) so the second copy reads as provenance rather than as a
//   bug — hiding it would surprise the user who ran the import on purpose (#552).
//
// HELD OUT, and these reasons were the ones missing before:
//
//   `bot_room` — one row per Group Chat room (`gateway/platforms/api_server_room_dispatch.py`), not a
//   session anybody coded in.
//
//   `telegram`, `discord`, `slack`, … — gateway chats, named by whichever platform adapter took the
//   message. Conversations, not work in a project, and the set grows with every adapter — which is why
//   they are held out by ABSENCE rather than by name.
//
//   `subagent` — a delegated child. It belongs to its parent's turn; Hermes' own session search hides
//   these too.
//
//   `cron`, `kanban`, `api_server`, `acp`, `tool` — machine-driven turns (a schedule, a board, the HTTP
//   API, an editor's ACP bridge, an integration). Nobody is sitting in front of one.
//
//   anything else — an unknown value is held out by not being in the list, and that is the whole
//   argument for an allow-list here.
const INGEST_SOURCES = ['cli', 'recovered', 'claude-code', 'codex-cli'];

// Which tool a session was imported FROM, as a label a person reads — null when it was not imported.
//
// The mapping stays HERE, inside the backend's own folder, and what leaves is a plain string. That is
// what keeps `claude-code` out of the core and out of the renderer: the cache stores the label, the
// sidebar prints it, and neither has to know that Hermes spells its import sources this way. An
// unrecognised value is not translated — a source we have no sentence for is not "imported", it is
// simply not in this table (#552).
// A Map, not an object literal: `source` is a free string a user can set (`hermes --source constructor`),
// and a plain object would answer that lookup with something off Object.prototype — a truthy non-string
// this would then hand to the cache as a label.
const IMPORT_ORIGINS = new Map([
  ['claude-code', 'Claude Code'],
  ['codex-cli', 'Codex CLI'],
]);

function importOrigin(source) {
  return IMPORT_ORIGINS.get(String(source || '')) || null;
}

// --- which session rows are ours, by what the store has (#864) ---
//
// Hermes 0.23 (schema 33) keeps TWO source columns. `created_source` is the surface that made the row and is
// permanent ('cli' or 'tui' for a terminal); `source` starts equal and flips to 'local' after the first
// completed turn (measured). Gating on `source = 'cli'` therefore loses every session the moment its first
// turn ends. So when the column exists the terminal surfaces are named by `created_source`, and the old
// `source` allow-list stays for the rows that column says nothing about (an import, a recovered stub, a
// store older than 0.23).
const TERMINAL_SURFACES = ['cli', 'tui'];

function tableColumns(db, table) {
  const cols = new Set();
  try {
    for (const r of db.all(`PRAGMA table_info(${table})`)) cols.add(String(r.name));
  } catch { /* unreadable -> treated as "no such column" */ }
  return cols;
}

function hasTable(db, name) {
  try { return !!db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", name); } catch { return false; }
}

const quoted = (list) => list.map(s => `'${s}'`).join(', ');

// A delegated child is held out by Hermes' own marker, whatever surface it inherited (#553).
function delegateExclusion(cols) {
  return cols.has('model_config')
    ? " AND json_extract((CASE WHEN json_valid(s.model_config) THEN s.model_config ELSE json_object() END), '$._delegate_from') IS NULL"
    : '';
}

/**
 * The WHERE for ingest. `includeAll` lifts every filter. Otherwise a row is ingested when a terminal surface
 * created it (`created_source`, 0.23) or its `source` is on the allow-list. On a 0.23 store an EMPTY LAUNCH
 * STUB is left out as well: a row nobody has written to and no turn was admitted for (Hermes' own
 * `launch_stub_filter_sql`: the CLI was opened and closed, or died before the first turn). Those rows stay
 * open for ever (measured) and listing them would fill the sidebar with sessions that hold nothing.
 */
function ingestWhere(db, includeAll) {
  if (includeAll) return '';
  const cols = tableColumns(db, 'sessions');
  const bySource = `s.source IN (${quoted(INGEST_SOURCES)})`;
  const modern = cols.has('created_source');
  const pick = modern ? `(s.created_source IN (${quoted(TERMINAL_SURFACES)}) OR ${bySource})` : bySource;
  const stub = modern
    ? ` AND (s.message_count > 0${hasTable(db, 'session_admissions')
      ? ' OR EXISTS (SELECT 1 FROM session_admissions a WHERE a.target_session_id = s.id)' : ''})`
    : '';
  return ` WHERE ${pick}${stub}${delegateExclusion(cols)}`;
}

// Live PAIRING asks a narrower question than ingest: which row did the session we JUST spawned write?
// Only a terminal surface writes one of those. A `recovered` stub is a rebuild of a session that already
// ended, and an imported transcript was written by another tool on another day — neither can be the row a
// launch just created, so both stay out of the candidate pool they were never in (#551, #552). Resuming an
// imported session is unaffected: `liveRefFor` already holds the id and asks `sessionExists`.
//
// A row that already ENDED is not the one a launch just made, and a row with a parent is a branch, a
// rewind fork or a compression continuation of a session that existed before — the tab that tracks the
// parent follows it (`followTarget`), and it must not be offered to another tab that is unpaired in the
// same directory.
//
// One exception, with `sinceMs`: a `/branch` made before the tab's FIRST pairing tick leaves only the child
// to pair with (the parent ended as `branched`), so a child whose parent was itself born inside the tab's
// window and ended that way is offered. A parent born before the window is somebody else's conversation.
function liveCandidateFilter(db, includeAll, { sinceMs = null } = {}) {
  if (includeAll) return '';
  const cols = tableColumns(db, 'sessions');
  // A 0.21 store never wrote `ended_at` and its pairing has always been source + directory + time, so the
  // two narrowing terms apply to the 0.23 schema only.
  if (!cols.has('created_source')) return " WHERE s.source = 'cli'";
  const sec = Number.isFinite(sinceMs) ? Number(sinceMs) / 1000 : null;
  const parentless = sec == null
    ? 's.parent_session_id IS NULL'
    : '(s.parent_session_id IS NULL OR EXISTS (SELECT 1 FROM sessions p WHERE p.id = s.parent_session_id'
      + ` AND p.end_reason = 'branched' AND p.started_at >= ${sec}))`;
  return ` WHERE s.created_source IN (${quoted(TERMINAL_SURFACES)}) AND s.ended_at IS NULL`
    + ` AND ${parentless}${delegateExclusion(cols)}`;
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
      `SELECT s.id AS id, ${MARKER_SQL} AS marker FROM sessions s${LAST_MESSAGE_JOIN}${ingestWhere(db, includeAll)}`
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

// --- which message rows are the conversation (#864) ---
//
// Hermes 0.23 (schema 33) stopped deleting rows. A rewind / undo flips `active` to 0, an in-place compaction
// archives the rows it folded away as `active = 0, compacted = 1`, and scaffolding the person never saw is
// typed through `display_kind`. Read blind, all of that comes back as conversation: an undone prompt is the
// "last row" (a wrong busy), and undone turns and pre-compaction rows land in the first prompt and the search
// body. Like Hermes' own search, the search body keeps `compacted` rows (real history a person searches for);
// every other read (first prompt, user count, viewer, digest, busy/idle) takes live rows only.
//
// The columns are asked for, not the version number: `PRAGMA table_info` is one cheap read per short-lived
// connection and answers exactly "can I filter on this?" for any schema. A store without a column keeps the
// old, unfiltered query. `active` goes through COALESCE: it is nullable in older tables that already carry
// it, and a NULL there is a live row.
//
// Rows that carry a `display_kind` are not what the person typed or what the agent answered. Each kind below
// was checked against Hermes' source:
//   hidden                    model-facing scaffolding the gateway never paints (hermes_state_stored_reads.py)
//   internal_notification     a self-injected machinery turn (gateway/response_filters.py)
//   process_complete          a background-process result card (gateway/response_filters.py)
//   async_delegation_complete a delegated-agent result card (gateway/response_filters.py)
//   auto_continue             the "continue" Hermes sends itself after an interrupted turn (tui_gateway/)
//   model_switch              a durable marker that the model changed (tui_gateway/server.py)
//   personality_switch        a durable marker that the personality changed (tui_gateway/agent_callbacks.py)
//   failed_turn               the ASSISTANT notice written when a turn failed (agent/conversation_loop.py)
// None is a prompt or an answer, so content reads (first prompt, user count, search body, viewer, digest) drop
// all of them. The two result cards are shown by Hermes itself as events through `display_text`; the viewer here
// has only user/assistant messages and no neutral event shape, so they are dropped, not shown as prompts.
const SCAFFOLD_KINDS = [
  'hidden', 'internal_notification', 'process_complete', 'async_delegation_complete',
  'auto_continue', 'model_switch', 'personality_switch', 'failed_turn',
];
// Busy/idle ignores only the two markers: no turn follows them, so a trailing one is not "the last word".
// The other user kinds (hidden, internal_notification, the result cards, auto_continue) START a turn and stay.
const NO_TURN_MARKERS = ['model_switch', 'personality_switch'];

function messageColumns(db) {
  const cols = new Set();
  try {
    for (const r of db.all('PRAGMA table_info(messages)')) cols.add(String(r.name));
  } catch { /* unreadable -> no filtering, the old behaviour */ }
  return cols;
}

/**
 * SQL fragments (each starts with ` AND `, or is empty) for one connection. `live` drops soft-deleted rows;
 * `content` also drops scaffolding. `prefix` is a table alias with its dot ('m.') or ''.
 *
 * Busy/idle uses `turn`: live rows minus the two no-turn markers. A hidden user row (a goal-control send, a
 * machinery notification, an auto-continue) STARTS a turn, so dropping it would read the row before as the last
 * word. `failed_turn` stays too, and `lastMessage` reports it as a finished turn.
 */
function rowFilters(db, prefix = '') {
  const cols = messageColumns(db);
  const live = cols.has('active') ? ` AND COALESCE(${prefix}active, 1) = 1` : '';
  const scaffold = cols.has('display_kind')
    ? ` AND COALESCE(${prefix}display_kind, '') NOT IN (${SCAFFOLD_KINDS.map(k => `'${k}'`).join(', ')})`
    : '';
  // The search body keeps rows a compaction archived (`active = 0, compacted = 1`), like Hermes' own search:
  // they are real history. Only rewound / undone rows (`active = 0`, not compacted) are dropped.
  const turn = live + (cols.has('display_kind')
    ? ` AND COALESCE(${prefix}display_kind, '') NOT IN (${NO_TURN_MARKERS.map(k => `'${k}'`).join(', ')})`
    : '');
  const archived = cols.has('active') && cols.has('compacted')
    ? ` AND (COALESCE(${prefix}active, 1) = 1 OR COALESCE(${prefix}compacted, 0) = 1)`
    : live;
  return {
    live,
    turn,
    hasDisplayKind: cols.has('display_kind'),
    content: live + scaffold,
    search: archived + scaffold,
    // 1 for a row that is part of the live conversation, 0 for an archived one (selected beside the text).
    liveFlag: cols.has('active') ? `COALESCE(${prefix}active, 1) = 1` : '1',
  };
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
    const filters = rowFilters(db);
    try {
      const msgs = db.all(
        "SELECT role, content, timestamp FROM messages WHERE session_id = ? AND content IS NOT NULL AND content <> ''"
        + filters.search + ' ORDER BY id LIMIT 500',
        handle.sessionId
      );
      const parts = [];
      for (const m of msgs) {
        const text = typeof m.content === 'string' ? m.content : '';
        if (!text) continue;
        parts.push(text);
      }
      textContent = parts.join('\n').slice(0, 200000);
    } catch { /* messages unreadable -> still index the session row itself */ }

    // The first prompt has its own query: the body above includes archived history and stops at 500 rows, so on
    // a long compacted session the first LIVE user prompt can lie beyond it.
    try {
      const first = db.get(
        "SELECT content FROM messages WHERE session_id = ? AND role = 'user' AND content IS NOT NULL AND content <> ''"
        + filters.content + ' ORDER BY id LIMIT 1',
        handle.sessionId
      );
      if (first && typeof first.content === 'string') firstPrompt = first.content.slice(0, 500);
    } catch { /* leave it empty -> the summary falls back to the title */ }

    // Last activity is asked SEPARATELY, over all messages. Deriving it from the capped read above
    // would freeze it at message #500 — and busy/idle rides on it (state.js), so a long agent session
    // (tool-call rows add up fast) would be declared idle while it is still working.
    try {
      const last = db.get('SELECT MAX(timestamp) AS t FROM messages WHERE session_id = ?' + filters.turn, handle.sessionId);
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
        ' FROM messages WHERE session_id = ? AND timestamp IS NOT NULL' + filters.live + ' GROUP BY date, hour',
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
      // none, and neither does a `recovered` stub (#551) — those fall into the backend bucket, they are
      // not forced under a project (§5.9).
      cwd: s.cwd || null,
      // Provenance for a session `hermes sessions import` brought in (#552) — the label of the tool it
      // came from, null for everything else. The sidebar marks the row with it, because Switchboard also
      // reads that tool's own store: without the mark the second copy looks like a duplicate nobody can
      // explain.
      importedFrom: importOrigin(s.source),
      summary,
      firstPrompt: firstPrompt || summary,
      textContent,
      created: startedAt,
      modified: lastEntryAt,
      startedAt,
      lastEntryAt,
      activeMinutes,
      messageCount: Number(s.message_count || 0),
      // Hermes has no user-message column, but the rows are right there. It used to be hardcoded to 0.
      // It feeds the session metrics and the handoff prompt; since #620 it decides no health badge — that
      // comes from the context fill, which this store cannot give.
      userMessageCount: countUserMessages(db, handle.sessionId, filters.content),
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
      endedMs: s.ended_at != null ? Number(s.ended_at) * 1000 : 0,
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
    const f = rowFilters(db);
    const m = db.get(
      'SELECT role, finish_reason AS finishReason, timestamp, (content IS NULL OR content = \'\') AS emptyContent'
      + (f.hasDisplayKind ? ', display_kind AS displayKind' : '')
      + ' FROM messages WHERE session_id = ?' + f.turn + ' ORDER BY id DESC LIMIT 1',
      sessionId
    );
    if (!m) return null;
    // Two assistant rows END a turn without a finish_reason, which state.js reads as "still generating":
    // the `failed_turn` notice, and the hidden EMPTY placeholder Hermes appends after a user interruption
    // (`hidden_interrupt_placeholder_row`: role assistant, no content, display_kind hidden). Each says so.
    let finishReason = m.finishReason || null;
    if (m.displayKind === 'failed_turn') finishReason = 'failed_turn';
    else if (!finishReason && m.role === 'assistant' && m.displayKind === 'hidden' && m.emptyContent) finishReason = 'interrupted';
    return {
      role: m.role || null,
      finishReason,
      timestampMs: m.timestamp ? Number(m.timestamp) * 1000 : 0,
    };
  } catch {
    return null;
  }
}

/**
 * What Hermes 0.23's own turn ledger says about a session, or `{ hasLedger: false }` on a store without it.
 *
 * `session_admissions` (one row per admitted turn, `target_session_id`, `status` queued / started / unknown /
 * terminal, `outcome`) is the runtime's own statement that a turn runs: measured `started` from ~0.36 s after
 * Enter until `terminal`. It has no timestamp, so a row a crash left `started` cannot be told from a running
 * one by itself — state.js bounds it by the last activity. `session_turn_leases` (`conversation_id`,
 * `acquired_at`, `expires_at` = acquired + 300 s) exists only during the model call; an unexpired lease
 * corroborates the admission, and `expires_at` is its own staleness bound. A lease is keyed by the
 * conversation, which is the session id until a compression rotates it, so a miss proves nothing.
 *
 * `unknown` (the runtime lost the owner of a turn, e.g. after a crash) is not counted as running: nothing is
 * writing. That status was not measured live; it is read from the source.
 */
function readTurnLedger(db, sessionId) {
  if (!hasTable(db, 'session_admissions')) return { hasLedger: false };
  const out = { hasLedger: true, admission: null, leaseExpiresMs: 0, leaseAcquiredMs: 0 };
  try {
    // Hermes counts ANY `queued` or `started` row as an active turn (`gateway/run_idle_exit.py` `_ledger_busy`;
    // the queue is FIFO, `hermes_state_runtime.py`), so the newest row alone is wrong: a queued prompt the user
    // cancels becomes `terminal`/`cancelled` ABOVE the `started` turn that is still running.
    // The one thing taken off Hermes' rule is the turn a crash left behind: an older `started` (or `queued`) row
    // BELOW a later `terminal` row of a turn that STARTED (a started turn keeps its `generation`; a cancelled
    // queued one never had one) can no longer be running, since turns run one at a time. A restarted daemon turns
    // those into `unknown` anyway; this covers the gap before it does. The activity window bounds the rest.
    const hasGeneration = tableColumns(db, 'session_admissions').has('generation');
    const floor = hasGeneration
      ? "AND seq > COALESCE((SELECT MAX(seq) FROM session_admissions WHERE target_session_id = ? AND status = 'terminal' AND generation IS NOT NULL), 0)"
      : '';
    const open = db.all(
      "SELECT status FROM session_admissions WHERE target_session_id = ? AND status IN ('queued', 'started') " + floor,
      ...(hasGeneration ? [sessionId, sessionId] : [sessionId])
    );
    if (open.some(r => r.status === 'started')) out.admission = 'started';
    else if (open.length) out.admission = 'queued';
  } catch { return { hasLedger: false }; }
  if (hasTable(db, 'session_turn_leases')) {
    try {
      const l = db.get('SELECT acquired_at AS acquiredAt, expires_at AS expiresAt FROM session_turn_leases WHERE conversation_id = ?', sessionId);
      if (l) {
        out.leaseExpiresMs = Number(l.expiresAt) * 1000 || 0;
        out.leaseAcquiredMs = Number(l.acquiredAt) * 1000 || 0;
      }
    } catch { /* corroboration only */ }
  }
  return out;
}

/**
 * Where a tab tracking `sessionId` goes next, or null (#864).
 *
 * Hermes moves a conversation to a NEW row in two ways, and in both the old row stays in the store (listed,
 * with lineage) while the process carries on in the child:
 *   - a branch / fork (`/branch`, a fork from a rewind): the parent ends with `end_reason = 'branched'`, the
 *     child has `parent_session_id` and a copy of the messages (measured, child at +0.6 s). -> 'fork'
 *   - a compression continuation: the parent ends with `end_reason = 'compression'` and the child continues
 *     the conversation (`get_compression_tip`, hermes_state_compression.py; not measured live). -> 'adopted'
 *
 * The compression step is Hermes' own `_CHAIN_STEP_SQL` (hermes_state_compression.py), clause for clause: the
 * child carries no `_branched_from`, `_delegate_from` or `_reset_from` marker and is not source 'tool' (the
 * pre-marker reset heuristic needs a parent ended by a RESET reason, which a parent ended by `compression` never
 * is, so it has no clause here); among several, one that itself ended by compression comes first (the chain goes
 * on), then a still-open one, then the most recently active, then the newest start, then the id. The branch
 * step is Hermes' `_BRANCH_CHILD_SQL`: a `_branched_from` marker, or a child started at or after the moment
 * the parent ended as `branched`.
 * A rewind (/undo) keeps the id and is not a move at all. The walk follows a chain of continuations to its
 * tip (bounded), so a resume of a compressed parent lands where Hermes' own `-r` lands.
 *
 * `{ sessionId, ref, reason }`; `reason` is the first step's.
 */
function followTargetUncached(sessionId, { sinceMs = null } = {}) {
  if (!sessionId) return null;
  const db = openDb();
  if (!db) return null;
  try {
    const cols = tableColumns(db, 'sessions');
    const hasReason = cols.has('end_reason') && cols.has('parent_session_id');
    if (!hasReason) return null;
    const hasConfig = cols.has('model_config');
    // A marker lookup that cannot throw on a column holding something that is not JSON (`_sql_json_extract`).
    const markerValue = (name) => `json_extract((CASE WHEN json_valid(c.model_config) THEN c.model_config ELSE json_object() END), '$.${name}')`;
    const marker = (name) => (hasConfig ? `${markerValue(name)} IS NOT NULL` : '0');
    const noMarker = (name) => (hasConfig ? ` AND ${markerValue(name)} IS NULL` : '');
    const notTool = " AND COALESCE(c.source, '') <> 'tool'";
    // `_sql_session_last_active`: the freshest of the heartbeat and the newest message (the heartbeat is
    // rate-limited and can lag a newer message), else the start. Hermes also skips cells outside a sane epoch
    // window; a garbage cell is not a case this read has seen, so that guard is not copied.
    const recency = 'COALESCE((SELECT MAX(v) FROM (SELECT ' + (cols.has('last_activity_at') ? 'c.last_activity_at' : 'NULL')
      + ' AS v UNION ALL SELECT (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = c.id)) WHERE v IS NOT NULL), c.started_at)';
    const select = 'SELECT c.id AS id, c.started_at AS startedAt FROM sessions c WHERE c.parent_session_id = ?';
    const compressionStep = select + noMarker('_branched_from') + noMarker('_delegate_from') + noMarker('_reset_from') + notTool
      + " ORDER BY CASE WHEN c.end_reason = 'compression' THEN 0 WHEN c.ended_at IS NULL THEN 1 ELSE 2 END,"
      + ` ${recency} DESC, c.started_at DESC, c.id DESC LIMIT 1`;
    const branchStep = select + noMarker('_delegate_from') + notTool
      + ` AND (${marker('_branched_from')} OR c.started_at >= (SELECT p.ended_at FROM sessions p WHERE p.id = c.parent_session_id AND p.end_reason = 'branched'))`
      + ` ORDER BY CASE WHEN c.ended_at IS NULL THEN 0 ELSE 1 END, ${recency} DESC, c.started_at DESC, c.id DESC LIMIT 1`;
    let current = String(sessionId);
    let first = null;
    const seen = new Set([current]);
    for (let step = 0; step < 16; step++) {
      const parent = db.get('SELECT end_reason AS endReason FROM sessions WHERE id = ?', current);
      const why = parent && parent.endReason === 'branched' ? 'fork'
        : parent && parent.endReason === 'compression' ? 'adopted' : null;
      if (!why) break;
      const child = db.get(why === 'fork' ? branchStep : compressionStep, current);
      if (!child || seen.has(String(child.id))) break;
      // A branch made while this tab ran is its move; one made before is somebody else's, and a tab that
      // merely resumed the parent must not be pulled onto it (Hermes' own `-r` follows only compression).
      if (why === 'fork' && sinceMs != null && !(Number(child.startedAt) * 1000 >= sinceMs)) break;
      current = String(child.id);
      seen.add(current);
      if (!first) first = why;
      // A branch is one move; only a compression chain is walked on to its tip.
      if (why === 'fork') break;
    }
    return first ? { sessionId: current, ref: current, reason: first } : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

// The follow question is asked on every watcher flush for every live session, like busy/idle, so it gets the
// same gate (#282): re-open the database only when state.db (or its -wal) moved since the last answer.
const _followCache = new Map();   // `${id}|${sinceMs}` -> { sig, result }
function followTarget(sessionId, opts = {}) {
  if (!sessionId) return null;
  const key = `${sessionId}|${opts.sinceMs == null ? '' : opts.sinceMs}`;
  const sig = dbSignature(dbPath());
  const hit = _followCache.get(key);
  if (hit && hit.sig === sig) return hit.result;
  const result = followTargetUncached(sessionId, opts);
  _followCache.set(key, { sig, result });
  if (_followCache.size > LIVE_STATE_CACHE_MAX) _followCache.delete(_followCache.keys().next().value);
  return result;
}

// A CLI `/new` (#869), measured on 0.23: the old row ends with `end_reason = 'new_session'` (or is deleted when it
// was empty, `_discard_session_if_empty`), and the new one is parentless and, on a gateway store, has no cwd — so
// nothing in the store ties it to the tab. What does is Hermes' per-terminal breadcrumb,
// `<home>/terminal-sessions/<terminal id>` = `{ session_id, cwd, ts }`, rewritten at start, on `/new`, after a turn,
// on a branch and on a resume (`hermes_cli/terminal_breadcrumbs.py`). The terminal id is the caller's, derived from
// an identity the spawn set for this tab only, so the file names this tab's session and no other terminal's.
// Followed only when the store agrees: the old row ended as `new_session` (or is gone), the new row exists, has no
// parent, and started after the tab opened and not before the old row ended.
const _newCache = new Map();   // `${ref}|${sinceMs}|${terminalId}` -> { sig, result }
function breadcrumbSession(terminalId) {
  if (!terminalId || /[\\/]/.test(terminalId) || terminalId === '.' || terminalId === '..') return { sig: '', id: null };
  const file = path.join(hermesHome(), 'terminal-sessions', terminalId);
  let st;
  try { st = fs.statSync(file); } catch { return { sig: 'none', id: null }; }
  if (!st.isFile() || st.size > 64 * 1024) return { sig: 'bad', id: null };
  const sig = `${st.mtimeMs}:${st.size}`;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    const id = data && typeof data.session_id === 'string' ? data.session_id.trim() : '';
    return { sig, id: id || null };
  } catch { return { sig, id: null }; }
}
function followNewSession(sessionId, { sinceMs = null, terminalId = null } = {}) {
  if (!sessionId || !terminalId) return null;
  const crumb = breadcrumbSession(terminalId);
  const key = `${sessionId}|${sinceMs == null ? '' : sinceMs}|${terminalId}`;
  const sig = `${dbSignature(dbPath())}|${crumb.sig}`;
  const hit = _newCache.get(key);
  if (hit && hit.sig === sig) return hit.result;
  let result = null;
  if (crumb.id && crumb.id !== String(sessionId)) {
    const db = openDb();
    if (db) {
      try {
        const cols = tableColumns(db, 'sessions');
        if (cols.has('end_reason') && cols.has('parent_session_id')) {
          const old = db.get('SELECT end_reason AS endReason, ended_at AS endedAt FROM sessions WHERE id = ?', String(sessionId));
          const next = db.get('SELECT id, started_at AS startedAt, parent_session_id AS parentId FROM sessions WHERE id = ?', crumb.id);
          const started = next ? Number(next.startedAt) : NaN;
          const ok = !!next && !next.parentId && Number.isFinite(started)
            && (!old || old.endReason === 'new_session')
            && (sinceMs == null || started * 1000 >= sinceMs)
            && (!old || old.endedAt == null || started >= Number(old.endedAt) - 2);
          if (ok) result = { sessionId: String(next.id), ref: String(next.id), reason: 'clear' };
        }
      } catch { result = null; } finally { db.close(); }
    }
  }
  _newCache.set(key, { sig, result });
  if (_newCache.size > LIVE_STATE_CACHE_MAX) _newCache.delete(_newCache.keys().next().value);
  return result;
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
      + ' (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id' + rowFilters(db, 'm.').turn + ') AS lastTs'
      + ' FROM sessions s WHERE s.id = ?',
      sessionId
    );
    if (!s) return null;
    const last = lastMessage(db, sessionId);
    const turn = readTurnLedger(db, sessionId);
    return {
      isEnded: s.endedAt != null,
      // `ended_at` is written by a graceful exit and by a fork, and is NOT cleared by `-r` (measured), so on its
      // own it says nothing about a session that is running now. state.js compares it with the last activity.
      endedMs: s.endedAt != null ? Number(s.endedAt) * 1000 : 0,
      ...turn,
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
function _clearLiveStateCache() { _liveStateCache.clear(); _followCache.clear(); _newCache.clear(); }

// #283: the live-pairing candidates — just the three columns matchLiveSession needs (id, start, cwd),
// one row per session from the small `sessions` table. The old path ran discoverSessions() (a GROUP BY
// over the whole `messages` table for a marker the matching never uses) and then a FULL parseSession per
// unclaimed candidate (500-message text pull, metrics GROUP BY, user-message count) — all on the main
// thread, on every unpaired flush, to answer a three-column question. This is that question.
function listLiveCandidates({ includeAll = false, sinceMs = null } = {}) {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db.all(
      'SELECT s.id AS id, s.started_at AS startedAt, s.cwd AS cwd, s.parent_session_id AS parentId FROM sessions s'
      + liveCandidateFilter(db, includeAll, { sinceMs })
    );
    return rows.map(r => ({
      sessionId: String(r.id),
      parentId: r.parentId ? String(r.parentId) : null,
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
function countUserMessages(db, sessionId, filter = '') {
  try {
    const row = db.get("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user'" + filter, sessionId);
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
      + rowFilters(db).content
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
  listLiveCandidates, sessionExists, followTarget, followNewSession,
  _clearLiveStateCache,
  openDb,
};
