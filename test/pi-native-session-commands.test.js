'use strict';
// Pi's own session commands in a session with no TUI (#642, #643): `/login`, `/logout`, `/model`, `/thinking`,
// `/compact`, and a line of explanation for the rest of Pi's terminal commands. The section is generated
// TypeScript, so it is compiled with esbuild and RUN against a fake `pi` and a fake login runtime shaped like
// the one measured on Pi 0.84.4 (`ctx.modelRegistry.runtime`). Beside it, the protocol half: the three
// markers the section writes, turned into the app's ops.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const runtimeExtension = require('../src/backends/pi-native/runtime-extension');
const sessionCommands = require('../src/backends/pi-native/session-commands');
const protocol = require('../src/backends/pi-native/rpc-protocol');

// A value built in the vm's realm is not deepStrictEqual to one built here: compare plain copies.
const plain = (v) => JSON.parse(JSON.stringify(v));

// A command's handler returns at once and the command finishes on its own, so each call below is followed by
// a turn of the event loop before anything is asserted.
const settle = () => new Promise((r) => setTimeout(r, 5));

let compiled = null;
function load({ gate = true, pi: extra = {} } = {}) {
  const code = require('esbuild').transformSync(runtimeExtension.extensionSource({ gate }), { loader: 'ts', format: 'cjs', target: 'node20' }).code;
  if (gate) compiled = code;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, JSON, AbortSignal, Symbol, Object, Array, Set, String, Error });
  const commands = {};
  mod.exports.default({ on() {}, appendEntry() {}, registerCommand: (name, def) => { commands[name] = def; }, ...extra });
  return commands;
}

// A command context whose `ui` records what it was asked and answers from a script.
function context({ select = [], input = [], runtime, models, model, idle = true, compact } = {}) {
  const said = [];
  const asked = [];
  const ctx = {
    ui: {
      notify: (text, level) => said.push({ text, level }),
      select: async (title, options, opts) => { asked.push({ kind: 'select', title, options, opts }); const a = select.shift(); return typeof a === 'function' ? a(options) : a; },
      input: async (title, placeholder, opts) => { asked.push({ kind: 'input', title, placeholder, opts }); const a = input.shift(); return typeof a === 'function' ? a(opts) : a; },
    },
    modelRegistry: { runtime, getAvailable: () => models || [] },
    model,
    isIdle: () => idle,
    compact,
  };
  return { ctx, said, asked };
}

function fakeRuntime({ providers, credentials = [], login, logout } = {}) {
  const calls = [];
  return {
    calls,
    getProviders: () => providers || [
      { id: 'anthropic', name: 'Anthropic', auth: { oauth: {}, apiKey: {} } },
      { id: 'openai-codex', name: 'OpenAI Codex', auth: { oauth: {} } },
      { id: 'groq', name: 'Groq', auth: { apiKey: {} } },
    ],
    getProvider: (id) => ({ anthropic: { name: 'Anthropic' } })[id],
    hasConfiguredAuth: (id) => id === 'openai-codex',
    listCredentials: async () => credentials,
    login: async (id, method, interaction) => { calls.push(['login', id, method]); if (login) return login(interaction); return {}; },
    logout: async (id) => { calls.push(['logout', id]); if (logout) return logout(); },
  };
}

test('the section is in the runtime extension with the gate on and off, registered at load', () => {
  for (const gate of [true, false]) {
    const commands = load({ gate });
    for (const name of ['login', 'logout', 'model', 'thinking', 'compact', 'session', 'export', 'copy', 'name', 'reload',
      ...Object.keys(sessionCommands.TUI_ONLY)]) {
      assert.equal(typeof (commands[name] && commands[name].handler), 'function', `/${name} with the gate ${gate ? 'on' : 'off'}`);
    }
  }
  assert.ok(!sessionCommands.TUI_ONLY.login && !sessionCommands.TUI_ONLY.model, 'a command that is built is not also a "not here" line');
});

// Pi answers the `prompt` command only once the handler returned, and the app stops waiting after 20 s — so a
// command holding a question open must not hold its handler.
test('a command waiting on a question has already returned to Pi', async () => {
  let level = 'low';
  const cmds = load({ pi: { getThinkingLevel: () => level, setThinkingLevel: (l) => { level = l; } } });
  let answer;
  const question = new Promise((resolve) => { answer = resolve; });
  const { ctx, said } = context({ select: [() => question] });
  let returned = false;
  await cmds.thinking.handler('', ctx).then(() => { returned = true; });
  assert.equal(returned, true, 'the handler is done while the card is still open');
  assert.equal(said.length, 0);
  answer('high');
  await new Promise((r) => setImmediate(r));
  assert.equal(said[0].text, 'Thinking: high.');
});

test('/login with a subscription: the login page is a link, the pasted URL a question Pi can take back', async () => {
  const cmds = load();
  let dismissedWith = null;
  const rt = fakeRuntime({
    login: async ({ prompt, notify }) => {
      notify({ type: 'auth_url', url: 'https://example.test/authorize?x=1', instructions: 'Complete login in your browser.' });
      const ac = new AbortController();
      const pending = prompt({ type: 'manual_code', message: 'Paste the redirect URL:', placeholder: 'http://localhost:1/callback', signal: ac.signal });
      ac.abort();   // the browser callback won
      await pending.catch((e) => { dismissedWith = e.message; });
      return {};
    },
  });
  const { ctx, said, asked } = context({ runtime: rt, select: ['With a subscription (in the browser)', (opts) => opts.find(o => o.startsWith('Anthropic'))],
    input: [(opts) => new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve(undefined)))] });
  await cmds.login.handler('', ctx); await settle();
  assert.deepEqual(rt.calls, [['login', 'anthropic', 'oauth']]);
  assert.deepEqual(plain(asked[1].options), ['Anthropic', 'OpenAI Codex — logged in'], 'only subscription providers, logged-in ones marked');
  assert.equal(dismissedWith, 'Login cancelled', 'the aborted question rejects, so the flow knows');

  const link = sessionCommands.parseLink(said[0].text);
  assert.deepEqual(link, { text: 'Complete login in your browser.', url: 'https://example.test/authorize?x=1', label: 'Open the login page' });
  const input = sessionCommands.parseAskTitle(asked[2].title);
  assert.equal(input.title, 'Paste the redirect URL:');
  assert.equal(input.secret, false);
  assert.equal(asked[2].placeholder, 'http://localhost:1/callback');
  assert.equal(sessionCommands.parseDismiss(said[1].text), input.token, 'Pi taking the question back is said, naming it');
  assert.match(said[2].text, /^Logged in to Anthropic\./);
});

test('/login with an API key: the field is a secret, the value is handed to Pi and nowhere else', async () => {
  const cmds = load();
  let got = null;
  const rt = fakeRuntime({ login: async ({ prompt }) => { got = await prompt({ type: 'secret', message: 'API key:' }); return {}; } });
  const { ctx, said, asked } = context({ runtime: rt, input: ['  sk-test-123  '] });
  await cmds.login.handler('groq', ctx); await settle();
  assert.deepEqual(rt.calls, [['login', 'groq', 'api_key']], 'one provider, one method: nothing to choose');
  assert.equal(got, 'sk-test-123');
  assert.equal(sessionCommands.parseAskTitle(asked[0].title).secret, true);
  assert.ok(!said.some(s => s.text.includes('sk-test-123')), 'the key is never said back');
  assert.match(said[said.length - 1].text, /^Saved the API key for Groq\./);
});

test('/login: a dismissed question cancels, a failure is said in a line, a filesystem error by its code only', async () => {
  const cmds = load();
  const cancel = context({ runtime: fakeRuntime({ login: async ({ prompt }) => prompt({ type: 'secret', message: 'k' }) }), input: [undefined] });
  await cmds.login.handler('groq', cancel.ctx); await settle();
  assert.equal(cancel.said.pop().text, 'Login to Groq cancelled.');

  const net = context({ runtime: fakeRuntime({ login: async () => { throw new Error('Token exchange failed: 400 invalid_grant'); } }) });
  await cmds.login.handler('groq', net.ctx); await settle();
  assert.equal(net.said.pop().text, 'Login to Groq failed: Token exchange failed: 400 invalid_grant');

  const fsErr = Object.assign(new Error("EACCES: permission denied, open '<home>/.pi/agent/auth.json'"), { code: 'EACCES' });
  const disk = context({ runtime: fakeRuntime({ login: async () => { throw fsErr; } }) });
  await cmds.login.handler('groq', disk.ctx); await settle();
  const line = disk.said.pop().text;
  assert.match(line, /\(EACCES\)/);
  assert.ok(!line.includes('auth.json'), 'the path is not repeated');

  const unknown = context({ runtime: fakeRuntime() });
  await cmds.login.handler('nobody', unknown.ctx); await settle();
  assert.match(unknown.said[0].text, /no provider called nobody/);
});

test('/login and /logout without Pi\'s login runtime say where to log in instead', async () => {
  const cmds = load();
  for (const name of ['login', 'logout']) {
    const { ctx, said } = context({ runtime: undefined });
    await cmds[name].handler('', ctx);
    assert.equal(said[0].level, 'error');
    assert.match(said[0].text, /Pi terminal session/);
  }
});

test('/logout: nothing saved says so, one saved login is removed without a question', async () => {
  const cmds = load();
  const empty = context({ runtime: fakeRuntime() });
  await cmds.logout.handler('', empty.ctx); await settle();
  assert.match(empty.said[0].text, /^Nothing to log out of/);

  const rt = fakeRuntime({ credentials: [{ providerId: 'anthropic', type: 'oauth' }] });
  const one = context({ runtime: rt });
  await cmds.logout.handler('', one.ctx); await settle();
  assert.deepEqual(rt.calls, [['logout', 'anthropic']]);
  assert.equal(one.asked.length, 0);
  assert.equal(one.said[0].text, 'Logged out of Anthropic.');

  const two = fakeRuntime({ credentials: [{ providerId: 'anthropic', type: 'oauth' }, { providerId: 'groq', type: 'api_key' }] });
  const pickOne = context({ runtime: two, select: ['groq (API key)'] });
  await cmds.logout.handler('', pickOne.ctx); await settle();
  assert.deepEqual(two.calls, [['logout', 'groq']]);
  assert.match(pickOne.said[0].text, /^Removed the saved API key for groq\./);
});

test('/model: by name, from a list, per provider when the list is long, and never onto a provider with no login', async () => {
  const set = [];
  let accept = true;
  const cmds = load({ pi: { setModel: async (m) => { set.push(`${m.provider}/${m.id}`); return accept; }, getThinkingLevel: () => 'medium' } });
  const models = [
    { provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT 5.6' },
    { provider: 'anthropic', id: 'claude-opus-5', name: 'Opus 5' },
    { provider: 'anthropic', id: 'claude-sonnet-5', name: 'Sonnet 5' },
  ];
  const direct = context({ models, model: models[0] });
  await cmds.model.handler('anthropic/claude-opus-5', direct.ctx); await settle();
  assert.deepEqual(set, ['anthropic/claude-opus-5']);
  assert.equal(direct.said[0].text, 'Model: anthropic/claude-opus-5 · thinking: medium.');

  const ambiguous = context({ models, model: models[0], select: ['anthropic/claude-sonnet-5'] });
  await cmds.model.handler('anthropic', ambiguous.ctx); await settle();
  assert.deepEqual(plain(ambiguous.asked[0].options), ['anthropic/claude-opus-5', 'anthropic/claude-sonnet-5'], 'only the matches are offered');
  assert.equal(set[1], 'anthropic/claude-sonnet-5');

  const same = context({ models, model: models[0] });
  await cmds.model.handler('gpt-5.6-sol', same.ctx); await settle();
  assert.match(same.said[0].text, /already uses/);
  assert.equal(set.length, 2);

  const many = Array.from({ length: 14 }, (_, i) => ({ provider: i < 7 ? 'a' : 'b', id: `m${i}` }));
  const long = context({ models: many, model: many[0], select: ['b', 'b/m9'] });
  await cmds.model.handler('', long.ctx); await settle();
  assert.deepEqual(plain(long.asked[0].options), ['a (current)', 'b'], 'the provider first');
  assert.equal(long.asked[1].options.length, 7);
  assert.equal(set[2], 'b/m9');

  accept = false;
  const refused = context({ models, model: models[0] });
  await cmds.model.handler('claude-opus-5', refused.ctx); await settle();
  assert.match(refused.said[0].text, /no login for anthropic/);

  const none = context({ models: [] });
  await cmds.model.handler('', none.ctx); await settle();
  assert.match(none.said[0].text, /\/login/);
});

test('/thinking: a level by name or from the list, an unknown one refused, a clamped one said', async () => {
  let level = 'medium';
  let clampTo = null;
  const cmds = load({ pi: { getThinkingLevel: () => level, setThinkingLevel: (l) => { level = clampTo || l; } } });
  const direct = context();
  await cmds.thinking.handler('high', direct.ctx); await settle();
  assert.equal(level, 'high');
  assert.equal(direct.said[0].text, 'Thinking: high.');

  const listed = context({ select: ['low'] });
  await cmds.thinking.handler('', listed.ctx); await settle();
  assert.ok(listed.asked[0].options.includes('high (current)'));
  assert.equal(level, 'low');

  const bad = context();
  await cmds.thinking.handler('ultra', bad.ctx); await settle();
  assert.match(bad.said[0].text, /Unknown thinking level ultra/);
  assert.equal(level, 'low');

  clampTo = 'high';
  const clamped = context();
  await cmds.thinking.handler('max', clamped.ctx); await settle();
  assert.equal(clamped.said[0].text, 'Thinking: high — the model does not offer max.');
});

test('/compact: runs with the instructions after it, waits for an idle session', async () => {
  const cmds = load();
  const calls = [];
  const idle = context({ compact: (o) => calls.push(o) });
  await cmds.compact.handler('keep the API notes', idle.ctx); await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ customInstructions: 'keep the API notes' }]);
  assert.equal(idle.said.length, 0, 'Pi\'s own compaction events say the rest');

  const busy = context({ compact: (o) => calls.push(o), idle: false });
  await cmds.compact.handler('', busy.ctx); await settle();
  assert.equal(calls.length, 1);
  assert.match(busy.said[0].text, /Wait for the current turn/);
});

test('a terminal-only command says where the thing lives instead of reaching the model', async () => {
  const cmds = load();
  const { ctx, said } = context();
  await cmds.hotkeys.handler('', ctx); await settle();
  assert.equal(said[0].text, '/hotkeys is a command of Pi\'s terminal interface. ' + sessionCommands.TUI_ONLY.hotkeys);
});

test('the protocol: a link notice gets a button, a secret input is flagged, Pi taking a question back closes it', () => {
  const d = protocol.createDecoder();
  const L = sessionCommands.LINK_PREFIX;
  const [link] = d.decode({ type: 'extension_ui_request', id: 'n1', method: 'notify', notifyType: 'info',
    message: L + JSON.stringify({ text: 'Log in.', url: 'https://example.test/a', label: 'Open the login page' }) });
  assert.deepEqual(link, { op: 'notice', level: 'info', text: 'Log in.', links: [{ url: 'https://example.test/a', label: 'Open the login page' }] });
  const [notHttp] = d.decode({ type: 'extension_ui_request', id: 'n2', method: 'notify',
    message: L + JSON.stringify({ text: 'Look.', url: 'file:///etc/passwd' }) });
  assert.deepEqual(notHttp, { op: 'notice', level: 'info', text: 'Look.' }, 'no button for anything but a web page, and no marker shown');

  const [ask] = d.decode({ type: 'extension_ui_request', id: 'q1', method: 'input', placeholder: 'sk-…',
    title: sessionCommands.ASK_PREFIX + JSON.stringify({ title: 'API key:', secret: true, token: 't1' }) });
  assert.equal(ask.request.title, 'API key:');
  assert.equal(ask.request.secret, true);
  assert.equal(ask.request.method, 'input');
  const [plain] = d.decode({ type: 'extension_ui_request', id: 'q2', method: 'input', title: 'Name?' });
  assert.equal(plain.request.title, 'Name?');
  assert.equal(plain.request.secret, undefined);

  const D = sessionCommands.DISMISS_PREFIX;
  assert.deepEqual(d.decode({ type: 'extension_ui_request', id: 'n3', method: 'notify', message: D + JSON.stringify({ token: 't1' }) }),
    [{ op: 'answered', id: 'q1' }]);
  assert.deepEqual(d.decode({ type: 'extension_ui_request', id: 'n4', method: 'notify', message: D + JSON.stringify({ token: 't1' }) }), [],
    'a second word about the same question, or one about a question never seen, draws nothing');
});

// #444: what Pi says about a failure reaches the conversation, so it may not carry a local path. Pi 0.84.4
// re-wraps a failed read of its login file WITHOUT the errno code, with the path at the end.
test('a failure is said without a local path: by its errno code, found on the error or in its text', () => {
  const say = (err) => sessionCommands.describeFailure(err, sessionCommands.MESSAGE_CAP);
  assert.equal(say(Object.assign(new Error('x'), { code: 'EACCES' })), 'a file could not be read or written (EACCES).');
  assert.equal(say(new Error("Failed to read auth.json: EACCES: permission denied, open '<home>/.pi/agent/auth.json'")),
    'a file could not be read or written (EACCES).');
  assert.equal(say(new Error('listen EADDRINUSE: address already in use 127.0.0.1:53692')), 'a system or network error (EADDRINUSE).');
  assert.equal(say(new Error('Token exchange failed: 400 ERROR: invalid_grant')), 'Token exchange failed: 400 ERROR: invalid_grant',
    'an upper-case word before a colon is not an errno code');
  assert.equal(say(new Error('getaddrinfo EAI_AGAIN example.test')), 'getaddrinfo EAI_AGAIN example.test', 'a code without its colon stays text');
  assert.equal(say(new Error('connect ECONNREFUSED: 127.0.0.1')), 'a system or network error (ECONNREFUSED).');
  assert.equal(say(Object.assign(new Error(''), { name: 'X' })), 'unknown error', 'an empty message is not "[object Object]"');
  assert.equal(say('plain words'), 'plain words');
  for (const withPath of ['cannot open Z:\\work\\auth.json', "open '/home/someone/x'", 'at /Users/someone/x', 'see ~/.pi/agent',
    'open \\\\server\\share\\auth.json', "open '/srv/pi/auth.json'", "open '/Volumes/disk/auth.json'"]) {
    assert.match(say(new Error(withPath)), /names a local path/, withPath);
  }
  assert.equal(say(new Error('Token exchange failed: https://example.test/v1/oauth/token 400')),
    'Token exchange failed: https://example.test/v1/oauth/token 400', 'a web address is not a local path');
  assert.equal(say(new Error('a'.repeat(400))).length, sessionCommands.MESSAGE_CAP);
  const cmds = load();
  return (async () => {
    const disk = context({ runtime: fakeRuntime({ listCredentials: undefined }) });
    disk.ctx.modelRegistry.runtime.listCredentials = async () => { throw new Error("Failed to read auth.json: EPERM: operation not permitted, open 'Z:\\x\\auth.json'"); };
    await cmds.logout.handler('', disk.ctx); await settle();
    assert.equal(disk.said[0].text, 'Could not read the saved logins: a file could not be read or written (EPERM).');
  })();
});

test('every question a command asks is marked, so it outlives a run and can be taken back', async () => {
  const cmds = load({ pi: { getThinkingLevel: () => 'low', setThinkingLevel: () => {} } });
  const { ctx, asked } = context({ select: [undefined] });
  await cmds.thinking.handler('', ctx); await settle();
  const own = sessionCommands.parseAskTitle(asked[0].title);
  assert.equal(own.title, 'How much should the model think?');
  assert.equal(own.secret, false);

  const d = protocol.createDecoder();
  const [sel] = d.decode({ type: 'extension_ui_request', id: 's1', method: 'select', title: asked[0].title, options: ['a', 'b'] });
  assert.deepEqual(sel.request, { id: 's1', method: 'select', title: 'How much should the model think?', message: '', options: ['a', 'b'],
    placeholder: '', prefill: '', secret: false, lasting: true });
  const [other] = d.decode({ type: 'extension_ui_request', id: 's2', method: 'select', title: 'Pick', options: ['a'] });
  assert.equal(other.request.lasting, undefined, 'another extension\'s question ends with the run as before');
  assert.deepEqual(d.decode({ type: 'extension_ui_request', id: 'n', method: 'notify', message: sessionCommands.DISMISS_PREFIX + JSON.stringify({ token: own.token }) }),
    [{ op: 'answered', id: 's1' }], 'a select Pi takes back is closed too');
});

// #643, A2: what the commands take as an argument, answered by the extension's internal command as a marked
// notice the decoder keeps for the core — never drawn.
test('the argument completions come from Pi itself and go back as one marked notice', async () => {
  const cmds = load({ pi: { getThinkingLevel: () => 'high' } });
  const complete = cmds[sessionCommands.COMPLETE_COMMAND];
  assert.equal(typeof complete.handler, 'function');
  const ask = async (command, ctxOpts) => {
    const { ctx, said } = context(ctxOpts);
    await complete.handler(JSON.stringify({ command, token: 'k1' }), ctx);
    assert.equal(said.length, 1, command);
    return sessionCommands.parseCompletions(said[0].text);
  };
  const models = [{ provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT 5.6' }, { provider: 'anthropic', id: 'claude-opus-5', name: 'Opus 5' }];
  assert.deepEqual(await ask('model', { models, model: models[0] }), { token: 'k1', items: [
    { value: 'openai-codex/gpt-5.6-sol', description: 'GPT 5.6 (current)' }, { value: 'anthropic/claude-opus-5', description: 'Opus 5' },
  ] });
  const thinking = await ask('thinking', {});
  assert.deepEqual(thinking.items.map(i => i.value), sessionCommands.THINKING_LEVELS);
  assert.equal(thinking.items.find(i => i.value === 'high').description, 'current');
  assert.deepEqual((await ask('login', { runtime: fakeRuntime() })).items, [
    { value: 'anthropic', description: 'Anthropic' }, { value: 'openai-codex', description: 'OpenAI Codex — logged in' }, { value: 'groq', description: 'Groq' },
  ]);
  assert.deepEqual((await ask('logout', { runtime: fakeRuntime({ credentials: [{ providerId: 'anthropic', type: 'oauth' }] }) })).items,
    [{ value: 'anthropic', description: 'subscription' }]);
  assert.deepEqual((await ask('tree', {})).items, [], 'a command with no argument list answers an empty one');
  const bad = context();
  await complete.handler('not json', bad.ctx);
  assert.equal(bad.said.length, 0, 'a request it cannot read gets no answer');

  const d = protocol.createDecoder();
  const [, ...none] = [null, ...d.decode({ type: 'extension_ui_request', id: 'n', method: 'notify',
    message: sessionCommands.COMPLETIONS_PREFIX + JSON.stringify({ token: 'k9', items: [{ value: 'a' }, { nope: 1 }] }) })];
  assert.deepEqual(none, [], 'not drawn');
  assert.deepEqual(d.takeCompletions('k9'), [{ value: 'a', description: '' }]);
  assert.equal(d.takeCompletions('k9'), null, 'taken once');
});

test('the command list leaves out the internal command and says which ones take an argument list', () => {
  const rows = protocol.commandsFromResponse({ data: { commands: [
    { name: 'thinking', description: 'Set it', source: 'extension' },
    { name: sessionCommands.COMPLETE_COMMAND, source: 'extension' },
    { name: 'greet', description: 'Say  hi\n twice', source: 'extension' },
    { name: 'review', source: 'prompt' },
    { name: 'skill:x', source: 'skill' },
    { name: 'hotkeys', source: 'extension', description: 'A command of the terminal interface' },
    { name: sessionCommands.NAVIGATE_COMMAND, source: 'extension' },
  ] } });
  assert.deepEqual(rows, [
    { name: 'thinking', description: 'Set it', kind: 'command', arguments: true },
    { name: 'greet', description: 'Say hi twice', kind: 'command', arguments: false },
    { name: 'review', description: '', kind: 'template', arguments: false },
    { name: 'skill:x', description: '', kind: 'skill', arguments: false },
  ]);
  assert.deepEqual(protocol.commandsFromResponse({}), []);
  const without = protocol.commandsFromResponse({ data: { commands: [{ name: 'model', source: 'extension' }] } });
  assert.equal(without[0].arguments, false, 'no answering command registered, no argument list asked for');
});

test('a failed compaction is said once, in Pi\'s words when Pi already said it', () => {
  const d = protocol.createDecoder();
  assert.deepEqual(d.decode({ type: 'compaction_end', errorMessage: 'Compaction failed: Nothing to compact (session too small)' }),
    [{ op: 'notice', level: 'error', text: 'Compaction failed: Nothing to compact (session too small)' }]);
  assert.deepEqual(d.decode({ type: 'compaction_end', errorMessage: 'model refused' }),
    [{ op: 'notice', level: 'error', text: 'Compaction failed: model refused' }]);
  assert.deepEqual(d.decode({ type: 'compaction_end' }), [{ op: 'notice', level: 'error', text: 'Compaction failed.' }]);
});

// #643 (W3) — the command is Pi's to resolve, the figures are the app's to fetch. The handler must carry
// no numbers: Pi's extension API has none to give, and an undocumented field is what this route avoids.
test('/session says only that it was typed, and the decoder turns that into an ask for the figures', async () => {
  const cmds = load();
  const { ctx, said } = context();
  await cmds.session.handler('', ctx); await settle();
  assert.equal(said.length, 1);
  assert.equal(said[0].text, sessionCommands.STATS_PREFIX, 'the marker alone — no figure passes through Pi');

  const d = protocol.createDecoder();
  assert.deepEqual(d.decode({ type: 'extension_ui_request', id: 'n9', method: 'notify', message: sessionCommands.STATS_PREFIX }),
    [{ op: 'figures' }]);
  // A notice that merely starts with something else is still an ordinary notice.
  assert.deepEqual(d.decode({ type: 'extension_ui_request', id: 'n10', method: 'notify', message: 'switchboard is fine' }),
    [{ op: 'notice', level: 'info', text: 'switchboard is fine' }]);
});

test('a command that is built is no longer answered with a line saying it is not here', () => {
  for (const name of ['session', 'export', 'copy', 'name', 'reload', 'tree']) {
    assert.equal(Object.prototype.hasOwnProperty.call(sessionCommands.TUI_ONLY, name), false,
      `/${name}: a command that gets built leaves TUI_ONLY in the same change`);
    const listed = protocol.commandsFromResponse({ data: { commands: [{ name, source: 'extension', description: 'd' }] } });
    assert.deepEqual(listed.map(c => c.name), [name], `and /${name} is offered in the input's command list`);
  }
});

// #643 (E14) — `/fork` and `/clone` are refused although `ctx.fork` reaches both, because they would move
// the tab the user is looking at onto a different session. The hint has to point at the route that exists.
test('the commands that stay refused name the route that does exist', () => {
  for (const name of ['fork', 'clone']) {
    assert.match(sessionCommands.TUI_ONLY[name], /sidebar/,
      `/${name} is refused on purpose, so its line must name where the app does it`);
  }
});

// --- /tree (#646) ---

// A session manager shaped like Pi 0.85.1's: entries in file order, the leaf moved by the navigation.
function treeContext({ idle = true, entries, leaf, navigate } = {}) {
  const base = context({ idle });
  const file = entries.slice();
  let leafId = leaf;
  const moves = [];
  base.ctx.sessionManager = {
    getEntry: (id) => file.find(e => e.id === id),
    getEntries: () => file,
    getLeafId: () => leafId,
  };
  base.ctx.navigateTree = async (id, opts) => {
    moves.push({ id, summarize: opts.summarize });
    if (navigate) return navigate({ id, opts, file, setLeaf: (l) => { leafId = l; } });
    const target = file.find(e => e.id === id);
    leafId = target.type === 'message' && target.message.role === 'user' ? target.parentId : id;
    return { cancelled: false };
  };
  return { ...base, file, moves };
}
const piEntries = () => [
  { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
  { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'ALPHA' }] } },
  { type: 'message', id: 'u2', parentId: 'a1', message: { role: 'user', content: 'second, as a string' } },
  { type: 'message', id: 'a2', parentId: 'u2', message: { role: 'assistant', content: [{ type: 'text', text: 'BETA' }] } },
];

test('/tree says only that it was typed, and not while a turn runs', async () => {
  const cmds = load();
  const idle = context();
  await cmds.tree.handler('', idle.ctx); await settle();
  assert.deepEqual(idle.said.map(s => s.text), [sessionCommands.TREE_PREFIX]);
  const busy = context({ idle: false });
  await cmds.tree.handler('', busy.ctx); await settle();
  assert.match(busy.said[0].text, /Wait for the current turn/);
  assert.equal(Object.prototype.hasOwnProperty.call(sessionCommands.TUI_ONLY, 'tree'), false);
});

// T7 (measured): a plain move writes nothing, so the command writes the entry that makes it durable.
test('a plain move is made durable with an entry the context ignores', async () => {
  const appended = [];
  const cmds = load({ pi: { appendEntry: (type, data) => appended.push({ type, data }) } });
  const t = treeContext({ entries: piEntries(), leaf: 'a2' });
  await cmds[sessionCommands.NAVIGATE_COMMAND].handler(JSON.stringify({ target: 'a1', token: 'k1' }), t.ctx); await settle();
  assert.deepEqual(plain(t.moves), [{ id: 'a1', summarize: false }]);
  assert.deepEqual(plain(appended), [{ type: sessionCommands.BRANCH_ENTRY, data: { target: 'a1' } }]);
  assert.deepEqual(sessionCommands.parseNavigated(t.said[0].text),
    { token: 'k1', ok: true, cancelled: false, error: '', summarized: false, draft: '' });
});

// T8: picking a user message hands its text back, read BEFORE the move (Pi's RPC mode drops it).
test('picking a user message hands its text back for editing', async () => {
  const cmds = load();
  const t = treeContext({ entries: piEntries(), leaf: 'a2' });
  await cmds[sessionCommands.NAVIGATE_COMMAND].handler(JSON.stringify({ target: 'u2', token: 'k2' }), t.ctx); await settle();
  assert.equal(sessionCommands.parseNavigated(t.said[0].text).draft, 'second, as a string');
});

test('a move with a summary is durable already and adds nothing', async () => {
  const appended = [];
  const cmds = load({ pi: { appendEntry: (type) => appended.push(type) } });
  const t = treeContext({
    entries: piEntries(), leaf: 'a2',
    navigate: ({ id, file, setLeaf }) => { file.push({ type: 'branch_summary', id: 's1', parentId: id }); setLeaf('s1'); return { cancelled: false }; },
  });
  await cmds[sessionCommands.NAVIGATE_COMMAND].handler(JSON.stringify({ target: 'a1', summarize: true, token: 'k3' }), t.ctx); await settle();
  assert.deepEqual(plain(t.moves), [{ id: 'a1', summarize: true }]);
  assert.deepEqual(appended, [], 'the summary is already the last entry and the leaf');
  assert.equal(sessionCommands.parseNavigated(t.said[0].text).summarized, true);
});

test('a move is refused while a turn runs, for a point that is gone, and says a cancel', async () => {
  const cmds = load();
  const nav = cmds[sessionCommands.NAVIGATE_COMMAND].handler;
  const busy = treeContext({ entries: piEntries(), leaf: 'a2', idle: false });
  await nav(JSON.stringify({ target: 'a1', token: 'b' }), busy.ctx); await settle();
  assert.match(sessionCommands.parseNavigated(busy.said[0].text).error, /Wait for the current turn/);
  assert.deepEqual(busy.moves, []);
  const gone = treeContext({ entries: piEntries(), leaf: 'a2' });
  await nav(JSON.stringify({ target: 'zz', token: 'g' }), gone.ctx); await settle();
  assert.match(sessionCommands.parseNavigated(gone.said[0].text).error, /no longer in the session/);
  const cancelled = treeContext({ entries: piEntries(), leaf: 'a2', navigate: () => ({ cancelled: true }) });
  await nav(JSON.stringify({ target: 'a1', token: 'c' }), cancelled.ctx); await settle();
  assert.equal(sessionCommands.parseNavigated(cancelled.said[0].text).cancelled, true);
  const unread = context();
  await nav('not json', unread.ctx); await settle();
  assert.equal(unread.said.length, 0, 'a request it cannot read gets no answer');
});

test('the protocol: /tree asks for the tree, the move comes back as its own op', () => {
  const d = protocol.createDecoder();
  assert.deepEqual(d.decode({ type: 'extension_ui_request', id: 't', method: 'notify', message: sessionCommands.TREE_PREFIX }), [{ op: 'branchTree' }]);
  const [moved] = d.decode({ type: 'extension_ui_request', id: 'm', method: 'notify',
    message: sessionCommands.NAVIGATED_PREFIX + JSON.stringify({ token: 'k', ok: true, draft: 'again' }) });
  assert.deepEqual(moved, { op: 'navigated', token: 'k', ok: true, cancelled: false, error: '', summarized: false, draft: 'again' });
  assert.deepEqual(protocol.navigateCommand('r1', { target: 'a1', summarize: true, token: 'k' }),
    { id: 'r1', type: 'prompt', message: '/' + sessionCommands.NAVIGATE_COMMAND + ' {"target":"a1","summarize":true,"token":"k"}' });
  assert.equal(protocol.navigatedNotice({ cancelled: true }), null, 'a cancel says nothing');
  assert.equal(protocol.navigatedNotice({ ok: false, error: 'No.' }).level, 'error');
  assert.match(protocol.navigatedNotice({ ok: true, summarized: true, draft: 'x' }).text, /summary .* back in the input/s);
});

// The rows are flat with a depth per fork, the session's branch first at every fork — a nested drawing of
// a chain would indent once per message.
test('the tree becomes flat rows: a depth per fork, the current branch first, noise left out', () => {
  const msg = (id, role, content, extra) => ({ entry: { type: 'message', id, message: { role, content, ...(extra || {}) } }, children: [] });
  const u1 = msg('u1', 'user', [{ type: 'text', text: 'hi\n  there' }]);
  const a1 = msg('a1', 'assistant', [{ type: 'text', text: 'ALPHA' }]);
  const old = msg('u2', 'user', 'old branch');
  const oldA = msg('a2', 'assistant', [{ type: 'toolCall', name: 'read' }]);   // tools only: hidden
  const newU = msg('u3', 'user', 'new branch');
  const newA = msg('a3', 'assistant', [{ type: 'toolCall', name: 'bash' }]);   // tools only, but the leaf
  const setting = { entry: { type: 'model_change', id: 'm1', provider: 'p', modelId: 'x' }, children: [] };
  u1.children = [a1]; a1.children = [old, setting]; old.children = [oldA]; setting.children = [newU]; newU.children = [newA];
  const out = protocol.treeRows({ success: true, data: { tree: [u1], leafId: 'a3' } });
  assert.deepEqual(out.rows.map(r => [r.id, r.depth, r.kind, r.text, r.onPath, r.current]), [
    ['u1', 0, 'user', 'hi there', true, false],
    ['a1', 0, 'assistant', 'ALPHA', true, false],
    ['m1', 1, 'setting', 'Model: p/x', true, false],
    ['u3', 1, 'user', 'new branch', true, false],
    ['a3', 1, 'assistant', 'Called bash', true, true],
    ['u2', 1, 'user', 'old branch', false, false],
  ]);
  assert.equal(out.truncated, false);
  assert.equal(protocol.treeRows({ success: false }), null, 'no answer is not an empty tree');
  assert.deepEqual(protocol.treeRows({ success: true, data: { tree: [], leafId: null } }), { rows: [], truncated: false });
});

// The same shape as `/session`: the command says it was typed, nothing else. What the user typed after it
// travels, because only the app can decide what to do with a path.
test('/export says only that it was typed, with whatever was typed after it', async () => {
  const cmds = load();
  const { ctx, said } = context();
  await cmds.export.handler('  notes.html  ', ctx); await settle();
  assert.equal(said.length, 1);
  assert.equal(said[0].text, sessionCommands.EXPORT_PREFIX + JSON.stringify({ args: 'notes.html' }),
    'the marker carries the typed name and no path of its own');

  const d = protocol.createDecoder();
  assert.deepEqual(d.decode({ type: 'extension_ui_request', id: 'e1', method: 'notify', message: said[0].text }),
    [{ op: 'exportFile', args: 'notes.html' }]);
  assert.deepEqual(d.decode({ type: 'extension_ui_request', id: 'e2', method: 'notify', message: sessionCommands.EXPORT_PREFIX + '{}' }),
    [{ op: 'exportFile', args: '' }], 'nothing typed is an empty name, not a missing op');
  assert.deepEqual(d.decode({ type: 'extension_ui_request', id: 'e3', method: 'notify', message: sessionCommands.EXPORT_PREFIX + 'not json' }),
    [{ op: 'exportFile', args: '' }], 'a marker that does not parse is still the command being typed');
});

test('/copy says only that it was typed; the clipboard is never the runtime\'s', async () => {
  const cmds = load();
  const { ctx, said } = context();
  await cmds.copy.handler('', ctx); await settle();
  assert.deepEqual(said.map(s => s.text), [sessionCommands.COPY_PREFIX]);
  const d = protocol.createDecoder();
  assert.deepEqual(d.decode({ type: 'extension_ui_request', id: 'c1', method: 'notify', message: sessionCommands.COPY_PREFIX }),
    [{ op: 'lastReply' }]);
});

// Answered inside the extension, because `pi.setSessionName` IS the answer — and Pi's own parser reads
// that name back as the row's title, so there is one name rather than the app writing a second.
test('/name sets the runtime\'s own session name, asking for one when none was typed', async () => {
  const named = [];
  const cmds = load({ pi: { setSessionName: (n) => named.push(n) } });
  const first = context();
  await cmds.name.handler('  Refactor auth  ', first.ctx); await settle();
  assert.deepEqual(named, ['Refactor auth'], 'trimmed, and taken from the argument when there is one');
  assert.match(first.said[0].text, /^Session name: Refactor auth\./);

  const asked = context({ input: ['From the card'] });
  await cmds.name.handler('', asked.ctx); await settle();
  assert.deepEqual(named, ['Refactor auth', 'From the card']);

  const cancelled = context({ input: [''] });
  await cmds.name.handler('', cancelled.ctx); await settle();
  assert.equal(named.length, 2, 'an empty answer names nothing');
  assert.equal(cancelled.said.length, 0, 'and says nothing either');
});

test('/name says so plainly when the runtime cannot be asked', async () => {
  const cmds = load({ pi: { setSessionName: undefined } });
  const { ctx, said } = context();
  await cmds.name.handler('x', ctx); await settle();
  assert.match(said[0].text, /cannot name a session/);
  assert.equal(said[0].level, 'error');
});

// Terminal for its own handler: Pi replaces this extension instance, so the notice goes out BEFORE the
// call and nothing is said after it.
test('/reload speaks first and then hands the runtime over', async () => {
  const order = [];
  const { ctx, said } = context();
  ctx.reload = async () => { order.push(['reload', said.length]); };
  const cmds = load();
  await cmds.reload.handler('', ctx); await settle();
  assert.deepEqual(order, [['reload', 1]], 'the notice was already out when the reload started');
  assert.equal(said.length, 1, 'and nothing is said from the instance being replaced');
  assert.match(said[0].text, /Reloading/);
});

test('/reload says so plainly when the runtime cannot be asked', async () => {
  const cmds = load();
  const { ctx, said } = context();
  ctx.reload = undefined;
  await cmds.reload.handler('', ctx); await settle();
  assert.match(said[0].text, /cannot reload/);
  assert.equal(said[0].level, 'error');
});

test('the figures name Pi as their source, and a missing reading is left out rather than guessed', () => {
  const full = protocol.statsNotice({
    success: true,
    data: {
      totalMessages: 7, userMessages: 3, assistantMessages: 3, toolCalls: 1,
      tokens: { input: 40100, output: 3000, cacheRead: 5100, cacheWrite: 0, total: 48200 },
      cost: 0.0412,
      contextUsage: { tokens: 48200, contextWindow: 200000, percent: 24.1 },
    },
  });
  assert.equal(full.level, 'info');
  assert.match(full.text, /^As Pi counts this session: /, 'whose numbers these are is said, not implied');
  // Not worded as a partition: Pi's `totalMessages` counts kinds the other two do not.
  assert.match(full.text, /7 messages, 3 of them yours and 3 the agent's · 1 tool call/);
  // Unrounded, so the parts visibly add up to the total; only the capacity is abbreviated.
  assert.match(full.text, /48200 tokens \(40100 in, 3000 out, 5100 read from cache, 0 written to it\)/);
  assert.match(full.text, /\$0\.0412/);
  assert.match(full.text, /24 % of a 200k context window/);

  // Rounding each figure on its own would print a total its own parts contradict.
  const evenSplit = protocol.statsNotice({ success: true, data: { totalMessages: 2, tokens: { input: 10500, output: 10500, cacheRead: 0, cacheWrite: 0, total: 21000 }, cost: 0 } });
  assert.match(evenSplit.text, /21000 tokens \(10500 in, 10500 out,/);

  // Right after a compaction Pi's reading has no percent; the sentence simply ends earlier.
  const noContext = protocol.statsNotice({ success: true, data: { totalMessages: 1, tokens: { total: 12 }, cost: 2.5, contextUsage: { tokens: null, contextWindow: 200000, percent: null } } });
  assert.doesNotMatch(noContext.text, /context window/);
  assert.match(noContext.text, /\$2\.50/, 'a spend of a dollar or more is not read in ten-thousandths');
  assert.match(noContext.text, /1 message, /, 'one message is not "1 messages"');

  const refused = protocol.statsNotice({ success: false, error: 'no answer' });
  assert.equal(refused.level, 'warning');
  assert.match(refused.text, /did not report/);
});

// #643 — a `!` line is not a command: Pi's own input event catches it, so the model never sees it and
// the `!` grammar stays inside this folder.
test('a ! line is caught in the input event and answered with a marker', async () => {
  const hooks = {};
  const cmds = load({ pi: { on: (name, fn) => { hooks[name] = fn; } } });
  assert.equal(typeof hooks.input, 'function', 'the section hooks Pi\'s own input event');
  assert.ok(cmds, 'and still registers the commands beside it');

  const { ctx, said } = context();
  const ran = await hooks.input({ text: '!ls -la', source: 'rpc' }, ctx);
  assert.deepEqual(plain(ran), { action: 'handled' }, 'handled, so it never reaches the model');
  assert.equal(said.length, 1);
  assert.equal(said[0].text, sessionCommands.SHELL_PREFIX + JSON.stringify({ command: 'ls -la' }));

  const d = protocol.createDecoder();
  assert.deepEqual(d.decode({ type: 'extension_ui_request', id: 's1', method: 'notify', message: said[0].text }),
    [{ op: 'shell', command: 'ls -la' }]);
});

test('an ordinary line is left alone, and a lone ! is somebody still typing', async () => {
  const hooks = {};
  load({ pi: { on: (name, fn) => { hooks[name] = fn; } } });
  const { ctx, said } = context();
  for (const text of ['hello', 'do not run !ls', '', '!', '!   ']) {
    const answer = await hooks.input({ text, source: 'rpc' }, ctx);
    assert.deepEqual(plain(answer), { action: 'continue' }, `"${text}" is ordinary input`);
  }
  assert.deepEqual(said, [], 'and nothing was said about any of them');
});

// `!!` means "keep the output out of the context" in Pi's terminal interface, and the RPC bash has no
// such option — so it is refused rather than run as if the second ! had been typed by accident.
test('a !! line is refused, naming what it cannot do here', async () => {
  const hooks = {};
  load({ pi: { on: (name, fn) => { hooks[name] = fn; } } });
  const { ctx, said } = context();
  const answer = await hooks.input({ text: '!!secret-thing', source: 'rpc' }, ctx);
  assert.deepEqual(plain(answer), { action: 'handled' }, 'handled, so it does not reach the model either');
  assert.equal(said.length, 1);
  assert.equal(said[0].level, 'warning');
  assert.match(said[0].text, /always joins the conversation/);
  assert.equal(said[0].text.includes('secret-thing'), false, 'and the line itself is not repeated back');
  assert.equal(said[0].text.startsWith(sessionCommands.SHELL_PREFIX), false, 'no shell line is asked for');
});

test('a shell line is run by the runtime, stopped by the one command that stops it, and worded here', () => {
  assert.deepEqual(protocol.shellCommand('r1', { command: 'echo hi' }), { id: 'r1', type: 'bash', command: 'echo hi' });
  // Pi's abort_bash takes no id of its own: one shell line runs at a time.
  assert.deepEqual(protocol.shellAbortCommand('r2'), { id: 'r2', type: 'abort_bash' });

  const ok = protocol.shellResult({ success: true, data: { output: 'hi\n', exitCode: 0, cancelled: false, truncated: false } });
  assert.equal(ok.status, 'done');
  assert.equal(ok.output, 'hi\n\n[exit 0]', 'worded like the history viewer words the same execution');

  const failed = protocol.shellResult({ success: true, data: { output: 'nope', exitCode: 2 } });
  assert.equal(failed.status, 'error');
  assert.match(failed.output, /\[exit 2\]/);

  const cut = protocol.shellResult({ success: true, data: { output: 'lots', exitCode: 0, truncated: true } });
  assert.match(cut.output, /\[truncated\]/);

  // A stopped line KEEPS what it had already printed (measured on 0.85.1 against a command that was
  // writing when it was stopped). An empty answer means it had printed nothing, not that Pi discarded it
  // — reading the empty case as the general one is how the opposite got written down first.
  const stoppedWithOutput = protocol.shellResult({ success: true, data: { output: 'half of it\n', cancelled: true } });
  assert.equal(stoppedWithOutput.status, 'cancelled');
  assert.equal(stoppedWithOutput.output, 'half of it\n\n[cancelled]', 'what it printed stands, marked as stopped');

  const stoppedSilent = protocol.shellResult({ success: true, data: { output: '', cancelled: true } });
  assert.equal(stoppedSilent.status, 'cancelled');
  assert.equal(stoppedSilent.output, '[cancelled]', 'a line that had printed nothing is the marker alone');

  // "did not finish", never "was not run": the commonest way here is the session ending mid-command, and
  // it HAD run.
  const refused = protocol.shellResult({ success: false, error: 'not running' });
  assert.equal(refused.status, 'error');
  assert.match(refused.output, /did not finish/);
});

// A line drawn live and the same line re-read out of the transcript after a re-mount must READ alike, so
// the two are asserted against each other rather than each against a string written twice.
test('a shell line is worded the same live as the history viewer words it', () => {
  const { normalizeTranscriptEntries } = require('../src/backends/pi/transcript-view');
  const history = (m) => normalizeTranscriptEntries([{ type: 'message', message: { role: 'bashExecution', ...m } }])[0]._localCmd.output;

  for (const m of [
    { command: 'x', output: 'out\n', exitCode: 0 },
    { command: 'x', output: 'out\n', exitCode: 2 },
    { command: 'x', output: 'half\n', cancelled: true },
    { command: 'x', output: 'lots', exitCode: 0, truncated: true },
  ]) {
    assert.equal(protocol.shellResult({ success: true, data: m }).output, history(m),
      `the live wording and the history wording agree for ${JSON.stringify(m)}`);
  }
});

test('a shell line\'s output accumulates under the id its request went out with', () => {
  const d = protocol.createDecoder();
  assert.deepEqual(d.decode({ type: 'bash_execution_update', id: 'r9', delta: 'one\n' }),
    [{ op: 'localCommand', id: 'r9', status: 'running', output: 'one\n' }]);
  assert.deepEqual(d.decode({ type: 'bash_execution_update', id: 'r9', delta: 'two\n' }),
    [{ op: 'localCommand', id: 'r9', status: 'running', output: 'one\ntwo\n' }],
    'the growing text is accumulated here, so a view that re-mounts mid-command still has all of it');
  // A second line keeps its own text.
  assert.deepEqual(d.decode({ type: 'bash_execution_update', id: 'r10', delta: 'other' }),
    [{ op: 'localCommand', id: 'r10', status: 'running', output: 'other' }]);
  assert.deepEqual(d.decode({ type: 'bash_execution_update', delta: 'nobody' }), [], 'no id, nothing to attach it to');
});

test('the written file is named by the backend and says where it went, or why it did not', () => {
  const name = protocol.exportFileName('01a0c81e-2545-77f6');
  assert.match(name, /^pi-session-01a0c81e-2545-77f6-[0-9T-]+Z?\.html$/, 'the format is the runtime\'s, so the extension is too');
  assert.match(protocol.exportFileName('../../etc/passwd'), /^pi-session-etcpasswd-/,
    'anything that is not plainly a filename is dropped rather than escaped');
  assert.match(protocol.exportFileName(''), /^pi-session-unnamed-/);
  assert.equal(protocol.exportFileName('a/b').includes('/'), false, 'never a second path segment');

  assert.deepEqual(protocol.exportCommand('q1', { outputPath: 'C:/tmp/x.html' }),
    { id: 'q1', type: 'export_html', outputPath: 'C:/tmp/x.html' });

  const wrote = protocol.exportNotice({ success: true, data: { path: '/somewhere/x.html' } });
  assert.equal(wrote.level, 'info');
  assert.equal(wrote.path, '/somewhere/x.html');
  assert.match(wrote.text, /Session written to \/somewhere\/x\.html/);

  // Pi's own refusal is the actionable half, so it is passed on.
  const empty = protocol.exportNotice({ success: false, error: 'Nothing to export yet - start a conversation first' });
  assert.equal(empty.level, 'error');
  assert.match(empty.text, /Nothing to export yet/);

  // …but not when it names a path, which is what `describeFailure` is for (#444).
  const leaky = protocol.exportNotice({ success: false, error: "EACCES: permission denied, open '/home/someone/x.html'" });
  assert.match(leaky.text, /a file could not be read or written \(EACCES\)/);
  assert.equal(leaky.text.includes('/home/someone'), false);

  const silent = protocol.exportNotice({ success: true, data: {} });
  assert.equal(silent.level, 'warning');
  assert.equal(silent.path, undefined, 'no path means no button rather than a button to nowhere');
});

test('the last reply is text the runtime hands over, and the copying is said to have happened or not', () => {
  assert.deepEqual(protocol.lastReplyCommand('q2'), { id: 'q2', type: 'get_last_assistant_text' });
  assert.equal(protocol.lastReplyText({ success: true, data: { text: 'pong' } }), 'pong');
  assert.equal(protocol.lastReplyText({ success: true, data: { text: null } }), null, 'no reply yet is an answer');
  assert.equal(protocol.lastReplyText({ success: true, data: { text: '' } }), null);
  // Three answers, not two: a request that was never answered must not be told as "no reply yet", or a
  // session full of replies is described as empty and the clipboard is left alone in silence.
  assert.equal(protocol.lastReplyText({ success: false, error: 'no answer' }), undefined);
  assert.equal(protocol.lastReplyText(null), undefined);

  const done = protocol.copiedNotice({ text: 'one\ntwo', copied: true });
  assert.equal(done.level, 'info');
  assert.match(done.text, /clipboard \(2 lines\)/);
  assert.match(protocol.copiedNotice({ text: 'one', copied: true }).text, /\(1 line\)/, 'one line is not "1 lines"');

  assert.match(protocol.copiedNotice({ text: null, copied: false }).text, /nothing to copy/);
  assert.equal(protocol.copiedNotice({ text: null, copied: false }).level, 'info', 'an empty session is not an error');
  assert.equal(protocol.copiedNotice({ text: 'x', copied: false }).level, 'error', 'a clipboard that refused is');

  const unanswered = protocol.copiedNotice({ text: undefined, copied: false });
  assert.equal(unanswered.level, 'warning');
  assert.match(unanswered.text, /did not answer/);
  assert.doesNotMatch(unanswered.text, /not replied/, 'never the empty-session sentence for a failed request');
});

test('the generated section carries no backtick-born damage and no execFile', () => {
  const text = runtimeExtension.extensionSource({ gate: true });
  assert.ok(compiled, 'it compiled above');
  assert.ok(text.includes(sessionCommands.describeFailure.toString()), 'the failure wording is the tested function, verbatim');
  assert.ok(text.includes('.replace(/\\s+/g, '), 'the whitespace class survived generation');
  assert.ok(!text.includes('execFile('));
});
