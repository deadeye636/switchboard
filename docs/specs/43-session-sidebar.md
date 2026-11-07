# 43 — The session sidebar

Issue #817. Status: **built**. The code is `src/renderer/session/session-sidebar.js`.

## What it does

Each session has a collapsible sidebar on its right, opened from the session's toolbar. Its groups collapse one by
one: Repository (#821), Tasks & notes (with a project's forge issues when spec 42 is on), Handoffs, Instructions (#823),
Context and Connectors.

## Decided by the owner (2026-11-06)

- **E1:** one per session or pane, not one per window. A user has it open in one pane and closed in another.
- **E4:** those four groups first. The breakdown by category came with #758, repository, branch and worktree with #821
  (see "The Repository group"), and changes, background tasks, the plan and bookmarks are candidates for later.
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
- **Clicks:** see "The row pattern" below.

## The row pattern (#822)

Owner decisions: E1 one pattern for every group, a click inserts into the session's prompt and hover buttons offer the
rest; E2 a local task inserts its title plus a task reference.

| Row | Click | Shift+click | Hover buttons |
|---|---|---|---|
| Local task | title and `(task #id)` | the title | open in the Tasks view, copy the title |
| Forge issue | `#number` | same | open in the browser (when it has a url), copy `#number` |
| Handoff | the path, with no template (requirement 4) | same | open in the preview (editable), copy the path |
| Skill | the invocation from the backend's `skillInvocation` hook, through `skillInsertText` (template only for a skill with none), submitted unless `submitSkillOnPick` is off | same | edit: Settings → Plugins → Skills on that skill |
| Instruction file, memory file | opens read-only in the preview (#823) | same | none |
| MCP server | opens the server manager, as `/mcp` does | same | none |

- **One way to insert.** Every insert goes through `sidebarInsert` to `insertResolvedText`, with the pickers' text
  functions (`handoffInsertText`, `skillInsertText`); the caret returns to the session afterwards (requirement 8). A
  conversation view takes the text into its input, a terminal pastes it.
- **Gap: no task picker exists**, so a task has no template setting and `Title (task #id)` is fixed in
  `taskInsertText`. It stays until a task picker with a template exists.
- **A handoff's Open leaves the file editable**: handoffs are working documents, not configuration, so unlike an
  instruction file it opens in the ordinary preview, not read-only.
- **A memory file's row reads the neutral `path`** that the backend puts on the memory row (`title` stays the tooltip).
- **The server manager** is `openSessionServers` in `servers-dialog.js`, shared by `/mcp` and the server rows.
- **A row has only the buttons it can honour:** `sidebarRowActions`. The buttons are siblings of the row button (never
  nested in it), shown on hover and when focus is anywhere in the row, so the keyboard reaches them.
- **The row finds its object by key** (`entry.sidebarRows`), the markup carries no payload but the key. Skill rows carry
  `id`, the inventory id main computes (`skillId`), so Edit opens that skill's page without the window building an id.
- Pure parts: `sidebarRowModel`, `sidebarInsertText`, `sidebarCopyText`, `sidebarItemHtml` (`test/session-sidebar-rows.test.js`).

## The context breakdown (#758)

Where a backend answers `context.breakdown`, the Context group draws one bar, a row per category, and a collapsible list
each for memory files, skills, custom agents and MCP tools with their tokens. A session without one shows the total as
before: a terminal session, and pi-native, whose stats name no categories.

- **A colour belongs to its category, not to its place.** The backend answers a `slot` per category, so the colours stay
  put when a category comes or goes, as Messages does with the first turn. A category it does not know is grey. The eight slots are a
  categorical palette, validated against the sidebar's surface.
- **The bar shows what is used and the reserved buffer.** The rest of the track is the free space. Deferred tools are not
  in the context, so they have a row, no share and no segment.
- **A memory file shows its file name, its path only in the tooltip** (owner's decision on #758).
- **A list keeps its open state across a redraw.** The group redraws with every `context` op, so it reads the open lists
  from the DOM first. That state is not stored, so closing the sidebar or a restart closes them.
- **An attach redraws the group too**, or a sidebar drawn before the answer came says it has no figure until the next
  `context` op.
- **The answer can hold several hundred MCP tools.** A real answer held 440. Synthetic rows of that count measured 67 KB of
  markup and 8 ms to build and parse, so the rows are drawn with the group rather than on opening a list.
- **A group out of view marks itself stale** on a `context` op and redraws when it comes into view (E10).

## The Instructions group (#823)

Between Handoffs and Context; closed by default, because it reads the files of two scopes (E10: only when open and in
view, marked stale otherwise). It lists what applies to this session: the instruction, memory and settings files of the
session's CLI, under the subheads Global and Project. A driver backend answers as its owner CLI; main decides that
(`get-session-instructions`, `src/app/instruction-files.js`), the window sends the session's backend and project and names
no CLI. A CLI with none shows its sentence as a note.

- **A click opens the file read-only in the preview panel** (`openFileInPanel(sessionId, path, { readOnly: true,
  editInSettings })`) and the caret returns to the session. The preview has no Save and no editing.
- **The preview's Edit button** asks main which listed file the path is (`locate-instruction`) and opens Settings on that
  file's page (`openSettingsWindow(scope, projectPath, { cat: 'instructions', item: id })`). No listed file, no navigation.
- **The path is the one place a path reaches the window**: the preview panel is path-based (label, language, watcher), so
  main sends it with the row. The id stays for Settings.
- **Edit without a located file**: the plan said no Edit button when `locate-instruction` answers null. The button is
  shown for every file opened this way and answers with a toast when main does not list the path, which saves a locate
  call per open. Read-only also stops typing (the editor is reconfigured, any file kind), and opening the same path again
  in the other mode reopens the viewer.
- **For #822 to reuse**: `instructionRow(row, meta)` draws a file row (`data-ssb="open-file"`, escaped) and
  `sessionSidebarOpenInstruction(entry, row)` opens it and returns the caret to the session once the panel has opened;
  the Context group's memory files call the same two.
- **A group drawn closed reads on its first real open.** The toggle handler only loaded a group that had been closed
  once, which a group drawn closed never was, so Handoffs and Instructions stayed empty on the first open of a fresh
  session. Groups drawn closed now start marked (`sidebarToggleAction`); a group drawn open still reads nothing on the one
  toggle it fires by itself.

## The Repository group (#821)

Where the session runs: the repository, the branch and, when the session's directory is a linked worktree, the worktree.

- **Owner decisions (2026-11-07):** a group of its own, at the top of the sidebar. The figures come from a new IPC,
  cache first. It is open by default for a session with no stored state; a session that has a stored set of open groups
  keeps it, so the group starts closed there.
- **Main answers** (`vcs-describe` in `src/app/vcs.js`, `window.api.vcsDescribe`): the provider's `describeRepo(cwd)`
  names the checkout root and, for a linked worktree, the main repository's root (filesystem only: git's `commondir`).
  The branch, its state and ahead/behind come from the poller's cache when it holds that directory, else from one
  status run with the poller's own flags; the sidebar's reload button asks with `fresh` and always runs it. That run happens whether or not the version-control chip polls, because the
  group reads only when it is open and in view (E10): one spawn per open or reload at most. The answer carries names and
  paths, no backend id and no VCS name beyond the provider's label.
- **Rows:** the repository's folder name, the branch with `↑n ↓m` and an in-progress state (merging, cherry-picking), or
  "detached HEAD" with the state beside it (a rebase detaches HEAD, so it shows as "detached HEAD · rebasing"), and the
  worktree's folder name. Each row's tooltip is its path. A row only shows; it is a `div`, not a
  disabled button, so its tooltip appears (Chromium shows none on a disabled button).
- **No VCS:** "This project is not under version control." A status that could not be read leaves the branch row out.
- **Repository name in a worktree** is the MAIN repository's folder, not the worktree's: the worktree has a row of its own.
  A bare main repository has no folder to name, so there the worktree itself is the repository.

## Known gaps

- The Repository group does not follow the poller: it shows what it read at open or reload. A branch switch while it is
  open shows after the reload button, which skips the poller's cache and runs the status afresh.
- A main repository whose git directory is not a `.git` folder in its working tree (`--separate-git-dir`) looks bare to
  `describeRepo`: a linked worktree of it is named as the repository and gets no worktree row.

- A backend that measures no context fill shows "No figure for this session yet." rather than leaving the group out, as
  does a session that has not reported yet. A projected capability could tell the two apart; nothing does yet.
- MCP status exists only for a session driven over a pipe. A terminal session leaves that row out.
- The Context group in a terminal session updates when the group is reloaded, not live.
- MCP is missing from the breakdown until the servers have settled, up to a minute after the start (spec 32). The core
  then asks the fill once more and the group redraws. While a turn runs it waits, and a turn that ends after they
  settled brings them itself. A server answer that does not come ends the wait without that ask.
