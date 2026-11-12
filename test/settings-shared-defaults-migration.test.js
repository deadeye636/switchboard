'use strict';
// #761 T4: launch defaults a CLI's modes store once move under the owner, in `global` and every `project:` blob,
// at startup and at the write door (import, a stale form). Nothing is dropped: a conflict keeps the driver's value
// under `backendDefaultsReplaced`.
const test = require('node:test');
const assert = require('node:assert/strict');

const backends = require('../src/backends');
const settings = require('../src/app/settings');
const { cliGroups, sharedIdsOfGroup } = require('../src/shared/backend-modes');
const claude = require('../src/backends/claude');
const claudeNative = require('../src/backends/claude-native');
const pi = require('../src/backends/pi');
const piNative = require('../src/backends/pi-native');

const MODEL = { id: 'model', type: 'text', default: '' };
const FLAG = { id: 'flag', type: 'toggle', default: false };
const OWNER = { id: 'ow', label: 'Owner', status: 'ready', configFields: [MODEL, FLAG] };
const DRIVER = { id: 'ow-gui', label: 'Owner GUI', status: 'ready', transcriptsOf: 'ow', modeLabel: 'GUI',
  configFields: [MODEL, FLAG, { id: 'own', type: 'toggle', default: false }] };
const TEMPLATE = { id: 'profile-x', label: 'T', status: 'ready', isProfile: true, configFields: [MODEL] };

const realList = backends.list;
function useRegistry(list) { backends.list = () => list; }
test.after(() => { backends.list = realList; });

/** A settings store that is an object; records every write and every log line. */
function makeStore(initial) {
  const store = { ...initial };
  const writes = [];
  const infos = [];
  const warns = [];
  const debugs = [];
  settings.init({
    db: {
      getSetting: key => store[key],
      setSetting: (key, value) => { writes.push(key); store[key] = value; },
      listSettings: prefix => Object.keys(store).filter(k => k.startsWith(prefix)).map(key => ({ key, value: store[key] })),
    },
    log: { info: m => infos.push(m), warn: (...a) => warns.push(a.join(' ')), error() {}, debug: m => debugs.push(m) },
    notifyRendererProjectsChanged() {},
  });
  return { store, writes, infos, warns, debugs };
}

const COMBOS = {
  ow: { model: 'owner-model' },
  'ow-gui': { model: 'driver-model', flag: false, own: true },
};

test('owner without a value: the driver value moves, falsy values included; own-only field stays', () => {
  useRegistry([OWNER, DRIVER]);
  makeStore({});
  const { value, changed } = settings.moveSharedLaunchDefaults({
    backendDefaults: { 'ow-gui': { model: '', flag: false, own: true } },
  });
  assert.deepEqual(value.backendDefaults, { ow: { model: '', flag: false }, 'ow-gui': { own: true } });
  assert.equal(changed.length, 2);
  assert.equal(value.backendDefaultsReplaced, undefined);
});

test('owner has an equal value: the driver copy is dropped, and an emptied entry is removed', () => {
  useRegistry([OWNER, DRIVER]);
  makeStore({});
  const { value } = settings.moveSharedLaunchDefaults({
    backendDefaults: { ow: { model: 'same' }, 'ow-gui': { model: 'same' } },
  });
  assert.deepEqual(value.backendDefaults, { ow: { model: 'same' } });
});

test('owner has a different value: owner wins, driver value kept aside, one note with both values', () => {
  useRegistry([OWNER, DRIVER]);
  makeStore({});
  const { value, changed, detail } = settings.moveSharedLaunchDefaults({
    backendDefaults: COMBOS,
    backendDefaultsReplaced: { other: { x: 1 } },
  });
  assert.equal(value.backendDefaults.ow.model, 'owner-model');
  assert.deepEqual(value.backendDefaults['ow-gui'], { own: true });
  assert.deepEqual(value.backendDefaultsReplaced, { other: { x: 1 }, 'ow-gui': { model: 'driver-model' } });
  // flag: owner has none, driver false -> moves
  assert.equal(value.backendDefaults.ow.flag, false);
  const conflict = changed.filter(n => n.includes('backendDefaultsReplaced'));
  assert.equal(conflict.length, 1);
  assert.match(conflict[0], /ow-gui\.model/);
  assert.doesNotMatch(changed.join('|'), /owner-model|driver-model/, 'the notes carry no values');
  assert.ok(detail.some(d => d.includes('owner-model') && d.includes('driver-model')), 'the debug detail does');
});

test('a value set aside earlier is never overwritten by a later conflicting one', () => {
  useRegistry([OWNER, DRIVER]);
  makeStore({});
  const { value, changed } = settings.moveSharedLaunchDefaults({
    backendDefaults: { ow: { model: 'o' }, 'ow-gui': { model: 'second' } },
    backendDefaultsReplaced: { 'ow-gui': { model: 'first' } },
  });
  assert.deepEqual(value.backendDefaultsReplaced, { 'ow-gui': { model: 'first' } });
  assert.equal(value.backendDefaults['ow-gui'], undefined, 'the driver copy is still dropped');
  assert.match(changed[0], /dropped/);
  assert.doesNotMatch(changed[0], /second|first/);
});

test('migrate: global and every project blob in one run, one info line per value naming the scope', () => {
  useRegistry([OWNER, DRIVER]);
  const h = makeStore({
    global: { backendDefaults: COMBOS },
    'project:/a': { backendDefaults: { 'ow-gui': { model: 'p' } } },
    'project:/b': { backendDefaults: { ow: { model: 'q' }, 'ow-gui': { model: 'q' } } },
    'project:/c': { backendDefaults: { 'ow-gui': { own: true } } },
  });
  settings.migrateSharedLaunchDefaults();
  assert.deepEqual(h.store.global.backendDefaults.ow.model, 'owner-model');
  assert.deepEqual(h.store['project:/a'].backendDefaults, { ow: { model: 'p' } });
  assert.deepEqual(h.store['project:/b'].backendDefaults, { ow: { model: 'q' } });
  assert.deepEqual(h.store['project:/c'].backendDefaults, { 'ow-gui': { own: true } }, 'nothing shared: untouched');
  assert.deepEqual(h.writes.sort(), ['global', 'project:/a', 'project:/b']);
  const line = h.infos.find(l => l.includes('backendDefaultsReplaced'));
  assert.ok(line, 'a conflict logs');
  assert.match(line, /global/);
  assert.match(line, /ow-gui\.model/);
  assert.doesNotMatch(h.infos.join('|'), /owner-model|driver-model/, 'no value at info');
  assert.ok(h.debugs.some(l => l.includes('owner-model') && l.includes('driver-model')), 'values at debug');
  assert.ok(h.infos.some(l => l.includes('project:/a')));
});

test('a second pass finds nothing and writes nothing', () => {
  useRegistry([OWNER, DRIVER]);
  const h = makeStore({
    global: { backendDefaults: COMBOS },
    'project:/a': { backendDefaults: { 'ow-gui': { model: 'p' } } },
  });
  settings.migrateSharedLaunchDefaults();
  h.writes.length = 0;
  h.infos.length = 0;
  settings.migrateSharedLaunchDefaults();
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.infos, []);
});

test('templates, unknown ids and non-object blobs are left exactly as they are', () => {
  useRegistry([OWNER, DRIVER, TEMPLATE]);
  const blob = { backendDefaults: { 'profile-x': { model: 'tpl' }, ghost: { model: 'g' }, 'ow-gui': 'not an object' } };
  const r = settings.moveSharedLaunchDefaults(blob);
  assert.equal(r.value, blob);
  assert.deepEqual(r.changed, []);
  for (const odd of [null, undefined, 'text', 7, [], { backendDefaults: 'x' }, { backendDefaults: [] }]) {
    assert.equal(settings.moveSharedLaunchDefaults(odd).value, odd);
  }
  // a driver whose owner is not in the registry stands alone: nothing to move to
  useRegistry([DRIVER]);
  const lone = { backendDefaults: { 'ow-gui': { model: 'x' } } };
  assert.equal(settings.moveSharedLaunchDefaults(lone).value, lone);
});

test('a corrupt blob or a failing write does not stop the other scopes', () => {
  useRegistry([OWNER, DRIVER]);
  const h = makeStore({
    global: 'corrupt',
    'project:/a': { backendDefaults: { 'ow-gui': { model: 'a' } } },
    'project:/b': { backendDefaults: { 'ow-gui': { model: 'b' } } },
  });
  const set = h.store;
  const original = settings;
  // make the first project write throw
  let thrown = false;
  settings.init({
    db: {
      getSetting: k => set[k],
      setSetting: (k, v) => { if (k === 'project:/a' && !thrown) { thrown = true; throw new Error('disk'); } set[k] = v; },
      listSettings: p => Object.keys(set).filter(k => k.startsWith(p)).map(key => ({ key, value: set[key] })),
    },
    log: { info() {}, warn: (...a) => h.warns.push(a.join(' ')), error() {} },
  });
  original.migrateSharedLaunchDefaults();
  assert.equal(set.global, 'corrupt');
  assert.deepEqual(set['project:/b'].backendDefaults, { ow: { model: 'b' } });
  assert.ok(h.warns.some(w => w.includes('project:/a')));
});

test('the write door moves an old-shaped blob (import, stale form)', () => {
  useRegistry([OWNER, DRIVER]);
  const h = makeStore({});
  settings.persistSettingsBlob('project:/x', { backendDefaults: { ow: { model: 'o' }, 'ow-gui': { model: 'd', own: true } } });
  assert.deepEqual(h.store['project:/x'].backendDefaults, { ow: { model: 'o' }, 'ow-gui': { own: true } });
  assert.deepEqual(h.store['project:/x'].backendDefaultsReplaced, { 'ow-gui': { model: 'd' } });
});

test('the Claude pair and the Pi pair: shared ids move, own-only ids stay', () => {
  const list = [claude, claudeNative, pi, piNative].map(b => ({ ...b, status: 'ready' }));
  useRegistry(list);
  makeStore({});
  const groups = cliGroups(list);
  const g = id => groups.find(x => x.owner.id === id);
  const claudeShared = sharedIdsOfGroup(g('claude'));
  const piShared = sharedIdsOfGroup(g('pi'));
  assert.ok(claudeShared.has('model') && !claudeShared.has('permissionMode'), 'D11: permissionMode is per mode');
  assert.ok(piShared.has('model') && !piShared.has('approvalGate'));

  const { value } = settings.moveSharedLaunchDefaults({
    backendDefaults: {
      'claude-native': { model: 'm1', permissionMode: 'plan' },
      'pi-native': { model: 'm2', approvalGate: false, approvalRules: 'x' },
    },
  });
  assert.equal(value.backendDefaults.claude.model, 'm1');
  assert.deepEqual(value.backendDefaults['claude-native'], { permissionMode: 'plan' });
  assert.equal(value.backendDefaults.pi.model, 'm2');
  assert.deepEqual(value.backendDefaults['pi-native'], { approvalGate: false, approvalRules: 'x' });
});

test('no value stops applying: a driver launch reads the same options before and after (no conflict)', () => {
  useRegistry([OWNER, DRIVER]);
  const old = {
    global: { backendDefaults: { 'ow-gui': { model: 'g', own: true }, ow: { flag: true } } },
    'project:/x': { backendDefaults: { 'ow-gui': { flag: false } } },
  };
  const h = makeStore(JSON.parse(JSON.stringify(old)));
  const before = settings.effectiveSettings('/x').launchDefaults;
  settings.migrateSharedLaunchDefaults();
  const after = settings.effectiveSettings('/x').launchDefaults;
  assert.deepEqual(after['ow-gui'], before['ow-gui']);
  assert.equal(after['ow-gui'].model, 'g');
  // The owner side DOES change: the project's driver value was stored once under the project's owner entry, so
  // the owner's own launch in that project now reads it too (D4). Documented here for the release note (T10).
  assert.equal(before.ow.flag, true);
  assert.equal(after.ow.flag, false);
  assert.ok(h.writes.length > 0);
});

test('the import door: mergeImport output through persistSettingsBlob ends moved', () => {
  useRegistry([OWNER, DRIVER]);
  const h = makeStore({ global: { sidebarWidth: 300 } });
  const settingsTransfer = require('../src/app/settings-transfer');
  const merged = settingsTransfer.mergeImport(h.store.global, { backendDefaults: { 'ow-gui': { model: 'imp', own: true } } });
  settings.persistSettingsBlob('project:/imp', merged);
  const out = h.store['project:/imp'];
  assert.equal(out.sidebarWidth, 300);
  assert.deepEqual(out.backendDefaults, { ow: { model: 'imp' }, 'ow-gui': { own: true } });
});

test('merge-setting with an unchanged blob writes it as is and logs nothing', () => {
  useRegistry([OWNER, DRIVER]);
  const h = makeStore({ global: { backendDefaults: { ow: { model: 'o' }, 'ow-gui': { own: true } } } });
  const handlers = {};
  settings.registerIpc({ handle: (name, fn) => { handlers[name] = fn; }, on() {} });
  handlers['merge-setting']({}, 'global', { sidebarWidth: 411 });
  assert.equal(h.store.global.sidebarWidth, 411);
  assert.deepEqual(h.store.global.backendDefaults, { ow: { model: 'o' }, 'ow-gui': { own: true } });
  assert.deepEqual(h.infos, []);
  assert.deepEqual(h.debugs, []);
  // and a blob without defaults never asks the registry
  let asked = 0;
  backends.list = () => { asked++; return [OWNER, DRIVER]; };
  handlers['merge-setting']({}, 'project:/z', { sidebarWidth: 1 });
  assert.equal(asked, 0);
  // nor does a partial that leaves `backendDefaults` alone, though the stored blob has some: the stored blob
  // already went through the move, and this handler fires on every drag frame
  handlers['merge-setting']({}, 'global', { sidebarWidth: 412 });
  assert.equal(asked, 0);
  // a partial that writes `backendDefaults` still goes through the move
  handlers['merge-setting']({}, 'global', { backendDefaults: { 'ow-gui': { model: 'late' } } });
  assert.equal(asked, 1);
  assert.deepEqual(h.store.global.backendDefaults, { ow: { model: 'late' } });
});

test('migrate asks the registry once for all scopes', () => {
  let asked = 0;
  backends.list = () => { asked++; return [OWNER, DRIVER]; };
  makeStore({
    global: { backendDefaults: COMBOS },
    'project:/a': { backendDefaults: { 'ow-gui': { model: 'p' } } },
    'project:/b': {},
  });
  settings.migrateSharedLaunchDefaults();
  assert.equal(asked, 1);
});
