'use strict';
// #803 T5 — the skill editor's door (owner decisions E11, E13, E14; verifier findings on the first cut).
//
// A skill is read and saved by its inventory ID, never a path. What is pinned is the edge of that write
// permission: the app's own skills directory is refused when it is a network path, a filesystem root (also
// through a junction), the home directory or above, or a backend's own directory; a file the expander did
// not name, or one reached through a link out of the directory, is not editable; a project must be on the
// list. `editable` on a row is the same predicate the save uses.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const skills = require('../src/app/skills');
const backendResources = require('../src/app/backend-resources');

const made = [];
const links = [];
function tmpdir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sk-door-' + name + '-'));
  made.push(dir);
  return dir;
}
test.after(() => {
  for (const l of links) { try { fs.rmSync(l, { recursive: false, force: true }); } catch {} }
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function write(file, text = '# skill\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function link(target, at) {
  try { fs.symlinkSync(target, at, 'junction'); links.push(at); return true; } catch { return false; }
}

function skillsBackend({ id = 'cli', dir, resourceEditing = null }) {
  return {
    id,
    label: 'Cli',
    ...(resourceEditing ? { resourceEditing } : {}),
    listResources: () => ({ ok: true, resources: [{ kind: 'skill', scope: 'global', name: 'skills', path: dir, source: 'skills-directory' }] }),
    expandResource: ({ path: d, scope }) => ({
      ok: true,
      entries: fs.readdirSync(d).filter(n => fs.statSync(path.join(d, n)).isDirectory())
        .map(n => ({ kind: 'skill', scope, name: n, path: path.join(d, n, 'SKILL.md'), source: 'skills-directory' })),
    }),
  };
}

function setup({ dataDir, settings = () => ({}), backends = [], projects = [] }) {
  const registry = {
    list: () => backends.map(b => ({ id: b.id, isProfile: false, status: 'ready' })),
    get: (id) => backends.find(b => b.id === id) || null,
  };
  skills.init({
    backends: registry,
    log: { warn() {}, error() {}, info() {}, debug() {} },
    dataDir,
    effectiveSettings: (p) => settings(p),
    projectStates: () => new Map(projects.map(p => [p, { registered: true }])),
  });
  backendResources.init({ backends: registry, log: { warn() {}, error() {}, info() {}, debug() {} } });
}

const byName = (projectPath = null) => Object.fromEntries(skills.getSkillInventory({ projectPath }).skills.map(s => [s.name, s]));

// ── which directory ─────────────────────────────────────────────────────────────────────────────────────
test('the app\'s skills directory lists SKILL.md files and one-file skills, nothing else', () => {
  const data = tmpdir('data');
  const dir = path.join(data, 'skills');
  const skill = write(path.join(dir, 'house-style', 'SKILL.md'));
  const loose = write(path.join(dir, 'one-file.md'));
  write(path.join(dir, 'house-style', 'notes.md'));
  setup({ dataDir: data });
  const answer = skills.switchboardSkillFiles(null);
  assert.equal(answer.refused, null);
  assert.deepEqual(answer.files.map(f => f.filePath).sort(), [skill, loose].sort());
});

for (const [why, dirOf, expect] of [
  ['a network path', () => '\\\\host\\share\\skills', 'a network path'],
  ['a filesystem root', (data) => path.parse(data).root, 'a drive root'],
  ['the home directory', () => os.homedir(), 'the home directory or a directory above it'],
  ['a directory above the home directory', () => path.dirname(os.homedir()), 'the home directory or a directory above it'],
]) {
  test(`skillsDir as ${why} is refused, lists nothing, and is not walked for the picker either`, () => {
    const data = tmpdir('data');
    setup({ dataDir: data, settings: () => ({ skillsDir: dirOf(data) }) });
    const answer = skills.switchboardSkillFiles(null);
    assert.equal(answer.refused, expect);
    assert.deepEqual(answer.files, []);
    assert.deepEqual(skills.getSkills({}).skills, []);
  });
}

test('a junction to a filesystem root is refused on its real path, for the editor and the picker', (t) => {
  const data = tmpdir('data');
  const at = path.join(data, 'looks-ordinary');
  if (!link(path.parse(data).root, at)) { t.skip('no junctions here'); return; }
  setup({ dataDir: data, settings: () => ({ skillsDir: at }) });
  const started = Date.now();
  assert.equal(skills.switchboardSkillFiles(null).refused, 'a drive root');
  assert.deepEqual(skills.getSkills({}).skills, []);
  assert.ok(Date.now() - started < 5000, 'nothing walked the drive');
});

test('a backend\'s own directory — at it, inside it, or above it — is refused (E14)', () => {
  const data = tmpdir('data');
  const cliHome = tmpdir('cli-home');
  const cliSkills = path.join(cliHome, 'skills');
  write(path.join(cliSkills, 'theirs', 'SKILL.md'));
  for (const dir of [cliSkills, path.join(cliSkills, 'theirs'), cliHome]) {
    setup({ dataDir: data, backends: [skillsBackend({ dir: cliSkills })], settings: () => ({ skillsDir: dir }) });
    assert.equal(skills.switchboardSkillFiles(null).refused, 'a backend\'s own directory', dir);
  }
});

// ── reading and saving ─────────────────────────────────────────────────────────────────────────────────
test('the app\'s own skill reads and saves by id, and a save over a change it has not seen is a conflict', async () => {
  const data = tmpdir('data');
  const file = write(path.join(data, 'skills', 'house-style', 'SKILL.md'), '# house\n');
  setup({ dataDir: data });
  const row = byName()['house-style'];
  assert.equal(row.editable, true);
  assert.deepEqual(await skills.readSkill({ id: row.id }), { ok: true, content: '# house\n' });
  const saved = await skills.saveSkill({ id: row.id, content: '# house\n\nmore\n', baseline: '# house\n' });
  assert.equal(saved.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '# house\n\nmore\n');
  fs.writeFileSync(file, 'changed outside\n');
  const stale = await skills.saveSkill({ id: row.id, content: 'stale\n', baseline: '# house\n\nmore\n' });
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'changed outside\n');
});

test('an upper-case .MD one-file skill is editable and saves, so `editable` and the save agree', async () => {
  const data = tmpdir('data');
  const file = write(path.join(data, 'skills', 'Loud.MD'), 'x\n');
  setup({ dataDir: data });
  const row = byName().Loud || byName()['Loud.MD'] || Object.values(byName())[0];
  assert.equal(row.editable, true);
  assert.equal((await skills.saveSkill({ id: row.id, content: 'y\n', baseline: 'x\n' })).ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'y\n');
});

test('a skill reached through a link out of the directory is listed but not editable, and refused', async (t) => {
  const data = tmpdir('data');
  write(path.join(data, 'skills', 'inside', 'SKILL.md'));
  const outside = tmpdir('outside');
  const target = write(path.join(outside, 'escaped', 'SKILL.md'), 'outside\n');
  if (!link(path.join(outside, 'escaped'), path.join(data, 'skills', 'escaped'))) { t.skip('no links here'); return; }
  setup({ dataDir: data });
  const row = byName().escaped;
  assert.ok(row, 'the picker still lists it, as it always did');
  assert.equal(row.editable, false);
  assert.equal((await skills.readSkill({ id: row.id })).ok, false);
  assert.equal((await skills.saveSkill({ id: row.id, content: 'x', baseline: 'outside\n' })).ok, false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'outside\n');
});

test('an unknown id, an unregistered project and a missing content are refused', async () => {
  const data = tmpdir('data');
  write(path.join(data, 'skills', 'house-style', 'SKILL.md'));
  setup({ dataDir: data });
  const row = byName()['house-style'];
  assert.match((await skills.readSkill({ id: '0000000000000000' })).reason, /no longer listed/);
  assert.match((await skills.readSkill({ id: row.id, projectPath: tmpdir('stranger') })).reason, /not on the list/);
  assert.match((await skills.saveSkill({ id: row.id })).reason, /Nothing to save/);
});

test('a save without a baseline is refused — the editor only saves what it read', async () => {
  const data = tmpdir('data');
  const file = write(path.join(data, 'skills', 'house-style', 'SKILL.md'), '# house\n');
  setup({ dataDir: data });
  const row = byName()['house-style'];
  assert.match((await skills.saveSkill({ id: row.id, content: 'x' })).reason, /Open the skill again/);
  assert.equal(fs.readFileSync(file, 'utf8'), '# house\n');
});

test('a listed FILE in the project (CLAUDE.md) does not make the project root a backend\'s', async () => {
  const data = tmpdir('data');
  const project = tmpdir('proj');
  write(path.join(project, 'CLAUDE.md'), '# project\n');
  write(path.join(project, 'docs', 'skills', 'in-repo', 'SKILL.md'));
  const claudeShaped = {
    id: 'cli',
    label: 'Cli',
    listResources: ({ projectPath }) => ({
      ok: true,
      resources: projectPath ? [
        { kind: 'instructions', scope: 'project', name: 'CLAUDE.md', path: path.join(projectPath, 'CLAUDE.md'), source: 'project-instructions' },
        { kind: 'skill', scope: 'project', name: 'skills', path: path.join(projectPath, '.cli', 'skills'), source: 'project-skills' },
      ] : [],
    }),
    expandResource: () => ({ ok: true, entries: [] }),
  };
  setup({ dataDir: data, backends: [claudeShaped], projects: [project], settings: (p) => (p === project ? { skillsDir: 'docs/skills' } : {}) });
  assert.equal(skills.switchboardSkillFiles(project).refused, null);
  assert.equal(byName(project)['in-repo'].editable, true);
});

test('a CLI home that lists only files (a fresh install) is still the CLI\'s (E14)', () => {
  const data = tmpdir('data');
  const cliHome = tmpdir('fresh-cli');
  const own = write(path.join(cliHome, 'CLAUDE.md'), '# global instructions\n');
  const fresh = {
    id: 'cli',
    label: 'Cli',
    listResources: () => ({ ok: true, resources: [{ kind: 'instructions', scope: 'global', name: 'CLAUDE.md', path: own, source: 'global-instructions' }] }),
    expandResource: () => ({ ok: true, entries: [] }),
  };
  setup({ dataDir: data, backends: [fresh], settings: () => ({ skillsDir: cliHome }) });
  assert.equal(skills.switchboardSkillFiles(null).refused, 'a backend\'s own directory');
  const row = Object.values(byName())[0];
  assert.equal(row && row.editable, false, 'the CLI\'s CLAUDE.md is listed as a one-file skill but not editable');
});

test('a worktree of a registered project may speak for it', async () => {
  const data = tmpdir('data');
  const project = tmpdir('proj');
  const worktree = path.join(project, '.claude', 'worktrees', 'agent-a');
  fs.mkdirSync(worktree, { recursive: true });
  write(path.join(data, 'skills', 'house-style', 'SKILL.md'), '# house\n');
  setup({ dataDir: data, projects: [project] });
  const row = byName(worktree)['house-style'];
  assert.equal((await skills.readSkill({ id: row.id, projectPath: worktree })).ok, true);
});

test('a backend skill folder linked out of the backend\'s directory is not editable, as its writer would refuse it', async (t) => {
  const data = tmpdir('data');
  const dir = tmpdir('cli');
  write(path.join(dir, 'inside', 'SKILL.md'));
  const outside = tmpdir('outside');
  write(path.join(outside, 'linked', 'SKILL.md'));
  if (!link(path.join(outside, 'linked'), path.join(dir, 'linked'))) { t.skip('no links here'); return; }
  setup({ dataDir: data, backends: [skillsBackend({ dir, resourceEditing: { extensions: ['.md'] } })] });
  const rows = byName();
  assert.equal(rows.inside.editable, true);
  assert.equal(rows.linked.editable, (await skills.saveSkill({ id: rows.linked.id, content: 'x', baseline: '# skill\n' })).ok,
    '`editable` and the save agree');
});

test('a registered project with its own relative skillsDir reads and saves there', async () => {
  const data = tmpdir('data');
  const project = tmpdir('proj');
  const file = write(path.join(project, 'docs', 'skills', 'in-repo', 'SKILL.md'), '# repo\n');
  setup({ dataDir: data, projects: [project], settings: (p) => (p === project ? { skillsDir: 'docs/skills' } : {}) });
  const row = byName(project)['in-repo'];
  assert.equal(row.scope, 'project');
  assert.equal(row.editable, true);
  assert.deepEqual(await skills.readSkill({ id: row.id, projectPath: project }), { ok: true, content: '# repo\n' });
  assert.equal((await skills.saveSkill({ id: row.id, projectPath: project, content: '# r2\n', baseline: '# repo\n' })).ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '# r2\n');
});

test('a backend\'s skill goes through that backend\'s own door, and only when it declares the extension', async () => {
  const data = tmpdir('data');
  const dir = tmpdir('cli');
  const file = write(path.join(dir, 'theirs', 'SKILL.md'), '# theirs\n');

  setup({ dataDir: data, backends: [skillsBackend({ dir })] });
  let row = byName().theirs;
  assert.equal(row.editable, false, 'a backend that declares nothing is read-only');
  assert.match((await skills.saveSkill({ id: row.id, content: 'x', baseline: '# theirs\n' })).reason, /cannot be edited/);

  setup({ dataDir: data, backends: [skillsBackend({ dir, resourceEditing: { extensions: ['.md'] } })] });
  row = byName().theirs;
  assert.equal(row.editable, true);
  const read = await skills.readSkill({ id: row.id });
  assert.equal(read.ok, true);
  assert.equal(read.content, '# theirs\n');
  assert.equal((await skills.saveSkill({ id: row.id, content: '# t2\n', baseline: '# theirs\n' })).ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '# t2\n');
});
