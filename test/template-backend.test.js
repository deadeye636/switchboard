'use strict';
// #161 — a template names the backend it runs on.
//
// It used to be Claude, always, nailed down in three places: no field in the editor (the word "Claude"
// never appeared in that dialog), no field in the stored shape (the validator whitelisted {id, name,
// env, icon} and dropped the rest), and `profileToDescriptor` reaching for `registry.get('claude')`.
//
// A template is a named set of defaults FOR a backend: "Codex with model X and this sandbox" and
// "Claude Code against DeepSeek" are the same mechanism, not two concepts.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const backends = require('../src/backends');
const profiles = require('../src/backends/profiles');

// A registry whose profile store we control, restored afterwards.
function withProfiles(list, fn) {
  const store = {
    list: () => list,
    get: (id) => list.find(p => p.id === id) || null,
  };
  backends.init({ getGlobalSettings: () => ({}), profiles: store });
  try { return fn(); } finally { backends.init({ getGlobalSettings: () => ({}), profiles }); }
}

const CTX = { cwd: '/p', resume: false, sessionId: 's1' };

// --- the stored shape -----------------------------------------------------------------------------

test('a template records the backend it runs on', () => {
  const res = profiles.validateProfile({ id: 't1', name: 'Codex fast', backendId: 'codex', env: {} });
  assert.equal(res.ok, true);
  assert.equal(res.profile.backendId, 'codex');
});

test('a template written before this existed is Claude\'s — it had no other option', () => {
  const res = profiles.validateProfile({ id: 'ds', name: 'DeepSeek', env: {} });
  assert.equal(res.ok, true);
  assert.equal(res.profile.backendId, 'claude', 'the migration is the default, not a rewrite');
});

test('a template cannot run on a backend that does not exist', () => {
  const res = profiles.validateProfile({ id: 't', name: 'T', backendId: 'gpt-9000', env: {} });
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown backend/i);
});

// The ANTHROPIC_* leak check is about re-pointing the CLAUDE binary. On a Codex base those variables do
// not exist, so running it there would be theatre — and would block a perfectly valid template.
test('the host-key leak check applies to a Claude base, and only there', () => {
  const leaky = { ANTHROPIC_BASE_URL: 'https://api.example.com', ANTHROPIC_API_KEY: '$MY_KEY' };
  const onClaude = profiles.validateProfile({ id: 'a', name: 'A', backendId: 'claude', env: leaky });
  assert.equal(onClaude.ok, false, 'an unblanked host key on a redirected Claude is refused');
  assert.equal(onClaude.leak, true);

  const onCodex = profiles.validateProfile({ id: 'b', name: 'B', backendId: 'codex', env: leaky });
  assert.equal(onCodex.ok, true, 'Codex has no ANTHROPIC_* variables — there is nothing to leak');
});

// --- the descriptor: what actually launches -------------------------------------------------------

test('a Codex template launches CODEX, not Claude', () => {
  withProfiles([{ id: 'fast', name: 'Codex fast', backendId: 'codex', env: {} }], () => {
    const t = backends.get('fast');
    assert.ok(t, 'the template is a backend like any other');
    assert.equal(t.isProfile, true);
    assert.equal(t.baseId, 'codex');

    const launch = t.buildLaunch({ ...CTX, options: { model: 'gpt-5.5', sandbox: 'read-only' } });
    assert.equal(launch.command, 'codex', 'THE point of #161');
    assert.ok(launch.args.includes('-m') && launch.args.includes('gpt-5.5'));
    assert.ok(launch.args.includes('-s') && launch.args.includes('read-only'));
  });
});

test('a Codex template offers CODEX\'s options — not Claude\'s', () => {
  withProfiles([{ id: 'fast', name: 'Codex fast', backendId: 'codex', env: {} }], () => {
    const ids = backends.get('fast').configFields.map(f => f.id);
    assert.ok(ids.includes('sandbox'), 'Codex has a sandbox');
    assert.ok(!ids.includes('permissionMode'), "and it does not have Claude's permission mode");
  });
});

test('a Claude template still runs the claude binary, with its env bundle on top', () => {
  withProfiles([{ id: 'ds', name: 'DeepSeek', backendId: 'claude', env: { ANTHROPIC_BASE_URL: 'https://x' } }], () => {
    const t = backends.get('ds');
    assert.equal(t.baseId, 'claude');
    const launch = t.buildLaunch({ ...CTX, options: {} });
    assert.equal(launch.command, 'claude');
    assert.equal(launch.env.ANTHROPIC_BASE_URL, 'https://x', 'the template env wins over the base env');
  });
});

test('a template with no backendId is Claude\'s — nothing existing breaks', () => {
  withProfiles([{ id: 'old', name: 'Old profile', env: {} }], () => {
    const t = backends.get('old');
    assert.equal(t.baseId, 'claude');
    assert.equal(t.buildLaunch({ ...CTX, options: {} }).command, 'claude');
  });
});

// The old code did `const claude = registry.get('claude')` and then called `claude.buildLaunch(ctx)`
// UNGUARDED. A template whose base is missing must fail with a sentence, not a TypeError.
test('a template whose backend is gone says so instead of throwing', () => {
  // A base id that is not registered at all (agy is real now, so it can no longer stand in for "gone").
  withProfiles([{ id: 'ghost', name: 'Ghost', backendId: 'no-such-backend', env: {} }], () => {
    const t = backends.get('ghost');
    assert.ok(t, 'it stays visible in Settings — it is the user\'s template, not ours to hide');
    assert.equal(t.status, 'planned', 'but it cannot be launched');
    assert.equal(backends.isLaunchable('ghost'), false);
    assert.throws(() => t.buildLaunch({ ...CTX, options: {} }), /not available/i,
      'and if something reaches for its launch anyway, it gets a sentence');
  });
});

// A template shares its base's store entirely — it has none of its own. That is why the scanner skips it
// (session-cache.js) and why its sessions get their provenance from the launch overlay instead.
test('a template borrows its base\'s store, parser and watcher', () => {
  withProfiles([{ id: 'fast', name: 'Codex fast', backendId: 'codex', env: {} }], () => {
    const codex = backends.get('codex');
    const t = backends.get('fast');
    assert.equal(t.discoverSessions, codex.discoverSessions);
    assert.equal(t.parseSession, codex.parseSession);
    assert.equal(t.watchTargets, codex.watchTargets);
    assert.equal(t.PARSER_SCHEMA_VERSION, codex.PARSER_SCHEMA_VERSION,
      'and it is versioned by the parser that actually reads its sessions (#152)');
  });
});

test('a template inherits its base\'s fork support, rather than claiming Claude\'s', () => {
  withProfiles([
    { id: 'ct', name: 'Claude template', backendId: 'claude', env: {} },
    { id: 'ht', name: 'Hermes template', backendId: 'hermes', env: {} },
  ], () => {
    assert.equal(backends.get('ct').supportsFork, backends.get('claude').supportsFork);
    assert.equal(backends.get('ht').supportsFork, backends.get('hermes').supportsFork);
  });
});

// --- the template is ONE record: base + name + icon + OPTIONS + env ---------------------------------
//
// Its launch options used to live in the settings blob (`backendDefaults.<templateId>`), on a separate
// page, behind a separate save button. So a template had two homes and two lifetimes, and its own editor
// showed only half of it. They live in the record now.

test('a template stores its launch options', () => {
  const res = profiles.validateProfile({
    id: 't', name: 'Codex fast', backendId: 'codex',
    options: { model: 'gpt-5.5-mini', sandbox: 'read-only' }, env: {},
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.profile.options, { model: 'gpt-5.5-mini', sandbox: 'read-only' });
});

test('a template stores ONLY what it sets — the rest falls through to the backend', () => {
  const res = profiles.validateProfile({ id: 't', name: 'T', backendId: 'codex', options: {}, env: {} });
  assert.equal(res.ok, true);
  assert.deepEqual(res.profile.options, {},
    'an option the template never mentions must not be frozen into it (#163, one level up again)');
});

// The reason every scope needs an explicit set-marker: an option whose default is ON can only be turned
// off by STORING the false, and "explicitly empty" is a different statement from "not set".
test('a template can say `false` and `""` — they are values, not absences', () => {
  const res = profiles.validateProfile({
    id: 't', name: 'T', backendId: 'claude',
    options: { mcpEmulation: false, model: '' }, env: {},
  });
  assert.equal(res.ok, true);
  assert.equal(res.profile.options.mcpEmulation, false);
  assert.equal(res.profile.options.model, '');
});

test('an option value that is not a scalar is refused', () => {
  const res = profiles.validateProfile({
    id: 't', name: 'T', backendId: 'codex', options: { model: { nested: 1 } }, env: {},
  });
  assert.equal(res.ok, false);
});

test('the descriptor carries the template\'s options, so the launch can layer them on top', () => {
  withProfiles([{ id: 'fast', name: 'Fast', backendId: 'codex', options: { sandbox: 'read-only' }, env: {} }], () => {
    assert.deepEqual(backends.get('fast').templateOptions, { sandbox: 'read-only' });
  });
});
