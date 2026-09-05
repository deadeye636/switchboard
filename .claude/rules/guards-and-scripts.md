---
paths:
  - "test/**"
  - "scripts/**"
---

# Guards and scripts

These two directories had no path-scoped rule at all. Everything reaching them came from `CLAUDE.md`,
which is always loaded and therefore says only what is worth saying to everyone. What follows is the
part that is specific to writing a guard or a tool, and it is short on purpose: a module's own header is
still the authority on that module. This file holds what is true ACROSS them, because that is exactly
what no header can hold and what has drifted repeatedly.

## A guard that carries a list is a SECOND COPY of something

Almost every guard here works by writing down what it expects and comparing. That written-down half is a
copy, and a copy drifts. Three that did, each found after the fact:

- `WHERE_IT_GOES` in `test/main-no-new-ipc.test.js` against the table in `.claude/rules/main-process.md`
  — six modules apart. The test's copy is the FAILURE MESSAGE, so it is the half an agent reads, and a
  handler whose area was missing from it became a `GRANDFATHERED` entry instead of moving.
- `ALLOWED_BINDINGS` in `test/backend-integrations.test.js` against what a rule said its size was.
- `MANAGED` in the old `scripts/check-*-help.js` against what the app actually sends — see below.

So: **name what your list is a copy of, in the file, next to the list.** "Change one, change the other"
is worth writing but is not a mechanism; where the two can be compared in code, compare them instead.

## Prefer DERIVING to listing (#548)

A hand-typed list can be wrong in the same direction as the thing it audits, and then the audit agrees
with itself and passes. `hermes --checkpoints` was missing from the CLI **and** from the list at once;
every session launched with that toggle died at spawn and the check stayed green. `scripts/managed-flags.js`
now derives the managed set by running `buildLaunch` at every launch shape with every option at a value
that reaches the argv, plus `buildLiveBinding`. Write the flag and the audit covers it; write a list and
it does not.

The residue that cannot be derived is one hand-written door — a script's `SENT_ELSEWHERE`, for a flag the
core adds outside the descriptor — and **each entry names where it is sent, with a test that checks that
file really sends it.**

## An allow-list entry carries its reason, and the list is checked BOTH ways

`GRANDFATHERED`, `ALLOWED_BINDINGS`, `DELIBERATE`, `NOT_ON_DISK`, `AUDITED_EXCLUDED` — every one of them
is a place to silence a finding, and that is what they turn into without two properties:

- **A reason per entry.** Not a category, the actual sentence: why this one is not a defect.
- **A stale entry FAILS.** An exemption whose path came back, an allow-list file that no longer contains
  the token, a grandfathered handler that has moved — these must be reported, or the list only ever
  grows. `scripts/check-doc-refs.js` and `test/backend-path-neutrality.test.js` both do this; copy the
  shape.

A red guard that only says "no" ends as a new entry in its own allow-list. **It has to name the
alternative** in the failure message, and that alternative has to still exist — test it.

## Walk the directory, or list the files — decide, and say which

Both are right for something and the trade-off is opposite:

- **Walk the tree** when a violation can hide in ANY file, including one that does not exist yet — a
  hardcoded path, a hand-rolled comment stripper. A new file is covered by default.
- **List the files** when the check needs per-file knowledge (an allow-list of legal bindings). Then a
  file split that forgets to add its new halves moves code out from under the guard silently, so the
  list says so in a comment and the split adds the line.

If you write a file map, write down that a new file is NOT covered until it is listed.

## Reading source as text: the shared stripper, always

`test/helpers/strip-comments.js`. Never a pair of regexes — CLAUDE.md reflex 14 and
`docs/ai/lessons.md` have what that cost. `test/strip-comments-shape.test.js` refuses a hand-rolled one
anywhere under `test/` or `scripts/` and has no exemption list. Note the failure mode: over-stripping
HIDES violations, so a blinded guard reports success about text it never read.

**And it is `scripts/**` as much as `src/**`.** A help check and an asset script are read as text by
`test/backend-launch-flags.test.js` and `test/asset-font.test.js`, and both went unstripped until #570 —
a flag named only in a comment counted as audited, so it would have been excused from the audit it was
supposed to face. When a file is read BOTH ways on purpose, say which half each question wants, in the
code: the flags come from the stripped source, the exclusion reasons from the prose, because the reason
genuinely IS a comment and a sibling test asserts it exists.

## A source check is a legitimate answer when there is no seam

`node-pty` is required at module load; `test/spawn-first-resize.test.js` therefore reads
`src/app/terminal/spawn.js` as text rather than reaching a fresh spawn. That is not a shortcut, but it is
weaker than a behavioural test and has to say so and say what it is really pinning — usually "the
regression that will actually happen", which is somebody tidying an asymmetry that was deliberate.

## Scripts

- **A new script → `docs/settings-reference.md`** (CLAUDE.md reflex 9). Same for a `SWITCHBOARD_*` env
  var. That page is where the scripts are enumerated; nothing generates the list.
- **A script that spawns a CLI to READ its output must close the child's stdin**, or a CLI that reads
  standard input hangs to the timeout. `src/backends/cli-probe.js` is the one way inside `src/backends/**`
  and its sweep does not reach here — a script closes its own (#541).
- **`scripts/check-*-help.js` and `check-backend-changelogs.js` REPORT.** They run a real CLI or fetch a
  real page; they do not judge whether an entry matters and they file no issues. Whether something is
  worth an issue is a conversation.
- **`scripts/drive-app.js` is the renderer's only real test** (CLAUDE.md reflex 2), and its own limit is
  the point of `drag`: a dispatched `DragEvent` is not an interaction, and passed a drag a real mouse
  could not perform. When you add a command here, ask what it would let a broken UI claim.
- **Nothing in `scripts/` may end up in the installer by accident**: `build.files` in `package.json` is
  an allow-list led by `src/**/*`, so a script is absent from a packaged build unless it was added on
  purpose. Do not require one from `src/`.

## The same rules as everywhere else

English, no personal or local identifiers — **including in a fixture and in a test NAME**, which is
where they hid last time (`test/no-local-paths.test.js` is the mechanism now). A test that needs a path
invents one.
