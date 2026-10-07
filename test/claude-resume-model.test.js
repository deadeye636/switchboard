// #754 T5: Claude's `resumeLaunchOptions` — the model a resume launches on.
//
// The hook reads one bounded ASYNC tail of the transcript first (the tail fold skips subagent and errored
// turns), falls back to the cached row only where the tail names no model, and takes `[1m]` from the same
// decision `contextWindow` uses. Fixtures are built in a temp directory; nothing here touches a real home or a real transcript.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const claude = require('../src/backends/claude');
const { MAX_TAIL_BYTES } = require('../src/backends/file-store');

let home;
let seq = 0;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-resume-model-'));
  fs.mkdirSync(path.join(home, 'projects'), { recursive: true });
  claude.setRoots([path.join(home, 'projects')]);
});
after(() => {
  claude.setRoots([path.join(os.tmpdir(), 'sb-resume-model-unused', 'projects')]);
  fs.rmSync(home, { recursive: true, force: true });
});

// An env layer that shields the test from an ANTHROPIC_MODEL in the process it runs in.
const NO_ENV = { ANTHROPIC_MODEL: '' };

const j = (o) => JSON.stringify(o);
const assistant = (model, extra = {}) => j({
  type: 'assistant', timestamp: '2026-10-01T10:00:00.000Z',
  message: { model, usage: { input_tokens: 100, output_tokens: 5 } }, ...extra,
});
const modelCmd = (spec) => j({
  type: 'user', timestamp: '2026-10-01T10:01:00.000Z',
  message: { role: 'user', content: `<command-name>/model</command-name><command-args>${spec}</command-args>` },
});
const HOUR_AGO = () => new Date(Date.now() - 3600 * 1000).toISOString();

/** A fresh project dir + transcript with `lines`; returns the row a cached session would have. */
function fixture(lines, row = {}) {
  const dir = path.join(home, `p${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 's.jsonl');
  fs.writeFileSync(filePath, lines.length ? lines.join('\n') + '\n' : '');
  return { projectPath: dir, filePath, sessionId: 's', folder: 'f', modified: new Date(Date.now() + 60000).toISOString(), ...row };
}
const ask = (row, ctx = {}) => claude.resumeLaunchOptions(row, { env: NO_ENV, ...ctx });
const modelOf = (answer) => answer && answer.options.model;
const filler = (c) => j({ type: 'summary', summary: c.repeat(1000) });
const overCap = (c) => Array.from({ length: Math.ceil(MAX_TAIL_BYTES / filler(c).length) + 20 }, () => filler(c));

test('the last assistant turn names the model; the answer is a patch with a label', async () => {
  const row = fixture([assistant('claude-haiku-4-5-20251001'), assistant('claude-opus-4-6-20251101')]);
  assert.deepEqual(await ask(row), { options: { model: 'claude-opus-4-6-20251101' }, label: 'claude-opus-4-6-20251101' });
});

test('a <synthetic> turn is skipped', async () => {
  const row = fixture([assistant('claude-haiku-4-5-20251001'), assistant('<synthetic>')]);
  assert.equal(modelOf(await ask(row)), 'claude-haiku-4-5-20251001');
});

test('an errored turn and a zero-usage turn are skipped (O8)', async () => {
  const row = fixture([
    assistant('claude-haiku-4-5-20251001'),
    assistant('claude-opus-4-6', { isApiErrorMessage: true }),
    j({ type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 0, output_tokens: 0 } } }),
    j({ type: 'assistant', message: { model: 'claude-sonnet-4-6' } }),
  ]);
  assert.equal(modelOf(await ask(row)), 'claude-haiku-4-5-20251001');
});

test('a subagent line in the transcript does not change the answer', async () => {
  const row = fixture([assistant('claude-haiku-4-5-20251001'), assistant('claude-opus-4-6', { isSidechain: true })]);
  assert.equal(modelOf(await ask(row)), 'claude-haiku-4-5-20251001');
});

test('a /model typed after the last turn wins (O7), as the alias the user typed', async () => {
  const row = fixture([assistant('claude-haiku-4-5-20251001'), modelCmd('sonnet')]);
  assert.equal(modelOf(await ask(row)), 'sonnet');
});

test('a /model with no argument (the picker) names nothing, so the last turn stands', async () => {
  const row = fixture([assistant('claude-haiku-4-5-20251001'), modelCmd('sonnet'), modelCmd('')]);
  assert.equal(modelOf(await ask(row)), 'claude-haiku-4-5-20251001');
});

test('no model anywhere, a missing file and a non-Claude model all answer null', async () => {
  assert.equal(await ask(fixture([])), null);
  assert.equal(await ask({ projectPath: home, filePath: path.join(home, 'gone.jsonl'), sessionId: 'x', folder: 'f' }), null);
  assert.equal(await ask(fixture([assistant('gpt-5.6-luna')])), null);
  assert.equal(await ask(null), null);
  assert.equal(await ask({}), null);
});

test('a hostile model string never reaches the launch', async () => {
  assert.equal(await ask(fixture([assistant('claude-opus-4-6; calc')])), null);
});

// ── [1m] ──────────────────────────────────────────────────────────────────────────────────────────────

test('[1m] from a /model spec on a model whose bare window is 200k', async () => {
  const row = fixture([assistant('claude-opus-4-6'), modelCmd('claude-opus-4-6[1m]')]);
  assert.equal(modelOf(await ask(row)), 'claude-opus-4-6[1m]');
});

test('[1m] from the launch model option, keeping the canonical id rather than a dated one', async () => {
  const row = fixture([assistant('claude-sonnet-4-6-20251001')]);
  assert.equal(modelOf(await ask(row, { launchOptions: { model: 'claude-sonnet-4-6[1m]' } })), 'claude-sonnet-4-6[1m]');
});

test('[1m] from ANTHROPIC_MODEL in the launch env', async () => {
  const row = fixture([assistant('claude-sonnet-4-6')]);
  assert.equal(modelOf(await ask(row, { env: { ANTHROPIC_MODEL: 'claude-sonnet-4-6[1m]' } })), 'claude-sonnet-4-6[1m]');
});

test('[1m] from the project settings, read asynchronously', async () => {
  const row = fixture([assistant('claude-opus-4-6')]);
  fs.mkdirSync(path.join(row.projectPath, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(row.projectPath, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus-4-6[1m]' }));
  assert.equal(modelOf(await ask(row)), 'claude-opus-4-6[1m]');
});

test('no suffix where the bare spec already runs at 1M, or the variant is not offered', async () => {
  // T1: bare claude-opus-5-5 is 1M; an unknown claude-* id counts 1M; haiku has no 1M variant.
  const cases = [['claude-opus-5-5', 'claude-opus-5-5[1m]'], ['claude-fable-9', 'claude-fable-9[1m]'],
    ['claude-haiku-4-5-20251001', 'claude-haiku-4-5[1m]']];
  for (const [model, spec] of cases) {
    const row = fixture([assistant(model)]);
    assert.equal(modelOf(await ask(row, { launchOptions: { model: spec } })), model, `${model} with ${spec}`);
  }
});

test('no suffix without a spec that says it, even for a 200k-base model', async () => {
  assert.equal(modelOf(await ask(fixture([assistant('claude-opus-4-6')]))), 'claude-opus-4-6');
});

// ── the tail first, the row second ───────────────────────────────────────────────────────────────────

test('the tail beats the row, however fresh the row is', async () => {
  const row = fixture([assistant('claude-haiku-4-5-20251001')], { lastModel: 'claude-opus-4-6', lastModelSpec: null });
  assert.equal(modelOf(await ask(row)), 'claude-haiku-4-5-20251001');
});

test('a row whose lastModel came from a subagent turn does not win: the main chain does', async () => {
  const row = fixture([assistant('claude-haiku-4-5-20251001'), assistant('claude-opus-4-6', { isSidechain: true })],
    { lastModel: 'claude-opus-4-6' });
  assert.equal(modelOf(await ask(row)), 'claude-haiku-4-5-20251001');
});

test('the row answers where the file is missing', async () => {
  const row = fixture([], { lastModel: 'claude-opus-4-6', lastModelSpec: null });
  assert.equal(modelOf(await ask({ ...row, filePath: path.join(home, 'gone.jsonl') })), 'claude-opus-4-6');
});

test('a row /model spec carries [1m] where the tail is silent', async () => {
  const row = fixture([], { lastModel: 'claude-opus-4-6', lastModelSpec: 'claude-opus-4-6[1m]' });
  assert.equal(modelOf(await ask(row)), 'claude-opus-4-6[1m]');
});

test('an errored last turn with a real model and usage is skipped, row or not', async () => {
  const row = fixture([assistant('claude-haiku-4-5-20251001'), assistant('claude-opus-4-6', { isApiErrorMessage: true })],
    { lastModel: 'claude-opus-4-6' });
  assert.equal(modelOf(await ask(row)), 'claude-haiku-4-5-20251001');
});

test('a single last line longer than MAX_TAIL_BYTES yields no tail model: the row stands in, nothing throws', async () => {
  const huge = j({ type: 'assistant', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 5 }, content: 'q'.repeat(MAX_TAIL_BYTES + 100) } });
  const row = fixture([huge], { lastModel: 'claude-opus-4-6' });
  assert.equal(modelOf(await ask(row)), 'claude-opus-4-6');
  assert.equal(await ask(fixture([huge])), null);
});

// ── /model specs with no Claude window (O7) ─────────────────────────────────────────────────────────────

test('/model default hands the choice back to the CLI: null', async () => {
  assert.equal(await ask(fixture([assistant('claude-haiku-4-5-20251001'), modelCmd('default')])), null);
});

test('/model opusplan has no window and is passed through as typed', async () => {
  const answer = await ask(fixture([assistant('claude-haiku-4-5-20251001'), modelCmd('opusplan')]));
  assert.deepEqual(answer, { options: { model: 'opusplan' }, label: 'opusplan' });
});

test('a hostile /model spec with no window never reaches the launch', async () => {
  assert.equal(await ask(fixture([assistant('claude-haiku-4-5-20251001'), modelCmd('opusplan;x')])), null);
});

test('no [1m] for a model without the variant, even when the floor says the session ran large', async () => {
  const big = j({ type: 'assistant', message: { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 250000, output_tokens: 5 } } });
  const row = fixture([big]);
  assert.equal(modelOf(await ask(row, { launchOptions: { model: 'claude-haiku-4-5[1m]' } })), 'claude-haiku-4-5-20251001');
  assert.equal(modelOf(await ask(row)), 'claude-haiku-4-5-20251001');
});

test('a transcript newer than its row is read, and its answer beats the stale row', async () => {
  const row = fixture([assistant('claude-haiku-4-5-20251001')], { lastModel: 'claude-opus-4-6', modified: HOUR_AGO() });
  assert.equal(modelOf(await ask(row)), 'claude-haiku-4-5-20251001');
});

test('the tail window is capped: a model further back than MAX_TAIL_BYTES is not found, the row stands in', async () => {
  const lines = [assistant('claude-haiku-4-5-20251001'), ...overCap('x')];
  assert.equal(await ask(fixture(lines)), null, 'no row model and none inside the window');
  const stale = fixture(lines, { lastModel: 'claude-opus-4-6', modified: HOUR_AGO() });
  assert.equal(modelOf(await ask(stale)), 'claude-opus-4-6', 'the row answers where the tail is silent');
});

test('a tail cut mid-line still finds the last turn', async () => {
  const lines = [...overCap('y'), assistant('claude-opus-4-6-20251101')];
  assert.equal(modelOf(await ask(fixture(lines))), 'claude-opus-4-6-20251101');
});

test('a /model before the tail window keeps its [1m] while it names the tail\'s model', async () => {
  const lines = [...overCap('z'), assistant('claude-opus-4-6')];
  const row = fixture(lines, { lastModel: null, lastModelSpec: 'claude-opus-4-6[1m]' });
  assert.equal(modelOf(await ask(row)), 'claude-opus-4-6[1m]');
});
