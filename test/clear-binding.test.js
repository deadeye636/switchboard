'use strict';
// The clear binding end to end (#223), through the REAL pieces: Claude's per-spawn settings file, the
// hook ingest that receives what the CLI posts, and the resolver that decides whether to re-key.
//
// WHY IT IS WORTH A TEST OF ITS OWN. The headline of #223 is "two live sessions in one folder": the case
// where every folder-local signal fails, and where two earlier attempts (mtime correlation, keystroke
// sniffing) would have re-keyed the WRONG session. So the assertion that matters is not "a claim works"
// but "a claim picks the right terminal out of several, and declines when it genuinely cannot know."
//
// The hook payload used here is the shape MEASURED against the real CLI (v2.1.215): SessionEnd fires with
// reason "clear" and the OLD session id, posted to the per-terminal URL from the settings file we wrote.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hooks = require('../src/app/hooks');
const claims = require('../src/session/clear-claims');
const liveBinding = require('../src/backends/claude/live-binding');
const { resolveClearParent } = require('../src/session/session-lineage');

function makeCtx() {
  const logged = [];
  hooks.init({
    getMainWindow: () => null,
    getSetting: () => ({}),
    activeSessions: new Map(),
    indexWorker: { postFile() {} },
    isPackaged: true,
    log: { info: (m) => logged.push(m), debug: () => {}, warn: () => {}, error: () => {} },
  });
  return logged;
}

// ONE server for the whole file. The module keeps a single instance and only clears that guard on the
// 'close' event, so starting and closing per test hands the next one a dying socket whose listen callback
// never fires again. The port is only known inside that callback, which is why this awaits it.
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

/** Drive the ingest the way the CLI would: a POST to the binding URL with the hook's JSON body. */
function post(url, payload, token) {
  const u = new URL(url);
  const req = { method: 'POST', url: u.pathname + u.search, _handlers: {}, on(ev, fn) { this._handlers[ev] = fn; } };
  const res = { writeHead() {}, end() {} };
  hooks.handleHookRequest(req, res, token);
  req._handlers.data?.(JSON.stringify(payload));
  req._handlers.end?.();
}

test.beforeEach(() => claims._resetForTests());

test('the settings file Claude gets registers exactly the clear hook, and nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bind-'));
  try {
    const file = liveBinding.writeBindingSettings({ dir, tag: 'tag-1', url: 'http://127.0.0.1:1234/x?t=tok&tag=tag-1' });
    const blob = JSON.parse(fs.readFileSync(file, 'utf8'));

    // Only SessionEnd:clear. This file is handed to a CLI the user did not configure for us — anything
    // more would be Switchboard changing behaviour it was not asked to change.
    assert.deepEqual(Object.keys(blob.hooks), ['SessionEnd']);
    assert.equal(blob.hooks.SessionEnd[0].matcher, 'clear');
    const hook = blob.hooks.SessionEnd[0].hooks[0];
    assert.equal(hook.type, 'http', 'a command hook prints into the session context — measured, and avoided');
    assert.match(hook.url, /tag=tag-1/, 'the tag rides the URL: the payload has no room for it');

    liveBinding.removeBindingSettings(file);
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a SessionEnd:clear POST becomes a claim that re-keys the RIGHT one of three live terminals', async () => {
  makeCtx();
  await ensureServer();
  try {
    const url = hooks.clearBindUrl('tag-b');
    assert.ok(url, 'the spawn path needs a URL to hand the backend');
    const token = new URL(url).searchParams.get('t');

    // What the CLI posts when the user clears terminal B.
    post(url, { session_id: 'B1', hook_event_name: 'SessionEnd', reason: 'clear' }, token);

    // Three sessions live in one folder — the case the whole issue is about.
    const candidates = [
      { id: 'A1', tag: 'tag-a' },
      { id: 'B1', tag: 'tag-b' },
      { id: 'C1', tag: 'tag-c' },
    ];
    const claim = claims.resolveSingleClaim({ liveTags: candidates.map(c => c.tag) });
    assert.ok(claim, 'the POST must have produced a claim');

    const r = resolveClearParent({ candidates, claim });
    assert.equal(r.parentId, 'B1', 'the terminal that cleared is the one that re-keys');
    assert.equal(r.via, 'claim');
  } finally { /* server closed in test.after */ }
});

test('a POST with the wrong token changes nothing — the ingest is reachable by every local process', async () => {
  makeCtx();
  await ensureServer();
  try {
    const url = hooks.clearBindUrl('tag-b');
    post(url, { session_id: 'B1', hook_event_name: 'SessionEnd', reason: 'clear' }, 'not-the-token');
    assert.equal(claims.resolveSingleClaim({ liveTags: ['tag-b'] }), null,
      'a forged claim would re-key a live terminal onto a session of the attacker\'s choosing');
  } finally { /* server closed in test.after */ }
});

test('only reason=clear becomes a claim — a normal session end must not move anything', async () => {
  makeCtx();
  await ensureServer();
  try {
    const url = hooks.clearBindUrl('tag-b');
    const token = new URL(url).searchParams.get('t');
    post(url, { session_id: 'B1', hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }, token);
    assert.equal(claims.resolveSingleClaim({ liveTags: ['tag-b'] }), null);
  } finally { /* server closed in test.after */ }
});

test('two terminals clearing at once stays ambiguous, and the detector still bails', async () => {
  makeCtx();
  await ensureServer();
  try {
    const token = new URL(hooks.clearBindUrl('x')).searchParams.get('t');
    post(hooks.clearBindUrl('tag-a'), { session_id: 'A1', hook_event_name: 'SessionEnd', reason: 'clear' }, token);
    post(hooks.clearBindUrl('tag-b'), { session_id: 'B1', hook_event_name: 'SessionEnd', reason: 'clear' }, token);

    const candidates = [{ id: 'A1', tag: 'tag-a' }, { id: 'B1', tag: 'tag-b' }];
    const claim = claims.resolveSingleClaim({ liveTags: ['tag-a', 'tag-b'] });
    assert.equal(claim, null, 'two claims in the window cannot be told apart');
    assert.equal(resolveClearParent({ candidates, claim }).confidence, 'none', 'so nothing is re-keyed');
  } finally { /* server closed in test.after */ }
});

test('an attention payload on the attention path never becomes a claim', async () => {
  // The two ingests share a socket. Deciding on the PATH (not the payload) is what keeps a Stop hook —
  // which also carries a session_id — from being read as "this terminal cleared".
  makeCtx();
  await ensureServer();
  try {
    const bindUrl = new URL(hooks.clearBindUrl('tag-b'));
    const token = bindUrl.searchParams.get('t');
    const attentionUrl = `http://127.0.0.1:1${hooks.ATTENTION_HOOK_MARK}?t=${token}`;
    post(attentionUrl, { session_id: 'B1', hook_event_name: 'SessionEnd', reason: 'clear' }, token);
    assert.equal(claims.resolveSingleClaim({ liveTags: ['tag-b'] }), null);
  } finally { /* server closed in test.after */ }
});
