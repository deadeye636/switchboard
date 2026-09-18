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
  — six modules apart the first time, nine the second. The test's copy is the FAILURE MESSAGE, so it is the half an agent reads, and a
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
that reaches the argv, plus every spawn-applied builder a descriptor declares (`buildLiveBinding`,
`buildPromptTemplates`, `buildSessionResources` — the script's header is the list). Write the flag and the audit covers it; write a list and
it does not.

The residue that cannot be derived is one hand-written door — a script's `SENT_ELSEWHERE`, for a flag the
core adds outside the descriptor — and **each entry names where it is sent, with a test that checks that
file really sends it.**

## An allow-list entry carries its reason, and the list is checked BOTH ways

`GRANDFATHERED`, `ALLOWED_BINDINGS`, `DELIBERATE`, `NOT_ON_DISK`, `AUDITED_EXCLUDED`, `PLURAL_ALLOWED` — every one of them
is a place to silence a finding, and that is what they turn into without two properties:

- **A reason per entry.** Not a category, the actual sentence: why this one is not a defect.
- **A stale entry FAILS.** An exemption whose path came back, an allow-list file that no longer contains
  the token, a grandfathered handler that has moved — these must be reported, or the list only ever
  grows. `scripts/check-doc-refs.js` and `test/backend-path-neutrality.test.js` both do this; copy the
  shape.

A red guard that only says "no" ends as a new entry in its own allow-list. **It has to name the
alternative** in the failure message, and that alternative has to still exist — test it.

## A guard for a duplicated pattern errs towards CATCHING

A false positive costs one reviewed line in an allow-list. A false negative is silent, which is the whole
failure mode a duplication guard exists to prevent — so when the two trade off, take the noisy one.

The worktree-layout guard is the worked example. It scans `src/` for the bare word `worktrees`, and a
sidebar fold that says "2 worktrees" to a user made it red. Narrowing the pattern to the LAYOUT — the word
with a dot within twenty characters — looked obviously right and left a hole a real copy falls into: the
window cannot cross a quote, so `path.join(dir, '.claude', 'worktrees')`, the idiomatic separator-safe
spelling in this codebase, matched nothing at all. The scan went back to the bare word and the one label
carries a named exemption (`PLURAL_ALLOWED` in `test/worktree-path.test.js`, which is in the list
above and has both of its properties).

**And a guard that carries its own pattern is a second copy of the thing it audits.** That test asserts
the shapes a fifth copy would take DO match, so the pattern is checked in both directions rather than only
against a tree that happens to be clean today.

**Write the shapes down BEFORE the tree is clean — they catch the pattern, not the code.** The sibling
guard in the same file (every surface that names a worktree asks `worktreeLabelOf`, #586) was first
written as `/worktree/i`, and the three violation shapes asserted beside it failed on the spot: this
codebase writes `wtName`, `wtProject`, `wtGroup`, so the realistic sixth surface would have been spelled
with the abbreviation and walked past a pattern named after the full word. The tree was green either way.
The shapes are what found it, and they cost three lines.

**A GENERATED file is not source, and tell it apart by a property.** That same scan went red on
`codemirror-bundle.js` and `pdf-worker.js`, which contain a minified `wtX` by chance — and both are
gitignored, so the guard was red here and green on a fresh clone, which is the one state a guard may
never be in. It skips a file with a line over 20 000 characters instead of naming the two: measured, the
three generated files under `src/` have longest lines of 689 244, 379 215 and 146 030 characters and the
longest hand-written line in the tree is 3 835 (an inline icon SVG). The next bundle is covered on the
day it is built, and no list goes stale.

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

## `not ok - test\<file>.test.js` with `# fail 0` has TWO causes, and they print the same thing

Node wraps each file as a test of its own, and `--test-timeout` applies to that wrapper as well as to the
tests inside it. So the whole file can be cancelled for two quite different reasons, and the four lines it
prints — `failureType: 'testTimeoutFailure'`, `# fail 0`, `# cancelled 1`, a duration equal to the cap — are
byte-identical in both. Neither reads like a defect, and the first instinct is to call it an infrastructure
hiccup. It is not.

- **The file leaks a handle.** Its tests all finish and the process then sits there, because nothing is
  running to time out and the runner waits for the event loop to drain.
- **The file is simply slow.** It makes progress the whole time and runs past the cap.

**The distinguisher is the subtest list, and it is the only one.** A leaker reports every one of its tests
as `ok` and then stalls; a slow file reports a truncated list. That is the first thing to look at, before
any theory about what is open — measured after this paragraph's first version asserted the leak as the
cause and sent a whole investigation after one that did not exist (#630). `panes-view.test.js` was the slow
case: 206 tests in one file, 13-20 s alone and **41 s under the suite's own 20-way concurrency**, against a
60 s cap. Another agent session on the machine is enough to push it over.

So measure the file's wall clock before anything else, and remember the number is not the one you get by
running it alone.

### The leaking half

What causes it here is a module under test that opened something in `init`. `plans-memory.js` starts an
`fs.watch` on every plans directory the backends it is handed declare — **including Claude's own, which is a
real directory on the machine running the suite** — and one open watcher keeps the process alive for good.
The file had been getting away with it by accident: its last test happened to re-initialise with a backend
list declaring no plans store, and the key change closed the watcher. Adding a test after that one brought
the watcher back and the file stopped exiting (#630).

So: **a test that calls an `init` hands back what it started**, through the module's own teardown export
(`stopWatchingPlansDirs` here, exported for the ordered teardown and reused by the test). Do not rely on
what the last test in the file happens to leave behind — that is a property nobody can see and the next test
appended to the file silently changes it.

Diagnosing one: run the file alone with a hard `timeout`. Every test prints `ok`, the file then prints
`not ok` with a duration equal to your timeout, and `process._getActiveHandles()` after the last test names
what is holding it open. `--test-name-pattern` is no use for bisecting — filtering keeps the process alive
by itself.

`test/npm-test-script.test.js` carries the static half of this: it derives every module under `src/` that
calls `fs.watch`, derives each one's teardown from its own exports, and fails by name on a test file that
starts one and never hands it back. It has no exemption list and nothing to put in one. Its limit is in its
header — `fs.watch` and nothing else, because a timer here is covered by the `unref()` discipline in `src/`
and a worker, a socket or a child process is not covered at all.

### The slow half

The three ways out all cost something: split the file, raise the cap, or accept the risk. Raising the cap
is what happened first at #630 — the timeout is per TEST, so it buys a slow file room while a genuinely
stuck test still fails, just later. `CLAUDE.md` carries the number and the reason; when you change it,
change it there too. Splitting is what actually moves the wall clock, because node parallelises across
FILES and not within one: `panes-view.test.js` became `panes-view` / `-tabs` / `-views` / `-drag`, by
subject, and the four run in the time the slowest of them takes.

`test/npm-test-script.test.js` guards the drift back. It is a **projection, not a timing run**: the tests a
covered file registers, times a recorded per-build cost, times a concurrency penalty derived from the pair of
measurements at #630 (16.8 s alone, 41 s under the suite's own concurrency), against a sixteenth of the cap.
A harness is any file under `test/helpers/` that builds a `new JSDOM` and exports one `setup*`, and its
covered files are whatever requires it — both derived, no list. **A jsdom-building helper that does not
offer exactly one `setup*` FAILS the guard rather than dropping out of it**, and that is deliberate: a
harness falling out silently takes every file it covers with it, and the guard's own backstops stay green
because the other harness keeps the counts non-zero. So a new helper whose entry point is called `makeDom`
meets a red guard with the alternative in the message — name it `setup*`, or teach the scan which export is
the way in. The `setup*` convention exists nowhere else; this is the file that made it one. The small fraction is deliberate and the
reasoning sits beside the constant: the projection counts builds only, about a third of the real cost, so a
budget near the cap would have passed the very file this catches.

**Its per-build cost is RECORDED, and the first version's live measurement is why.** That one was careful —
nine builds, median, taken before any test file was loaded — and it still failed on its first full `npm test`
while passing alone, because inside the suite twenty files are building jsdom worlds at once. A guard that is
red only under the load it exists to reason about teaches people to re-run until it is green, which is worse
than not having it. So the only variable input is the test count, which is deterministic, and what that gives
up is written in the guard's header: a harness that gets slower is invisible until somebody re-measures.
The other thing worth knowing here: the band between today's largest covered file and the file that went red
is a factor of three, so re-calibrate rather than nudge the number if a split lands in between.
