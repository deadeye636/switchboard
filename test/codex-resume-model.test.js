// #754 T6: Codex's `resumeLaunchOptions` — the model a resume launches on.
//
// Codex does not restore the model on `codex resume`, so the last `turn_context.model` of the rollout tail is
// handed back. A `thread_settings_applied` (a resume writes them at its start, with the default model) is never
// the source. Fixtures live in a temp directory.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const codex = require('../src/backends/codex');
const { MAX_TAIL_BYTES } = require('../src/backends/file-store');

let dir;
let seq = 0;
let hadHome;
let hadStore;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-codex-resume-model-'));
  // The descriptor home must not be the machine's real one (its catalog would decide these tests), nor a
  // demo store's: the resolver reads SWITCHBOARD_STORE_CODEX before CODEX_HOME.
  hadHome = process.env.CODEX_HOME;
  hadStore = process.env.SWITCHBOARD_STORE_CODEX;
  delete process.env.SWITCHBOARD_STORE_CODEX;
  process.env.CODEX_HOME = path.join(dir, 'empty-home');
});
after(() => {
  if (hadHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = hadHome;
  if (hadStore !== undefined) process.env.SWITCHBOARD_STORE_CODEX = hadStore;
  fs.rmSync(dir, { recursive: true, force: true });
});

const j = (o) => JSON.stringify(o);
const turn = (model) => j({ type: 'turn_context', payload: { model, cwd: '/p' } });
const settings = (model) => j({ type: 'event_msg', payload: { type: 'thread_settings_applied', model } });
const message = (text) => j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });

function fixture(lines, row = {}) {
  const filePath = path.join(dir, `rollout-${++seq}.jsonl`);
  fs.writeFileSync(filePath, lines.length ? lines.join('\n') + '\n' : '');
  return { filePath, ...row };
}
const modelOf = (answer) => answer && answer.options.model;

test('the last turn_context names the model; the answer is a patch in Codex\'s own key, with a label', async () => {
  const row = fixture([turn('gpt-5.6-luna'), message('hi'), turn('gpt-5.6-sol')]);
  const a = await codex.resumeLaunchOptions(row, {});
  assert.deepEqual({ options: a.options, label: a.label }, { options: { model: 'gpt-5.6-sol' }, label: 'gpt-5.6-sol' });
});

test('a trailing thread_settings_applied carrying another model is NOT the answer', async () => {
  const row = fixture([turn('gpt-5.6-luna'), message('hi'), settings('gpt-6.1-sol'), settings('gpt-6.1-sol')]);
  assert.equal(modelOf(await codex.resumeLaunchOptions(row, {})), 'gpt-5.6-luna');
});

test('a thread_settings_applied alone names no model: the row answers, else null', async () => {
  const lines = [settings('gpt-6.1-sol')];
  assert.equal(await codex.resumeLaunchOptions(fixture(lines), {}), null);
  assert.equal(modelOf(await codex.resumeLaunchOptions(fixture(lines, { lastModel: 'gpt-5.6-luna' }), {})), 'gpt-5.6-luna');
});

test('the tail wins over a stale cached row', async () => {
  const row = fixture([turn('gpt-5.6-sol')], { lastModel: 'gpt-5.6-luna' });
  assert.equal(modelOf(await codex.resumeLaunchOptions(row, {})), 'gpt-5.6-sol');
});

test('a tail cut mid-line (turn_context older than the window) falls back to the row', async () => {
  const filler = (c) => message(c.repeat(1000));
  const many = Array.from({ length: Math.ceil(MAX_TAIL_BYTES / 1000) + 20 }, () => filler('x'));
  const row = fixture([turn('gpt-5.6-sol'), ...many], { lastModel: 'gpt-5.6-luna' });
  assert.equal(modelOf(await codex.resumeLaunchOptions(row, {})), 'gpt-5.6-luna');
  assert.equal(await codex.resumeLaunchOptions(fixture([turn('gpt-5.6-sol'), ...many]), {}), null);
});

test('a damaged last line is skipped', async () => {
  const row = fixture([turn('gpt-5.6-luna')]);
  fs.appendFileSync(row.filePath, '{"type":"turn_context","payload":{"model":"gpt-5.6-so');
  assert.equal(modelOf(await codex.resumeLaunchOptions(row, {})), 'gpt-5.6-luna');
});

test('a missing file answers from the row, or null', async () => {
  const gone = path.join(dir, 'does-not-exist.jsonl');
  assert.equal(await codex.resumeLaunchOptions({ filePath: gone }, {}), null);
  assert.equal(modelOf(await codex.resumeLaunchOptions({ filePath: gone, lastModel: 'gpt-5.6-luna' }, {})), 'gpt-5.6-luna');
  assert.equal(await codex.resumeLaunchOptions({}, {}), null);
});

test('a model string that is not safe argv is refused', async () => {
  for (const bad of ['--oss', 'gpt 5', 'gpt$HOME', 'a"b', '-m']) {
    assert.equal(await codex.resumeLaunchOptions(fixture([turn(bad)]), {}), null, bad);
  }
});

// The catalog check: Codex's own models_cache.json in the Codex home.
function home(cache) {
  const h = fs.mkdtempSync(path.join(dir, 'home-'));
  if (cache !== undefined) fs.writeFileSync(path.join(h, 'models_cache.json'), typeof cache === 'string' ? cache : j(cache));
  return h;
}
const catalog = (...slugs) => ({ fetched_at: 'x', models: slugs.map((slug) => ({ slug })) });
const ask = (row, h) => codex.resumeLaunchOptions(row, { env: { CODEX_HOME: h } });

test('a model in the catalog is answered', async () => {
  assert.equal(modelOf(await ask(fixture([turn('gpt-5.6-sol')]), home(catalog('gpt-5.6-sol', 'gpt-5.5')))), 'gpt-5.6-sol');
});

test('a model the catalog does not list is declined', async () => {
  assert.equal(await ask(fixture([turn('gpt-6.1-sol')]), home(catalog('gpt-5.6-sol'))), null);
});

test('a missing, unparsable or shapeless catalog blocks nothing', async () => {
  const row = () => fixture([turn('gpt-5.6-sol')]);
  for (const h of [home(), home('{not json'), home('[]'), home({ models: 'x' }), home({ models: [] })]) {
    assert.equal(modelOf(await ask(row(), h)), 'gpt-5.6-sol');
  }
});

test('ctx.env.CODEX_HOME is honoured over the descriptor home', async () => {
  const had = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home(catalog('gpt-5.6-luna'));   // restored to the suite's empty home below
  try {
    const row = fixture([turn('gpt-5.6-sol')]);
    assert.equal(await codex.resumeLaunchOptions(row, { env: {} }), null);                          // descriptor home declines
    assert.equal(modelOf(await ask(row, home(catalog('gpt-5.6-sol')))), 'gpt-5.6-sol');             // ctx home answers
  } finally {
    if (had === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = had;
  }
});

test('the capability row says yes', () => {
  assert.equal(codex.capabilities.resumeModel, 'yes');
});

// T8: the notice. Codex does not restore the model, so any difference from what was sent is a change.
test('notice: none only when the sent model is the answered one', async () => {
  const a = await ask(fixture([turn('gpt-5.6-sol')]), home(catalog('gpt-5.6-sol')));
  assert.match(a.notice, /instead of Codex's default$/, 'no launchOptions: the default is not that model');
  const same = await codex.resumeLaunchOptions(fixture([turn('gpt-5.6-sol')]), { env: { CODEX_HOME: home(catalog('gpt-5.6-sol')) }, launchOptions: { model: 'gpt-5.6-sol' } });
  assert.equal(same.notice, undefined);
});

test('notice: a different sent model, or none at all, is named', async () => {
  const h = home(catalog('gpt-5.6-sol'));
  const other = await codex.resumeLaunchOptions(fixture([turn('gpt-5.6-sol')]), { env: { CODEX_HOME: h }, launchOptions: { model: 'gpt-5.5' } });
  assert.equal(other.notice, 'Resumed on gpt-5.6-sol, the model this session last used, instead of gpt-5.5');
  const none = await codex.resumeLaunchOptions(fixture([turn('gpt-5.6-sol')]), { env: { CODEX_HOME: h }, launchOptions: {} });
  assert.equal(none.notice, "Resumed on gpt-5.6-sol, the model this session last used, instead of Codex's default");
});
