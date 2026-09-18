# 31 — Resources from: a Pi session takes over another CLI's skills and commands

Issue #632. The core half is `src/app/resource-sources.js`, the Pi half is `src/backends/pi/session-resources.js`
with the per-spawn extension in `src/backends/pi/resources-extension.js` and the command bridge in
`src/backends/pi/command-bridge.js`. It applies to both Pi backends, the terminal one and `pi-native`
(spec 30).

## What changes for the user

Someone who has spent a year collecting skills and slash commands for Claude Code loses all of them the day
they start a session in Pi, even when Pi runs the same model. The owner's goal for this issue and the ones
after it: switching a session from Claude or Codex to Pi must not lose the user's setup. #632 covers the
content, skills and commands, and adds the one setting the later parts attach to.

That setting is **Resources from**, a select on the Pi backends: `None (Pi's own)`, Claude Code, Codex,
Antigravity CLI. It cascades like every launch option, so a project can pick a different source than the
global setting. With a source chosen, a Pi session gets that CLI's skills (`/skill:<name>`) and its commands
(`/<name>`) in addition to its own. `None` is Pi exactly as it was before. A source only adds: a skill or
command Pi already has keeps its own. The one thing a source replaces is the app's own `/handoff` and
`/plan` (#569), because a user's command of that name is the user's choice.

Under the select, the settings screen shows what a session started from that scope would take over: the
directories, and the ones left out with the reason.

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
| O6 | Agents are not part of this issue. | Measured below; a Claude agent's tools and model do not map onto Pi's without a translation. That is #639. |
| F3 | In `pi-native`, the approval gate asks before a **permitted** inline shell line. | A conversation with the gate on must not run a shell command nobody was asked about. |
| N1 | "Allow for this session" on such a line is per **command**, never the agent's `bash` tool. | Sharing the key would let a harmless `git status` in the user's own command unlock arbitrary agent bash. |

The settings screen (step 4) added two:

| | Decision | Why |
|---|---|---|
| Choices | The field declares `choicesFrom: 'sharedResourceSources'` instead of listing sources; the core fills the choices at the `backends-list` projection. | Pi's folder cannot name other backends (CLAUDE.md reflex 5). Filling them where every form reads the fields gives the settings page, the Configure dialog, the template editor and the tour one list. The list does not change at run time, so it needs no dynamic mechanism. |
| Preview | A closed disclosure under the select, read when opened, with the options the page shows for that backend. | It lists another backend's directories, so it costs a read, and the settings search must not open it on every keystroke (`data-lazy`). With the page's own options, unsaved edits included, its trust answer is the one a launch would get. A template's pane has none: its launch reads layers that page does not assemble. |

## The seam

No backend is named in the core, and no source's format is spelled in Pi's folder.

- **A source** declares `sharedResources: { sources, commandDialect }`. `sources` names which of its
  `listResources` rows may leave it, by their `source` key, so plugin rows stay out without the core knowing
  what a plugin is. `commandDialect` describes its command files as data (below), because they are expanded
  inside Pi's process, where no descriptor function can be called. Claude offers skills and commands, Codex
  and agy skills only; Hermes and Pi declare `null`.
- **A target** declares `acceptsSharedResources` (the kinds it can take) and `trustsProjectResources`
  (E1), and implements the hook pair `buildSessionResources` / `releaseSessionResources`.
- **The core** (`resource-sources.js`) has two answers. `sourcesFor(target)` lists the built-in backends
  that offer something, not the target itself and not a template, because a template reads its base's store
  and would offer the same directories twice. `resolve({ target, sourceId, projectPath, options })` lists
  the source's rows, keeps the declared sources of the kinds the target takes, drops project rows unless the
  target trusts the project, and reports each of those drops with its reason, as well as a command dropped
  because its source declares no dialect. Rows the source never offers (plugins, agents, settings) and kinds
  the target does not take are left out without a report, because nothing was going to be passed there. The
  spawn path and the settings preview both ask `resolve`, so they cannot disagree.
- **The spawn** (`src/app/terminal/spawn.js`) awaits `buildSessionResources` with the cascaded options and
  a resolver, before the #569 templates. After the await it checks again for a quit and for a second open
  of the same session. That await is the first on a Pi spawn before the session is registered, and without
  the check a quit could orphan the process or a racing open could double it.

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
  is skipped and reported. The one exception is the app's own per-spawn templates (#569): a source's
  `/handoff` is the user's, and it wins over the app's.
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

## Measured

Against Pi 0.84.4, in the isolated demo.

- A Claude skill via `--skill` works: `/skill:<name>` expanded and the model followed it.
- A Claude command via `--prompt-template`: frontmatter accepted, `$ARGUMENTS` and `$1` expand, `!` and `@`
  stay literal, `allowed-tools` and `model` are ignored. Hence the bridge.
- Pi's `input` event fires before template expansion, and extension commands are dispatched before both.
  That order is what lets the bridge take a command before Pi sees it.
- A Claude agent run as a Pi child: `tools: Read, Glob, Bash` gives the child **no** tools, without an error,
  because Pi looks tool names up exactly and drops unknown ones. `model: inherit` fails the child at once.
  `model: sonnet` resolved to a model of an unrelated provider by substring match. All three are why agents
  are #639 and not part of this issue.

Click-tested: in `pi-native` with Claude as source, a command with two arguments (one quoted) expanded
them, a permitted `echo` ran after the gate asked, and a `whoami` the file did not permit was refused with a
notice. In terminal Pi, with the run trusted, a project command's inline shell line ran and its `@README.md`
was inlined, a command from a subdirectory registered under its own name, and the subagent tool and the
commands came from one extension.

## What comes along and what does not

Comes along: skills, and commands with arguments, file references and permitted shell lines.

Does not, and says so in the option's own text:

- Hooks: #635, as a section of the same extension.
- MCP servers: #633. Pi has no MCP client of its own.
- Agents: #639, with a tool and model mapping declared by the source.
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
- **A name Pi already has** is only known once the session runs, so the settings preview cannot show it.
