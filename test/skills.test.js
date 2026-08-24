'use strict';
// #462 — what the skill picker is offered, assembled in main.
//
// The descriptor is stubbed rather than mocked away: the point of this file is that `src/app/skills.js`
// asks the backend for BOTH the listing and the invocation and adds nothing of its own. A stub that
// answers differently per scope is what proves the two scopes are actually both asked for.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const skills = require('../src/app/skills');

function tmpdir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-skills-' + name + '-'));
  return dir;
}

/** A skill on disk is a folder holding SKILL.md — the shape every CLI here uses. */
function writeSkill(root, name, body = '# skill\n') {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  return path.join(dir, 'SKILL.md');
}

/** A descriptor that reports one skills directory per scope and expands it the way the real ones do. */
function stubBackend({ id = 'stub', label = 'Stub', globalDir = null, projectDir = null, invocation = null,
  originLabel = null } = {}) {
  return {
    id,
    label,
    listResources: ({ projectPath }) => ({
      ok: true,
      resources: [
        ...(globalDir ? [{ kind: 'skill', scope: 'global', name: 'skills', path: globalDir, source: 'skills-directory', originLabel }] : []),
        ...(projectPath && projectDir
          ? [{ kind: 'skill', scope: 'project', name: 'skills', path: projectDir, source: 'skills-directory' }] : []),
        // A directory that is NOT skills, to prove the kind filter is real.
        { kind: 'command', scope: 'global', name: 'commands', path: globalDir || projectDir, source: 'commands-directory' },
      ],
    }),
    expandResource: ({ path: dir, scope }) => ({
      ok: true,
      entries: fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => ({ kind: 'skill', scope, name: e.name, path: path.join(dir, e.name, 'SKILL.md'), source: 'skills-directory' })),
    }),
    ...(invocation ? { skillInvocation: invocation } : {}),
  };
}

function setup({ backend = null, dataDir = null, settings = {} } = {}) {
  skills.init({
    backends: { get: (id) => (backend && backend.id === id ? backend : null) },
    log: { warn() {}, error() {}, info() {} },
    dataDir: dataDir || tmpdir('data'),
    effectiveSettings: () => settings,
  });
}

test('a backend\'s skills are listed for both scopes, with the invocation it declares', () => {
  const globalDir = tmpdir('global');
  const projectDir = tmpdir('project');
  writeSkill(globalDir, 'git-commit');
  writeSkill(projectDir, 'release');
  const backend = stubBackend({
    globalDir, projectDir, invocation: ({ name }) => '/' + name,
  });
  setup({ backend });

  const { skills: rows } = skills.getSkills({ projectPath: 'C:/proj', backendId: 'stub' });
  assert.deepEqual(rows.map(r => r.name), ['git-commit', 'release']);
  assert.deepEqual(rows.map(r => r.invocation), ['/git-commit', '/release']);
  assert.deepEqual(rows.map(r => r.scope), ['global', 'project']);
  // The origin is what the row shows, so the same name from two places stays two readable rows.
  assert.deepEqual(rows.map(r => r.origin), ['Stub · global', 'Stub · project']);
});

// #463: a listing entry may say what a reader should CALL it, for a directory whose path does not — a
// plugin's skills are cached under the marketplace's name, so "Stub · global" would be true and useless.
// The core does not know what makes a label special, only to prefer one over the scope.
test('a label on the listing entry replaces the scope in the origin', () => {
  const globalDir = tmpdir('labelled');
  writeSkill(globalDir, 'do-a-thing');
  setup({ backend: stubBackend({ globalDir, originLabel: 'Plugin toolkit' }) });

  const { skills: rows } = skills.getSkills({ projectPath: null, backendId: 'stub' });
  assert.deepEqual(rows.map(r => r.origin), ['Stub · Plugin toolkit']);
  assert.deepEqual(rows.map(r => r.scope), ['global'], 'the scope itself is unchanged, only what is shown');
});

test('without such a label the origin still names the scope', () => {
  const globalDir = tmpdir('unlabelled');
  writeSkill(globalDir, 'do-a-thing');
  setup({ backend: stubBackend({ globalDir }) });
  assert.deepEqual(skills.getSkills({ projectPath: null, backendId: 'stub' }).skills.map(r => r.origin),
    ['Stub · global']);
});

test('a backend with no invocation hook leaves every row on the text fallback', () => {
  const globalDir = tmpdir('global2');
  writeSkill(globalDir, 'humanizer');
  setup({ backend: stubBackend({ globalDir }) });
  const { skills: rows } = skills.getSkills({ projectPath: null, backendId: 'stub' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].invocation, null, 'no hook is the honest answer, not a guessed prefix');
});

test('an invocation hook that throws or answers with nothing falls back to text', () => {
  const globalDir = tmpdir('global3');
  writeSkill(globalDir, 'boom');
  setup({ backend: stubBackend({ globalDir, invocation: () => { throw new Error('nope'); } }) });
  assert.equal(skills.getSkills({ backendId: 'stub' }).skills[0].invocation, null);

  setup({ backend: stubBackend({ globalDir, invocation: () => '   ' }) });
  assert.equal(skills.getSkills({ backendId: 'stub' }).skills[0].invocation, null);
});

test('the app\'s own skills are offered whatever the backend is, and always as text', () => {
  const dataDir = tmpdir('data2');
  const ownDir = path.join(dataDir, 'skills');
  fs.mkdirSync(ownDir, { recursive: true });
  writeSkill(ownDir, 'house-style');
  // A single markdown file counts too — a first skill should not have to learn a folder convention.
  fs.writeFileSync(path.join(ownDir, 'one-file.md'), '# one file\n');
  setup({ dataDir });

  const { skills: rows } = skills.getSkills({ backendId: 'nothing-here' });
  assert.deepEqual(rows.map(r => r.name).sort(), ['house-style', 'one-file']);
  assert.deepEqual(rows.map(r => r.origin), ['Switchboard', 'Switchboard']);
  assert.deepEqual(rows.map(r => r.invocation), [null, null], 'they belong to no CLI, so there is nothing to invoke');
});

test('the rows are sorted by skill name, whatever they came from', () => {
  const dataDir = tmpdir('data3');
  const ownDir = path.join(dataDir, 'skills');
  fs.mkdirSync(ownDir, { recursive: true });
  writeSkill(ownDir, 'middle');
  const globalDir = tmpdir('global4');
  writeSkill(globalDir, 'aaa');
  writeSkill(globalDir, 'zzz');
  setup({ backend: stubBackend({ globalDir }), dataDir });

  const { skills: rows } = skills.getSkills({ backendId: 'stub' });
  assert.deepEqual(rows.map(r => r.name), ['aaa', 'middle', 'zzz'],
    'the name is what someone is looking for; the source is not a sort order');
});

test('a skills directory in the settings cascade wins, absolute or relative', () => {
  const dataDir = tmpdir('data4');
  const elsewhere = tmpdir('elsewhere');
  writeSkill(elsewhere, 'from-settings');
  setup({ dataDir, settings: { skillsDir: elsewhere } });
  assert.deepEqual(skills.getSkills({}).skills.map(r => r.name), ['from-settings']);

  // Relative is read from the project, so a project can keep its skills in the repository.
  const project = tmpdir('proj');
  fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
  writeSkill(path.join(project, 'docs'), 'in-repo');
  setup({ dataDir, settings: { skillsDir: 'docs' } });
  assert.deepEqual(skills.getSkills({ projectPath: project }).skills.map(r => r.name), ['in-repo']);
});

test('a missing directory and a missing backend are answers, not errors', () => {
  setup({ dataDir: path.join(tmpdir('data5'), 'gone') });
  assert.deepEqual(skills.getSkills({ backendId: 'nope' }).skills, []);
  assert.deepEqual(skills.getSkills({}).skills, []);
});

test('only skill directories are read, never the other resource kinds', () => {
  const globalDir = tmpdir('global5');
  writeSkill(globalDir, 'only-this');
  setup({ backend: stubBackend({ globalDir }) });
  const rows = skills.getSkills({ backendId: 'stub' }).skills;
  // The stub also reports a commands directory pointing at the same place; a kind filter that was not
  // applied would list its contents a second time.
  assert.deepEqual(rows.map(r => r.name), ['only-this']);
});
