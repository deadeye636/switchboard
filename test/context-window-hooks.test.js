// #620: which context window a stored session row ran against, per backend.
//
// Claude derives it (the transcript never names the window, and `[1m]` decides it for some models), Codex
// reports it, Pi looks it up in its own catalog, Hermes and agy decline. The Claude numbers are the ones
// the CLI itself reported when measured; see src/backends/claude/model-windows.js.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const windows = require('../src/backends/claude/model-windows');

// ── the Claude table ───────────────────────────────────────────────────────────────────────────────

test('a spec is taken apart: case, a date or @version suffix, the [1m] suffix and an alias', () => {
  assert.deepEqual(windows.parseSpec('claude-opus-4-5-20251101'), { model: 'claude-opus-4-5', oneM: false, family: null });
  assert.deepEqual(windows.parseSpec('claude-opus-4-6@20251101'), { model: 'claude-opus-4-6', oneM: false, family: null });
  assert.deepEqual(windows.parseSpec(' Claude-Sonnet-4-5[1m] '), { model: 'claude-sonnet-4-5', oneM: true, family: null });
  assert.deepEqual(windows.parseSpec('opus[1m]'), { model: 'claude-opus-5', oneM: true, family: 'opus' });
  assert.deepEqual(windows.parseSpec('fable'), { model: 'claude-fable-5-1', oneM: false, family: 'fable' });
  assert.equal(windows.parseSpec('default'), null, 'the CLI default names no model');
  assert.equal(windows.parseSpec(''), null);
  assert.equal(windows.parseSpec(null), null);
});

test('an alias in the transcript only names a family: a turn inside it keeps its own id', () => {
  // An old `/model sonnet` from when it meant 4-5, turns on 4-5 at 170k: 85 % of 200k, not 17 % of 1M.
  assert.deepEqual(windows.resolveClaudeWindow({ lastInputTokens: 170000, lastModel: 'claude-sonnet-4-5', lastModelSpec: 'sonnet' }),
    { windowTokens: 200000, source: 'transcript-spec' });
  // …and a switch to another family still decides at once.
  assert.deepEqual(windows.resolveClaudeWindow({ lastInputTokens: 170000, lastModel: 'claude-opus-4-5', lastModelSpec: 'sonnet' }),
    { windowTokens: 1000000, source: 'transcript-spec' });
});

test('a transcript alias matched by FAMILY is inferred, so the floor still applies to it', () => {
  // `/model opus` while the opus alias points at 4-6[1m], then a turn at 400k on 4-6: 1M, not 200 % of 200k.
  assert.deepEqual(windows.resolveClaudeWindow({ lastInputTokens: 400000, lastModel: 'claude-opus-4-6', lastModelSpec: 'opus' }),
    { windowTokens: 1000000, source: 'floor' });
  assert.deepEqual(windows.resolveClaudeWindow({ lastInputTokens: 150000, lastModel: 'claude-opus-4-6', lastModelSpec: 'opus[1m]' }),
    { windowTokens: 1000000, source: 'transcript-spec' });
});

test('a turn on another provider\'s model has no window, whatever a Claude alias in the transcript says', () => {
  assert.equal(windows.resolveClaudeWindow({ lastInputTokens: 90000, lastModel: 'deepseek-v4-pro', lastModelSpec: 'opus' }), null);
});

test('a transcript spec that yields no window falls back to the turn\'s model instead of taking the fill away', () => {
  assert.deepEqual(windows.resolveClaudeWindow({ lastInputTokens: 90000, lastModel: 'claude-opus-4-5', lastModelSpec: 'opusplan' }),
    { windowTokens: 200000, source: 'model' });
});

test('/model default names no model, so the turn\'s model answers', () => {
  assert.deepEqual(windows.resolveClaudeWindow({ lastInputTokens: 90000, lastModel: 'claude-opus-4-5', lastModelSpec: 'default' }),
    { windowTokens: 200000, source: 'model' });
});

test('a configured alias names its family too: opus[1m] with a turn on claude-opus-4-6 means 1M', () => {
  assert.deepEqual(windows.resolveClaudeWindow({ lastInputTokens: 180000, lastModel: 'claude-opus-4-6' }, ['opus[1m]']),
    { windowTokens: 1000000, source: 'configured-spec' });
});

test('specNamesModel: the raw spec against the raw model a transcript reports (#622)', () => {
  assert.equal(windows.specNamesModel('claude-opus-4-6[1m]', 'claude-opus-4-6'), true);
  assert.equal(windows.specNamesModel('Claude-Sonnet-4-5', 'claude-sonnet-4-5-20250929'), true, 'case and a date suffix are ignored');
  assert.equal(windows.specNamesModel('opus', 'claude-opus-4-8'), true, 'an alias names its family');
  assert.equal(windows.specNamesModel('claude-opus-4-5', 'claude-opus-5'), false);
  assert.equal(windows.specNamesModel('haiku', 'claude-opus-5'), false);
  assert.equal(windows.specNamesModel('opusplan', 'claude-opus-5'), false, 'an alias the table does not know names nothing');
  assert.equal(windows.specNamesModel('default', 'claude-opus-5'), false);
});

test('the table gives the measured windows, and [1m] only where the CLI offers it', () => {
  assert.equal(windows.windowFor('claude-opus-5', false), 1000000);
  assert.equal(windows.windowFor('claude-sonnet-4-5', false), 200000);
  assert.equal(windows.windowFor('claude-sonnet-4-5', true), 1000000);
  assert.equal(windows.windowFor('claude-opus-4-6', true), 1000000);
  assert.equal(windows.windowFor('claude-haiku-4-5', true), 200000, 'no 1M variant: the suffix changes nothing');
  assert.equal(windows.windowFor('claude-opus-4-8', false), 1000000);
});

test('an unknown claude model counts as 1M, and a model from another provider has no window at all', () => {
  assert.equal(windows.windowFor('claude-opus-6', false), 1000000);
  assert.equal(windows.windowFor('deepseek-v4-pro', false), null);
  assert.equal(windows.windowFor('glm-4.6', false), null);
});

test('a /model spec in the transcript decides at once, even over the model the last turn ran on (E9)', () => {
  const r = windows.resolveClaudeWindow({ lastInputTokens: 46370, lastModel: 'claude-opus-5', lastModelSpec: 'claude-sonnet-4-5' });
  assert.deepEqual(r, { windowTokens: 200000, source: 'transcript-spec' });
});

test('without a transcript spec, a configured spec naming the SAME model decides the variant', () => {
  const row = { lastInputTokens: 150000, lastModel: 'claude-sonnet-4-5-20250929' };
  assert.deepEqual(windows.resolveClaudeWindow(row, ['opus[1m]', 'claude-sonnet-4-5[1m]']),
    { windowTokens: 1000000, source: 'configured-spec' }, 'a spec for another model is skipped');
  assert.deepEqual(windows.resolveClaudeWindow(row, ['claude-sonnet-4-5']), { windowTokens: 200000, source: 'configured-spec' });
  assert.deepEqual(windows.resolveClaudeWindow(row, []), { windowTokens: 200000, source: 'model' });
});

// ── E12: of the specs naming one model, the larger window wins ─────────────────────────────────────

test('E12: a bare spec higher in the cascade does not take away an exact [1m] lower down', () => {
  const row = { lastInputTokens: 170000, lastModel: 'claude-sonnet-4-5' };
  assert.deepEqual(windows.resolveClaudeWindow(row, ['sonnet', 'claude-sonnet-4-5', 'claude-sonnet-4-5[1m]']),
    { windowTokens: 1000000, source: 'configured-spec' });
  assert.deepEqual(windows.resolveClaudeWindow({ lastInputTokens: 170000, lastModel: 'claude-opus-4-6' }, ['opus', 'opus[1m]']),
    { windowTokens: 1000000, source: 'configured-spec' }, 'two aliases of the family: the [1m] one wins');
});

test('E12: a stale /model <id> in the transcript does not outlive a later [1m] launch of the same model', () => {
  const row = { lastInputTokens: 170000, lastModel: 'claude-sonnet-4-5', lastModelSpec: 'claude-sonnet-4-5' };
  assert.deepEqual(windows.resolveClaudeWindow(row, ['claude-sonnet-4-5[1m]']), { windowTokens: 1000000, source: 'configured-spec' });
  assert.deepEqual(windows.resolveClaudeWindow({ ...row, lastModelSpec: 'claude-sonnet-4-5[1m]' }, ['claude-sonnet-4-5']),
    { windowTokens: 1000000, source: 'transcript-spec' }, 'and a bare configured spec does not take the transcript\'s [1m] away');
});

test('E12: a switch to another model keeps E9, and only specs naming THAT model can widen its window', () => {
  const row = { lastInputTokens: 46370, lastModel: 'claude-opus-5', lastModelSpec: 'claude-opus-4-6' };
  assert.deepEqual(windows.resolveClaudeWindow(row, ['claude-opus-4-6[1m]']), { windowTokens: 1000000, source: 'configured-spec' });
  assert.deepEqual(windows.resolveClaudeWindow(row, ['claude-opus-5[1m]', 'claude-sonnet-4-5[1m]']),
    { windowTokens: 200000, source: 'transcript-spec' }, 'a [1m] for the turn\'s model or another model changes nothing');
});

test('E12: a transcript alias matched by family, and a switch before any turn, are widened too', () => {
  assert.deepEqual(windows.resolveClaudeWindow({ lastInputTokens: 150000, lastModel: 'claude-opus-4-6', lastModelSpec: 'opus' }, ['claude-opus-4-6[1m]']),
    { windowTokens: 1000000, source: 'configured-spec' });
  assert.deepEqual(windows.resolveClaudeWindow({ lastModelSpec: 'claude-sonnet-4-5' }, ['claude-sonnet-4-5[1m]']),
    { windowTokens: 1000000, source: 'configured-spec' }, 'no turn yet: the switch names the model, the configured [1m] its variant');
  // Known gap in spec 28: the alias names only its family, so it widens a pinned bare id of that family.
  assert.deepEqual(windows.resolveClaudeWindow({ lastInputTokens: 190000, lastModel: 'claude-opus-4-6' }, ['claude-opus-4-6', 'opus[1m]']),
    { windowTokens: 1000000, source: 'configured-spec' });
});

test('E12: precedence breaks a tie, and a tie with the switch itself keeps the floor off', () => {
  const row = { lastInputTokens: 240000, lastModel: 'claude-sonnet-4-5', lastModelSpec: 'claude-sonnet-4-5' };
  assert.deepEqual(windows.resolveClaudeWindow(row, ['claude-sonnet-4-5', 'sonnet']),
    { windowTokens: 200000, source: 'transcript-spec' }, 'every spec says 200k: the CLI\'s own switch stands, 120 %');
  assert.deepEqual(windows.resolveClaudeWindow({ lastInputTokens: 240000, lastModel: 'claude-sonnet-4-5' }, ['claude-sonnet-4-5', 'sonnet']),
    { windowTokens: 1000000, source: 'floor' }, 'without the switch the 200k is inferred, so the floor applies');
});

test('the floor: an inferred 200k window under a turn above 200k means 1M — never against a transcript spec', () => {
  assert.deepEqual(windows.resolveClaudeWindow({ lastInputTokens: 240000, lastModel: 'claude-sonnet-4-5' }),
    { windowTokens: 1000000, source: 'floor' });
  assert.deepEqual(windows.resolveClaudeWindow({ lastInputTokens: 240000, lastModel: 'claude-opus-5', lastModelSpec: 'claude-sonnet-4-5' }),
    { windowTokens: 200000, source: 'transcript-spec' }, 'a switch to another model: its window is the true one');
  assert.deepEqual(windows.resolveClaudeWindow({ lastInputTokens: 240000, lastModel: 'claude-sonnet-4-5', lastModelSpec: 'claude-sonnet-4-5' }),
    { windowTokens: 200000, source: 'transcript-spec' }, 'dropping [1m] on the same model: the CLI shows 120 % too');
});

test('a row naming no model, or a non-Claude one, has no window', () => {
  assert.equal(windows.resolveClaudeWindow(null), null);
  assert.equal(windows.resolveClaudeWindow({ lastInputTokens: 10 }), null);
  assert.equal(windows.resolveClaudeWindow({ lastInputTokens: 10, lastModel: 'deepseek-v4-pro' }), null);
});

// ── the Claude hook: env and the settings cascade ──────────────────────────────────────────────────

// An isolated Claude home for one test: the roots point at it, and ANTHROPIC_MODEL is taken out of this
// process's env so a developer's own shell cannot decide an assertion. Nothing reads the real home.
function withClaudeHome(fn) {
  const claude = require('../src/backends/claude');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxwin-claude-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(home, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  const previousRoots = claude._roots();
  const previousModel = process.env.ANTHROPIC_MODEL;
  delete process.env.ANTHROPIC_MODEL;
  try {
    claude.setRoots([path.join(home, 'projects')]);
    fn({ claude, home, project });
  } finally {
    claude.setRoots(previousRoots);
    if (previousModel === undefined) delete process.env.ANTHROPIC_MODEL; else process.env.ANTHROPIC_MODEL = previousModel;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// The settings files are cached for five seconds, so each precedence case gets its own project directory.
function projectWith(root, files) {
  const dir = fs.mkdtempSync(path.join(root, 'p-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  for (const [name, model] of Object.entries(files)) fs.writeFileSync(path.join(dir, '.claude', name), JSON.stringify({ model }));
  return dir;
}

test('Claude hook: launch model, env, project-local, project and user settings are each read', () => {
  withClaudeHome(({ claude, home, project }) => {
    const row = (projectPath) => ({ projectPath, lastInputTokens: 120000, lastModel: 'claude-opus-4-6' });
    const root = path.dirname(project);

    assert.deepEqual(claude.contextWindow(row(project)), { windowTokens: 200000, source: 'model' }, 'nothing names it');
    assert.deepEqual(claude.contextWindow(row(project), { launchOptions: { model: 'claude-opus-4-6[1m]' } }),
      { windowTokens: 1000000, source: 'configured-spec' }, 'the stored launch model');
    assert.deepEqual(claude.contextWindow(row(project), { env: { ANTHROPIC_MODEL: 'claude-opus-4-6[1m]' } }),
      { windowTokens: 1000000, source: 'configured-spec' }, 'the session env');
    assert.deepEqual(claude.contextWindow(row(projectWith(root, { 'settings.local.json': 'claude-opus-4-6[1m]' }))),
      { windowTokens: 1000000, source: 'configured-spec' }, 'project-local settings');
    assert.deepEqual(claude.contextWindow(row(projectWith(root, { 'settings.json': 'claude-opus-4-6[1m]' }))),
      { windowTokens: 1000000, source: 'configured-spec' }, 'project settings');
  });
  // A home of its own: the user file's answer is cached per file, and the case above already read it absent.
  withClaudeHome(({ claude, home, project }) => {
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ model: 'claude-opus-4-6[1m]' }));
    const row = { projectPath: project, lastInputTokens: 120000, lastModel: 'claude-opus-4-6' };
    assert.deepEqual(claude.contextWindow(row), { windowTokens: 1000000, source: 'configured-spec' }, 'user settings');
    assert.deepEqual(claude.contextWindow(row, { env: { ANTHROPIC_MODEL: '$MODEL' } }),
      { windowTokens: 1000000, source: 'configured-spec' }, 'an unresolved reference names no model and is skipped');
  });
});

test('Claude hook (E12): a bare spec anywhere in the cascade does not outrank a [1m] elsewhere', () => {
  withClaudeHome(({ claude, home, project }) => {
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ model: 'claude-opus-4-6[1m]' }));
    const row = (projectPath) => ({ projectPath, lastInputTokens: 170000, lastModel: 'claude-opus-4-6' });
    const root = path.dirname(project);

    assert.deepEqual(claude.contextWindow(row(projectWith(root, { 'settings.json': 'claude-opus-4-6', 'settings.local.json': 'opus' })),
      { launchOptions: { model: 'claude-opus-4-6' }, env: { ANTHROPIC_MODEL: 'claude-opus-4-6' } }),
    { windowTokens: 1000000, source: 'configured-spec' }, 'launch, env and both project files bare; the user file says [1m]');
  });
  withClaudeHome(({ claude, home, project }) => {
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ model: 'claude-opus-4-6' }));
    assert.deepEqual(claude.contextWindow({ projectPath: project, lastInputTokens: 170000, lastModel: 'claude-opus-4-6' }, { launchOptions: { model: 'claude-opus-4-6' } }),
      { windowTokens: 200000, source: 'configured-spec' }, 'no spec says [1m]: 200k, and still no floor below 200k');
  });
});

test('Claude hook: a per-call env is LAYERED over the process env, never a replacement for it', () => {
  withClaudeHome(({ claude, project }) => {
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5[1m]';
    const row = { projectPath: project, lastInputTokens: 170000, lastModel: 'claude-sonnet-4-5' };
    // A caller passing only its own additions must not lose the process's ANTHROPIC_MODEL — that loss is
    // exactly how 170k on a 1M session would read as 85 % and raise a false badge.
    assert.deepEqual(claude.contextWindow(row, { env: { SOMETHING_ELSE: '1' } }), { windowTokens: 1000000, source: 'configured-spec' });
  });
});

test('Claude hook: a settings file with a BOM is still read', () => {
  withClaudeHome(({ claude, home, project }) => {
    fs.writeFileSync(path.join(home, 'settings.json'), '\uFEFF' + JSON.stringify({ model: 'claude-sonnet-4-5[1m]' }));
    assert.deepEqual(claude.contextWindow({ projectPath: project, lastInputTokens: 150000, lastModel: 'claude-sonnet-4-5' }),
      { windowTokens: 1000000, source: 'configured-spec' });
  });
});

test('Claude hook: a settings file is held for a few seconds, not re-read per row', () => {
  withClaudeHome(({ claude, project }) => {
    const local = path.join(project, '.claude', 'settings.local.json');
    fs.writeFileSync(local, JSON.stringify({ model: 'claude-sonnet-4-5[1m]' }));
    const row = { projectPath: project, lastInputTokens: 150000, lastModel: 'claude-sonnet-4-5' };
    assert.equal(claude.contextWindow(row).windowTokens, 1000000);
    fs.writeFileSync(local, JSON.stringify({ model: 'claude-sonnet-4-5' }));
    assert.equal(claude.contextWindow(row).windowTokens, 1000000, 'within the TTL the cached answer stands');
  });
});

test('a template on Claude asks with its own env layered on top', () => {
  withClaudeHome(({ project }) => {
    const { profileToDescriptor } = require('../src/backends');
    const template = profileToDescriptor({ id: 'tmpl-ctx', name: 'T', backendId: 'claude', env: { ANTHROPIC_MODEL: 'claude-sonnet-4-5[1m]' } });
    assert.equal(typeof template.contextWindow, 'function', 'the hook is forwarded');
    assert.deepEqual(template.contextWindow({ projectPath: project, lastInputTokens: 50000, lastModel: 'claude-sonnet-4-5' }, { env: { ANTHROPIC_MODEL: 'claude-sonnet-4-5' } }),
      { windowTokens: 1000000, source: 'configured-spec' }, 'the template bundle wins over what the caller passes');
  });
});

// ── Codex, Pi, Hermes, agy ─────────────────────────────────────────────────────────────────────────

test('Codex hook: the window the CLI reported with the last request, else nothing', () => {
  const codex = require('../src/backends/codex');
  assert.deepEqual(codex.contextWindow({ contextWindowReported: 258400 }), { windowTokens: 258400, source: 'cli' });
  assert.equal(codex.contextWindow({ contextWindowReported: null }), null);
});

test('Pi hook: the catalog window for the provider AND model, with the user file winning', () => {
  const pi = require('../src/backends/pi');
  const piWindows = require('../src/backends/pi/model-windows');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxwin-pi-'));
  const store = path.join(root, 'stores', 'pi');
  const agentDir = path.join(root, 'stores', 'pi-agent');   // trust.agentDirFromStore's sibling layout
  const saved = process.env.SWITCHBOARD_STORE_PI;
  try {
    fs.mkdirSync(store, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'models-store.json'), JSON.stringify({
      'openai-codex': { models: [{ id: 'gpt-5.6-sol', contextWindow: 272000 }] },
      anthropic: { models: [{ id: 'claude-opus-5', contextWindow: 1000000 }] },
    }));
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
      providers: { lmstudio: { models: [{ id: 'local-coder', contextWindow: 16384 }] },
        anthropic: { models: [{ id: 'claude-opus-5', contextWindow: 500000 }] } },
    }));
    process.env.SWITCHBOARD_STORE_PI = store;
    piWindows._resetCache();

    assert.deepEqual(pi.contextWindow({ lastProvider: 'openai-codex', lastModel: 'gpt-5.6-sol' }), { windowTokens: 272000, source: 'catalog' });
    assert.deepEqual(pi.contextWindow({ lastProvider: 'lmstudio', lastModel: 'local-coder' }), { windowTokens: 16384, source: 'catalog' });
    assert.deepEqual(pi.contextWindow({ lastProvider: 'anthropic', lastModel: 'claude-opus-5' }), { windowTokens: 500000, source: 'catalog' },
      'the user\'s models.json overrides the catalog');
    assert.equal(pi.contextWindow({ lastProvider: 'openai-codex', lastModel: 'not-listed' }), null);
    assert.equal(pi.contextWindow({ lastProvider: 'anthropic', lastModel: 'gpt-5.6-sol' }), null, 'the provider is part of the key');
  } finally {
    if (saved === undefined) delete process.env.SWITCHBOARD_STORE_PI; else process.env.SWITCHBOARD_STORE_PI = saved;
    piWindows._resetCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Hermes and agy decline for any row', () => {
  for (const id of ['hermes', 'agy']) {
    const b = require(`../src/backends/${id}`);
    assert.equal(b.contextWindow({ lastInputTokens: 50000, lastModel: 'claude-opus-5', contextWindowReported: 1000000 }), null, id);
  }
});
