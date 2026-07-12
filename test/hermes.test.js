'use strict';
// Phase 5 — Hermes: the first NON-FILE backend. This is what proves the dual-mode discovery seam:
// {kind:'db'} handles, a row-based parse, and a change marker that stands in for a file mtime.
//
// The fixture is BUILT (test/fixtures/hermes-fixture.js) from the REAL schema dumped off a live install
// (docs/plans/research/hermes-format.md) — the live DB itself has zero sessions, so there is nothing real
// to read. It used to be a checked-in `hermes-state.db`, which `.gitignore` (`*.db`) silently kept out of
// the repo: the file existed only where it was made, and these tests failed on every clone (#158).
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const hermes = require('../backends/hermes');
const reader = require('../backends/hermes/reader');
const { deriveState, ACTIVITY_WINDOW_MS } = require('../backends/hermes/state');
const { makeHermesHome, T0 } = require('./fixtures/hermes-fixture');

// Point the reader at a HERMES_HOME holding a freshly built state.db.
function useFixture() {
  const home = makeHermesHome();
  hermes.setHome(home);
  return home;
}

test('store root: %LOCALAPPDATA%\\hermes on Windows, never a hardcoded ~/.hermes', () => {
  hermes.setHome(null);
  const prevHome = process.env.HERMES_HOME;
  delete process.env.HERMES_HOME;
  try {
    const home = reader.hermesHome();
    if (process.platform === 'win32') {
      assert.match(home, /AppData[\\/]Local[\\/]hermes$/i, 'Windows store lives under LOCALAPPDATA');
      assert.ok(!/\.hermes$/.test(home), '~/.hermes is the Linux path, not the Windows one');
    } else {
      assert.match(home, /\.hermes$/);
    }
  } finally {
    if (prevHome) process.env.HERMES_HOME = prevHome;
  }
});

test('HERMES_HOME overrides the store root', () => {
  hermes.setHome(null);
  const prev = process.env.HERMES_HOME;
  process.env.HERMES_HOME = 'D:\\custom\\hermes';
  try {
    assert.strictEqual(reader.hermesHome(), 'D:\\custom\\hermes');
  } finally {
    if (prev) process.env.HERMES_HOME = prev; else delete process.env.HERMES_HOME;
  }
});

test('a missing store degrades to empty, never throws (Hermes installed but never run)', () => {
  hermes.setHome(path.join(os.tmpdir(), 'hermes-does-not-exist-' + Date.now()));
  assert.strictEqual(reader.dbExists(), false);
  assert.deepStrictEqual(reader.discoverSessions(), []);
  assert.strictEqual(reader.parseSession({ kind: 'db', sessionId: 'x' }), null);
});

test('discoverSessions yields {kind:db} handles — only source=cli by default', () => {
  useFixture();
  const handles = reader.discoverSessions();
  const ids = handles.map(h => h.sessionId).sort();
  // sess-gateway-1 is source='gateway' -> a Telegram/cron chat, not a coding session -> excluded.
  assert.deepStrictEqual(ids,
    ['sess-cli-1', 'sess-cli-2', 'sess-cli-nocwd', 'sess-no-messages', 'sess-running', 'sess-zero-cost']);
  for (const h of handles) {
    assert.strictEqual(h.kind, 'db', 'db-mode handle, not a file handle');
    assert.ok(h.marker, 'carries a change marker (there is no file mtime to use)');
    assert.ok(!h.path, 'a db session has no file path');
  }
});

test('includeAll pulls the gateway sessions in too', () => {
  useFixture();
  const ids = reader.discoverSessions({ includeAll: true }).map(h => h.sessionId).sort();
  assert.ok(ids.includes('sess-gateway-1'));
});

test('parseSession maps a row to the normalised shape (id taken verbatim, never parsed)', () => {
  useFixture();
  const h = reader.discoverSessions().find(x => x.sessionId === 'sess-cli-1');
  const row = reader.parseSession(h);

  assert.strictEqual(row.sessionId, 'sess-cli-1');
  assert.strictEqual(row.backendId, 'hermes');
  assert.strictEqual(row.cwd, 'D:\\Projekte\\demo', 'a real cwd column EXISTS (the plan assumed it did not)');
  assert.strictEqual(row.model, 'claude-opus-4.6');
  assert.strictEqual(row.summary, 'Refactor the auth middleware');
  assert.strictEqual(row.messageCount, 4);
  // REAL epoch seconds -> ISO
  assert.strictEqual(row.startedAt, new Date(T0 * 1000).toISOString());
  assert.strictEqual(row.lastEntryAt, new Date((T0 + 600) * 1000).toISOString());
  assert.strictEqual(row.activeMinutes, 10);
});

test('token breakdown + USD cost are read (Hermes is the only backend reporting money)', () => {
  useFixture();
  const h = reader.discoverSessions().find(x => x.sessionId === 'sess-cli-1');
  const row = reader.parseSession(h);
  assert.strictEqual(row.inputTokens, 1000);
  assert.strictEqual(row.outputTokens, 200);
  assert.strictEqual(row.cacheReadTokens, 50);
  assert.strictEqual(row.cacheCreationTokens, 10);
  assert.strictEqual(row.reasoningTokens, 25);
  // estimated is the PRIMARY field; actual is often null -> the UI must not present an estimate as truth
  assert.strictEqual(row.estimatedCostUsd, 0.0123);
  assert.strictEqual(row.actualCostUsd, null);
  assert.strictEqual(row.costStatus, 'estimated');
});

test('a session with a real actual cost reports both figures', () => {
  useFixture();
  const h = reader.discoverSessions().find(x => x.sessionId === 'sess-cli-2');
  const row = reader.parseSession(h);
  assert.strictEqual(row.estimatedCostUsd, 0.004);
  assert.strictEqual(row.actualCostUsd, 0.0038);
  assert.strictEqual(row.costStatus, 'actual');
});

test('lineage: parent_session_id is surfaced', () => {
  useFixture();
  const h = reader.discoverSessions().find(x => x.sessionId === 'sess-cli-2');
  assert.strictEqual(reader.parseSession(h).parentSessionId, 'sess-cli-1');
});

test('message text feeds OUR FTS body + first prompt', () => {
  useFixture();
  const h = reader.discoverSessions().find(x => x.sessionId === 'sess-cli-1');
  const row = reader.parseSession(h);
  assert.match(row.textContent, /Refactor the auth middleware and add tests/);
  assert.match(row.textContent, /extracted the token check/);
  assert.strictEqual(row.firstPrompt, 'Refactor the auth middleware and add tests');
});

test('a cwd-less session parses fine and is NOT dropped (it needs the backend bucket)', () => {
  useFixture();
  const h = reader.discoverSessions().find(x => x.sessionId === 'sess-cli-nocwd');
  const row = reader.parseSession(h);
  assert.ok(row, 'still a valid session');
  assert.strictEqual(row.cwd, null, 'a general agent genuinely has no working dir here');
  assert.strictEqual(typeof hermes.sessionBucketPath(), 'string', 'the backend offers a bucket for it');
});

test('the change marker moves when a session changes (it replaces the file mtime)', () => {
  useFixture();
  const before = reader.discoverSessions().find(h => h.sessionId === 'sess-cli-1').marker;
  assert.ok(before && before.includes(':'), 'marker is built from ended_at + last message + count');
  // Same DB, unchanged -> same marker => the scanner will skip the row.
  const again = reader.discoverSessions().find(h => h.sessionId === 'sess-cli-1').marker;
  assert.strictEqual(again, before, 'an unchanged session must produce a stable marker');
});

test('watchTargets returns the DB (the watcher polls its -wal too — a WAL commit misses the mtime)', () => {
  useFixture();
  const t = hermes.watchTargets();
  assert.strictEqual(t[0].kind, 'db');
  assert.match(t[0].path, /state\.db$/);
});

// --- state derivation (T-5.3): Hermes has no OSC title and no shipped status file, so the DB row IS
// the signal: ended_at null + recent activity = busy.

test('deriveState: a finished session is idle', () => {
  useFixture();
  const h = reader.discoverSessions().find(x => x.sessionId === 'sess-cli-1');
  assert.strictEqual(deriveState(reader.parseSession(h)), 'idle');
});

test('deriveState: a running session with recent activity is busy', () => {
  useFixture();
  const h = reader.discoverSessions().find(x => x.sessionId === 'sess-running');
  const row = reader.parseSession(h);
  assert.strictEqual(row.isEnded, false, 'ended_at is null while the turn runs');
  const justAfter = (T0 + 1001) * 1000 + 1000;   // 1s after its last message
  assert.strictEqual(deriveState(row, justAfter), 'busy');
});

test('deriveState: a stale running session goes idle (crashed/abandoned, never spins forever)', () => {
  useFixture();
  const h = reader.discoverSessions().find(x => x.sessionId === 'sess-running');
  const row = reader.parseSession(h);
  const wayLater = (T0 + 1001) * 1000 + ACTIVITY_WINDOW_MS + 1000;
  assert.strictEqual(deriveState(row, wayLater), 'idle');
});

// --- descriptor

test('descriptor: Axis-B, ready, monogram H, argv spawn, and NO auth injected', () => {
  assert.strictEqual(hermes.id, 'hermes');
  assert.strictEqual(hermes.axis, 'B');
  assert.strictEqual(hermes.status, 'ready');
  assert.strictEqual(hermes.monogram, 'H');

  const launch = hermes.buildLaunch({ cwd: 'D:\\p', resume: false, sessionId: 'S' });
  assert.strictEqual(launch.spawnMode, 'argv', 'hermes is a real .exe — argv mode genuinely applies');
  // Hermes self-auths from its OWN .env/OAuth. We must inject nothing and never read its credentials.
  assert.deepStrictEqual(launch.env, {}, 'no auth key may be injected');
});

test('buildLaunch: resume targets the recorded session id (binary-bound, §5.11)', () => {
  const launch = hermes.buildLaunch({ resume: true, sessionId: 'sess-cli-1' });
  assert.deepStrictEqual(launch.args, ['-r', 'sess-cli-1']);
});

// --- D10: identity adoption. Hermes, like Codex, creates its OWN session id in its own store, so the
// id we launch under is not the id it records. Without this, resume targets an id Hermes never had and
// the sidebar shows a ghost row. This is the DB-side of the same seam.

test('matchLiveSession: finds the DB row for a session we just launched in this cwd', () => {
  useFixture();
  const match = hermes.matchLiveSession({ cwd: 'D:\\Projekte\\demo', sinceMs: 0, claimed: new Set() });
  assert.ok(match, 'found the session row');
  assert.strictEqual(match.sessionId, 'sess-cli-1', 'the EARLIEST matching session (launch order)');
});

test('matchLiveSession: never hands the same session to two tabs', () => {
  useFixture();
  const match = hermes.matchLiveSession({
    cwd: 'D:\\Projekte\\demo', sinceMs: 0, claimed: new Set(['sess-cli-1']),
  });
  assert.ok(match, 'a second live tab gets the NEXT session, not the claimed one');
  assert.notStrictEqual(match.sessionId, 'sess-cli-1');
});

test('matchLiveSession: ignores a session from another project', () => {
  useFixture();
  const match = hermes.matchLiveSession({ cwd: 'D:\\Projekte\\elsewhere', sinceMs: 0, claimed: new Set() });
  assert.strictEqual(match, null);
});

test('matchLiveSession: ignores sessions that predate the launch', () => {
  useFixture();
  const match = hermes.matchLiveSession({
    cwd: 'D:\\Projekte\\demo', sinceMs: Date.now() + 3600_000, claimed: new Set(),
  });
  assert.strictEqual(match, null, 'an older session belongs to a previous run');
});

// The RESUME half of the seam. `matchLiveSession` deliberately ignores records that predate the launch
// — which is EVERY record a resume continues. Without `liveRefFor`, a resumed session could never claim
// its own row (no busy/idle, a full-store search on every watcher tick), and the stale claim would later
// adopt the id of the next NEW session in the same cwd, folding two tabs onto one identity.
test('liveRefFor: a resumed session claims its OWN row, however old it is', () => {
  useFixture();
  assert.strictEqual(hermes.liveRefFor('sess-cli-1'), 'sess-cli-1');
  // The same id via matchLiveSession is impossible once the launch is newer than the row:
  const viaMatch = hermes.matchLiveSession({
    cwd: 'D:\\Projekte\\demo', sinceMs: Date.now() + 3600_000, claimed: new Set(),
  });
  assert.strictEqual(viaMatch, null, 'correlation cannot find it — which is exactly why liveRefFor exists');
});

test('liveRefFor: an id the store does not know claims nothing', () => {
  useFixture();
  // A NEW session runs under an id we invented; it must fall through to correlation, not claim a row.
  assert.strictEqual(hermes.liveRefFor('7eecde0f-472e-4d37-a901-71a2fbc4bdb5'), null);
  assert.strictEqual(hermes.liveRefFor(null), null);
});

test('liveState: reads busy/idle straight from the session row', () => {
  useFixture();
  assert.strictEqual(hermes.liveState('sess-cli-1'), 'idle', 'a finished session');
  // sess-running has ended_at NULL but its last message is long in the past (fixed fixture epoch),
  // so it reads idle rather than spinning forever — the safety net.
  assert.strictEqual(hermes.liveState('sess-running'), 'idle');
  assert.strictEqual(hermes.liveState('does-not-exist'), null);
});

test('probe reports a clear reason when hermes is not installed', () => {
  const res = hermes.probe();
  assert.strictEqual(typeof res.ok, 'boolean');
  if (!res.ok) assert.match(res.reason, /hermes/i);
});

// #148 — Hermes has no transcript FILE, so two things silently did not work for it: "View messages"
// showed "nothing to show here", and a handoff could not pre-fill the packet the agent had just
// written (the user had to retype it). Its messages are right there in its DB.

test('readMessages hands out the session transcript, in the shape the viewer speaks', () => {
  useFixture();
  const entries = reader.readMessages('sess-cli-1');
  assert.ok(entries.length, 'the DB has the messages');
  for (const e of entries) {
    assert.strictEqual(e.type, 'message');
    assert.ok(e.message && typeof e.message.role === 'string');
    assert.strictEqual(typeof e.message.content, 'string');
  }

  // The handoff extractor must find the last assistant turn in exactly this shape. NOT guarded by an
  // `if` — a fixture without an assistant turn would silently void this test, and this assertion is the
  // whole point: without it, a handoff from Hermes comes up empty and the user retypes the packet.
  const { extractLatestAssistantText } = require('../public/handoff-extract.js');
  const assistants = entries.filter(e => e.message.role === 'assistant');
  assert.ok(assistants.length, 'the fixture must contain an assistant turn');
  assert.strictEqual(
    extractLatestAssistantText(entries),
    assistants[assistants.length - 1].message.content.trim(),
    'the handoff pre-fill reads the packet Hermes wrote',
  );
});

test('readMessages keeps the RECENT end when it has to truncate', () => {
  // Both consumers want the recent end: the handoff reads the newest assistant turn, the viewer scrolls
  // to the bottom. Reading the head would — on exactly the long sessions this feature exists for — serve
  // a stale mid-session turn AS the fresh packet. Silently wrong content is worse than an empty box.
  useFixture();
  const all = reader.readMessages('sess-cli-1');
  assert.ok(all.length >= 2, 'the fixture has enough messages to truncate');

  const tail = reader.readMessages('sess-cli-1', { limit: 1 });
  assert.strictEqual(tail.length, 1);
  assert.strictEqual(tail[0].message.content, all[all.length - 1].message.content,
    'the LAST message survives the cap, not the first');
});

test('readMessages returns only real turns, and never throws on a missing session', () => {
  useFixture();
  assert.deepStrictEqual(reader.readMessages('does-not-exist'), []);
  for (const e of reader.readMessages('sess-cli-1')) {
    assert.ok(['user', 'assistant'].includes(e.message.role),
      'tool scaffolding and compacted rows are not conversation turns');
  }
});

test('a Hermes session reports its user-message count (the handoff nudge depends on it)', () => {
  // It used to be hardcoded to 0, so session-health could never recommend a handoff for Hermes — the one
  // backend whose handoff support the readMessages hook was built for.
  useFixture();
  const row = reader.parseSession({ kind: 'db', sessionId: 'sess-cli-1' });
  assert.ok(row.userMessageCount >= 1, 'counted from the messages table, not assumed');
});

// --- #159: the metrics buckets Hermes feeds into the Stats charts.

test('metrics: message counts are exact per bucket, tokens ride on the last active one', () => {
  useFixture();
  const h = reader.discoverSessions().find(x => x.sessionId === 'sess-cli-1');
  const row = reader.parseSession(h);
  const buckets = row.dailyMetrics;
  assert.ok(buckets.length, 'a session produces buckets');

  // Hermes' message rows carry timestamps but NO per-message tokens (those live on the session row),
  // so this is the honest split: the counts are exact, the totals are booked on the last active bucket.
  assert.strictEqual(buckets.reduce((n, b) => n + b.messageCount, 0), 5, 'every message counted once');
  assert.strictEqual(buckets.reduce((n, b) => n + b.inputTokens, 0), 1000, 'the session total, booked once');
  assert.strictEqual(buckets.filter(b => b.inputTokens > 0).length, 1, 'on exactly ONE bucket, not spread');

  // ...and that bucket is the one its last message fell in.
  const carrier = buckets.find(b => b.inputTokens > 0);
  const lastMessageAt = new Date((T0 + 590) * 1000);
  assert.strictEqual(carrier.hour, lastMessageAt.getHours(), 'the LOCAL hour of the last message');
  assert.strictEqual(carrier.estimatedCostUsd, 0.0123, 'the money rides along with the tokens');
});

test('metrics: every bucket knows its local hour', () => {
  useFixture();
  const h = reader.discoverSessions().find(x => x.sessionId === 'sess-cli-1');
  for (const b of reader.parseSession(h).dailyMetrics) {
    assert.strictEqual(Number.isInteger(b.hour), true);
    assert.ok(b.hour >= 0 && b.hour <= 23, `hour ${b.hour} is a real hour`);
  }
});

// A ZERO estimate means Hermes had no price for that model — NOT that the work was free. Stored as 0 it
// would draw a $0.00 bar in the cost chart, which is a fact nobody stated. Found on real data.
test('metrics: a zero estimate is "no figure", not "it was free"', () => {
  useFixture();
  const h = reader.discoverSessions().find(x => x.sessionId === 'sess-zero-cost');
  const row = reader.parseSession(h);
  assert.strictEqual(row.estimatedCostUsd, 0, 'the session row reports what Hermes said');
  for (const b of row.dailyMetrics) {
    assert.strictEqual(b.estimatedCostUsd, null, 'but no bucket claims a price');
    assert.strictEqual(b.actualCostUsd, null);
  }
  // The tokens are real and must still be counted — it is the MONEY that is unknown, not the work.
  assert.strictEqual(row.dailyMetrics.reduce((n, b) => n + b.inputTokens, 0), 400);
});

test('metrics: a settled cost survives, including a settled zero', () => {
  useFixture();
  const h = reader.discoverSessions().find(x => x.sessionId === 'sess-cli-2');
  const carrier = reader.parseSession(h).dailyMetrics.find(b => b.inputTokens > 0);
  assert.strictEqual(carrier.estimatedCostUsd, 0.004);
  assert.strictEqual(carrier.actualCostUsd, 0.0038, 'the settled figure is its own number');
});

// --- the hot path: what busy/idle and the change gate actually cost (#155) -------------------------

test('the change marker is unchanged by the grouped join (an unchanged session must not re-parse)', () => {
  useFixture();
  // The marker used to come from a correlated MAX(messages.timestamp) subquery — one scan of `messages`
  // per session, on every WAL commit. It is a grouped join now. Same string, or every session in the
  // cache would re-read itself once for nothing.
  const db = reader.openDb();
  const expected = new Map(db.all(
    "SELECT s.id AS id, COALESCE(s.ended_at, 0) || ':' ||"
    + ' COALESCE((SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id), 0) || \':\' ||'
    + " COALESCE(s.message_count, 0) AS marker FROM sessions s WHERE s.source = 'cli'"
  ).map(r => [String(r.id), String(r.marker)]));
  db.close();

  const handles = reader.discoverSessions();
  assert.strictEqual(handles.length, expected.size);
  for (const h of handles) {
    assert.strictEqual(h.marker, expected.get(h.sessionId), `marker for ${h.sessionId} must be byte-identical`);
  }
  // The row the rewrite could actually break: no messages (so the grouped join has no partner) and a
  // null message_count. A LEFT JOIN yields NULL there, exactly as the subquery did.
  const empty = handles.find(h => h.sessionId === 'sess-no-messages');
  assert.strictEqual(empty.marker, '0:0:0', 'no end, no message, no count — and still a stable marker');
});

test('readLiveState answers busy/idle from two columns, and agrees with the full parse', () => {
  useFixture();
  // liveState fires on every WAL commit. It used to go through parseSession — 500 messages of text, a
  // metrics GROUP BY and a user-message count, all thrown away to learn whether the turn is running.
  for (const id of ['sess-cli-1', 'sess-running']) {
    const full = reader.parseSession({ kind: 'db', sessionId: id });
    const live = reader.readLiveState(id);
    assert.strictEqual(live.isEnded, full.isEnded, `${id}: same end state`);
    assert.strictEqual(live.lastActivityMs, full.lastActivityMs, `${id}: same last activity`);
  }
  assert.strictEqual(reader.readLiveState('sess-running').isEnded, false, 'a running turn has no ended_at');
  assert.strictEqual(reader.readLiveState('no-such-session'), null, 'an unknown id is no evidence, not idle');
  assert.strictEqual(reader.readLiveState(null), null);
});

test('readLiveState degrades to null when the store is unreachable', () => {
  hermes.setHome(path.join(os.tmpdir(), 'hermes-gone-' + process.pid));
  assert.strictEqual(reader.readLiveState('sess-cli-1'), null);
});
