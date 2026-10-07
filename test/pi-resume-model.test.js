// #754 T7: Pi's `resumeLaunchOptions` — the provider + model a resume launches on.
//
// Decided by FILE ORDER across `model_change` and assistant entries (a resume with `--model` leaves a stale
// `model_change` behind); an errored or zero-usage assistant turn never ran (O8). Fixtures live in a temp directory.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pi = require('../src/backends/pi');
const piNative = require('../src/backends/pi-native');
const backends = require('../src/backends');
const { MAX_TAIL_BYTES } = require('../src/backends/file-store');

let dir;
let seq = 0;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pi-resume-model-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const j = (o) => JSON.stringify(o);
const change = (provider, modelId) => j({ type: 'model_change', provider, modelId });
const USAGE = { input: 100, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 105 };
const assistant = (provider, model, extra = {}) => j({
  type: 'message', timestamp: '2026-10-01T10:00:00.000Z',
  message: { role: 'assistant', provider, model, usage: USAGE, stopReason: 'stop', content: [], ...extra },
});
const user = (text) => j({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } });

function fixture(lines, row = {}) {
  const filePath = path.join(dir, `s${++seq}.jsonl`);
  fs.writeFileSync(filePath, lines.length ? lines.join('\n') + '\n' : '');
  return { filePath, ...row };
}
const ask = (row) => pi.resumeLaunchOptions(row, {});

test('the last assistant turn names provider and model; the answer sets both in Pi\'s own keys', async () => {
  const row = fixture([change('anthropic', 'claude-haiku-4-5'), assistant('anthropic', 'claude-haiku-4-5'), assistant('openai-codex', 'gpt-5.6-luna')]);
  assert.deepEqual(await ask(row), { options: { model: 'gpt-5.6-luna', provider: 'openai-codex' }, label: 'openai-codex/gpt-5.6-luna' });
});

test('a model_change after the last assistant turn wins (the user switched, nothing ran yet)', async () => {
  const row = fixture([assistant('anthropic', 'claude-haiku-4-5'), user('x'), change('openai-codex', 'gpt-5.6-luna')]);
  assert.deepEqual((await ask(row)).options, { model: 'gpt-5.6-luna', provider: 'openai-codex' });
});

test('a stale model_change BEFORE a later assistant turn on another model loses (resume with --model, T1)', async () => {
  const row = fixture([change('anthropic', 'claude-haiku-4-5'), assistant('anthropic', 'claude-haiku-4-5'), assistant('openai-codex', 'gpt-6-luna')]);
  assert.deepEqual((await ask(row)).options, { model: 'gpt-6-luna', provider: 'openai-codex' });
});

test('an errored assistant turn is skipped (O8)', async () => {
  const row = fixture([assistant('anthropic', 'claude-haiku-4-5'), assistant('openai-codex', 'gpt-6-luna', { stopReason: 'error' })]);
  assert.deepEqual((await ask(row)).options, { model: 'claude-haiku-4-5', provider: 'anthropic' });
});

test('a zero-usage assistant turn is skipped (O8)', async () => {
  const row = fixture([assistant('anthropic', 'claude-haiku-4-5'), assistant('openai-codex', 'gpt-6-luna', { usage: { input: 0, output: 0, totalTokens: 0 } })]);
  assert.deepEqual((await ask(row)).options, { model: 'claude-haiku-4-5', provider: 'anthropic' });
});

test('an errored first turn voids the model_change that preceded it; with no proven turn the row answers or null', async () => {
  const lines = [change('anthropic', 'claude-bad'), assistant('anthropic', 'claude-bad', { stopReason: 'error' })];
  assert.equal(await ask(fixture(lines)), null);
  assert.deepEqual((await ask(fixture(lines, { lastModel: 'gpt-5.6-luna', lastProvider: 'openai-codex' }))).options, { model: 'gpt-5.6-luna', provider: 'openai-codex' });
});

test('a model_change with no assistant turn at all is taken', async () => {
  assert.deepEqual((await ask(fixture([change('openai-codex', 'gpt-5.6-luna')]))).options, { model: 'gpt-5.6-luna', provider: 'openai-codex' });
});

test('an errored turn BEFORE a model_change does not void it', async () => {
  const row = fixture([assistant('anthropic', 'claude-bad', { stopReason: 'error' }), change('openai-codex', 'gpt-5.6-luna')]);
  assert.deepEqual((await ask(row)).options, { model: 'gpt-5.6-luna', provider: 'openai-codex' });
});

test('the tail wins over a stale cached row; the row answers only where the tail names none', async () => {
  const row = fixture([assistant('openai-codex', 'gpt-5.6-luna')], { lastModel: 'claude-haiku-4-5', lastProvider: 'anthropic' });
  assert.deepEqual((await ask(row)).options, { model: 'gpt-5.6-luna', provider: 'openai-codex' });
  const filler = user('x'.repeat(1000));
  const many = Array.from({ length: Math.ceil(MAX_TAIL_BYTES / 1000) + 20 }, () => filler);
  const cut = fixture([assistant('openai-codex', 'gpt-5.6-luna'), ...many], { lastModel: 'claude-haiku-4-5', lastProvider: 'anthropic' });
  assert.deepEqual((await ask(cut)).options, { model: 'claude-haiku-4-5', provider: 'anthropic' });
});

test('a damaged last line is skipped', async () => {
  const row = fixture([assistant('anthropic', 'claude-haiku-4-5')]);
  fs.appendFileSync(row.filePath, '{"type":"message","message":{"role":"assistant","model":"gpt-');
  assert.equal((await ask(row)).options.model, 'claude-haiku-4-5');
});

test('a row or file that names nothing answers null; a missing file answers from the row', async () => {
  assert.equal(await ask({}), null);
  assert.equal(await ask(fixture([user('hello')])), null);
  const gone = path.join(dir, 'nope.jsonl');
  assert.equal(await ask({ filePath: gone }), null);
  assert.deepEqual((await ask({ filePath: gone, lastModel: 'm1', lastProvider: 'p1' })).options, { model: 'm1', provider: 'p1' });
});

test('a model without a known provider clears the provider, so a settings provider is never paired with it', async () => {
  assert.deepEqual((await ask(fixture([j({ type: 'model_change', modelId: 'm1' })]))), { options: { model: 'm1', provider: null }, label: 'm1' });
});

test('a model or provider that is not safe argv is refused', async () => {
  assert.equal(await ask(fixture([assistant('p', '--oss')])), null);
  assert.equal(await ask(fixture([assistant('p', 'a b')])), null);
  assert.deepEqual((await ask(fixture([assistant('--x', 'm1')]))).options, { model: 'm1', provider: null });
});

test('capability rows say yes, and pi-native forwards the hook of its owner', () => {
  assert.equal(pi.capabilities.resumeModel, 'yes');
  assert.equal(piNative.capabilities.resumeModel, 'yes');
  assert.equal(piNative.resumeLaunchOptions, pi.resumeLaunchOptions);
  assert.equal(backends.get('pi-native').resumeLaunchOptions, pi.resumeLaunchOptions);
});
