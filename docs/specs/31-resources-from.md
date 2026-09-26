# 31 — Resources from: a Pi session takes over another CLI's skills, commands, agents, MCP servers and hooks

Issue #632, with agents from #639 and MCP servers from #633. The core half is `src/app/resource-sources.js`, the Pi half is `src/backends/pi/session-resources.js`
with the per-spawn extension in `src/backends/pi/resources-extension.js`, the command bridge in
`src/backends/pi/command-bridge.js` and the MCP client in `src/backends/pi/mcp-section.js`. Claude's side of
the MCP servers is `src/backends/claude/mcp-servers.js`. It applies to both Pi backends, the terminal one and `pi-native`
(spec 30).

## What changes for the user

Someone who has spent a year collecting skills and slash commands for Claude Code loses all of them the day
they start a session in Pi, even when Pi runs the same model. The owner's goal for this issue and the ones
after it: switching a session from Claude or Codex to Pi must not lose the user's setup. #632 covers the
content, skills and commands, and adds the one setting the later parts attach to; #639 adds agents and #633
MCP servers.

That setting is **Resources from**, a select on the Pi backends: `None (Pi's own)`, Claude Code, Codex,
Antigravity CLI. It cascades like every launch option, so a project can pick a different source than the
global setting. With a source chosen, a Pi session gets that CLI's skills (`/skill:<name>`) and its commands
(`/<name>`) in addition to its own. `None` is Pi exactly as it was before. A source only adds: a skill or
command Pi already has keeps its own. The one thing a source replaces is the app's own `/handoff` and
`/plan` (#569), because a user's command of that name is the user's choice.

A source's MCP servers come along only with a second switch, **MCP servers from the source**, which is off
by default: each server is a process started on the user's behalf, and choosing a source must not start
processes by itself.

Under the select, the settings screen shows what a session started from that scope would take over: the
directories and the MCP servers, and the ones left out with the reason.

## Decisions

All of them the owner's, 2026-09-18.

| | Decision | Why |
|---|---|---|
| E1 | A source's **project** directories are passed only when Pi trusts the project: this run's `approval` override first, then Pi's saved trust. No saved decision counts as no. Global directories are always passed. | A path on Pi's command line is loaded whether or not the project is trusted (read in Pi's source: `--skill` bypasses trust), so passing one would read a project's instructions before anybody trusted it. |
| E2 | Only the Pi backends take resources over. | Pi is the backend that can be driven and extended per spawn. The seam is neutral, so another target would be a declaration, not a rewrite. |
| E5 | Plugin skills stay out for now. | A plugin is its own install with its own lifecycle; the design keeps it possible by naming the `source` rows a backend offers. |
| E9 | **One** source per cascade level, through the select. The label is "Resources from", never "behave like". | Two sources would collide by name, the first found would win, and nobody could tell which `/review` ran. |
| S1 | A **disabled** backend is still offered as a source. | Only its files are read. The user who switched Claude off in favour of Pi is exactly the one who wants Claude's skills to follow. |
| O3 | Commands are taken over, and their `` !`…` `` and `@file` work. | Measured: handed to Pi as `--prompt-template`, both stay literal text. See "Commands". |
| O4 | An inline shell line runs only where the command file's own permission allows it, by the source CLI's rule. | That is what the source CLI does, and the rule belongs to the source: Codex and agy declare no commands at all. |
| O5 | **One** per-spawn resources extension carries everything taken from the source. The `subagent` tool (#634) is folded into it as a section. | One file and one release per spawn. MCP (#633) and hooks (#635) attach as further sections, not as new hook pairs. |
| O6 | Agents were split off to #639. | Measured below; a Claude agent's tools and model do not map onto Pi's without a translation. #639 has since built it, see "Agents". |
| F3 | In `pi-native`, the approval gate asks before a **permitted** inline shell line. | A conversation with the gate on must not run a shell command nobody was asked about. |
| N1 | "Allow for this session" on such a line is per **command**, never the agent's `bash` tool. | Sharing the key would let a harmless `git status` in the user's own command unlock arbitrary agent bash. |

The settings screen (step 4) added two:

| | Decision | Why |
|---|---|---|
| Choices | The field declares `choicesFrom: 'sharedResourceSources'` instead of listing sources; the core fills the choices at the `backends-list` projection. | Pi's folder cannot name other backends (CLAUDE.md reflex 5). Filling them where every form reads the fields gives the settings page, the Configure dialog, the template editor and the tour one list. The list does not change at run time, so it needs no dynamic mechanism. |
| Preview | A closed disclosure under the select, read when opened, with the options the page shows for that backend. | It lists another backend's directories, so it costs a read, and the settings search must not open it on every keystroke (`data-lazy`). With the page's own options, unsaved edits included, its trust answer is the one a launch would get. A template's pane has none: its launch reads layers that page does not assemble. |

#633 added these, the owner's as well, 2026-09-18 (direction comment on #633):

| | Decision | Why |
|---|---|---|
| M1 | The server list comes from the source picked in "Resources from". A list of the user's own beside it is a later step. | One switch for everything a session takes over. |
| M2 | A source reads its own config format through a hook in its own folder and answers with neutral rows. Only Claude declares one so far. | Parsing JSON or TOML is logic, not dialect data, and it runs in the app, where a descriptor function can be called. |
| M3 | The server list reaches Pi in one environment variable, never in the generated file. The extension reads it once and deletes it. | A server's `env` routinely holds tokens, and the extension file sits on disk for the life of the session. |
| M4 | A small stdio client of the app's own, no SDK. | Three requests are all it needs, and it is tested like the other sections. |
| M5 | In `pi-native` every MCP tool is asked about, and "Allow for this session" covers one tool. | `readOnlyHint` is the server's own claim, and an MCP tool can do anything its server does. |
| M6 | A project's `.mcp.json` servers come along only when Pi trusts the project and the user approved them in Claude. | They come with the repository, as project directories do (E1), and Claude itself starts none without the approval. |
| M7 | The extension ends its servers when the session ends. | Measured on Windows: they also die with Pi itself, because Node puts its children in a kill-on-close job object, so the app needs nothing of its own there. Elsewhere a Pi that is killed leaves its servers to end on their closed input, which was not measured. |
| M8 | A server that fails is said, in the session and in the preview, never silently absent. | A tool that is just missing is the failure mode an extension makes easy. The preview can only say what a definition shows; a server that fails when it starts is said in the session (see Known limits). |
| O1 | Each source keeps its own CLI's rule for what needs trust: what sits in the user's home file does not, what sits in the repository does. | The owner's words: "same handling as Claude, Codex". |
| O2 | A tool is called `mcp__<server>__<tool>`, cleaned to letters, digits, `_` and `-`, cut at 64. | What every provider accepts, and the spelling a Claude agent's `mcp__…` tools already use. |
| O4 | `session_start` waits for the servers up to 5 s together, then goes on; a slower server registers later and says so. | Measured: a tool registered after a prompt went out is not seen by it, and the app often launches with a prompt. |

## The seam

No backend is named in the core, and no source's format is spelled in Pi's folder.

- **A source** declares `sharedResources: { sources, commandDialect, agentDialect }`. `sources` names which
  of its `listResources` rows may leave it, by their `source` key, so plugin rows stay out without the core
  knowing what a plugin is. The two dialects describe its command and agent files as data (below), because
  those are read inside Pi's process, where no descriptor function can be called. Claude offers skills,
  commands and agents, Codex and agy skills only; Hermes and Pi declare `null`. A source that offers MCP
  servers also implements `listSharedMcpServers({ projectPath, env })` (#633): they are entries in its
  config files, not listing rows, so it answers with neutral rows of its own (below). Only Claude does.
- **A target** declares `acceptsSharedResources` (the kinds it can take) and `trustsProjectResources`
  (E1), and implements the hook pair `buildSessionResources` / `releaseSessionResources`. It may also
  declare `declinesSharedResource({ kind, scope, options })`, for a kind it accepts but not with this
  launch's options, with a note of its own (#639: Pi declines agents while its subagent tool is off).
- **The core** (`resource-sources.js`) has two answers. `sourcesFor(target)` lists the built-in backends
  that offer something, not the target itself and not a template, because a template reads its base's store
  and would offer the same directories twice. `resolve({ target, sourceId, projectPath, options })` lists
  the source's rows, keeps the declared sources of the kinds the target takes, drops project rows the target
  does not trust and any row of a kind the target declines for this launch, and reports each of those drops
  with its reason, as well as a command or an agent dropped because its source declares no dialect for it. Rows the source never offers (plugins, settings) and kinds
  the target does not take are left out without a report, because nothing was going to be passed there. The
  spawn path and the settings preview both ask `resolve`, so they cannot disagree, with one exception: an
  MCP definition is expanded against the launch's environment at spawn and against the app's in the
  preview, so a variable that only a launch sets can read differently in the two. Its answer has an
  `mcpServers` bucket as well, and it takes an `env`, the environment a launch runs with, which a source
  expands its MCP definitions against. The preview answers without a server's `env` and arguments.
- **The spawn** (`src/app/terminal/spawn.js`) awaits `buildSessionResources` with the cascaded options and
  a resolver, before the #569 templates. After the await it checks again for a quit and for a second open
  of the same session. That await is the first on a Pi spawn before the session is registered, and without
  the check a quit could orphan the process or a racing open could double it. The hook may also answer an
  `env`, which the spawn adds to the session's environment last, after its own `$VAR` resolution (#633).

`projectPath` is the session's working directory, not the project whose settings apply. Pi checks trust
there, and for a worktree the two differ.

## Skills

A source's skill directories go to Pi as `--skill <dir>`. Pi appends command-line paths after its own and
keeps the first skill of a name, so the user's own Pi skill wins over the source's. Claude's and
Codex' skills are `SKILL.md` folders, and Pi reads them unchanged. agy's are taken to be the same shape,
which is not measured yet (see Known limits).

## Commands

Handed to Pi as prompt templates, a Claude command expands `$ARGUMENTS` and `$1`, and leaves `` !`cmd` `` and
`@file` as text, which breaks the commands people actually write. So the resources extension registers each
source command itself (`pi.registerCommand`) and expands it before sending it as the user's message.

- **Registered at `session_start`**, when Pi's own templates are known. Extension commands are dispatched
  before templates, so registering a name Pi already has would shadow the user's own template. Such a name
  is skipped and reported. The one exception is the app's own per-spawn templates (#569), recognised by the
  prefix of the per-spawn directory they are passed from (`pi-prompts-`): a source's `/handoff` is the
  user's, and it wins over the app's. A registered command shows in RPC `get_commands` like one of Pi's own.
- **A subdirectory labels a command and does not rename it.** `commands/fe/x.md` is `/x`, described as
  "(fe)". `description` and `argument-hint` from the frontmatter become its description.
- **On use the file is read again**, so an edit takes effect without a restart. The expansion works on the
  raw file: arguments are substituted into each piece and judged there, so an argument can neither open nor
  split an inline shell line, and `@path` is expanded only in the file's own text, never inside shell output
  or an argument.
- **An inline shell line** runs only when the file's `allowed-tools` names the shell tool: bare (anything),
  as `Bash(<prefix>:*)`, as a pattern with `*`, or exactly. A line that chains, pipes, redirects or
  substitutes (`;`, `&&`, `|`, `>`, `$(`) runs only with the bare tool, or a prefix pattern would let
  `git status && <anything>` through. A refused line stays in the text, with the arguments substituted,
  and the user is told. In `pi-native` a permitted line is asked about as well (F3), and the question reads
  "Your command /x wants to run a shell line".
- **Sent** with `pi.sendUserMessage`, as a follow-up when the agent is busy.

The matching rules are Claude's `commandDialect` in `src/backends/claude/index.js`. Pi's extension carries
them out and knows no syntax of its own.

## Agents (#639)

With the subagent tool on (`subagentTool`, #634), a source's agents can be delegated to like Pi's own. The
source only adds a directory; it never switches the tool on, because the tool starts model sessions with a
cost of their own. With the tool off, the preview shows the agent directories as not passed and says why.

- **One loader, one order.** Pi's own agents directory (or `subagentAgentsDir`) comes first, then the
  source's project agents, then its global ones, and the first agent of a name wins. The tool description,
  the call and the approval question all ask the same loader, so they cannot disagree about which agent a
  name means. Pi's own agents are used as they are written.
- **Tools through a neutral vocabulary** (`src/backends/tool-vocabulary.js`). The source maps its names onto
  words such as `read`, `find-files` and `shell` (`agentDialect.toolWords`), and Pi declares which of its
  tools does each word (`TOOL_FOR_WORD` in `src/backends/pi/subagent-tool.js`). Neither side names the
  other's tools. The issue proposed that Claude's descriptor name Pi's tools, which is CLAUDE.md reflex 5
  the other way round.
- **Nothing is widened.** A tool with no counterpart (`WebFetch`, `Task`, `mcp__…`) is left out and named.
  An entry restricted to a pattern (`Bash(git status:*)`) is left out as well, because the child runs without
  this app's gate and could not enforce the restriction. `disallowedTools` takes whole tools away, from the
  user's own `defaultTools` when the agent has no `tools` line. A project's `defaultTools` can only narrow
  that list, because Pi ignores it in a project it does not trust and this code does not know the answer.
  A dialect that does not say how agents name their tools refuses instead of granting the defaults.
- **An agent left with nothing it may use is refused** and not offered. In `pi-native` the gate blocks
  such a delegation without asking. It is not waved through, because the tool reads the agent files again
  when it runs, and a file written in the same batch of calls could make the agent runnable in between.
- **The model stays with the session's provider.** `inherit`, or no model at all, is the session's model
  and thinking level. Any other name is looked up only among the models the session's provider offers
  (`ctx.modelRegistry.getAvailable()`, which lists only providers with a login, so the pick never lands on
  a model the user cannot reach): an exact id first, then the highest-sorting id containing the name,
  preferring one without a date suffix. The child is handed that exact `provider/id`. With no match the agent runs on the
  session's model, and the question and the result say so. Pi's own resolver would have searched every
  provider (measured: `sonnet` under an OpenAI session picked an amazon-bedrock model). Pi's own agents get
  the same rule since #641 (owner decision), with two differences because they were written for Pi: a
  `provider/id` naming an available model is kept as written, whatever its provider, since spelling out the
  provider is how such an agent asks for another one on purpose; and Pi's `:<thinking>` suffix is carried
  over onto the resolved model. A name that needed resolving is said in the question and in the result.
- **The question (in `pi-native`) and the result say what was done**: the tools the agent got, the model it runs on and why,
  and every entry left out with its reason. "Allow for this session" is keyed by the agent's origin, scope
  and name, so an allow cannot pass to a different agent that later answers to the same name.

Click-tested in `pi-native` with Claude as source, on an OpenAI session: a Claude agent with
`tools: Read, Glob, Bash` and `model: sonnet` ran with `read, find, bash` on the session's model and
followed its own system prompt. A call to an agent with only `WebFetch` was blocked with its reason, and
nobody was asked.

## MCP servers (#633)

Pi has no MCP client. Its README says so and points to an extension, and 0.85.1 is no different. So the
resources extension carries one, as a third section (`src/backends/pi/mcp-section.js`), and it runs only
while **MCP servers from the source** is on. With it off the source's config is not even read, and the
preview shows one line saying so.

**Where the servers come from.** Claude keeps them in three places (`src/backends/claude/mcp-servers.js`):
the user scope at the top of `~/.claude.json`, the local scope in that file's block for the project, and
the project scope in `<project>/.mcp.json`. The first two are the user's own writing and count as global.
The third comes with the repository: it needs Pi's trust in the project (E1) and the user's approval in
Claude, read from the project's blocks in `~/.claude.json`, the user settings and the project's
`settings.local.json`, and never from the committed `.claude/settings.json`. `settings.local.json` is the
user's only by convention: it is gitignored, not unwritable, so a repository that commits one can approve
its own servers there, as it can for Claude. What still stands in the way is Pi's trust, which a project
server needs as well. Rows come in Claude's order, local then project then user, and the first
definition of a name decides even when it cannot be started, because that is the one Claude would run.
`${VAR}` and `${VAR:-default}` are expanded in the command, the arguments and the env, against the
session's own environment, resolved as the spawn resolves it. A server with a variable that is not set and
has no default is left out and named; a variable set to an empty value expands to nothing, as in a shell.

The local scope is looked up under the project path as spelled, forward slashes and exact case, and under
nothing else. That is measured: `claude mcp add` filed the server under the directory as the shell spelled
it, and `claude mcp list` run from the same directory in its on-disk case did not find it. Trust is filed
differently (#627), which is why this lookup has its own function.

**What the core leaves out, with a reason each:** a transport other than stdio, a project server in an
untrusted project or without the approval, a missing variable, a definition with no command, a name a
higher scope already defined, and every server while the switch is off.

**How they reach Pi.** The list, `env` included, travels in one environment variable that the spawn adds
after its own `$VAR` resolution. The extension reads it when Pi loads it and deletes it from the process's
environment, so the agent's `bash` tool does not inherit it (measured: a shell the agent ran saw nothing).
Nothing of it is written into the extension file or the log.

**The client.** Each server is started without a shell, as Claude starts it, and spoken to line by line:
`initialize`, `tools/list` with paging, `tools/call`. A server's `ping` is answered and anything else it asks
is refused. Every tool becomes a Pi tool named `mcp__<server>__<tool>` with the server's own input schema
(measured: Pi takes it as it is). A result's text and images are carried, a resource's text is inlined,
anything else is named, and the text is cut at 51,200 characters. Stop aborts a call and tells the server so.

**Starting and restarting.** `session_start` waits up to 5 s for all servers together. A server that is
slower registers when it answers and says that its tools are offered from the next prompt on. A server
that fails is announced with its reason, including the tail of its standard error, and a failure is never
lost because a slower sibling kept the start past the cap. Pi builds a new extension instance for every
`/new`, `/resume` and `/fork` and evaluates the extension again on `/reload`, so the list and the running
clients live in a process-level holder and each instance registers the tools again. A counter per start
keeps a start that belongs to an earlier session from stopping a later one's server or announcing anything
into it. The servers end with the session; on Windows the whole tree is ended.

**The question in `pi-native`** (M5). The approval gate asks before every tool whose name starts with
`mcp__`, and "Allow for this session" covers that one tool. The question carries a line the section
publishes about the tool: which server it belongs to and the server's own description of it. That line is
the server's claim, like `readOnlyHint`. A tool of the user's own that happens to start with `mcp__` is
asked about as well, without a line. The terminal backend asks about nothing, and neither does
`pi-native` with the gate off; the option text says both.

Click-tested with two stdio servers from Claude, one user-scope with a secret in its `env` and one
local-scope. In `pi-native` with a launch prompt, both tools were called on the first turn, after the gate
asked, and "Allow for this session" let the second call of the same tool through without a question. In
terminal Pi the tool worked and the agent's shell did not see the variable. After `/new` and after `/reload`
the tools worked again on fresh server processes, and the server with the secret still had it. After the
sessions were stopped no server process was left.

## Hooks (#635)

The user has attached commands to the source CLI's own lifecycle. With `sourceHooks` on, the same commands
run when the Pi session reaches the matching moment — the point of the whole effort applied once more:
switching CLIs should not lose the setup.

**A MOMENT IS A WORD NEITHER CLI OWNS.** `src/backends/hook-events.js` is to events what
`tool-vocabulary.js` is to an agent's tools: the source maps its own event names onto `session-start`,
`tool-finished` and `agent-idle`, and the target declares which of ITS events is each word. Neither folder
learns the other's names, and a word one side cannot answer means the hook is not taken over rather than
attached to the nearest moment instead — a hook that fires at almost the right time is worse than one that
does not fire, because nothing on screen says it was the wrong moment.

**The three words are the ones both sides were MEASURED to have**, and two of them have a plausible
neighbour that is wrong:

| Word | Source | Target | Why not the neighbour |
|---|---|---|---|
| `session-start` | `SessionStart` | `session_start` | — |
| `tool-finished` | `PostToolUse` | `tool_result` | `tool_execution_end` carries the tool's RESULT and not its INPUT, and a hook of this kind is handed both (measured payloads in `pi/hooks-section.js`) |
| `agent-idle` | `Stop` | `agent_settled` | an `agent_end` may still be followed by a retry, a compaction or a queued continuation, so it is not the moment a person means by "it has stopped" — the same reading the live binding took for busy/idle (#573) |

**Only a hook that RUNS A COMMAND travels**, and that is also what keeps Switchboard's own attention hook
out (owner decision H1). The app writes `type: "http"` entries into the very file this reads
(`src/app/hooks.js`), and a session reporting its turns through a taken-over copy of them would announce
every turn twice. Filtering by TYPE rather than by our own URL is the structural version of that rule:
ours is not a command, so nothing here has to know what our sentinel looks like.

**Nothing that can answer back comes along** (H3). `PreToolUse`, `UserPromptSubmit` and `PreCompact` have
no word at all, and a deny, an `additionalContext` or an exit code 2 is not honoured: blocking is a
permission surface, `approvalGate` is already that surface, and a second one is the second way to do one
thing. There is therefore no return value to respect and no way for a hook to hold the session.

**A matcher names the source's tools**, mapped through the same `toolWords` table the agent dialect
declares — one table, because a matcher and an agent's `tools` line name the same things (H4). A matcher
that is a pattern rather than a list of names is not taken over: narrowing it would mean guessing which
tools it meant. A matcher naming a tool with no counterpart is refused for the same reason.

**The payload is the SOURCE's own shape** (H8), and that is the point rather than a compromise: a hook the
user already wrote reads `hook_event_name` and `tool_name` by name, so a neutral shape would be a takeover
that breaks everything it takes over. The key names come out of the source's `hookDialect` as data, the way
a command's and an agent's do, because the payload is written inside the target's process.

**Nothing waits for a hook** (H5). Pi awaits its event handlers, so a slow hook would make the agent look
stuck with nothing on screen saying why. The handler starts the child and returns; the child is stopped at
the timeout its own entry set (60 s when it set none), **with its whole tree** — `shell: true` means what
the section holds is a shell, and killing a shell does not kill what it launched, so a report of "it was
stopped" would otherwise be false on Windows. **A failure is said and a success is not** (H10): a non-zero exit, a spawn that
fails and a timeout each put one line in the conversation, naming the command rather than the moment,
because the command is what the user would go and look at. A line per successful tool call would be noise.

**A project's hooks need the target's trust** (H6), like every other project-scope resource — and
`settings.local.json` inside a project counts as the project's although it is conventionally the user's
alone, because nothing enforces that convention and the trust rule is the only guard between a checkout and
a command running on this machine.

The MVP in the issue's body — a hand-written command per event, configured in Switchboard — is not built
and is not this (H7). It was split off into #652 and **closed there as not needed**: Pi already has that
route. Pi discovers the user's own extensions in `~/.pi/agent/extensions/` on every launch, and this app
never passes `--no-extensions`, so a file placed there loads beside the per-spawn extensions this app
writes. Measured on Pi 0.85.1 in RPC mode (the Pi (native) launch) with an `-e` extension alongside, as the
app launches it: the user's extension loaded and its `session_start` handler ran. A Switchboard setting would
have been a second way to do that. It would also have needed a payload shape of its own, an order against
the taken-over hooks, and a guard for project-scoped commands. Pi's route answers all three itself: the
handler receives Pi's own event object, there is no second runner, and project-local extensions load only
once Pi trusts the project. This section takes over what the user already has; the user's guide says how
to write the extension (`docs/multi-llm.md`).

**A matcher is only read as tools on the TOOL moment.** This CLI's `SessionStart` matcher is `startup`,
`resume`, `clear` or `compact` — which side of a session it is, not a tool — and `Stop` has none. Reading
one as a tool list refused the commonest `SessionStart` configuration there is, with a sentence that was
true and about the wrong question. What a session-side matcher SELECTS is not carried: the target reaches
its own start once, however this one was reached.

Three limits worth knowing. **The failure line is the FIRST line of the hook's standard error**, stripped of
colour codes and capped — the same reading `cli-probe.js` takes of a CLI's complaint. For a script that
fails with a stack trace that is not always the most useful line (Node prints its own locator first), and
picking a better one would mean guessing at one runtime's format; the command and the exit code are named,
which is enough to go and run it. **A `SessionStart` hook fires before the conversation view has
attached**, so its failure reaches the log rather than the screen — it is the one moment where "a hook that
failed says so" is weaker than the others. And **nothing serialises the hooks**: a `PostToolUse` hook with
no matcher starts one shell per tool call, where the source CLI runs its own one at a time. Nothing waits
for them either, which is the point, so a busy session with a slow hook can have several in flight.

**What a hook is told about the session is the session FILE, not an id.** The dialect's `session_id` key is
filled from what the target can answer, and Pi names a session by its transcript path. A hook that reads
that field gets an absolute `.jsonl` path where the source CLI would have given a UUID. The key is the
source's, the value is the target's, and a hook that only passes it along is unaffected.

## Measured

Against Pi 0.84.4, in the isolated demo. Later Pi versions were not re-measured.

- A Claude skill via `--skill` works: `/skill:<name>` expanded and the model followed it.
- A Claude command via `--prompt-template`: frontmatter accepted, `$ARGUMENTS` and `$1` expand, `!` and `@`
  stay literal, `allowed-tools` and `model` are ignored. Hence the bridge.
- Pi's `input` event fires before template expansion, and extension commands are dispatched before both.
  That order is what lets the bridge take a command before Pi sees it.
- A Claude agent run as a Pi child: `tools: Read, Glob, Bash` gives the child **no** tools, without an error,
  because Pi looks tool names up exactly and drops unknown ones. `model: inherit` fails the child at once.
  `model: sonnet` resolved to a model of an unrelated provider by substring match. All three are why agents
  were split off to #639; "Agents" above is how that was built.

Click-tested: in `pi-native` with Claude as source, a command with two arguments (one quoted) expanded
them, a permitted `echo` ran after the gate asked, and a `whoami` the file did not permit was refused with a
notice. In terminal Pi, with the run trusted, a project command's inline shell line ran and its `@README.md`
was inlined, a command from a subdirectory registered under its own name, and the subagent tool and the
commands came from one extension.

## What comes along and what does not

Comes along: skills; commands with arguments, file references and permitted shell lines; while the
subagent tool is on, agents with the tools Pi has a counterpart for (#639); and while its own switch is on,
the source's stdio MCP servers with their tools (#633).

Two of those four need a second switch, and the form now says which while the switch is off (#645). The
defaults do not move: choosing a source must start neither a model session nor a process nobody asked for,
which is what `declinesSharedResource` decides at launch and at the preview alike. What moved is only the
sentence. The field's own description had carried it since #633 and buried it; the preview lists each
withheld row with the target's reason and is closed until somebody opens it, because it costs a walk of
another backend's directories; at launch the dropped rows went to the log and nothing else. A measured
launch: `1 skill dir(s), 1 command dir(s), 0 agent dir(s), 0 MCP server(s), 5 dropped`, and not a character
of it in the app. So a user who moved a session to Pi kept their skills and their commands and learned
about their agents when an agent answered that it was not available.

The line is a **declaration**, like the preview beside it: a field may carry `withheld`, one entry per kind
it does not deliver alone, each naming the option that would and the sentence to print while it is off. The
form compares that option's value and prints the note, so it learns no option and no backend of its own.
And it is drawn from the option STATE — no listing, no filesystem — which is what lets it sit in the open
beside a preview that cannot.

Does not, and says so in the option's own text:

- A hook that answers back, blocks or feeds context in, or whose moment or tools have no counterpart in Pi.
  The hooks that do come along are in "Hooks (#635)" above.
- MCP servers other than stdio (HTTP, SSE), and any server of Codex or agy, which declare none yet.
- Plugin skills: later (E5).
- Anything tied to the source CLI's own tools. Of a command's frontmatter, `allowed-tools` decides its
  shell lines and `description` and `argument-hint` describe it; nothing else changes what it does, and
  `model` is not applied. A skill whose text tells the model to use a tool Pi
  does not have fails the way it would fail anywhere without that tool.

## Known limits

- **Pi's `shellPath` setting is not honoured.** The bridge asks Pi's `getShellConfig()` without it, so on
  Windows without Git Bash an inline shell line answers `[shell unavailable: …]`.
- **A timeout on POSIX ends the shell, not its children.** A shell line has 30 seconds.
- **An argument inside a file reference is not expanded** (`@docs/$1.md`), on purpose: a file reference
  comes from the file's own text, and an argument that could build one could name any file.
- **agy's skill folder shape is unverified.** It is inferred from its plugin bundles; there were no agy
  skills to measure.
- **Codex skills may carry Codex-only instructions.** Pi reads them as they are, and they fail the way they
  would in any CLI other than Codex. They are documented, not filtered.
- **The settings screen has four small cuts, left on purpose.** A backend that is switched off shows no
  preview on its global page, where every control is disabled anyway. An empty stored value is shown as a
  blank "(not available)". The Configure dialog, unlike the settings screen, still falls back to the
  first choice for a stored value it does not offer. And that dialog draws the same fields without the
  withheld lines of #645 — so the one place a source is chosen immediately before a launch still says
  nothing about the two kinds that need a second switch. It is the strongest case for saying it and it is
  still a cut: the dialog is a per-session override with its own markers, and a line there would have to
  answer against those rather than against the cascade, which is a second rule for one sentence. Whoever
  takes it on states which of the two the dialog's line describes.
- **A session with no model gives a source agent no `--model`**, so Pi picks its own default. A running
  session always has a model, so this is theoretical, and it was true before #639 as well.
- **A name Pi already has** is only known once the session runs, so the settings preview cannot show it. The
  same goes for the tools an agent loses: the preview lists agent directories, not agents.
- **Nested agent folders are not read.** The subagent tool's loader reads one level of `agents/`; whether Claude reads
  deeper was not measured.
- **An agent file edited during a session** is read again at each call, so it can gain tools after an
  "Allow for this session" was given for it, and a session model switched with Ctrl+P can resolve its model
  differently at the next call. The key names the agent, not its contents or its model (as in #634).
- **MCP (#633): the list stays in a wrapping shell's environment.** Pi and its tools do not have it, but
  where terminal Pi is started through a shell (an npm shim such as `pi.cmd`, or a pre-launch command), that
  shell keeps the variable, secrets included, for the life of the session, and a pre-launch command runs
  with it. A process of the same user can read it there. The same secrets sit in the source CLI's own
  config file anyway.
- **MCP: the preview sees definitions, not processes.** It says which servers a launch would start and why
  the others are left out, but a server that then fails to start (a command that does not exist, a crash on
  its own config) is only said in the session, when it happens.
- **MCP: the preview expands `${VAR}` against the app's environment**, while a launch uses the session's,
  which adds the backend's and your per-backend variables. So a variable set only there can read as missing
  in the preview and still start at launch. The preview also shows a variable in `command` expanded. At
  launch the expansion sees the app's environment with the backend's and your variables over it, but not the
  variables the spawn adds for the session itself (the CLI's home in an isolated run), so `${VAR}` naming one
  of those gets the app's value.
- **MCP: a delegated agent has no MCP tools.** A taken-over agent's `mcp__…` tools are left out as having no
  counterpart, and the subagent tool's child Pi loads none of this app's extensions, so it starts no server.
- **MCP: a bare `npx` does not start on Windows**, because a `.cmd` shim needs a shell, and Claude's own
  Windows setup writes such a server as `cmd /c npx …` for the same reason. The notice says so.
- **MCP: a tool call has no timeout.** A tool may run long; Stop ends it. Starting and listing have 30 s.
- **MCP: `.mcp.json` is read from the project directory only.** Whether Claude also reads one from a parent
  directory was not measured.
- **MCP: the whole list travels in one environment variable**, and Windows caps one at 32,767 characters. An
  extreme list could fail the spawn; this was not tried.
