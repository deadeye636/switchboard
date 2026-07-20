const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldRenderProjectGroup, projectHasNothingToRender, orphanSubagents } = require('../src/renderer/shell/sidebar-state');

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

// --- Orphan subagents: who lands in the group, and for how long (#247, #248) ---

const NOW = Date.UTC(2026, 6, 20);
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

const indexOf = (...entries) => new Map(entries);
const kid = (id, days) => ({ sessionId: id, modified: daysAgo(days) });

test('#247: a parent that a filter removed from view keeps its subagents out of the orphan group', () => {
  const out = orphanSubagents({
    subagentIndex: indexOf(['filtered-parent', [kid('a', 1), kid('b', 1)]]),
    renderedParentIds: new Set(),          // nothing on screen — the filter took it
    knownSessionIds: new Set(['filtered-parent']),  // but it IS still in the project
    now: NOW,
  });
  assert.deepEqual(out, []);
});

test('#247: a parent that is genuinely absent still yields orphan rows', () => {
  const out = orphanSubagents({
    subagentIndex: indexOf(['gone-parent', [kid('a', 1)]]),
    renderedParentIds: new Set(),
    knownSessionIds: new Set(['some-other-session']),
    now: NOW,
  });
  assert.deepEqual(out.map(s => s.sessionId), ['a']);
});

test('#247: a rendered parent never contributes orphans — its children nest under it', () => {
  assert.deepEqual(orphanSubagents({
    subagentIndex: indexOf(['shown-parent', [kid('a', 1)]]),
    renderedParentIds: new Set(['shown-parent']),
    knownSessionIds: new Set(['shown-parent']),
    now: NOW,
  }), []);
});

test('#247: without a known-id set the old behaviour stands — nothing silently vanishes', () => {
  // The argument is optional: a caller that cannot supply the project's id set must still get the
  // rows rather than an empty group.
  const out = orphanSubagents({
    subagentIndex: indexOf(['p', [kid('a', 1)]]),
    renderedParentIds: new Set(),
    knownSessionIds: null,
    now: NOW,
  });
  assert.deepEqual(out.map(s => s.sessionId), ['a']);
});

test('#248: 0 days means never hide, however old the row is', () => {
  const out = orphanSubagents({
    subagentIndex: indexOf(['gone', [kid('ancient', 4000), kid('fresh', 0)]]),
    renderedParentIds: new Set(),
    maxAgeDays: 0,
    now: NOW,
  });
  assert.deepEqual(out.map(s => s.sessionId), ['ancient', 'fresh']);
});

test('#248: the age cut drops only what is older than the span', () => {
  const out = orphanSubagents({
    subagentIndex: indexOf(['gone', [kid('old', 20), kid('edge', 14), kid('new', 2)]]),
    renderedParentIds: new Set(),
    maxAgeDays: 14,
    now: NOW,
  });
  // Exactly at the cutoff counts as inside it — a boundary row is not old yet.
  assert.deepEqual(out.map(s => s.sessionId), ['edge', 'new']);
});

test('#248: a row with no timestamp is kept — unknown age is not old age', () => {
  const out = orphanSubagents({
    subagentIndex: indexOf(['gone', [{ sessionId: 'undated' }, kid('old', 90)]]),
    renderedParentIds: new Set(),
    maxAgeDays: 7,
    now: NOW,
  });
  assert.deepEqual(out.map(s => s.sessionId), ['undated']);
});

test('#248: the age cut applies only after the orphan decision, never to a nested child', () => {
  // An ancient subagent whose parent is present must not appear at all — not even as an aged-out
  // orphan. The nested path renders it under the parent and this function never sees it.
  assert.deepEqual(orphanSubagents({
    subagentIndex: indexOf(['present', [kid('ancient', 4000)]]),
    renderedParentIds: new Set(['present']),
    maxAgeDays: 14,
    now: NOW,
  }), []);
});
