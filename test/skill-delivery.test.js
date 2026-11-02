'use strict';
// #803 T3 — what one skill is to one target backend (spec 40 F2).
//
// Two halves. The STATES are reached with stub descriptors and the real `resource-sources.resolve`, so
// the answer is the launch's own. The FACTS each state depends on are pinned per built-in backend
// against the real descriptors — one line each, never a loop asserting them all alike — because a
// descriptor that starts taking skills changes what the detail page says, and that should be a red test
// somebody reads rather than a silent new answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { deliveryFor, sourceOptionId } = require('../src/app/skill-delivery');
const resourceSources = require('../src/app/resource-sources');

const made = [];
function tmpdir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-skill-dlv-' + name + '-'));
  made.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function writeSkill(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# skill\n');
  return path.join(dir, 'SKILL.md');
}

const globalDir = tmpdir('global');
const projectDir = tmpdir('project');
const pluginDir = tmpdir('plugin');
const globalSkill = writeSkill(globalDir, 'release');
const projectSkill = writeSkill(projectDir, 'local');
const pluginSkill = writeSkill(pluginDir, 'from-plugin');

const owner = {
  id: 'owner',
  label: 'Owner',
  sharedResources: { sources: ['skills-directory', 'project-skills'] },
  listResources: ({ projectPath }) => ({
    ok: true,
    resources: [
      { kind: 'skill', scope: 'global', name: 'skills', path: globalDir, source: 'skills-directory' },
      { kind: 'skill', scope: 'global', name: 'plugin', path: pluginDir, source: 'plugin-skills' },
      ...(projectPath ? [{ kind: 'skill', scope: 'project', name: 'skills', path: projectDir, source: 'project-skills' }] : []),
    ],
  }),
  // One level, the way the real expanders read a skills directory — for the detail page's inventory.
  expandResource: ({ path: dir, scope, source }) => ({
    ok: true,
    entries: fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory())
      .map(e => ({ kind: 'skill', scope, name: e.name, path: path.join(dir, e.name, 'SKILL.md'), source })),
  }),
  skillInvocation: ({ name }) => '/' + name,
};
const other = { id: 'other', label: 'Other', sharedResources: { sources: ['skills-directory'] }, listResources: () => ({ ok: true, resources: [] }) };
const taker = {
  id: 'taker',
  label: 'Taker',
  acceptsSharedResources: ['skill'],
  configFields: [{ id: 'takeFrom', type: 'select', choices: [''], choicesFrom: 'sharedResourceSources' }],
  trustsProjectResources: ({ options }) => options.trust === true,
  skillInvocation: ({ name }) => '/skill:' + name,
};
const driver = { id: 'driver', label: 'Driver', transcriptsOf: 'owner' };
const plain = { id: 'plain', label: 'Plain' };

const all = [owner, other, taker, driver, plain];
resourceSources.init({
  backends: {
    list: () => all.map(b => ({ id: b.id, isProfile: false, status: 'ready' })),
    get: (id) => all.find(b => b.id === id) || null,
  },
});

const ownerOf = (b) => b.transcriptsOf || b.id;
const labelOf = (id) => (all.find(b => b.id === id) || {}).label || null;
const ask = (row, target, options = {}, projectPath = null) =>
  deliveryFor({ row, target, ownerOf, labelOf, options, projectPath, resolve: resourceSources.resolve });

const ownerRow = { backendId: 'owner', source: 'skills-directory', filePath: globalSkill, name: 'release', scope: 'global' };

test('a Switchboard skill is text for every target', async () => {
  const row = { backendId: null, source: 'switchboard-skills', filePath: globalSkill, name: 'mine', scope: 'global' };
  for (const target of all) assert.equal((await ask(row, target)).state, 'text', target.id);
});

test('the owning CLI answers native, with its own invocation', async () => {
  const answer = await ask(ownerRow, owner);
  assert.equal(answer.state, 'native');
  assert.equal(answer.invocation, '/release');
});

test('a driver of the owning CLI is native too, and a driver without an invocation hook gets none', async () => {
  const answer = await ask(ownerRow, driver);
  assert.equal(answer.state, 'native');
  assert.equal(answer.invocation, null);
  assert.equal(answer.sentence, 'Its own skill.');
});

test('a target that takes no skills answers none', async () => {
  const answer = await ask(ownerRow, plain);
  assert.equal(answer.state, 'none');
  assert.match(answer.sentence, /no skills from another CLI/);
});

test('a taker with no source set answers none', async () => {
  assert.match((await ask(ownerRow, taker, {})).sentence, /"Resources from" is unset/);
});

test('a taker set to another source names both', async () => {
  const answer = await ask(ownerRow, taker, { takeFrom: 'other' });
  assert.equal(answer.state, 'none');
  assert.equal(answer.sentence, 'Takes resources from Other here, not from Owner.');
});

test('a taker set to the owner takes a shared skill over, with its own invocation', async () => {
  const answer = await ask(ownerRow, taker, { takeFrom: 'owner' });
  assert.equal(answer.state, 'shared');
  assert.equal(answer.invocation, '/skill:release');
});

test('a skill in a directory the owner does not share answers none', async () => {
  const row = { ...ownerRow, source: 'plugin-skills', filePath: pluginSkill, name: 'from-plugin' };
  const answer = await ask(row, taker, { takeFrom: 'owner' });
  assert.equal(answer.state, 'none');
  assert.match(answer.sentence, /does not share/);
});

test('a project skill for a target that does not trust the project is declined, with the reason', async () => {
  const row = { backendId: 'owner', source: 'project-skills', filePath: projectSkill, name: 'local', scope: 'project' };
  const project = tmpdir('proj');
  const declined = await ask(row, taker, { takeFrom: 'owner' }, project);
  assert.equal(declined.state, 'declined');
  assert.match(declined.sentence, /project's resources/);
  assert.equal((await ask(row, taker, { takeFrom: 'owner', trust: true }, project)).state, 'shared');
});

test('a resolver that throws gives none, not a crash', async () => {
  const answer = await deliveryFor({
    row: ownerRow, target: taker, ownerOf, labelOf, options: { takeFrom: 'owner' },
    resolve: async () => { throw new Error('boom'); },
  });
  assert.equal(answer.state, 'none');
  assert.match(answer.sentence, /Could not tell/);
});

// ── The facts the answers rest on, per built-in backend (real descriptors) ─────────────────────────────
const real = require('../src/backends');
const takes = (id) => {
  const d = real.get(id);
  return { option: sourceOptionId(d), skills: (d.acceptsSharedResources || []).includes('skill') };
};
const shares = (id) => ((real.get(id).sharedResources || {}).sources || []).includes('skills-directory');

test('claude: takes no skills over, shares its skills directory', () => {
  assert.deepEqual(takes('claude'), { option: null, skills: false });
  assert.equal(shares('claude'), true);
});
test('codex: takes no skills over, shares its skills directory', () => {
  assert.deepEqual(takes('codex'), { option: null, skills: false });
  assert.equal(shares('codex'), true);
});
test('agy: takes no skills over, shares its skills directory', () => {
  assert.deepEqual(takes('agy'), { option: null, skills: false });
  assert.equal(shares('agy'), true);
});
test('hermes: takes no skills over and shares none', () => {
  assert.deepEqual(takes('hermes'), { option: null, skills: false });
  assert.equal(shares('hermes'), false);
});
test('pi: takes skills over through resourcesFrom, shares none', () => {
  assert.deepEqual(takes('pi'), { option: 'resourcesFrom', skills: true });
  assert.equal(shares('pi'), false);
});
test('pi-native: takes skills over through resourcesFrom, and counts as pi for its own skills', () => {
  assert.deepEqual(takes('pi-native'), { option: 'resourcesFrom', skills: true });
  assert.equal(real.cliOwnerOf(real.get('pi-native')).id, 'pi');
});
test('claude-native: takes no skills over, and counts as claude for its own skills', () => {
  assert.deepEqual(takes('claude-native'), { option: null, skills: false });
  assert.equal(real.cliOwnerOf(real.get('claude-native')).id, 'claude');
});

// ── The detail page: every ready backend answers, from its effective options ──────────────────────────
const skills = require('../src/app/skills');

function setupSkills({ backendDefaults = {}, dataDir = null, disabled = [] } = {}) {
  skills.init({
    backends: {
      list: () => all.map(b => ({ id: b.id, isProfile: false, status: 'ready', enabled: !disabled.includes(b.id) })),
      get: (id) => all.find(b => b.id === id) || null,
      cliOwnerOf: (b) => (b.transcriptsOf ? all.find(x => x.id === b.transcriptsOf) : b),
    },
    log: { warn() {}, error() {}, info() {} },
    dataDir: dataDir || tmpdir('data'),
    effectiveSettings: () => ({ backendDefaults }),
  });
}

test('the detail page answers once per ready backend, from that backend\'s options', async () => {
  setupSkills({ backendDefaults: { taker: { takeFrom: 'owner' } } });
  const row = skills.getSkillInventory({}).skills.find(r => r.name === 'release');
  const detail = await skills.getSkillDetail({ id: row.id });
  assert.equal(detail.ok, true);
  assert.equal(detail.projectPath, null);
  const byTarget = Object.fromEntries(detail.targets.map(t => [t.targetLabel, t.state]));
  assert.deepEqual(byTarget, { Owner: 'native', Other: 'none', Taker: 'shared', Driver: 'native', Plain: 'none' });
  for (const t of detail.targets) {
    assert.deepEqual(Object.keys(t).sort(), ['invocation', 'sentence', 'state', 'targetLabel'], 'no backend id reaches the page');
  }
});

test('the detail page of a Switchboard skill is text everywhere', async () => {
  const data = tmpdir('data');
  writeSkill(path.join(data, 'skills'), 'house-style');
  setupSkills({ dataDir: data });
  const row = skills.getSkillInventory({}).skills.find(r => r.name === 'house-style');
  const detail = await skills.getSkillDetail({ id: row.id });
  assert.deepEqual([...new Set(detail.targets.map(t => t.state))], ['text']);
});

test('an id that is no longer listed answers not ok', async () => {
  setupSkills();
  const detail = await skills.getSkillDetail({ id: '0000000000000000' });
  assert.equal(detail.ok, false);
});

test('a backend that is switched off is not a target', async () => {
  setupSkills({ disabled: ['plain', 'other'] });
  const row = skills.getSkillInventory({}).skills.find(r => r.name === 'release');
  const labels = (await skills.getSkillDetail({ id: row.id })).targets.map(t => t.targetLabel);
  assert.deepEqual(labels, ['Owner', 'Taker', 'Driver']);
});

// ── Edges the verifier named ───────────────────────────────────────────────────────────────────────────
test('a skill folder that is a link to elsewhere still counts as under the shared directory', async (t) => {
  const elsewhere = tmpdir('elsewhere');
  writeSkill(elsewhere, 'linked');
  const link = path.join(globalDir, 'linked');
  try { fs.symlinkSync(path.join(elsewhere, 'linked'), link, 'junction'); } catch { t.skip('no links here'); return; }
  try {
    const row = { ...ownerRow, filePath: path.join(link, 'SKILL.md'), name: 'linked' };
    assert.equal((await ask(row, taker, { takeFrom: 'owner' })).state, 'shared');
  } finally {
    fs.rmSync(link, { recursive: false, force: true });
  }
});

test('a row no backend reported and that is not the app\'s own is none, not text', async () => {
  const row = { backendId: null, owners: [], source: 'skills-directory', filePath: globalSkill, name: 'orphan', scope: 'global' };
  assert.equal((await ask(row, taker)).state, 'none');
});

test('a target\'s own note is shown as a sentence', async () => {
  const declining = { ...taker, id: 'decliner', declinesSharedResource: () => ({ reason: 'off', note: 'not with this switch off' }) };
  all.push(declining);
  try {
    const answer = await ask(ownerRow, declining, { takeFrom: 'owner' });
    assert.equal(answer.state, 'declined');
    assert.equal(answer.sentence, 'Not with this switch off');
  } finally {
    all.pop();
  }
});

// ── Real Pi descriptors as targets, against a source shaped like the stub owner ────────────────────────
for (const id of ['pi', 'pi-native']) {
  test(`${id} with "Resources from" on the owner: a global skill is shared`, async () => {
    const answer = await ask(ownerRow, real.get(id), { resourcesFrom: 'owner' });
    assert.equal(answer.state, 'shared');
  });
  // Pi takes a run's `approval` override; pi-native does not offer that option and strips it, so only its
  // saved trust decides — an untrusted project stays declined whatever the stored option says.
  test(`${id}: a project skill in an untrusted project is declined, and the approval option decides only for pi`, async () => {
    const row = { backendId: 'owner', source: 'project-skills', filePath: projectSkill, name: 'local', scope: 'project' };
    const project = tmpdir('proj');
    assert.equal((await ask(row, real.get(id), { resourcesFrom: 'owner' }, project)).state, 'declined');
    const approved = (await ask(row, real.get(id), { resourcesFrom: 'owner', approval: 'approve' }, project)).state;
    assert.equal(approved, id === 'pi' ? 'shared' : 'declined');
  });
  test(`${id}: a skill in a directory the owner does not share is none`, async () => {
    const row = { ...ownerRow, source: 'plugin-skills', filePath: pluginSkill, name: 'from-plugin' };
    assert.equal((await ask(row, real.get(id), { resourcesFrom: 'owner' })).state, 'none');
  });
}
