# 40 — The Plugins manager: five compact views over the inventories Switchboard already has

Issue #803. Status: **built** (see "As built" and "Known gaps"; the working plan was
`docs/plans/803-plugins-manager/PLAN.md`, local). This restores the unified manager chosen in #789's design note (D1)
and narrowed by [spec 36](36-external-mcp-servers.md) D-B3. It is separate from #507. The owner decisions below are
binding; E1 to E10 were answered by the owner on 2026-11-02 (see "Decided by the owner").

Reflex 16 applies: a first-class entry point, a master-detail flow and a cross-backend skill inventory are new user
flows and a new contract. The plan states pros, cons and alternatives for each.

## What changes for the user

A **Plugins** group in Settings (entry points in "Where it is reached") with five views: **Plugins**, **Apps**,
**MCPs**, **Skills**, **Marketplace**. Each view is a compact list with a count and a filter box. A row is one line.
Selecting a row opens that item's own detail page (with a Back control); everything verbose lives there.

| View | A row says | The detail page holds |
|---|---|---|
| Plugins | name, backend label, scope, state | path, what it brings (skills, commands), Open |
| Apps | name, backend label, state | whatever the backend declares; nothing else is invented |
| MCPs | name, transport, one concise state, **enable switch** | the facts lines (command found, variables, which backends take it), backends, Edit (the existing form), Remove, the "not used at launch" reason |
| Skills | name, source label, scope | path, invocation per backend, backend compatibility and effective delivery, an editor on the page (E11) |
| Marketplace | name, runtime, one state in words (registry hits: **Unverified**) | summary, source, licence, install and uninstall commands with Copy, Add to project |

## Decided (owner; binding)

| | Decision | Source |
|---|---|---|
| D1 | The five views and the compact list density are the required direction. No large per-item cards, no expanded fields in an overview. | #803 comment 2 |
| D2 | An MCP row is one line: identity, concise state, enable switch. Description, reachability, commands, configuration, Edit and Remove sit on the detail page. | #803 comment 2 |
| D3 | Machine-wide discovery and install stay apart from per-project enablement. A server's on/off is saved only with that project's settings. | #789/#790, #803 |
| D4 | A skill is one neutral inventory row with source and scope, never one UI record per backend. Discovery and delivery run through the core; invocation, injection, flags, paths and formats stay in the target backend's descriptor. The detail page shows compatibility from facts main serves. | #803 comment 3 |
| D5 | Reuse, do not rebuild: resource listing, Agent Files skill editing (superseded by E11: the skill is edited on its own page), the project MCP editor, the reviewed catalog, the official-registry search. | #803 |
| D6 | No new IPC handler in `src/main.js`; no backend id in the renderer; CLI-read files only through `src/app/safe-write.js`; a setting change goes into `docs/settings-reference.md`; English everywhere. | CLAUDE.md |
| D7 | **The visual reference is a screenshot the owner supplied** (an MCPs view, kept locally with the plan). One **Plugins** menu item with sub-items (Plugins, Apps, MCPs, Skills, Marketplace), which matches E7. Taken over: a page head with title, one-line subtitle and header actions (browse, Add); a filter box under it; a view split into labelled sections (MCPs: configured servers, then servers that come from plugins); rows grouped in one rounded container with thin separators; per row a settings icon that opens the detail page and the enable switch. Sections the reference shows without a Switchboard source (for example MCP app data) are not copied; whether a "From plugins" MCP section has a source is checked in T7. Styling reuses the settings screen's existing tokens (reflex 8). | Owner, 2026-11-02 |

## Seams reused (file:line at the time of writing)

| Need | Existing seam |
|---|---|
| Plugin/package/extension rows | `listResources` per backend, `src/app/backend-resources.js:31`; IPC `backend-list-resources` (`:431`), preload `backends.listResources` (`src/preload.js:33`) |
| Backend skills for one scope, with `skillInvocation` | `backendSkills`, `src/app/skills.js:75` |
| The app's own skills | `ownSkills`, `src/app/skills.js:125` |
| Skill dedupe by path | `getSkills`, `src/app/skills.js:145` |
| Skill editing (safe-write, baseline, atomic rename) | `readResource` / `writeResource`, `src/app/backend-resources.js:162` / `:222`; whether editable: `editableHere` (`:204`) |
| What a target takes from another backend (skills, trust, declines) | `sourcesFor` / `resolve` / `preview`, `src/app/resource-sources.js:61` / `:95` / `:342`; descriptor fields `sharedResources`, `acceptsSharedResources`, `trustsProjectResources`, `declinesSharedResource` (spec 31, "The seam") |
| Where session resources are delivered | `buildSessionResources` call, `src/app/terminal/spawn.js:1012` |
| Plugin enabled state (Claude and Codex read it internally, neither exposes it; F4) | `enabledPluginMap`, `src/backends/claude/plugins.js:48`; `enabledInstallKeys`, `src/backends/codex/plugins.js:56` |
| Project MCP list, validator, form, facts | `src/renderer/panels/settings-external-mcp.js`: `buildCard` `:258`, `renderCards` `:307`, `openForm` `:438`, `factLines` `:98`, `bind` `:635`, `read` `:660`; the textarea is the store (spec 36 D-B1, D-B7) |
| Catalog, PATH check, registry search | `bindAddons` `:842`, `addonRow` `:722`, `registryResult` `:817`, `copyText` `:683`; `src/shared/mcp-addon-catalog.js`; `src/app/external-mcp-check.js`; `window.api.searchMcpRegistry` |
| Settings window, nav, lazy show | `src/renderer/panels/settings-global-html.js:92` (Extensions group), `settings-panel.js` `wireTwoPane` `:457`, `settings-cat-shown` `:509`; `src/app/windows.js:110` (`openSettingsWindow(scope, path, seed)`) |

## Facts (T1)

Checked against the code at HEAD aa59e114. Research only.

**F1. Agent Files does NOT list or open Switchboard-owned skills. E5 premise failed; the owner re-decided E5 (option a, see "Decided by the owner").**
- `ownSkills` (`src/app/skills.js:125`) is called only by `getSkills` (`src/app/skills.js:150`); nothing else reads the app's skills directory (`switchboardSkillsDir`, `src/app/skills.js:52`).
- Agent Files groups come only from `memoryBackends()` (`src/app/plans-memory.js:204`) through each descriptor's `listResources` (`src/app/plans-memory.js:437`, `:441`). No group is built for the skills directory, so no row exists to select (`openMemory`, `src/renderer/views/plans-memory-view.js:817`).
- The path-level door is closed for the default directory: `readMemory` / `saveMemory` (`src/app/plans-memory.js:1240`, `:1261`) allow only `.md` under a backend memory root or a registered project or an active session's project (`src/app/plans-memory.js:1199`, `:1216`). The default `<data dir>/skills` is none of those. A project-relative `skillsDir` inside a registered project would pass that check, but is still never listed.
- Backend-owned skills are listed and editable there (`readResource` branch, `src/renderer/views/plans-memory-view.js:826`), but the Switchboard row has no `backendId`, and `backend-open-resource` / `readResource` need one (`src/preload.js:40`).
- Information only, not a redesign: the generic file panel opens any non-sensitive path with the same `safe-write` baseline (`read-file-for-panel` / `save-file-for-panel`, `src/main.js:987`, `:1022`), but it is a per-session preview tab (`openFileInPanel(sessionId, filePath)`, `src/renderer/views/file-panel.js:796`), not Agent Files, and a Settings relay would need a session to host it.
- A main relay to the main window's Agent Files would therefore need new work beyond the relay: a Switchboard-skills group in `get-memories` (or an equivalent listing) plus a read/save door for the skills directory. That is a decision for the owner (E5), not for this plan.

**F2. `resolve` cannot answer for one skill row; a pure helper beside it is needed.**
- `resolve` (`src/app/resource-sources.js:95`) is async and answers per (target, source) pair for a whole launch: `skills: [{ path, scope }]` are listing directories, not skill files (`src/app/resource-sources.js:165`), and `dropped` entries are keyed by directory path and kind. It never reads which source the target is configured for; the caller passes `sourceId` (Pi's `resourcesFrom` select, `src/backends/pi/index.js:129`; `src/backends/pi/session-resources.js:28`). `sourcesFor` skips the target itself (`src/app/resource-sources.js:67`), so "native" is not an answer it gives.
- Helper (planned T3, beside `resolve`): `skillDeliveryFor({ skillFilePath, ownerBackendId, listingSource, scope, targetId, sourceId, projectPath, options })` returning `{ state: 'native' | 'shared' | 'declined' | 'none', reason?, note? }`. `native` when `targetId === ownerBackendId`; otherwise run `resolve({ target, sourceId, projectPath, options })` and match the skill file by containment (`isAtOrInside`, `src/app/path-containment.js:79`) under a returned `skills[].path` (`shared`) or a `dropped` entry of kind `skill` (`declined` / `untrusted-project`); `none` when the target has no source set, or the source is not `ownerBackendId`. `text` for a Switchboard skill needs no helper (no owner id).
- The row must carry the owner id and the listing `source` inside main: `skillRow` today has `backendId` but no `source` (`src/app/skills.js:64`, `:106`).

**F3. Plugin and package rows, per backend (`listResources`, `src/app/backend-resources.js:31` hands back the descriptor's answer unchanged).**
- Row shape for all: `{ kind, scope, name, path, source, description, originLabel }` (`src/backends/claude/resources.js:71`; Codex `src/backends/codex/resources.js:31`; agy `src/backends/agy/resources.js:37`; Pi `src/backends/pi/resources.js:45` without `originLabel`). Since O5 a Claude or Codex plugin skill directory also carries `fromPlugin: true`.
- Claude: ONE `kind: 'plugin'` row for the `plugins` directory (`source: 'plugins-directory'`, `src/backends/claude/resources.js:23`); individual plugins appear only after `expandResource` (`dirs` mode, one entry per subdirectory, `src/backends/resource-expand.js:119`). Installed AND enabled plugins that ship skills are `kind: 'skill'` rows with `originLabel: "Plugin <name>"` (`:118`), not plugin rows.
- Codex: the same two shapes (`src/backends/codex/resources.js:95`, `:99`; `originLabel` `:73`). Hermes: one `kind: 'plugin'` directory row only (`src/backends/hermes/resources.js:73`). agy: one `kind: 'plugin'` directory row under `config/plugins` (`src/backends/agy/resources.js:101`); its listing is documented as never complete.
- Pi: `kind: 'package'` rows for configured values of `settings.json` `packages` (`name` = the configured string, `path: null`, `source: 'settings.json:packages'`, `src/backends/pi/resources.js:63`), and `package` directory rows for `npm` / `git` under the agent directory (`:85`, `source: 'installed-directory'`); `extension`, `theme`, `skill`, `prompt-template` rows likewise from settings and directories.
- No row anywhere has an `enabled` field. So a plugins-inventory row cannot take its state from the listing (F4). **As built (T4):** not the `dirs` expansion either — expanding Claude's or Codex' plugins directory one level lists cache and marketplace folders, not installs. The install record is the only source of a plugin's real name, its scope and its state, so those two backends answer a hook instead (F4). The other backends are shown from their listing rows: a directory row read one level through the backend's own `expandResource`, a directory the backend has no rule for (Pi's installed `npm`/`git` package directories) as one entry, a row without a path as one entry.

**F4. Enabled state: Claude and Codex read it internally; no descriptor exposes it.**
- Claude: `enabledPluginMap` merges `enabledPlugins` of the user, project and local settings (`src/backends/claude/plugins.js:48`); used only to filter plugin skill rows (`:91`).
- Codex: `enabledInstallKeys` reads `[plugins."<name>@<marketplace>"] enabled = true` from `config.toml` (`src/backends/codex/plugins.js:56`, `:61`); used only to filter (`:155`). The spec's "only Claude" was therefore too narrow; both could answer a state, neither does.
- agy: `config/config.json` holds a `plugins` map keyed by directory name that is deliberately not read (`src/backends/agy/resources.js:94`). Hermes and Pi declare nothing.
- Consequence for T4 (E6 = read-only chip), **as built**: the hook is `listPlugins({ projectPath })` → `{ ok, plugins: [{ name, scope, state, path, brings }] }` — the install list and the state in one answer, read in the backend's own folder (`listInstalledPlugins` in `src/backends/claude/plugins.js` and `src/backends/codex/plugins.js`). Claude and Codex answer it, their drivers forward it, agy, Hermes and Pi declare `null`; `listApps` is declared `null` by every backend (E3). `test/backend-parity.test.js` makes each backend answer both, a template does not inherit them, and `src/app/plugins-inventory.js` shows a declining backend from its listing with the state "not reported".

## Premises of #803 that do not match the code

1. **There is no cross-backend skill inventory.** `getSkills` answers for one `backendId` (`src/app/skills.js:145`); a
   row carries `backendId` (`:64`). "Represented once" needs a new neutral aggregation in main (plan T2), built from
   `backendSkills` and `ownSkills`. It does not exist to reuse.
2. **A Switchboard-owned skill is always `scope: 'global'`** (`src/app/skills.js:133`), even when `skillsDir` is a
   project-relative path. The inventory must either keep that and say so or fix it (plan T2, E4 neighbour).
3. **Spec 36 D-B3 (`36-external-mcp-servers.md:256`) says the five-tab manager is "not adopted", and D-B4 says
   "Per project only. No global or personal list".** D-B3 is superseded by this spec and is amended in place when the
   build lands. D-B4 stays true: there is no machine-wide MCP list, so the MCPs view is per project (E8).
4. **Agent Files lives in the main window**; the Settings window (`settings.html`) has neither it nor a path to it.
   `backend-open-resource` needs a backend id (`src/preload.js:40`), and a Switchboard skill has none. "Edit from the
   skill detail" therefore needs a relay (E5). **T1 found that Agent Files does not list Switchboard skills at all (F1), so
   a relay alone does not open one.** E5 was re-decided and then superseded by E11: a skill is edited on its own
   detail page in Settings, so no relay was built (see "Decided by the owner").
5. **The project settings category called "Skills" (`settings-panel.js:639`, `:729`) is the `skillsDir` path field**,
   not a skill list. The new view needs another category id.
6. **Apps have no data source.** No descriptor declares apps or connectors; claude.ai connectors are only visible in a
   live claude-native session's MCP status (`src/backends/claude-native/rpc-protocol.js:1173`), not as an inventory.
   Apps ship as a view with an honest empty state and an optional descriptor hook (E3).
7. **"Toggle" on plugins and skills (the reference) has no seam.** The only plugin enable state is read from the
   CLI's own settings (`claude/plugins.js:45`); writing it would be a new contract (E6). A skill has no on/off at all (E10).

## Shape

Three layers, so the structural choice (E1) touches only the third.

1. **Main (`src/app/`).** `getSkillInventory` and a skill-detail answer (compatibility and effective delivery) in or
   beside `skills.js`; a `plugins-inventory` module for plugins and apps rows; both over the existing descriptors. They
   return display facts (labels, states, sentences); the renderer compares no backend id and derives no path.
   Bindings go in `src/preload.js`; nothing in `src/main.js` beyond the existing three-line wiring pattern.
2. **Renderer kit.** One small module for the list-to-detail interaction (compact row, filter, count, detail page,
   Back, keyboard), used by all five views so they cannot drift. Controls reuse `.settings-toggle`,
   `.settings-action-btn`, `.sv-mcp-chip`, `.settings-label`.
3. **Shell.** Where the five views sit and how the user gets there (E1, E7).

The MCPs and Marketplace views are the **existing** project MCP editor and global catalog re-presented: the card list
becomes a row list, the card's verbose parts move to the detail page, and the add/edit form, the textarea store, the
validator, the facts lines, the PATH check, Copy and the registry search are the same code. Nothing is duplicated.

### Skill delivery, from facts the descriptors already declare

For each built-in target backend, main answers one of: *native* (the skill is in that backend's own store), *shared*
(the target accepts skills and a source backend offers this row, trust allows its scope, nothing declines it),
*text only* (a Switchboard skill: handed over as text, no invocation), *declined* (with the descriptor's own note), or
*not offered*. It also serves the `skillInvocation` string where there is one. "Effective" depends on the target's
configured resource source (one source at a time, spec 31 E9), so the detail page names the project the answer is for.
No backend adds a hook for this: T1 found every fact already declared, but `resolve` answers per directory, so a pure helper is
needed beside it (F2).

## Decided by the owner (2026-11-02)

E1 to E10 were put to the owner with options; every one was answered as recommended:

| ID | Decision |
|---|---|
| E1 | A Plugins group in the existing Settings window (no standalone window, no third writer of `externalMcpServers`). |
| E2 | An MCP toggle is staged until Save (spec 36's contract). |
| E3 | Apps view present with an honest empty state, plus an optional `listApps` descriptor hook no backend implements yet. |
| E4 | One skill row per file path; same-name files elsewhere are marked "also named in". |
| E5 | Skill Edit hands off to Agent Files through a main relay; no second editor. Reopened by T1 (F1), because Agent Files listed and opened no Switchboard-owned skill. Re-decided 2026-11-02 (Agent Files group + widened memory door + relay). **Superseded by E11 on 2026-11-03** before it was committed. |
| E11 | (2026-11-03) The sidebar's Agent Files is the old surface; Settings → Plugins is the new one. A skill is **edited on its own detail page** in the Skills view. Reads and saves go through `read-skill` / `save-skill` in `src/app/skills.js`, named by inventory ID: the app's own skill through `safe-write.js`, a backend's through `src/app/backend-resources.js` for the first owner whose `resourceEditing` takes it. No relay to the main window. |
| E12 | (2026-11-03) Once the Plugins manager is built, the sidebar's Agent Files **stops listing skills and plugins**; it keeps instruction files, settings files and handoffs. A step of its own (T12). |
| E13 | (2026-11-03) The sidebar gets **no** "Switchboard skills" group; the memory door is not widened. |
| E14 | (2026-11-03) A `skillsDir` at, inside or above a backend's own directory is **refused** for editing — those files belong to that CLI and its own door decides. Also refused, for the editor and the picker's walk alike, on the real path: a network path, a filesystem root (a junction to one included), the home directory and anything above it. |
| E15 | (2026-11-03) E12 takes out of the sidebar what the Skills view replaces, and nothing more: the `skill` kind. Commands, agents, rules and Hermes' skill bundles stay in Agent Files, because no view here lists them. First the Skills view gets "New skill" (the sidebar's only way to create one), then the sidebar drops skills. |
| E16 | (2026-11-03) The Skills page also gets **Delete**, which the sidebar offered: for a CLI's skill where Edit is offered, after a confirmation. The app's own skills are not deleted here, and neither is a plugin's (O5, 2026-11-03): a backend marks a listed folder a plugin installed and keeps with `fromPlugin` (Claude, Codex), and no Delete is offered there, because the plugin's next update would bring a deleted skill back. |
| E17 | (2026-11-03) Accepted: with skills gone from Agent Files, the app search no longer finds text inside a skill. The Skills view's filter matches name and source only. |
| E6 | Plugin state is read-only; Switchboard does not write a CLI's plugin settings. |
| E7 | Five nav items under a "Plugins" head, not a tab strip. |
| E8 | The global window's MCPs view explains the per-project list and offers a project picker. |
| E9 | Marketplace in a project window adds directly to that project (staged); the global hand-off stays. |
| E10 | No skill enable switch in v1; a neutral disabled-skills setting would be its own issue. |

## Verification

Renderer tests (jsdom) for navigation, counts, density, master-detail, toggles and scope; main tests for the
inventory and delivery tables pinned per backend; a live click test on the demo instance (`npm run demo:start`) after
each renderer step. No model turn was started.

## As built

Built 2026-11-02 to 2026-11-03 in steps T1 to T10 of the plan, each one verified and click-tested before its commit.

| Part | Where |
|---|---|
| The neutral skill inventory: one row per file path, source label, scope, `alsoNamed`, `editable`; the owner backends stay in main | `getSkillInventory` and IPC `get-skill-inventory` in `src/app/skills.js`; `test/skill-inventory.test.js` |
| What one skill is to each target backend (`native`, `shared`, `text`, `declined`, `none`) with the sentence and the invocation | `src/app/skill-delivery.js` (pure), IPC `get-skill-detail` in `src/app/skills.js`; `test/skill-delivery.test.js` |
| The skill editor's door (E11, E14): read and save by inventory ID, never by path | `read-skill` / `save-skill` in `src/app/skills.js`; the app's own skills through `src/app/safe-write.js`, a backend's through `src/app/backend-resources.js`; `test/skill-editor-door.test.js` |
| "New skill" (E15): the places a backend's `skill` scaffold claims, by opaque id; the file from that scaffold | `get-skill-places` / `create-skill` in `src/app/skills.js` over `createResource` in `src/app/backend-resources.js`; the form in `src/renderer/panels/plugins-views.js`; `test/skill-create.test.js`, `test/plugins-views.test.js` |
| Delete (E16, O5): `deletable` on a row is a CLI's skill whose door admits Edit, in a folder its listing does not mark `fromPlugin`; the folder goes through `deleteResource` | `delete-skill` in `src/app/skills.js`; the button and confirmation in `src/renderer/panels/plugins-views.js`; `test/skill-create.test.js`, `test/plugins-views.test.js` |
| The sidebar drops skills (E12, E15) | `skill` is out of `TAB_KINDS` in `src/app/plans-memory.js`; `test/plans-memory-resource-groups.test.js` |
| Installed plugins and reported apps | `src/app/plugins-inventory.js` (IPC for both lists and `open-plugin` by ID); descriptor hooks `listPlugins` (Claude and Codex answer, their drivers forward) and `listApps` (no backend answers yet); `test/plugins-inventory.test.js`, `test/backend-parity.test.js` |
| The list-to-detail kit: compact row, filter, count, detail page, Back, keyboard, `canLeave` | `src/renderer/panels/plugins-kit.js` (`window.pluginsKit`); `test/plugins-kit.test.js` |
| The Plugins, Apps and Skills views, the skill editor on the Skills page | `src/renderer/panels/plugins-views.js` (`bindLazy`, `mountPlugins`, `mountApps`, `mountSkills`); `test/plugins-views.test.js` |
| The MCPs view (project window) and the Marketplace | `src/renderer/panels/settings-external-mcp.js` (rows over the kit; `bindAddons(..., { projectAdd })` for E9); `test/settings-mcp-addons.test.js`, `test/settings-mcp-addon-handoff.test.js` |
| The nav group, the sections, counts, the global MCPs picker (E8), `leave()` | `src/renderer/panels/settings-plugins.js` (`window.settingsPlugins`), used by `src/renderer/panels/settings-global-html.js` and `src/renderer/panels/settings-panel.js`; `test/settings-plugins.test.js`, `test/settings-plugins-panel.test.js` |
| Deep link to a view | `openSettingsWindow(scope, path, { cat })`, validated against `SETTINGS_SEED_CATS` in `src/app/windows.js`; the renderer's list is compared with it both ways in `test/settings-plugins.test.js` |
| Entry points | the "Plugins" head in both settings windows; the command palette action "Open Plugins" in `src/renderer/app.js` (the global window on Plugins) |

The category ids are `plugins-plugins`, `plugins-apps`, `plugins-skills`, `mcp-addons` (Marketplace, the spec 38 id
kept) and, for MCPs, `mcp` in a project window and `plugins-mcps` in the global one.

What differs from the design above, and why:

- **No "From plugins" MCP section** (D7). No source names a plugin's MCP servers one by one; the plugin inventory only
  says that a plugin brings MCP servers.
- **States are words in the row, not chips.** D1 asks for one compact line, and a chip per row was wider than the text
  it carried. A registry hit still reads **Unverified**.
- **Plugin rows come from the install record, not the directory listing** (F3, F4). Expanding Claude's or Codex' plugins
  directory lists cache and marketplace folders. A backend that declines `listPlugins` is shown from its listing with
  the state "not reported".
- **A skill is edited on its own page (E11)**, not in the sidebar's Agent Files. The editor is the file panel's
  CodeMirror viewer, loaded at run time from `codemirror-bundle.js`. A conflict shows the text on disk read-only and
  offers "Save mine over it" or "Load the version on disk"; one save runs at a time.
- **Views read lazily.** Plugins, Apps and Skills read on their category's first `settings-cat-shown`, never when the
  window opens; a nav badge stays empty until its view has read. The Marketplace badge counts catalog rows, never
  registry hits.
- **Leaving asks first.** Cancel, Save, Apply, Hide Project, Remove Project, the settings search and both hand-offs to a
  project's window call `leave()`. It asks every view before it moves any (`canLeave` on the kit's handle), so a skill
  page with unsaved text refuses with every other page left as it was, and the screen switches to it. The settings
  search also sends every view back to its list and clears its own filter, without taking the caret from the search.
- **An unknown `cat` in a deep link is ignored**, in main and in the renderer.

## Backend filter (#824)

A row of chips above each list (Plugins, Apps, MCPs, Skills; not the Marketplace), one per CLI that has rows there, each
with its count. Several chips can be on; none on means all; the chips AND with the text filter. The row shows only when
there are two or more CLIs.

- **A group is a CLI, not a backend id.** A driver (the native GUI backends) is its owner's chip; the one answer is
  `cliOwnerOf` in `src/backends/index.js`. Main stamps a neutral `cli: { key, label }` (owner id as an opaque key, the
  owner's label) on each plugin row (`src/app/plugins-inventory.js`) and app row. The window never reads the key's
  meaning.
- **Skills carry `clis: [{ key, label }]`** (`src/app/skills.js`): one skill file can be reported by several CLIs, so it
  sits under each of their chips (`alsoNamed` lists other *files* of the same name and is not used for grouping). The
  app's own skills answer the neutral key `switchboard` (label "Switchboard"), which is no backend id.
- **MCPs** target backends through `raw.backends`. The renderer maps each id to its CLI from the same
  `window.api.backends.list()` it already reads (owner = `transcriptsOf || id`, label from the owner's entry); an id the
  list does not know is its own chip, and a template's id shows as its own label there (known gap). An entry without
  `backends` serves every CLI: no group, passes any selection, counted under no chip. `backends: []` is not "all": the
  launch (`entryAppliesTo`) applies it to no backend, so the view gives it a group of its own, "No backend", shown only
  with no chip on or that chip on. No chips are drawn until the backend list has resolved.
- **Kit hook** (`src/renderer/panels/plugins-kit.js`): optional `rowGroups(row) -> [{ key, label }]` and `filterKey`.
  The selection lives in a module-level Map keyed by `filterKey` (fallback: the view's title), so a view that re-mounts
  keeps the choice while the window is open; it is not stored on disk. A stored key whose group is gone, or fewer than
  two groups, applies no filter. A row matches when any of its groups is on; a row with no groups always matches.
- **Counts** are over all rows, not narrowed by the text; the list count reads `n of m` while a text or a chip narrows.
- **`clearFilter` clears the text only; the settings search suspends the chips.** That search shows and hides rows that
  are drawn, so a row a chip excluded would never be found. While it runs the views get `suspendGroups(true)` (from
  `settingsPlugins.leave({ clearFilter: true })`): the chips narrow nothing and the chip row is hidden beside the filter
  row. The stored choice is kept and applies again when the search is cleared (`resume()`).
- **Styling** reuses the toggle chips of the MCP form (`settings-action-btn sv-mcp-chip`, `.active`, `aria-pressed`);
  `.plugins-chip-row` only places the row.

## Agents, Commands, Rules (#823)

Three more items under the Plugins head, in both windows: `plugins-agents`, `plugins-commands`, `plugins-rules` (in
`SETTINGS_SEED_CATS` and in the renderer's list, compared both ways by `test/settings-plugins.test.js`). The inventory and
the doors are spec 44's; this section is the page.

- **One builder.** `panels/plugins-resources.js` (`window.pluginsResources.mountResourceView(view)`) hands
  `pluginsViews.mountItemView` its door and its sentences. `mountItemView`, `itemEditor` and `newItemForm` in
  `panels/plugins-views.js` are the Skills page's list, detail page, editor, conflict UI, New form and Delete confirmation,
  extracted and parametrised with a noun and a door (`io`); Skills uses the same functions, so nothing is copied.
- **Rows** come from `getResourceInventory(view, projectPath)`, grouped "This project" / "Global", with the #824 CLI chips
  from `clis` (filter key `resources-<view>`). A file two CLIs name sits under both chips. The detail page shows Source,
  From (when the origin differs) and Kind; main sends no path.
- **Edit** where the row is `editable` (the same editor, read and saved by id with the view named, baseline compare,
  conflict answer as for a skill). A row that is not editable (a hook, a kind the CLI does not let Switchboard edit) shows a
  sentence and its text in the same CodeMirror setup, read-only (no Save, no Discard; this holds for a Skills page too),
  and one that came with a plugin says to change it there. The syntax comes from the row's `ext` (main sends the
  extension, never the path).
- **Delete** where the row is `deletable`, after a confirmation naming the item and its source; never a plugin's item,
  never a hook (main decides, the button follows the flag). **New** shows where `getResourcePlaces` offers at least one
  place (probed after the list is drawn, so an empty folder still offers it); the form is the Skills form with the places
  main offers.
- **Declines.** A line per CLI main reports in `declines` ("Codex keeps no agents here.") sits under the list.
- **Lazy and counted.** The first read is the category's first `settings-cat-shown`, never bind; the nav badge is the row
  count (`data-count-own`); `leave()` and `pluginsMayLeave` reach these pages through `pluginsKit.viewsIn`, so unsaved
  text refuses Cancel, Save, Apply and the settings search as it does on the Skills page.
- **A redraw starts from the rows on screen**, never from the first read: the New probe resolves after the list is drawn
  and must not bring back a row deleted or created in between.
- **Not here yet.** The filter matches name and source only; matching file content is #823 T4.

## Known gaps

- **E12 is narrowed by E15.** The sidebar's Agent Files no longer lists skills, but still lists commands, agents,
  rules and Hermes' skill bundles: no view of the Plugins manager lists those.
- **The app search does not find text inside a skill** (E17, accepted). Agent Files indexed it; the Skills view's
  filter matches name and source only.
- **The window's title-bar X does not ask.** It hides the settings window, and unsaved skill text is lost. The same is
  true of any unsaved setting there; it predates this spec.
- **The two hand-offs to a project's window have no panel test** of the refusal; Cancel, Save, Apply, Hide, Remove
  and the search do (`test/settings-plugins-panel.test.js`).
- **One inventory call lists each backend up to three times**, and each skill read or save rebuilds the inventory. Both
  run only on a click; share the listings if it shows.
- **A deep link with `cat` to a settings window of the same scope that is already open only raises it**; the category
  does not change.
- **Apps is empty for every backend** until one answers `listApps` (E3).
- **Plugin state is read-only** (E6), and a skill has no on/off (E10).
- **The CodeMirror loader exists three times** (`src/renderer/panels/plugins-views.js`, `src/renderer/views/viewer-panel.js`, `src/renderer/diff-window.js`).
