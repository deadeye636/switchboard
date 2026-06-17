# Spec 07 — Session groups (visual folders)

> Read `docs/specs/README.md` first.

**Status:** Ready to build · **Roadmap:** Opportunity #7a (Phase 5A) · **Independent:** Yes · **Blocks:** Spec 08

## Problem & goal

When several agents work on the same project (or across projects on one initiative), the sidebar and grid get hard to scan. There's automatic grouping by **project** and by **slug** (forks/scheduled tasks), but **no user-defined grouping** — no way to say "these 3 agents are my 'checkout refactor' crew."

**Goal:** Let users create named, colored **groups** ("visual folders"), assign sessions to them, and have those groups render as collapsible sections in the sidebar and as bounded regions in the grid — with attention counts rolled up so a collapsed group still signals status.

## Current state (grounded)

- Sidebar render pipeline: `renderProjects(projects, resort)` (`public/sidebar.js:379`) → per project `processProjectSessions` (filter/sort) → **slug grouping** via `slugMap` (~443) → `buildSlugGroup(slug, sessions)` (`sidebar.js:283`) which renders a collapsible group (expand state via `getExpandedSlugs()`/`slugId()`, ~285). **This is the pattern to mirror for user groups.**
- Runtime/status helpers: `getSessionRuntimeState()` (`sidebar.js:20`), `getAllRenderableSessions(projects)` (`sidebar.js:36`), `getStatusCounts`, `getSessionStatus` (`session-status.js`).
- Grid: cards built in sidebar order in `wrapInGridCard` / `showGridView` (`grid-view.js`); filter bar `renderGridStatusFilters` (~42); no group boundaries today.
- Persistence: `window.api.getSetting/setSetting` (blob); per-session flags precedent: `toggleStar`, `archiveSession`.
- Sidebar uses morphdom (`index.html:122`) for diff-rendering — keep new DOM stable-keyed.

## Scope

**In (5A):** group data model + persistence; create/rename/recolor/delete groups; assign/unassign sessions (one group per session in v1); collapsible group sections in the sidebar; bounded group regions + a group filter in the grid; rolled-up attention counts on group headers.
**Out:** resize/drag layout (Spec 08); multi-group membership (future).

## Design

### Pure module: `public/groups-model.js` (UMD, Electron-free, tested)
```js
// createGroupsState() -> { groups: [], assignments: {} }  // assignments: sessionId -> groupId
// addGroup(state, {name, color}) -> {state, group}
// renameGroup(state, id, name) / recolorGroup(state, id, color) / removeGroup(state, id)
// assignSession(state, sessionId, groupId|null)  // null = ungrouped
// reorderGroups(state, orderedIds)
// getGroupForSession(state, sessionId) -> group|null
// groupSessions(state, sessions) -> { grouped: [{group, sessions:[...]}], ungrouped: [...] }
//   - preserves input session order within each group
//   - groups ordered by group.order
// serialize(state)/deserialize(blob)  // for setSetting('groups', ...)
```
Group shape: `{ id, name, color, order }`. State is a plain serializable object.

### Persistence
- Load `groups` blob on startup (alongside `global` in `app.js` ~1261) into a renderer-held `groupsState`.
- Persist via `window.api.setSetting('groups', serialize(groupsState))` on every mutation (debounce if needed).

### Sidebar (`sidebar.js`)
- In `renderProjects`, after computing each project's filtered sessions, split them with `groupSessions(groupsState, sessions)`. Render user groups as collapsible sections (clone the `buildSlugGroup` structure into a `buildUserGroup(group, sessions)`), with:
  - colored dot/left-border using `group.color`, name, session count, collapse caret (persist collapse like `getExpandedSlugs`).
  - rolled-up status: compute `getStatusCounts(sessions, runtime)`; show e.g. a "2" attention chip on the header when collapsed.
- Decide cross-project handling: render a top-level **"Groups"** band above projects for groups whose members span projects, OR render groups within each project for single-project groups. **Recommended v1:** render groups *within* their project section (simplest), and if a group spans projects, show it in each project section filtered to that project's members. Keep a project label on each card so it's unambiguous.
- Assignment UI: per-session context action "Add to group ▸ (existing / New group…)" and "Remove from group". Reuse existing session-row affordances (the slug/archive buttons are the precedent). "New group" prompts for name + color (use a `showControlDialog` with an input, or a small popover like `showNewSessionPopover`).

### Grid (`grid-view.js`)
- In `showGridView`, instead of one flat flow, render a labeled **group region** per group (header with color + name + rolled-up counts) containing that group's cards, then an "Ungrouped" region. Keep cards built by `wrapInGridCard` unchanged; just nest them under region containers. Ensure `navigateGrid` still works (it uses bounding rects, so nesting is fine — verify).
- Add **group** options to the grid filter bar (`renderGridStatusFilters`) — a group dropdown/segmented control alongside status filters; persist like `gridStatusFilter`.

## Files to touch
- **New:** `public/groups-model.js`, `test/groups-model.test.js`.
- **Modified:** `public/sidebar.js` (`renderProjects` split + `buildUserGroup` + assignment UI), `public/grid-view.js` (group regions + group filter), `public/app.js` (load/hold/persist `groupsState`; expose to sidebar/grid via the existing globals pattern), `public/index.html` (script tag before `sidebar.js`), `public/style.css` (group section + region styles; reuse slug-group styles as base).

## Tests (`test/groups-model.test.js`)
- add/rename/recolor/remove groups; assign moves a session and unassign returns it to ungrouped.
- one-group-per-session invariant (assigning to a new group removes from the old).
- `groupSessions` partitions correctly, preserves order, orders groups by `order`.
- serialize/deserialize round-trips; deserialize tolerates missing/garbage blob → empty state.

## Acceptance criteria
- Create a group with a color, assign multiple sessions, see them collapse together in the sidebar with a rolled-up attention count.
- The grid shows bounded, labeled group regions and can filter to a single group.
- Groups + membership + collapse state persist across restart.
- Existing project/slug grouping and filters still work.
- `npm test`, `ReadLints`, Electron smoke run pass.

## Risks / notes
- Keep DOM keys stable for morphdom to avoid flicker on re-render.
- Don't regress slug grouping — user groups layer on top, they don't replace it.
- Coordinate `grid-view.js` header edits with Spec 06 if concurrent.
