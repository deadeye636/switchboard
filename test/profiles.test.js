'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profiles = require('../src/backends/profiles');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proftest-'));
  return path.join(dir, 'profiles.json');
}

test('save + list + get round-trip', () => {
  profiles._configureForTests({ filePath: tmpFile() });
  const r = profiles.save({ id: 'ds', name: 'DeepSeek', icon: 'deepseek',
    env: { ANTHROPIC_AUTH_TOKEN: '$DEEPSEEK_API_KEY', ANTHROPIC_API_KEY: '' } });
  assert.ok(r.ok, r.error);
  assert.strictEqual(profiles.list().length, 1);
  assert.deepStrictEqual(profiles.get('ds').env.ANTHROPIC_AUTH_TOKEN, '$DEEPSEEK_API_KEY');
});

test('validation: bad id / name / env rejected', () => {
  profiles._configureForTests({ filePath: tmpFile() });
  assert.ok(!profiles.save({ id: 'bad id!', name: 'x', env: {} }).ok);
  assert.ok(!profiles.save({ id: 'ok', name: '', env: {} }).ok);
  assert.ok(!profiles.save({ id: 'ok', name: 'n', env: { '1bad': 'x' } }).ok);
  assert.ok(!profiles.save({ id: 'ok', name: 'n', env: { GOOD: 123 } }).ok);
});

test('secret hardening: a pasted raw key is blocked', () => {
  profiles._configureForTests({ filePath: tmpFile() });
  const r = profiles.save({ id: 'leak', name: 'Leak',
    env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789' } });
  assert.ok(!r.ok, 'raw key must be rejected');
  assert.ok(Array.isArray(r.secretKeys) && r.secretKeys.includes('ANTHROPIC_AUTH_TOKEN'));
});

test('secret hardening: $VAR ref and normal literals pass', () => {
  profiles._configureForTests({ filePath: tmpFile() });
  const r = profiles.save({ id: 'ok', name: 'OK', env: {
    ANTHROPIC_AUTH_TOKEN: '$MY_KEY',
    ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
    ANTHROPIC_MODEL: 'anthropic/claude-sonnet-4.6',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/claude-haiku-latest',
    ANTHROPIC_API_KEY: '',
  } });
  assert.ok(r.ok, r.error);
});

// --- auth-named vars: ANY literal is a secret (catches JWT/AWS/short keys an entropy check misses)

test('secret hardening: an auth-NAMED var rejects any literal, whatever its shape', () => {
  profiles._configureForTests({ filePath: tmpFile() });
  // JWT (dots) — slipped through a punctuation-based entropy heuristic
  assert.ok(!profiles.save({ id: 'a', name: 'A',
    env: { ANTHROPIC_AUTH_TOKEN: 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4' } }).ok);
  // AWS-style base64 with a slash
  assert.ok(!profiles.save({ id: 'b', name: 'B',
    env: { MY_SECRET_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' } }).ok);
  // short key
  assert.ok(!profiles.save({ id: 'c', name: 'C', env: { OPENAI_API_KEY: 'sk-short123' } }).ok);
  // but a $VAR ref and the deliberate blank are fine
  assert.ok(profiles.save({ id: 'd', name: 'D',
    env: { ANTHROPIC_AUTH_TOKEN: '$TOK', ANTHROPIC_API_KEY: '' } }).ok);
});

test('looksLikeRawSecret: a non-auth var still flags obvious tokens but never a model id', () => {
  // model ids / URLs must never be flagged (they would block a legitimate save)
  assert.strictEqual(profiles.looksLikeRawSecret('meta-llama/llama-3.1-405b-instruct', 'ANTHROPIC_MODEL'), false);
  assert.strictEqual(profiles.looksLikeRawSecret('anthropic/claude-sonnet-4.6', 'ANTHROPIC_MODEL'), false);
  assert.strictEqual(profiles.looksLikeRawSecret('https://api.z.ai/api/anthropic', 'ANTHROPIC_BASE_URL'), false);
  assert.strictEqual(profiles.looksLikeRawSecret('3000000', 'API_TIMEOUT_MS'), false);
  assert.strictEqual(profiles.looksLikeRawSecret('{"metadata":{"user_id":"switchboard-deepseek"}}', 'CLAUDE_CODE_EXTRA_BODY'), false);
  // ...but a token pasted into a non-auth-named row is still caught
  assert.strictEqual(profiles.looksLikeRawSecret('ghp_abcdefghijklmnopqrstuvwxyz0123', 'SOMETHING'), true);
  assert.strictEqual(profiles.looksLikeRawSecret('abcdefghij0123456789klmnopqrst', 'SOMETHING'), true);
});

// --- Axis-A host-key-leak lint (a security bug, so it is a hard block, not a confirmable warning)

test('leak lint: an endpoint profile that does not blank ANTHROPIC_API_KEY is blocked', () => {
  profiles._configureForTests({ filePath: tmpFile() });
  const r = profiles.save({ id: 'leaky', name: 'Leaky', env: {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: '$DEEPSEEK_API_KEY',
    // ANTHROPIC_API_KEY not blanked -> the host key would be sent to DeepSeek
  } });
  assert.ok(!r.ok);
  assert.strictEqual(r.leak, true);
  assert.match(r.error, /ANTHROPIC_API_KEY/);
});

test('leak lint: redirecting the main model but not haiku is blocked', () => {
  profiles._configureForTests({ filePath: tmpFile() });
  const r = profiles.save({ id: 'nohaiku', name: 'NoHaiku', env: {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: 'deepseek-v4-pro',
  } });
  assert.ok(!r.ok);
  assert.match(r.error, /haiku/i);
});

test('leak lint: NOT bypassable by allowSecrets (a different decision)', () => {
  profiles._configureForTests({ filePath: tmpFile() });
  const r = profiles.save({ id: 'x', name: 'X', env: {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: '$K',
  } }, { allowSecrets: true });
  assert.ok(!r.ok, 'acknowledging a secret must not also acknowledge leaking the host key');
});

test('leak lint: a plain profile (no endpoint redirect) is unaffected', () => {
  profiles._configureForTests({ filePath: tmpFile() });
  assert.ok(profiles.save({ id: 'plain', name: 'Plain', env: { FOO: 'bar' } }).ok);
});

// --- reserved ids

test('a profile may not shadow a built-in backend id', () => {
  profiles._configureForTests({ filePath: tmpFile() });
  for (const id of ['claude', 'codex', 'agy', 'hermes', 'pi']) {
    const r = profiles.save({ id, name: 'Shadow', env: {} });
    assert.ok(!r.ok, `${id} must be rejected`);
    assert.match(r.error, /built-in/);
  }
  assert.ok(profiles.save({ id: 'my-claude', name: 'Mine', env: {} }).ok, 'a non-reserved id is fine');
});

test('secret hardening: allowSecrets override lets a literal through', () => {
  profiles._configureForTests({ filePath: tmpFile() });
  const r = profiles.save({ id: 'ovr', name: 'Override',
    env: { TOKEN: 'abcdefghijklmnopqrstuvwxyz0123456789' } }, { allowSecrets: true });
  assert.ok(r.ok, r.error);
});

test('looksLikeRawSecret heuristic', () => {
  assert.strictEqual(profiles.looksLikeRawSecret('sk-ant-abcdefghijklmnopqrstuvwxyz0123'), true);
  assert.strictEqual(profiles.looksLikeRawSecret('$VAR'), false);
  assert.strictEqual(profiles.looksLikeRawSecret(''), false);
  assert.strictEqual(profiles.looksLikeRawSecret('https://api.deepseek.com/anthropic'), false);
  assert.strictEqual(profiles.looksLikeRawSecret('anthropic/claude-sonnet-4.6'), false);
  assert.strictEqual(profiles.looksLikeRawSecret('glm-4.6'), false);
});

test('cap at MAX_PROFILES', () => {
  profiles._configureForTests({ filePath: tmpFile() });
  for (let i = 0; i < profiles.MAX_PROFILES; i++) {
    assert.ok(profiles.save({ id: 'p' + i, name: 'P' + i, env: {} }).ok);
  }
  assert.ok(!profiles.save({ id: 'over', name: 'Over', env: {} }).ok, 'cap enforced');
});

test('default get/set + remove clears default', () => {
  profiles._configureForTests({ filePath: tmpFile() });
  profiles.save({ id: 'a', name: 'A', env: {} });
  assert.ok(profiles.setDefault('a').ok);
  assert.strictEqual(profiles.getDefault(), 'a');
  assert.ok(!profiles.setDefault('missing').ok);
  profiles.remove('a');
  assert.strictEqual(profiles.getDefault(), null);
});

test('pickProfileForSession 3-state', () => {
  profiles._configureForTests({ filePath: tmpFile() });
  profiles.save({ id: 'def', name: 'Def', env: { X: '1' } });
  profiles.setDefault('def');
  assert.strictEqual(profiles.pickProfileForSession('none'), null);
  assert.strictEqual(profiles.pickProfileForSession('def').id, 'def');
  assert.strictEqual(profiles.pickProfileForSession(undefined).id, 'def'); // global default
  assert.strictEqual(profiles.pickProfileForSession('missing'), null);
});

test('atomic load drops junk + persists across reload', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    profiles: [
      { id: 'good', name: 'Good', env: { X: '1' } },
      { id: 'bad id!', name: 'x', env: {} },
      'nope',
    ],
    defaultProfileId: 'good',
  }));
  profiles._configureForTests({ filePath: file });
  assert.deepStrictEqual(profiles.list().map(p => p.id), ['good']);
  assert.strictEqual(profiles.getDefault(), 'good');
});

test('resolveEnvForProfile resolves $VAR at read time', () => {
  profiles._configureForTests({ filePath: tmpFile() });
  process.env.__PROF_TEST_KEY__ = 'resolved-secret';
  try {
    profiles.save({ id: 'r', name: 'R', env: { ANTHROPIC_AUTH_TOKEN: '$__PROF_TEST_KEY__', MISSING: '$__NOPE__' } });
    const env = profiles.resolveEnvForProfile('r');
    assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, 'resolved-secret');
    assert.ok(!('MISSING' in env), 'unresolved ref dropped');
  } finally {
    delete process.env.__PROF_TEST_KEY__;
  }
});
