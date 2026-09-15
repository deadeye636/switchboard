'use strict';
// #620 — the middle link of the context-fill seam: `projects-view.js` asks the row's backend for its window
// and stamps `{ usedTokens, windowTokens, percent }` onto the payload.
//
// The backends' answers have their own tests (`test/context-window-hooks.test.js`) and the renderer will
// have its own; both keep passing if this link is deleted. So: the real read path over a fake store.
//
// The Claude rows run against a temporary Claude home, with ANTHROPIC_MODEL taken out of the process env,
// so neither the developer's real settings nor their shell can decide an assertion.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const view = require('../src/index/projects-view');
const claude = require('../src/backends/claude');

const ALPHA = '/invented/demo-alpha';
const REGISTERED = { registered: true, registeredAt: '2026-01-01T00:00:00Z' };

function withIsolatedClaude(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-ctxfill-'));
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  const previousRoots = claude._roots();
  const previousModel = process.env.ANTHROPIC_MODEL;
  delete process.env.ANTHROPIC_MODEL;
  try {
    claude.setRoots([path.join(root, 'projects')]);
    fn();
  } finally {
    claude.setRoots(previousRoots);
    if (previousModel === undefined) delete process.env.ANTHROPIC_MODEL; else process.env.ANTHROPIC_MODEL = previousModel;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function build(rows, globalSettings = null) {
  view.init({
    PROJECTS_DIR: '/invented/nowhere',
    activeSessions: new Map(),
    db: {
      getAllMeta: () => new Map(),
      getAllCached: () => rows,
      getAllFolderMeta: () => new Map(),
      setFolderMeta: () => {},
      getFavoritedProjects: () => new Set(),
      getProjectDisplayNames: () => new Map(),
      getProjectStates: () => new Map([[ALPHA, REGISTERED]]),
      getSetting: (key) => (key === 'global' ? globalSettings : null),
    },
  });
  const out = new Map();
  for (const p of view.buildProjectsFromCache(false)) for (const s of p.sessions) out.set(s.sessionId, s);
  return out;
}

const row = (sessionId, backendId, fields) => ({
  sessionId, projectPath: ALPHA, modified: '2026-09-15T00:00:00Z', summary: 'work', messageCount: 2, backendId, ...fields,
});

test('the payload carries the fill each backend can measure, and null where it cannot', () => {
  withIsolatedClaude(() => {
    const sessions = build([
      row('codex-a', 'codex', { lastInputTokens: 22056, lastModel: 'gpt-5.6-sol', contextWindowReported: 258400 }),
      row('claude-a', 'claude', { lastInputTokens: 471766, lastModel: 'claude-opus-5' }),
      row('hermes-a', 'hermes', { lastInputTokens: 50000, lastModel: 'claude-opus-5' }),
      row('no-turn-yet', 'claude', { lastInputTokens: 0, lastModelSpec: 'claude-sonnet-4-5' }),
      row('sub', 'claude', { lastInputTokens: 9000, lastModel: 'claude-haiku-4-5', parentSessionId: 'claude-a', agentId: 'x' }),
    ]);
    assert.deepEqual(sessions.get('codex-a').contextFill, { usedTokens: 22056, windowTokens: 258400, percent: 9 });
    assert.deepEqual(sessions.get('claude-a').contextFill, { usedTokens: 471766, windowTokens: 1000000, percent: 47 });
    assert.equal(sessions.get('hermes-a').contextFill, null, 'a backend that cannot read its last turn has no fill');
    assert.equal(sessions.get('no-turn-yet').contextFill, null, 'a window without a turn is no fill, not 0 %');
    assert.equal(sessions.get('sub').contextFill, null, 'the badge belongs to the session, not its subagent');
  });
});

test('the user\'s per-backend variables reach the hook — without them a 1M session would read as 200k', () => {
  withIsolatedClaude(() => {
    const rows = [row('claude-1m', 'claude', { lastInputTokens: 170000, lastModel: 'claude-sonnet-4-5' })];
    assert.deepEqual(build(rows, { backendEnv: { claude: { ANTHROPIC_MODEL: 'claude-sonnet-4-5[1m]' } } }).get('claude-1m').contextFill,
      { usedTokens: 170000, windowTokens: 1000000, percent: 17 });
    assert.deepEqual(build(rows, { backendEnv: { codex: { ANTHROPIC_MODEL: 'claude-sonnet-4-5[1m]' } } }).get('claude-1m').contextFill,
      { usedTokens: 170000, windowTokens: 200000, percent: 85 }, 'another backend\'s variables do not apply');
    assert.deepEqual(build(rows, null).get('claude-1m').contextFill,
      { usedTokens: 170000, windowTokens: 200000, percent: 85 }, 'no settings at all is not an error');
  });
});

test('a $VAR reference in the per-backend variables is resolved like the spawn resolves it', () => {
  withIsolatedClaude(() => {
    const rows = [row('claude-ref', 'claude', { lastInputTokens: 170000, lastModel: 'claude-sonnet-4-5' })];
    const savedRef = process.env.PV_CTX_MODEL;
    try {
      process.env.PV_CTX_MODEL = 'claude-sonnet-4-5[1m]';
      assert.equal(build(rows, { backendEnv: { claude: { ANTHROPIC_MODEL: '$PV_CTX_MODEL' } } }).get('claude-ref').contextFill.windowTokens,
        1000000, 'a set reference becomes its value');
      delete process.env.PV_CTX_MODEL;
      process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5[1m]';
      assert.equal(build(rows, { backendEnv: { claude: { ANTHROPIC_MODEL: '$PV_CTX_MODEL' } } }).get('claude-ref').contextFill.windowTokens,
        1000000, 'an unset reference is dropped, so the process variable shows through — as for the launched CLI');
    } finally {
      if (savedRef === undefined) delete process.env.PV_CTX_MODEL; else process.env.PV_CTX_MODEL = savedRef;
    }
  });
});

test('a template row asks with its BASE backend\'s variables and its own bundle on top', () => {
  withIsolatedClaude(() => {
    const registry = require('../src/backends');
    const profiles = new Map([
      ['tmpl-plain', { id: 'tmpl-plain', name: 'Plain', backendId: 'claude' }],
      ['tmpl-own', { id: 'tmpl-own', name: 'Own', backendId: 'claude', env: { ANTHROPIC_MODEL: 'claude-sonnet-4-5' } }],
    ]);
    registry.init({ profiles: { get: (id) => profiles.get(id) || null, list: () => [...profiles.values()] } });
    try {
      const settings = { backendEnv: { claude: { ANTHROPIC_MODEL: 'claude-sonnet-4-5[1m]' }, 'tmpl-plain': { ANTHROPIC_MODEL: 'claude-sonnet-4-5' } } };
      const sessions = build([
        row('t-plain', 'tmpl-plain', { lastInputTokens: 170000, lastModel: 'claude-sonnet-4-5' }),
        row('t-own', 'tmpl-own', { lastInputTokens: 170000, lastModel: 'claude-sonnet-4-5' }),
      ], settings);
      assert.equal(sessions.get('t-plain').contextFill.windowTokens, 1000000,
        'the base\'s key applies; a key named after the template is not what the spawn reads');
      assert.equal(sessions.get('t-own').contextFill.windowTokens, 200000, 'the template bundle wins over the base\'s variables');
    } finally {
      registry.init({ profiles: { get: () => null, list: () => [] } });
    }
  });
});

test('the stored launch model reaches the hook: global default, project override, template on top (O5)', () => {
  withIsolatedClaude(() => {
    const registry = require('../src/backends');
    const profiles = new Map([
      ['tmpl-opt', { id: 'tmpl-opt', name: 'Opt', backendId: 'claude', options: { model: 'claude-sonnet-4-5' } }],
    ]);
    registry.init({ profiles: { get: (id) => profiles.get(id) || null, list: () => [...profiles.values()] } });
    const rows = [
      row('plain', 'claude', { lastInputTokens: 170000, lastModel: 'claude-sonnet-4-5' }),
      row('tmpl', 'tmpl-opt', { lastInputTokens: 170000, lastModel: 'claude-sonnet-4-5' }),
    ];
    const projectBlobs = new Map();
    const buildWith = (globalSettings) => {
      view.init({
        PROJECTS_DIR: '/invented/nowhere', activeSessions: new Map(),
        db: {
          getAllMeta: () => new Map(), getAllCached: () => rows, getAllFolderMeta: () => new Map(), setFolderMeta: () => {},
          getFavoritedProjects: () => new Set(), getProjectDisplayNames: () => new Map(),
          getProjectStates: () => new Map([[ALPHA, REGISTERED]]),
          getSetting: (key) => (key === 'global' ? globalSettings : (projectBlobs.get(key) || null)),
        },
      });
      const out = new Map();
      for (const p of view.buildProjectsFromCache(false)) for (const s of p.sessions) out.set(s.sessionId, s.contextFill);
      return out;
    };
    try {
      const globalOneM = { backendDefaults: { claude: { model: 'claude-sonnet-4-5[1m]' } } };
      assert.equal(buildWith(globalOneM).get('plain').windowTokens, 1000000, 'the global default carries [1m]');
      assert.equal(buildWith(globalOneM).get('tmpl').windowTokens, 200000, 'the template\'s own option is the top layer');

      projectBlobs.set('project:' + ALPHA, { backendDefaults: { claude: { model: 'claude-sonnet-4-5' } } });
      assert.equal(buildWith(globalOneM).get('plain').windowTokens, 200000, 'the project override wins over the global default');

      // A worktree has no settings of its own: its row reads its PROJECT's override (rule 17).
      const worktreeRows = [row('in-worktree', 'claude', { lastInputTokens: 170000, lastModel: 'claude-sonnet-4-5', projectPath: ALPHA + '/.claude/worktrees/wt-1' })];
      rows.push(...worktreeRows);
      assert.equal(buildWith(globalOneM).get('in-worktree').windowTokens, 200000, 'a worktree session takes its project\'s override');
      rows.splice(rows.length - worktreeRows.length);

      projectBlobs.clear();
      process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5';
      assert.equal(buildWith(globalOneM).get('plain').windowTokens, 1000000, 'a bare ANTHROPIC_MODEL does not take the launch model\'s [1m] away (E12)');
    } finally {
      registry.init({ profiles: { get: () => null, list: () => [] } });
    }
  });
});

test('a Pi row carries the fill from Pi\'s catalog', () => {
  const piWindows = require('../src/backends/pi/model-windows');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-ctxfill-pi-'));
  const store = path.join(root, 'stores', 'pi');
  const agentDir = path.join(root, 'stores', 'pi-agent');
  const saved = process.env.SWITCHBOARD_STORE_PI;
  try {
    fs.mkdirSync(store, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'models-store.json'), JSON.stringify({ 'openai-codex': { models: [{ id: 'gpt-5.6-sol', contextWindow: 272000 }] } }));
    process.env.SWITCHBOARD_STORE_PI = store;
    piWindows._resetCache();
    const sessions = build([row('pi-a', 'pi', { lastInputTokens: 136000, lastProvider: 'openai-codex', lastModel: 'gpt-5.6-sol' })]);
    assert.deepEqual(sessions.get('pi-a').contextFill, { usedTokens: 136000, windowTokens: 272000, percent: 50 });
  } finally {
    if (saved === undefined) delete process.env.SWITCHBOARD_STORE_PI; else process.env.SWITCHBOARD_STORE_PI = saved;
    piWindows._resetCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a fill above the window is passed on as it is, not capped', () => {
  withIsolatedClaude(() => {
    const sessions = build([row('switched', 'claude', { lastInputTokens: 240000, lastModel: 'claude-opus-5', lastModelSpec: 'claude-sonnet-4-5' })]);
    assert.deepEqual(sessions.get('switched').contextFill, { usedTokens: 240000, windowTokens: 200000, percent: 120 });
  });
});

test('an unknown backend or a throwing hook cannot take the sidebar down', () => {
  // The descriptor the view asks is the REGISTRY's entry, not the module export.
  const codex = require('../src/backends').get('codex');
  const original = codex.contextWindow;
  try {
    codex.contextWindow = () => { throw new Error('boom'); };
    const sessions = build([
      row('odd', 'not-a-backend-at-all', { lastInputTokens: 5000 }),
      row('throws', 'codex', { lastInputTokens: 5000, contextWindowReported: 258400 }),
    ]);
    assert.equal(sessions.get('odd').contextFill, null);
    assert.equal(sessions.get('throws').contextFill, null);
  } finally {
    codex.contextWindow = original;
  }
});
