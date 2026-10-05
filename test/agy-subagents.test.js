'use strict';
// agy subagent conversations (#739). Every subagent agy spawns writes a conversation `.db` of its own and
// inherits the parent's workspace, so before #739 each one stood in the sidebar as a top-level session the
// user never started. The child names its root in its own `gen_metadata` blobs (`parent_cascade_id`,
// `root_cascade_id`); a root may carry `root_cascade_id` naming ITSELF (measured — half the keyed files
// were such roots), so the self-reference check matters. These tests pin what the parser and the
// descriptor do with that: a root stays top-level, a child is keyed under its root with the shared
// subagent fields, and anything missing or garbled degrades to a top-level row without throwing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const parser = require('../src/backends/agy/parser');
const agy = require('../src/backends/agy');
const { parseBackendSessions } = require('../src/backends/parse');

// Synthetic conversation ids — nothing here is from a real store.
const ROOT = '00000000-0000-4000-8000-0000000000a1';
const CHILD = '00000000-0000-4000-8000-0000000000b2';
const GRANDCHILD = '00000000-0000-4000-8000-0000000000c3';

function varint(n) {
  const bytes = [];
  let v = n;
  while (v > 0x7f) { bytes.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
  bytes.push(v);
  return Buffer.from(bytes);
}

function lenField(fieldNo, body) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  return Buffer.concat([Buffer.from([(fieldNo << 3) | 2]), varint(b.length), b]);
}

/** One key/value entry the way the recon string dump shows it: the key, a tag, the 0x24 length, the id. */
function cascadeEntry(key, id) {
  return lenField(1, Buffer.concat([lenField(1, key), lenField(2, id)]));
}

function metadataBlob(uri) {
  return lenField(1, lenField(1, uri));
}

/**
 * A minimal conversation DB. `gen` is a list of gen_metadata blobs; `gen: null` leaves the table out
 * entirely (a store without it must still parse).
 */
function makeDb(dbPath, { gen = [], prompt = 'hello world' } = {}) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB, metadata BLOB);
    CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
  `);
  db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run('main', metadataBlob('file:///X:/proj'));
  const step = db.prepare('INSERT INTO steps (idx, step_type, step_payload, metadata) VALUES (?, ?, ?, ?)');
  step.run(0, 14, lenField(1, prompt), null);
  step.run(1, 15, lenField(1, 'Done, here is the answer.'), null);
  if (gen) {
    db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
    const ins = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
    gen.forEach((blob, i) => ins.run(i, blob));
  }
  db.close();
}

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sub-'));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const parse = (p) => parser.parseSession({ kind: 'file', path: p });

test('agy subagents: a root conversation stays a top-level session', () => {
  withStore((dir) => {
    const p = path.join(dir, `${ROOT}.db`);
    makeDb(p, { gen: [lenField(1, 'Gemini 3.5 Flash (Medium)')] });
    const row = parse(p);
    assert.equal(row.sessionId, ROOT, 'a root keeps its conversation id');
    assert.equal(row.parentSessionId, null);
    assert.equal(row.agentId, null);
  });
});

test('agy subagents: a child is keyed under its root with the shared subagent fields', () => {
  withStore((dir) => {
    const p = path.join(dir, `${CHILD}.db`);
    makeDb(p, { gen: [Buffer.concat([cascadeEntry('parent_cascade_id', ROOT), cascadeEntry('root_cascade_id', ROOT)])], prompt: 'research the parser' });
    const row = parse(p);
    assert.equal(row.parentSessionId, ROOT, 'nests under the conversation that spawned it');
    assert.equal(row.agentId, CHILD, 'the agent id is the child\'s own conversation id');
    assert.equal(row.sessionId, agy.subagentSessionId(ROOT, CHILD), 'the row id is the descriptor\'s own minting');
    assert.equal(row.sessionId, `agy-sub:${ROOT}:${CHILD}`);
    assert.ok(!row.sessionId.startsWith('sub:'), 'never in Claude\'s id space — the cache is one table');
    assert.equal(row.subagentType, null, 'no measured agent-type field — unknown, not guessed');
    assert.equal(row.firstPrompt, 'research the parser', 'the rest of the row is read as before');
  });
});

test('agy subagents: a grandchild nests under the ROOT, not under its immediate parent', () => {
  withStore((dir) => {
    const p = path.join(dir, `${GRANDCHILD}.db`);
    // The sidebar nests one level under a top-level row; a grandchild hung under a child row would be
    // an orphan at the top level.
    makeDb(p, { gen: [Buffer.concat([cascadeEntry('parent_cascade_id', CHILD), cascadeEntry('root_cascade_id', ROOT)])] });
    const row = parse(p);
    assert.equal(row.parentSessionId, ROOT);
    assert.equal(row.agentId, GRANDCHILD);
  });
});

test('agy subagents: only a parent link (no root key) still nests under that parent', () => {
  withStore((dir) => {
    const p = path.join(dir, `${CHILD}.db`);
    makeDb(p, { gen: [lenField(1, 'noise'), cascadeEntry('parent_cascade_id', ROOT)] });
    assert.equal(parse(p).parentSessionId, ROOT);
  });
});

test('agy subagents: missing or garbled metadata degrades to a top-level row without throwing', () => {
  const cases = [
    { name: 'no gen_metadata table', gen: null },
    { name: 'an empty gen_metadata table', gen: [] },
    { name: 'random bytes', gen: [Buffer.from([0xff, 0x00, 0x13, 0x88, 0x0a, 0x7f, 0xfe])] },
    { name: 'the key with no id after it', gen: [lenField(1, 'parent_cascade_id')] },
    { name: 'the key with a truncated id', gen: [cascadeEntry('parent_cascade_id', ROOT.slice(0, 20))] },
    { name: 'the key with a non-uuid value', gen: [cascadeEntry('parent_cascade_id', 'not-a-conversation-id-at-all-xxxxxxx')] },
    { name: 'a link that names the conversation itself', gen: [cascadeEntry('parent_cascade_id', CHILD), cascadeEntry('root_cascade_id', CHILD)] },
    // A root that records only `root_cascade_id`, pointing at itself, is still a root — and so in any case.
    { name: 'only root_cascade_id, naming itself', gen: [cascadeEntry('root_cascade_id', CHILD)] },
    { name: 'only root_cascade_id, naming itself in upper case', gen: [cascadeEntry('root_cascade_id', CHILD.toUpperCase())] },
  ];
  for (const c of cases) {
    withStore((dir) => {
      const p = path.join(dir, `${CHILD}.db`);
      makeDb(p, { gen: c.gen });
      let row;
      assert.doesNotThrow(() => { row = parse(p); }, c.name);
      assert.ok(row, `${c.name}: still a row`);
      assert.equal(row.sessionId, CHILD, `${c.name}: top-level id`);
      assert.equal(row.parentSessionId, null, `${c.name}: no parent`);
    });
  }
  // A NULL blob in the column is a read the parser must survive too.
  withStore((dir) => {
    const p = path.join(dir, `${CHILD}.db`);
    makeDb(p, { gen: [] });
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(p);
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, null);
    db.close();
    assert.equal(parse(p).parentSessionId, null);
  });
});

test('agy subagents: findCascadeIds reads both keys, and nothing from a blob without them', () => {
  const blob = Buffer.concat([cascadeEntry('parent_cascade_id', CHILD), cascadeEntry('root_cascade_id', ROOT)]);
  assert.deepEqual(parser.findCascadeIds(blob), { parent: CHILD, root: ROOT });
  assert.deepEqual(parser.findCascadeIds(lenField(1, 'Gemini 3.5 Flash (Medium)')), { parent: null, root: null });
  assert.deepEqual(parser.findCascadeIds(null), { parent: null, root: null });
});

test('agy subagents: the descriptor implements the whole seam, and declines the live drive', () => {
  assert.equal(agy.supportsSubagents, true);
  assert.equal(agy.listSubagents(ROOT, { folderPath: os.tmpdir() }), null, 'no watcher drives agy\'s store — nothing to watch');
  assert.equal(agy.subagentMeta(ROOT, CHILD), null, 'no measured agent type or description');
  assert.equal(agy.capabilities.subagentSessions.state, 'limited');
});

test('agy subagents: a subagent row id maps back to its conversation for resume, transcript and live ref', () => {
  const subId = agy.subagentSessionId(ROOT, CHILD);
  assert.equal(parser.conversationIdOf(subId), CHILD);
  assert.equal(parser.conversationIdOf(ROOT), ROOT, 'a plain id passes through');
  assert.deepEqual(agy.buildLaunch({ cwd: '/p', resume: true, sessionId: subId, options: {} }).args, ['--conversation', CHILD]);

  withStore((dir) => {
    makeDb(path.join(dir, `${ROOT}.db`));
    makeDb(path.join(dir, `${CHILD}.db`), { gen: [cascadeEntry('root_cascade_id', ROOT)], prompt: 'child prompt' });
    agy.setRoot(dir);
    try {
      assert.equal(agy.liveRefFor(subId), path.join(dir, `${CHILD}.db`));
      const msgs = agy.readMessages(subId);
      assert.equal(msgs.length, 2, 'the export reads the child\'s own conversation');
      assert.equal(msgs[0].message.content, 'child prompt');
    } finally {
      agy.setRoot(null);
    }
  });
});

test('agy subagents: a subagent conversation is never paired with a launch (matchLiveSession)', () => {
  withStore((dir) => {
    // The child is written FIRST, so it is the oldest record born after the spawn — exactly the one the
    // oldest-wins correlation would take if it were allowed to.
    makeDb(path.join(dir, `${CHILD}.db`), { gen: [cascadeEntry('root_cascade_id', ROOT)] });
    makeDb(path.join(dir, `${ROOT}.db`));
    agy.setRoot(dir);
    try {
      const m = agy.matchLiveSession({ cwd: 'X:\\proj', sinceMs: 0 });
      assert.ok(m, 'the root is still found');
      assert.equal(m.sessionId, ROOT);
    } finally {
      agy.setRoot(null);
    }
  });
});

test('agy subagents: a file re-read under a new id reports the old id as replaced (scan reconcile)', () => {
  withStore((dir) => {
    const p = path.join(dir, `${CHILD}.db`);
    makeDb(p, { gen: [cascadeEntry('root_cascade_id', ROOT)] });
    // The row an older parser cached for this file: the bare conversation id, as a top-level session.
    const stale = { sessionId: CHILD, filePath: p, modified: 'older', parserVersion: 3 };
    const reply = parseBackendSessions(agy, {
      handles: [{ kind: 'file', path: p }],
      cachedByFile: new Map([[p, stale]]),
      cachedById: new Map([[CHILD, stale]]),
    });
    assert.equal(reply.sessions.length, 1);
    assert.equal(reply.sessions[0].sessionId, agy.subagentSessionId(ROOT, CHILD));
    assert.deepEqual(reply.replaced, [{ sessionId: CHILD, replacedBy: agy.subagentSessionId(ROOT, CHILD) }],
      'the old top-level row is named for deletion, with the row that replaces it');

    // Same id as cached: nothing is replaced.
    const current = { sessionId: agy.subagentSessionId(ROOT, CHILD), filePath: p, modified: 'older', parserVersion: 3 };
    const again = parseBackendSessions(agy, {
      handles: [{ kind: 'file', path: p }],
      cachedByFile: new Map([[p, current]]),
      cachedById: new Map(),
    });
    assert.deepEqual(again.replaced, []);
  });
});

// The sidebar nests by EXACT id, and a root's row id is its `.db` basename as the filesystem spells it.
// A link spelled in another case must still land on that row — without re-keying the root.
test('agy subagents: a child nests under its root whatever case the link is spelled in', () => {
  const cases = [
    { name: 'upper-case link, lower-case root file', rootFile: ROOT, link: ROOT.toUpperCase() },
    { name: 'lower-case link, upper-case root file', rootFile: ROOT.toUpperCase(), link: ROOT },
  ];
  for (const c of cases) {
    withStore((dir) => {
      makeDb(path.join(dir, `${c.rootFile}.db`));
      const p = path.join(dir, `${CHILD}.db`);
      makeDb(p, { gen: [cascadeEntry('root_cascade_id', c.link)] });
      const root = parse(path.join(dir, `${c.rootFile}.db`));
      const child = parse(p);
      assert.equal(root.sessionId, c.rootFile, `${c.name}: the root keeps its own spelling`);
      assert.equal(child.parentSessionId, root.sessionId, `${c.name}: the child names the root's row id exactly`);
      assert.equal(child.sessionId, agy.subagentSessionId(root.sessionId, CHILD));
    });
  }
  // The root is not in the store (deleted): the link is used as written, never dropped.
  withStore((dir) => {
    const p = path.join(dir, `${CHILD}.db`);
    makeDb(p, { gen: [cascadeEntry('root_cascade_id', ROOT.toUpperCase())] });
    assert.equal(parse(p).parentSessionId, ROOT.toUpperCase());
  });
});
