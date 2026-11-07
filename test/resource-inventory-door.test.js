'use strict';
// #823 T2 — the doors of the agents/commands/rules rows: read, save, create, delete by inventory id (spec 44).
//
// Stub descriptors over temp folders pin the core's rules: an id that is not in the current listing is refused,
// a hook can be read but never saved or deleted, a plugin's file is not deleted, a stale baseline answers the
// conflict and writes nothing, the file's line endings and BOM survive, a project off the register is refused,
// and no refusal carries a path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const inventory = require('../src/app/resource-inventory');
const backendResources = require('../src/app/backend-resources');
const skills = require('../src/app/skills');

const made = [];
function tmpdir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-resdoor-' + name + '-'));
  made.push(dir);
  return dir;
}
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

const log = { warn() {}, error() {}, info() {}, debug() {} };

/** One CLI with a `commands` directory (global or per project), an optional hooks directory and a scaffold. */
function cliStub({ id = 'cli', label = 'Cli', globalDir, projectDir = null, hooksDir = null, fromPlugin = false, scaffold = true }) {
  const dirs = (projectPath) => {
    const out = [{ kind: 'command', scope: 'global', name: 'commands', path: globalDir, source: 'cmds', ...(fromPlugin ? { fromPlugin: true } : {}) }];
    if (projectPath && projectDir) out.push({ kind: 'command', scope: 'project', name: 'commands', path: projectDir, source: 'pcmds' });
    if (hooksDir) out.push({ kind: 'hook', scope: 'global', name: 'hooks', path: hooksDir, source: 'hooks' });
    return out;
  };
  return {
    id, label,
    resourceEditing: { extensions: ['.md', '.sh'] },     // .sh on purpose: a hook must still be read-only
    ...(scaffold ? { resourceScaffolds: [{ kind: 'command', layout: 'file', ext: '.md', sources: ['cmds', 'pcmds'], template: (n) => `# ${n}\n` }] } : {}),
    listResources: ({ projectPath }) => ({ ok: true, resources: dirs(projectPath) }),
    expandResource: ({ path: d, source }) => ({
      ok: true,
      entries: fs.readdirSync(d).map(n => ({ kind: source === 'hooks' ? 'hook' : 'command', name: n.replace(/\.\w+$/, ''), path: path.join(d, n), source })),
    }),
  };
}

function setup(list, projects = []) {
  const registry = {
    list: () => list.map(b => ({ id: b.id, isProfile: false, status: 'ready' })),
    get: (id) => list.find(b => b.id === id) || null,
  };
  const states = () => new Map(projects.map(p => [p, { registered: true }]));
  inventory.init({ backends: registry, log });
  backendResources.init({ backends: registry, log });
  skills.init({ backends: registry, log, dataDir: tmpdir('data'), effectiveSettings: () => ({}), projectStates: states });
}

const idOf = (view, name, projectPath = null) => inventory.getResourceInventory({ view, projectPath }).rows.find(r => r.name === name).id;

function fixture(extra = {}) {
  const globalDir = tmpdir('global');
  fs.writeFileSync(path.join(globalDir, 'ship.md'), 'one\r\ntwo\r\n');
  fs.writeFileSync(path.join(globalDir, 'crlf-bom.md'), '﻿a\r\nb\r\n');
  const hooksDir = tmpdir('hooks');
  fs.writeFileSync(path.join(hooksDir, 'pre.sh'), 'echo hi\n');
  setup([cliStub({ globalDir, hooksDir, ...extra })]);
  return { globalDir, hooksDir };
}

test('read: an id from the current listing is read, an unknown id and a non-string are refused', async () => {
  fixture();
  const out = await inventory.readResourceItem({ id: idOf('commands', 'ship') });
  assert.equal(out.ok, true);
  assert.equal(out.content, 'one\r\ntwo\r\n');
  assert.equal((await inventory.readResourceItem({ id: 'deadbeefdeadbeef' })).ok, false);
  assert.equal((await inventory.readResourceItem({ id: null })).ok, false);
  assert.equal((await inventory.readResourceItem({})).ok, false);
});

test('an id outside the listing is refused even when the file exists: the id is not a path', async () => {
  const { globalDir } = fixture();
  const stray = path.join(globalDir, '..', 'stray.md');
  fs.writeFileSync(stray, 'x');
  for (const id of [stray, path.join(globalDir, 'ship.md'), '../stray.md']) {
    const out = await inventory.readResourceItem({ id });
    assert.equal(out.ok, false);
    assert.equal(JSON.stringify(out).includes(globalDir), false, 'the refusal names no path');
  }
});

test('a file that left the listing since the page was drawn is refused', async () => {
  const { globalDir } = fixture();
  const id = idOf('commands', 'ship');
  fs.unlinkSync(path.join(globalDir, 'ship.md'));
  const out = await inventory.saveResourceItem({ id, content: 'x', baseline: 'one\r\ntwo\r\n' });
  assert.equal(out.ok, false);
  assert.equal(fs.existsSync(path.join(globalDir, 'ship.md')), false, 'nothing was written back');
});

test('a hook can be read, but never saved or deleted', async () => {
  const { hooksDir } = fixture();
  const row = inventory.getResourceInventory({ view: 'rules' }).rows.find(r => r.kind === 'hook');
  assert.equal(row.editable, false);
  assert.equal(row.deletable, false);
  const read = await inventory.readResourceItem({ id: row.id });
  assert.equal(read.ok, true);
  assert.equal(read.content, 'echo hi\n');
  assert.equal((await inventory.saveResourceItem({ id: row.id, content: 'rm -rf x\n', baseline: 'echo hi\n' })).ok, false);
  assert.equal((await inventory.deleteResourceItem({ id: row.id })).ok, false);
  assert.equal(fs.readFileSync(path.join(hooksDir, 'pre.sh'), 'utf8'), 'echo hi\n');
});

test('save: a baseline is required, the write keeps CRLF and the BOM', async () => {
  const { globalDir } = fixture();
  const id = idOf('commands', 'crlf-bom');
  assert.equal((await inventory.saveResourceItem({ id, content: 'x' })).ok, false, 'no baseline, no write');
  assert.equal((await inventory.saveResourceItem({ id, baseline: 'a\nb\n' })).ok, false, 'no content, no write');
  const read = await inventory.readResourceItem({ id });
  const out = await inventory.saveResourceItem({ id, content: 'a\nb\nc\n', baseline: read.content });
  assert.equal(out.ok, true);
  assert.equal(fs.readFileSync(path.join(globalDir, 'crlf-bom.md'), 'utf8'), '﻿a\r\nb\r\nc\r\n');
});

test('save: a stale baseline answers the conflict with the disk text and writes nothing', async () => {
  const { globalDir } = fixture();
  const id = idOf('commands', 'ship');
  const read = await inventory.readResourceItem({ id });
  fs.writeFileSync(path.join(globalDir, 'ship.md'), 'an agent wrote this\r\n');
  const out = await inventory.saveResourceItem({ id, content: 'mine', baseline: read.content });
  assert.equal(out.ok, false);
  assert.equal(out.conflict, true);
  assert.equal(out.diskContent, 'an agent wrote this\r\n');
  assert.equal(fs.readFileSync(path.join(globalDir, 'ship.md'), 'utf8'), 'an agent wrote this\r\n');
});

test('delete: a CLI\'s own file goes, a plugin\'s does not', async () => {
  const own = fixture();
  const id = idOf('commands', 'ship');
  assert.equal((await inventory.deleteResourceItem({ id })).ok, true);
  assert.equal(fs.existsSync(path.join(own.globalDir, 'ship.md')), false);
  assert.equal(inventory.getResourceInventory({ view: 'commands' }).rows.some(r => r.name === 'ship'), false);

  const plugin = fixture({ fromPlugin: true });
  const row = inventory.getResourceInventory({ view: 'commands' }).rows.find(r => r.name === 'ship');
  assert.equal(row.fromPlugin, true);
  assert.equal(row.deletable, false);
  const refused = await inventory.deleteResourceItem({ id: row.id });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /plugin/);
  assert.equal(fs.existsSync(path.join(plugin.globalDir, 'ship.md')), true);
});

test('delete: a kind without a lifecycle is refused', async () => {
  const dir = tmpdir('bundles');
  fs.writeFileSync(path.join(dir, 'b.md'), 'x');
  const d = cliStub({ globalDir: dir });
  d.listResources = () => ({ ok: true, resources: [{ kind: 'skill-bundle', scope: 'global', name: 'bundles', path: dir, source: 'cmds' }] });
  d.expandResource = ({ path: p }) => ({ ok: true, entries: fs.readdirSync(p).map(n => ({ kind: 'skill-bundle', name: 'b', path: path.join(p, n), source: 'cmds' })) });
  setup([d]);
  const row = inventory.getResourceInventory({ view: 'commands' }).rows[0];
  assert.equal(row.deletable, false);
  assert.equal((await inventory.deleteResourceItem({ id: row.id })).ok, false);
  assert.equal(fs.existsSync(path.join(dir, 'b.md')), true);
});

test('create: places are opaque, the new file is made from the scaffold and its id comes back', async () => {
  const { globalDir } = fixture();
  const places = inventory.getResourcePlaces({ view: 'commands' });
  assert.equal(places.ok, true);
  assert.deepEqual(places.places.map(p => [p.scope, p.kind]), [['global', 'command']]);
  assert.deepEqual(Object.keys(places.places[0]).sort(), ['id', 'kind', 'label', 'scope']);
  const out = await inventory.createResourceItem({ view: 'commands', placeId: places.places[0].id, name: 'fresh' });
  assert.equal(out.ok, true);
  assert.equal(fs.readFileSync(path.join(globalDir, 'fresh.md'), 'utf8'), '# fresh\n');
  assert.equal(out.id, idOf('commands', 'fresh'));
  const again = await inventory.createResourceItem({ view: 'commands', placeId: places.places[0].id, name: 'fresh' });
  assert.equal(again.ok, false, 'an existing file is not overwritten');
});

test('create: an unknown place, a bad name, an unknown view and a hook view with no scaffold are refused', async () => {
  const { globalDir } = fixture();
  const [place] = inventory.getResourcePlaces({ view: 'commands' }).places;
  assert.equal((await inventory.createResourceItem({ view: 'commands', placeId: 'nope', name: 'a' })).ok, false);
  assert.equal((await inventory.createResourceItem({ view: 'commands', placeId: place.id, name: '../escape' })).ok, false);
  assert.equal((await inventory.createResourceItem({ view: 'skills', placeId: place.id, name: 'a' })).ok, false);
  assert.equal(inventory.getResourcePlaces({ view: 'skills' }).ok, false);
  // The commands place is not a place of the rules view.
  assert.deepEqual(inventory.getResourcePlaces({ view: 'rules' }).places, []);
  assert.equal((await inventory.createResourceItem({ view: 'rules', placeId: place.id, name: 'a' })).ok, false);
  assert.deepEqual(fs.readdirSync(globalDir).sort(), ['crlf-bom.md', 'ship.md']);
});

test('a CLI without a scaffold has no place', () => {
  const globalDir = tmpdir('noscaf');
  setup([cliStub({ globalDir, scaffold: false })]);
  assert.deepEqual(inventory.getResourcePlaces({ view: 'commands' }).places, []);
});

test('a project off the register is refused by every door; a registered one reaches its project file', async () => {
  const globalDir = tmpdir('g');
  const project = tmpdir('project');
  const projectDir = path.join(project, '.cli', 'commands');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'local.md'), 'proj\n');
  const registered = tmpdir('registered-elsewhere');
  setup([cliStub({ globalDir, projectDir })], [project]);

  const id = idOf('commands', 'local', project);
  assert.equal((await inventory.readResourceItem({ id, projectPath: project })).content, 'proj\n');
  const ok = await inventory.saveResourceItem({ id, projectPath: project, content: 'proj2\n', baseline: 'proj\n' });
  assert.equal(ok.ok, true);
  assert.equal(fs.readFileSync(path.join(projectDir, 'local.md'), 'utf8'), 'proj2\n');

  const stranger = tmpdir('stranger');
  for (const projectPath of [stranger, registered]) {
    assert.equal((await inventory.readResourceItem({ id, projectPath })).ok, false);
    assert.equal((await inventory.saveResourceItem({ id, projectPath, content: 'x', baseline: 'proj2\n' })).ok, false);
    assert.equal((await inventory.deleteResourceItem({ id, projectPath })).ok, false);
    assert.equal(inventory.getResourcePlaces({ view: 'commands', projectPath }).ok, false);
    assert.equal((await inventory.createResourceItem({ view: 'commands', placeId: 'x', name: 'a', projectPath })).ok, false);
  }
  // Without the project the project file is not listed, so its id is unknown.
  assert.equal((await inventory.readResourceItem({ id })).ok, false);
  assert.equal(fs.readFileSync(path.join(projectDir, 'local.md'), 'utf8'), 'proj2\n');

  const places = inventory.getResourcePlaces({ view: 'commands', projectPath: project }).places;
  assert.deepEqual(places.map(p => p.scope), ['project', 'global']);
  const made = await inventory.createResourceItem({ view: 'commands', placeId: places[0].id, name: 'newlocal', projectPath: project });
  assert.equal(made.ok, true);
  assert.equal(fs.existsSync(path.join(projectDir, 'newlocal.md')), true);
  assert.equal((await inventory.deleteResourceItem({ id: made.id, projectPath: project })).ok, true);
  assert.equal(fs.existsSync(path.join(projectDir, 'newlocal.md')), false);
});

test('a thrown error never carries its own text across the door', async () => {
  const globalDir = tmpdir('throws');
  fs.writeFileSync(path.join(globalDir, 'a.md'), 'x');
  const d = cliStub({ globalDir });
  setup([d]);
  const id = idOf('commands', 'a');
  // The file turns into a directory: the read fails on the real filesystem, and the sentence is ours.
  fs.rmSync(path.join(globalDir, 'a.md'));
  fs.mkdirSync(path.join(globalDir, 'a.md'));
  const out = await inventory.readResourceItem({ id });
  assert.equal(out.ok, false);
  assert.equal(JSON.stringify(out).includes(globalDir), false);
});

test('a command file named SKILL.md is deleted alone; a skill\'s folder still goes with its SKILL.md', async () => {
  const dir = tmpdir('skillmd');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'cmd');
  fs.writeFileSync(path.join(dir, 'keep.md'), 'keep');
  setup([cliStub({ globalDir: dir })]);
  const row = inventory.getResourceInventory({ view: 'commands' }).rows.find(r => r.name === 'SKILL');
  assert.equal((await inventory.deleteResourceItem({ id: row.id })).ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'SKILL.md')), false);
  assert.equal(fs.existsSync(dir), true, 'the folder stays');
  assert.equal(fs.readFileSync(path.join(dir, 'keep.md'), 'utf8'), 'keep');

  const skillsRoot = tmpdir('skillroot');
  fs.mkdirSync(path.join(skillsRoot, 'one'));
  fs.writeFileSync(path.join(skillsRoot, 'one', 'SKILL.md'), 's');
  const registry = { get: () => ({
    listResources: () => ({ ok: true, resources: [{ kind: 'skill', scope: 'global', name: 'skills', path: skillsRoot, source: 's' }] }),
    expandResource: () => ({ ok: true, entries: [{ kind: 'skill', name: 'one', path: path.join(skillsRoot, 'one', 'SKILL.md'), source: 's' }] }),
  }) };
  backendResources.init({ backends: registry, log });
  const out = await backendResources.deleteResource('x', path.join(skillsRoot, 'one', 'SKILL.md'));
  assert.equal(out.ok, true);
  assert.equal(fs.existsSync(path.join(skillsRoot, 'one')), false, 'the skill folder went');
});

test('a file listed as a rule by one CLI and a hook by another is read-only for both', async () => {
  const dir = tmpdir('twokinds');
  fs.writeFileSync(path.join(dir, 'x.md'), 'x');
  const mk = (id, kind) => {
    const d = cliStub({ id, label: id, globalDir: dir });
    d.listResources = () => ({ ok: true, resources: [{ kind, scope: 'global', name: 'dir', path: dir, source: 'cmds' }] });
    d.expandResource = ({ path: p }) => ({ ok: true, entries: fs.readdirSync(p).map(n => ({ kind, name: 'x', path: path.join(p, n), source: 'cmds' })) });
    return d;
  };
  setup([mk('a', 'rule'), mk('b', 'hook')]);
  const rows = inventory.getResourceInventory({ view: 'rules' }).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].editable, false);
  assert.equal(rows[0].deletable, false);
  assert.equal((await inventory.saveResourceItem({ id: rows[0].id, content: 'y', baseline: 'x' })).ok, false);
  assert.equal((await inventory.deleteResourceItem({ id: rows[0].id })).ok, false);
  assert.equal(fs.readFileSync(path.join(dir, 'x.md'), 'utf8'), 'x');
});

test('with a view the door lists only that view; an unknown view is refused', async () => {
  fixture();
  const id = idOf('commands', 'ship');
  assert.equal((await inventory.readResourceItem({ id, view: 'commands' })).ok, true);
  assert.equal((await inventory.readResourceItem({ id, view: 'agents' })).ok, false, 'not an agent');
  assert.equal((await inventory.readResourceItem({ id, view: 'skills' })).ok, false);
  assert.equal((await inventory.saveResourceItem({ id, view: 'rules', content: 'x', baseline: 'one\r\ntwo\r\n' })).ok, false);
  assert.equal((await inventory.deleteResourceItem({ id, view: 'rules' })).ok, false);
});
