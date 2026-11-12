// The pure module behind "one row per CLI, a mode select, launch defaults stored once" (#761, T2).
//
// Expectations are DERIVED from the real descriptors' `configFields` (registry-driven, like
// backend-parity.test.js); the only ids written out are the two cases D11 names by field (`permissionMode`
// not shared, `restricted` shared) and the fake groups built here.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const backends = require('../src/backends');
const modes = require('../src/shared/backend-modes');

const ALL = backends.list();
const BY_ID = Object.fromEntries(ALL.map(b => [b.id, b]));
const GROUPS = modes.cliGroups(ALL);
const PAIRS = GROUPS.filter(g => g.drivers.length);

const fieldIds = b => (b.configFields || []).map(f => f.id);
const fieldOf = (b, id) => (b.configFields || []).find(f => f.id === id);

// A fake CLI with two drivers, to prove a third mode costs a descriptor and nothing else.
function fakeGroup() {
  const owner = { id: 'fx', label: 'Fx', status: 'ready', configFields: [
    { id: 'model', type: 'text', default: '' },
    { id: 'flag', type: 'toggle', default: false, description: 'owner wording' },
    { id: 'level', type: 'select', default: 'a', choices: ['a', 'b'] },
  ] };
  const a = { id: 'fx-a', label: 'Fx (A)', modeLabel: 'Alpha', status: 'ready', transcriptsOf: 'fx', configFields: [
    { id: 'model', type: 'text', default: '' },
    { id: 'flag', type: 'toggle', default: false, description: 'alpha wording' },
    { id: 'level', type: 'select', default: 'a', choices: ['a', 'b', 'c'] },
    { id: 'onlyA', type: 'toggle', default: false },
  ] };
  const b = { id: 'fx-b', label: 'Fx (B)', modeLabel: 'Beta', status: 'ready', transcriptsOf: 'fx', configFields: [
    { id: 'model', type: 'text', default: '' },
    { id: 'flag', type: 'toggle', default: false, description: 'owner wording' },
  ] };
  return { owner, a, b, list: [owner, a, b] };
}

test('grouping: every real driver folds into the owner it names; the rest stay alone', () => {
  const ready = ALL.filter(b => b.status === 'ready' && !b.isProfile);
  const drivers = ready.filter(b => b.transcriptsOf);
  assert.ok(drivers.length >= 2, 'the registry has at least the two GUI drivers');
  for (const d of drivers) {
    const g = GROUPS.find(x => x.ids.includes(d.id));
    assert.equal(g.owner.id, d.transcriptsOf, `${d.id} sits in its owner's group`);
    assert.ok(g.drivers.some(x => x.id === d.id));
    assert.equal(g.modes.find(m => m.id === d.id).label, d.modeLabel);
    assert.equal(g.modes[0].id, g.owner.id, 'owner mode first');
    assert.equal(g.modes[0].label, 'Terminal');
  }
  for (const g of GROUPS) {
    if (!g.drivers.length) assert.equal(g.ids.length, 1);
    assert.deepEqual(g.ids, g.modes.map(m => m.id));
  }
  // Every ready non-template backend lands in exactly one group.
  const seen = GROUPS.flatMap(g => g.ids);
  assert.deepEqual([...seen].sort(), ready.map(b => b.id).sort());
  assert.ok(GROUPS.length < ready.length, 'something folded');
});

test('grouping: a planned backend and a template are never grouped; a driver with a missing owner stands alone', () => {
  const g = fakeGroup();
  const planned = { id: 'pl', label: 'Planned', status: 'planned', configFields: [] };
  const plannedDriver = { id: 'pl-d', label: 'PD', modeLabel: 'X', status: 'ready', transcriptsOf: 'pl', configFields: [] };
  const template = { id: 'tpl', label: 'Tpl', status: 'ready', isProfile: true, baseId: 'fx', transcriptsOf: 'fx', configFields: [] };
  const orphan = { id: 'orph-d', label: 'Orphan', modeLabel: 'Y', status: 'ready', transcriptsOf: 'nowhere', configFields: [] };
  const groups = modes.cliGroups([...g.list, planned, plannedDriver, template, orphan]);
  const flat = groups.flatMap(x => x.ids);
  assert.ok(!flat.includes('pl'), 'planned is not grouped');
  assert.ok(!flat.includes('tpl'), 'template is not grouped');
  const alone = groups.find(x => x.ids.includes('pl-d'));
  assert.deepEqual(alone.ids, ['pl-d'], 'driver of a planned owner stands alone');
  assert.deepEqual(groups.find(x => x.ids.includes('orph-d')).ids, ['orph-d']);
  assert.deepEqual(groups.find(x => x.owner.id === 'fx').ids, ['fx', 'fx-a', 'fx-b']);
});

test('the owner cliGroups assigns equals cliOwnerOf in the registry (one answer to "which CLI")', () => {
  for (const g of GROUPS) {
    for (const id of g.ids) {
      assert.equal(backends.cliOwnerOf(BY_ID[id]).id, g.owner.id, `${id}: same owner as cliOwnerOf`);
    }
  }
});

test('shared computation: derived from configFields, with D11\'s two named cases', () => {
  assert.ok(PAIRS.length >= 2);
  for (const g of PAIRS) {
    for (const d of g.drivers) {
      const shared = modes.sharedFieldIds(g.owner, d);
      for (const id of fieldIds(g.owner)) {
        const a = fieldOf(g.owner, id);
        const b = fieldOf(d, id);
        const expected = !!b && a.type === b.type
          && JSON.stringify(a.default) === JSON.stringify(b.default)
          && JSON.stringify((a.choices || null) && [...a.choices].sort()) === JSON.stringify((b.choices || null) && [...b.choices].sort());
        assert.equal(shared.includes(id), expected, `${g.owner.id}/${d.id}: ${id}`);
      }
      for (const id of shared) assert.ok(fieldOf(d, id), `${id} is declared by the driver`);
      // A driver-only field is never shared.
      for (const id of fieldIds(d)) if (!fieldOf(g.owner, id)) assert.ok(!shared.includes(id), `${id} is driver-only`);
    }
  }
  const claudePair = PAIRS.find(g => fieldOf(g.owner, 'permissionMode') && fieldOf(g.owner, 'restricted'));
  assert.ok(claudePair, 'the pair with permissionMode and restricted');
  const shared = modes.sharedFieldIds(claudePair.owner, claudePair.drivers[0]);
  assert.ok(!shared.includes('permissionMode'), 'D11: permissionMode is not shared (narrower choices)');
  assert.ok(shared.includes('restricted'), 'D11: restricted is shared');
});

test('shared computation: owner-only fields stay owner-only, driver-only stay driver-only', () => {
  for (const g of PAIRS) {
    const d = g.drivers[0];
    const shared = new Set(modes.sharedFieldIds(g.owner, d));
    const split = modes.fieldSplit(g);
    assert.deepEqual(split.shared.map(s => s.field.id), fieldIds(g.owner).filter(id => shared.has(id)));
    assert.deepEqual(split.own[g.owner.id].map(f => f.id), fieldIds(g.owner).filter(id => !shared.has(id)));
    assert.deepEqual(split.own[d.id].map(f => f.id), fieldIds(d).filter(id => !shared.has(id)));
    for (const s of split.shared) assert.equal(s.field, fieldOf(g.owner, s.field.id), 'the owner\'s declaration');
    // Every declared field appears exactly once per id: shared, or in that id's own list.
    for (const b of [g.owner, d]) {
      const shown = [...split.shared.map(s => s.field.id).filter(id => fieldOf(b, id)), ...split.own[b.id].map(f => f.id)];
      assert.deepEqual([...shown].sort(), fieldIds(b).slice().sort(), `${b.id}: nothing lost, nothing twice`);
    }
  }
});

test('a note rides with a shared field only for a driver whose description differs', () => {
  for (const g of PAIRS) {
    const split = modes.fieldSplit(g);
    for (const s of split.shared) {
      const differing = g.drivers.filter(d => (fieldOf(d, s.field.id).description || '') !== (s.field.description || ''));
      assert.deepEqual(s.notes.map(n => n.id), differing.map(d => d.id), `${g.owner.id}: ${s.field.id}`);
      for (const n of s.notes) {
        assert.equal(n.label, g.modes.find(m => m.id === n.id).label);
        assert.equal(n.description, fieldOf(BY_ID[n.id], s.field.id).description || '');
      }
    }
  }
  const claudePair = PAIRS.find(g => fieldOf(g.owner, 'restricted'));
  const restricted = modes.fieldSplit(claudePair).shared.find(s => s.field.id === 'restricted');
  assert.ok(fieldOf(claudePair.owner, 'restricted').description !== fieldOf(claudePair.drivers[0], 'restricted').description);
  assert.equal(restricted.notes.length, 1, 'D11: restricted carries the driver\'s note');
  const fx = fakeGroup();
  const g = modes.cliGroups(fx.list)[0];
  const split = modes.fieldSplit(g);
  const flag = split.shared.find(s => s.field.id === 'flag');
  assert.deepEqual(flag.notes.map(n => n.label), ['Alpha'], 'only the driver whose wording differs');
  assert.equal(split.shared.find(s => s.field.id === 'level'), undefined, 'a field not shared with every driver is not shared in the page');
  assert.ok(split.own['fx-b'].length === 0 || !split.own['fx-b'].some(f => f.id === 'model'));
  assert.ok(!modes.sharedFieldIds(fx.owner, fx.a).includes('level'), 'different choices');
});

test('guard (R3): no requires across the shared/own boundary', () => {
  const groups = [...PAIRS, modes.cliGroups(fakeGroup().list)[0]];
  for (const g of groups) {
    const split = modes.fieldSplit(g);
    const sharedIds = new Set(split.shared.map(s => s.field.id));
    for (const b of [g.owner, ...g.drivers]) {
      for (const f of b.configFields) {
        if (!f.requires) continue;
        const isShared = sharedIds.has(f.id);
        const targetShared = sharedIds.has(f.requires);
        assert.equal(isShared, targetShared,
          `${b.id}: ${isShared ? 'shared' : 'own-only'} field "${f.id}" requires ${targetShared ? 'shared' : 'own-only'} field "${f.requires}"; the requires machinery matches by data-backend, so it would not toggle`);
      }
    }
  }
});

test('layering: owner wins on shared ids, the driver\'s own value applies where the owner has none', () => {
  const g = PAIRS[0];
  const d = g.drivers[0];
  const shared = modes.sharedFieldIds(g.owner, d);
  const own = fieldIds(d).find(id => !shared.includes(id));
  assert.ok(shared.length && own);
  const id = shared[0];
  const both = modes.launchLayer({ [g.owner.id]: { [id]: 'O' }, [d.id]: { [id]: 'D', [own]: 'own' } }, d, BY_ID);
  assert.equal(both[id], 'O', 'owner wins');
  assert.equal(both[own], 'own', 'own-only ids come from the driver');
  const driverOnly = modes.launchLayer({ [d.id]: { [id]: 'D' } }, d, BY_ID);
  assert.equal(driverOnly[id], 'D', 'unmigrated driver value still applies');
  const ownerOnly = modes.launchLayer({ [g.owner.id]: { [id]: 'O', [own]: 'leak' } }, d, BY_ID);
  assert.equal(ownerOnly[id], 'O');
  assert.ok(!(own in ownerOnly), 'the owner\'s own-only value does not reach the driver');
  // The owner itself reads its own entry, untouched by the driver's.
  const forOwner = modes.launchLayer({ [g.owner.id]: { [id]: 'O' }, [d.id]: { [id]: 'D' } }, g.owner, BY_ID);
  assert.deepEqual(forOwner, { [id]: 'O' });
});

test('layering: a field shared with only one driver is not layered from the owner, and the page shows it per mode', () => {
  const fx = fakeGroup();
  const g = modes.cliGroups(fx.list)[0];
  const byId = Object.fromEntries(fx.list.map(b => [b.id, b]));
  assert.ok(modes.sharedFieldIds(fx.owner, fx.b).includes('flag') && modes.sharedFieldIds(fx.owner, fx.a).includes('flag'));
  // 'level' differs for fx-a only; fx-b does not declare it at all, so it is shared with nobody in the group.
  assert.ok(!modes.sharedIdsOfGroup(g).has('level'));
  assert.ok(modes.fieldSplit(g).own.fx.some(f => f.id === 'level'), 'the page shows it in the owner own section');
  const r = modes.launchLayer({ fx: { level: 'b', model: 'O' }, 'fx-a': { level: 'a' } }, fx.a, byId);
  assert.equal(r.level, 'a', 'not layered from the owner');
  assert.equal(r.model, 'O', 'a group-shared field is');
  // One rule: page, layer and the exported helper agree on every real pair too.
  for (const pg of PAIRS) {
    const ids = modes.sharedIdsOfGroup(pg);
    assert.deepEqual(modes.fieldSplit(pg).shared.map(s => s.field.id), fieldIds(pg.owner).filter(id => ids.has(id)));
    for (const d of pg.drivers) {
      for (const id of ids) {
        const out = modes.launchLayer({ [pg.owner.id]: { [id]: 'O' }, [d.id]: { [id]: 'D' } }, d, BY_ID);
        assert.equal(out[id], 'O', `${d.id}: ${id}`);
      }
    }
  }
});

test('layering: false and the empty string are values; undefined and null are not set', () => {
  const g = PAIRS[0];
  const d = g.drivers[0];
  const id = modes.sharedFieldIds(g.owner, d)[0];
  for (const v of ['', false, 0]) {
    const r = modes.launchLayer({ [g.owner.id]: { [id]: v }, [d.id]: { [id]: 'D' } }, d, BY_ID);
    assert.strictEqual(r[id], v, `${JSON.stringify(v)} is a value`);
  }
  for (const v of [undefined, null]) {
    const r = modes.launchLayer({ [g.owner.id]: { [id]: v }, [d.id]: { [id]: 'D' } }, d, BY_ID);
    assert.equal(r[id], 'D', `${v} in the owner is not set`);
  }
  const r = modes.launchLayer({ [d.id]: { [id]: null } }, d, BY_ID);
  assert.ok(!(id in r), 'a null in the driver is not set either');
  assert.deepEqual(modes.launchLayer(undefined, d, BY_ID), {});
});

test('layering: a template on a driver base layers through the driver; the input is not mutated', () => {
  const g = PAIRS[0];
  const d = g.drivers[0];
  const id = modes.sharedFieldIds(g.owner, d)[0];
  const tpl = { id: 'tpl-x', label: 'T', status: 'ready', isProfile: true, baseId: d.id, configFields: [] };
  const defaults = { [g.owner.id]: { [id]: 'O' }, [d.id]: { [id]: 'D' }, 'tpl-x': { [id]: 'T' } };
  const copy = JSON.parse(JSON.stringify(defaults));
  const r = modes.launchLayer(defaults, tpl, { ...BY_ID, 'tpl-x': tpl });
  assert.equal(r[id], 'O', 'the base driver\'s layering applies');
  assert.deepEqual(defaults, copy);
  // A Map works as the lookup too.
  assert.equal(modes.launchLayer(defaults, tpl, new Map(Object.entries(BY_ID)))[id], 'O');
  // A backend with no owner reads only its own entry.
  const lone = GROUPS.find(x => !x.drivers.length).owner;
  assert.deepEqual(modes.launchLayer({ [lone.id]: { a: 1 }, other: { a: 2 } }, lone, BY_ID), { a: 1 });
});

test('choices: two modes read Terminal / <mode word> / Both', () => {
  for (const g of PAIRS.filter(x => x.modes.length === 2)) {
    const c = modes.modeChoices(g);
    assert.deepEqual(c.map(x => x.label), ['Terminal', g.modes[1].label, 'Both']);
    assert.deepEqual(c.map(x => x.ids), [[g.owner.id], [g.drivers[0].id], g.ids]);
    assert.equal(new Set(c.map(x => x.value)).size, 3, 'values are distinct');
  }
  const single = GROUPS.find(x => !x.drivers.length);
  assert.deepEqual(modes.modeChoices(single), [], 'no twin, no select');
});

test('choices: three modes read three singles + All', () => {
  const g = modes.cliGroups(fakeGroup().list)[0];
  const c = modes.modeChoices(g);
  assert.deepEqual(c.map(x => x.label), ['Terminal', 'Alpha', 'Beta', 'All']);
  assert.deepEqual(c[3].ids, ['fx', 'fx-a', 'fx-b']);
});

test('choiceFor / enabledForChoice round-trip; unrepresentable subsets are read-only; none is null', () => {
  for (const g of [...PAIRS, modes.cliGroups(fakeGroup().list)[0]]) {
    for (const c of modes.modeChoices(g)) {
      const map = modes.enabledForChoice(g, c.value);
      assert.deepEqual(Object.keys(map), g.ids);
      assert.deepEqual(g.ids.filter(id => map[id]), c.ids);
      assert.equal(modes.choiceFor(g, map).value, c.value);
      assert.ok(!modes.choiceFor(g, map).readOnly);
    }
    assert.equal(modes.choiceFor(g, {}), null);
    assert.equal(modes.choiceFor(g, Object.fromEntries(g.ids.map(id => [id, false]))), null);
    assert.ok(g.ids.every(id => modes.enabledForChoice(g, '')[id] === false), 'empty value is all off');
    assert.ok(g.ids.every(id => modes.enabledForChoice(g, 'nonsense')[id] === false));
  }
  const g = modes.cliGroups(fakeGroup().list)[0];
  const two = modes.choiceFor(g, { fx: true, 'fx-b': true });
  assert.equal(two.readOnly, true);
  assert.equal(two.label, 'Terminal + Beta');
  assert.deepEqual(two.ids, ['fx', 'fx-b']);
  // A lone backend: enabled -> its single entry, disabled -> null.
  const lone = modes.cliGroups([{ id: 'solo', label: 'Solo', status: 'ready', configFields: [] }])[0];
  assert.equal(modes.choiceFor(lone, { solo: true }).label, 'Terminal');
  assert.equal(modes.choiceFor(lone, { solo: false }), null);
});

test('targetAfterModeChange: follows to the enabled twin, otherwise stays', () => {
  const g = PAIRS[0];
  const [o, d] = [g.owner.id, g.drivers[0].id];
  assert.equal(modes.targetAfterModeChange(d, g, { [o]: true, [d]: false }), o, 'target disabled, twin enabled');
  assert.equal(modes.targetAfterModeChange(o, g, { [o]: false, [d]: true }), d);
  assert.equal(modes.targetAfterModeChange(d, g, { [o]: true, [d]: true }), d, 'both enabled');
  assert.equal(modes.targetAfterModeChange(d, g, { [o]: false, [d]: false }), d, 'none enabled');
  assert.equal(modes.targetAfterModeChange('elsewhere', g, { [o]: false, [d]: true }), 'elsewhere', 'outside the group');
  const three = modes.cliGroups(fakeGroup().list)[0];
  assert.equal(modes.targetAfterModeChange('fx-a', three, { fx: false, 'fx-a': false, 'fx-b': true }), 'fx-b');
});

test('the module is pure data work: no backend id, no fs, no DOM', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { stripComments } = require('./helpers/strip-comments');
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'backend-modes.js'), 'utf8'));
  for (const b of ALL) assert.ok(!new RegExp(`['"\`]${b.id}['"\`]`).test(src), `no backend id: ${b.id}`);
  assert.ok(!/require\(|document\.|window\./.test(src));
});

test('loaded as a classic script (no module), the file adds exactly one global: backendModes', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'backend-modes.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  const before = new Set(vm.runInContext('Object.getOwnPropertyNames(globalThis)', sandbox));
  vm.runInContext(code, sandbox);
  const added = vm.runInContext('Object.getOwnPropertyNames(globalThis)', sandbox).filter(k => !before.has(k));
  assert.deepEqual([...added], ['backendModes']);
  assert.deepEqual(Object.keys(sandbox.backendModes).sort(), Object.keys(modes).sort());
  // Top-level let/const would not show as properties, so also prove none is visible by name.
  assert.equal(vm.runInContext("typeof isSet + typeof fieldsOf + typeof OWNER_MODE_LABEL", sandbox), 'undefinedundefinedundefined');
});
