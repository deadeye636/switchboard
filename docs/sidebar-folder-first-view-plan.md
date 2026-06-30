# Sidebar folder-first view — plan

> **[← Roadmap](ROADMAP.md)** · Stand 2026-06-30 · Status: ✅ Erledigt (#11)

Add a second sidebar layout that can be toggled against the existing one.

- **Directory-first** (current): project dir → user-groups / slug-groups / loose
  sessions interleaved within each project.
- **Folder-first** (new): user-defined groups ("folders") are top-level. Inside a
  folder, members are split into project-dir sub-sections. Below all folders, an
  "Ungrouped" area lists everything not in a folder, also split by project dir.

Front-end only. Groups already live in `groupsState` (`groups-model.js`).

## Decisions (confirmed)

- A "folder" = user-defined group only. Slug-groups are NOT treated as folders.
- Inside a folder, always show the project sub-header (even single-project).
- View switcher = a toggle button in the sidebar filter row (`#session-filters`),
  persisted in `localStorage` under `sidebarViewMode` (`directory` | `folder`).
- Inside folders: flat session list per project sub-section (no slug grouping, no
  "+older" truncation — members are user-curated and folders collapse).
- Ungrouped area: reuses the existing project-group machinery (slug grouping +
  truncation), but rendered flat (worktrees are NOT nested in folder-first to
  avoid orphaning a worktree whose parent has no ungrouped sessions).

## Toggle + state

- `index.html`: add `<button id="view-mode-toggle">` to `#session-filters`.
- `app.js`: `let sidebarViewMode = localStorage.getItem('sidebarViewMode') === 'folder' ? 'folder' : 'directory';`
  plus `updateViewModeToggle()` and a click handler that flips the mode,
  persists, and `refreshSidebar({ resort: true })`.

## sidebar.js refactor

Lift these out of `renderProjects` to module scope so both views share them:

- `filterSidebarSessions(sessions)` — star/running/today filtering.
- `sortSidebarSessions(sessions)` — running/pinned priority + recency sort.
- `processProjectSessions(project, resort)` — unchanged logic, module scope.
- `buildSessionsList(fId, visible, older)` — module scope.
- `appendProjectGroups(container, projects, resort, newSortedOrder, { nestWorktrees })`
  — the worktree detection + project-group build loop.
- `finalizeSidebar(newSidebar, projects, newSortedOrder, folderMode)` — active
  state, morphdom call, `sortedOrder =`, rebind (directory vs folder), focus
  restore.

`renderProjects` becomes: branch to `renderProjectsFolderFirst` when folder mode;
otherwise build attention inbox + project sort + `appendProjectGroups` +
`finalizeSidebar(..., false)`.

## Folder-first rendering

`renderProjectsFolderFirst(projects, resort)`:

1. Attention inbox (shared).
2. Bucket filtered+sorted sessions: `folderBuckets: groupId → (projectPath → [])`
   and `ungroupedByProject: projectPath → []`.
3. Folders (ordered by `group.order`): build a `.user-group-sessions` body of
   `.ff-project` sub-sections (one per project, ordered by recency), then
   `buildUserGroup(group, allMembers, body)`.
4. Ungrouped: build `{ ...project, sessions: ungrouped }` per project (recency
   order), prepend an `.ff-ungrouped-heading` when folders were rendered, then
   `appendProjectGroups(..., { nestWorktrees: false })`.
5. `finalizeSidebar(newSidebar, projects, newSortedOrder, true)`.

New builders / binds:

- `buildUserGroup(group, sessions, bodyNode?)` — optional pre-built body.
- `buildFolderProjectSubsection(scopePrefix, projectPath, sessions, missing)` —
  collapsible `.ff-project-header` (scoped id) + `.ff-project-sessions` list +
  per-project `+` new-session button.
- `rebindFolderFirstEvents(projects)` = `rebindSidebarEvents(projects)` (all the
  global-selector binds + tolerant project loop) + a `.ff-project-header` loop
  (collapse toggle + new-session).

## Cross-cutting wiring

- `COLLAPSIBLE_SECTION_SELECTOR` (`app.js`) += `.ff-project-header`.
- morphdom `onBeforeElUpdated` (`sidebar.js`): preserve `collapsed` for
  `.ff-project-header` like `.project-header`.
- CSS (`style.css`): `#view-mode-toggle` (mirror filter buttons), `.ff-project`,
  `.ff-project-header`(+`.collapsed`/arrow), `.ff-project-name`,
  `.ff-project-count`, `.ff-project-new-btn`, `.ff-project-sessions`,
  `.ff-ungrouped-heading`.

## Verify

- `npm run build` succeeds; quick run shows no console errors.
- Prettier/format check passes.
- Toggle flips views; folders show project sub-sections; ungrouped lists below;
  collapse-all + per-section collapse persist; switching back is clean.
