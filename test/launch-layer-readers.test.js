'use strict';
// #761 T3: every reader of a launch's stored options goes through `launchLayer`, per scope, with the FULL
// descriptor list. A driver gets the shared fields from its owner's entry even when the owner is switched off.
// The renderer reader (`storedDefaultsFor`) is covered in settings-cascade.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const spawn = require('../src/app/terminal/spawn');
const skills = require('../src/app/skills');
const skillDelivery = require('../src/app/skill-delivery');
const { createContextWindowResolver } = require('../src/index/context-window');

const MODEL = { id: 'model', type: 'text', default: '' };
const OWNER = { id: 'ow', label: 'Owner', status: 'ready', enabled: true, configFields: [MODEL] };
const DRIVER = { id: 'ow-gui', label: 'Owner GUI', status: 'ready', enabled: true, transcriptsOf: 'ow', modeLabel: 'GUI',
  configFields: [MODEL, { id: 'approvalGate', type: 'toggle', default: false }] };
const OFF_OWNER = { ...OWNER, enabled: false };

function globalAndProject(global, project) {
  return (key) => (key === 'global' ? { backendDefaults: global } : (key.startsWith('project:') ? { backendDefaults: project } : {}));
}

test('spawnOptionsFor layers each scope: owner value for a shared field, the driver\'s own field from its entry', () => {
  spawn.init({
    getSetting: globalAndProject({ ow: { model: 'g-owner' }, 'ow-gui': { approvalGate: true } }, { ow: { model: 'p-owner' } }),
    backends: { list: () => [OFF_OWNER, DRIVER] },
  });
  const o = spawn.spawnOptionsFor(DRIVER, '/proj', { extra: 1 });
  assert.equal(o.model, 'p-owner', 'project beats global, and the owner (switched off) still reaches the driver');
  assert.equal(o.approvalGate, true);
  assert.equal(o.extra, 1);
});

test('spawnOptionsFor: a driver value alone (unmigrated) still applies, and the owner needs no project', () => {
  spawn.init({
    getSetting: globalAndProject({ 'ow-gui': { model: 'mine' } }, {}),
    backends: { list: () => [OWNER, DRIVER] },
  });
  assert.equal(spawn.spawnOptionsFor(DRIVER, null, {}).model, 'mine');
  assert.equal(spawn.spawnOptionsFor(OWNER, null, {}).model, undefined);
});

test('launchOptionsFor reads the driver\'s shared field from the owner, per scope', () => {
  const get = globalAndProject({ ow: { model: 'g-owner' } }, { 'ow-gui': { approvalGate: true } });
  const resolver = createContextWindowResolver(get, { listBackends: () => [OFF_OWNER, DRIVER] });
  const o = resolver.launchOptionsFor({ projectPath: '/proj' }, DRIVER, DRIVER.id);
  assert.equal(o.model, 'g-owner');
  assert.equal(o.approvalGate, true);
});

test('launchOptionsFor without a list degrades to the backend\'s own entry', () => {
  const resolver = createContextWindowResolver(globalAndProject({ 'ow-gui': { model: 'mine' } }, {}));
  assert.equal(resolver.launchOptionsFor({ projectPath: '/proj' }, DRIVER, DRIVER.id).model, 'mine');
});

test('getSkillDetail hands each target its layered options', async () => {
  const seen = {};
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-layer-'));
  fs.mkdirSync(path.join(dataDir, 'skills', 'house-style'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'skills', 'house-style', 'SKILL.md'), ['---', 'name: house-style', 'description: d', '---', 'body', ''].join('\n'));
  const original = skillDelivery.deliveryFor;
  skillDelivery.deliveryFor = async ({ target, options }) => { seen[target.id] = options; return { state: 'none', sentence: '', invocation: null }; };
  try {
    skills.init({
      backends: {
        list: () => [OFF_OWNER, DRIVER].map(b => ({ id: b.id, isProfile: false, status: 'ready', enabled: true, transcriptsOf: b.transcriptsOf })),
        get: (id) => [OWNER, DRIVER].find(b => b.id === id) || null,
        cliOwnerOf: (b) => b,
      },
      log: { warn() {}, error() {}, info() {} },
      dataDir,
      effectiveSettings: () => ({ backendDefaults: { ow: { model: 'm1' }, 'ow-gui': { approvalGate: true } } }),
    });
    const row = skills.getSkillInventory({}).skills.find(r => r.name === 'house-style');
    assert.ok(row, 'the own skill is listed');
    await skills.getSkillDetail({ id: row.id });
    assert.equal(seen['ow-gui'].model, 'm1');
    assert.equal(seen['ow-gui'].approvalGate, true);
    assert.equal(seen.ow.model, 'm1');
  } finally { skillDelivery.deliveryFor = original; }
});

// --- mixed scopes: main layers each scope on its own, every reader agrees ---------------------------

const backends = require('../src/backends');
const settings = require('../src/app/settings');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function registerPair(extra = []) {
  backends._resetForTests();
  backends.init({ getGlobalSettings: () => ({ backendEnabled: { ow: true, 'ow-gui': true } }) });
  backends.register({ id: 'ow', label: 'Owner', configFields: [MODEL], availability: () => ({ status: 'ready' }) });
  backends.register({ id: 'ow-gui', label: 'Owner GUI', transcriptsOf: 'ow', modeLabel: 'GUI', configFields: [MODEL, { id: 'approvalGate', type: 'toggle', default: false }] });
  for (const d of extra) backends.register(d);
}

function effectiveOf(globalDefaults, projectDefaults) {
  const blobs = { global: { backendDefaults: globalDefaults }, 'project:/proj': { backendDefaults: projectDefaults } };
  settings.init({ db: { getSetting: (k) => blobs[k] }, log: { info() {}, warn() {}, error() {} } });
  return settings.effectiveSettings('/proj');
}

test('effectiveSettings.launchDefaults: a project value under the driver beats a global value under the owner', () => {
  registerPair();
  const eff = effectiveOf({ ow: { model: 'g' } }, { 'ow-gui': { model: 'p' } });
  assert.equal(eff.launchDefaults['ow-gui'].model, 'p');
  assert.equal(eff.launchDefaults.ow.model, 'g');
  assert.equal(eff.backendDefaults['ow-gui'].model, 'p', 'backendDefaults stays as it was');
  assert.deepEqual(JSON.parse(JSON.stringify(eff)).launchDefaults, eff.launchDefaults, 'it crosses serialisation');
});

function rendererStored(eff, backend) {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const ctxVm = dom.getInternalVMContext();
  dom.window._backendsById = { ow: OWNER, 'ow-gui': DRIVER };
  for (const f of ['src/shared/backend-modes.js', 'src/renderer/dialogs/dialogs.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctxVm, { filename: f });
  }
  return dom.window.storedDefaultsFor(eff, backend);
}

test('mixed scopes: storedDefaultsFor, getSkillDetail and spawnOptionsFor give the same answer', async () => {
  registerPair();
  const g = { ow: { model: 'g' } };
  const p = { 'ow-gui': { model: 'p' } };
  const eff = effectiveOf(g, p);
  assert.equal(rendererStored(eff, DRIVER).model, 'p');

  spawn.init({ getSetting: globalAndProject(g, p), backends: { list: () => [OWNER, DRIVER] } });
  assert.equal(spawn.spawnOptionsFor(DRIVER, '/proj', {}).model, 'p');

  const seen = {};
  const original = skillDelivery.deliveryFor;
  skillDelivery.deliveryFor = async ({ target, options }) => { seen[target.id] = options; return { state: 'none', sentence: '', invocation: null }; };
  try {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-layer-'));
    fs.mkdirSync(path.join(dataDir, 'skills', 'house-style'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'skills', 'house-style', 'SKILL.md'), ['---', 'name: house-style', 'description: d', '---', 'body', ''].join('\n'));
    skills.init({
      backends: {
        list: () => [OWNER, DRIVER].map(b => ({ id: b.id, isProfile: false, status: 'ready', enabled: true, transcriptsOf: b.transcriptsOf })),
        get: (id) => [OWNER, DRIVER].find(b => b.id === id) || null,
        cliOwnerOf: (b) => b,
      },
      log: { warn() {}, error() {}, info() {} },
      dataDir,
      effectiveSettings: () => eff,
    });
    const row = skills.getSkillInventory({}).skills.find(r => r.name === 'house-style');
    await skills.getSkillDetail({ id: row.id });
    assert.equal(seen['ow-gui'].model, 'p');
  } finally { skillDelivery.deliveryFor = original; }
});

test('spawnOptionsFor: a template whose base is a driver reads the driver\'s layers', () => {
  const tpl = { id: 'tpl', label: 'T', isProfile: true, baseId: 'ow-gui', configFields: [] };
  spawn.init({
    getSetting: globalAndProject({ ow: { model: 'g' } }, { 'ow-gui': { approvalGate: true } }),
    backends: { list: () => [OWNER, DRIVER, tpl] },
  });
  const o = spawn.spawnOptionsFor(tpl, '/proj', {});
  assert.equal(o.model, 'g');
  assert.equal(o.approvalGate, true);
});
