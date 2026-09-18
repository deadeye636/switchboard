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
  assert.deepEqual(none, { ok: true, source: null, skills: [], commands: [], agents: [], mcpServers: [], dropped: [] });
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
test('every source a backend offers is emitted by its own listing, as a skill, a command or an agent', (t) => {
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
      assert.ok(['skill', 'command', 'agent'].includes(row.kind), `${b.id} '${source}' is a ${row.kind}`);
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

test('both Pi backends take skills, commands, agents and MCP servers, and offer Claude, Codex and Antigravity as sources', () => {
  resourceSources.init({ backends });
  for (const id of ['pi', 'pi-native']) {
    assert.deepEqual(backends.get(id).acceptsSharedResources, ['skill', 'command', 'agent', 'mcp-server'], id);
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

// ── Steps 2 and 3: Pi turns the resolved source into flags and one extension ─────────────────────────

function tmp() {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-632-res-'));
}

test('Pi hands a source\'s skill directories over as --skill, in order, and its commands in one extension', async () => {
  const fs = require('node:fs');
  const pi = backends.get('pi');
  const dir = tmp();
  try {
    const resolved = {
      ok: true,
      skills: [{ path: '<home>/a/skills', scope: 'global' }, { path: '<project>/.a/skills', scope: 'project' }],
      commands: [{ path: '<home>/a/commands', scope: 'global', dialect: { allArguments: '$ARGUMENTS' } }],
      dropped: [{ path: '<project>/.a/commands', kind: 'command', scope: 'project', reason: 'untrusted-project' }],
    };
    let asked = null;
    const built = await pi.buildSessionResources({
      dir, tag: 't632',
      options: { resourcesFrom: 'src-a' },
      resolveSource: async (id) => { asked = id; return resolved; },
    });
    assert.equal(asked, 'src-a');
    assert.deepEqual(built.args, ['--skill', '<home>/a/skills', '--skill', '<project>/.a/skills', '--extension', built.cleanup]);
    assert.deepEqual(built.dropped.map((d) => d.reason), ['untrusted-project']);
    const text = fs.readFileSync(built.cleanup, 'utf8');
    assert.match(text, /registerSourceCommands\(pi\);/);
    assert.ok(text.includes(JSON.stringify('<home>/a/commands')));
    assert.doesNotMatch(text, /registerSubagent\(pi\);/, 'the tool is off, so its section is not written');
    pi.releaseSessionResources(built.cleanup);
    assert.equal(fs.existsSync(built.cleanup), false);
  } finally {
    require('node:fs').rmSync(dir, { recursive: true, force: true });
  }
});

test('skills alone need no file; no source and no tool means nothing at all', async () => {
  const pi = backends.get('pi');
  const dir = tmp();
  try {
    const skillsOnly = pi.buildSessionResources({
      dir, tag: 't1', options: { resourcesFrom: 'x' },
      resolveSource: () => ({ ok: true, skills: [{ path: '<home>/s', scope: 'global' }], commands: [], dropped: [] }),
    });
    assert.deepEqual(skillsOnly.args, ['--skill', '<home>/s']);
    assert.equal(skillsOnly.cleanup, null);
    let called = false;
    assert.equal(pi.buildSessionResources({ dir, tag: 't2', options: {}, resolveSource: () => { called = true; } }), null);
    assert.equal(pi.buildSessionResources({ dir, tag: 't3', options: { resourcesFrom: '  ' }, resolveSource: () => { called = true; } }), null);
    assert.equal(called, false, 'no source, no listing');
    const failed = await pi.buildSessionResources({ dir, tag: 't4', options: { resourcesFrom: 'x' }, resolveSource: async () => ({ ok: false }) });
    assert.deepEqual(failed.args, [], 'a source that answers nothing gives nothing, and still says which source it was');
    assert.equal(failed.source, 'x');
    assert.deepEqual(require('node:fs').readdirSync(dir), []);
  } finally {
    require('node:fs').rmSync(dir, { recursive: true, force: true });
  }
});

test('a source\'s commands and the subagent tool share ONE extension file (O5)', () => {
  const fs = require('node:fs');
  const pi = backends.get('pi');
  const dir = tmp();
  try {
    const built = pi.buildSessionResources({
      dir, tag: 'both',
      options: { resourcesFrom: 'x', subagentTool: true },
      resolveSource: () => ({ ok: true, skills: [], commands: [{ path: '<home>/c', scope: 'global', dialect: {} }], dropped: [] }),
    });
    assert.equal(built.args.filter((a) => a === '--extension').length, 1);
    assert.deepEqual(fs.readdirSync(dir), ['pi-resources-both.ts']);
    const text = fs.readFileSync(built.cleanup, 'utf8');
    assert.match(text, /registerSubagent\(pi\);\n  registerSourceCommands\(pi\);/);
    assert.equal((text.match(/from "@earendil-works\/pi-coding-agent";/g) || []).length, 1, 'one merged import line');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pi-native and a template on Pi carry the same hook, and the flag audit derives --skill and --extension from it', () => {
  const pi = backends.get('pi');
  assert.equal(backends.get('pi-native').buildSessionResources, pi.buildSessionResources);
  const tpl = backends.profileToDescriptor({ id: 'tpl-pi', name: 'A template', backendId: 'pi' });
  assert.equal(tpl.buildSessionResources, pi.buildSessionResources);
  assert.equal(tpl.releaseSessionResources, pi.releaseSessionResources);
  assert.equal(tpl.providesSessionResources, true);
  assert.deepEqual(tpl.acceptsSharedResources, pi.acceptsSharedResources);
  const { managedFlags } = require('../scripts/managed-flags');
  for (const b of [pi, backends.get('pi-native')]) {
    assert.ok(managedFlags(b).includes('--skill'), `${b.id} can send --skill, so its help check audits it`);
    assert.ok(managedFlags(b).includes('--extension'));
  }
});

test('the spawn path resolves against the session\'s working directory and places the flags before the #569 templates', () => {
  // A source check (node-pty loads at require time, so there is no seam to call): what it pins is the
  // regression that will happen — the block moved below the templates, or handed the settings owner's path.
  const fs = require('node:fs');
  const path = require('node:path');
  const { stripComments } = require('./helpers/strip-comments');
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'terminal', 'spawn.js'), 'utf8'));
  const shared = src.indexOf('backend.buildSessionResources(');
  const templates = src.indexOf('backend.buildPromptTemplates(');
  assert.ok(shared > 0 && templates > 0 && shared < templates, 'shared resources come before the templates');
  const call = src.slice(shared, src.indexOf('});', shared));
  assert.match(call, /resourceSources\.resolve\(\{ target: backend, sourceId, projectPath: projectPath \|\| null, options \}\)/);
  assert.doesNotMatch(call, /settingsOwnerPath/);
  // The options are the CASCADED ones: the global and project settings are where `resourcesFrom` is set, and
  // the raw session options would silently drop both.
  const block = src.slice(src.lastIndexOf('if (backend.providesSessionResources === true', shared), shared);
  assert.match(block, /const options = spawnOptionsFor\(backend, projectPath, sessionOptions\)/);
});

test('after the shared-resources await, a quit or a second open of the same session stops this spawn', () => {
  // The first await on a Pi spawn before the session is registered. A quit that began meanwhile has already
  // collected its pids, and a racing open may have registered the session — spawning anyway orphans a
  // process or doubles one. Source check, for the reason given above.
  const fs = require('node:fs');
  const path = require('node:path');
  const { stripComments } = require('./helpers/strip-comments');
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'terminal', 'spawn.js'), 'utf8'));
  const start = src.indexOf('backend.buildSessionResources(');
  const after = src.slice(start, src.indexOf('backend.buildPromptTemplates(', start));
  assert.match(after, /if \(ctx\.getAppQuitting\(\)\) \{\s*releaseSpawnAllocations\(\);\s*return/);
  assert.match(after, /ctx\.activeSessions\.get\(sessionId\)[\s\S]*releaseSpawnAllocations\(\);\s*return openTerminal\(/);
});

// ── Step 4: the select's choices and the settings preview ──────────────────────────────────────────

test('a select declaring choicesFrom gets one choice per source after its own, labelled by the source', () => {
  const target = withRegistry();
  target.configFields = [
    { id: 'other', type: 'select', choices: ['x'], default: 'x' },
    { id: 'from', type: 'select', choices: [''], choicesFrom: resourceSources.SOURCE_CHOICES, choiceLabels: { '': 'None' }, default: '' },
  ];
  const fields = resourceSources.projectFields(target);
  assert.equal(fields[0], target.configFields[0], 'a field that asks for nothing is passed through untouched');
  assert.deepEqual(fields[1].choices, ['', 'src-a', 'src-b']);
  assert.deepEqual(fields[1].choiceLabels, { '': 'None', 'src-a': 'SRC-A', 'src-b': 'SRC-B' });
  assert.equal(fields[1].sourcePreview, true, 'the settings screen learns to offer the preview from the core');
  assert.deepEqual(target.configFields[1].choices, [''], 'the descriptor itself is not mutated');
  assert.ok(fields[1].choices.includes(fields[1].default), 'the default stays one of the choices');
});

test('a target whose fields ask for nothing gets its own array back, and a target that accepts nothing gets no sources', () => {
  const target = withRegistry();
  target.configFields = [{ id: 'a', type: 'text', default: '' }];
  assert.equal(resourceSources.projectFields(target), target.configFields);
  const src = { id: 'src-a', configFields: [{ id: 'from', type: 'select', choices: [''], choicesFrom: resourceSources.SOURCE_CHOICES, default: '' }] };
  assert.deepEqual(resourceSources.projectFields(src)[0].choices, [''], 'no accepted kinds, no sources to list');
});

test('the real Pi fields list Claude, Codex and Antigravity as sources, on both Pi backends', () => {
  resourceSources.init({ backends });
  for (const id of ['pi', 'pi-native']) {
    const field = resourceSources.projectFields(backends.get(id)).find((f) => f.id === 'resourcesFrom');
    assert.ok(field, id);
    assert.deepEqual([...field.choices].sort(), ['', 'agy', 'claude', 'codex'], id);
    assert.equal(field.sourcePreview, true, id);
    for (const c of field.choices) assert.ok(field.choiceLabels[c], `${id}: "${c}" has a label`);
  }
});

test('the preview resolves the named source with the options it is handed, and names the source', async () => {
  const target = withRegistry();
  let seen = null;
  target.trustsProjectResources = (arg) => { seen = arg; return arg.options.approval === 'approve'; };
  const r = await resourceSources.preview({ backendId: 'tgt', sourceId: 'src-a', projectPath: '<project>', options: { approval: 'approve' } });
  assert.equal(r.ok, true);
  assert.equal(r.sourceLabel, 'SRC-A');
  assert.deepEqual(r.skills.map((s) => s.scope), ['global', 'project']);
  assert.deepEqual(seen, { projectPath: '<project>', options: { approval: 'approve' } });
});

test('the preview takes its window-side input apart: no nested options, no non-string ids', async () => {
  const target = withRegistry();
  let seen = null;
  target.trustsProjectResources = (arg) => { seen = arg; return false; };
  const r = await resourceSources.preview({
    backendId: 'tgt', sourceId: 'src-a', projectPath: '<project>',
    options: { approval: 'approve', nested: { a: 1 }, list: [1], fn: null },
  });
  assert.deepEqual(seen.options, { approval: 'approve', fn: null });
  assert.equal(r.ok, true);
  assert.deepEqual((await resourceSources.preview({ backendId: 42 })).ok, false);
  assert.deepEqual((await resourceSources.preview({ backendId: 'nope' })).ok, false);
  const none = await resourceSources.preview({ backendId: 'tgt', sourceId: { id: 'src-a' } });
  assert.equal(none.source, null, 'a source that is not a string is no source');
  assert.equal(none.sourceLabel, null);
});

test('the preview without a project lists only the global directories', async () => {
  withRegistry({ trusted: true });
  const r = await resourceSources.preview({ backendId: 'tgt', sourceId: 'src-a', projectPath: null });
  assert.deepEqual([...r.skills, ...r.commands].map((x) => x.scope).filter((s) => s !== 'global'), []);
});

test('the preview is registered as an IPC handler', async () => {
  withRegistry();
  const handlers = new Map();
  resourceSources.registerIpc({ handle: (name, fn) => handlers.set(name, fn) });
  assert.deepEqual([...handlers.keys()], ['resource-sources-preview']);
  const r = await handlers.get('resource-sources-preview')(null, { backendId: 'tgt', sourceId: '' });
  assert.equal(r.ok, true);
  assert.equal(r.source, null);
});

test('a select whose target has no source to offer is not marked for a preview', () => {
  const target = withRegistry();
  resourceSources.init({ backends: stubRegistry([target]) });
  target.configFields = [{ id: 'from', type: 'select', choices: [''], choicesFrom: resourceSources.SOURCE_CHOICES, default: '' }];
  const [field] = resourceSources.projectFields(target);
  assert.deepEqual(field.choices, ['']);
  assert.equal(field.sourcePreview, false);
});

// ── #639: agents, and a kind the target declines for this launch ────────────────────────────────────

const AGENT_DIALECT = { toolsKey: 'tools', toolWords: { Read: 'read' } };

function withAgents({ trusted = true, decline = null, dialect = AGENT_DIALECT } = {}) {
  const target = {
    id: 'tgt', status: 'ready', sharedResources: null,
    acceptsSharedResources: ['skill', 'command', 'agent'],
    trustsProjectResources: () => trusted,
  };
  if (decline) target.declinesSharedResource = decline;
  const a = source('src-a', rows, {
    sources: ['skills-directory', 'agents-directory'],
    commandDialect: null,
    agentDialect: dialect,
  });
  resourceSources.init({ backends: stubRegistry([target, a]) });
  return target;
}

test('an agent directory is handed over with the source\'s agent dialect', async () => {
  withAgents();
  const r = await resourceSources.resolve({ target: 'tgt', sourceId: 'src-a' });
  assert.deepEqual(r.agents, [{ path: '<home>/src-a/agents', scope: 'global', dialect: AGENT_DIALECT }]);
});

test('agents of a source without an agent dialect are dropped with a reason, not guessed at', async () => {
  withAgents({ dialect: null });
  const r = await resourceSources.resolve({ target: 'tgt', sourceId: 'src-a' });
  assert.deepEqual(r.agents, []);
  assert.deepEqual(r.dropped.map((d) => [d.kind, d.reason]), [['agent', 'no-agent-dialect']]);
});

test('a kind the target declines for this launch is dropped with the target\'s own note, asked once per kind and scope', async () => {
  const asked = [];
  withAgents({
    decline: (arg) => { asked.push([arg.kind, arg.scope, arg.options.flag]); return arg.kind === 'agent' ? { reason: 'target-declined', note: 'not now' } : null; },
  });
  const r = await resourceSources.resolve({ target: 'tgt', sourceId: 'src-a', options: { flag: 1 } });
  assert.deepEqual(r.agents, []);
  assert.deepEqual(r.skills.map((s) => s.path), ['<home>/src-a/skills']);
  assert.deepEqual(r.dropped, [{ path: '<home>/src-a/agents', kind: 'agent', scope: 'global', reason: 'target-declined', note: 'not now' }]);
  assert.deepEqual(asked, [['skill', 'global', 1], ['agent', 'global', 1]]);
});

test('a declining hook that throws or answers nonsense takes nothing away', async () => {
  for (const decline of [() => { throw new Error('boom'); }, () => ({ reason: '' }), () => 'no']) {
    withAgents({ decline });
    const r = await resourceSources.resolve({ target: 'tgt', sourceId: 'src-a' });
    assert.equal(r.agents.length, 1);
    assert.deepEqual(r.dropped, []);
  }
});

test('Pi declines a source\'s agents while its subagent tool is off, and takes them when it is on', () => {
  for (const id of ['pi', 'pi-native']) {
    const b = backends.get(id);
    const off = b.declinesSharedResource({ kind: 'agent', scope: 'global', options: {} });
    assert.equal(off.reason, 'target-declined', id);
    assert.match(off.note, /subagent tool is off/, id);
    assert.equal(b.declinesSharedResource({ kind: 'agent', scope: 'global', options: { subagentTool: true } }), null, id);
    assert.equal(b.declinesSharedResource({ kind: 'skill', scope: 'global', options: {} }), null, `${id}: skills are never declined`);
  }
});

test('Claude offers its agent directories with an agent dialect; Codex and agy offer none', () => {
  const claude = backends.get('claude').sharedResources;
  assert.ok(claude.sources.includes('agents-directory'));
  assert.ok(claude.sources.includes('project-agents'));
  assert.equal(claude.agentDialect.inheritModel, 'inherit');
  for (const id of ['codex', 'agy']) assert.equal(backends.get(id).sharedResources.agentDialect, undefined, id);
});

// ── #633: MCP servers, which a source answers through its own hook ─────────────────────────────────

function withMcp({ trusted = true, decline = null, servers, throws = false, accepts = ['skill', 'mcp-server'] } = {}) {
  const target = {
    id: 'tgt', status: 'ready', sharedResources: null,
    acceptsSharedResources: accepts,
    trustsProjectResources: () => trusted,
  };
  if (decline) target.declinesSharedResource = decline;
  const a = source('src-a', rows, { sources: ['skills-directory'], commandDialect: null });
  const asked = [];
  a.listSharedMcpServers = (arg) => {
    asked.push(arg);
    if (throws) throw new Error('boom');
    return { ok: true, servers };
  };
  resourceSources.init({ backends: stubRegistry([target, a]) });
  return asked;
}

const stdio = (name, extra = {}) => ({
  name, scope: 'global', origin: 'user', path: '<home>/src-a.json', transport: 'stdio',
  command: 'node', args: ['server.js'], env: { TOKEN: 'secret' }, ...extra,
});

test('a stdio MCP server is handed over with its command, arguments and env, and the source is asked with the project', async () => {
  const asked = withMcp({ servers: [stdio('one')] });
  const r = await resourceSources.resolve({ target: 'tgt', sourceId: 'src-a', projectPath: '<project>' });
  assert.deepEqual(r.mcpServers, [{
    name: 'one', scope: 'global', origin: 'user', path: '<home>/src-a.json', command: 'node', args: ['server.js'], env: { TOKEN: 'secret' },
  }]);
  assert.equal(asked[0].projectPath, '<project>');
});

test('MCP servers are dropped with a reason: other transports, untrusted project, no command, a missing variable', async () => {
  withMcp({
    trusted: false,
    servers: [
      { name: 'remote', scope: 'global', origin: 'user', path: '<home>/src-a.json', transport: 'http' },
      stdio('repo', { scope: 'project', origin: 'project', path: '<project>/.mcp.json', approved: true }),
      stdio('empty', { command: '' }),
      stdio('needs', { missingEnv: ['API_KEY'] }),
    ],
  });
  const r = await resourceSources.resolve({ target: 'tgt', sourceId: 'src-a', projectPath: '<project>' });
  assert.deepEqual(r.mcpServers, []);
  assert.deepEqual(r.dropped.filter((d) => d.kind === 'mcp-server').map((d) => [d.name, d.reason]), [
    ['remote', 'transport-unsupported'], ['repo', 'untrusted-project'], ['empty', 'no-command'], ['needs', 'missing-env'],
  ]);
  assert.match(r.dropped.find((d) => d.name === 'needs').note, /API_KEY/);
});

test('a project MCP server needs both the target\'s trust and the source\'s approval', async () => {
  withMcp({
    servers: [
      stdio('ok', { scope: 'project', origin: 'project', approved: true }),
      stdio('pending', { scope: 'project', origin: 'project', approved: false }),
    ],
  });
  const r = await resourceSources.resolve({ target: 'tgt', sourceId: 'src-a', projectPath: '<project>' });
  assert.deepEqual(r.mcpServers.map((s) => s.name), ['ok']);
  assert.deepEqual(r.dropped.map((d) => [d.name, d.reason]), [['pending', 'not-approved']]);
});

test('the first row of an MCP server name decides, even when that row cannot be started', async () => {
  withMcp({
    servers: [
      { name: 'dup', scope: 'global', origin: 'local', path: '<home>/src-a.json', transport: 'http' },
      stdio('dup'),
      stdio('solo', { origin: 'local' }),
      stdio('solo'),
    ],
  });
  const r = await resourceSources.resolve({ target: 'tgt', sourceId: 'src-a' });
  assert.deepEqual(r.mcpServers.map((s) => [s.name, s.origin]), [['solo', 'local']]);
  assert.deepEqual(r.dropped.map((d) => [d.name, d.reason]), [['dup', 'transport-unsupported'], ['dup', 'shadowed'], ['solo', 'shadowed']]);
});

test('a target that declines every MCP server for this launch costs no read of the source, and says so once', async () => {
  const asked = withMcp({ servers: [stdio('one')], decline: ({ kind }) => (kind === 'mcp-server' ? { reason: 'target-declined', note: 'off' } : null) });
  const r = await resourceSources.resolve({ target: 'tgt', sourceId: 'src-a' });
  assert.equal(asked.length, 0);
  assert.deepEqual(r.mcpServers, []);
  assert.deepEqual(r.dropped.map((d) => [d.kind, d.name, d.reason, d.note]), [['mcp-server', null, 'target-declined', 'off']]);
});

test('a decline for one scope only is reported per server, before any detail of its definition', async () => {
  withMcp({
    servers: [stdio('repo', { scope: 'project', origin: 'project', missingEnv: ['X'] }), stdio('mine')],
    decline: ({ kind, scope }) => (kind === 'mcp-server' && scope === 'project' ? { reason: 'target-declined', note: 'no project servers' } : null),
  });
  const r = await resourceSources.resolve({ target: 'tgt', sourceId: 'src-a', projectPath: '<project>' });
  assert.deepEqual(r.mcpServers.map((s) => s.name), ['mine']);
  assert.deepEqual(r.dropped.map((d) => [d.name, d.reason, d.note]), [['repo', 'target-declined', 'no project servers']]);
});

test('the launch\'s environment is what the source expands against; without one, this process\'s', async () => {
  const asked = withMcp({ servers: [] });
  await resourceSources.resolve({ target: 'tgt', sourceId: 'src-a', env: { ONLY_HERE: '1' } });
  await resourceSources.resolve({ target: 'tgt', sourceId: 'src-a' });
  assert.deepEqual(asked[0].env, { ONLY_HERE: '1' });
  assert.equal(asked[1].env, process.env);
});

test('a throwing source gives no MCP servers and takes nothing else away', async () => {
  let r;
  withMcp({ servers: [stdio('one')], throws: true });
  r = await resourceSources.resolve({ target: 'tgt', sourceId: 'src-a' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.mcpServers, []);
  assert.deepEqual(r.skills.map((s) => s.path), ['<home>/src-a/skills']);
});

test('a target that does not accept MCP servers never asks the source for them', async () => {
  const asked = withMcp({ servers: [stdio('one')], accepts: ['skill'] });
  const r = await resourceSources.resolve({ target: 'tgt', sourceId: 'src-a' });
  assert.equal(asked.length, 0);
  assert.deepEqual(r.mcpServers, []);
});

test('the settings preview never carries an MCP server\'s env or arguments', async () => {
  withMcp({ servers: [stdio('one', { args: ['--token', 'abc'] })], accepts: ['mcp-server'] });
  const p = await resourceSources.preview({ backendId: 'tgt', sourceId: 'src-a', projectPath: null, options: {} });
  assert.deepEqual(p.mcpServers, [{ name: 'one', scope: 'global', origin: 'user', path: '<home>/src-a.json', command: 'node' }]);
  const text = JSON.stringify(p);
  assert.ok(!text.includes('secret') && !text.includes('abc'), text);
});

test('Pi takes a source\'s MCP servers only while "MCP servers from the source" is on; only Claude answers them', () => {
  for (const id of ['pi', 'pi-native']) {
    const b = backends.get(id);
    const off = b.declinesSharedResource({ kind: 'mcp-server', scope: 'global', options: {} });
    assert.equal(off.reason, 'target-declined', id);
    assert.match(off.note, /MCP servers/, id);
    assert.equal(b.declinesSharedResource({ kind: 'mcp-server', scope: 'global', options: { mcpServers: true } }), null, id);
    assert.ok(b.configFields.some((f) => f.id === 'mcpServers' && f.default === false && f.appliedBy === 'buildSessionResources'), id);
  }
  assert.equal(typeof backends.get('claude').listSharedMcpServers, 'function');
  for (const id of ['codex', 'agy', 'hermes']) assert.equal(backends.get(id).listSharedMcpServers, undefined, id);
});
