# 29 — The document conventions, offered inside the session

## The problem

Switchboard has two document conventions of its own: where a handoff packet goes and what it looks
like (spec 25), and where a plan goes and what it looks like (spec 20). Both are carried to an agent
the same way — the app types a prompt into the session and gets out of the way.

That works only for a session the app is driving at the moment the user presses the button. Inside
the session the conventions do not exist. An agent asked for a plan in its own words writes one
wherever the moment suggests, and `docs/plans-convention.md` said so plainly: for the CLIs with no
plan mode, the convention "can only be carried by instructions — a line in the project's `AGENTS.md`
or `CLAUDE.md`", which is "a suggestion the model can ignore".

Pi has a third route, and it is the one this chapter is about. Pi discovers **prompt templates**:
markdown files with frontmatter, offered as `/<filename>`, with argument substitution. A template is
not a suggestion — the user types `/plan` and the convention arrives in full.

## The templates are the app's text, not the app's PROMPT text

The obvious implementation is to reuse `DEFAULT_HANDOFF_PROMPT` and `DEFAULT_PLAN_PROMPT` from
`src/renderer/session/session-health.js`. It does not work, and the reason is worth stating because
the next reader will see two similar texts and want to merge them.

- `DEFAULT_HANDOFF_PROMPT` says *"Return only a markdown handoff"*, because the **app** captures the
  answer and writes the packet. Typed as `/handoff` inside Pi, nobody is capturing anything — the
  agent has to be told to write the file itself.
- `withDirHint` appends the directory sentence **only** to a prompt that is a slash command, so the
  resolved text of a prose prompt names no directory at all.
- `DEFAULT_PLAN_PROMPT` interpolates the absolute `{planPath}`, which is empty when there is no
  project.
- Both carry per-session placeholders — `{goal}`, `{project}`, `{sessionId}`, `{metrics}` — that a
  static file cannot fill, and `{today}`, which a prompt template cannot compute.

So the two template texts are written separately and say something different on purpose: write the
file yourself, here, in this shape.

**The honest limit of that argument: it holds for the handoff half and is thin for the plan half.**
The plan template is close to `DEFAULT_PLAN_PROMPT` word for word — the opening sentence, the naming
sentence, the heading sentence and the closing paragraph are the same — and nothing compares them.
The reasons above are still why they cannot be one string, but "two texts that differ on purpose do
not drift" is not true of these two, and a guard over strings that are ninety per cent alike would
fail on every ordinary edit to either. This paragraph is what carries it instead.

## Three carriers, and none of them is redundant

After this, the plan convention can reach a Pi session three ways. That is the shape CLAUDE.md
reflex 16 asks about — a second way to do one thing — and the answer is not to drop two:

| Carrier | Reaches | Does not reach |
|---|---|---|
| The prompt the app types | a session the app is driving, on the button press | a session the user is typing in |
| A line in `AGENTS.md` / `CLAUDE.md` | every Pi run, with or without this app | nothing, but it is a suggestion the model may ignore |
| The prompt template | the user asking for it by name, in a session this app started | a Pi run started elsewhere |

Pi reads `AGENTS.md` and `CLAUDE.md` by itself — first match per directory, ancestors walked to the
filesystem root, the user-level file first, injected as a `<project_context>` block in the system
prompt, re-read only on start or `/reload`. There was never anything for this app to build there,
and it is listed here so nobody builds it.

## A launch flag, not a file in Pi's home

The first design wrote the templates into Pi's own prompts directory — `<agentDir>/prompts/` for the
global scope, `<project>/.pi/prompts/` for a project that overrides the directory names. Everything
hard about this feature came from that decision: an ownership marker in the frontmatter so the app
could tell its own file from an edited one, a digest so a settings change and a user edit were
distinguishable, a conflict flow that stops maintaining an adopted file and offers to replace it,
install and remove actions, a state to show in Agent Files, and the fact that a project-scoped
template does nothing at all until the project is trusted.

Pi takes `--prompt-template <path>`, a file or a directory, repeatable. So none of that is necessary.
Each spawn gets a directory of its own under the app's `userData`, the two files are written into it,
the flag is appended, and the directory is removed when the session ends — the same shape
`src/backends/pi/live-binding.js` has used for `--extension` since #303.

What it costs, stated because a decision has to say what it takes away:

- **A Pi run this app did not start gets neither command.** The file-writing route left them behind,
  so after one launch from the app a bare `pi` in a terminal would have had them too.
- **A user's own template of the same name wins.** CLI paths merge last and Pi's dedupe keeps the
  first, so a `plan.md` in Pi's own prompts directory or in a trusted project takes precedence over
  ours. That is the intended way to replace the text, and it is why there is nothing to edit here.
- **There is no way to edit ours.** The file lives one spawn. The answer to "I want it different" is
  to write your own, which then wins.

## What Pi's own reader decides

Three things were established by reading Pi 0.84.4's compiled source rather than assumed, and each
one shapes the code:

1. **Frontmatter is real YAML and unknown keys are ignored** — but an invalid block makes Pi's loader
   return null inside a bare `catch`, so the command disappears with no diagnostic in Pi and nothing
   said anywhere else. Every value the app writes into that block is therefore quoted and none of it
   is user-supplied.
2. **There is no escape for argument substitution.** Pi rewrites `$1`, `$@`, `$ARGUMENTS` and
   `${…}` anywhere in the body, through one regex with no `\$` branch and no `$$` branch. A
   directory name containing any of those cannot be represented in a template at all, so the
   composer refuses that kind rather than writing a template that names a directory the agent will
   never find. The other kind is still written.
3. **A template passed on the command line loses a name collision**, as above.

## Where the directories come from

`src/app/convention-dirs.js`, and only there — CLAUDE.md reflex 12. The spawn path asks `dirsFor`
and hands the answer to the backend, so the template text, the prompt the app types and the button
that saves a packet cannot name different directories for one project. The names are written into
the template relative to the project, never absolute: an agent runs in the project, and an absolute
path would put this machine's directory layout into a file that gets read out loud.

## The seam

The core calls a descriptor hook pair and names neither the backend nor the option:
`buildPromptTemplates` / `releasePromptTemplates`, declared together the way
`buildLiveBinding` / `releaseLiveBinding` are, with the release kept rather than the descriptor
because the exit handler runs where the descriptor is out of scope.

**The option that switches it off is read inside the backend**, which is the point. A spawn-applied
option used to prove itself by having its id appear literally in `src/app/terminal/spawn.js` — and
the only way the core can name one backend's option is to know that backend, which
`.claude/rules/backends.md` forbids. `src/app/terminal/spawn.js` still reads `backendDefaults.claude`
by hand for three Claude options; that is the older shape and is deliberately not migrated here,
because changing live Claude launch behaviour inside a Pi feature is how a regression gets filed
against the wrong change. `test/backend-config-fields.test.js` now accepts a second, honest
declaration — `appliedBy: '<hook>'` — and checks all three halves of it: the descriptor really
declares that hook, `spawn.js` really calls it, and the backend's own folder really reads the option.

## Known gaps

- **The collision is untested in a running Pi.** That a user's own template wins was read out of
  `mergePaths` and `dedupePrompts`, not run.
- **The plan text and the app's plan prompt will drift**, and only this chapter says why they are
  separate.
- **Nothing offers the templates to a Pi session the app did not start.** Accepted with the flag
  route; if it turns out to matter, writing into Pi's home is the route that was not taken and this
  chapter records what it would cost.
- **The runtime-driven backend of #568 got this for free.** It spawns a process too, so the same flag
  reaches it, and Pi expands a template before it sends a `prompt` over RPC (spec 30). `pi-native` forwards
  the hook trio unchanged.
