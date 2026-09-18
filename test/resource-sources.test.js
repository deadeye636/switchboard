// #632 — which of another backend's resources a session takes over ("Resources from").
//
// Two halves: the seam itself against a stub registry (filtering, trust, the one-source rule), and the
// real descriptors' declarations, so a backend that stops offering or accepting fails here by name.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const backends = require('../src/backends');
const resourceSources = require('../src/app/resource-sources');

const CLAUDE_LIKE_DIALECT = { allArguments: '$ARGUMENTS' };

function stubRegistry(descriptors) {
  const byId = new Map(descriptors.map((d) => [d.id, d]));
  return {
    list: () => descriptors.map((d) => ({ ...d })),
    get: (id) => byId.get(id) || null,
  };
}

function source(id, rows, shared) {
  return {
    id,
    label: id.toUpperCase(),
    status: 'ready',
    sharedResources: shared,
    listResources: async () => ({ ok: true, resources: rows }),
  };
}

const rows = [
  { kind: 'skill', scope: 'global', path: '<home>/src-a/skills', source: 'skills-directory' },
  { kind: 'skill', scope: 'global', path: '<home>/src-a/plugins/x/skills', source: 'plugin-skills:x' },
  { kind: 'command', scope: 'global', path: '<home>/src-a/commands', source: 'commands-directory' },
  { kind: 'skill', scope: 'project', path: '<project>/.src-a/skills', source: 'project-skills' },
  { kind: 'command', scope: 'project', path: '<project>/.src-a/commands', source: 'project-commands' },
  { kind: 'agent', scope: 'global', path: '<home>/src-a/agents', source: 'agents-directory' },
  { kind: 'settings', scope: 'global', path: '<home>/src-a/settings.json', source: 'settings-file' },
];

function withRegistry({ trusted = false } = {}) {
  const target = {
    id: 'tgt',
    status: 'ready',
    sharedResources: null,
    acceptsSharedResources: ['skill', 'command'],
    trustsProjectResources: () => trusted,
  };
  const a = source('src-a', rows, {
    sources: ['skills-directory', 'commands-directory', 'project-skills', 'project-commands'],
    commandDialect: CLAUDE_LIKE_DIALECT,
  });
  const b = source('src-b', [
    { kind: 'skill', scope: 'global', path: '<home>/src-b/skills', source: 'skills-directory' },
    { kind: 'command', scope: 'global', path: '<home>/src-b/prompts', source: 'prompts-directory' },
  ], { sources: ['skills-directory', 'prompts-directory'], commandDialect: null });
  const silent = { id: 'silent', status: 'ready', sharedResources: null, listResources: async () => ({ ok: true, resources: [] }) };
  const planned = source('planned', rows, { sources: ['skills-directory'], commandDialect: null });
  planned.status = 'planned';
  const template = { ...source('tpl', rows, { sources: ['skills-directory'], commandDialect: null }), isProfile: true };
  resourceSources.init({ backends: stubRegistry([target, a, b, silent, planned, template]) });
  return target;
}

test('only built-in, non-planned backends that offer something are sources, never the target itself', () => {
  withRegistry();
  assert.deepEqual(resourceSources.sourcesFor('tgt').map((s) => s.id), ['src-a', 'src-b']);
  assert.deepEqual(resourceSources.sourcesFor('src-a'), [], 'a backend that accepts nothing has no sources');
});

test('a source hands over its declared skill and command directories, never plugins, agents or settings', async () => {
  withRegistry({ trusted: true });
  const r = await resourceSources.resolve({ target: 'tgt', sourceId: 'src-a', projectPath: '<project>' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.skills, [
    { path: '<home>/src-a/skills', scope: 'global' },
    { path: '<project>/.src-a/skills', scope: 'project' },
  ]);
  assert.deepEqual(r.commands.map((c) => c.path), ['<home>/src-a/commands', '<project>/.src-a/commands']);
  assert.deepEqual(r.commands[0].dialect, CLAUDE_LIKE_DIALECT);
  assert.deepEqual(r.dropped, []);
});

test('an untrusted project keeps the global directories and reports the project ones as dropped (E1)', async () => {
  withRegistry({ trusted: false });
  const r = await resourceSources.resolve({ target: 'tgt', sourceId: 'src-a', projectPath: '<project>' });
  assert.deepEqual(r.skills.map((s) => s.scope), ['global']);
  assert.deepEqual(r.commands.map((c) => c.scope), ['global']);
  assert.deepEqual(r.dropped.map((d) => [d.kind, d.reason]), [
    ['skill', 'untrusted-project'],
    ['command', 'untrusted-project'],
  ]);
});

test('the trust question receives this launch\'s options, so a per-run override can answer it', async () => {
  const target = withRegistry();
  let seen = null;
  target.trustsProjectResources = (arg) => { seen = arg; return true; };
  await resourceSources.resolve({ target, sourceId: 'src-a', projectPath: '<project>', options: { approval: 'approve' } });
  assert.deepEqual(seen, { projectPath: '<project>', options: { approval: 'approve' } });
});

test('commands from a source without a dialect are dropped, not passed as plain text', async () => {
  withRegistry();
  const r = await resourceSources.resolve({ target: 'tgt', sourceId: 'src-b' });
  assert.deepEqual(r.skills.map((s) => s.path), ['<home>/src-b/skills']);
  assert.deepEqual(r.commands, []);
  assert.deepEqual(r.dropped.map((d) => d.reason), ['no-command-dialect']);
});

test('no source means nothing to hand over; an unknown or silent source is refused', async () => {
  withRegistry();
  const none = await resourceSources.resolve({ target: 'tgt', sourceId: '' });
  assert.deepEqual(none, { ok: true, source: null, skills: [], commands: [], dropped: [] });
  for (const id of ['silent', 'planned', 'tpl', 'nope', 'tgt']) {
    const r = await resourceSources.resolve({ target: 'tgt', sourceId: id });
    assert.equal(r.ok, false, id);
    assert.deepEqual([r.skills, r.commands], [[], []], id);
  }
});

test('a source whose listing throws or fails answers ok:false with nothing, never a partial list', async () => {
  const target = withRegistry();
  const reg = stubRegistry([
    target,
    { ...source('src-a', [], { sources: ['skills-directory'], commandDialect: null }), listResources: async () => { throw new Error('boom'); } },
    { ...source('src-b', [], { sources: ['skills-directory'], commandDialect: null }), listResources: async () => ({ ok: false, reason: 'nope' }) },
  ]);
  resourceSources.init({ backends: reg });
  for (const id of ['src-a', 'src-b']) {
    const r = await resourceSources.resolve({ target: 'tgt', sourceId: id });
    assert.equal(r.ok, false, id);
    assert.deepEqual(r.skills, [], id);
  }
});

// ── The real descriptors ────────────────────────────────────────────────────────────────────────────

// Every source a backend OFFERS must be one its listing really EMITS, with the kind it is offered as.
// Without this, renaming `project-skills` in a backend's resources.js would drop the project half silently
// and every other test here would stay green. Each listing is built over a throwaway home and project that
// hold every directory the backend knows, so what it emits is exactly what it can emit.
test('every source a backend offers is emitted by its own listing, as a skill or a command', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-632-src-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mk = (...parts) => { const p = path.join(root, ...parts); fs.mkdirSync(p, { recursive: true }); return p; };
  const project = mk('project');
  for (const d of ['skills', 'commands', 'agents']) mk('project', '.claude', d);
  for (const d of ['skills', 'commands', 'agents']) mk('claude-home', d);
  mk('codex-home', 'skills');
  mk('gemini', 'config', 'skills');
  const conversations = mk('gemini', 'antigravity', 'conversations');

  const listings = {
    claude: require('../src/backends/claude/resources').createListResources({ claudeHome: () => path.join(root, 'claude-home') }),
    codex: require('../src/backends/codex/resources').createListResources({ codexHome: () => path.join(root, 'codex-home') }),
    agy: require('../src/backends/agy/resources').createListResources({ conversationsRoot: () => conversations }),
  };
  const offering = backends.list().filter((b) => !b.isProfile && backends.get(b.id).sharedResources);
  assert.deepEqual(offering.map((b) => b.id).sort(), Object.keys(listings).sort(),
    'a new offering backend needs a listing fixture here');
  for (const b of offering) {
    const emitted = listings[b.id]({ projectPath: project }).resources;
    for (const source of backends.get(b.id).sharedResources.sources) {
      const row = emitted.find((r) => r.source === source);
      assert.ok(row, `${b.id} offers '${source}', which its listing never emits`);
      assert.ok(['skill', 'command'].includes(row.kind), `${b.id} '${source}' is a ${row.kind}`);
    }
  }
});

test('a target that takes only skills gets no commands, whatever the source offers', async () => {
  const target = withRegistry({ trusted: true });
  target.acceptsSharedResources = ['skill'];
  const r = await resourceSources.resolve({ target, sourceId: 'src-a', projectPath: '<project>' });
  assert.equal(r.skills.length, 2);
  assert.deepEqual(r.commands, []);
  assert.deepEqual(r.dropped, [], 'a kind the target never takes is not a drop worth reporting');
});

test('the owner\'s three sources offer skills; only Claude declares a command dialect', () => {
  resourceSources.init({ backends });
  const byId = (id) => backends.get(id).sharedResources;
  for (const id of ['claude', 'codex', 'agy']) {
    assert.ok(byId(id) && byId(id).sources.includes('skills-directory'), id);
    assert.ok(!byId(id).sources.some((s) => s.startsWith('plugin')), `${id}: plugin skills stay out (E5)`);
  }
  assert.ok(byId('claude').sources.includes('commands-directory'));
  assert.ok(byId('claude').commandDialect && byId('claude').commandDialect.inlineShell.permissionKey === 'allowed-tools');
  assert.equal(byId('codex').commandDialect, null);
  assert.equal(byId('agy').commandDialect, null);
  assert.equal(byId('hermes'), null);
});

test('both Pi backends take skills and commands, and offer Claude, Codex and Antigravity as sources', () => {
  resourceSources.init({ backends });
  for (const id of ['pi', 'pi-native']) {
    assert.deepEqual(backends.get(id).acceptsSharedResources, ['skill', 'command'], id);
    assert.deepEqual(resourceSources.sourcesFor(id).map((s) => s.id).sort(), ['agy', 'claude', 'codex'], id);
  }
  assert.deepEqual(resourceSources.sourcesFor('claude'), [], 'Claude takes nothing over');
});

test('Pi trusts a project\'s resources only on an explicit yes: the run override first, then the saved decision', () => {
  const pi = backends.get('pi');
  assert.equal(pi.trustsProjectResources({ projectPath: '<project>', options: { approval: 'approve' } }), true);
  assert.equal(pi.trustsProjectResources({ projectPath: '<project>', options: { approval: 'no-approve' } }), false);
  assert.equal(pi.trustsProjectResources({ projectPath: null, options: {} }), false);
});

test('Pi\'s saved trust decides when the run does not override it, and "no decision" is not trust', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-632-trust-'));
  const agentDir = path.join(root, 'agent');
  fs.mkdirSync(agentDir);
  const trustedDir = path.join(root, 'trusted');
  fs.mkdirSync(trustedDir);
  const refusedDir = path.join(root, 'refused');
  const unknownDir = path.join(root, 'unknown');
  fs.mkdirSync(refusedDir);
  fs.mkdirSync(unknownDir);
  const canonical = (p) => fs.realpathSync(p);   // the spelling trust.js keys by
  fs.writeFileSync(path.join(agentDir, 'trust.json'), JSON.stringify({
    [canonical(trustedDir)]: true,
    [canonical(refusedDir)]: false,
  }));
  const before = process.env.SWITCHBOARD_STORE_PI;
  process.env.SWITCHBOARD_STORE_PI = path.join(agentDir, 'sessions');
  t.after(() => {
    if (before === undefined) delete process.env.SWITCHBOARD_STORE_PI; else process.env.SWITCHBOARD_STORE_PI = before;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const pi = backends.get('pi');
  assert.equal(pi.trustsProjectResources({ projectPath: trustedDir, options: {} }), true);
  assert.equal(pi.trustsProjectResources({ projectPath: refusedDir, options: {} }), false);
  assert.equal(pi.trustsProjectResources({ projectPath: unknownDir, options: {} }), false);
  assert.equal(pi.trustsProjectResources({ projectPath: refusedDir, options: { approval: 'approve' } }), true,
    'the run override wins over a saved no, as it does in Pi');
});
