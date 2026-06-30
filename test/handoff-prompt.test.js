const { test } = require('node:test');
const assert = require('node:assert');
const { DEFAULT_HANDOFF_PROMPT, fillHandoffPrompt, buildHandoffRequestPrompt } = require('../public/session-health.js');

test('DEFAULT_HANDOFF_PROMPT carries placeholders', () => {
  for (const ph of ['{goal}', '{project}', '{sessionId}', '{metrics}']) {
    assert.ok(DEFAULT_HANDOFF_PROMPT.includes(ph), `missing ${ph}`);
  }
});

test('fillHandoffPrompt substitutes placeholders from the session', () => {
  const out = fillHandoffPrompt(DEFAULT_HANDOFF_PROMPT, {
    name: 'Checkout refactor',
    projectPath: '/home/me/dev/shop',
    sessionId: 'abc-123',
  });
  assert.ok(out.includes('Checkout refactor'));
  assert.ok(out.includes('/home/me/dev/shop'));
  assert.ok(out.includes('abc-123'));
  assert.ok(!out.includes('{goal}') && !out.includes('{project}') && !out.includes('{sessionId}') && !out.includes('{metrics}'));
});

test('fillHandoffPrompt leaves a plain skill command unchanged', () => {
  assert.strictEqual(fillHandoffPrompt('/handoff', {}), '/handoff');
});

test('fillHandoffPrompt falls back for missing fields', () => {
  const out = fillHandoffPrompt('{goal} | {project} | {sessionId}', {});
  assert.strictEqual(out, 'the current task | unknown | unknown');
});

test('buildHandoffRequestPrompt equals the filled default template', () => {
  const session = { name: 'X', projectPath: '/p', sessionId: 's1' };
  assert.strictEqual(buildHandoffRequestPrompt(session), fillHandoffPrompt(DEFAULT_HANDOFF_PROMPT, session));
});
