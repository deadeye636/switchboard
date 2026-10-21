'use strict';
// #507 Phase 1 (T5): the project-scoped reader behind the discovery tools. Plain fakes for the cache, the
// meta, the live map and the backends; the real handoffs module over a temp project for the handoff half.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const handoffs = require('../src/app/handoffs');
const { createDiscoveryReader, NO_SUCH_SESSION, NO_SUCH_HANDOFF, UNAVAILABLE } = require('../src/app/discovery-reader');

const log = { info() {}, warn() {}, error() {}, debug() {} };

function tempProject(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initHandoffs(projectPath) {
  handoffs.init({
    backends: { list: () => [] },
    db: {
      getProjectStates: () => new Map([[projectPath, { registered: true }]]),
      getProjectDisplayNames: () => new Map(),
      readLegacyHandoffs: () => [],
      deleteLegacyHandoff() {},
      dropLegacyHandoffTable: () => true,
    },
    log,
    effectiveSettings: () => ({}),
  });
}

function sessionRow(id, projectPath, extra = {}) {
  return {
    sessionId: id, projectPath, backendId: 'alpha', summary: `title ${id}`, firstPrompt: `first ${id}`,
    modified: '2026-10-01T10:00:00.000Z', messageCount: 4, userMessageCount: 2, ...extra,
  };
}

function backendsFake(digests = {}) {
  const make = (id, hook, cap) => ({ id, label: id.toUpperCase(), capabilities: { turnDigest: cap }, readTurnDigest: hook });
  return {
    get: (id) => ({
      alpha: make('alpha', digests.alpha || (async () => ({ messages: [], partial: false })), 'yes'),
      beta: make('beta', digests.beta, 'yes'),
      gamma: make('gamma', digests.gamma, 'yes'),
      nodigest: make('nodigest', undefined, 'no'),
    })[id] || null,
  };
}

function readerFor(project, { rows, meta = new Map(), live = new Map(), digests, caller = null, extra = {} } = {}) {
  return createDiscoveryReader({
    projectPath: project,
    callerSessionId: caller,
    getCachedSessions: () => rows,
    getSessionMeta: () => meta,
    activeSessions: live,
    backends: backendsFake(digests),
    handoffs,
    isForeignNetworkFile: () => false,
    log,
    ...extra,
  });
}

test('lists the project sessions across backends, newest first, without subagent and archived rows', () => {
  const project = tempProject('sb-disc-');
  const other = tempProject('sb-disc-other-');
  const rows = [
    sessionRow('a', project, { backendId: 'alpha', lastEntryAt: '2026-10-01T10:00:00Z' }),
    sessionRow('b', project, { backendId: 'beta', lastEntryAt: '2026-10-03T10:00:00Z' }),
    sessionRow('c', project, { backendId: 'gamma', lastEntryAt: '2026-10-02T10:00:00Z' }),
    sessionRow('sub', project, { parentSessionId: 'a', agentId: 'x' }),
    sessionRow('old', project),
    sessionRow('foreign', other),
  ];
  const meta = new Map([['old', { archived: 1 }], ['c', { name: 'Named by user' }]]);
  const live = new Map([['b', { exited: false }], ['a', { exited: true }]]);
  const res = readerFor(project, { rows, meta, live, caller: 'b' }).listSessions();
  assert.equal(res.ok, true);
  assert.deepEqual(res.sessions.map((s) => s.id), ['b', 'c', 'a']);
  assert.deepEqual(res.sessions.map((s) => s.backend.id), ['beta', 'gamma', 'alpha']);
  assert.equal(res.sessions[0].backend.label, 'BETA');
  assert.deepEqual(res.sessions.map((s) => s.self), [true, false, false]);
  assert.deepEqual(res.sessions.map((s) => s.state), ['running', 'stopped', 'stopped']);
  assert.equal(res.sessions[1].title, 'Named by user');
  assert.equal(res.sessions[0].turns, 2);
  assert.equal(res.sessions[0].messages, 4);
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
});

test('the limit is clamped to its maximum', () => {
  const project = tempProject('sb-disc-limit-');
  const rows = Array.from({ length: 130 }, (_, i) => sessionRow(`s${i}`, project, { lastEntryAt: new Date(1e12 + i * 1000).toISOString() }));
  const reader = readerFor(project, { rows });
  assert.equal(reader.listSessions({ limit: 99999 }).sessions.length, 100);
  assert.equal(reader.listSessions({}).sessions.length, 25);
  assert.equal(reader.listSessions({ limit: 3 }).sessions.length, 3);
  fs.rmSync(project, { recursive: true, force: true });
});

test('a session of another project and an unknown id answer byte-identically', async () => {
  const project = tempProject('sb-disc-scope-');
  const other = tempProject('sb-disc-scope-other-');
  const rows = [sessionRow('mine', project), sessionRow('theirs', other)];
  const reader = readerFor(project, { rows });
  const foreign = await reader.readSession({ sessionId: 'theirs' });
  const missing = await reader.readSession({ sessionId: 'does-not-exist' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, NO_SUCH_SESSION);
  assert.equal(JSON.stringify(foreign), JSON.stringify(missing));
  assert.equal((await reader.readSession({ sessionId: 'mine' })).ok, true);
  // The same for an archived row and a subagent row: absent from the listing, absent from the answer.
  const hidden = readerFor(project, { rows: [sessionRow('arch', project), sessionRow('sub', project, { parentSessionId: 'x' })], meta: new Map([['arch', { archived: 1 }]]) });
  assert.equal(JSON.stringify(await hidden.readSession({ sessionId: 'arch' })), JSON.stringify(missing));
  assert.equal(JSON.stringify(await hidden.readSession({ sessionId: 'sub' })), JSON.stringify(missing));
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
});

test('a reader without a project answers an error and lists nothing', async () => {
  const reader = createDiscoveryReader({ projectPath: '', getCachedSessions: () => [sessionRow('a', '/x')], getSessionMeta: () => new Map(), log });
  assert.equal(reader.listSessions().ok, false);
  assert.equal((await reader.readSession({ sessionId: 'a' })).ok, false);
  assert.equal(reader.listHandoffs().ok, false);
  assert.equal(reader.readHandoff({ id: 'a.md' }).ok, false);
});

test('readSession feeds the backend digest through the turn builder with the caps and surfaces partial and omitted', async () => {
  const project = tempProject('sb-disc-read-');
  const seen = [];
  const messages = [];
  for (let i = 1; i <= 5; i++) {
    messages.push({ role: 'user', text: `question ${i} ` + 'q'.repeat(100), at: `2026-10-0${i}T00:00:00Z` });
    messages.push({ role: 'assistant', text: `answer ${i}`, tools: ['Read'] });
  }
  const digests = { alpha: async (row, opts) => { seen.push({ row, opts }); return { messages, partial: true }; } };
  const reader = readerFor(project, { rows: [sessionRow('s1', project)], digests });
  const res = await reader.readSession({ sessionId: 's1', turns: 2, maxCharsPerTurn: 40 });
  assert.equal(res.ok, true);
  assert.equal(res.available, true);
  assert.equal(res.session.id, 's1');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].row.sessionId, 's1');
  assert.ok(seen[0].opts.maxMessages >= 2 && seen[0].opts.maxMessages <= 400);
  assert.ok(seen[0].opts.signal, 'a timeout signal is passed');
  assert.equal(res.returned, 2);
  assert.equal(res.turns.length, 2);
  assert.equal(res.omitted, 3);
  assert.equal(res.partial, true);
  assert.ok(res.note);
  assert.ok(res.turns.every((t) => t.user.length <= 80), 'each turn text is cut');
  assert.deepEqual(res.turns[1].tools, { Read: 1 });
  // A whole, uncut session says so.
  const whole = readerFor(project, { rows: [sessionRow('s1', project)], digests: { alpha: async () => ({ messages: messages.slice(0, 2), partial: false }) } });
  const wholeRes = await whole.readSession({ sessionId: 's1' });
  assert.equal(wholeRes.partial, false);
  assert.equal(wholeRes.omitted, 0);
  assert.equal(wholeRes.note, undefined);
  fs.rmSync(project, { recursive: true, force: true });
});

test('a backend that declines or whose capability is no answers an honest no-view result', async () => {
  const project = tempProject('sb-disc-no-');
  const rows = [sessionRow('d', project, { backendId: 'nodigest' }), sessionRow('n', project, { backendId: 'beta' }), sessionRow('t', project, { backendId: 'gamma' })];
  const digests = { beta: async () => null, gamma: async () => { throw new Error('boom'); } };
  const reader = readerFor(project, { rows, digests });
  for (const id of ['d', 'n', 't']) {
    const res = await reader.readSession({ sessionId: id });
    assert.equal(res.ok, true, id);
    assert.equal(res.available, false, id);
    assert.ok(res.reason, id);
    assert.equal(res.session.id, id);
    assert.equal(res.turns, undefined);
  }
  fs.rmSync(project, { recursive: true, force: true });
});

test('handoffs are listed from a fresh derivation, newest first, with ids relative to the project', () => {
  const project = tempProject('sb-disc-ho-');
  initHandoffs(project);
  handoffs.saveHandoff({ projectPath: project, label: 'First packet', content: 'one', backendId: 'codex' });
  const reader = readerFor(project, { rows: [] });
  const first = reader.listHandoffs();
  assert.equal(first.ok, true);
  assert.equal(first.handoffs.length, 1);
  assert.match(first.handoffs[0].id, /^\.handoffs\/.+\.md$/);
  assert.equal(first.handoffs[0].title, 'First packet');
  assert.equal(first.handoffs[0].backend, 'codex');
  assert.ok(first.handoffs[0].bytes > 0);
  assert.equal(first.handoffs[0].content, undefined, 'the list carries no text');
  // A file that appears later is in the next listing: nothing is cached.
  fs.writeFileSync(path.join(project, '.handoffs', 'second.md'), '# Second\n\nbody');
  assert.equal(reader.listHandoffs().handoffs.length, 2);
  fs.rmSync(project, { recursive: true, force: true });
});

test('readHandoff refuses every id that is not in the project listing, and reads nothing', () => {
  const project = tempProject('sb-disc-hoid-');
  const outside = tempProject('sb-disc-hoid-out-');
  fs.writeFileSync(path.join(outside, 'secret.md'), '# secret');
  initHandoffs(project);
  handoffs.saveHandoff({ projectPath: project, label: 'Real', content: 'body' });
  fs.writeFileSync(path.join(project, '.handoffs', 'note.txt'), 'not markdown');
  let linked = false;
  try { fs.symlinkSync(path.join(outside, 'secret.md'), path.join(project, '.handoffs', 'link.md')); linked = true; } catch { /* no symlink right on this machine */ }

  const foreignCalls = [];
  const reader = readerFor(project, { rows: [], extra: { isForeignNetworkFile: (p) => { foreignCalls.push(p); return false; } } });
  const bad = [
    '../x.md', '.handoffs/../../x.md', path.join(outside, 'secret.md'), '/etc/passwd.md', 'C:\\x\\y.md', 'C:/x/y.md',
    '.handoffs\\real.md', '\\\\host\\share\\a.md', '//host/share/a.md', '.handoffs/note.txt', '.handoffs/missing.md', '', null, undefined, 42,
  ];
  if (linked) bad.push('.handoffs/link.md');
  for (const id of bad) {
    const res = reader.readHandoff({ id });
    assert.equal(res.ok, false, String(id));
    assert.equal(res.error, NO_SUCH_HANDOFF, String(id));
    assert.equal(res.text, undefined);
  }
  // The real one still reads.
  const id = reader.listHandoffs().handoffs.find((h) => h.title === 'Real').id;
  assert.equal(reader.readHandoff({ id }).ok, true);
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('a network path is refused before the guard or the listing is asked', () => {
  const project = tempProject('sb-disc-net-');
  const calls = [];
  const spy = { getHandoffs: () => { calls.push('list'); return []; }, isAllowedHandoffPath: () => { calls.push('allowed'); return 'x'; } };
  const reader = createDiscoveryReader({
    projectPath: project, handoffs: spy, isForeignNetworkFile: () => true, log,
  });
  const res = reader.readHandoff({ id: '.handoffs/a.md' });
  assert.equal(res.ok, false);
  assert.equal(res.error, NO_SUCH_HANDOFF);
  assert.deepEqual(calls, []);
  fs.rmSync(project, { recursive: true, force: true });
});

test('a handoff above maxChars returns a slice with more, and the next offset returns the rest', () => {
  const project = tempProject('sb-disc-slice-');
  initHandoffs(project);
  const body = 'x'.repeat(40000) + '😀end';
  handoffs.saveHandoff({ projectPath: project, label: 'Big', content: body });
  const reader = readerFor(project, { rows: [] });
  const id = reader.listHandoffs().handoffs[0].id;
  const a = reader.readHandoff({ id, maxChars: 99999 });
  assert.equal(a.ok, true);
  assert.equal(a.returned, 32000, 'clamped to the maximum');
  assert.equal(a.offset, 0);
  assert.equal(a.more, true);
  assert.equal(a.text.length, 32000);
  const b = reader.readHandoff({ id, offset: a.returned, maxChars: 32000 });
  assert.equal(b.more, false);
  assert.equal(b.offset, 32000);
  assert.equal(a.returned + b.returned, a.total);
  assert.ok(b.text.endsWith('😀end\n'));
  assert.ok(!b.text.includes('\uFFFD'), 'no code point is split');
  assert.equal(reader.readHandoff({ id }).returned, 16000, 'the default slice');
  assert.equal(reader.readHandoff({ id, offset: 10 ** 9 }).returned, 0);
  fs.rmSync(project, { recursive: true, force: true });
});

test('a reader missing from the deps logs and answers an error, never an empty list', async () => {
  const project = tempProject('sb-disc-missing-');
  const errors = [];
  const quiet = { ...log, error: (m) => errors.push(m) };
  const reader = createDiscoveryReader({ projectPath: project, log: quiet });
  for (const res of [reader.listSessions(), await reader.readSession({ sessionId: 'a' }), reader.listHandoffs(), reader.readHandoff({ id: 'a.md' })]) {
    assert.equal(res.ok, false);
    assert.equal(res.error, UNAVAILABLE);
    assert.equal(res.sessions, undefined);
    assert.equal(res.handoffs, undefined);
  }
  assert.equal(errors.length, 4);
  // A reader that throws is an error too, and it is logged.
  const warns = [];
  const throwing = createDiscoveryReader({
    projectPath: project, getCachedSessions: () => { throw new Error('db gone'); }, getSessionMeta: () => new Map(), log: { ...log, warn: (m) => warns.push(m) },
  });
  assert.equal(throwing.listSessions().error, UNAVAILABLE);
  assert.equal(warns.length, 1);
  fs.rmSync(project, { recursive: true, force: true });
});

test('the module is db-free and electron-free, and names no backend', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'discovery-reader.js'), 'utf8');
  assert.ok(!/require\(['"]electron['"]\)/.test(src));
  assert.ok(!/require\(['"][^'"]*db\/db['"]\)/.test(src));
  assert.ok(!/['"](claude|codex|pi|hermes|agy)['"]/.test(src));
});
