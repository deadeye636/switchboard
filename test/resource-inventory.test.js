'use strict';
// #823 T1 — the neutral inventory of agents, commands and rules (spec 44).
//
// Two halves. The real descriptors over fixture homes (`SWITCHBOARD_STORE_*`) pin what each of the five CLIs
// reports for each view, including the CLIs that decline. Stub descriptors pin the core's own rules: a
// plugin's file is not deletable, a driver folds into its owner CLI, one file named twice is one row.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-resinv-'));
const STORE = {};
for (const id of ['claude', 'codex', 'hermes', 'pi', 'agy']) {
  STORE[id] = path.join(root, id, 'store');
  fs.mkdirSync(STORE[id], { recursive: true });
  process.env['SWITCHBOARD_STORE_' + id.toUpperCase()] = STORE[id];
}
const project = path.join(root, 'project');
fs.mkdirSync(project, { recursive: true });

const backends = require('../src/backends');
const inventory = require('../src/app/resource-inventory');

test.after(() => { fs.rmSync(root, { recursive: true, force: true }); });

function write(file, body = 'x\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

const noLog = { debug() {}, warn() {}, error() {}, info() {} };
const byName = (rows, name) => rows.find(r => r.name === name);
const declined = (answer) => answer.declines.map(d => d.cli.key).sort();

// Homes, as each descriptor resolves them from its store override.
const claudeHome = path.dirname(STORE.claude);
const codexHome = path.dirname(STORE.codex);
const hermesHome = STORE.hermes;
const piAgentDir = require('../src/backends/pi/trust').agentDir();

write(path.join(claudeHome, 'agents', 'reviewer.md'));
write(path.join(claudeHome, 'commands', 'ship.md'));
write(path.join(claudeHome, 'hooks', 'pre.sh'));
write(path.join(project, '.claude', 'commands', 'local.md'));
write(path.join(codexHome, 'rules', 'style.md'));
write(path.join(project, '.codex', 'rules', 'house.md'));
write(path.join(hermesHome, 'skill-bundles', 'bundle.yaml'));
write(path.join(hermesHome, 'hooks', 'notify.sh'));
write(path.join(piAgentDir, 'prompts', 'plan.md'));

function real() {
  inventory.init({ backends, log: noLog });
}

test('an unknown view is refused, a known one answers ok', () => {
  real();
  assert.equal(inventory.getResourceInventory({ view: 'skills' }).ok, false);
  assert.equal(inventory.getResourceInventory({ view: '' }).ok, false);
  assert.equal(inventory.getResourceInventory({ view: 'agents' }).ok, true);
});

test('agents: Claude lists its agent file, every other CLI declines (or has nothing to say)', () => {
  real();
  const a = inventory.getResourceInventory({ view: 'agents' });
  assert.deepEqual(a.rows.map(r => [r.name, r.kind, r.scope, r.cli.key]), [['reviewer', 'agent', 'global', 'claude']]);
  assert.equal(a.rows[0].editable, true);
  assert.equal(a.rows[0].deletable, true);
  assert.equal(a.rows[0].creatable, true);
  assert.deepEqual(declined(a), ['agy', 'codex', 'hermes', 'pi']);
  assert.match(a.declines[0].sentence, /keeps no agents here/);
});

test('commands: Claude, Hermes bundles and Pi prompt templates; project scope adds the project file', () => {
  real();
  const global = inventory.getResourceInventory({ view: 'commands' });
  assert.deepEqual(global.rows.map(r => [r.name, r.kind, r.cli.key]).sort(),
    [['bundle', 'skill-bundle', 'hermes'], ['plan', 'prompt-template', 'pi'], ['ship', 'command', 'claude']]);
  assert.equal(byName(global.rows, 'ship').creatable, true, 'Claude scaffolds a command');
  assert.equal(byName(global.rows, 'plan').creatable, true, 'Pi scaffolds a prompt template');
  assert.equal(byName(global.rows, 'bundle').creatable, false, 'a bundle has no scaffold');
  assert.equal(byName(global.rows, 'bundle').deletable, false, 'a bundle has no lifecycle here');
  assert.deepEqual(declined(global), ['agy', 'codex']);

  const withProject = inventory.getResourceInventory({ view: 'commands', projectPath: project });
  const local = byName(withProject.rows, 'local');
  assert.ok(local, 'the project command is listed');
  assert.equal(local.scope, 'project');
  assert.equal(byName(withProject.rows, 'ship').scope, 'global');
});

test('rules: Codex rules in both scopes, hooks read-only and never deleted, Claude/Pi/agy have nothing else', () => {
  real();
  const answer = inventory.getResourceInventory({ view: 'rules', projectPath: project });
  const style = byName(answer.rows, 'style');
  const house = byName(answer.rows, 'house');
  assert.equal(style.scope, 'global');
  assert.equal(house.scope, 'project');
  assert.equal(style.deletable, true);
  const hooks = answer.rows.filter(r => r.kind === 'hook');
  assert.deepEqual(hooks.map(h => h.cli.key).sort(), ['claude', 'hermes']);
  for (const h of hooks) {
    assert.equal(h.editable, false, 'a hook is a script: not editable');
    assert.equal(h.deletable, false, 'and never deleted');
  }
  assert.deepEqual(declined(answer), ['agy', 'pi']);
});

test('a global request lists no project file', () => {
  real();
  const rows = inventory.getResourceInventory({ view: 'rules' }).rows;
  assert.equal(byName(rows, 'house'), undefined);
  assert.ok(byName(rows, 'style'));
});

test('no row carries a backend id or a path', () => {
  real();
  for (const view of Object.keys(inventory.RESOURCE_VIEWS)) {
    const answer = inventory.getResourceInventory({ view, projectPath: project });
    for (const r of answer.rows) {
      assert.deepEqual(Object.keys(r).sort(), [
        'cli', 'clis', 'creatable', 'deletable', 'editable', 'ext', 'fromPlugin', 'id', 'kind', 'name', 'originLabel', 'scope', 'sourceLabel',
      ]);
      assert.match(r.id, /^[0-9a-f]{16}$/);
      assert.equal(JSON.stringify(r).includes(root.replace(/\\/g, '\\\\')), false, 'no fixture path inside the row');
    }
  }
});

// --- the core's own rules, over stubs ---------------------------------------------------------------

function stubDescriptor({ id, label, dir, kind = 'command', fromPlugin = false, editable = true, scaffold = false, source = 'cmds' }) {
  return {
    id, label,
    listResources: () => ({ ok: true, resources: [{ kind, scope: 'global', name: kind + 's', path: dir, source, fromPlugin }] }),
    expandResource: ({ path: d }) => ({
      ok: true,
      entries: fs.readdirSync(d).map(n => ({ kind, name: n.replace(/\.md$/, ''), path: path.join(d, n), source })),
    }),
    ...(editable ? { resourceEditing: { extensions: ['.md'] } } : {}),
    ...(scaffold ? { resourceScaffolds: [{ kind, layout: 'file', ext: '.md', sources: [source], template: () => '' }] } : {}),
  };
}

function stubRegistry(list, { cliOwnerOf = null, oneAskerPerCli = null } = {}) {
  inventory.init({
    backends: {
      list: () => list.map(b => ({ id: b.id, isProfile: false, status: 'ready' })),
      get: (id) => list.find(b => b.id === id) || null,
      ...(cliOwnerOf ? { cliOwnerOf } : {}),
      ...(oneAskerPerCli ? { oneAskerPerCli } : {}),
    },
    log: noLog,
  });
}

test('a file a plugin installed is editable but not deletable', () => {
  const dir = path.join(root, 'plugin-cmds');
  write(path.join(dir, 'from-plugin.md'));
  stubRegistry([stubDescriptor({ id: 'plug', label: 'Plug', dir, fromPlugin: true })]);
  const [row] = inventory.getResourceInventory({ view: 'commands' }).rows;
  assert.equal(row.fromPlugin, true);
  assert.equal(row.editable, true);
  assert.equal(row.deletable, false);
});

test('one file listed by a second CLI unmarked still counts as a plugin file', () => {
  const dir = path.join(root, 'shared-cmds');
  write(path.join(dir, 'shared.md'));
  stubRegistry([
    stubDescriptor({ id: 'one', label: 'One', dir, fromPlugin: true }),
    stubDescriptor({ id: 'two', label: 'Two', dir }),
  ]);
  const { rows } = inventory.getResourceInventory({ view: 'commands' });
  assert.equal(rows.length, 1, 'one file is one row');
  assert.deepEqual(rows[0].clis.map(c => c.key), ['one', 'two']);
  assert.equal(rows[0].deletable, false);
});

test('a driver folds into its owner CLI', () => {
  const dir = path.join(root, 'driver-cmds');
  write(path.join(dir, 'x.md'));
  const base = stubDescriptor({ id: 'base', label: 'Base', dir });
  const driver = stubDescriptor({ id: 'driver', label: 'Driver', dir });
  stubRegistry([base, driver], {
    cliOwnerOf: (d) => (d.id === 'driver' ? base : d),
    oneAskerPerCli: (list) => list.filter(b => b.id !== 'driver'),
  });
  const { rows } = inventory.getResourceInventory({ view: 'commands' });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].clis, [{ key: 'base', label: 'Base' }]);
  assert.deepEqual(rows[0].cli, { key: 'base', label: 'Base' });
});

test('a CLI that lists the kind but holds no file does not decline; one with a scaffold does not either', () => {
  const empty = path.join(root, 'empty-cmds');
  fs.mkdirSync(empty, { recursive: true });
  const bare = { id: 'bare', label: 'Bare', listResources: () => ({ ok: true, resources: [] }) };
  stubRegistry([
    stubDescriptor({ id: 'listed', label: 'Listed', dir: empty }),
    stubDescriptor({ id: 'scaffolded', label: 'Scaffolded', dir: empty, source: 'other', scaffold: true }),
    bare,
  ]);
  const answer = inventory.getResourceInventory({ view: 'commands' });
  assert.deepEqual(answer.rows, []);
  assert.deepEqual(answer.declines.map(d => d.cli.key), ['bare']);
  assert.equal(answer.declines[0].sentence, 'Bare keeps no commands here.');
});

test('a backend that throws is skipped and the others still answer', () => {
  const dir = path.join(root, 'throw-cmds');
  write(path.join(dir, 'ok.md'));
  const throwing = { id: 'throws', label: 'Throws', listResources: () => { throw new Error('boom'); } };
  stubRegistry([throwing, stubDescriptor({ id: 'fine', label: 'Fine', dir })]);
  const answer = inventory.getResourceInventory({ view: 'commands' });
  assert.deepEqual(answer.rows.map(r => r.name), ['ok']);
  assert.deepEqual(answer.declines.map(d => d.cli.key), ['throws']);
});

// --- gaps found by the verifier -----------------------------------------------------------------------

test('a hook is read-only whatever its extension, even where the descriptor would let a .md be edited', () => {
  const dir = path.join(root, 'md-hooks');
  write(path.join(dir, 'notes.md'));
  stubRegistry([stubDescriptor({ id: 'hooky', label: 'Hooky', dir, kind: 'hook', source: 'hooks' })]);
  const [row] = inventory.getResourceInventory({ view: 'rules' }).rows;
  assert.equal(row.kind, 'hook');
  assert.equal(row.editable, false);
  assert.equal(row.deletable, false);
});

test('an expander that answers a promise is a failure and does not stop the CLI from declining', () => {
  const dir = path.join(root, 'async-cmds');
  write(path.join(dir, 'a.md'));
  const asyncOne = stubDescriptor({ id: 'later', label: 'Later', dir });
  asyncOne.expandResource = async () => ({ ok: true, entries: [] });
  stubRegistry([asyncOne]);
  const answer = inventory.getResourceInventory({ view: 'commands' });
  assert.deepEqual(answer.rows, []);
  assert.deepEqual(answer.declines.map(d => d.cli.key), ['later']);
});

test('real descriptors: Claude project agents and a workflow file, and the Hermes bundle is editable', () => {
  real();
  write(path.join(project, '.claude', 'agents', 'local-agent.md'));
  write(path.join(claudeHome, 'workflows', 'flow.md'));
  const agents = inventory.getResourceInventory({ view: 'agents', projectPath: project }).rows;
  const local = byName(agents, 'local-agent');
  assert.equal(local.scope, 'project');
  assert.equal(local.cli.key, 'claude');
  assert.equal(byName(agents, 'reviewer').scope, 'global');
  const commands = inventory.getResourceInventory({ view: 'commands' }).rows;
  const flow = byName(commands, 'flow');
  assert.equal(flow.kind, 'workflow');
  assert.equal(flow.deletable, false, 'a workflow has no lifecycle here');
  const bundle = byName(commands, 'bundle');
  assert.equal(bundle.editable, true, 'Hermes takes .yaml');
});
