'use strict';
// #803 T12a (owner decision E15) — "New skill" on the Skills page of Settings → Plugins.
//
// Where a new skill may go is the backends' answer: a skills directory the listing names, under a source the
// backend's own `skill` scaffold claims, that exists. The window gets an opaque place id and a label, never a
// backend id or a path to send back; the file is written by `backend-resources.createResource`, which keeps its
// own checks (the name rule, no overwrite). The answer carries the new row's inventory id so its page opens.
// Delete (E16) is offered where Edit is, for a CLI's skill only, and done by `deleteResource`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const skills = require('../src/app/skills');
const backendResources = require('../src/app/backend-resources');

const made = [];
function tmpdir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sk-create-' + name + '-'));
  made.push(dir);
  return dir;
}
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

const SCAFFOLD = { kind: 'skill', layout: 'dir', entryFile: 'SKILL.md', sources: ['skills-directory'], template: (n) => `---\nname: ${n}\n---\n` };

function skillsBackend({ id = 'cli', label = 'Cli', dirs, scaffolds = [SCAFFOLD], resourceEditing = null }) {
  return {
    id,
    label,
    resourceScaffolds: scaffolds,
    ...(resourceEditing ? { resourceEditing } : {}),
    listResources: ({ projectPath }) => ({
      ok: true,
      resources: dirs.filter(d => (d.scope === 'project') === !!projectPath)
        .map(d => ({ kind: d.kind || 'skill', scope: d.scope, name: 'skills', path: d.path, source: d.source || 'skills-directory' })),
    }),
    expandResource: ({ path: d, scope }) => ({
      ok: true,
      entries: fs.readdirSync(d).filter(n => fs.statSync(path.join(d, n)).isDirectory())
        .map(n => ({ kind: 'skill', scope, name: n, path: path.join(d, n, 'SKILL.md'), source: 'skills-directory' })),
    }),
  };
}

function setup({ backends = [], projects = [] }) {
  const registry = {
    list: () => backends.map(b => ({ id: b.id, isProfile: false, status: 'ready' })),
    get: (id) => backends.find(b => b.id === id) || null,
  };
  const log = { warn() {}, error() {}, info() {}, debug() {} };
  skills.init({
    backends: registry, log, dataDir: tmpdir('data'),
    effectiveSettings: () => ({}),
    projectStates: () => new Map(projects.map(p => [p, { registered: true }])),
  });
  backendResources.init({ backends: registry, log });
}

test('places are the scaffold-claimed skills directories that exist, per scope, with no backend id or path to send back', () => {
  const global = tmpdir('global');
  const project = tmpdir('project');
  const projectSkills = path.join(project, '.cli', 'skills');
  fs.mkdirSync(projectSkills, { recursive: true });
  setup({
    projects: [project],
    backends: [
      skillsBackend({ dirs: [
        { scope: 'global', path: global },
        { scope: 'project', path: projectSkills },
        { scope: 'global', path: path.join(global, 'missing') },                     // not on disk
        { scope: 'global', path: tmpdir('plugin'), source: 'plugin-skills' },         // not a scaffold source
        { scope: 'global', path: tmpdir('rules'), kind: 'rule' },                     // not a skill directory
      ] }),
      skillsBackend({ id: 'other', label: 'Other', dirs: [{ scope: 'global', path: tmpdir('other') }], scaffolds: [] }),
    ],
  });
  const atGlobal = skills.getSkillPlaces({});
  assert.equal(atGlobal.ok, true);
  assert.deepEqual(atGlobal.places.map(p => p.scope), ['global']);
  assert.match(atGlobal.places[0].label, /^Cli · global — /);
  assert.deepEqual(Object.keys(atGlobal.places[0]).sort(), ['id', 'label', 'scope']);

  const inProject = skills.getSkillPlaces({ projectPath: project });
  assert.deepEqual(inProject.places.map(p => p.scope), ['project', 'global']);
});

test('createSkill writes the scaffold into the chosen place and answers the new row\'s inventory id', async () => {
  const global = tmpdir('global');
  setup({ backends: [skillsBackend({ dirs: [{ scope: 'global', path: global }] })] });
  const [place] = skills.getSkillPlaces({}).places;
  const out = await skills.createSkill({ placeId: place.id, name: 'house-style' });
  assert.equal(out.ok, true);
  const file = path.join(global, 'house-style', 'SKILL.md');
  assert.equal(fs.readFileSync(file, 'utf8'), '---\nname: house-style\n---\n');
  const row = skills.getSkillInventory({}).skills.find(s => s.name === 'house-style');
  assert.equal(out.id, row.id);
});

test('createSkill refuses an unknown place, a bad name, an existing skill and a project not on the list', async () => {
  const global = tmpdir('global');
  setup({ backends: [skillsBackend({ dirs: [{ scope: 'global', path: global }] })] });
  const [place] = skills.getSkillPlaces({}).places;
  assert.equal((await skills.createSkill({ placeId: 'nope', name: 'a' })).ok, false);
  assert.equal((await skills.createSkill({ placeId: place.id, name: '../escape' })).ok, false);
  assert.equal(fs.existsSync(path.join(path.dirname(global), 'escape')), false);
  assert.equal((await skills.createSkill({ placeId: place.id, name: 'twice' })).ok, true);
  const again = await skills.createSkill({ placeId: place.id, name: 'twice' });
  assert.equal(again.ok, false);
  assert.match(again.reason, /already/);
  assert.equal(skills.getSkillPlaces({ projectPath: tmpdir('unlisted') }).ok, false);
  assert.equal((await skills.createSkill({ placeId: place.id, name: 'x', projectPath: tmpdir('unlisted') })).ok, false);
});

test('a project-scope place creates in the project\'s folder; one folder listed in both scopes is offered once', async () => {
  const project = tmpdir('project');
  const shared = path.join(project, '.cli', 'skills');
  fs.mkdirSync(shared, { recursive: true });
  setup({
    projects: [project],
    backends: [skillsBackend({ dirs: [{ scope: 'project', path: shared }, { scope: 'global', path: shared }] })],
  });
  const { places } = skills.getSkillPlaces({ projectPath: project });
  assert.deepEqual(places.map(p => p.scope), ['project'], 'the same folder is not offered twice');
  const out = await skills.createSkill({ placeId: places[0].id, name: 'local-one', projectPath: project });
  assert.equal(out.ok, true);
  assert.ok(fs.existsSync(path.join(shared, 'local-one', 'SKILL.md')));
  assert.ok(out.id, 'the new row is found in the project\'s inventory');
});

test('a backend that cannot read its skills folder offers no place (the new skill could never be opened)', () => {
  const global = tmpdir('global');
  const b = skillsBackend({ dirs: [{ scope: 'global', path: global }] });
  delete b.expandResource;
  setup({ backends: [b] });
  assert.deepEqual(skills.getSkillPlaces({}).places, []);
});

test('deleteSkill removes a CLI\'s skill folder by id; a row Edit is not offered for is neither deletable nor deleted', async () => {
  const global = tmpdir('global');
  const folder = path.join(global, 'gone-soon');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'SKILL.md'), '# x\n');
  fs.writeFileSync(path.join(folder, 'notes.md'), 'helper\n');

  setup({ backends: [skillsBackend({ dirs: [{ scope: 'global', path: global }] })] });   // no resourceEditing
  let row = skills.getSkillInventory({}).skills.find(s => s.name === 'gone-soon');
  assert.equal(row.deletable, false);
  assert.equal((await skills.deleteSkill({ id: row.id })).ok, false);
  assert.ok(fs.existsSync(folder));

  setup({ backends: [skillsBackend({ dirs: [{ scope: 'global', path: global }], resourceEditing: { extensions: ['.md'] } })] });
  row = skills.getSkillInventory({}).skills.find(s => s.name === 'gone-soon');
  assert.equal(row.deletable, true);
  assert.equal((await skills.deleteSkill({ id: 'nope' })).ok, false);
  assert.equal((await skills.deleteSkill({ id: row.id })).ok, true);
  assert.equal(fs.existsSync(folder), false, 'the folder goes with its helper files');
  assert.ok(fs.existsSync(global), 'never the listed directory itself');
});

test('deleteSkill removes a project-scope skill through the project\'s own listing', async () => {
  const project = tmpdir('project');
  const dir = path.join(project, '.cli', 'skills');
  const folder = path.join(dir, 'local-gone');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'SKILL.md'), '# x\n');
  setup({
    projects: [project],
    backends: [skillsBackend({ dirs: [{ scope: 'project', path: dir }], resourceEditing: { extensions: ['.md'] } })],
  });
  const row = skills.getSkillInventory({ projectPath: project }).skills.find(s => s.name === 'local-gone');
  assert.equal(row.scope, 'project');
  assert.equal(row.deletable, true);
  assert.equal((await skills.deleteSkill({ id: row.id, projectPath: project })).ok, true);
  assert.equal(fs.existsSync(folder), false);
});

test('the app\'s own skills are editable but not deletable here', async () => {
  const data = tmpdir('data');
  const own = path.join(data, 'skills', 'mine', 'SKILL.md');
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.writeFileSync(own, '# mine\n');
  const registry = { list: () => [], get: () => null };
  const log = { warn() {}, error() {}, info() {}, debug() {} };
  skills.init({ backends: registry, log, dataDir: data, effectiveSettings: () => ({}), projectStates: () => new Map() });
  backendResources.init({ backends: registry, log });
  const row = skills.getSkillInventory({}).skills.find(s => s.name === 'mine');
  assert.equal(row.editable, true);
  assert.equal(row.deletable, false);
  const out = await skills.deleteSkill({ id: row.id });
  assert.equal(out.ok, false);
  assert.ok(fs.existsSync(own));
});
