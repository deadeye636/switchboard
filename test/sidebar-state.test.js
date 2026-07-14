const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldRenderProjectGroup, projectHasNothingToRender, sessionsForGroupVisibility, userGroupSections } = require('../public/sidebar-state');
const { groupSessions } = require('../public/groups-model');

test('#173: a project left with only subagent rows keeps its empty placeholder row', () => {
  // Every top-level session archived, but the payload still carries subagent rows
  // (a subagent whose parent lives in another project survives the archive drop).
  // Weighed against the raw payload this project was skipped outright and vanished
  // from the sidebar, though it is neither hidden nor auto-hidden.
  assert.equal(projectHasNothingToRender({
    filteredCount: 0,
    topLevelCount: 0,
    anyFilterActive: false,
  }), false);
});

test('#173: a project whose top-level sessions are all filtered out is still skipped', () => {
  // Sessions exist at the top level, none survives the filter (e.g. a disabled
  // backend, no active filter): unchanged behaviour, the project is dropped.
  assert.equal(projectHasNothingToRender({
    filteredCount: 0,
    topLevelCount: 4,
    anyFilterActive: false,
  }), true);
  // Under an active filter a project that matches nothing stays skipped even when
  // its payload holds nothing at all.
  assert.equal(projectHasNothingToRender({
    filteredCount: 0,
    topLevelCount: 0,
    anyFilterActive: true,
  }), true);
});

test('#173: anything left to render keeps the project', () => {
  assert.equal(projectHasNothingToRender({ filteredCount: 2, topLevelCount: 2 }), false);
  assert.equal(projectHasNothingToRender({ filteredCount: 0, topLevelCount: 3, anyFilterActive: true, projectMatchedOnly: true }), false);
  // A user group held visible under "running only" (#102) outranks the skip.
  assert.equal(projectHasNothingToRender({ filteredCount: 0, topLevelCount: 3, anyFilterActive: true, userGroupCount: 1 }), false);
});

test('#54: sidebar renders a non-hidden project whose sessions are all folded away', () => {
  // All sessions older than the fold threshold (visibleCount 0, olderCount > 0):
  // the group must still render, with its sessions behind "+N older". Previously
  // this silently dropped the whole project (#54). Auto-hide (#57) is now the only
  // mechanism that removes a stale project.
  assert.equal(shouldRenderProjectGroup({
    filteredCount: 3,
    visibleCount: 0,
    olderCount: 3,
    projectMatchedOnly: false,
  }), true);
});

test('sidebar renders a genuinely empty project (all sessions archived) as a placeholder', () => {
  // No sessions after backend filtering, nothing truncated away, no active filter:
  // keep the project so archiving its last session doesn't drop it from the sidebar.
  assert.equal(shouldRenderProjectGroup({
    filteredCount: 0,
    visibleCount: 0,
    olderCount: 0,
    projectMatchedOnly: false,
    emptyPlaceholder: true,
  }), true);
});

test('sidebar still hides a project that matches nothing under an active filter', () => {
  // Active search/filter, this project matches no session and isn't an explicit
  // project match: nothing visible, nothing folded, not an empty placeholder.
  assert.equal(shouldRenderProjectGroup({
    filteredCount: 0,
    visibleCount: 0,
    olderCount: 0,
    projectMatchedOnly: false,
    emptyPlaceholder: false,
  }), false);
});

test('sidebar still renders explicit project matches and visible session groups', () => {
  assert.equal(shouldRenderProjectGroup({
    filteredCount: 0,
    visibleCount: 0,
    olderCount: 0,
    projectMatchedOnly: true,
  }), true);

  assert.equal(shouldRenderProjectGroup({
    filteredCount: 1,
    visibleCount: 1,
    olderCount: 0,
    projectMatchedOnly: false,
  }), true);
});

// --- #102: keep user groups visible under "running only" ---

test('sessionsForGroupVisibility keeps stopped sessions but drops archived + subagents', () => {
  const sessions = [
    { sessionId: 'a' },                        // plain, stopped — kept
    { sessionId: 'b', archived: 1 },           // archived — dropped
    { sessionId: 'c', parentSessionId: 'a' },  // subagent — dropped
    { sessionId: 'd' },                        // plain — kept
  ];
  assert.deepEqual(sessionsForGroupVisibility(sessions).map((s) => s.sessionId), ['a', 'd']);
});

test('#102: a user group with assigned but no running members stays visible (empty) under running-only', () => {
  const groupsState = {
    groups: [{ id: 'g1', name: 'Work', color: '#fff', order: 0 }],
    assignments: { s1: 'g1', s2: 'g1' },
  };
  const projectSessions = [
    { sessionId: 's1', modified: '2026-07-01T00:00:00Z' },
    { sessionId: 's2', modified: '2026-07-02T00:00:00Z' },
  ];
  // Running-only leaves no sessions (nothing running).
  const { sections } = userGroupSections({
    groupSessions, groupsState, projectSessions, filteredSessions: [], showRunningOnly: true,
  });
  assert.equal(sections.length, 1);
  assert.equal(sections[0].group.id, 'g1');
  assert.deepEqual(sections[0].sessions, []); // header kept, body empty
});

test('#102: group rows stay filtered to running members when some are running', () => {
  const groupsState = {
    groups: [{ id: 'g1', name: 'Work', color: '#fff', order: 0 }],
    assignments: { s1: 'g1', s2: 'g1' },
  };
  const projectSessions = [{ sessionId: 's1' }, { sessionId: 's2' }];
  const runningOnly = [{ sessionId: 's1' }]; // only s1 is running
  const { sections } = userGroupSections({
    groupSessions, groupsState, projectSessions, filteredSessions: runningOnly, showRunningOnly: true,
  });
  assert.equal(sections.length, 1);
  assert.deepEqual(sections[0].sessions.map((s) => s.sessionId), ['s1']); // s2 (stopped) not shown as a row
});

test('#102: an archived-only group does not linger under running-only', () => {
  const groupsState = {
    groups: [{ id: 'g1', name: 'Work', color: '#fff', order: 0 }],
    assignments: { s1: 'g1' },
  };
  const projectSessions = [{ sessionId: 's1', archived: 1 }]; // only member is archived
  const { sections } = userGroupSections({
    groupSessions, groupsState, projectSessions, filteredSessions: [], showRunningOnly: true,
  });
  assert.equal(sections.length, 0); // nothing to keep
});

test('#102: without running-only, empty groups are not force-kept', () => {
  const groupsState = {
    groups: [{ id: 'g1', name: 'Work', color: '#fff', order: 0 }],
    assignments: { s1: 'g1' },
  };
  const projectSessions = [{ sessionId: 's1' }];
  const { sections } = userGroupSections({
    groupSessions, groupsState, projectSessions, filteredSessions: [], showRunningOnly: false,
  });
  assert.equal(sections.length, 0); // no filter-keep outside running-only
});
