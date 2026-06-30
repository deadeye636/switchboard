# Sidebar group interactions — plan

> **[← Roadmap](ROADMAP.md)** · Stand 2026-06-30 · Status: ✅ Erledigt (#12)

Three additions to the sidebar user-group UX, all front-end only (groups live in
the `groups` settings blob; `assignSessionToGroup` / `renameUserGroup` already
persist + re-render).

## Feature 1 — drag a session into a group (sidebar)

- Pointer-based drag on `.session-item` rows in the sidebar (grid already has a
  reference impl in `grid-view.js`, but the sidebar is a simple list so we use a
  lighter ghost + drop-target approach instead of FLIP).
- `startSidebarSessionDrag(session, item, e)` in `sidebar.js`, bound via
  `item.onpointerdown` in `rebindSidebarEvents` (property assignment avoids
  listener stacking across morphdom re-renders).
- Ignore drags that start on buttons / pin / inputs. Only begin after a 6px move
  threshold so plain clicks still open the session.
- Floating `.sidebar-drag-ghost` follows the cursor; `.user-group` under the
  cursor (via `elementFromPoint`) gets `.drop-target`.
- On drop over a `.user-group`: `assignSessionToGroup(sessionId, groupId)`.
  Suppress the trailing `click` so the session doesn't also open.

## Feature 2 — new session from a group folder

- Add `.user-group-new-btn` to the group header (mirrors `.project-new-btn`).
- Determine the group's project via `getProjectForGroup(groupId)` (most common
  project among current members) and open `showNewSessionPopover(project, btn,
  { groupId })`.
- Thread an optional `groupId` through `showNewSessionPopover` →
  `launchNewSession` / `launchTerminalSession` / `showNewSessionDialog`; after the
  session is created, `assignSessionToGroup(newSessionId, groupId)`.

## Feature 3 — double-click group name to rename

- Mirror session `startRename`: `startGroupRename(nameEl, group)` swaps the name
  for a `.group-rename-input`, saves via `renameUserGroup(groupId, name)` on
  blur/Enter, restores on Escape.
- Bind `nameEl.ondblclick` in `rebindSidebarEvents` (the `.user-group-header`
  loop). Stop propagation so it doesn't toggle collapse.
- morphdom: skip updating a `.user-group` that has an active
  `.group-rename-input` (extend `onBeforeElUpdated`).

## Files

- `public/sidebar.js` — buildUserGroup button, rebind (dblclick + drag),
  startGroupRename, startSidebarSessionDrag, morphdom guard.
- `public/app.js` — `getProjectForGroup`, thread `groupId` into launch.
- `public/dialogs.js` — `groupId` param on popover/dialog/launch.
- `public/style.css` — new button, drag ghost, drop-target, group rename input.

## Verify

- `npm run build` (or equivalent) succeeds; quick run shows no console errors.
- Prettier/format check passes.
