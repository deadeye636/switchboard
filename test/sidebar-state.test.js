const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldRenderProjectGroup } = require('../public/sidebar-state');

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
