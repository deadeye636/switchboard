'use strict';
// #864 part 2 — ingest and live pairing for a Hermes 0.23 (schema 33) store: `created_source` against
// the flipping `source`, empty launch stubs, the turn ledger (`session_admissions` / `session_turn_leases`)
// as the busy signal, and where a tab goes when its conversation moves to a child row.
//
// The DDL is partial on purpose (the columns the reader asks for), like hermes-store-v33.test.js. The shapes
// follow what a real 0.23.1 store was MEASURED to hold: new ids `local-<64 hex>`, `source` flipping to
// 'local' after the first turn, a stub row at message_count 0, an admission `started` while a turn runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* older Node: the file skips */ }

const reader = require('../src/backends/hermes/reader');
const hermes = require('../src/backends/hermes');
const { deriveState } = require('../src/backends/hermes/state');

const SKIP = { skip: !DatabaseSync && 'node:sqlite is not available in this runtime' };
const WINDOWS = { skip: process.platform !== 'win32' && 'a directory differing only in case is one directory on Windows only' };

const T0 = 1780000000;

const DDL = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, source TEXT, created_source TEXT, started_at REAL, ended_at REAL, end_reason TEXT,
  message_count INTEGER DEFAULT 0, cwd TEXT, title TEXT, parent_session_id TEXT, model_config TEXT
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL,
  finish_reason TEXT, active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0, display_kind TEXT
);
CREATE TABLE session_admissions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, target_session_id TEXT NOT NULL, status TEXT NOT NULL, outcome TEXT,
  owner_epoch INTEGER, generation INTEGER
);
CREATE TABLE session_turn_leases (
  conversation_id TEXT PRIMARY KEY, holder TEXT, acquired_at REAL NOT NULL, expires_at REAL NOT NULL
);`;

function makeStore(fill, { ledger = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-v33-live-'));
  const db = new DatabaseSync(path.join(dir, 'state.db'));
  db.exec(ledger ? DDL : DDL.slice(0, DDL.indexOf('CREATE TABLE session_admissions')));
  const session = (id, o = {}) => db.prepare(
    'INSERT INTO sessions (id, source, created_source, started_at, ended_at, end_reason, message_count, cwd, parent_session_id, model_config)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, o.source ?? 'cli', o.created ?? 'cli', o.started ?? T0, o.ended ?? null, o.reason ?? null,
    o.mc ?? 0, o.cwd ?? 'proj', o.parent ?? null, o.config ?? null);
  const message = (sid, role, finish, t, extra = {}) => db.prepare(
    'INSERT INTO messages (session_id, role, content, timestamp, finish_reason, display_kind) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(sid, role, extra.content ?? 'text', t, finish, extra.kind ?? null);
  // A turn that STARTED carries owner_epoch and generation for good (a `started` row must, and `terminal` keeps
  // them); a queued prompt cancelled before it ran never had either.
  const admission = (sid, status, o = {}) => db.prepare(
    'INSERT INTO session_admissions (target_session_id, status, outcome, owner_epoch, generation) VALUES (?, ?, ?, ?, ?)'
  ).run(sid, status, o.outcome ?? null, o.gen === null ? null : (o.gen ?? (status === 'queued' ? null : 1)),
    o.gen === null ? null : (o.gen ?? (status === 'queued' ? null : 1)));
  const lease = (sid, acquired, expires) => db.prepare('INSERT INTO session_turn_leases VALUES (?, ?, ?, ?)').run(sid, 'h', acquired, expires);
  fill({ session, message, admission, lease });
  db.close();
  return dir;
}

function withStore(dir, fn) {
  const saved = process.env.SWITCHBOARD_STORE_HERMES;
  process.env.SWITCHBOARD_STORE_HERMES = dir;
  reader.setHome(null);
  reader._clearLiveStateCache();
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.SWITCHBOARD_STORE_HERMES;
    else process.env.SWITCHBOARD_STORE_HERMES = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ids = (list) => list.map(h => h.sessionId).sort();

test('ingest: created_source names the terminal surfaces, so a session whose source flipped to local stays listed', SKIP, () => {
  const dir = makeStore(({ session }) => {
    session('flipped', { source: 'local', created: 'cli', mc: 2 });
    session('tui-row', { source: 'local', created: 'tui', mc: 2 });
    session('gateway', { source: 'telegram', created: 'telegram', mc: 2 });
    session('flipped-gateway', { source: 'local', created: 'telegram', mc: 2 });
    session('cron', { source: 'cron', created: 'cron', mc: 2 });
    session('recovered-row', { source: 'recovered', created: 'recovered', mc: 2 });
    session('imported', { source: 'claude-code', created: 'claude-code', mc: 2 });
    session('delegated', { source: 'subagent', created: 'cli', mc: 2, config: '{"_delegate_from": "flipped"}' });
  });
  withStore(dir, () => {
    assert.deepEqual(ids(reader.discoverSessions()),
      ['flipped', 'imported', 'recovered-row', 'tui-row']);
  });
});

test('ingest: an empty launch stub is not listed; one with a message or an admitted turn is', SKIP, () => {
  const dir = makeStore(({ session, admission }) => {
    session('stub');                                   // opened, never used: message_count 0, no admission
    session('first-prompt-pending', { mc: 0 });        // a turn was admitted, its transcript row not yet written
    admission('first-prompt-pending', 'started');
    session('used', { mc: 2 });
  });
  withStore(dir, () => {
    assert.deepEqual(ids(reader.discoverSessions()), ['first-prompt-pending', 'used']);
    assert.equal(reader.discoverSessions({ includeAll: true }).length, 3, 'includeAll lifts the filters');
  });
});

test('ingest: a 0.21 store without created_source keeps the old source allow-list and lists a stub', SKIP, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-v21-live-'));
  const db = new DatabaseSync(path.join(dir, 'state.db'));
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL, ended_at REAL, message_count INTEGER, cwd TEXT, title TEXT)');
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL, finish_reason TEXT)');
  db.exec(`INSERT INTO sessions (id, source, started_at, message_count) VALUES ('a', 'cli', ${T0}, 0), ('b', 'telegram', ${T0}, 3)`);
  db.close();
  withStore(dir, () => {
    assert.deepEqual(ids(reader.discoverSessions()), ['a']);
  });
});

test('live candidates: by created_source, open rows only, never a child row', SKIP, () => {
  const dir = makeStore(({ session }) => {
    session('fresh-cli', { started: T0 + 10 });
    session('fresh-tui', { created: 'tui', source: 'tui', started: T0 + 11 });
    session('flipped', { source: 'local', started: T0 + 12 });
    session('ended', { ended: T0 + 50, reason: 'cli_close', started: T0 + 13 });
    session('branch-child', { parent: 'flipped', started: T0 + 14 });
    session('gateway', { created: 'telegram', source: 'telegram', started: T0 + 15 });
    session('recovered', { created: 'recovered', source: 'recovered', started: T0 + 16 });
  });
  withStore(dir, () => {
    assert.deepEqual(reader.listLiveCandidates().map(c => c.sessionId).sort(), ['flipped', 'fresh-cli', 'fresh-tui']);
  });
});

test('matchLiveSession: takes the earliest open terminal row in the directory, whatever its delay after the spawn', SKIP, () => {
  const spawnMs = (T0 - 100) * 1000;
  const dir = makeStore(({ session }) => {
    session('cold', { started: T0 + 18, cwd: 'proj' });          // 18 s after a spawn at T0 (a cold gateway)
    session('other-project', { started: T0 + 1, cwd: 'elsewhere' });
  });
  withStore(dir, () => {
    const hit = hermes.matchLiveSession({ cwd: 'proj', sinceMs: spawnMs, claimed: new Set() });
    assert.equal(hit.sessionId, 'cold');
    assert.ok(Number.isFinite(hit.bornMs));
    assert.equal(hermes.matchLiveSession({ cwd: 'proj', sinceMs: spawnMs, claimed: new Set(['cold']) }), null);
  });
});

test('matchLiveSession: a cwd differing only in case is the same directory (Windows)', WINDOWS, () => {
  const dir = makeStore(({ session }) => { session('r', { cwd: 'Z:\\nowhere-example\\Demo', started: T0 + 4 }); });
  withStore(dir, () => {
    const hit = hermes.matchLiveSession({ cwd: 'z:\\nowhere-example\\demo', sinceMs: 0, claimed: new Set() });
    assert.equal(hit && hit.sessionId, 'r');
  });
});

test('followLiveSession: a branch moves the tab to the child; the parent stays listed', SKIP, () => {
  const dir = makeStore(({ session }) => {
    session('parent', { mc: 4, ended: T0 + 100, reason: 'branched' });
    session('child', { mc: 4, parent: 'parent', started: T0 + 100.6, config: '{"_branched_from": "parent"}' });
  });
  withStore(dir, () => {
    assert.deepEqual(hermes.followLiveSession('parent', { sinceMs: T0 * 1000 }),
      { sessionId: 'child', ref: 'child', reason: 'fork' });
    assert.equal(hermes.followLiveSession('child'), null, 'a row that has not moved on has nowhere to go');
    assert.deepEqual(ids(reader.discoverSessions()), ['child', 'parent']);
  });
});

test('followLiveSession: a branch made before this tab opened is not its move', SKIP, () => {
  const dir = makeStore(({ session }) => {
    session('parent', { mc: 4, ended: T0 + 100, reason: 'branched' });
    session('child', { mc: 4, parent: 'parent', started: T0 + 100 });
  });
  withStore(dir, () => {
    assert.equal(hermes.followLiveSession('parent', { sinceMs: (T0 + 500) * 1000 }), null);
  });
});

test('followLiveSession: a compression chain is followed to its tip, whenever the tab opened (resume)', SKIP, () => {
  const dir = makeStore(({ session }) => {
    session('root', { mc: 9, ended: T0 + 10, reason: 'compression' });
    session('mid', { mc: 5, parent: 'root', started: T0 + 10, ended: T0 + 20, reason: 'compression' });
    session('tip', { mc: 3, parent: 'mid', started: T0 + 20 });
    session('delegate', { mc: 1, parent: 'root', started: T0 + 11, config: '{"_delegate_from": "root"}' });
  });
  withStore(dir, () => {
    assert.deepEqual(hermes.followLiveSession('root', { sinceMs: (T0 + 9999) * 1000 }),
      { sessionId: 'tip', ref: 'tip', reason: 'adopted' });
  });
});

test('followLiveSession: a graceful exit is not a move', SKIP, () => {
  const dir = makeStore(({ session }) => {
    session('closed', { mc: 4, ended: T0 + 100, reason: 'cli_close' });
    session('stranger', { mc: 4, parent: 'closed', started: T0 + 101 });
  });
  withStore(dir, () => { assert.equal(hermes.followLiveSession('closed'), null); });
});

// --- busy / idle from the turn ledger ---

test('busy/idle: an open admission is the busy signal, a terminal one is idle', SKIP, () => {
  const NOW = (T0 + 60) * 1000;
  const dir = makeStore(({ session, message, admission }) => {
    session('s', { mc: 2 });
    message('s', 'user', null, T0 + 50);
    message('s', 'assistant', 'stop', T0 + 55);          // the last row says "answered" ...
    admission('s', 'started');                           // ... but the runtime has admitted another turn
    session('t', { mc: 2 });
    message('t', 'user', null, T0 + 50);                  // the last row is an unanswered prompt ...
    admission('t', 'terminal');                          // ... but the ledger says the turn is over
  });
  withStore(dir, () => {
    const s = reader.readLiveState('s');
    assert.equal(s.hasLedger, true);
    assert.equal(s.admission, 'started');
    assert.equal(deriveState(s, NOW), 'busy');
    assert.equal(deriveState(reader.readLiveState('t'), NOW), 'idle');
  });
});

test('busy/idle: a queued admission is busy; unknown is not', SKIP, () => {
  const NOW = (T0 + 60) * 1000;
  const dir = makeStore(({ session, message, admission }) => {
    session('q', { mc: 1 }); message('q', 'user', null, T0 + 50); admission('q', 'queued');
    session('u', { mc: 1 }); message('u', 'user', null, T0 + 50); admission('u', 'unknown');
  });
  withStore(dir, () => {
    assert.equal(deriveState(reader.readLiveState('q'), NOW), 'busy');
    assert.equal(deriveState(reader.readLiveState('u'), NOW), 'idle');
  });
});

test('busy/idle: an unexpired lease keeps a turn busy past the quiet window; an expired one does not', SKIP, () => {
  const dir = makeStore(({ session, message, admission, lease }) => {
    session('leased', { mc: 1 }); message('leased', 'user', null, T0); admission('leased', 'started');
    lease('leased', T0 + 1, T0 + 301);
    session('lapsed', { mc: 1 }); message('lapsed', 'user', null, T0); admission('lapsed', 'terminal');
    lease('lapsed', T0 + 1, T0 + 301);
  });
  withStore(dir, () => {
    const farLater = (T0 + 250) * 1000;                  // past the 3 minute window, lease still valid
    assert.equal(deriveState(reader.readLiveState('leased'), farLater), 'busy');
    assert.equal(deriveState(reader.readLiveState('lapsed'), (T0 + 400) * 1000), 'idle');
    // A crash that left the admission `started` with no lease heals through the ordinary ceiling.
    const stuck = { hasLedger: true, admission: 'started', leaseExpiresMs: 0, lastActivityMs: T0 * 1000 };
    assert.equal(deriveState(stuck, (T0 + 16 * 60) * 1000, { lastOutputMs: (T0 + 16 * 60) * 1000 }), 'idle');
  });
});

test('busy/idle: a ghost row (no messages, no admission) is idle', SKIP, () => {
  const dir = makeStore(({ session }) => { session('ghost'); });
  withStore(dir, () => {
    assert.equal(deriveState(reader.readLiveState('ghost'), (T0 + 5) * 1000), 'idle');
  });
});

test('busy/idle: ended_at left from an earlier exit does not hide a resumed turn (-r does not clear it)', SKIP, () => {
  const dir = makeStore(({ session, message, admission }) => {
    session('resumed', { mc: 3, ended: T0 + 10, reason: 'cli_close' });
    message('resumed', 'user', null, T0 + 100);
    admission('resumed', 'started');
    session('done', { mc: 3, ended: T0 + 100, reason: 'cli_close' });
    message('done', 'user', null, T0 + 50);
    message('done', 'assistant', null, T0 + 60);
    admission('done', 'started');
  });
  withStore(dir, () => {
    const NOW = (T0 + 105) * 1000;
    assert.equal(deriveState(reader.readLiveState('resumed'), NOW), 'busy');
    assert.equal(deriveState(reader.readLiveState('done'), NOW), 'idle', 'nothing happened since the end');
  });
});

test('busy/idle without a ledger: the hidden interrupt placeholder ends the turn, as failed_turn does', SKIP, () => {
  const dir = makeStore(({ session, message }) => {
    session('s', { mc: 2 });
    message('s', 'user', null, T0 + 10);
    message('s', 'assistant', null, T0 + 12, { content: '', kind: 'hidden' });
  }, { ledger: false });
  withStore(dir, () => {
    const row = reader.readLiveState('s');
    assert.equal(row.hasLedger, false);
    assert.equal(row.lastFinishReason, 'interrupted');
    assert.equal(deriveState(row, (T0 + 13) * 1000), 'idle');
  });
});

// --- the follow rules are Hermes' own (hermes_state_compression.py `_CHAIN_STEP_SQL`) ---

test('followLiveSession: a branch or reset sibling of the continuation is not the continuation, however open or new', SKIP, () => {
  const dir = makeStore(({ session }) => {
    session('root', { mc: 9, ended: T0 + 10, reason: 'compression' });
    session('cont', { mc: 3, parent: 'root', started: T0 + 10 });
    session('branchy', { mc: 3, parent: 'root', started: T0 + 30, config: '{"_branched_from": "somewhere"}' });
    session('resety', { mc: 3, parent: 'root', started: T0 + 40, config: '{"_reset_from": "root"}' });
    session('tooly', { mc: 3, parent: 'root', started: T0 + 50, source: 'tool', created: 'tool' });
  });
  withStore(dir, () => {
    assert.equal(hermes.followLiveSession('root').sessionId, 'cont');
  });
});

test('followLiveSession: among continuations one that itself ended by compression comes first, then an open one, then a closed one', SKIP, () => {
  const dir = makeStore(({ session }) => {
    session('root', { mc: 9, ended: T0 + 10, reason: 'compression' });
    session('mid', { mc: 5, parent: 'root', started: T0 + 10, ended: T0 + 20, reason: 'compression' });
    session('open-newer', { mc: 2, parent: 'root', started: T0 + 50 });
    session('closed-newest', { mc: 2, parent: 'root', started: T0 + 60, ended: T0 + 70, reason: 'cli_close' });
    session('tip', { mc: 3, parent: 'mid', started: T0 + 20 });
  });
  withStore(dir, () => {
    assert.equal(hermes.followLiveSession('root').sessionId, 'tip', 'the chain goes on through mid');
  });
  const dir2 = makeStore(({ session }) => {
    session('root', { mc: 9, ended: T0 + 10, reason: 'compression' });
    session('closed', { mc: 2, parent: 'root', started: T0 + 60, ended: T0 + 70, reason: 'cli_close' });
    session('open', { mc: 2, parent: 'root', started: T0 + 10 });
  });
  withStore(dir2, () => {
    assert.equal(hermes.followLiveSession('root').sessionId, 'open');
  });
});

test('followLiveSession: a branch is a child that carries the marker or started after the parent ended as branched', SKIP, () => {
  const dir = makeStore(({ session }) => {
    session('parent', { mc: 4, ended: T0 + 100, reason: 'branched' });
    session('earlier-child', { mc: 4, parent: 'parent', started: T0 + 50 });          // no marker, born before the end
    session('child', { mc: 4, parent: 'parent', started: T0 + 100.6 });
  });
  withStore(dir, () => {
    assert.equal(hermes.followLiveSession('parent', { sinceMs: T0 * 1000 }).sessionId, 'child');
  });
});

// --- the ledger: Hermes counts any queued / started row, minus what a later STARTED turn's end supersedes ---

test('busy/idle: an older admission a crash left started, below a later turn that started and ended, is not running', SKIP, () => {
  const dir = makeStore(({ session, message, admission }) => {
    session('s', { mc: 2 });
    message('s', 'user', null, T0 + 50);
    admission('s', 'started', { gen: 1 });                          // never closed out
    admission('s', 'terminal', { gen: 2, outcome: 'completed' });   // the next turn ran to its end
  });
  withStore(dir, () => {
    const row = reader.readLiveState('s');
    assert.equal(row.admission, null);
    assert.equal(deriveState(row, (T0 + 60) * 1000), 'idle');
  });
});

test('busy/idle: a queued prompt cancelled above a started turn that still runs leaves the session busy', SKIP, () => {
  const dir = makeStore(({ session, message, admission }) => {
    session('s', { mc: 2 });
    message('s', 'user', null, T0 + 50);
    admission('s', 'started', { gen: 1 });                          // running
    admission('s', 'terminal', { gen: null, outcome: 'cancelled' }); // queued behind it, cancelled: never started
  });
  withStore(dir, () => {
    const row = reader.readLiveState('s');
    assert.equal(row.admission, 'started');
    assert.equal(deriveState(row, (T0 + 60) * 1000), 'busy');
  });
});

test('busy/idle: a queued prompt behind a running turn, and a finished turn below a queued one, are busy', SKIP, () => {
  const dir = makeStore(({ session, message, admission }) => {
    session('behind', { mc: 1 }); message('behind', 'user', null, T0 + 50);
    admission('behind', 'started', { gen: 1 }); admission('behind', 'queued');
    session('next', { mc: 1 }); message('next', 'user', null, T0 + 50);
    admission('next', 'terminal', { gen: 1, outcome: 'completed' }); admission('next', 'queued');
  });
  withStore(dir, () => {
    assert.equal(deriveState(reader.readLiveState('behind'), (T0 + 60) * 1000), 'busy');
    assert.equal(reader.readLiveState('next').admission, 'queued');
    assert.equal(deriveState(reader.readLiveState('next'), (T0 + 60) * 1000), 'busy');
  });
});

test('a model_config that is not JSON neither throws nor hides the row, in ingest or in the follow', SKIP, () => {
  const dir = makeStore(({ session }) => {
    session('broken', { mc: 2, config: 'not json at all' });
    session('root', { mc: 5, ended: T0 + 10, reason: 'compression', config: '{broken' });
    session('cont', { mc: 3, parent: 'root', started: T0 + 11, config: '{"unrelated": 1}' });
  });
  withStore(dir, () => {
    assert.deepEqual(ids(reader.discoverSessions()), ['broken', 'cont', 'root']);
    assert.equal(hermes.followLiveSession('root').sessionId, 'cont');
  });
});

test('/new is a known gap: a tab on a row ended as new_session is not moved to a parentless row', SKIP, () => {
  const dir = makeStore(({ session }) => {
    session('old', { mc: 4, ended: T0 + 100, reason: 'new_session', started: T0 + 5 });
    session('stranger', { started: T0 + 101, cwd: 'proj' });
  });
  withStore(dir, () => {
    assert.equal(hermes.followLiveSession('old', { sinceMs: T0 * 1000 }), null,
      'the new row names no parent and no directory, so nothing ties it to this tab');
  });
});

// --- pairing for a /branch made before the first tick ---

test('matchLiveSession: a branch child whose parent was born in the tab\'s window pairs when the parent is unclaimed territory', SKIP, () => {
  const dir = makeStore(({ session }) => {
    session('p', { started: T0 + 5, ended: T0 + 9, reason: 'branched', mc: 2 });
    session('c', { started: T0 + 9.6, parent: 'p', mc: 2 });
  });
  withStore(dir, () => {
    const hit = hermes.matchLiveSession({ cwd: 'proj', sinceMs: T0 * 1000, claimed: new Set() });
    assert.equal(hit && hit.sessionId, 'c');
    assert.equal(hermes.matchLiveSession({ cwd: 'proj', sinceMs: T0 * 1000, claimed: new Set(['p']) }), null,
      'the tab that holds the parent follows it; the child is not a new session');
    assert.equal(hermes.matchLiveSession({ cwd: 'proj', sinceMs: (T0 + 7) * 1000, claimed: new Set() }), null,
      'a parent born before the window is somebody else\'s conversation');
  });
});

test('busy/idle without a ledger: the message-row inference of the earlier schema still decides', SKIP, () => {
  const dir = makeStore(({ session, message }) => {
    session('s', { mc: 1 });
    message('s', 'user', null, T0 + 10);
  }, { ledger: false });
  withStore(dir, () => {
    assert.equal(deriveState(reader.readLiveState('s'), (T0 + 20) * 1000), 'busy');
  });
});

// --- #869: a CLI `/new`, followed through this tab's own breadcrumb ---
// Measured on 0.23.1 with a gateway (2026-11-13, isolated demo, no model turn): the new row is parentless with cwd NULL,
// the old empty row is deleted, and `terminal-sessions/term_session_id-switchboard-<tag>` is rewritten with the new id.
const identity = require('../src/backends/hermes/terminal-identity');
const TAG = '6b6d0d9e-a85f-4a9f-9dcf-ad2f7e2b7039';
function crumb(dir, sessionId, tag = TAG) {
  const d = path.join(dir, 'terminal-sessions');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, identity.terminalIdFor(tag, 'win32')), JSON.stringify({ session_id: sessionId, cwd: 'proj', ts: T0 }));
  reader._clearLiveStateCache();   // a rewrite within one millisecond keeps mtime and maybe size: ask afresh
}
// The follow reads the breadcrumb only where the spawn set an identity, which is Windows; elsewhere it is not asked.
const WIN_ONLY = { skip: (!DatabaseSync && 'node:sqlite is not available in this runtime') || (process.platform !== 'win32' && 'the breadcrumb identity is set on Windows only') };

test('terminal identity: the variable Hermes reads first, its file name, and the multiplexers ahead of it blanked', () => {
  assert.equal(identity.terminalIdFor(TAG, 'win32'), 'term_session_id-switchboard-' + TAG);
  assert.equal(identity.terminalIdFor('a/b c', 'win32'), 'term_session_id-switchboard-a-b-c', 'sanitized like Hermes does');
  assert.equal(identity.terminalIdFor('', 'win32'), null);
  assert.equal(identity.terminalIdFor(TAG, 'linux'), null, 'no identity set, nothing to look for');
  const env = identity.terminalEnv(TAG, 'win32');
  assert.equal(env.TERM_SESSION_ID, 'switchboard-' + TAG);
  for (const v of ['ZELLIJ_PANE_ID', 'TMUX_PANE', 'KITTY_WINDOW_ID', 'WEZTERM_PANE']) assert.equal(env[v], '', v);
  assert.deepEqual(identity.terminalEnv(TAG, 'linux'), {}, 'a tty names the breadcrumb there, so nothing is set');
  assert.deepEqual(identity.terminalEnv('', 'win32'), {});
  assert.deepEqual(hermes.buildLaunch({ cwd: 'proj', terminalTag: TAG }).env, identity.terminalEnv(TAG));
});

test('followLiveSession /new: the empty old row is gone, the breadcrumb names the new parentless row', WIN_ONLY, () => {
  const dir = makeStore(({ session }) => {
    session('fresh', { mc: 0, cwd: null, started: T0 + 50 });
    session('elsewhere', { mc: 0, cwd: null, started: T0 + 51 });
  });
  crumb(dir, 'fresh');
  withStore(dir, () => {
    assert.deepEqual(hermes.followLiveSession('gone', { sinceMs: T0 * 1000, terminalTag: TAG }),
      { sessionId: 'fresh', ref: 'fresh', reason: 'clear' });
    assert.equal(hermes.followLiveSession('gone', { sinceMs: T0 * 1000 }), null, 'no tag, no follow');
    assert.equal(hermes.followLiveSession('gone', { sinceMs: T0 * 1000, terminalTag: 'another-tab' }), null,
      'another tab\'s breadcrumb is not read');
  });
});

test('followLiveSession /new: an old row that ended as new_session is followed; any other end is not', WIN_ONLY, () => {
  const dir = makeStore(({ session }) => {
    session('old', { mc: 4, ended: T0 + 100, reason: 'new_session' });
    session('new', { mc: 0, cwd: null, started: T0 + 100.2 });
    session('quit', { mc: 4, ended: T0 + 100, reason: 'cli_close' });
  });
  crumb(dir, 'new');
  withStore(dir, () => {
    assert.deepEqual(hermes.followLiveSession('old', { sinceMs: T0 * 1000, terminalTag: TAG }),
      { sessionId: 'new', ref: 'new', reason: 'clear' });
    assert.equal(hermes.followLiveSession('quit', { sinceMs: T0 * 1000, terminalTag: TAG }), null);
    assert.equal(hermes.followLiveSession('new', { sinceMs: T0 * 1000, terminalTag: TAG }), null, 'already there');
  });
});

test('followLiveSession /new: a child row, a row older than the tab or than the old end is never the move', WIN_ONLY, () => {
  const dir = makeStore(({ session }) => {
    session('old', { mc: 4, ended: T0 + 100, reason: 'new_session' });
    session('child', { mc: 1, parent: 'old', started: T0 + 101 });
    session('early', { mc: 1, cwd: null, started: T0 + 10 });
    session('open', { mc: 4 });
    session('after-open', { mc: 0, cwd: null, started: T0 + 200 });
  });
  withStore(dir, () => {
    crumb(dir, 'child');
    assert.equal(hermes.followLiveSession('old', { sinceMs: T0 * 1000, terminalTag: TAG }), null, 'a child is a branch, not /new');
    crumb(dir, 'early');
    assert.equal(hermes.followLiveSession('old', { sinceMs: T0 * 1000, terminalTag: TAG }), null, 'started before the old row ended');
    crumb(dir, 'missing');
    assert.equal(hermes.followLiveSession('old', { sinceMs: T0 * 1000, terminalTag: TAG }), null, 'a row the store does not hold');
    crumb(dir, 'after-open');
    assert.equal(hermes.followLiveSession('open', { sinceMs: T0 * 1000, terminalTag: TAG }), null, 'the old row is still open');
    assert.equal(hermes.followLiveSession('gone', { sinceMs: (T0 + 500) * 1000, terminalTag: TAG }), null,
      'the old row is gone but the new one is older than the tab');
  });
});
