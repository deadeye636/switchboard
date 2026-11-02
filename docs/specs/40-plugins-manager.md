# 40 — The Plugins manager: five compact views over the inventories Switchboard already has

Issue #803. Status: **planned** (design only; building needs the owner's go; the working plan is
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
| Skills | name, source label, scope | path, invocation per backend, backend compatibility and effective delivery, Edit (hand-off to Agent Files) |
| Marketplace | name, runtime, one state chip (registry hits: **Unverified**) | summary, source, licence, install and uninstall commands with Copy, Add to project |

## Decided (owner; binding)

| | Decision | Source |
|---|---|---|
| D1 | The five views and the compact list density are the required direction. No large per-item cards, no expanded fields in an overview. | #803 comment 2 |
| D2 | An MCP row is one line: identity, concise state, enable switch. Description, reachability, commands, configuration, Edit and Remove sit on the detail page. | #803 comment 2 |
| D3 | Machine-wide discovery and install stay apart from per-project enablement. A server's on/off is saved only with that project's settings. | #789/#790, #803 |
| D4 | A skill is one neutral inventory row with source and scope, never one UI record per backend. Discovery and delivery run through the core; invocation, injection, flags, paths and formats stay in the target backend's descriptor. The detail page shows compatibility from facts main serves. | #803 comment 3 |
| D5 | Reuse, do not rebuild: resource listing, Agent Files skill editing, the project MCP editor, the reviewed catalog, the official-registry search. | #803 |
| D6 | No new IPC handler in `src/main.js`; no backend id in the renderer; CLI-read files only through `src/app/safe-write.js`; a setting change goes into `docs/settings-reference.md`; English everywhere. | CLAUDE.md |

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
| Plugin enabled state (Claude, read only) | `enabledPluginMap`, `src/backends/claude/plugins.js:45` |
| Project MCP list, validator, form, facts | `src/renderer/panels/settings-external-mcp.js`: `buildCard` `:258`, `renderCards` `:307`, `openForm` `:438`, `factLines` `:98`, `bind` `:635`, `read` `:660`; the textarea is the store (spec 36 D-B1, D-B7) |
| Catalog, PATH check, registry search | `bindAddons` `:842`, `addonRow` `:722`, `registryResult` `:817`, `copyText` `:683`; `src/shared/mcp-addon-catalog.js`; `src/app/external-mcp-check.js`; `window.api.searchMcpRegistry` |
| Settings window, nav, lazy show | `src/renderer/panels/settings-global-html.js:92` (Extensions group), `settings-panel.js` `wireTwoPane` `:457`, `settings-cat-shown` `:509`; `src/app/windows.js:110` (`openSettingsWindow(scope, path, seed)`) |

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
   skill detail" therefore needs a relay (E5), and whether Agent Files lists Switchboard skills at all is checked in T1.
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
No backend adds a hook for this unless T1 finds a fact that is not already declared.

## Decided by the owner (2026-11-02)

E1 to E10 were put to the owner with options; every one was answered as recommended:

| ID | Decision |
|---|---|
| E1 | A Plugins group in the existing Settings window (no standalone window, no third writer of `externalMcpServers`). |
| E2 | An MCP toggle is staged until Save (spec 36's contract). |
| E3 | Apps view present with an honest empty state, plus an optional `listApps` descriptor hook no backend implements yet. |
| E4 | One skill row per file path; same-name files elsewhere are marked "also named in". |
| E5 | Skill Edit hands off to Agent Files through a main relay; no second editor. |
| E6 | Plugin state is read-only; Switchboard does not write a CLI's plugin settings. |
| E7 | Five nav items under a "Plugins" head, not a tab strip. |
| E8 | The global window's MCPs view explains the per-project list and offers a project picker. |
| E9 | Marketplace in a project window adds directly to that project (staged); the global hand-off stays. |
| E10 | No skill enable switch in v1; a neutral disabled-skills setting would be its own issue. |

## Verification (planned)

Renderer tests (jsdom) for navigation, counts, density, master-detail, toggles and scope; main tests for the
inventory and delivery tables pinned per backend; a live click test on the demo instance (`npm run demo:start`).
No model turn is needed; if one is, the smallest model runs it.

## As built

Not built yet.
