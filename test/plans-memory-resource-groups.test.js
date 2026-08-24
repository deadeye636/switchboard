'use strict';
// #440/#441 — the group builder behind the Agent Files tab.
//
// It decides three things nothing else can: which directories appear at all, which rows offer a Delete,
// and which groups offer a New. All three are read by the renderer, and none of them was covered — the
// tab was the only thing exercising it, which is the shape this repo has been bitten by before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const plansMemory = require('../src/app/plans-memory');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-groups-'));
}

function write(file, body = 'x\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

/**
 * A backend with a skills directory holding one skill, an empty commands directory it CAN create into,
 * an empty output-styles directory it cannot, a settings file, and a model cache.
 */
function stubBackend(home, { scaffolds = true } = {}) {
  const skillsDir = path.join(home, 'skills');
  const commandsDir = path.join(home, 'commands');
  const stylesDir = path.join(home, 'output-styles');
  const skillFile = write(path.join(skillsDir, 'do-a-thing', 'SKILL.md'), '---\nname: do-a-thing\n---\n');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.mkdirSync(stylesDir, { recursive: true });
  const settings = write(path.join(home, 'settings.json'), '{}\n');
  const cache = write(path.join(home, 'models_cache.json'), '{}\n');

  return {
    id: 'stub',
    label: 'Stub',
    status: 'ready',
    memorySources: () => [],
    listResources: () => ({
      ok: true,
      resources: [
        { kind: 'skill', scope: 'global', name: 'skills', path: skillsDir, source: 'skills-directory' },
        { kind: 'command', scope: 'global', name: 'commands', path: commandsDir, source: 'commands-directory' },
        { kind: 'output-style', scope: 'global', name: 'output-styles', path: stylesDir, source: 'styles-directory' },
        { kind: 'settings', scope: 'global', name: 'settings.json', path: settings, source: 'settings' },
        { kind: 'model-catalog', scope: 'global', name: 'models_cache.json', path: cache, source: 'model-cache' },
      ],
    }),
    expandResource: ({ path: dir }) => ({
      ok: true,
      entries: dir === skillsDir ? [{ kind: 'skill', name: 'do-a-thing', path: skillFile }] : [],
    }),
    ...(scaffolds ? {
      resourceScaffolds: [
        { kind: 'skill', layout: 'dir', entryFile: 'SKILL.md', sources: ['skills-directory'], template: () => '' },
        { kind: 'command', layout: 'file', ext: '.md', sources: ['commands-directory'], template: () => '' },
      ],
    } : {}),
    fixtures: { skillsDir, commandsDir, stylesDir, settings, cache, skillFile },
  };
}

function setup(opts) {
  const home = tmpdir();
  const backend = stubBackend(home, opts);
  plansMemory.init({
    backends: { list: () => [backend] },
    db: { getProjectStates: () => new Map(), getProjectDisplayNames: () => new Map() },
    log: { warn() {}, error() {}, info() {} },
    activeSessions: new Map(),
    dataDir: home,
  });
  return { home, backend, fixtures: backend.fixtures };
}

const groupsOf = () => plansMemory._resourceGroups(null, new Map());

test('a directory with entries is a group, and its rows say whether they can be deleted', () => {
  setup();
  const skills = groupsOf().find(g => g.label === 'skills');
  assert.ok(skills, 'the skills directory is a group');
  assert.deepEqual(skills.files.map(f => f.filename), ['do-a-thing']);
  assert.equal(skills.files[0].deletable, true, 'a skill has a lifecycle, so the tab may offer Delete');
});

test('an EMPTY directory survives when something can be created in it', () => {
  // The case this exists for: a folder that is there and holds nothing is exactly where a first skill
  // belongs, and it used to render no group at all — nowhere to put the New.
  setup();
  const commands = groupsOf().find(g => g.label === 'commands');
  assert.ok(commands, 'an empty but creatable directory is kept');
  assert.deepEqual(commands.files, []);
  assert.deepEqual(commands.creatableKinds, ['command']);
});

test('an empty directory nothing can be created in is still dropped', () => {
  setup();
  assert.equal(groupsOf().some(g => g.label === 'output-styles'), false);
});

test('with no scaffolds at all, an empty directory is dropped and no group offers a New', () => {
  setup({ scaffolds: false });
  const groups = groupsOf();
  assert.equal(groups.some(g => g.label === 'commands'), false);
  assert.deepEqual(groups.find(g => g.label === 'skills').creatableKinds, []);
});

test('the settings file is a group of its own, and is not deletable', () => {
  setup();
  const settings = groupsOf().find(g => g.kind === 'settings');
  assert.ok(settings, 'without this group the app could validate TOML for a file nobody can open');
  assert.deepEqual(settings.files.map(f => f.filename), ['settings.json']);
  assert.notEqual(settings.files[0].deletable, true, 'a settings file belongs to the CLI');
});

test('a model cache is not offered — the CLI rewrites it, and editing one is a trap', () => {
  setup();
  const everyFile = groupsOf().flatMap(g => g.files.map(f => f.filename));
  assert.equal(everyFile.includes('models_cache.json'), false);
});

test('a file another row already claimed is not listed a second time', () => {
  const box = setup();
  const seen = new Map();
  seen.set(box.fixtures.skillFile, { filename: 'do-a-thing', backendIds: ['other'] });
  const skills = plansMemory._resourceGroups(null, seen).find(g => g.label === 'skills');
  // The claim adds this backend to the row that already exists, so the group has nothing of its own —
  // and an empty group only survives when something can be created in it, which skills can.
  assert.deepEqual(skills.files, []);
});
