# 43 — The session sidebar

Issue #817. Status: **built**. The code is `src/renderer/session/session-sidebar.js`.

## What it does

Each session has a collapsible sidebar on its right, opened from the session's toolbar. Its groups collapse one by
one: Repository (#821), Processes (#834), Context, Tasks & notes (with a project's forge issues when spec 42 is on),
Handoffs, Instructions (#823) and Connectors. That is the default order since #841, which put the two figures a user
glances at most right after the repository; a user can change it (see "The section order"), and a saved order is kept.
A collapsed Processes or Context group shows its figure in its header (see "Figures in a collapsed header").

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

A session with no row starts as the global setting `sessionSidebarDefault` says (`open` or `closed`, default `closed`, #831).
A row, once written, keeps its own state whatever the setting says, so changing it never moves a session that was set. There
is no "last state" option and no per-project override. `sidebarStateOf` takes the default as a third argument and applies it
only when there is no row; a write passes it too, so a width change in a session that was showing open by default stores
`open`.

## Choices worth keeping

- **A group reads when it is open and in view.** A restart can bring back several sessions with an open sidebar. Hidden
  ones, and grid cards, mark their groups stale and read when they come into view. A group drawn open fires one `toggle`
  by itself, which reads nothing, or every build would read twice.
- **Forge issues start a CLI**, so they load with the group, not on a timer, and after the local tasks are drawn. Panes and
  windows on one project share main's answer for 30 seconds per query (#830, spec 42). The reload button asks again.
  The issue filters sit under the subhead: a text field, and a "Filter" button whose popover holds the state, the label
  and the two "me" toggles. A control with the caret keeps it across the group's redraw (`data-ssb-focus`).
- **Focus returns to the session** after a handoff insert, or Enter would press the row again, and after the sidebar is
  closed.
- **The head has Reload only.** The session's toolbar button opens and closes the sidebar; a close button in the head
  was a second one for the same thing and was taken out after #829. The body uses the app sidebar's thin scrollbar.
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

- **Owner decisions (2026-11-07):** a group of its own, at the top of the sidebar (the default place since #829). The figures come from a new IPC,
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

## The section order (#829)

A user drags a section by the grip at the right of its heading, or presses Alt+Up or Alt+Down on the grip. The order is
one global setting, `sessionSidebarOrder`, and every session sidebar in every window shows it.

- **Owner decisions (2026-11-09):** E1 the grip sits beside the `<details>`, inside a wrapper (`.ssb-slot`), not in its
  `<summary>`, so a press or Space on it never opens or closes the section. E2 the reset is a button in Settings →
  Sessions that writes at once, without Save. E3 the list functions are the variables manager's
  (`src/renderer/lib/variable-order.js`), used under their names. E4 the key is `sessionSidebarOrder`. E5 a settings
  change now reaches every window, detached ones included (below).
- **Reading the order:** `orderSidebarGroups` drops an id it does not know, counts a repeat once, and puts a section the
  list does not name, one added in a later version, right after the section that comes before it by default.
- **One funnel for a move:** `commitSidebarGroupOrder` moves the slots of every sidebar in this window (it never rebuilds
  them, so a section keeps what it read), updates this window's `appGlobalSettings`, writes the key through
  `mergeSetting` and then calls `notifySettingsChanged`. The broadcast skips the sender, which is why the sender applies
  the move itself. A failed write puts the old order back and says so.
- **The other windows** apply it from `reapplyGlobalSettings` through `sessionSidebarOrderChanged`, which only reads.
  Until #829, `broadcastSettingsChanged` sent to the main and the settings window only, so a detached window took any
  global setting at its next start. It now sends to every window but the sender. To keep that cheap,
  `reapplyGlobalSettings` switches the GPU renderer only when its value changed: the switch reloads WebGL into every open
  terminal past the per-mode policy.
- **A drag carries its own type**, `application/x-switchboard-sidebar-group`. The terminal container under the sidebar
  lets it through (`isPaneTabDrag`), so a section dropped on the terminal inserts nothing, and the sidebar keeps drag
  events from that container while its own drag runs.
- **The settings screen does not hold the key.** Its Save reads the blob fresh and writes only its own fields, so an open
  settings window cannot put an old order back.

## Processes (#834)

What the session costs the machine: its process tree from its root (the terminal's shell, or the pipe child of a
backend driven over a runtime protocol; both are `session.pty.pid`), each process with its name, CPU and memory, and a
total at the top. Closed by default, between Repository and Context (#841).

- **Owner decision (way a):** Windows measures through `@vscode/windows-process-tree`, a native module (N-API, so no
  rebuild per Electron version). It is in `optionalDependencies`, required lazily, and unpacked from the asar; a machine
  where it did not build answers that it is not installed, and the group says so. Building it needs the
  Spectre-mitigated MSVC libraries (`docs/build-windows.md`).
- **One measurement for every session.** `src/app/process-usage.js` takes one `getProcessList(process.pid)` and one
  `getProcessCpuUsage` (its worker reads the times a second apart, off the main thread). Every shell and pipe child is a
  direct child of the main process, so its descendants hold every session; each session is cut out of that one list by
  its root pid. macOS and Linux run one `ps -A -o pid=,ppid=,rss=,time=,comm=` and take CPU as the CPU time used between
  two samples; the first sample therefore shows memory only. CPU is a share of all cores, 0 to 100, on every platform.
  A sample answers every request within `REUSE_MS` or while it is out, so several sidebars and windows cost one.
- **Measured only when looked at.** The group's read starts a poll (`SIDEBAR_PROCESS_POLL_MS`, 4 s). A collapsed group
  goes on at `SIDEBAR_PROCESS_POLL_COLLAPSED_MS` (15 s) for the figure in its header (#840); showing the sidebar or the
  group again with the group collapsed measures once at once. A tick with the sidebar out of view or the window hidden
  measures nothing and waits; when the sidebar comes back into view (its pane or tab is shown again) the next tick runs
  at once, while a window shown again waits for the next tick (up to one interval); a hidden group, a closed sidebar
  or a removed session ends the poll, and the next read starts it again. Nothing in main runs on its own.
- **Only what changed is redrawn.** Rows are keyed by pid: a row whose figures did not move is not touched, a row that
  came or went is inserted or removed, and the total updates its text. No animation.
- **The answer is neutral:** per session `running`, a total `{ cpu, memory, count }` and at most `MAX_ROWS` rows
  `{ pid, name, depth, cpu, memory }`. No command line, no path, no backend id.
- A process that ends between two samples drops out; a session whose root is not running says it has no running process.

## Figures in a collapsed header (#840)

A collapsed group shows nothing of its body, and two groups hold a figure worth a glance without opening them. Their
header carries it at the right, in the row-meta tone, and only while the group is collapsed (the stylesheet hides it in
an open one, whose body shows the same figure).

- **Processes:** the session's total CPU, in the total's own format (`processHeadFigure`, `sidebarCpu`). It comes from
  the slow poll above. A session with nothing running, an unsupported machine or a first sample without CPU shows no
  figure, never `0 %`.
- **Context:** the share of the window in use, rounded (`contextHeadFigure`). It costs no read: the figures come from
  what the conversation view and the session already hold, so it is set when the sidebar is shown, when it comes into
  view, on the conversation view's context change (a session driven over a pipe) and after `loadProjects` refreshed the
  session objects (a terminal session's `contextFill`, `sessionSidebarSessionsChanged`), collapsed or not. The open
  group's body still redraws only on the conversation view's context change, as before. While the app sidebar shows
  another tab than Sessions, `loadProjects` waits for the way back, and a terminal session's header waits with it.
- The header stays one line; the name and the figure sit in two spans (`.ssb-group-name`, `.ssb-group-figure`).

## Hidden sections (#835)

A user can hide a section and show it again. The list is one global setting, `sessionSidebarHidden`, a list of section
ids, and every session sidebar in every window hides the same sections.

- **Owner decisions (2026-11-10):** Settings → Sessions offers the same list as the sidebar (a switch per section), not
  only a "show all" reset. Every section may be hidden; the sidebar then shows a note that says how to bring them back,
  instead of the last switch being locked.
- **Where the list opens:** a right click on a section's heading, its grip, the sidebar's head, or the empty sidebar's
  note. The context-menu key and Shift+F10 arrive as the same `contextmenu` event, at a point Chromium puts on the
  focused control; an event with no position opens the list under the control. A right click on a section's rows is not
  the list. The list is the terminal menu's surface (`popover terminal-context-menu`)
  with `.popover-option` rows as `menuitemcheckbox`; it stays open while sections are checked and unchecked, the arrows,
  Home and End move, Escape and Tab close it and give the caret back, a click outside closes it.
- **A hidden section reads nothing.** `loadSidebarGroup`, every section's one way to read, returns before reading and
  marks the section stale. Showing a section that is open reads it at once when the sidebar is in view, else when it
  comes into view.
- **The slots are hidden, never rebuilt** (`applySidebarHidden`), so a section keeps its open state and its place in the
  order. Alt+Up and Alt+Down step past the neighbouring SHOWN section; a hidden one keeps its place.
- **One funnel for a change**, as for the order: `commitSidebarHidden` applies it to every sidebar in this window, updates
  `appGlobalSettings`, writes the key through `mergeSetting`, then calls `notifySettingsChanged`. A failed write puts the
  old list back and says so. The other windows apply it from `reapplyGlobalSettings` through
  `sessionSidebarHiddenChanged`, which only reads.
- **The names live in `src/renderer/lib/sidebar-groups.js`**, which the settings window loads too (it does not load the
  sidebar). The sidebar's own table adds a loader per id; `test/session-sidebar-hidden.test.js` checks both name the
  same ids in the same order. The settings switches write at once like Reset order, and each reads the stored list fresh
  before it changes its own section, because the settings window holds a snapshot.

## Known gaps

- Two windows moving sections at nearly the same moment can each end up drawing the other's order while the database
  holds the last write. The same can happen in one window when a move's write fails just before a later move's write
  succeeds. The next settings broadcast or a restart puts it right. The hidden sections (#835) have the same race: a
  sidebar writes its whole list from its window's cached copy.
- An open settings window does not follow a section hidden from a sidebar: its switch shows the state the window opened
  with until one of its switches is used, which reads the stored list and sets every switch from it.
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
