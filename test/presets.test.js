'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { PRESETS, MODEL_VARS, applyModel, getPreset } = require('../backends/presets');

const AXIS_A = PRESETS.filter(p => p.id !== 'anthropic');

test('all presets load with an env bundle', () => {
  assert.ok(PRESETS.length >= 4);
  for (const p of PRESETS) {
    assert.strictEqual(typeof p.id, 'string');
    assert.strictEqual(p.axis, 'A');
    assert.ok(p.env && typeof p.env === 'object');
  }
});

test('auth is a $VAR ref only — no literal high-entropy secret anywhere', () => {
  const looksLikeKey = (v) => typeof v === 'string' && !v.startsWith('$') && /^[A-Za-z0-9_\-]{24,}$/.test(v);
  for (const p of PRESETS) {
    for (const [k, v] of Object.entries(p.env)) {
      assert.ok(!looksLikeKey(v), `${p.id}.${k} looks like a literal secret: ${v}`);
    }
    // auth token, when present, is a $VAR reference
    if (p.env.ANTHROPIC_AUTH_TOKEN) {
      assert.ok(p.env.ANTHROPIC_AUTH_TOKEN.startsWith('$'), `${p.id} auth token must be a $VAR`);
    }
  }
});

test('every Axis-A endpoint preset blanks the inherited host ANTHROPIC_API_KEY', () => {
  for (const p of AXIS_A) {
    assert.strictEqual(p.env.ANTHROPIC_API_KEY, '', `${p.id} must blank the host key`);
  }
});

test('haiku model is redirected to the endpoint (no host-key leak)', () => {
  for (const p of AXIS_A) {
    assert.ok(p.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, `${p.id} sets a haiku model`);
    assert.ok(p.env.CLAUDE_CODE_SUBAGENT_MODEL, `${p.id} sets a subagent model`);
    // deprecated var must not be used
    assert.ok(!('ANTHROPIC_SMALL_FAST_MODEL' in p.env), `${p.id} must not use the deprecated small-fast var`);
  }
});

test('every preset sets both stability flags', () => {
  for (const p of PRESETS) {
    assert.strictEqual(p.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert.strictEqual(p.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, '1');
  }
});

test('model ids match 01-providers', () => {
  assert.strictEqual(getPreset('deepseek').env.ANTHROPIC_MODEL, 'deepseek-v4-pro');
  assert.strictEqual(getPreset('deepseek').env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-v4-flash');
  assert.strictEqual(getPreset('glm').env.ANTHROPIC_MODEL, 'glm-4.6');
  assert.strictEqual(getPreset('openrouter').env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api');
});

test('deepseek keeps the user_id EXTRA_BODY quirk', () => {
  assert.match(getPreset('deepseek').env.CLAUDE_CODE_EXTRA_BODY, /switchboard-deepseek/);
});

test('applyModel writes the whole model var set with haiku redirected', () => {
  const out = applyModel({ ANTHROPIC_BASE_URL: 'x' }, 'glm-5.2', 'glm-5.2-air');
  for (const v of MODEL_VARS) assert.ok(v in out, `${v} written`);
  assert.strictEqual(out.ANTHROPIC_MODEL, 'glm-5.2');
  assert.strictEqual(out.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-5.2-air');
  assert.strictEqual(out.CLAUDE_CODE_SUBAGENT_MODEL, 'glm-5.2-air');
  assert.strictEqual(out.ANTHROPIC_BASE_URL, 'x', 'unrelated vars preserved');
});

test('applyModel with empty model is a no-op (Anthropic passthrough)', () => {
  const out = applyModel({ A: '1' }, '', '');
  assert.deepStrictEqual(out, { A: '1' });
});
