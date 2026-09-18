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
    for (const name of ['login', 'logout', 'model', 'thinking', 'compact', ...Object.keys(sessionCommands.TUI_ONLY)]) {
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
  await cmds.tree.handler('', ctx); await settle();
  assert.equal(said[0].text, '/tree is a command of Pi\'s terminal interface. ' + sessionCommands.TUI_ONLY.tree);
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
    { name: 'tree', source: 'extension', description: 'A command of the terminal interface' },
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

test('the generated section carries no backtick-born damage and no execFile', () => {
  const text = runtimeExtension.extensionSource({ gate: true });
  assert.ok(compiled, 'it compiled above');
  assert.ok(text.includes(sessionCommands.describeFailure.toString()), 'the failure wording is the tested function, verbatim');
  assert.ok(text.includes('.replace(/\\s+/g, '), 'the whitespace class survived generation');
  assert.ok(!text.includes('execFile('));
});
