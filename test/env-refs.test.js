'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveEnv, resolveEnvRefs, missingRefsMessage, isEnvRef, refVarName } = require('../src/backends/env-refs');

test('literal values are kept verbatim', () => {
  const host = {};
  const out = resolveEnv({ ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', MODEL: 'glm-4.6' }, host);
  assert.deepStrictEqual(out, {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    MODEL: 'glm-4.6',
  });
});

test('empty-string literal is kept (used to clear a stale var)', () => {
  const out = resolveEnv({ ANTHROPIC_API_KEY: '' }, { ANTHROPIC_API_KEY: 'leaked-host-key' });
  assert.strictEqual(out.ANTHROPIC_API_KEY, '', 'empty literal must survive to blank the inherited var');
  assert.ok('ANTHROPIC_API_KEY' in out);
});

test('$VAR reference resolves to the host value', () => {
  const out = resolveEnv({ ANTHROPIC_AUTH_TOKEN: '$DEEPSEEK_API_KEY' }, { DEEPSEEK_API_KEY: 'sk-abc123' });
  assert.strictEqual(out.ANTHROPIC_AUTH_TOKEN, 'sk-abc123');
});

test('${VAR} braced form resolves', () => {
  const out = resolveEnv({ TOKEN: '${MY_TOKEN}' }, { MY_TOKEN: 'val' });
  assert.strictEqual(out.TOKEN, 'val');
});

test('missing $VAR is dropped, never leaks the literal "$VAR"', () => {
  const out = resolveEnv({ ANTHROPIC_AUTH_TOKEN: '$NOT_SET' }, {});
  assert.ok(!('ANTHROPIC_AUTH_TOKEN' in out), 'unresolved ref must be dropped');
});

// --- and it is SAID (#169) -------------------------------------------------------------------------
//
// The drop above is right and stays. What was wrong is that it happened in SILENCE: a template pointed at
// another provider whose key is not set launched happily, the key simply absent, and the user was left
// with a provider auth error that named nothing. The check existed — it just ran in the EDITOR, where
// nothing is at stake, and said nothing at the spawn, where it costs a session.

test('a dropped ref is REPORTED — the key it was for, and the variable that was missing', () => {
  const { env, missing } = resolveEnvRefs({
    ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',   // literal: fine
    ANTHROPIC_AUTH_TOKEN: '$ZAI_KEY',                        // set: resolves
    OPENAI_API_KEY: '$NOT_SET',                              // unset: dropped, and named
    EMPTY_ONE: '$BLANK',                                     // empty is unset
  }, { ZAI_KEY: 'secret', BLANK: '' });

  assert.deepStrictEqual(env, {
    ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'secret',
  });
  assert.deepStrictEqual(missing, [
    { key: 'OPENAI_API_KEY', varName: 'NOT_SET' },
    { key: 'EMPTY_ONE', varName: 'BLANK' },
  ]);
});

test('nothing missing is nothing to say', () => {
  assert.deepStrictEqual(resolveEnvRefs({ A: 'literal' }, {}).missing, []);
  assert.strictEqual(missingRefsMessage([], 'Template'), null);
  assert.strictEqual(missingRefsMessage(null, 'Template'), null);
});

test('the message names the variable AND whose bundle it was — three templates can want three keys', () => {
  const one = missingRefsMessage([{ key: 'OPENAI_API_KEY', varName: 'OPENAI_KEY' }], 'GLM 4.6');
  assert.match(one, /GLM 4\.6/, 'without the source, "OPENAI_KEY is not set" is a riddle');
  assert.match(one, /\$OPENAI_KEY/);
  assert.match(one, /is not set/);
  assert.match(one, /authenticate/, 'and it says what will go wrong, not just what happened');

  const two = missingRefsMessage(
    [{ key: 'A', varName: 'ONE' }, { key: 'B', varName: 'TWO' }], 'Launcher');
  assert.match(two, /\$ONE, \$TWO are not set/);
});

test('the same variable referenced twice is named once', () => {
  const msg = missingRefsMessage(
    [{ key: 'A', varName: 'KEY' }, { key: 'B', varName: 'KEY' }], 'T');
  assert.strictEqual((msg.match(/\$KEY/g) || []).length, 1);
});

test('resolveEnv still returns just the env — the callers that have nothing to say are unchanged', () => {
  assert.deepStrictEqual(resolveEnv({ A: '$X', B: 'lit' }, { X: 'v' }), { A: 'v', B: 'lit' });
});

test('no spawn path in main.js resolves an env bundle in silence', () => {
  // There were THREE of them — the external launcher, the in-app launcher, the backend PTY — and all
  // three called resolveEnv() bare and inspected nothing. A fourth would be added the same way. So: in
  // main.js, the resolution goes through resolveSpawnEnv(), which says what it dropped.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

  const bare = src.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /(?<!function\s)\bresolveEnv\s*\(/.test(line))
    .filter(({ line }) => !line.trim().startsWith('//') && !line.trim().startsWith('*'));

  assert.deepStrictEqual(bare.map(b => `main.js:${b.n} ${b.line.trim()}`), [],
    'a spawn that drops a $VAR without saying so leaves the user with an auth error that names nothing');
  assert.match(src, /function resolveSpawnEnv\(/);
});

test('empty host value is treated as unset -> dropped', () => {
  const out = resolveEnv({ TOKEN: '$EMPTY' }, { EMPTY: '' });
  assert.ok(!('TOKEN' in out), 'ref to an empty host var must drop, not emit ""');
});

test('mixed bundle: literals kept, refs resolved, missing dropped', () => {
  const out = resolveEnv({
    ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    ANTHROPIC_AUTH_TOKEN: '$ZAI_API_KEY',
    ANTHROPIC_API_KEY: '',
    MISSING: '$NOPE',
  }, { ZAI_API_KEY: 'zk-1' });
  assert.deepStrictEqual(out, {
    ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'zk-1',
    ANTHROPIC_API_KEY: '',
  });
});

test('a value with surrounding text is a literal, not a ref', () => {
  const out = resolveEnv({ X: 'prefix-$VAR' }, { VAR: 'v' });
  assert.strictEqual(out.X, 'prefix-$VAR', 'only a whole-string $VAR is a reference');
});

test('resolveEnv defaults to process.env when no host given', () => {
  process.env.__ENVREFS_TEST__ = 'here';
  try {
    const out = resolveEnv({ V: '$__ENVREFS_TEST__' });
    assert.strictEqual(out.V, 'here');
  } finally {
    delete process.env.__ENVREFS_TEST__;
  }
});

test('resolveEnv tolerates null/undefined/non-object bundle', () => {
  assert.deepStrictEqual(resolveEnv(null), {});
  assert.deepStrictEqual(resolveEnv(undefined), {});
  assert.deepStrictEqual(resolveEnv('nope'), {});
});

test('isEnvRef / refVarName helpers', () => {
  assert.strictEqual(isEnvRef('$VAR'), true);
  assert.strictEqual(isEnvRef('${VAR}'), true);
  assert.strictEqual(isEnvRef(''), false);
  assert.strictEqual(isEnvRef('literal'), false);
  assert.strictEqual(isEnvRef('prefix-$VAR'), false);
  assert.strictEqual(isEnvRef(42), false);
  // mismatched braces are not refs (treated as literals; never leak)
  assert.strictEqual(isEnvRef('${VAR'), false);
  assert.strictEqual(isEnvRef('$VAR}'), false);
  assert.strictEqual(refVarName('$FOO'), 'FOO');
  assert.strictEqual(refVarName('${BAR}'), 'BAR');
  assert.strictEqual(refVarName('literal'), null);
});
