'use strict';
// #486 — asking an agent for a plan.
//
// The mirror image of the handoff prompt, and deliberately smaller: the app writes no plan and reviews
// none. What it does is type a prompt, so the prompt is the whole feature — if it does not carry the
// convention, every CLI writes a plan in its own shape and the plans list fills with documents that
// agree about nothing.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_PLAN_PROMPT, resolvePlanPrompt, fillPromptTemplate, withDirHint, localDateStamp,
} = require('../src/renderer/session/session-health.js');

const CLAUDE = { id: 'claude', label: 'Claude Code' };
const CODEX = { id: 'codex', label: 'Codex' };
const DIRS = { planDir: '.plans', planPath: '/home/me/dev/shop/.plans' };

test('the default names the directory, the file shape and the header block', () => {
  for (const piece of ['{planPath}', '<date>-<slug>.md', 'status:', 'updated:', '{today}']) {
    assert.ok(DEFAULT_PLAN_PROMPT.includes(piece), `missing ${piece}`);
  }
  assert.match(DEFAULT_PLAN_PROMPT, /Do not implement/i, 'a plan is not the work');
});

test('the cascade: the backend\'s own prompt, else the global one, else the built-in', () => {
  assert.equal(resolvePlanPrompt(CODEX, {}), DEFAULT_PLAN_PROMPT);
  assert.equal(resolvePlanPrompt(CODEX, { planPrompt: 'global plan' }), 'global plan');
  assert.equal(
    resolvePlanPrompt(CODEX, { planPrompt: 'global plan', planPromptByBackend: { codex: 'codex plan' } }),
    'codex plan',
  );
  assert.equal(
    resolvePlanPrompt(CLAUDE, { planPrompt: 'global plan', planPromptByBackend: { codex: 'codex plan' } }),
    'global plan',
    'another backend is untouched',
  );
});

// The same trap #225 documented for handoffs: with no backend named, no per-backend override applies —
// and answering 'claude' there would hand Claude's wording, slash commands included, to a CLI that reads
// them as plain text.
test('no backend named binds no per-backend override', () => {
  const settings = { planPrompt: 'global plan', planPromptByBackend: { claude: 'claude plan' } };
  assert.equal(resolvePlanPrompt(null, settings), 'global plan');
  assert.equal(resolvePlanPrompt({}, settings), 'global plan');
});

test('a whitespace-only override falls through rather than sending whitespace', () => {
  assert.equal(resolvePlanPrompt(CODEX, { planPrompt: '   ' }), DEFAULT_PLAN_PROMPT);
  assert.equal(
    resolvePlanPrompt(CODEX, { planPrompt: 'global plan', planPromptByBackend: { codex: '  ' } }),
    'global plan',
  );
});

test('the plan directory and today are substituted', () => {
  const out = fillPromptTemplate(DEFAULT_PLAN_PROMPT, { ...DIRS, name: 'tariff end date', projectPath: '/home/me/dev/shop' });
  assert.ok(out.includes('/home/me/dev/shop/.plans'));
  assert.ok(out.includes('tariff end date'));
  assert.match(out, /updated: \d{4}-\d{2}-\d{2}/);
  assert.ok(!out.includes('{planPath}') && !out.includes('{today}') && !out.includes('{goal}'));
});

test('localDateStamp is the LOCAL day, not the UTC one', () => {
  // 2026-08-20 23:30 local. toISOString() would answer the 21st for anyone east of UTC — and date a plan
  // written on Thursday night as Friday.
  const evening = new Date(2026, 7, 20, 23, 30, 0);
  assert.equal(localDateStamp(evening), '2026-08-20');
  assert.equal(localDateStamp(new Date(2026, 0, 5, 0, 5, 0)), '2026-01-05', 'padded, both parts');
});

// A slash command is the CLI's own skill: it decides where it writes, and this line is the only say we
// have. The handoff side proved the mechanic; here it has to speak about plans rather than packets.
test('a slash-command plan prompt is told the plan directory, in its own words', () => {
  const hinted = withDirHint('/plan', DIRS, 'plan');
  assert.ok(hinted.startsWith('/plan'));
  assert.match(hinted, /plan directory/);
  assert.match(hinted, /write the plan there/);
  assert.match(hinted, /\{planPath\}/, 'the token, filled by the one substitution step');
  assert.ok(!hinted.includes('handoff'), 'the wrong noun here sends the plan to the packet directory');
  assert.match(fillPromptTemplate(hinted, DIRS), /\/home\/me\/dev\/shop\/\.plans/);
});

test('the plan kind reads plan dirs, not handoff dirs', () => {
  const handoffOnly = { handoffDir: '.handoffs', handoffPath: '/p/.handoffs' };
  assert.equal(withDirHint('/plan', handoffOnly, 'plan'), '/plan',
    'a project that answered only about handoffs says nothing about plans');
});

test('the default prompt is prose, so it is sent exactly as written', () => {
  assert.equal(withDirHint(DEFAULT_PLAN_PROMPT, DIRS, 'plan'), DEFAULT_PLAN_PROMPT);
});

test('an unknown kind appends nothing rather than guessing a noun', () => {
  assert.equal(withDirHint('/something', DIRS, 'sketch'), '/something');
});
