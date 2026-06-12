# Agent Supervision UX Plan

**Goal:** Make Switchboard feel like an agent control room, where a human can quickly see which agents are running, blocked, ready for review, or safe to ignore.

**Approach:** Build this in small, testable slices. Start by making session state explicit and centralizing attention state in the sidebar, then improve grid supervision, keyboard/accessibility behavior, and safer bulk actions.

## Phase 1: Attention Inbox And Status Chips

- [x] Add a small pure status-model helper for mapping session runtime state into labels, priorities, and CSS classes.
- [x] Add tests for attention, response-ready, busy, running, exited, and idle state priority.
- [x] Render an "Attention" section above projects when any session needs human action, has finished with unread output, or is actively running.
- [x] Add visible status chips to session rows so state is not only conveyed by dots or color.
- [x] Keep existing project ordering and filters intact.
- [x] Validate with `npm test`, `ReadLints`, and a short Electron smoke run.

## Phase 2: Grid Command Center

- [x] Add grid card status chips and project counts.
- [x] Add filters for `Needs You`, `Ready`, and `Running` in grid mode.
- [x] Keep card actions visible for attention sessions instead of hover-only.
- [x] Preserve current keyboard navigation and active-session restoration.

## Phase 3: Keyboard And Accessibility Hardening

- [x] Add accessible names to icon-only buttons that currently rely on `title`.
- [x] Add visible `:focus-visible` styles for sidebar rows, toolbar buttons, project headers, grid cards, and popover options.
- [x] Convert custom clickable rows to keyboard-operable controls or add correct roles and Enter/Space handlers where conversion would be too invasive.
- [x] Add live-region announcements for status changes such as "3 sessions need attention".
- [x] Respect `prefers-reduced-motion` for ripples, spinners, shimmer, and toast animations.

## Phase 4: Density Tuning

- [x] Slightly reduce sidebar chrome padding, row padding, and group margins without making click targets cramped.
- [x] Slightly reduce grid header/filter padding, card gaps, and grid card chrome to fit more live sessions on screen.
- [x] Validate that focus rings and status chips still have enough breathing room.

## Phase 5: Safer Human Control Flows

- [x] Replace native `confirm`/`alert` flows with app-styled dialogs for archive, hide worktree, remap, and stop actions.
- [x] Include counts, affected project/session names, and an explicit destructive-action label.
- [x] Add an undo path where the underlying operation supports it.

## Phase 6: Agent Timeline

- [x] Add a per-session timeline panel for important events: started, busy, needs attention, response ready, exited, stopped, forked.
- [x] Keep raw terminal scrollback as the source of detail, but surface the supervision summary separately.
- [x] Add search/filter within timeline if event volume warrants it.

## Notes From Audit

- Current state signals already exist in `public/app.js`: `attentionSessions`, `responseReadySessions`, `sessionBusyState`, `activePtyIds`, `openSessions`, and `lastActivityTime`.
- Session rows are built in `public/sidebar.js`; this is the lowest-risk place to add the first visible workflow improvements.
- Grid view in `public/grid-view.js` already groups sessions by project and supports keyboard navigation, so it can be enhanced without replacing the layout.
- Several controls rely on icon-only `title` attributes and custom clickable `div`s; accessibility hardening should be a dedicated pass to avoid mixing behavior changes with visual state work.
