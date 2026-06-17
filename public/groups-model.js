(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Default palette for new groups (used by the renderer's "New group" UI).
  const GROUP_COLORS = [
    '#8088ff',
    '#3ecf5a',
    '#f0a050',
    '#4fc3f7',
    '#e05070',
    '#c0a0ff',
    '#e0c050',
    '#50c0a0',
  ];

  function createGroupsState() {
    return { groups: [], assignments: {} };
  }

  function nextGroupId(groups) {
    let max = 0;
    for (const group of groups) {
      const match = /^g(\d+)$/.exec(group.id || '');
      if (match) max = Math.max(max, Number(match[1]));
    }
    return 'g' + (max + 1);
  }

  function findGroup(state, id) {
    return state.groups.find(group => group.id === id) || null;
  }

  function normalizeColor(color) {
    return typeof color === 'string' && color.trim() ? color.trim() : GROUP_COLORS[0];
  }

  function normalizeName(name) {
    return typeof name === 'string' ? name.trim() : '';
  }

  function addGroup(state, { name, color } = {}) {
    const order = state.groups.reduce((max, group) => Math.max(max, group.order ?? 0), -1) + 1;
    const group = {
      id: nextGroupId(state.groups),
      name: normalizeName(name) || `Group ${state.groups.length + 1}`,
      color: normalizeColor(color),
      order,
    };
    state.groups.push(group);
    return { state, group };
  }

  function renameGroup(state, id, name) {
    const group = findGroup(state, id);
    if (group) group.name = normalizeName(name) || group.name;
    return state;
  }

  function recolorGroup(state, id, color) {
    const group = findGroup(state, id);
    if (group) group.color = normalizeColor(color);
    return state;
  }

  function removeGroup(state, id) {
    state.groups = state.groups.filter(group => group.id !== id);
    for (const sessionId of Object.keys(state.assignments)) {
      if (state.assignments[sessionId] === id) delete state.assignments[sessionId];
    }
    return state;
  }

  // Assign a session to a group (one group per session). Passing null/unknown
  // group id unassigns the session, returning it to the ungrouped pool.
  function assignSession(state, sessionId, groupId) {
    if (!sessionId) return state;
    if (groupId && findGroup(state, groupId)) {
      state.assignments[sessionId] = groupId;
    } else {
      delete state.assignments[sessionId];
    }
    return state;
  }

  function reorderGroups(state, orderedIds) {
    const orderIndex = new Map(orderedIds.map((id, index) => [id, index]));
    for (const group of state.groups) {
      if (orderIndex.has(group.id)) group.order = orderIndex.get(group.id);
    }
    state.groups.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return state;
  }

  function getGroupForSession(state, sessionId) {
    const groupId = state.assignments[sessionId];
    return groupId ? findGroup(state, groupId) : null;
  }

  // Partition `sessions` into ordered group buckets + ungrouped, preserving the
  // input order within each bucket. Only groups with at least one matching
  // session are returned; groups are ordered by `group.order`.
  function groupSessions(state, sessions) {
    const orderedGroups = [...state.groups].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const buckets = new Map(orderedGroups.map(group => [group.id, []]));
    const ungrouped = [];

    for (const session of sessions) {
      const groupId = state.assignments[session.sessionId];
      if (groupId && buckets.has(groupId)) {
        buckets.get(groupId).push(session);
      } else {
        ungrouped.push(session);
      }
    }

    const grouped = [];
    for (const group of orderedGroups) {
      const groupSessionsList = buckets.get(group.id);
      if (groupSessionsList.length > 0) grouped.push({ group, sessions: groupSessionsList });
    }

    return { grouped, ungrouped };
  }

  function serialize(state) {
    const safe = state && typeof state === 'object' ? state : createGroupsState();
    return {
      groups: (safe.groups || []).map(group => ({
        id: group.id,
        name: group.name,
        color: group.color,
        order: group.order ?? 0,
      })),
      assignments: { ...(safe.assignments || {}) },
    };
  }

  function deserialize(blob) {
    if (!blob || typeof blob !== 'object' || !Array.isArray(blob.groups)) {
      return createGroupsState();
    }

    const groups = [];
    const seenIds = new Set();
    for (const raw of blob.groups) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') continue;
      if (seenIds.has(raw.id)) continue;
      seenIds.add(raw.id);
      groups.push({
        id: raw.id,
        name: normalizeName(raw.name) || raw.id,
        color: normalizeColor(raw.color),
        order: Number.isFinite(raw.order) ? raw.order : groups.length,
      });
    }

    const assignments = {};
    const rawAssignments = blob.assignments && typeof blob.assignments === 'object' ? blob.assignments : {};
    for (const [sessionId, groupId] of Object.entries(rawAssignments)) {
      if (typeof groupId === 'string' && seenIds.has(groupId)) {
        assignments[sessionId] = groupId;
      }
    }

    return { groups, assignments };
  }

  return {
    GROUP_COLORS,
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
  };
});
