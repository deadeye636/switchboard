# 43 — The session sidebar

Issue #817. Status: **built**. The code is `src/renderer/session/session-sidebar.js`.

## What it does

Each session has a collapsible sidebar on its right, opened from the session's toolbar. Its groups collapse one by
one: Tasks & notes (with a project's forge issues when spec 42 is on), Handoffs, Context and Connectors.

## Decided by the owner (2026-11-06)

- **E1:** one per session or pane, not one per window. A user has it open in one pane and closed in another.
- **E4:** those four groups first. The breakdown by category waits for #758, and changes, background tasks, the plan and
  bookmarks are candidates for later.
- **E6:** a new session starts collapsed.
- **E7, E8:** open or closed, which groups are open and the width are per session and survive a restart.
- **E9:** no sidebar in a grid card.
- **E10:** only groups that are open and in view read anything.

## How it fits the terminal

The sidebar is a child of the session's `.terminal-container`, so it travels with the session between panes and windows.
The container keeps its size. FitAddon subtracts the `.xterm` element's own padding, so the open sidebar is that padding,
through the `--session-sidebar-width` variable, and `safeFit` needed no change. `.xterm-viewport` gets the same inset, or
its scrollbar would sit under the sidebar. A wrapper element around xterm would have moved what every fit, the drag-over
state and the panes host address.

Opening, closing and the end of a drag each ask for one refit. A drag moves only the sidebar's own width, so it starts no
PTY resize per frame. The width shown is capped at 60 % of the container and follows the box through a `ResizeObserver`,
because a padding wider than the box would make FitAddon answer its minimum of two columns and rewrap the buffer.

## State

`localStorage` key `sessionSidebar`: one row per session, the newest 300 kept, moved on a re-key. A detached window shares
this storage, so a write reads the map fresh and changes only its own session's row. A write can still lose a change made
by another window in the same moment, which costs a remembered width.

## Choices worth keeping

- **A group reads when it is open and in view.** A restart can bring back several sessions with an open sidebar. Hidden
  ones, and grid cards, mark their groups stale and read when they come into view. A group drawn open fires one `toggle`
  by itself, which reads nothing, or every build would read twice.
- **Forge issues start a CLI**, so they load with the group, not on a timer, and after the local tasks are drawn. Panes on
  one project share one answer for 30 seconds. The reload button asks again.
- **Focus returns to the session** after a handoff insert and after closing, or Enter would press the row again.
- **The sidebar is out of the container's handlers:** its right click, mouse release and wheel do nothing to the session.
- **All text is escaped.** A task title, an issue and a skill name can be someone else's.
- **Clicks:** a task opens the project's Tasks view, an issue opens in the browser, a handoff inserts its path into the
  session.

## Known gaps

- A backend that measures no context fill shows "No figure for this session yet." rather than leaving the group out, as
  does a session that has not reported yet. A projected capability could tell the two apart; nothing does yet.
- MCP status exists only for a session driven over a pipe. A terminal session leaves that row out.
- The Context group in a terminal session updates when the group is reloaded, not live.
