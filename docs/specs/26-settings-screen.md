# 26 — The settings screen

Status: **built** (#471, #472, #490; later #565, #593, #803, #761).
Written after the fact, as a design record.

The enforceable half is the *settings screen* section of [`.claude/rules/renderer.md`](../../.claude/rules/renderer.md);
that file says what to do, this one says why. What each setting means is
[`docs/settings-reference.md`](../settings-reference.md).

## The problem

The screen had grown by accretion. Both scopes had, and neither could answer the question it was opened
with.

- **A heading meant "roughly this area", not a subject.** Terminal had collected documents, editor
  settings and secrets, because each one had once been *about* the terminal. The nav said it held ten
  fields. It held twenty-six.
- **The counts were written into the markup**, so they were wrong long before anyone looked at them.
- **Project settings were one column**, a screen and a half long, with no nav at all — while the global
  ones had had one since #471.
- **A backend and its own files were never on screen together.** The project scope drew every backend's
  launch defaults first and every backend's resources after them, as two flat lists. To see what Claude
  was configured to do *and* what Claude reads, you scrolled past four other backends.
- **Opening the screen walked the filesystem five times.** Each backend's resource block listed a
  directory on render, for lists nobody had asked to see.

## A category is a subject, and the nav is generic

`settings-global-html.js` holds one `<section class="settings-cat" data-cat="…">` per category and a nav
button per section. Nothing about the switching knows what a category *is*, which is what makes adding one
those two edits and nothing else.

**The counts are counted** (#471). `settings-panel.js` fills each badge from its section's
`.settings-field` elements after the markup is in. A category another module fills in later — Backends,
Tags, Custom launchers — counts nothing and shows nothing, which is honest: the panel cannot count what it
has not been given yet. The Plugins group (#803, [spec 40](40-plugins-manager.md)) counts its own: each entry carries
`data-count-own="1"`, and its badge is the number of rows the view drew, empty until the view has read. The Marketplace
(#790, [spec 38](38-mcp-addon-catalog.md)) counts its catalog rows, never registry hits.

The rule that comes with it, and the reason the grouping is worth writing down: **a field goes where its
subject is.** Terminal is what a terminal does, not what happens to be reachable from one.

## Closed by default, because open costs something (#472)

Per-backend blocks are disclosures, and a disclosure fetches on `toggle` rather than on render
(`bindLazyResources`). Five installed backends meant five directory walks per open before this, and the
question "what does this project override" did not need a single one of them answered.

**Closed is closed for everyone** — no remembered per-user state, so two people looking at one project see
one screen. What a collapsed thing must never stop saying is whether the project overrides anything: a
screen that hides the answer to its own question is worse than a long one.

## Project settings get the same shell, and one wiring serves both (#490)

The nav moved to the project scope unchanged in look and different in one way that matters: **its entries
are not all knowable when the markup is written.** Every ready backend is an entry, and which backends
exist is answered by main, after the panel has already rendered.

So `wireTwoPane` in `settings-panel.js` is the one implementation for both scopes, and it:

- **queries `.settings-nav-item` and `.settings-cat` on every use** rather than capturing them in arrays,
- **delegates the clicks** to the nav container,

because a list captured at wiring time would leave every backend entry dead. `addBackendNav` builds the
BACKENDS group from what `backendsPanel.mount` reports through `onBackendPanes` — never from a list written
into the markup, which would be a guess about the machine the app is running on.

**Panes, not scroll anchors.** The alternative was one long page with the nav scrolling to a heading. It
was rejected on cost, not taste: the active-entry highlight needs an observer that does not exist here, and
the search hides fields, so "which section am I in" stops having an answer exactly when a hit is being
looked at. Panes reuse the switching that was already there.

## A backend's page holds its defaults AND its resources

This is the point of #490 rather than a side effect. The pairing replaced two flat lists, and three things
had to move for it:

- **The shared "Launch defaults" heading is gone**, and the sentence under it — the one explaining that an
  option falls back to the global default, and that enabling a backend and the default launch target stay
  global — sits on **each** backend's page and names that backend. There is no landing page left to put it
  on: every entry under BACKENDS goes straight to a backend. The repetition reads as being about this one.
- **The per-backend collapse is gone**, because the page is the disclosure now.
- **The "N overrides" marker moved onto the nav entry.** It was on the collapsed summary, and without it
  "what does this project change" would mean opening every backend in turn. `data-count-own="1"` keeps the
  generic field counter off that badge: every backend has roughly the same number of launch options, so
  counting them says nothing, and counting the overrides says everything.

Since #761 that page belongs to a CLI and not to one backend id; see "A CLI is one row and one page" below.

**Resources stay lazy through a different door.** `showCat` fires `settings-cat-shown`, the backend's page
opens its own disclosure, and the existing `toggle` fetch does the rest. One backend's walk, when that
backend is looked at.

## The search is the hole in laziness, and it is guarded

`applyGlobalSearch` force-opens every `details.settings-adv` so a hit inside one is visible. A resources
block **is** a `settings-adv`. With every backend's page in the DOM from the first render, that meant the
first keystroke in the project search box walked the filesystem once per backend — the exact cost #472 had
removed, coming back through the search box #490 added, in code that had never heard of either.

It now force-opens a resources disclosure only when `dataset.loaded === '1'`: one already read has nothing
left to pay and is searched, one nobody has opened stays closed and is not. A search that silently costs
five directory walks is not a search anybody asked for.

**The general shape of the defect is the part worth keeping:** a blanket operation over a shared DOM
defeats a rule it was never told about. Anything future that opens, expands or measures "everything" in the
settings tree has to answer this question again — see
[`docs/ai/lessons.md`](../ai/lessons.md).

## The Plugins group reads lazily and can hold unsaved work (#803)

The Plugins group ([spec 40](40-plugins-manager.md)) sits in both windows' nav, built by
`src/renderer/panels/settings-plugins.js`. Its Plugins, Apps and Skills views read on their category's first
`settings-cat-shown`, like a backend's resources, so opening the window walks nothing. The search does not open a view
nobody has looked at.

It is also the first part of the screen that holds work outside a setting: a skill page with text not yet saved to its
file. Cancel, Save, Apply, Hide Project, Remove Project, the search and the hand-offs to a project's window all ask
`leave()` first. A refusing page stops the action and the screen switches to it. The search also sends each view back
to its list and clears the view's own filter, so every row is searched.

## What it cost, and what caught it

The suite stayed green through the whole change, including through that defect: nothing tests
`applyGlobalSearch`, and the project scope's search box did not exist before this issue. It was found by a
reading verifier and confirmed in a running app, which is the same shape as every other entry in
`docs/ai/lessons.md` that starts with "all tests passed".

## An action that takes the subject away closes the screen (#565)

Hide Project and Remove Project sit on the project page's button row, and both take the project the page
is about off the list. What happened next had been written for the in-app overlay: hide the viewer, show
`#placeholder`. There has been no overlay since #365 — `settings-panel.js` is loaded by `settings.html`
alone, and that page carries no `#placeholder` at all. So the first line blanked the window and the second
threw on a null. Pressing a destructive button produced an empty window that said nothing either way,
which is also what kept the failure in #566 out of sight.

**A window opened from a WORKTREE opens on its project (#593).** A worktree has no settings scope of its
own, so a page keyed on its own path would show global values while the app applied the project's, and
write a blob nothing reads. The resolution happens in `settingsQuery` (`src/app/windows.js`), before the
URL is built — the one place the scope is decided — so the tags and the per-backend panes describe the
same thing the fields do. The worktree's NAME rides along as a `worktree=` parameter and the panel renders
it as a note in the title, because otherwise the row the user clicked names one thing and the title names
another. The name, not the path: `settings.html` does not load the worktree helper and a label is not a
decision. Since #586 that name is the whole chain — `agent-a / hotfix-1` — for the same reason it is here
at all: it has to read as the row that was clicked, and a nested worktree is drawn beside its own parent
under the project.

The screen closes instead, and the alternative was weighed rather than skipped. Going back to a project
list is not something this window can do: the scope is settled once, from the URL, while the window loads
(`settings-window.js`), and the list of projects lives in the main window. Landing on one here would mean
building a surface that does not exist. Staying is worse than closing, not better — every field writes to
`project:<path>` and every entry under BACKENDS describes a project that has just left the list. Closing
also lands the user in front of the only project list there is: the main window's sidebar, where the row
is now gone, so the result of the action is visible rather than asserted.

What replaces the blank window is the button that was pressed: the green flash the Save button already
uses, worded for the action, and then the close. The failure side had the same hole from the same cause —
the error branch called `toast`, which belongs to app.js and is not loaded here, so a refused Hide or
Remove reported itself to nobody. It says so through `showControlMessage` now, the way the rest of the
panel does.

`test/settings-project-action-close.test.js` loads the panel the way `settings.html` does — every script
that page names, in order, into one jsdom vm context — and clicks both buttons. It is the first harness
that reaches this file's click-time surface; `settings-modules-smoke.test.js` is a load-time guard and
says so.

## A CLI is one row and one page (#761)

Claude and the mode that drives it over a pipe are two backends in the registry, and they used to be two rows, two
gears, two pages and, in a project, two panes, each with its own copy of `model`, `worktree` and the rest. A user who
ran both set everything twice and had no way to see that the two copies had drifted. They are now one row, one page
and one project pane per CLI. The registry did not change: the GUI mode is still its own backend with its own
descriptor, and `src/shared/backend-modes.js` is the one answer to which backends form a CLI (`cliGroups`). Main, the
panel, the tour and the New Session picker all ask it, and `test/backend-modes.test.js` compares its owner with
`cliOwnerOf` in `src/backends/index.js`. No renderer code names a backend; the mode word comes from the descriptor
(`modeLabel`), so a third mode is a line in its own folder.

**The row.** It shows the owner's icon and label. The control column holds, from left to right, a mode badge, the
picker-default badge, the on/off toggle and the gear. The mode badge (a `.conversation-bg-chip` pill) names the current
choice: Terminal, GUI or Both. A click opens a small popover with the choices side by side and the current one marked.
It is the session line's idle chooser (`.conversation-bg-pop`, `.conversation-idle-choices`, `aria-pressed`).

The popover is appended to the page body with `position: fixed`. Inside the row, the settings list clipped it to a
single scrolling line. It opens below the badge, right-aligned to it, flips above when it would leave the window at the
bottom, and is clamped horizontally. A pick applies and closes it. Escape, a click outside, a second click on the
badge, a scroll, a resize or focus moving elsewhere also close it, and focus goes back to the badge.

The badge is not a setting. `backendEnabled` stays one flag per id, so main, the scan and the watchers never had to
learn about groups; a choice writes only the flags of its group (`enabledForChoice`). A CLI without a second mode has
no badge. With three modes some subsets have no choice of their own. The badge then shows the subset ("Terminal +
GUI"), the popover marks nothing and says why, and nothing is rewritten. The badge is disabled while the toggle is off.
The owner looked at a dropdown and at an inline segmented switch first and picked the badge; the welcome tour keeps the
segmented switch.
Toggling off writes every flag `false`; toggling on restores the mode the group had earlier in the open window, or
Terminal when there is none. The default launch target follows the mode (`targetAfterModeChange`): if the target is
the GUI mode and the user switches to Terminal only, the target moves to Terminal. Main does the same in
`getDefaultLaunchTarget` for any path that flips the flags without the panel, such as an import.

**Default in the picker.** With more than one mode on, a second badge sits right of the mode badge ("Picker:
Terminal"). Its popover lists the enabled modes and sets which one the New Session row starts. The setting is global,
one entry per CLI keyed by the owner's id (`pickerModeByBackend`). The panel holds it like the enabled flags and Save
writes it through `readGlobal`. The value is a mode id from the registry. `pickerModeOf` in `src/shared/backend-modes.js`
is the only fallback: the stored id while it is an enabled mode of the CLI, else the terminal mode while it is
enabled, else the first enabled mode. The welcome tour shows it as a segmented switch on the CLI's row when Both is
chosen and writes the same key through the whole blob.

**The page.** One gear. A block "Launch defaults" holds the fields every mode shares, then one section per enabled
mode holds the fields only that mode has, then that mode's env variables, prompt overrides and integrations. A
CLI with every mode switched off shows every section, so it stays editable. A CLI with one mode renders as before,
with no section titles. In a project the pane is the same page with the "use global default" checkbox per option.
The "N overrides" count on the nav entry counts every set value of the group, hidden sections included, because a
hidden value still applies when the mode is switched on.

**Why storage stayed per id while the page did not.** The edit machinery (`recordDefault`, `readDefaults`,
`readProjectDefaults`, `pendingDefaults`) is keyed by `data-backend` and `data-opt`. Putting a shared field under the
owner is therefore a drawing decision: the row names the owner's id. Nothing in the read and write path had to change,
and a section hidden by a mode choice keeps its pending edits. The alternative, one merged descriptor, would have
broken the rule that a backend stays its own folder.

**What "shared" means.** The same field id in the CLI and in every one of its modes, with the same `type`, the
same `default` and, for a select, the same set of choices. It is computed (`sharedIdsOfGroup`), never listed. The
reason for the strict test: a value is only safe to store once when both launches read it with the same meaning and
the same vocabulary. The one place this bites is `permissionMode`: Claude's GUI mode offers a shorter list, because
the skip-permissions mode cannot work where no approval card could appear. A shared value `dangerously-skip` would
sit under the owner, be refused by the GUI launch and still be shown on the page as if it applied. So the permission
mode is set per mode, in each mode's section. `restricted` is shared even though its description differs; the page
shows the CLI's description and adds a line with the mode's description (`fieldSplit` notes).

**What a launch reads.** The readers that build a launch's options from stored defaults all go through
`launchLayer`: the renderer's `storedDefaultsFor`, `spawnOptionsFor` in `src/app/terminal/spawn.js`, the context-window
resolver in `src/index/context-window.js` and the skill detail in `src/app/skills.js`. The GUI mode's own entry is laid
under the CLI's value for every shared field. Main computes the layered result per scope (`launchDefaults` in
`effectiveSettings`) because the merged blob cannot be layered afterwards: a project value under the GUI id would lose
against a global value under the CLI. `approval-memory.js` reads Pi (GUI)'s own `approvalRules`, which only that mode
has, so it stays on its own id.

**The move.** A value already stored under the GUI id for a shared field moves to the CLI's id, at startup and at the
write door (`scrubBlobForDisk`), in the global blob and in every project blob. If the CLI has a different value, the CLI
wins and the GUI value is kept in `backendDefaultsReplaced.<driverId>.<field>`. The write door matters because a
settings import and a form that was open before the startup move can both write the old shape back. Details and the
key are in [`docs/settings-reference.md`](../settings-reference.md#one-row-per-cli-and-launch-defaults-stored-once).

**What it takes away.** Two things change for a user who had both modes. First, a value that was set differently
for the two modes is now one value, the CLI's: a `model` of `opus` for Claude and `sonnet` for Claude (GUI) means both
run `opus` after the move, and the old value sits in `backendDefaultsReplaced`. Second, the permission mode is
still set twice. A user with only the GUI mode on loses nothing: shared values are stored under the CLI's id even when the CLI's
terminal mode is off, and the page shows only the GUI section.

**The New Session picker (the issue first listed it as out of scope).** A single list that shows `Claude` and
`Claude (GUI)` as two rows next to a settings page that shows one would have been the one place the old split stayed
visible, so it follows the same grouping. One row per CLI. With only the terminal mode on, the row is as before.
With both on, a click on the row starts the mode chosen as "Default in the picker" (the terminal mode unless the GUI
was picked) and a button on the right of the row, before the gear, starts the other mode and is labelled with it
("GUI", or "Terminal" when the row starts the GUI). The row keeps the CLI's label either way. With only the GUI mode on,
the row starts it and carries the GUI label. The DEFAULT badge stays on the row when the default target is in the
group. The gear opens the Configure dialog on the mode the row starts, and when both modes are on that dialog has a
Terminal | GUI switch at the top that redraws the fields for the chosen mode and starts it. Nothing else in the dialog
changed.

## Known gaps

- **The permission mode is set once per mode.** If the CLI's own list were narrowed the same way as the GUI mode's,
  the field would become shared with no further work.
- **Toggling a CLI off and reloading starts from Terminal.** The mode the group had is remembered only while the
  window is open; no stored key was added for it.
- **When the default launch target is the mode the side button starts, the row's DEFAULT badge sits on the row's
  launch** for a screen reader. The side button says "(default)" in its label; the badge text on the row does not.
- **The picker default is not moved when a mode goes off.** A stored GUI preference stays stored while the GUI mode is
  off and applies again when it is switched back on; until then the row starts the terminal mode.
- **A later conflicting GUI value is dropped once one is set aside.** The first value kept in
  `backendDefaultsReplaced` stays; a second one for the same field is only logged.
- **No test drives the tour and the settings badge together.** Both build their writes from `enabledForChoice`, so they
  agree by construction.
- **No test covers the search.** The fix is a one-line condition in `settings-panel.js`. The harness that
  arrived with #565 clicks the two project buttons and could be pointed at the search box, but nothing
  does that yet; until then the guard against a regression is the rule and this document.
- **The nav is built in `settings-panel.js` for the project scope** and in `settings-global-html.js` for
  the global one. Two markup sources, one wiring. Splitting the project markup out the way #218 split the
  global one is the obvious follow-up, and was left alone here because the change was already large.
- **`data-count-own` is a convention, not a type.** A future entry that wants its own badge has to know
  the attribute exists.
- **The title-bar X does not ask** (#803). It hides the window, and a skill page's unsaved text is lost with it, as is
  any unsaved setting.
