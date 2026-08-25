# Skills

Issue: #462. Built: the skill picker, the descriptor seam behind it, and the app's own skills
directory.

## The problem

Every CLI in the app has skills, and every one of them wants to be asked differently. To hand one over
you had to remember the skill's name, remember whether this CLI takes a slash command at all, and type
the right shape of it. The app already knew the skills — they are read as resources, per backend and
per scope — and it knows which CLI is in the terminal. That is enough for a hotkey.

`insertSkill` (default `Ctrl/Cmd+Shift+S`) opens the third instance of the same palette, after the
saved-variable picker (#207) and the plan picker (#453). It is the same popover in the same place with
the same keys, because a picker that behaves almost like the one beside it is worse than a third
identical one.

## What it lists

Two kinds of row, and the difference is what gets typed.

**The backend's own skills.** `listResources` reports the directory, `expandResource` reads one level
into it in `skillTree` mode — descend until a folder holds `SKILL.md`, report that folder as one skill.
Four backends do it (claude, codex, hermes, pi; pi also allows a single markdown file at the root),
and both scopes are asked for: the CLI's home and the project's.

**Switchboard's own skills.** A directory of the same shape, offered in every session whatever is
running there. They belong to no CLI, so they are always handed over as text. The location is a setting
with a global default and a per-project override: unset means the `skills` directory beside the
database; a relative path in a project is read from the project root, so a team can keep its skills in
the repository.

Sorted by skill NAME, not by source. The name is what someone is looking for; a list ordered by where a
skill happens to live makes them read three groups to find out whether it exists at all. Where the same
name exists twice, both rows stay and each says where it came from — dropping one would hide the fact
that two answers exist.

## What it types

`invocation` is resolved in MAIN, per row, and the renderer never learns which backend it is talking
to. That is the rule the whole renderer is held to, and this is exactly the feature that would have
broken it: a slash command is a CLI's syntax, and a `switch (backendId)` in the picker would have put
it in the layer that must not know any.

The invocation comes off the descriptor (`skillInvocation`). A backend that declares no hook gets the
text fallback, which is the honest answer rather than a guessed prefix. The fallback is a template in
the settings cascade, like the plan reference: every CLI can read a file it is pointed at.

**The answers are measured, in a running session, never read out of a help text** — the rule that
`PAGE_KEY_TARGETS` exists for. Typing a prefix into a live prompt and reading what the CLI offered:

| Backend | What a running session did | Answer |
|---|---|---|
| claude | `/git-com` offers `/git-commit` with the skill's own description and a `(user)` marker | `/<name>` |
| hermes | `/air` offers `/airtable` with the skill's description | `/<name>` |
| pi | `/git` offers `skill:git-commit`; completing it writes `/skill:git-commit` | `/skill:<name>` |
| codex | `/` lists its built-in commands, `/git` offers nothing — its palette does not know the skills it stores | text |
| agy | declares no skills directory, so there is nothing to run | text |

Hermes is the case that shows why documentation would have got this wrong: it takes a `--skills` LAUNCH
flag, which says nothing about a session already at its prompt — and the session turned out to accept
slash commands anyway.

**Claude's plugin skills are offered too (#463), and the picker did not have to change.** A plugin's
skills sit in its cached checkout, which `listResources` used to report only as a plugin directory, so
nothing ever saw one. Claude now lists each installed plugin's `skills/` folder as a skill source of its
own, and everything above applies unaltered — the shared expander walks it, the row says where it came
from, and the descriptor builds the invocation.

Two questions the layout cannot answer, and both are why this is not a directory walk:

- **What the plugin is CALLED.** The invocation is `/<plugin>:<skill>`, and the cache folder is named
  after the MARKETPLACE. `.claude-plugin/plugin.json` carries the plugin's own name; the install key
  (`<plugin>@<marketplace>`) is the fallback. Reading the folder name works on the machine it was written
  on and produces a slash command the CLI refuses anywhere else.
- **Whether it is installed AND on.** A marketplace checkout holds plugins nobody installed, and
  `installed_plugins.json` holds ones that are switched off. A plugin counts when it is in the install
  record for a scope that applies here — `user` everywhere, `local` only in its own project — and
  explicitly enabled in `enabledPlugins`, user settings first, then the project's, then its local file.
  An absent flag is not a yes.

MEASURED the same way as the table above: typing `/caveman:` at a running Claude prompt offers
`/caveman:caveman` and `/caveman:cavecrew`, each with the skill's description and a `(caveman)` marker;
taking the row from the picker types `/caveman:caveman-help` and the CLI runs it.

## It presses Enter

Deliberately unlike the pickers that insert. A variable, a plan reference and — since #469 — a handoff
reference are material inserted INTO a sentence the user is still writing; picking a skill is asking for
it to run. `submitSkillOnPick`
turns that off for anyone who wants to read the line first.

The one thing this owes the user is knowing which of the two happened: when a row goes in as text
because its CLI has no skill command, a toast says so. An insert that silently differs from the one
beside it reads as a bug.

## The palette core (#462)

Writing a third picker was what made the shared core worth extracting. `variable-palette.js` and
`plan-palette.js` were the same 200 lines twice — the geometry, the focus recovery, the outside-click
and scrollbar rules, the listbox semantics, the epoch that keeps two opens apart — all of it paid for
in bugs, and every fix had to be made twice.

`src/renderer/terminal/palette-core.js` owns the behaviour now. A picker is a description: what to
load, how to filter it, what a row looks like, what Enter does. None of the three picker files holds a
DOM node or an event listener.

One palette is open at a time across all pickers. Two of these on screen would fight over the anchor,
the focus and the Escape key, so `closePalette` takes no picker — whoever is open closes. The callers
that used to close each picker in turn make one call.

## Files

| Area | What is there |
|---|---|
| `src/app/skills.js` | the listing: both scopes off the descriptor, the app's own directory, the invocation lookup, `get-skills` |
| `src/backends/*/index.js` | `skillInvocation` where it was measured, and the `skillInvoke` capability answer for every backend |
| `src/backends/capabilities.js` | the `skillInvoke` row |
| `src/renderer/terminal/palette-core.js` | the popover every picker opens |
| `src/renderer/terminal/skill-palette.js` | this picker's description |
| `src/renderer/panels/settings-*.js` | the three settings, global and per project |

## Known gaps

- A plugin's skills follow the plugin, so a plugin the user installs while a session runs is picked up on
  the next open of the picker and not before — the list is built per open, and nothing watches the
  install record.
- Codex stores skills it cannot run from its prompt. If that changes, it is one descriptor hook and one
  measured row here.
- The app's own skills are read, never written: there is no editor for them, the same way the app reads
  plans and does not write them.
