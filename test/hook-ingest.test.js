'use strict';
// The hook-ingest server's trust boundary and its reversibility promise (spec 05).
//
// Neither was asserted by anything until app/hooks.js was split out of main.js (#213, extraction 3):
// main.js needs Electron, so nothing could require it, and the ~12 guards that read it did so as SOURCE
// TEXT — which cannot tell you that a POST without the token is actually answered 403, only that a line
// saying so exists. hooks.js requires no Electron (registerIpc takes the ipc object), so the handler can
// be driven here with a fake req/res and no socket.
//
// What is being protected: the server listens on 127.0.0.1, so EVERY local process can reach it. The
// per-run token in the hook URL is the only thing between "Claude Code reports a turn ended" and "any
// local process forges attention signals and forces undebounced reads" (#77).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hooks = require('../src/app/hooks');

const TOKEN = 'a-known-token';

// A fake ServerResponse that records what the handler did to it.
function fakeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(code, headers) { res.statusCode = code; res.headers = headers || null; },
    end(chunk) { res.body = chunk == null ? '' : String(chunk); },
  };
  return res;
}

// A fake IncomingMessage. `body` is delivered on the next tick, the way a real socket would.
function fakeReq(method, url, body) {
  const listeners = {};
  const req = {
    method,
    url,
    on(event, fn) {
      listeners[event] = fn;
      // Once the handler has subscribed to 'end', feed it the body.
      if (event === 'end') {
        queueMicrotask(() => {
          if (body != null && listeners.data) listeners.data(body);
          fn();
        });
      }
      return req;
    },
    destroy() { req.destroyed = true; },
  };
  return req;
}

function makeCtx(over = {}) {
  const sent = [];
  const ctx = {
    sent,
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
    }),
    getSetting: () => ({}),
    activeSessions: new Map(),
    indexWorker: { postFile: () => {} },
    log: { info() {}, warn() {}, error() {} },
    // Default to a packaged build so the write/strip round-trip tests below actually write; the dev-block
    // tests override this to false (#219).
    isPackaged: true,
    ...over,
  };
  hooks.init(ctx);
  return ctx;
}

// Drive the handler and resolve once it has answered.
function post(url, payload, token) {
  const res = fakeRes();
  const req = fakeReq('POST', url, payload == null ? null : JSON.stringify(payload));
  hooks.handleHookRequest(req, res, token);
  return new Promise((resolve) => setTimeout(() => resolve(res), 0));
}

const stopHook = { hook_event_name: 'Notification', matcher: 'permission_prompt', message: 'needs you', session_id: 'sess-1' };

test('a POST with no token is refused — the server is on 127.0.0.1, so anyone local can knock (#77)', async () => {
  const ctx = makeCtx();
  const res = await post('/switchboard-attention-hook', stopHook, TOKEN);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(ctx.sent, [], 'and no attention signal reaches the renderer');
});

test('a POST with the WRONG token is refused', async () => {
  const ctx = makeCtx();
  const res = await post('/switchboard-attention-hook?t=guessed', stopHook, TOKEN);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(ctx.sent, []);
});

test('no token for this run = nothing is accepted, however the URL looks', async () => {
  const ctx = makeCtx();
  const res = await post('/switchboard-attention-hook?t=undefined', stopHook, null);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(ctx.sent, []);
});

test('a POST with the right token is forwarded to the renderer as an attention-signal', async () => {
  const ctx = makeCtx();
  const res = await post(`/switchboard-attention-hook?t=${TOKEN}`, stopHook, TOKEN);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '{}', 'an empty decision object: never block or alter Claude\'s behaviour');
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].channel, 'attention-signal');
  assert.equal(ctx.sent[0].payload.sessionId, 'sess-1');
  assert.equal(ctx.sent[0].payload.kind, 'needs-attention');
  assert.equal(ctx.sent[0].payload.source, 'hook');
});

test('a GET is not a hook', async () => {
  makeCtx();
  const res = fakeRes();
  hooks.handleHookRequest(fakeReq('GET', `/switchboard-attention-hook?t=${TOKEN}`), res, TOKEN);
  assert.equal(res.statusCode, 405);
});

test('a bad payload answers 200 anyway — Claude Code blocks on this response', async () => {
  const ctx = makeCtx();
  const res = fakeRes();
  const req = fakeReq('POST', `/switchboard-attention-hook?t=${TOKEN}`, 'not json at all');
  hooks.handleHookRequest(req, res, TOKEN);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(ctx.sent, [], 'nothing is forwarded, but the turn is not held up either');
});

test('the fast-path reindex only fires for a session we know (#60)', async () => {
  const posted = [];
  const activeSessions = new Map([['sess-1', { projectFolder: 'proj', realSessionId: 'sess-1' }]]);
  makeCtx({ activeSessions, indexWorker: { postFile: (folder, rel, opts) => posted.push({ folder, rel, opts }) } });

  await post(`/switchboard-attention-hook?t=${TOKEN}`, stopHook, TOKEN);
  assert.deepEqual(posted, [{ folder: 'proj', rel: 'proj/sess-1.jsonl', opts: { immediate: true } }],
    'immediate: the rename shows the moment the turn ends, not several seconds later');

  posted.length = 0;
  await post(`/switchboard-attention-hook?t=${TOKEN}`, { ...stopHook, session_id: 'unknown' }, TOKEN);
  assert.deepEqual(posted, [], 'an unknown session is not a reason to hit the index');
});

// --- the reversibility promise: switching the feature off must leave the user's own hooks alone -------

test('stripSwitchboardHooks removes only our own handlers', () => {
  const settings = {
    hooks: {
      Stop: [
        { matcher: '', hooks: [{ type: 'http', url: `http://127.0.0.1:1234${hooks.ATTENTION_HOOK_MARK}?t=x` }] },
        { matcher: '', hooks: [{ type: 'command', command: 'echo the user\'s own hook' }] },
      ],
    },
  };
  const out = hooks.stripSwitchboardHooks(settings);

  assert.equal(out.hooks.Stop.length, 1);
  assert.equal(out.hooks.Stop[0].hooks[0].command, 'echo the user\'s own hook');
});

test('stripSwitchboardHooks prunes what it empties, and leaves settings with no hooks at all', () => {
  const settings = {
    otherSetting: 'untouched',
    hooks: {
      Stop: [{ matcher: '', hooks: [{ type: 'http', url: `http://127.0.0.1:1234${hooks.ATTENTION_HOOK_MARK}` }] }],
    },
  };
  const out = hooks.stripSwitchboardHooks(settings);

  assert.equal(out.hooks, undefined, 'an empty hooks object is removed, not left as {}');
  assert.equal(out.otherSetting, 'untouched');
});

test('stripSwitchboardHooks survives a settings.json that has no hooks, or junk where hooks should be', () => {
  assert.deepEqual(hooks.stripSwitchboardHooks({}), {});
  assert.deepEqual(hooks.stripSwitchboardHooks({ hooks: 'nonsense' }), { hooks: 'nonsense' });
  assert.equal(hooks.stripSwitchboardHooks(null), null);
});

// --- dev builds do not touch the shared ~/.claude/settings.json (#219) ----------------------------
//
// A dev run is force-killed by `npm run stop:dev` (no before-quit), so a hook it wrote would be left
// behind on a dead port; and because the sentinel carries no instance marker, a dev enable/quit strips the
// INSTALLED app's live hook too. So an unpackaged build is a no-op on the whole write/strip path unless
// SWITCHBOARD_DEV_ATTENTION_HOOK=1 is set. These tests pin both halves.

test('a dev build does not write to the shared settings.json even when the feature is on', async () => {
  const prev = process.env.SWITCHBOARD_DEV_ATTENTION_HOOK;
  delete process.env.SWITCHBOARD_DEV_ATTENTION_HOOK;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-hooks-dev-'));
  const settingsFile = path.join(dir, 'settings.json');
  const before = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'user-own' }] }] } };
  fs.writeFileSync(settingsFile, JSON.stringify(before));
  let server = null;
  try {
    makeCtx({ isPackaged: false, getSetting: () => ({ attentionHooks: true }), claudeSettingsPath: settingsFile });
    server = hooks.startAttentionHookServer();
    // #223 changed one half of this on purpose: the SERVER now starts in a dev build too. It is a
    // loopback listener that touches nothing outside this process, and the per-spawn clear binding posts
    // to it through the backend's OWN settings file — so it has to work everywhere the app runs.
    //
    // What #219 promised is the OTHER half, and it is unchanged and still asserted below: the user's
    // shared ~/.claude/settings.json is never written by a dev build. That file is the shared state; the
    // socket never was.
    assert.notEqual(server, null, 'the loopback server starts — it is not what #219 blocked');
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), before,
      'the shared settings.json is byte-for-byte untouched');
  } finally {
    // Close the one we started and WAIT for it: the module keeps a single server and only clears that
    // guard on the 'close' event, so a later test asking for one would otherwise be handed this dying
    // socket and wait forever for a listen callback that never comes again.
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.SWITCHBOARD_DEV_ATTENTION_HOOK; else process.env.SWITCHBOARD_DEV_ATTENTION_HOOK = prev;
  }
});

test('a dev build\'s removeClaudeAttentionHook leaves the installed app\'s hook alone', () => {
  const prev = process.env.SWITCHBOARD_DEV_ATTENTION_HOOK;
  delete process.env.SWITCHBOARD_DEV_ATTENTION_HOOK;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-hooks-dev-'));
  const settingsFile = path.join(dir, 'settings.json');
  // A Switchboard hook the INSTALLED app wrote. A dev quit must not strip it (#219).
  const installed = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'http', url: `http://127.0.0.1:9999${hooks.ATTENTION_HOOK_MARK}?t=x` }] }] } };
  fs.writeFileSync(settingsFile, JSON.stringify(installed));
  try {
    makeCtx({ isPackaged: false, claudeSettingsPath: settingsFile });
    hooks.removeClaudeAttentionHook();
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), installed,
      'the installed app\'s hook survives a dev build\'s removal');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.SWITCHBOARD_DEV_ATTENTION_HOOK; else process.env.SWITCHBOARD_DEV_ATTENTION_HOOK = prev;
  }
});

test('SWITCHBOARD_DEV_ATTENTION_HOOK=1 re-enables the write path in a dev build', async (t) => {
  const prev = process.env.SWITCHBOARD_DEV_ATTENTION_HOOK;
  process.env.SWITCHBOARD_DEV_ATTENTION_HOOK = '1';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-hooks-dev-'));
  const settingsFile = path.join(dir, 'settings.json');
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.SWITCHBOARD_DEV_ATTENTION_HOOK; else process.env.SWITCHBOARD_DEV_ATTENTION_HOOK = prev;
  });
  makeCtx({ isPackaged: false, getSetting: () => ({ attentionHooks: true }), claudeSettingsPath: settingsFile });
  const server = hooks.startAttentionHookServer();
  assert.ok(server, 'opted in, the server starts');
  t.after(() => new Promise((r) => server.close(r)));
  await new Promise((r) => server.once('listening', r));
  await new Promise((r) => setTimeout(r, 0));
  const written = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.ok(JSON.stringify(written.hooks).includes(hooks.ATTENTION_HOOK_MARK), 'the hook is written when opted in');
});

// --- the whole thing, wired the way main.js wires it ---------------------------------------------
//
// Everything above drives handleHookRequest with an explicit token, which is a call shape NOTHING in
// production uses: the real server calls it with two arguments and lets the default pick up this run's
// token. So none of it would notice that wiring breaking — and if it broke, every real hook POST would
// answer 403 forever while the suite stayed green. This test closes that hole: one real server, one real
// socket, one real settings.json round-trip, and the token is never passed in — it is read back out of
// the file the app itself wrote, exactly as Claude Code would.
//
// It writes to a temp directory via ctx.claudeSettingsPath. It must never touch the real one: that is a
// developer's own Claude config, with their own hooks in it.
test('end to end: the server writes its own URL, and only that URL is accepted', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-hooks-'));
  const settingsFile = path.join(dir, 'settings.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // A hook the user already had. It must still be there at the end.
  fs.writeFileSync(settingsFile, JSON.stringify({
    hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'the-user-own-hook' }] }] },
  }));

  const ctx = makeCtx({ getSetting: () => ({ attentionHooks: true }), claudeSettingsPath: settingsFile });
  const server = hooks.startAttentionHookServer();
  t.after(() => new Promise((r) => server.close(r)));
  await new Promise((r) => server.once('listening', r));
  await new Promise((r) => setTimeout(r, 0));   // let the listen callback's write land

  // What the app told Claude Code to call. This is the only place the token exists.
  const written = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const url = written.hooks.Stop.find((g) => g.hooks[0].type === 'http').hooks[0].url;
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/switchboard-attention-hook\?t=.+/);
  assert.ok(written.hooks.Stop.some((g) => g.hooks[0].command === 'the-user-own-hook'),
    'writing ours does not disturb the user\'s own');
  for (const event of ['Notification', 'Stop', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop']) {
    assert.ok(JSON.stringify(written.hooks[event]).includes(hooks.ATTENTION_HOOK_MARK), `${event} registered`);
  }

  const post = (target, payload) => fetch(target, { method: 'POST', body: JSON.stringify(payload) });

  // The real URL, through a real socket, hitting the real 2-argument call: this is the only test that
  // proves the running server actually accepts what it advertised.
  const ok = await post(url, stopHook);
  assert.equal(ok.status, 200);
  assert.equal(ctx.sent.length, 1, 'and the signal reached the renderer');
  assert.equal(ctx.sent[0].payload.sessionId, 'sess-1');

  // Same socket, token stripped off: refused.
  const forged = await post(url.split('?')[0], stopHook);
  assert.equal(forged.status, 403);
  assert.equal(ctx.sent.length, 1, 'still one — a local process cannot forge a signal (#77)');

  // And switching the feature off leaves the user with exactly what they started with.
  hooks.removeClaudeAttentionHook();
  const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(after, {
    hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'the-user-own-hook' }] }] },
  }, 'byte for byte what was there before it was ever enabled');
});

// --- #395: the same signal, recorded by the window that renders the session -----------------------

test('the hook signal is also echoed to the window that renders the session', async () => {
  const echoed = [];
  const ctx = makeCtx({ sendTimelineSignal: (sessionId, signal) => echoed.push({ sessionId, signal }) });
  await post(`/switchboard-attention-hook?t=${TOKEN}`, stopHook, TOKEN);

  assert.equal(ctx.sent.length, 1, 'main still hears it exactly once');
  assert.deepEqual(echoed, [{
    sessionId: 'sess-1',
    signal: { kind: 'needs-attention', reason: ctx.sent[0].payload.reason, source: 'hook' },
  }]);
});

test('the echo does not depend on the main window being alive', async () => {
  // A window of its own outlives a closed main window on macOS, and its recap should not have a hole
  // shaped like that.
  const echoed = [];
  makeCtx({
    getMainWindow: () => null,
    sendTimelineSignal: (sessionId, signal) => echoed.push({ sessionId, signal }),
  });
  await post(`/switchboard-attention-hook?t=${TOKEN}`, stopHook, TOKEN);

  assert.equal(echoed.length, 1);
});

test('a ctx without the echo is not an error', async () => {
  // An older wiring, and the shape every existing test in this file uses.
  const ctx = makeCtx();
  const res = await post(`/switchboard-attention-hook?t=${TOKEN}`, stopHook, TOKEN);
  assert.equal(res.statusCode, 200);
  assert.equal(ctx.sent.length, 1);
});

// --- #529: a CLI blocked on its own prompt is waiting, not working ------------------------------------
//
// Pi 0.84.4 separates active agent work from time spent on a blocking `ctx.ui` prompt. Before those
// events the two were one state and the session sat on "Working" while it held an unanswered question:
// the row said the agent was busy and the inbox said nothing at all. So a `waiting` binding has to do
// BOTH halves — take the row out of Working and raise the attention flag — and doing only one is the
// state this exists to remove.
//
// The route is deliberately backend-blind: it trusts the per-spawn URL and token, and the vocabulary is
// neutral, so this is asserted with no backend in sight.

const BIND_URL = '/switchboard-session-bind?t=' + TOKEN + '&tag=terminal-tag-1';

function bindCtx() {
  return makeCtx({ adoptSessionId: () => null, log: { info() {}, warn() {}, debug() {}, error() {} } });
}

test('a waiting binding takes the row out of Working AND raises attention (#529)', async () => {
  const ctx = bindCtx();
  const res = await post(BIND_URL, { session_id: 'sess-9', kind: 'waiting', prompt_kind: 'confirm' }, TOKEN);
  assert.equal(res.statusCode, 200);

  const busy = ctx.sent.filter(s => s.channel === 'cli-busy-state');
  assert.equal(busy.length, 1, 'the busy edge was sent');
  assert.deepEqual(busy[0].payload, 'sess-9');

  const attention = ctx.sent.filter(s => s.channel === 'attention-signal');
  assert.equal(attention.length, 1, 'and so was the attention signal');
  assert.equal(attention[0].payload.kind, 'needs-attention');
  assert.equal(attention[0].payload.reason, 'Waiting for you to confirm');
  assert.equal(attention[0].payload.source, 'bind');
});

test('the busy edge of a waiting binding is FALSE, not the kind (#529)', async () => {
  // `cli-busy-state` takes (sessionId, busy, exact) as separate arguments, so the fake records only the
  // first. Driving the real send through a recorder that keeps all of them is the only way to assert the
  // half that would leave the row spinning behind the inbox flag.
  const args = [];
  const ctx = makeCtx({
    adoptSessionId: () => null,
    log: { info() {}, warn() {}, debug() {}, error() {} },
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (...all) => args.push(all) },
    }),
  });
  await post(BIND_URL, { session_id: 'sess-9', kind: 'waiting', prompt_kind: 'input' }, TOKEN);

  const busy = args.find(a => a[0] === 'cli-busy-state');
  assert.deepEqual(busy, ['cli-busy-state', 'sess-9', false, true], 'not busy, and exactly so');
  assert.ok(ctx);
});

test('an ordinary busy binding is unchanged and raises no attention (#529)', async () => {
  const ctx = bindCtx();
  await post(BIND_URL, { session_id: 'sess-9', kind: 'busy' }, TOKEN);

  assert.equal(ctx.sent.filter(s => s.channel === 'cli-busy-state').length, 1);
  assert.deepEqual(ctx.sent.filter(s => s.channel === 'attention-signal'), [], 'busy is not attention');
});

test('a binding with no lifecycle kind still binds and sends nothing (#529)', async () => {
  // `session_start` and `session_info_changed` post the id alone — they say where the terminal is, not
  // what it is doing, and inventing an edge for them would flip the row on every rename.
  const ctx = bindCtx();
  await post(BIND_URL, { session_id: 'sess-9' }, TOKEN);
  assert.deepEqual(ctx.sent, []);
});
