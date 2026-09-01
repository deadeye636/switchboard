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

// --- #278: which projects start collapsed, and in which mode ---

const { projectStartCollapsed } = require('../src/renderer/shell/sidebar-state');

const NOW_278 = Date.UTC(2026, 0, 20);
const staleBy = (n) => new Date(NOW_278 - n * 86400000).toISOString();

test('#278: auto folds a project whose newest session is past the threshold', () => {
  assert.equal(projectStartCollapsed({
    mode: 'auto', ageDays: 3, mostRecent: staleBy(10), now: NOW_278,
  }), true);
});

test('#278: auto leaves a recently active project open', () => {
  assert.equal(projectStartCollapsed({
    mode: 'auto', ageDays: 3, mostRecent: staleBy(1), now: NOW_278,
  }), false);
});

test('#278: remember applies no age heuristic at all', () => {
  // The whole point of the mode: last state means last state. Before this the heuristic ran in every
  // mode, so a project the user had left open reopened folded and nothing said why.
  assert.equal(projectStartCollapsed({
    mode: 'remember', ageDays: 3, mostRecent: staleBy(400), now: NOW_278,
  }), false);
});

test('#278: the forcing modes decide nothing here — applyCollapseDefault does that after the render', () => {
  for (const mode of ['expanded', 'collapsed']) {
    assert.equal(projectStartCollapsed({
      mode, ageDays: 3, mostRecent: staleBy(400), now: NOW_278,
    }), false, mode);
  }
});

test('#278: a threshold of 0 collapses nothing, like every other day limit', () => {
  assert.equal(projectStartCollapsed({
    mode: 'auto', ageDays: 0, mostRecent: staleBy(9999), now: NOW_278,
  }), false);
});

test('#278: an explicit toggle wins over the heuristic, in both directions and in every mode', () => {
  assert.equal(projectStartCollapsed({
    explicit: false, mode: 'auto', ageDays: 3, mostRecent: staleBy(400), now: NOW_278,
  }), false);
  assert.equal(projectStartCollapsed({
    explicit: true, mode: 'remember', ageDays: 3, mostRecent: staleBy(1), now: NOW_278,
  }), true);
  // …and over the missing-path and matched-only rules, which sit below it.
  assert.equal(projectStartCollapsed({
    explicit: false, missing: true, projectMatchedOnly: true, mode: 'auto', ageDays: 3, now: NOW_278,
  }), false);
});

test('#278: a missing path and a project that only matched the search itself still start folded', () => {
  assert.equal(projectStartCollapsed({ missing: true, mode: 'remember', now: NOW_278 }), true);
  assert.equal(projectStartCollapsed({ projectMatchedOnly: true, mode: 'expanded', now: NOW_278 }), true);
});

test('#278: an active filter suspends the heuristic — a match must not be hidden behind a fold', () => {
  assert.equal(projectStartCollapsed({
    mode: 'auto', ageDays: 3, mostRecent: staleBy(400), filtersActive: true, now: NOW_278,
  }), false);
});

test('#278: a project with no timestamp is left open — an unknown age is not an old one', () => {
  assert.equal(projectStartCollapsed({
    mode: 'auto', ageDays: 3, mostRecent: null, now: NOW_278,
  }), false);
});

// --- #229: what a morphdom pass carries from the live node to its replacement ---

const { preserveSidebarState } = require('../src/renderer/shell/sidebar-state');

// Stub elements rather than jsdom: the clauses only read classList, style.display and one querySelector,
// and a fake keeps what each case actually depends on visible in the test.
function el(classes = [], { display = 'none', renaming = false } = {}) {
  const set = new Set(classes);
  return {
    classList: {
      contains: (c) => set.has(c),
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      toggle: (c, on) => { if (on) set.add(c); else set.delete(c); return on; },
    },
    style: { display },
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    querySelector: (sel) => (renaming && sel === '.session-rename-input' ? {} : null),
    has: (c) => set.has(c),
  };
}

test('#229: a row with a rename in flight is skipped entirely — that is the false', () => {
  assert.equal(preserveSidebarState(el(['session-item'], { renaming: true }), el(['session-item'])), false);
  assert.equal(preserveSidebarState(el(['session-item']), el(['session-item'])), true);
});

test('#229: a collapsed header stays collapsed, and an expanded one stays expanded', () => {
  for (const cls of ['project-header', 'slug-group', 'worktree-header']) {
    const openTo = el([cls, 'collapsed']);
    preserveSidebarState(el([cls]), openTo);
    assert.equal(openTo.has('collapsed'), false, `${cls}: an open section must not be re-folded`);

    const foldedTo = el([cls]);
    preserveSidebarState(el([cls, 'collapsed']), foldedTo);
    assert.equal(foldedTo.has('collapsed'), true, `${cls}: a folded section stays folded`);
  }
});

test('#229: a revealed list keeps its display, a hidden one is left alone', () => {
  for (const cls of ['sessions-older', 'slug-group-older', 'session-lineage-ancestors']) {
    const shown = el([cls], { display: 'none' });
    preserveSidebarState(el([cls], { display: '' }), shown);
    assert.equal(shown.style.display, '', `${cls}: an open list stays open`);

    const hidden = el([cls], { display: 'none' });
    preserveSidebarState(el([cls], { display: 'none' }), hidden);
    assert.equal(hidden.style.display, 'none', `${cls}: a closed list stays closed`);
  }
});

test('#229: an expanded caret carries its state and its aria, in both flavours', () => {
  for (const cls of ['sessions-more-toggle', 'session-lineage-toggle']) {
    const to = el([cls]);
    preserveSidebarState(el([cls, 'expanded']), to);
    assert.equal(to.has('expanded'), true, cls);
    assert.equal(to.attrs['aria-expanded'], 'true', cls);
  }
  const more = el(['slug-group-more']);
  preserveSidebarState(el(['slug-group-more', 'expanded']), more);
  assert.equal(more.has('expanded'), true);
});

test('#229: a caret nobody opened is not marked expanded by the copy', () => {
  const to = el(['sessions-more-toggle']);
  preserveSidebarState(el(['sessions-more-toggle']), to);
  assert.equal(to.has('expanded'), false);
  assert.equal(to.attrs['aria-expanded'], undefined);
});

// --- #516: the pass that has nothing to do ---

test('#516: a row that is already what the builder wants is skipped, a changed one is not', () => {
  // jsdom rather than the stub above: this clause is a native deep compare, so it needs real nodes.
  const { JSDOM } = require('jsdom');
  const { window } = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const row = (name) => {
    const el = window.document.createElement('div');
    el.className = 'session-item';
    el.id = 'si-a';
    el.innerHTML = '<span class="session-summary">' + name + '</span>';
    return el;
  };

  assert.equal(preserveSidebarState(row('Same'), row('Same')), false,
    'an identical row: morphdom would end in no mutation, so the subtree is skipped');
  assert.equal(preserveSidebarState(row('Same'), row('Renamed')), true,
    'a row whose text changed must still be patched');

  // The skip never costs a carry-over: the clauses above run first and have already mutated `toEl`.
  const fromOpen = window.document.createElement('div');
  fromOpen.className = 'sessions-older';
  fromOpen.style.display = '';
  const toHidden = window.document.createElement('div');
  toHidden.className = 'sessions-older';
  toHidden.style.display = 'none';
  preserveSidebarState(fromOpen, toHidden);
  assert.equal(toHidden.style.display, '', 'an open list still comes out open');
  window.close();
});
