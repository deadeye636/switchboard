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

const CLAUDE = { id: 'claude', label: 'Claude Code', slashCommands: true };
const CODEX = { id: 'codex', label: 'Codex', slashCommands: true };   // Codex has slash commands + skills too
const AGY = { id: 'agy', label: 'Antigravity CLI', slashCommands: false };  // unbuilt: we know nothing

test('a backend override beats the global prompt', () => {
  const r = resolveHandoffPrompt(CODEX, {
    handoffPrompt: 'global text',
    handoffPromptByBackend: { codex: 'codex-specific text' },
  });
  assert.strictEqual(r.prompt, 'codex-specific text');
  assert.strictEqual(r.usedFallback, false);
});

test('no override falls back to the global prompt, then to the built-in default', () => {
  assert.strictEqual(resolveHandoffPrompt(CODEX, { handoffPrompt: 'global text' }).prompt, 'global text');
  assert.strictEqual(resolveHandoffPrompt(CODEX, {}).prompt, DEFAULT_HANDOFF_PROMPT);
  assert.strictEqual(resolveHandoffPrompt(CODEX, { handoffPrompt: '   ' }).prompt, DEFAULT_HANDOFF_PROMPT);
});

// Every shipped CLI has slash commands — but the COMMANDS are each CLI's own. `/handoff` is a Claude
// skill; it does not exist in Codex merely because Codex also has skills. Typed there, the agent answers
// nothing useful (or "unknown command"), and the capture step would offer THAT as the handoff packet.

test('a global slash command reaches the agent it was written for (the default)', () => {
  const r = resolveHandoffPrompt(CLAUDE, { handoffPrompt: '/handoff' }, { defaultBackendId: 'claude' });
  assert.strictEqual(r.prompt, '/handoff');
  assert.strictEqual(r.usedFallback, false);
});

test('a global slash command is NOT typed into a DIFFERENT agent — its commands are its own', () => {
  const r = resolveHandoffPrompt(CODEX, { handoffPrompt: '/handoff' }, { defaultBackendId: 'claude' });
  assert.strictEqual(r.prompt, DEFAULT_HANDOFF_PROMPT, 'the prose default goes out instead');
  assert.strictEqual(r.usedFallback, true);
  assert.match(r.reason, /\/handoff/);
  assert.match(r.reason, /Codex/, 'and it names the backend the user has to fix it on');
});

test("...unless the user set that backend's OWN slash command — then it is exactly what they chose", () => {
  const r = resolveHandoffPrompt(CODEX, {
    handoffPrompt: '/handoff',
    handoffPromptByBackend: { codex: '/prompts:handoff' },   // a real Codex-side command
  }, { defaultBackendId: 'claude' });
  assert.strictEqual(r.prompt, '/prompts:handoff');
  assert.strictEqual(r.usedFallback, false);
});

test('a backend with no slash-command surface at all never gets one typed into it', () => {
  const r = resolveHandoffPrompt(AGY, { handoffPrompt: '/handoff' }, { defaultBackendId: 'agy' });
  assert.strictEqual(r.usedFallback, true);
  assert.match(r.reason, /no slash commands/i);
});

test('a prompt that merely CONTAINS a slash is not a command', () => {
  const r = resolveHandoffPrompt(CODEX, { handoffPrompt: 'Summarise the work in src/app.js' }, { defaultBackendId: 'claude' });
  assert.strictEqual(r.usedFallback, false);
  assert.match(r.prompt, /src\/app\.js/);
});
