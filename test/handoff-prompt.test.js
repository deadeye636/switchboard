const { test } = require('node:test');
const assert = require('node:assert');
const { DEFAULT_HANDOFF_PROMPT, fillHandoffPrompt, buildHandoffRequestPrompt } = require('../src/renderer/session/session-health.js');

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

const { resolveHandoffPrompt } = require('../src/renderer/session/session-health.js');

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

// --- the two prompts (#148) -----------------------------------------------------------------------
// There are two ways to produce a handoff, so there are two prompts — and both are overridable globally
// and per backend. Conflating them is what let the library fill up with metadata skeletons.

const { DEFAULT_HANDOFF_READ_PROMPT } = require('../src/renderer/session/session-health.js');

test('the summarise prompt goes to the OLD agent; the read prompt goes to a NEW one', () => {
  const settings = {
    handoffPrompt: 'summarise what you hold',
    handoffReadPrompt: 'read {transcript} and summarise it',
  };
  assert.strictEqual(resolveHandoffPrompt(CODEX, settings, 'summarise'), 'summarise what you hold');
  assert.strictEqual(resolveHandoffPrompt(CODEX, settings, 'read'), 'read {transcript} and summarise it');
});

test('each prompt has its own per-backend override', () => {
  const settings = {
    handoffPrompt: 'global summarise',
    handoffReadPrompt: 'global read',
    handoffPromptByBackend: { codex: 'codex summarise' },
    handoffReadPromptByBackend: { codex: 'codex read' },
  };
  assert.strictEqual(resolveHandoffPrompt(CODEX, settings, 'summarise'), 'codex summarise');
  assert.strictEqual(resolveHandoffPrompt(CODEX, settings, 'read'), 'codex read');
  assert.strictEqual(resolveHandoffPrompt(CLAUDE, settings, 'summarise'), 'global summarise', 'another backend is untouched');
  assert.strictEqual(resolveHandoffPrompt(CLAUDE, settings, 'read'), 'global read');
});

test('both fall back to their own built-in default', () => {
  assert.strictEqual(resolveHandoffPrompt(CODEX, {}, 'summarise'), DEFAULT_HANDOFF_PROMPT);
  assert.strictEqual(resolveHandoffPrompt(CODEX, {}, 'read'), DEFAULT_HANDOFF_READ_PROMPT);
  assert.match(DEFAULT_HANDOFF_READ_PROMPT, /\{transcript\}/, 'the reader must be told WHAT to read');
});

test('{transcript} is filled with the path the new agent can actually open', () => {
  const filled = fillHandoffPrompt(DEFAULT_HANDOFF_READ_PROMPT, {
    sessionId: 's1', projectPath: '/p', transcriptPath: '/tmp/switchboard-handoff/s1.md',
  });
  assert.match(filled, /\/tmp\/switchboard-handoff\/s1\.md/);
  assert.ok(!filled.includes('{transcript}'));
});

// --- where the packet belongs (#485) -------------------------------------------------------------
// The prompt used to say nothing about a directory. That is fine while Switchboard captures the answer
// and writes the file itself — and wrong the moment the agent writes it, which is exactly what a skill
// behind a slash command does. Then the packet lands wherever that skill keeps its own, and the app looks
// in the project.

const { withHandoffDirHint, isSlashCommandPrompt } = require('../src/renderer/session/session-health.js');

const DIRS = { handoffDir: '.handoffs', handoffPath: '/home/me/dev/shop/.handoffs' };

test('{handoffDir} and {handoffPath} are filled from the caller', () => {
  const out = fillHandoffPrompt('write it to {handoffPath} ({handoffDir})', { ...DIRS });
  assert.strictEqual(out, 'write it to /home/me/dev/shop/.handoffs (.handoffs)');
});

test('the directory tokens resolve to empty when nobody could answer', () => {
  assert.strictEqual(fillHandoffPrompt('{handoffDir}|{handoffPath}', {}), '|');
});

test('isSlashCommandPrompt looks at the first non-empty line only', () => {
  assert.ok(isSlashCommandPrompt('/handoff'));
  assert.ok(isSlashCommandPrompt('\n\n  /handoff arg'));
  assert.ok(!isSlashCommandPrompt('Summarise the state.\nThen run /handoff'), 'a slash in prose is prose');
  assert.ok(!isSlashCommandPrompt(''));
});

test('a slash-command prompt is told the directory — as a token, filled by the one substitution step', () => {
  const hinted = withHandoffDirHint('/handoff', DIRS);
  assert.ok(hinted.startsWith('/handoff'), 'the command stays the first thing typed');
  assert.match(hinted, /\{handoffPath\}/, 'the line carries the token, not a path');
  assert.match(fillHandoffPrompt(hinted, { ...DIRS }), /\/home\/me\/dev\/shop\/\.handoffs/);
});

test('a prompt that is not a slash command is left alone', () => {
  assert.strictEqual(withHandoffDirHint(DEFAULT_HANDOFF_PROMPT, DIRS), DEFAULT_HANDOFF_PROMPT);
});

test('a slash command that already names the directory is left alone', () => {
  const own = '/handoff into {handoffDir}';
  assert.strictEqual(withHandoffDirHint(own, DIRS), own);
});

test('no directory known — nothing is appended', () => {
  assert.strictEqual(withHandoffDirHint('/handoff', {}), '/handoff');
  assert.strictEqual(withHandoffDirHint('/handoff'), '/handoff');
});

test('the relative directory is used when there is no absolute one', () => {
  assert.match(withHandoffDirHint('/handoff', { handoffDir: '.handoffs' }), /\{handoffDir\}/);
});
