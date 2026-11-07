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
view. One row per real path. A row is `{ id, name, kind, scope, sourceLabel, originLabel, cli, clis, editable, deletable,
fromPlugin, creatable }`:

- `id` is a hash of the path's `pathKey`; no path and no backend id field leave main. The owner CLI's id travels only
  as the opaque `cli.key` of the #824 stamps (spec 40).
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

## Known gaps

- A CLI's listing only includes a directory that exists, so a CLI whose commands directory has not been created yet
  declines until it does, unless it declares a scaffold.
- The reading and writing door by id, the three views, the content filter, the Instructions inventory and category, the
  deep link, the sidebar group, and removing the Agent Files tab are later steps of the plan and are not built.
