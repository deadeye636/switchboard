const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createGroupsState,
  addGroup,
  renameGroup,
  recolorGroup,
  removeGroup,
  assignSession,
  reorderGroups,
  getGroupForSession,
  groupSessions,
  serialize,
  deserialize,
} = require('../public/groups-model');

function sessionList(...ids) {
  return ids.map(id => ({ sessionId: id }));
}

test('createGroupsState returns an empty serializable state', () => {
  const state = createGroupsState();
  assert.deepEqual(state, { groups: [], assignments: {} });
});

test('addGroup creates groups with unique ids and incrementing order', () => {
  const state = createGroupsState();
  const { group: a } = addGroup(state, { name: 'Checkout', color: '#3ecf5a' });
  const { group: b } = addGroup(state, { name: 'Search' });

  assert.equal(a.name, 'Checkout');
  assert.equal(a.color, '#3ecf5a');
  assert.equal(a.order, 0);
  assert.equal(b.order, 1);
  assert.notEqual(a.id, b.id);
  assert.equal(state.groups.length, 2);
});

test('addGroup falls back to a default name and color', () => {
  const state = createGroupsState();
  const { group } = addGroup(state, {});
  assert.ok(group.name.length > 0);
  assert.ok(/^#/.test(group.color));
});

test('renameGroup and recolorGroup mutate the target group', () => {
  const state = createGroupsState();
  const { group } = addGroup(state, { name: 'Old' });
  renameGroup(state, group.id, 'New Name');
  recolorGroup(state, group.id, '#e05070');
  const updated = state.groups.find(g => g.id === group.id);
  assert.equal(updated.name, 'New Name');
  assert.equal(updated.color, '#e05070');
});

test('renameGroup ignores blank names', () => {
  const state = createGroupsState();
  const { group } = addGroup(state, { name: 'Keep' });
  renameGroup(state, group.id, '   ');
  assert.equal(state.groups[0].name, 'Keep');
});

test('removeGroup deletes the group and clears its assignments', () => {
  const state = createGroupsState();
  const { group } = addGroup(state, { name: 'Temp' });
  assignSession(state, 's1', group.id);
  assignSession(state, 's2', group.id);
  removeGroup(state, group.id);
  assert.equal(state.groups.length, 0);
  assert.deepEqual(state.assignments, {});
});

test('assignSession assigns and unassigns a session', () => {
  const state = createGroupsState();
  const { group } = addGroup(state, { name: 'A' });
  assignSession(state, 's1', group.id);
  assert.equal(getGroupForSession(state, 's1').id, group.id);

  assignSession(state, 's1', null);
  assert.equal(getGroupForSession(state, 's1'), null);
  assert.equal(state.assignments.s1, undefined);
});

test('assignSession enforces one group per session', () => {
  const state = createGroupsState();
  const { group: a } = addGroup(state, { name: 'A' });
  const { group: b } = addGroup(state, { name: 'B' });

  assignSession(state, 's1', a.id);
  assignSession(state, 's1', b.id);

  assert.equal(state.assignments.s1, b.id);
  assert.equal(getGroupForSession(state, 's1').id, b.id);
});

test('assignSession to an unknown group unassigns the session', () => {
  const state = createGroupsState();
  const { group } = addGroup(state, { name: 'A' });
  assignSession(state, 's1', group.id);
  assignSession(state, 's1', 'does-not-exist');
  assert.equal(getGroupForSession(state, 's1'), null);
});

test('groupSessions partitions sessions and preserves input order', () => {
  const state = createGroupsState();
  const { group: a } = addGroup(state, { name: 'A' });
  const { group: b } = addGroup(state, { name: 'B' });
  assignSession(state, 's1', a.id);
  assignSession(state, 's3', a.id);
  assignSession(state, 's2', b.id);

  const sessions = sessionList('s1', 's2', 's3', 's4');
  const { grouped, ungrouped } = groupSessions(state, sessions);

  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].group.id, a.id);
  assert.deepEqual(grouped[0].sessions.map(s => s.sessionId), ['s1', 's3']);
  assert.equal(grouped[1].group.id, b.id);
  assert.deepEqual(grouped[1].sessions.map(s => s.sessionId), ['s2']);
  assert.deepEqual(ungrouped.map(s => s.sessionId), ['s4']);
});

test('groupSessions omits empty groups and orders by group.order', () => {
  const state = createGroupsState();
  const { group: a } = addGroup(state, { name: 'A' });
  const { group: b } = addGroup(state, { name: 'B' });
  const { group: c } = addGroup(state, { name: 'C' });
  assignSession(state, 's1', b.id);
  assignSession(state, 's2', a.id);

  // c has no sessions, so it should be omitted.
  reorderGroups(state, [b.id, a.id, c.id]);

  const { grouped } = groupSessions(state, sessionList('s1', 's2'));
  assert.deepEqual(grouped.map(entry => entry.group.id), [b.id, a.id]);
});

test('reorderGroups updates order and sorts groups', () => {
  const state = createGroupsState();
  const { group: a } = addGroup(state, { name: 'A' });
  const { group: b } = addGroup(state, { name: 'B' });
  const { group: c } = addGroup(state, { name: 'C' });

  reorderGroups(state, [c.id, a.id, b.id]);

  assert.deepEqual(state.groups.map(g => g.id), [c.id, a.id, b.id]);
  assert.equal(state.groups.find(g => g.id === c.id).order, 0);
  assert.equal(state.groups.find(g => g.id === b.id).order, 2);
});

test('serialize/deserialize round-trips state', () => {
  const state = createGroupsState();
  const { group } = addGroup(state, { name: 'Checkout', color: '#3ecf5a' });
  assignSession(state, 's1', group.id);

  const restored = deserialize(serialize(state));
  assert.deepEqual(restored.groups, state.groups);
  assert.deepEqual(restored.assignments, state.assignments);
});

test('deserialize tolerates a missing blob', () => {
  assert.deepEqual(deserialize(undefined), { groups: [], assignments: {} });
  assert.deepEqual(deserialize(null), { groups: [], assignments: {} });
});

test('deserialize tolerates garbage and drops dangling assignments', () => {
  assert.deepEqual(deserialize('nonsense'), { groups: [], assignments: {} });
  assert.deepEqual(deserialize({ groups: 'bad' }), { groups: [], assignments: {} });

  const messy = {
    groups: [
      { id: 'g1', name: 'Keep', color: '#fff', order: 0 },
      { id: 'g1', name: 'Duplicate', color: '#000', order: 1 },
      { name: 'No id' },
      null,
    ],
    assignments: { s1: 'g1', s2: 'ghost', s3: 42 },
  };
  const restored = deserialize(messy);
  assert.equal(restored.groups.length, 1);
  assert.equal(restored.groups[0].id, 'g1');
  assert.deepEqual(restored.assignments, { s1: 'g1' });
});

test('serialize produces a detached copy', () => {
  const state = createGroupsState();
  const { group } = addGroup(state, { name: 'A' });
  const blob = serialize(state);
  blob.groups[0].name = 'Mutated';
  blob.assignments.s1 = group.id;
  assert.equal(state.groups[0].name, 'A');
  assert.equal(state.assignments.s1, undefined);
});
