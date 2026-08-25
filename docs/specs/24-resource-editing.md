# Editing a backend's own files

Issues: #440 (read), #441 (write, create, delete). Built: the Agent Files tab shows what each CLI reads
its behaviour from, and can now change it.

## Two halves, and the second is where the rules are

#440 made a customization directory expandable and its entries readable. It shipped one guard short of
its own scope: an entry opened in the ordinary memory panel, which came with a working Save and none of
the safeguards, while the issue said "read-only step". That gap is what #441 closed — not by adding a
read-only flag, but by making the save real and guarded.

## The write core

`src/app/safe-write.js`. Three properties, each missing from at least one writer before it existed:

**It must not silently win a race.** The caller says what it believed the file to hold; a file holding
something else refuses the write and hands back its current text. **Content, not mtime.** The issue asked
for an mtime check; the codebase had already argued the other way in `viewer-panel.js`, and the argument
holds: an mtime has a resolution and a clock behind it, and against an agent saving every few seconds
that is the difference between a certainty and a coincidence. It is stronger for exactly the case the
issue names — the hook entry this app patches into Claude's `settings.json` — and needed no new state in
the renderer, because the panel already holds its baseline. It is check-then-write, not a lock, and the
module says so rather than implying safety.

**It must not be half-written.** A CLI reading its config mid-save would get a truncated file and refuse
to start. Temp file in the same directory, then a rename, with a short retry for the Windows case where a
scanner or the CLI still holds a handle. On exhaustion it fails; it never falls back to a truncating
write, which would reintroduce exactly what the atomicity is for.

**It must not rewrite what nobody touched.** CodeMirror hands back LF with no BOM, so the first save of a
CRLF file would rewrite every line of it and a BOM'd `settings.json` would lose its BOM.

Every writer uses it: `saveMemory`, `savePlan`, `save-file-for-panel` — the last of which every preview
tab uses and which had none of the three, not even a baseline argument — plus the resource writer this
spec adds and, since #468, the one that saves a handoff packet into its project. `writeTextFile` is the
grep that stays true.

## Validation

`src/app/format-validate.js`, keyed by **extension** rather than by backend: TOML is TOML for everyone,
and a backend that invents a format gets an entry here rather than a rule of its own. JSON, TOML
(`smol-toml`), YAML (`js-yaml`) and a skill's frontmatter.

**Syntax only, never schema.** Four CLIs change their own settings schema whenever they like; a schema
check would refuse files they are perfectly happy with. A format with no parser is saved and *says* it
was not checked — a different promise from checked and fine.

## What each backend allows is the backend's answer

Two declarations, because both questions are its own:

- `resourceEditing: { extensions }` — which of its files the app may save. This is what makes "nothing
  executable" mechanical rather than a promise: pi keeps skills as markdown but extensions as `.ts`,
  hermes hooks are arbitrary files. **A backend that declares nothing is read-only.**
- `resourceScaffolds: [{ kind, layout, sources, template }]` — what it can create and where. `sources`
  are the same keys `expandResource` reads, so a scaffold cannot drift from the directories it belongs
  to, and a kind cannot be created in a directory that holds a different one.

`docs/backend-formats.md` carries the per-backend table.

## Deleting is narrower than writing

Reachability answers "is this under a directory whose layout the backend declares" — which admits a
settings file and every helper beside a skill. Deletion asks whether the path is one the **expansion**
itself named, of a kind with a lifecycle (skill, rule, command, agent, prompt template). A settings file
is a listed *file* and never an expansion entry, so it is unreachable by construction rather than by a
deny-list somebody has to remember to extend.

A skill is its folder, and that folder must be strictly inside the listed directory, still hold the file
it was listed for, and stay inside after its links are followed. Which kinds have a lifecycle is the
core's vocabulary: the payload stamps each row, and the renderer offers the button where main would act.

## Two things the tab needed before any of this was reachable

- **Settings files were not in it at all.** The group builder walks directories and a settings file is
  not one, so Claude's `settings.json`, Codex' `config.toml` and Hermes' `config.yaml` had no editing
  surface — the app could have validated TOML for a file nobody could open. They are one group per
  backend now. Model caches stay out: the CLI rewrites them, and editing one is a trap.
- **An empty directory was dropped**, which is precisely where a first skill belongs. It is kept when
  something can be created in it, and that is where the "New" sits — the kind, the backend and the target
  are the group's own, so only the name is asked for.

## What is left

A directory that has never existed cannot receive its first file: the listing only names directories that
are there, so a project with no `.claude/skills/` at all is not a create target. It needs a `dirFor`
answer on the scaffold, so the backend names the directory from its own store-override-resolved home.

## Tests

`test/safe-write.test.js` (encoding round-trip, the conflict refusal, the rename retry and its cleanup),
`test/format-validate.test.js` (each format, and the honest "unchecked" answer),
`test/backend-resource-write.test.js` (every guard, plus create and delete),
`test/plans-memory-resource-groups.test.js` (which groups appear, which rows may be deleted, which may be
created in). What none of them can prove is the click: the conflict bar rendering, the New dialog, the
delete confirmation — `node scripts/drive-app.js` is what covered those.
