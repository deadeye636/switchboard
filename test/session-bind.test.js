'use strict';
// #303: a terminal whose CLI moves to a new session id IN PLACE — an `/exit` and relaunch, an auto-update
// restart, anything that is not one of the three births the transcript detector knows (fork, plan-accept,
// clear). Before this the live row simply kept the dead id: the sidebar showed the abandoned session as
// Working (OSC titles still arrive over the PTY), the hook fast-path stopped finding the row, attention
// signals landed on an id with no row, and every LATER transition of that terminal was poisoned too.
//
// The fix is not a better heuristic — it is a signal. The per-spawn settings file re-states "terminal
// <tag> is running session <id>" on ordinary turn events, so both halves are facts: the tag is ours, the
// id is the CLI's. See backends/claude/live-binding.js for what was measured about which events fire.
//
// Driven through the REAL pieces: the ingest that receives the POST and the re-key that acts on it.

const test = require('node:test');
const assert = require('node:assert/strict');

const transitions = require('../src/session/session-transitions');
const hooks = require('../src/app/hooks');
const claims = require('../src/session/clear-claims');

function setup({ claim = null } = {}) {
  const activeSessions = new Map();
  const sent = [];
  const rekeyedMcp = [];
  const rekeyedBackend = [];
  const lineage = [];
  const released = [];
  transitions.init({
    PROJECTS_DIR: require('node:os').tmpdir(),
    activeSessions,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } }),
    log: { info() {}, warn() {}, debug() {}, error() {} },
    rekeyMcpServer: (from, to) => rekeyedMcp.push([from, to]),
    rekeySessionBackend: (from, to) => rekeyedBackend.push([from, to]),
    recordLineage: (childId, folder, parentId, kind) => lineage.push([childId, folder, parentId, kind]),
    getClearClaim: ({ liveTags } = {}) => (claim && (!liveTags || liveTags.includes(claim.tag)) ? claim : null),
    releaseClearClaim: (tag) => released.push(tag),
  });
  const add = (id, over = {}) => activeSessions.set(id, {
    exited: false, isPlainTerminal: false, projectFolder: 'proj',
    knownJsonlFiles: new Set(), knownSubagents: new Map(), ...over,
  });
  return { activeSessions, sent, rekeyedMcp, rekeyedBackend, lineage, released, add };
}

test('THE #303 CASE: the terminal reports a new id and the live row follows it', () => {
  const s = setup();
  s.add('dead', { _terminalTag: 'tag-term' });

  const moved = transitions.adoptSessionId('tag-term', 'alive');

  assert.deepEqual({ from: moved.from, to: moved.to }, { from: 'dead', to: 'alive' });
  assert.equal(s.activeSessions.has('alive'), true, 'the row is keyed to what the CLI is actually running');
  assert.equal(s.activeSessions.has('dead'), false, 'the abandoned id is gone');
  assert.equal(s.activeSessions.get('alive').realSessionId, 'alive');
  assert.deepEqual(s.rekeyedMcp, [['dead', 'alive']], 'the MCP server followed');
  assert.deepEqual(s.rekeyedBackend, [['dead', 'alive']], 'the backend overlay followed');
  assert.deepEqual(s.sent.find(([ch]) => ch === 'session-forked'), ['session-forked', 'dead', 'alive']);
});

test('with no claim the lineage kind is "terminal" — no cause was witnessed, so none is claimed', () => {
  const s = setup();
  s.add('dead', { _terminalTag: 'tag-term' });

  transitions.adoptSessionId('tag-term', 'alive');

  assert.deepEqual(s.lineage, [['alive', 'proj', 'dead', 'terminal']],
    'all that was observed is that this PTY ran that session before this one');
});

test('a clear claim for the same terminal names the true parent and the kind', () => {
  // The CLI told us out of band which session it ENDED. That beats "the id we happened to hold the row
  // under", which can be older still if an earlier move was missed.
  const s = setup({ claim: { tag: 'tag-term', sessionId: 'real-parent' } });
  s.add('stale', { _terminalTag: 'tag-term' });

  transitions.adoptSessionId('tag-term', 'child');

  assert.deepEqual(s.lineage, [['child', 'proj', 'real-parent', 'clear']]);
  assert.deepEqual(s.released, ['tag-term'], 'the claim is consumed so it cannot win a second pairing');
});

test('the report is a no-op once the id is current — it is re-stated every single turn', () => {
  const s = setup();
  s.add('same', { _terminalTag: 'tag-term' });

  assert.equal(transitions.adoptSessionId('tag-term', 'same'), null);
  assert.deepEqual(s.rekeyedMcp, [], 'no churn on the ordinary case');
  assert.deepEqual(s.lineage, [], 'and no lineage row per turn');
});

test('two live rows never collapse onto one key', () => {
  // The #223 failure the whole area exists to prevent. A terminal reporting an id another row already
  // holds is not evidence about that other row.
  const s = setup();
  s.add('mine', { _terminalTag: 'tag-a' });
  s.add('theirs', { _terminalTag: 'tag-b' });

  assert.equal(transitions.adoptSessionId('tag-a', 'theirs'), null);
  assert.equal(s.activeSessions.has('mine'), true);
  assert.equal(s.activeSessions.get('theirs')._terminalTag, 'tag-b', 'the other row is untouched');
});

test('an unknown, exited or plain-terminal tag moves nothing', () => {
  const s = setup();
  s.add('gone', { _terminalTag: 'tag-gone', exited: true });
  s.add('shell', { _terminalTag: 'tag-shell', isPlainTerminal: true });

  assert.equal(transitions.adoptSessionId('tag-nobody', 'x'), null, 'a tag we never issued');
  assert.equal(transitions.adoptSessionId('tag-gone', 'x'), null, 'a dead PTY must not be resurrected');
  assert.equal(transitions.adoptSessionId('tag-shell', 'x'), null, 'a plain terminal runs no session');
  assert.deepEqual(s.rekeyedMcp, []);
});

test('a session started before the binding existed carries no tag and cannot be moved', () => {
  const s = setup();
  s.add('old');   // no _terminalTag
  assert.equal(transitions.adoptSessionId(undefined, 'x'), null);
  assert.equal(transitions.adoptSessionId('tag-term', 'x'), null);
  assert.equal(s.activeSessions.has('old'), true);
});

// --- through the ingest, where the trust boundary is ---------------------------------------------------

let _server = null;
function ensureServer() {
  if (_server && _server.listening) return Promise.resolve(_server);
  _server = hooks.startAttentionHookServer();
  return new Promise((resolve) => {
    if (_server.listening) return resolve(_server);
    _server.once('listening', () => resolve(_server));
  });
}
test.after(() => new Promise((resolve) => (_server ? _server.close(resolve) : resolve())));

function post(url, payload, token) {
  const u = new URL(url);
  const req = { method: 'POST', url: u.pathname + u.search, _handlers: {}, on(ev, fn) { this._handlers[ev] = fn; } };
  const res = { writeHead() {}, end() {} };
  hooks.handleHookRequest(req, res, token);
  req._handlers.data?.(JSON.stringify(payload));
  req._handlers.end?.();
}

function ingest() {
  const adopted = [];
  hooks.init({
    getMainWindow: () => null,
    getSetting: () => ({}),
    activeSessions: new Map(),
    indexWorker: { postFile() {} },
    isPackaged: true,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    adoptSessionId: (tag, id) => { adopted.push([tag, id]); return { from: 'old', to: id }; },
  });
  return adopted;
}

test('a UserPromptSubmit POST on the bind path reaches the re-key with tag and id', async () => {
  const adopted = ingest();
  await ensureServer();
  const url = hooks.sessionBindUrl('tag-b');
  assert.ok(url, 'the spawn path needs a URL to hand the backend');
  const token = new URL(url).searchParams.get('t');

  post(url, { session_id: 'B2', hook_event_name: 'UserPromptSubmit' }, token);

  assert.deepEqual(adopted, [['tag-b', 'B2']]);
});

test('a POST with the wrong token moves nothing — every local process can reach this socket', async () => {
  const adopted = ingest();
  await ensureServer();
  const url = hooks.sessionBindUrl('tag-b');
  post(url, { session_id: 'B2', hook_event_name: 'Stop' }, 'not-the-token');
  assert.deepEqual(adopted, [], 'a forged bind would hand a live terminal to a session of the forger\'s choosing');
});

test('the two bind ingests are told apart by PATH, never by payload shape', async () => {
  // They share a socket. A Stop hook also carries a session_id, and a SessionEnd:clear payload posted to
  // the bind path must not be read as "this terminal is now that session" — it says the opposite.
  claims._resetForTests();
  const adopted = ingest();
  await ensureServer();
  const token = new URL(hooks.sessionBindUrl('tag-b')).searchParams.get('t');

  post(hooks.clearBindUrl('tag-b'), { session_id: 'B1', hook_event_name: 'SessionEnd', reason: 'clear' }, token);
  assert.deepEqual(adopted, [], 'a clear POST is a claim, not a binding');
  assert.ok(claims.resolveSingleClaim({ liveTags: ['tag-b'] }), 'and it did land as a claim');

  post(hooks.sessionBindUrl('tag-b'), { session_id: 'B2', hook_event_name: 'Stop' }, token);
  assert.deepEqual(adopted, [['tag-b', 'B2']], 'a bind POST is a binding, not a claim');
});
