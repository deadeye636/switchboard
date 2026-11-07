# 44 — Instructions, Agents, Commands and Rules in Settings

Issue #823. Status: **in progress** (the neutral inventory of agents, commands and rules is built; the rest is planned).
The code so far is `src/app/resource-inventory.js`.

## What it does

The sidebar's Agent Files tab is retired in favour of pages in Settings. Agents, Commands and Rules become three views
of the Plugins group; the instruction files and the CLIs' settings files get a category of their own, Instructions, in
the global and the project window; the session sidebar gets an Instructions group. Every kind that Agent Files showed
must have a new home before the tab goes. Built on #824 (CLI chips and filters in the Plugins kit); #822 follows.

## Decided by the owner

- **O7:** instruction files and the CLIs' settings files live in a Settings category Instructions, in the global and the
  project window, each file in the scope it applies to. Handoffs stay where they are.
- **Search:** every new view's filter matches the name and the file content.
- **Actions:** Agents, Commands and Rules offer New, Edit and Delete as the Skills page does (spec 40, E16), where a
  descriptor's `resourceScaffolds` and `resourceEditing` allow it. Delete asks first, and nothing a plugin installed
  (`fromPlugin`) is deleted.
- **Sidebar:** the Instructions group is what applies to the session (global and project, the owner CLI of the session's
  backend). A click opens the file read-only in the preview panel; its Edit button opens the file's page in Settings.
- **Every backend** through descriptors, in neutral rows. A backend without the kind declines, and the view says so.
- **The settings window is a snapshot:** edits use the `safe-write` baseline.
- **Order:** #824, then #823, then #822. Agent Files goes away completely, and only after every kind has a new home.

## Decided by the planner (each reversible)

- **P1:** Instructions is its own top-level nav item in both windows, not under Plugins. Plugins means what you add to a
  CLI; instruction and settings files are what the CLI already reads. Agents, Commands and Rules go under Plugins.
- **P2:** the kind-to-view table is one core constant, `RESOURCE_VIEWS` in `src/app/resource-inventory.js`. Kinds are
  the shared vocabulary of the listing, never a backend id.
- **P3:** the sidebar group lands with this work and does not wait for #822's hover-button rows.
- **P4:** a content filter is matched in main; the window never receives file text. Bounded and lazy.
- **P5:** Skills gets the content filter too (this reverses spec 40, E17).
- **P6:** work files get a small section on the project-scope Instructions page.
- **P7:** handoff groups vanish with the tab and get no new home. Known gap: if Agent Files was the only surface with
  Delete for a packet, that is lost (to verify when the tab goes).
- **P8:** the door for the new pages names a file by an opaque inventory id (a hash of the real path), re-derived on
  every call from the current listing, through `safe-write.js` with the baseline.
- **P9:** no cross-listing. The global window shows global-scope files, the project window project-scope files, each with
  a one-line pointer to the other.

## What Agent Files lists today (checked against the code)

- Loose instruction files from each ready backend's `memorySources(scope)`, one asker per CLI: Claude (global
  `~/.claude/*.md`; project instruction file, `.claude/*.md`, auto memory from the store folders, `.claude/commands/*.md`),
  Codex (`AGENTS.md`), Pi (`AGENTS.md`, `CLAUDE.md`), agy (`GEMINI.md`), Hermes (`AGENTS.md`, `CLAUDE.md`, `.hermes.md`,
  `SOUL.md`, `.cursorrules`).
- Resource groups: `listResources` directories whose kind is in `TAB_KINDS` of `src/app/plans-memory.js`.
- A settings group per backend (kind `settings`), a work files group, and handoff groups.
- **Defect today:** project `.claude/commands/*.md` arrive as loose instruction files first, and the group builder then
  skips them, so project commands are listed as instructions and not under a Commands group.
- **Gap today:** Codex global `AGENTS.md` and agy global `GEMINI.md` are listed as kind `memory` but not as memory
  sources, and a `memory` file is not an expandable directory, so neither is shown.

## Kind mapping

| Kind as Agent Files shows it | New home | Note |
|---|---|---|
| `agent` | Plugins, Agents | New, Edit and Delete from the descriptor's scaffolds (Claude only today) |
| `command`, `prompt-template` (Pi), `workflow` (Claude), `skill-bundle` (Hermes) | Plugins, Commands | Scaffold: Claude `command`, Pi `prompt-template`; the others are Edit only where `resourceEditing` takes the extension |
| `rule` (Codex), `hook` (Claude, Hermes) | Plugins, Rules | Hooks are scripts: listed read-only, never deleted |
| instruction files, `memory` entries | Instructions | scope per file |
| `memory-store`, `output-style`, `resource`, `settings` | Instructions | sections Memory, Output styles, Settings files |
| `work-file` | project Instructions, section Work files | |
| handoff groups | stay where handoffs are | sidebar group, picker |
| `skill` | Plugins, Skills (unchanged) | |
| `plan-store` | Plans tab (unchanged) | |

## As built

**The neutral inventory (`src/app/resource-inventory.js`).** `get-resource-inventory(view, projectPath)` answers
`{ ok, rows, declines }` for `agents`, `commands` or `rules`. It asks each ready, non-profile backend (one per CLI) for
`listResources` in the global scope and, with a project, in the project scope, reads each listed directory through the
descriptor's own `expandResource` (a listed file is one row itself), and keeps the entries whose kind belongs to the
view. One row per real path. A row is `{ id, name, kind, scope, sourceLabel, originLabel, ext, cli, clis, editable, deletable,
fromPlugin, creatable }`:

- `id` is a hash of the path's `pathKey`; no path and no backend id field leave main. The owner CLI's id travels only
  as the opaque `cli.key` of the #824 stamps (spec 40).
- `ext` is the file's lowercase extension (`.md`, `.toml`), nothing of the path: the editor picks its syntax from it.
- `cli` and `clis` are the #824 stamps; a driver folds into its owner CLI. A file named by several CLIs carries all of
  them in `clis`.
- `editable` is the Skills door's predicate: some owner's `resourceEditing` takes the extension and that owner's listing
  reaches the file. A `hook` never is, whatever its extension (`READ_ONLY_KINDS`).
- `deletable` is `editable`, the kind has a lifecycle (`isDeletableKind`), and no owner marks the folder `fromPlugin`.
- `creatable` is true when some owner declares a `resourceScaffolds` entry for the row's kind.
- `declines` holds `{ cli, sentence }` for a CLI that reports no row, lists no source and declares no scaffold for the
  view's kinds ("Codex keeps no agents here."). A CLI that lists an empty directory of the kind has not declined.

A hook that throws is skipped and logged at debug level; the other backends still answer. The listing is synchronous: an
`expandResource` that answers a promise counts as a failure, is logged, and does not mark the source as listed. No setting was added.

**The doors (same module).** `read-resource-item(id, projectPath)`, `save-resource-item(id, projectPath, content,
baseline)`, `delete-resource-item(id, projectPath)`, `get-resource-places(view, projectPath)` and
`create-resource-item(view, placeId, name, projectPath)`; each has a `window.api` binding in `src/preload.js`. They name
an item by its inventory id only. Every call checks the project against the register (`skills.projectAllowed`, a
worktree through its project). Read, save and delete take an optional trailing `view` and list only that view (all three
when none is given), then take a row only by equality of its id; an id that is no longer listed is refused. Places and
create list the one view they are given. A file two backends list under different kinds is read-only for all of them
when either kind is read-only (a hook). The work is `backend-resources.js`'s: `readResource`, `writeResource` (the `safe-write.js`
baseline, line endings and BOM kept, format check), `createResource` and `deleteResource`, each through the first owner
that qualifies, with the project passed only for a project-scope row.

- Read needs an owner whose listing reaches the file (a hook can be read). Save needs a baseline string and an owner
  with the `editable` predicate; a stale baseline answers `{ ok: false, conflict: true, diskContent }` and writes nothing.
- Delete takes the row's `deletable` flag: a hook, a kind without a lifecycle (a Hermes bundle) and anything a plugin
  installed (`fromPlugin` on any owner) is refused with a sentence.
- A new item goes into a place: a listed directory of the view's kind, under a source that backend's scaffold claims, that
  exists. The window gets `{ id, label, scope, kind }`: no path field and no backend id (the label shows the folder). The answer carries the new row's
  id (null when the fresh listing does not show it).

**The three views (renderer, T3).** Settings, Plugins, Agents / Commands / Rules, in the global and the project window,
are `src/renderer/panels/plugins-resources.js` over the Skills page's builder; spec 40 ("Agents, Commands, Rules (#823)")
has the page. The window calls `get-resource-inventory` with the view name, reads and saves through the id doors passing
the view, and draws `declines` as one line per CLI. No new setting.

**The content filter (T4).** The filter of the three views (and of Skills, P5) matches name OR file content, decided in
main by `match-resource-content(view, projectPath, query)` (`matchResourceContent` in preload) in the inventory module; spec 40
("Content filter") has the bounds, the memo and the kit hook. The settings-wide search does not use it. The Instructions
view (T6) will pass the same hook with its own view name.

**The instruction inventory (main, T5).** `src/app/instruction-files.js`. The scan helpers the Agent Files tab used
(`memoryBackends`, `visibleProjectPaths`, `storeFoldersFor`, `scanMdFiles`, `claim`, `collectSource`) moved there
unchanged; `plans-memory.js` requires them (the three that read the registry or the db take the caller's ctx), so the tab and
the inventory cannot answer differently until the tab goes. The module has its own `init`, called in `main.js`. `get-instruction-inventory(scope)` takes `'global'` or a registered project's path (an unregistered
path is refused) and answers `{ ok, rows, declines }`; a row is `{ id, name, kind, section, scope, ext, cli, clis,
sourceLabel, editable }`, with no path and no backend id.

- Sources, in this order so a file is claimed by its real kind first: the listing kinds `memory` (an instruction file,
  row kind `instructions`), `settings` (files only), `memory-store` (expanded, row kind `memory`), `output-style` and
  `resource` (expanded), through the same listing seam as the Plugins views; then every descriptor's `memorySources(scope)`
  with the store folders from the db, for what the listing did not name (Claude's `.claude/*.md`, Hermes' five names). A
  directory source outside the project is the CLI's own store for it (Claude's auto memory) and files under it are
  Memory; this is decided by where the source is, never by a backend id.
- One row per real path; every CLI that names a file is in `clis` (Pi lists `AGENTS.md` and `CLAUDE.md` with Codex and
  Claude). A file an agent, command or rule row owns is left out, which fixes the Agent Files defect where
  `.claude/commands/*.md` showed up as instructions. The Codex global `AGENTS.md` and the agy global `GEMINI.md`, which
  Agent Files dropped, are listed.
- Every listed file is a row, as in Agent Files. `editable` is true only for `.md .markdown .json .toml .yaml .yml` and
  `.cursorrules` (under 1 MB); any other row (agy's built-in resource files) can be read when it is text and is never
  saved. The sections are Instructions, Memory, Settings files, Output styles, and Resources. **Decision (owner-confirmed
  deviation from the plan):** Resources is a fifth section, for agy's built-in and implicit files; the plan had none. A CLI with no row and no listed source for the scope lands in `declines` ("<CLI> keeps no instructions here.").
- Doors: `read-instruction(id, scope)` and `save-instruction(id, scope, content, baseline)` re-list on every call and take
  a row only by equality of its id (a global id is not found in a project scope). The save needs a baseline and goes
  through `safe-write.js` (stale baseline answers `{ ok: false, conflict: true, diskContent }` and writes nothing, the
  file's EOL and BOM kept) with `format-validate.js`; a file over 1 MB or with a NUL byte is refused, and so is content with a NUL byte. There is no create and
  no delete. `locate-instruction(path, projectPath)` answers `{ id, scope, projectPath }` for a path that is a listed file
  (equality on the real path), else null. `match-instruction-content(scope, query)` runs T4's matcher over the scope's files.

### The Instructions category (T6, `panels/settings-instructions.js`)

- Its own nav item (`instructions`, P1) in both windows, after the Plugins group, with its own section; it is in `SETTINGS_SEED_CATS` (main) and in `settingsPlugins.SEED_CATS` (renderer), which a test compares both ways.
- One kit view over `pluginsViews.mountItemView` (new optional `matchContent` in its cfg for the content filter), sections Instructions, Memory, Settings files, Output styles, Resources (a section only when it has rows), chips by CLI, the `declines` lines, the editor with the conflict UI for an editable row and the read-only viewer for any other. No New and no Delete (`probeCreate` answers false, no row is `deletable`). A save refused by format validation shows main's reason where the editor shows any refusal.
- Scope (P9): the global window asks `getInstructionInventory('global')`, a project window its project path. A line above the list points to the other scope: a project window has "Open the global instructions", the global window a project picker and "Open its instructions". Either replaces the window, so `leave()` is asked first and a dialog warns, as in the MCPs hand-off.
- Read on the first `settings-cat-shown`, never at bind; the nav badge is the row count (`data-count-own`). It joins `leave()` through `pluginsKit.viewsIn`, so Cancel, Save, Apply and the settings search ask it too. `settingsPlugins.bind` calls `settingsInstructions.bind`.

## Known gaps

- A CLI's listing only includes a directory that exists, so a CLI whose commands directory has not been created yet
  declines until it does, unless it declares a scaffold.
- The deep link to a file, the sidebar group, and removing the Agent
  Files tab are later steps of the plan and are not built.
