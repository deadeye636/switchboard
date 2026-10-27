# 38 — MCP addon catalog: find an external MCP server, see whether it is installed, copy the command

Issue #790. Status: **planned** (nothing is built; the plan is `docs/plans/790-mcp-addons/`, local). This is the
install-side companion to [spec 36](36-external-mcp-servers.md): there a project names the servers it wants and
Switchboard puts them in front of a launched CLI; here the user finds one, learns whether it is on this machine, and
gets the exact command to install or remove it. Switchboard runs none of it. Spec 34 recorded the scope decision (D5,
"Later phases" item 6); this file is the design behind it.

Reflex 16 applies: a new settings category, an outbound request and a hand-off between two settings scopes are new
user flows. The decisions below are the owner's unless a row says otherwise; what is not decided is under "Open".

## What changes for the user

Global settings gain a category **MCP servers** ("Installed on this machine") in the Extensions group. It lists a
short, fixed catalog of servers kept in the repository. Each row says what the server is, where it comes from
(upstream URL), its licence, which runtime installs it, and whether that runtime and the server are found on this
machine. A row shows the exact install and the exact uninstall command with a **Copy** button. The user pastes it into
their own terminal. Switchboard never starts a package manager.

A row also has **Add to project**: pick a project, and that project's settings open on its *MCP servers* cards with the
Add form already filled in for this server. Nothing is stored until the user presses Save there. Installing is per
machine, enabling stays per project (spec 36, D-A2).

Below the catalog a **Search the MCP registry** box. It sends nothing until the user presses Search (or Enter in the
box). Results are marked **Unverified**, are plain text, and offer Copy at most: they cannot be added to a project from
here and are never run.

## Decided

| | Decision | Why |
|---|---|---|
| D1 | **Flow (b): show the command, never run it.** Install and uninstall are text with a Copy button. Switchboard starts no package manager. Flow (c), running it after a confirmation, is a separate later decision. | Owner (spec 34, D5). A package manager changes the machine outside the app's data directory. |
| D2 | **A static catalog in the repository, maintained by pull request.** Each entry: name, upstream source URL, licence, runtime (`uv` or `pipx`), install and uninstall command, and the stdio line a project card needs (command and arguments). Starts with the three servers the issue names: jcodemunch, jdocmunch, jdatamunch. | Owner (E31 a). A reviewed list is the only part Switchboard can stand behind. |
| D3 | **"Verified on <date>" lives in this spec, never in the UI.** The catalog verification table below records, per entry, the date the source, licence and commands were checked against upstream. | Owner (E31 a). A date on screen reads as a guarantee the app cannot keep. |
| D4 | **A public-registry search, only on an explicit click, results marked "Unverified".** Results are text with Copy; never run, never added to a project from here. Every registry string is escaped (set as text, never as markup); the command shape is validated in main before it reaches the renderer. | Owner (E31 b). The registry is third-party data; the catalog is the reviewed path. |
| D5 | **"Installed" is the PATH resolver's answer and nothing else.** Detection is `resolveCommand(s)` in `src/app/path-resolve.js`, no process started. "Not found" means "not found on PATH", with the evidence rules of spec 36 slice D (missing only with evidence, otherwise "not checked" and the reason). | Owner (E32 a). The resolver exists, starts nothing, and slice D already decided what counts as evidence of absence. |
| D6 | **The list lives in the global app settings; installing is per machine.** "Add to project" hands off to that project's existing external-MCP cards; enabling stays per project. | Owner (E33 b). One place for the machine, one place for the project (D-A2). |
| D7 | **Switchboard distributes nothing.** The catalog names upstream sources; an install pulls from the source the user pasted into their own terminal. Each row shows the licence as upstream states it, including a non-open one. | Owner (spec 36, D-A5; the issue). |
| D8 | **No stored state in v1.** No new setting, no new `SWITCHBOARD_*` variable, so `docs/settings-reference.md` is unchanged. Detection runs when the category is first shown and on **Check again**. | Planner, from E31 to E33: nothing in them needs to persist. Revisit if a stored choice is added. |
| D9 | **A catalog command is data, and one string for every shell.** The catalog stores a command as an argument list. A token may hold letters, digits and `. _ - @ : + = /` only, so the joined string means the same in PowerShell, cmd and POSIX shells. A test rejects any entry that breaks the rule. | Planner. Command text that quotes differently per shell is the worst failure mode of this feature: a user pastes it. |
| D10 | **A registry result carries a command only when main can build it from a validated field.** Main never forwards a command string taken from the registry as it came. A package whose registry or identifier main cannot build safely shows its identifier and source as text and no command. | Planner, from D4. The same rule as D9, for text nobody reviewed. |
| D11 | **Hand-off carries a catalog id, never text.** The seed that opens the project's Add form is the id of a catalog entry; the project window looks the entry up itself. A registry result has no hand-off (D4). | Planner. An id cannot smuggle a command into a form through a URL. |

## The catalog entry

One entry per server: `id` (the card name, matching the card name rule of spec 36), `name`, `summary`, `source`
(an `https` URL), `licence` (as upstream states it, text), `runtimes` (each: `runtime`, `install` and `uninstall` as
argument lists), and `stdio` (`command`, `args`: what the project card gets). `stdio.command` is the executable the
install puts on PATH, which is also the name detection looks for. The entry reaches the project's form through the
existing form model (`entryToForm`/`formToEntry` in `src/shared/external-mcp-form.js`) and is checked by the one
validator (`validateExternalMcpServers`, spec 36 D-B7). The catalog adds no rule of its own to what a card may hold.

The runtime itself (`uv`, `pipx`) is looked up the same way, so a row can say "uv not found" before it offers an
install command that needs it.

## Detection

A row asks two questions of PATH: is the runtime there, and is the server's executable there. Both go through
`checkExternalMcp` (`src/app/external-mcp-check.js`): the catalog's commands become throwaway stdio entries and the
reply's `command` facts are read; the variable and backend facts are not used. The reply carries a state
(`found`, `missing`, `unknown`) and a reason code, which the renderer maps with the existing `reasonSentence`
(exported from `src/renderer/panels/settings-external-mcp.js`). The check runs when the category is first shown, not
when the window opens, and again on **Check again**. Open point O5 records why the existing IPC is used.

Two honest limits, both shown in the UI text:

- **It is the PATH Switchboard was started with.** A tool installed after the app started may not be visible until the
  app restarts. The sessions Switchboard launches use the same PATH, so the answer matches what a launched CLI would
  find.
- **Found is not working.** The executable exists; nothing was started, no version was read.

## The registry search

The request is made in main only (the renderer's CSP allows no outbound request) by a new `src/app/` module with one
IPC, bound in `src/preload.js`. It is a plain `GET` to one fixed host over `https`, with a timeout, a response-size
cap and no redirect to another host. The search term is the only thing that leaves the machine: it is sent to the
registry's operator, which is why the request is click-only and the box says so beside the button (O8). A stale reply
is dropped by a sequence number; an error is a fixed sentence through `src/app/readable-error.js`; results are an
`aria-live` region.

The reply main returns holds names, short descriptions, the source URL as text, and per package the registry name, the
identifier and, where D10 allows, a command. Strings are length-capped and stripped of control characters in main, and
set as text in the renderer. The registry is the official MCP Registry (O1); what its entries carry is under
"Registry facts" below.

## Hand-off to a project

The **Add to project** control is a project picker plus a button. It opens the project's settings
(`window.api.openSettingsWindow('project', path)`) with a seed naming the catalog id. The settings window is one
window: the call navigates it from the global scope to the project scope, as the project gear does today. The seed has
to survive that reload, and `settingsQuery` (`src/app/windows.js`) compares queries by their JSON, so it travels as a
query key (O2). The project window selects the *MCP servers* category and opens the Add form seeded from the catalog
entry. Save is the project window's own and persists the list as usual; Cancel stores nothing.

A project window already open with unsaved edits is reloaded by a seeded open and loses them, and so does the global
window the user is leaving (O3).

## Open

**Answered (owner, 2026-10-27): every point below as recommended, and D8 to D11 above are confirmed.** The
table keeps the reasoning; O1's facts are still to be read by the first plan step.

| | Open point | Recommendation |
|---|---|---|
| O1 | **Which registry.** The official MCP Registry (`registry.modelcontextprotocol.io`) is the MCP project's own and vendor-neutral. It has been in preview since 2025-09-08, and secondary sources say its REST API was frozen at `v0.1` on 2025-10-24; both are unverified here. Whether a package entry carries a runtime hint a command can be built from is also unverified. The aggregators (Glama, Smithery, mcp.so) are commercial. The cost of any registry: a new outbound request, and the search term leaves the machine. | The official registry; no aggregator. The first plan step reads the published schema and records it here before anything relies on it. If it carries no usable runtime data, results show identifier and source only (D10). |
| O2 | **Seed carrier** across the settings window's reload: a `settingsQuery` key, or a one-shot stash in main. | A query key (`addon=<catalog id>`): it rides the load like `scope` and `path`, and the "same thing" comparison then treats a seeded open as different. |
| O3 | **Picker against a window with unsaved edits.** A seeded open reloads the one settings window, so the unsaved edits of the open project window (if it is that project) and of the global window the user is leaving are lost. | Warn with the existing control dialog before the hand-off; refuse nothing. Revisit when a dirty flag exists for the settings window. |
| O4 | **A new renderer file or an extension of `src/renderer/panels/settings-external-mcp.js`.** A new file is a three-file change (script tag, `test/fixtures/script-order.json`, `ALLOWED_BINDINGS` in `test/backend-integrations.test.js`). | Extend the existing file: the hand-off needs its form, `reasonSentence` and `cardButton`. Split it only if it grows past one reader's grasp. |
| O5 | **`checkExternalMcp` without a project, or a global IPC.** Read in `src/app/external-mcp-check.js`: `projectPath` is optional (`null` is handled), bare names are looked up on PATH, and the validator accepts a stdio entry with a name and a command. So it works without a project. The cost is a throwaway entry per name and the backend and variable facts computed and ignored. | Reuse it; add a test that runs `checkEntries` with no project over the catalog's names. A global IPC adds a handler and a module for no new fact. |
| O6 | **Where the catalog lives and its format.** | A module under `src/shared/` in the UMD shape of `src/shared/external-mcp-form.js`: the renderer reads it, and main validates a seed id against it. Data plus a small `commandLine` helper that enforces D9. It names servers, not backends, so reflex 5 is not touched. |
| O7 | **`uvx` without an install.** `uvx <package>` runs a server from a cache: there is no executable on PATH to detect and nothing to uninstall. | Catalog the installed form (`uv tool install`, `pipx install`); say in the row text that `uvx` is the runtime that makes the zero-install form possible and that it is not what is detected. Do not add a zero-install row in v1. |
| O8 | **Disclosure for the registry request.** Whether a hint next to the button is enough, or a setting should turn the search off. | A hint, always visible: "Press Search to send this text to the registry." No setting (D8). |
| O9 | **Wording of the PATH limit.** The restart caveat above is true and easy to miss. | One sentence under **Check again**: "Checked against the PATH this app started with." |

## Catalog verification

Filled in when the catalog is built (plan step T2): one row per entry with the date the source, licence, executable
name and both commands were checked against the upstream project, and what was checked them against.

| Entry | Verified on | Checked against |
|---|---|---|
| jcodemunch | 2026-10-27 | Package page `pypi.org/project/jcodemunch-mcp` (installs with `uv tool install` and `pipx install`); upstream `pyproject.toml` (`name`, `license = "LicenseRef-jCodeMunch-Dual-Use-1"`, `[project.scripts]` names `jcodemunch-mcp`); upstream `LICENSE` ("jCodeMunch-MCP — Dual-Use License", version 1.2: non-commercial use free, commercial use needs a paid license). |
| jdocmunch | 2026-10-27 | Package page `pypi.org/project/jdocmunch-mcp` (`uv tool install`, `pipx install`); upstream `pyproject.toml` (`license = "LicenseRef-jDocMunch-Dual-Use"`, `[project.scripts]` names `jdocmunch-mcp`); upstream `LICENSE` ("jDocMunch-MCP — Dual-Use License", same terms). |
| jdatamunch | 2026-10-27 | Package page `pypi.org/project/jdatamunch-mcp` (`uv tool install`, `pipx install`); upstream `pyproject.toml` (`license = "LicenseRef-jDataMunch-Dual-Use"`, `[project.scripts]` names `jdatamunch-mcp`); upstream `LICENSE` ("jDataMunch-MCP — Dual-Use License", same terms). |

None of the three upstream READMEs names an uninstall command. The uninstall lines come from the runtimes themselves:
`uv tool uninstall <NAME>` (`uv tool uninstall --help`, the argument is the tool name) and `pipx uninstall ENVIRONMENT`
(the pipx CLI reference, `pipx.pypa.io/stable/reference/cli.html`; the environment is named after the package). The
optional extras jdatamunch documents (`jdatamunch-mcp[excel,parquet]`) are not catalogued: the brackets break D9, and
the base package is what every README installs first. The data is `src/shared/mcp-addon-catalog.js`; the rules are
checked by `test/mcp-addon-catalog.test.js`.

## Registry facts

Read on 2026-10-27 (plan step T1) against the live service, unauthenticated.

- **Endpoint.** `GET https://registry.modelcontextprotocol.io/v0.1/servers` answers JSON with no login. `v0` answered
  the same body. Parameters used: `search` (a substring of the name), `version=latest` and `limit`; the reply is
  `{ servers: [...], metadata: { count, nextCursor? } }`, and a further page is asked with the cursor.
- **One server, many rows.** Without `version=latest` a search answers every published version of a server as its own
  row (a search for jcodemunch returned three versions of one server, each `isLatest: false`). The search therefore
  always sends `version=latest`. A row is `{ server, _meta }`, and `_meta["io.modelcontextprotocol.registry/official"]`
  carries `status`, `isLatest` and dates.
- **Schema.** Each `server` names its schema: `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`.
  A server has `name` (reverse-DNS, e.g. `io.github.<owner>/<repo>`), `title`, `description`, `version`, `repository`
  (`url`, `source`), and `packages` and/or `remotes`.
- **A package** requires `registryType` (`npm`, `pypi`, `oci`, `nuget`, `mcpb`), `identifier` (a package name, or a URL
  for a direct download) and `transport`; optional are `version`, `runtimeHint` (examples in the schema: `npx`, `uvx`,
  `docker`, `dnx`), `runtimeArguments`, `packageArguments`, `environmentVariables`, `registryBaseUrl`, `fileSha256`.
- **The runtime hint is optional and was absent** on the three catalog servers: each is
  `{ registryType: "pypi", identifier: "<name>-mcp", transport: { type: "stdio" } }`. So a command cannot come from the
  hint. Under D10 main builds one only from `registryType: "pypi"` plus an identifier that passes the PyPI name rule
  (`uv tool install <identifier>` / `pipx install <identifier>`); every other package type, and a server with only
  `remotes`, shows its identifier and source as text and no command.
- **Not found:** published usage terms or a rate limit for unauthenticated clients. The service calls itself a
  preview, so the plan treats its shape as able to change: the reply is validated field by field and anything
  unexpected is dropped, never passed through.

## Known limits

- The catalog is three entries long and grows by pull request; it is not a store (the issue: not a general plugin or
  extension store).
- A found executable is not a working server, and an installed server on a PATH the app has not seen reads as missing.
- Registry results are unreviewed. The label says so; nothing here makes one safer than it is.
- No uninstall check: after the user runs the uninstall command, **Check again** is how the row learns of it.
- Flow (c), running the command after a confirmation, is not designed here.
