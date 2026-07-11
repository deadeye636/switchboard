'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveEnv, isEnvRef, refVarName } = require('../env-refs');

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
