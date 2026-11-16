// #878: the model list and the effort levels per model a launch form offers — Claude's and Codex' sources, the
// launch flags, and the renderer helper that narrows the levels to the chosen model.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const claudeModels = require('../src/backends/claude/models');
const codexModels = require('../src/backends/codex/models');
const claude = require('../src/backends/claude');
const claudeNative = require('../src/backends/claude-native');
const codex = require('../src/backends/codex');
const protocol = require('../src/backends/claude-native/rpc-protocol');
const modelChoices = require('../src/renderer/lib/model-choices');

// The shape the runtime answered `initialize` with on 2.1.323 (trimmed), in the core's normalised form.
const initialize = () => ({ success: true, data: { models: [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
  { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
] } });

test('Claude: the initialize answer becomes form rows, without `default`, with the levels per model', () => {
  const rows = claudeModels.modelsFromInitialize(initialize());
  assert.deepEqual(rows.map(r => r.id), ['opus', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-6']);
  assert.deepEqual(rows[1].effortLevels, [], 'a model that takes no effort says so with an empty list');
  assert.deepEqual(rows[2].effortLevels, ['low', 'medium', 'high', 'max']);
  assert.equal(rows[0].label, 'Opus 5.5');
  assert.deepEqual(claudeModels.modelsFromInitialize({ success: false }), []);
});

test('Claude: one probe fills the cache, a failed probe falls back to the aliases, and a stale list outlives a failure', async () => {
  claudeModels._reset();
  let probes = 0;
  const failing = async () => { probes++; return null; };
  const first = await claudeModels.listModels({ probe: failing });
  assert.equal(first.fallback, true);
  assert.deepEqual(first.models.map(m => m.id), claudeModels.ALIASES.map(m => m.id));

  const working = async () => { probes++; return initialize(); };
  const [a, b] = await Promise.all([claudeModels.listModels({ probe: working }), claudeModels.listModels({ probe: working })]);
  assert.equal(probes, 2, 'two callers at once share one probe');
  assert.equal(a.models.length, 3);
  assert.equal(b.models.length, 3);
  const again = await claudeModels.listModels({ probe: failing });
  assert.equal(again.cached, true, 'a fresh cache answers without a probe');
  assert.equal(probes, 2);
  claudeModels._reset();
});

test('Claude: a probe with nothing startable answers null rather than throwing', async () => {
  assert.equal(await claudeModels.probeInitialize({ exe: null }), null);
});

test('claude-native: the running picker refreshes the launch form\'s list', async () => {
  claudeModels._reset();
  protocol.modelsFromResponse(initialize(), {});
  const res = await claudeModels.listModels({ probe: async () => { throw new Error('must not probe'); } });
  assert.equal(res.cached, true);
  assert.deepEqual(res.models.map(m => m.id), ['opus', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-6']);
  claudeModels._reset();
});

// The shape `codex debug models` printed on 0.167.0 (trimmed).
const catalog = JSON.stringify({ models: [
  { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'ultra' }] },
  { slug: 'gpt-reserve', display_name: 'Reserve', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
  { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }] },
] });

test('Codex: the catalog becomes form rows; hidden entries are not offered', () => {
  const rows = codexModels.modelsFromCatalog(catalog);
  assert.deepEqual(rows.map(r => r.id), ['gpt-6-sol', 'gpt-6-luna']);
  assert.deepEqual(rows[0].effortLevels, ['low', 'medium', 'ultra']);
  assert.deepEqual(codexModels.modelsFromCatalog('not json'), []);
});

test('Codex: the refreshed catalog is cached; when it fails the bundled one answers once, uncached', async () => {
  codexModels._reset();
  const calls = [];
  const resolveCommand = () => ({ command: 'codex', args: [] });
  const failRefresh = async (_launch, extra) => { calls.push(extra.join(' ')); return extra.length ? { models: codexModels.modelsFromCatalog(catalog) } : { models: [], reason: 'offline' }; };
  const fromBundle = await codexModels.listModels({ resolveCommand, run: failRefresh });
  assert.equal(fromBundle.bundled, true);
  assert.deepEqual(calls, ['', '--bundled']);
  await codexModels.listModels({ resolveCommand, run: failRefresh });
  assert.equal(calls.length, 4, 'the bundled answer was not cached, so the account\'s list is asked for again');

  const ok = async () => ({ models: codexModels.modelsFromCatalog(catalog) });
  await codexModels.listModels({ resolveCommand, run: ok });
  const cached = await codexModels.listModels({ resolveCommand, run: async () => { throw new Error('must not run'); } });
  assert.equal(cached.cached, true);
  assert.deepEqual(await codexModels.listModels({ resolveCommand: () => null }).then(r => r.cached), true);
  codexModels._reset();
  assert.equal((await codexModels.listModels({ resolveCommand: () => null })).ok, false);
});

test('the effort option reaches each CLI in its own spelling, and an empty one sends nothing', () => {
  assert.deepEqual(claude.buildLaunch({ sessionId: 's', options: { effort: 'high' } }).args.slice(-2), ['--effort', 'high']);
  assert.ok(!claude.buildLaunch({ sessionId: 's', options: { effort: '' } }).args.includes('--effort'));
  assert.ok(claudeNative.buildLaunch({ sessionId: 's', options: { effort: 'max' } }).args.includes('--effort=max'));
  const cx = codex.buildLaunch({ options: { effort: 'ultra' } }).args;
  assert.deepEqual(cx.slice(cx.indexOf('-c'), cx.indexOf('-c') + 2), ['-c', 'model_reasoning_effort=ultra']);
  assert.ok(!codex.buildLaunch({ options: {} }).args.includes('-c'));
});

test('both Claude modes declare the same model and effort fields, so they are stored once', () => {
  for (const id of ['model', 'effort']) {
    const a = claude.configFields.find(f => f.id === id);
    const b = claudeNative.configFields.find(f => f.id === id);
    assert.ok(a && b, `${id} is declared by both modes`);
    assert.equal(a, b, `${id} is the same declaration, not a copy`);
  }
  assert.equal(claudeNative.listModels, claude.listModels);
});

// ── the renderer helper ──────────────────────────────────────────────────────────────────────────────

function formWith(selected) {
  const dom = new JSDOM(`<div id="root">
    <input id="m" data-model-discovery="b" data-model-field="model" value="">
    <select id="e" data-choices-per-model="model" data-model-backend="b">
      <option value="">Default</option><option value="low">Low</option><option value="high">High</option><option value="max"${selected === 'max' ? ' selected' : ''}>Max</option>
    </select></div>`);
  return dom.window.document;
}

test('the levels of a listed model narrow the select; an unknown or empty model narrows nothing', () => {
  const models = modelChoices.normalise([{ id: 'a', effortLevels: ['low', 'high'] }, { id: 'none', effortLevels: [] }, 'plain']);
  assert.deepEqual(modelChoices.levelsFor(models, 'a'), ['low', 'high']);
  assert.deepEqual(modelChoices.levelsFor(models, 'none'), []);
  assert.equal(modelChoices.levelsFor(models, 'plain'), null, 'a row without levels says nothing');
  assert.equal(modelChoices.levelsFor(models, 'typed-by-hand'), null);
  assert.equal(modelChoices.levelsFor(models, ''), null);

  const doc = formWith('');
  const select = doc.getElementById('e');
  modelChoices.narrowSelect(select, ['low', 'high']);
  assert.deepEqual(Array.from(select.options).filter(o => !o.hidden).map(o => o.value), ['', 'low', 'high']);
  modelChoices.narrowSelect(select, null);
  assert.deepEqual(Array.from(select.options).filter(o => !o.hidden).map(o => o.value), ['', 'low', 'high', 'max']);
  modelChoices.narrowSelect(select, []);
  assert.deepEqual(Array.from(select.options).filter(o => !o.hidden).map(o => o.value), [''], 'a model that takes no effort leaves only the CLI\'s default');
});

test('a stored level the model does not list stays selected and says so', () => {
  const doc = formWith('max');
  const select = doc.getElementById('e');
  modelChoices.narrowSelect(select, ['low']);
  const max = Array.from(select.options).find(o => o.value === 'max');
  assert.equal(max.hidden, false);
  assert.equal(max.textContent, 'Max' + modelChoices.NOT_OFFERED);
  modelChoices.narrowSelect(select, null);
  assert.equal(max.textContent, 'Max', 'the mark goes once the level is offered again');
});

test('the attributes a form writes link a select to its model input, and a plain field gets none', () => {
  assert.equal(modelChoices.selectAttrs({ id: 'x', type: 'select' }, 'b'), '');
  assert.match(modelChoices.selectAttrs({ id: 'effort', choicesPerModel: 'model' }, 'claude'), /data-choices-per-model="model" data-model-backend="claude"/);
  assert.match(modelChoices.inputAttrs({ id: 'model', modelDiscovery: true }, 'claude', 'm-models'), /list="m-models" data-model-discovery="claude" data-model-field="model"/);
  assert.equal(modelChoices.inputAttrs({ id: 'name' }, 'claude', 'x'), '');
});
