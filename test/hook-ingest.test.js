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
