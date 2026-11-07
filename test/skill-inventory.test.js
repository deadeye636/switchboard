'use strict';
// #803 T2 — the neutral skill inventory the Plugins manager lists (spec 40 D4, E4).
//
// One row per skill FILE across every backend, plus the app's own. What is pinned here is what the
// renderer may never get: no backend id, no invocation, no listing source. The descriptors are stubs,
// as in skills.test.js, because the point is that the inventory asks the same seam the picker does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const skills = require('../src/app/skills');

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-skill-inv-' + name + '-'));
}

function writeSkill(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# skill\n');
  return path.join(dir, 'SKILL.md');
}

/** A descriptor reporting one global skills directory and expanding it one level, like the real ones. */
function stubBackend({ id, label, globalDir = null, projectDir = null, throws = false }) {
  return {
    id,
    label,
    listResources: ({ projectPath }) => {
      if (throws) throw new Error('listing failed');
      return {
        ok: true,
        resources: [
          ...(globalDir ? [{ kind: 'skill', scope: 'global', name: 'skills', path: globalDir, source: 'skills-directory' }] : []),
          ...(projectPath && projectDir
            ? [{ kind: 'skill', scope: 'project', name: 'skills', path: projectDir, source: 'skills-directory' }] : []),
        ],
      };
    },
    expandResource: ({ path: dir, scope }) => ({
      ok: true,
      entries: fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => ({ kind: 'skill', scope, name: e.name, path: path.join(dir, e.name, 'SKILL.md'), source: 'skills-directory' })),
    }),
    skillInvocation: ({ name }) => '/' + name,
  };
}

/** A registry with the two calls the inventory makes: `list` for who to ask, `get` for the descriptor. */
function setup({ backends = [], rows = null, dataDir = null, settings = {}, oneAskerPerCli = null } = {}) {
  const listed = rows || backends.map(b => ({ id: b.id, isProfile: false, status: 'ready' }));
  skills.init({
    backends: {
      list: () => listed,
      get: (id) => backends.find(b => b.id === id) || null,
      ...(oneAskerPerCli ? { oneAskerPerCli } : {}),
    },
    log: { warn() {}, error() {}, info() {} },
    dataDir: dataDir || tmpdir('data'),
    effectiveSettings: () => settings,
  });
}

test('two backends reporting one directory give one row', () => {
  const shared = tmpdir('shared');
  writeSkill(shared, 'release');
  setup({ backends: [
    stubBackend({ id: 'one', label: 'One', globalDir: shared }),
    stubBackend({ id: 'two', label: 'Two', globalDir: shared }),
  ] });
  const rows = skills.getSkillInventory({}).skills;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'release');
  assert.deepEqual(rows[0].alsoNamed, [], 'one file is one skill, not two names for it');
});

test('two files of one name give two rows, each naming the other place', () => {
  const a = tmpdir('a');
  const b = tmpdir('b');
  writeSkill(a, 'review');
  writeSkill(b, 'Review');
  setup({ backends: [
    stubBackend({ id: 'one', label: 'One', globalDir: a }),
    stubBackend({ id: 'two', label: 'Two', globalDir: b }),
  ] });
  const rows = skills.getSkillInventory({}).skills;
  assert.equal(rows.length, 2);
  const one = rows.find(r => r.sourceLabel === 'One · global');
  const two = rows.find(r => r.sourceLabel === 'Two · global');
  assert.deepEqual(one.alsoNamed, [{ sourceLabel: 'Two · global', filePath: two.filePath }]);
  assert.deepEqual(two.alsoNamed, [{ sourceLabel: 'One · global', filePath: one.filePath }]);
});

test('no row carries a backend id, an invocation or the listing source', () => {
  const dir = tmpdir('g');
  writeSkill(dir, 'commit');
  const data = tmpdir('data');
  writeSkill(path.join(data, 'skills'), 'house-style');
  setup({ backends: [stubBackend({ id: 'one', label: 'One', globalDir: dir })], dataDir: data });
  const rows = skills.getSkillInventory({}).skills;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['alsoNamed', 'clis', 'deletable', 'editable', 'filePath', 'id', 'name', 'scope', 'sourceLabel']);
  }
});

test('the app\'s own skill reads Switchboard, global for the default directory', () => {
  const data = tmpdir('data');
  writeSkill(path.join(data, 'skills'), 'house-style');
  setup({ dataDir: data });
  const [row] = skills.getSkillInventory({ projectPath: tmpdir('proj') }).skills;
  assert.equal(row.sourceLabel, 'Switchboard');
  assert.equal(row.scope, 'global');
});

test('the app\'s own skills in a directory inside the project are the project\'s', () => {
  const project = tmpdir('proj');
  writeSkill(path.join(project, 'docs', 'skills'), 'in-repo');
  setup({ settings: { skillsDir: 'docs/skills' } });
  const [row] = skills.getSkillInventory({ projectPath: project }).skills;
  assert.equal(row.name, 'in-repo');
  assert.equal(row.scope, 'project');
});

test('both scopes of every backend are asked when a project is given', () => {
  const g = tmpdir('g');
  const p = tmpdir('p');
  writeSkill(g, 'global-one');
  writeSkill(p, 'project-one');
  setup({ backends: [stubBackend({ id: 'one', label: 'One', globalDir: g, projectDir: p })] });
  const rows = skills.getSkillInventory({ projectPath: tmpdir('proj') }).skills;
  assert.deepEqual(rows.map(r => [r.name, r.scope]), [['global-one', 'global'], ['project-one', 'project']]);
});

test('profiles and backends that are not ready are not asked', () => {
  const dir = tmpdir('g');
  writeSkill(dir, 'only-ready');
  const other = tmpdir('o');
  writeSkill(other, 'from-profile');
  const missing = tmpdir('m');
  writeSkill(missing, 'from-missing');
  setup({
    backends: [
      stubBackend({ id: 'ready', label: 'Ready', globalDir: dir }),
      stubBackend({ id: 'profile', label: 'Profile', globalDir: other }),
      stubBackend({ id: 'missing', label: 'Missing', globalDir: missing }),
    ],
    rows: [
      { id: 'ready', isProfile: false, status: 'ready' },
      { id: 'profile', isProfile: true, status: 'ready' },
      { id: 'missing', isProfile: false, status: 'missing' },
    ],
  });
  assert.deepEqual(skills.getSkillInventory({}).skills.map(r => r.name), ['only-ready']);
});

test('one asker per CLI: the registry decides which of a pair is asked', () => {
  const dir = tmpdir('g');
  writeSkill(dir, 'x');
  const drv = tmpdir('d');
  writeSkill(drv, 'from-driver');
  setup({
    backends: [
      stubBackend({ id: 'owner', label: 'Owner', globalDir: dir }),
      stubBackend({ id: 'driver', label: 'Driver', globalDir: drv }),
    ],
    oneAskerPerCli: (list) => list.filter(b => b.id !== 'driver'),
  });
  assert.deepEqual(skills.getSkillInventory({}).skills.map(r => r.name), ['x']);
});

test('a backend whose listing throws does not drop the others', () => {
  const dir = tmpdir('g');
  writeSkill(dir, 'survivor');
  setup({ backends: [
    stubBackend({ id: 'bad', label: 'Bad', throws: true }),
    stubBackend({ id: 'good', label: 'Good', globalDir: dir }),
  ] });
  assert.deepEqual(skills.getSkillInventory({}).skills.map(r => r.name), ['survivor']);
});

test('the id is stable per file and differs between files', () => {
  const dir = tmpdir('g');
  writeSkill(dir, 'a');
  writeSkill(dir, 'b');
  setup({ backends: [stubBackend({ id: 'one', label: 'One', globalDir: dir })] });
  const first = skills.getSkillInventory({}).skills.map(r => r.id);
  const second = skills.getSkillInventory({}).skills.map(r => r.id);
  assert.deepEqual(first, second);
  assert.notEqual(first[0], first[1]);
  assert.match(first[0], /^[0-9a-f]{16}$/);
});

test('the main-side collection keeps the owner and the listing source for the delivery answer', () => {
  const dir = tmpdir('g');
  writeSkill(dir, 'kept');
  setup({ backends: [stubBackend({ id: 'one', label: 'One', globalDir: dir })] });
  const [row] = skills._collectSkillInventory({});
  assert.equal(row.backendId, 'one');
  assert.equal(row.source, 'skills-directory');
  assert.deepEqual(row.owners, [{ backendId: 'one', source: 'skills-directory', fromPlugin: false }]);
});

test('a file two backends report keeps both owners, whatever the registry order', () => {
  const shared = tmpdir('shared');
  writeSkill(shared, 'both');
  setup({ backends: [
    stubBackend({ id: 'one', label: 'One', globalDir: shared }),
    stubBackend({ id: 'two', label: 'Two', globalDir: shared }),
  ] });
  const [row] = skills._collectSkillInventory({});
  assert.deepEqual(row.owners.map(o => o.backendId), ['one', 'two']);
});

test('two files of one name under ONE label still name each other', () => {
  const root = tmpdir('cats');
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  writeSkill(a, 'review');
  writeSkill(b, 'review');
  const backend = stubBackend({ id: 'one', label: 'One', globalDir: a });
  const listResources = backend.listResources;
  backend.listResources = (args) => {
    const listed = listResources(args);
    listed.resources.push({ kind: 'skill', scope: 'global', name: 'more', path: b, source: 'skills-directory' });
    return listed;
  };
  setup({ backends: [backend] });
  const rows = skills.getSkillInventory({}).skills;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.alsoNamed.length, 1, 'one other file, though under the same label');
    assert.equal(row.alsoNamed[0].sourceLabel, 'One · global');
    assert.notEqual(row.alsoNamed[0].filePath, row.filePath);
  }
});

test('an absolute skills directory inside the project belongs to the project', () => {
  const project = tmpdir('proj');
  const dir = path.join(project, 'skills');
  writeSkill(dir, 'abs');
  setup({ settings: { skillsDir: dir } });
  const [row] = skills.getSkillInventory({ projectPath: project }).skills;
  assert.equal(row.scope, 'project');
});

test('the id does not change with the case of the path', () => {
  const dir = tmpdir('g');
  const file = writeSkill(dir, 'cased');
  setup({ backends: [stubBackend({ id: 'one', label: 'One', globalDir: dir })] });
  const [row] = skills.getSkillInventory({}).skills;
  assert.equal(row.filePath, file);
  const upper = stubBackend({ id: 'one', label: 'One', globalDir: dir.toUpperCase() });
  if (!fs.existsSync(dir.toUpperCase())) return;   // a case-sensitive file system has no second spelling
  setup({ backends: [upper] });
  assert.equal(skills.getSkillInventory({}).skills[0].id, row.id);
});

test('the picker rows are unchanged: no listing source reaches them', () => {
  const dir = tmpdir('g');
  writeSkill(dir, 'commit');
  const backend = stubBackend({ id: 'one', label: 'One', globalDir: dir });
  setup({ backends: [backend] });
  const [row] = skills.getSkills({ backendId: 'one' }).skills;
  assert.deepEqual(Object.keys(row).sort(), ['backendId', 'filePath', 'invocation', 'name', 'origin', 'scope']);
});

test('each row names the CLIs that reported it (#824): a driver folds into its owner, the app\'s own skill is neutral', () => {
  const shared = tmpdir('shared');
  writeSkill(shared, 'release');
  const data = tmpdir('data');
  writeSkill(path.join(data, 'skills'), 'house-style');
  const owner = stubBackend({ id: 'owner', label: 'Owner CLI', globalDir: shared });
  const driver = { ...stubBackend({ id: 'driver', label: 'Driver GUI', globalDir: shared }), transcriptsOf: 'owner' };
  const other = stubBackend({ id: 'other', label: 'Other CLI', globalDir: shared });
  const all = [owner, driver, other];
  skills.init({
    backends: {
      list: () => all.map(b => ({ id: b.id, isProfile: false, status: 'ready' })),
      get: (id) => all.find(b => b.id === id) || null,
      cliOwnerOf: (b) => (b.transcriptsOf ? all.find(x => x.id === b.transcriptsOf) : b),
    },
    log: { warn() {}, error() {}, info() {} },
    dataDir: data,
    effectiveSettings: () => ({}),
  });
  const rows = skills.getSkillInventory({}).skills;
  const release = rows.find(r => r.name === 'release');
  assert.deepEqual(release.clis, [{ key: 'owner', label: 'Owner CLI' }, { key: 'other', label: 'Other CLI' }]);
  assert.deepEqual(rows.find(r => r.name === 'house-style').clis, [{ key: 'switchboard', label: 'Switchboard' }]);
});
