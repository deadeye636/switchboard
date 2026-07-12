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

// --- per-backend prompt + the slash-command safety net -------------------------------------------
// The prompt is typed INTO the running agent. A slash command is a Claude skill; typed into Codex, Pi
// or Hermes it is merely text — the agent answers nothing useful, and the capture step would then offer
// its PREVIOUS message as the "fresh" packet. Silently wrong, which is the one thing this must not do.

const { resolveHandoffPrompt } = require('../public/session-health.js');

const CLAUDE = { id: 'claude', label: 'Claude Code' };
const CODEX = { id: 'codex', label: 'Codex' };

// The rule, and nothing more: the backend's own prompt, else the global one, else the built-in default.
// A slash command is that CLI's own — /handoff is a Claude skill and does not exist in Codex just because
// Codex also has skills — but the app does not second-guess that. The per-backend field IS how the user
// says what each CLI should be sent; a command that is wrong there is fixed there.

test("a backend's own prompt wins over the global one", () => {
  const p = resolveHandoffPrompt(CODEX, {
    handoffPrompt: 'global text',
    handoffPromptByBackend: { codex: 'codex-specific text' },
  });
  assert.strictEqual(p, 'codex-specific text');
});

test('without an override, the global prompt is used', () => {
  assert.strictEqual(resolveHandoffPrompt(CODEX, { handoffPrompt: 'global text' }), 'global text');
});

test('without either, the built-in default is used', () => {
  assert.strictEqual(resolveHandoffPrompt(CODEX, {}), DEFAULT_HANDOFF_PROMPT);
  assert.strictEqual(resolveHandoffPrompt(CODEX, { handoffPrompt: '   ' }), DEFAULT_HANDOFF_PROMPT);
  assert.strictEqual(resolveHandoffPrompt(CODEX, { handoffPromptByBackend: { codex: '  ' }, handoffPrompt: 'g' }), 'g');
});

test('a slash command is sent as written — to whichever backend it was set for', () => {
  assert.strictEqual(resolveHandoffPrompt(CLAUDE, { handoffPrompt: '/handoff' }), '/handoff');
  assert.strictEqual(
    resolveHandoffPrompt(CODEX, { handoffPromptByBackend: { codex: '/prompts:handoff' } }),
    '/prompts:handoff',
    "Codex gets Codex's command, because that is what the user put there",
  );
});

test('a global slash command reaches every backend — the user decides, not us', () => {
  // Deliberate: we do NOT rewrite it for Codex. If /handoff does not exist there, that is for the user
  // to fix on Codex's page. Silently substituting a different prompt would be worse than being wrong.
  assert.strictEqual(resolveHandoffPrompt(CODEX, { handoffPrompt: '/handoff' }), '/handoff');
});
