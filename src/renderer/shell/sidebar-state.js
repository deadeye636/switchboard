(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function shouldRenderProjectGroup({
    visibleCount = 0,
    olderCount = 0,
    projectMatchedOnly = false,
    emptyPlaceholder = false,
  } = {}) {
    // A non-hidden project always renders — the backend already dropped hidden
    // projects, so anything reaching here should stay visible. That includes a
    // project whose sessions are all older than the fold threshold (visibleCount
    // 0, olderCount > 0): render the group with its sessions folded behind
    // "+N older" instead of silently dropping the whole project (#54). The
    // explicit hide / auto-hide feature (#57) is the only thing that removes a
    // project. emptyPlaceholder covers the no-sessions case (all archived / fresh
    // directory). Only case left hidden: an active search/filter that this project
    // matches nothing in (visibleCount 0, olderCount 0, emptyPlaceholder false).
    return projectMatchedOnly || visibleCount > 0 || olderCount > 0 || emptyPlaceholder;
  }

  // Whether a project has nothing left to render and should be dropped from the
  // sidebar before any DOM is built.
  //
  // `topLevelCount` is the number of NON-SUBAGENT sessions in the payload, and it
  // has to be: subagents are rendered nested under their parent (or in the orphan
  // section), never in the flat list, so they are stripped before `filteredCount`
  // is counted. Weighing an empty filtered list against the RAW payload therefore
  // dropped a project whose payload held nothing but subagent rows — one whose
  // top-level sessions were all archived — while a project with a genuinely empty
  // payload kept its placeholder row. Same situation, two outcomes (#173).
  //
  // With no filter active and nothing top-level left, the project stays on as an
  // empty row: only the explicit hide / auto-hide actions (#57) remove a project.
  function projectHasNothingToRender({
    filteredCount = 0,
    topLevelCount = 0,
    anyFilterActive = false,
    projectMatchedOnly = false,
  } = {}) {
    if (filteredCount > 0 || projectMatchedOnly) return false;
    return topLevelCount > 0 || anyFilterActive;
  }

  // Whether a project (or worktree) header starts collapsed on this render (#278).
  //
  // The heuristic — an old project starts folded — used to run on every render whatever the startup mode
  // said, so `remember` never meant last state and there was no way to switch the folding off. It lives
  // behind `auto` now, with a threshold of its own, and the two forcing modes are handled where they
  // always were (sidebar-collapse.js's applyCollapseDefault, after the render).
  //
  // Order matters and each step is a decision someone can point at:
  //   explicit    — the user toggled THIS project; that always wins, in every mode
  //   missing     — the path is gone, so there is nothing worth opening
  //   matchedOnly — the project matched a search but none of its sessions did
  //   auto        — the age heuristic, and only here
  //
  // `ageDays` 0 = collapse nothing, the same reading `sessionMaxAgeDays` 0 has (#144). A project with no
  // timestamp is left open: an unknown age is not evidence of an old one.
  function projectStartCollapsed({
    explicit = undefined,
    missing = false,
    projectMatchedOnly = false,
    filtersActive = false,
    mostRecent = null,
    mode = 'auto',
    ageDays = 0,
    now = 0,
  } = {}) {
    if (explicit === true) return true;
    if (explicit === false) return false;
    if (missing) return true;
    if (projectMatchedOnly) return true;
    if (mode !== 'auto' || filtersActive) return false;
    if (!(ageDays > 0) || !mostRecent || !now) return false;
    return (now - new Date(mostRecent).getTime()) > ageDays * 86400000;
  }

  // What a morphdom pass must carry from the live node to its replacement (#229).
  //
  // Everything here is state the USER put on the DOM and the builder cannot know: a fold someone opened,
  // a rename half typed. The sidebar re-renders on every store event, so a clause missing from this list
  // is a section that closes itself while it is being read — which is how it was found, and the reason
  // these clauses are worth a test rather than an anonymous callback inside the render.
  //
  // The return value is morphdom's contract, not a formality: `false` skips this element AND its subtree,
  // which is the only thing keeping an in-flight rename alive. So the rename check stays first and
  // short-circuits; everything else falls through to `true` after mutating `toEl`.
  function preserveSidebarState(fromEl, toEl) {
    if (!fromEl || !toEl) return true;
    const has = (cls) => fromEl.classList.contains(cls);
    // A row whose name is being edited must not be rebuilt under the caret.
    if (has('session-item') && fromEl.querySelector('.session-rename-input')) return false;
    // Collapsible headers carry their fold in BOTH directions — an expanded one has to stay expanded
    // against a builder that decided it should start folded (#278's age heuristic runs on every render).
    if (has('project-header') || has('slug-group') || has('worktree-header')) {
      toEl.classList.toggle('collapsed', has('collapsed'));
    }
    // The lists that are hidden by an inline style when built, and revealed by a click.
    for (const cls of ['sessions-older', 'slug-group-older', 'session-lineage-ancestors']) {
      if (has(cls) && fromEl.style.display !== 'none') toEl.style.display = '';
    }
    // …and the carets that opened them. Only the open/closed state carries over, never the label: the
    // label is rebuilt from fresh counts, and copying it is what used to plant a stale "- hide older".
    if ((has('sessions-more-toggle') || has('session-lineage-toggle')) && has('expanded')) {
      toEl.classList.add('expanded');
      toEl.setAttribute('aria-expanded', 'true');
    }
    if (has('slug-group-more') && has('expanded')) toEl.classList.add('expanded');
    return true;
  }

  // Which subagents belong in a project's "Orphan subagents" group, and which of those survive the
  // age cut (#247, #248).
  //
  // Orphan means the parent is GONE, not merely off screen. The group used to ask only whether the
  // parent was among the rendered rows, while the subagent index is built from the project's raw
  // session list — so every filter (running / today / pinned / favorites), the age cut and the
  // `older` limit pushed its parents' children in here instead of hiding them along with the parent.
  // On a real history that is hundreds of rows appearing the moment a filter goes on.
  //
  // `knownSessionIds` is deliberately the PROJECT's id set, not an app-wide one. A subagent whose
  // parent is bucketed into a different project is not rendered under that parent either — the index
  // is per project — so this group is the only place it can be reached, and a global set would make
  // it unreachable rather than merely mislabelled.
  //
  // `maxAgeDays` 0 = never hide, like the other day limits (#144). Hiding is display-only.
  function orphanSubagents({
    subagentIndex = new Map(),
    renderedParentIds = new Set(),
    knownSessionIds = null,
    maxAgeDays = 0,
    now = 0,
  } = {}) {
    const orphans = [];
    for (const [parentId, kids] of subagentIndex) {
      if (renderedParentIds.has(parentId)) continue;
      if (knownSessionIds && knownSessionIds.has(parentId)) continue;
      orphans.push(...kids);
    }
    if (!(maxAgeDays > 0) || !now) return orphans;
    const cutoff = now - maxAgeDays * 86400000;
    // A row with no timestamp is kept: an unknown age is not evidence of an old one.
    return orphans.filter(s => !s.modified || new Date(s.modified).getTime() >= cutoff);
  }

  return { shouldRenderProjectGroup, projectHasNothingToRender, projectStartCollapsed, preserveSidebarState, orphanSubagents };
});
