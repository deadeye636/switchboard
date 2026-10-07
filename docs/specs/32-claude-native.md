# 32 — Claude driven through its stream protocol, not through a terminal

Issue #653, built in #657, #658, #655, #659, #660 and #661. The backend is `src/backends/claude-native/`,
the core half is `src/app/agent-rpc.js`, and the surface is `src/renderer/session/conversation-view.js`,
the same three places spec 30 describes for Pi. This spec covers what is different for Claude. Where the
mechanism is the shared one, it points to spec 30 instead of describing it again.

Every "measured" in this spec is Claude Code 2.1.283, driven over the pipe in an isolated home while
#653 to #661 were built. The larger measurements are recorded on those issues' comments; the smaller ones
are recorded here and, where the code depends on them, in the comment beside that code.

## What changes for the user

Claude Code has a print mode that speaks JSON on both sides:
`claude -p --input-format stream-json --output-format stream-json` takes one line per turn or control
request and writes the turn back as events. The Claude Agent SDK is a wrapper around exactly this: it starts
the Claude Code binary and speaks this protocol to it. `Claude (native)` does the same without the SDK. It
starts the `claude` the user installed, draws the conversation in the conversation view, and sends turns
and answers down the same pipe.

Skills, commands, `CLAUDE.md`, hooks, MCP servers and plugins load from `.claude/` and `~/.claude/` the way
they do in the terminal, because it is the same binary reading the same files. The terminal Claude backend
stays as it is. Anyone who wants Claude's own TUI keeps it, and neither backend has to keep two surfaces
in step.

## Decisions

| | Decision | Why |
|---|---|---|
| E1 | Speak stream-json directly to the installed `claude`. No npm Agent SDK. | The SDK runs the same binary over the same pipe. It would add an ESM dependency and nothing the app needs. |
| E2 | No billing notice in the UI. | See "Billing, for the record" below. |
| E3 | A separate backend, `claude-native`, beside the terminal one. | The same split as pi-native: one surface per backend. |
| E4 | **No login flow, no token.** The backend starts the CLI the user installed and signed in to, as that user, and handles no credential of any kind. | Anthropic's Agent SDK documentation says third-party developers may not offer claude.ai login for their products unless approved. The backend stays on the right side of that line by not touching authentication at all. A CLI that is not signed in says so in its own words, on screen, and `/login` answers that it is not available in this environment. |
| E5 | **No trust, no start** (#655). | Print mode skips Claude's workspace trust dialog. See "The trust gate". |
| E6 | The permission mode follows the usual cascade, global → project → session (`backendDefaults.claude-native`). Unset sends no `--permission-mode`, so Claude's own `defaultMode` applies. | An unset option describes what the CLI does anyway (`.claude/rules/backends.md`). |
| E7 | One implementation per concept. What is not one CLI's is shared with pi-native. The backend keeps only its protocol translator, its launch and its marker. | See "Shared with pi-native, and what is not". |
| E9 | The marker means "driven over the pipe at least once", as for Pi. | See "Who owns a row". |
| E10 | Image input is in scope, through the same view code as pi-native's (#656). | Built in #662; see "Images". Paste and drop only, no file picker (a file that is not attached is named as `@<path>`, #699); the view refuses a format or size the backend does not declare, and a model that cannot read images gets the CLI's own error (owner, #662). |
| E11 | No AFK timeout for a piped child, for now. | `CLAUDE_AFK_TIMEOUT_MS` is about a terminal left alone. |
| E12 | A driver's store is read while the driver is on, even with its owner switched off. | Without it a new session never reached the sidebar with the owner off (#658). |
| E14 | A stop waits only where the CLI needs time to finish its transcript. | Measured: a child killed the moment its `result` arrived had already written the turn's last line, so claude-native declares no `gracefulStopMs`. |
| E16 | Approving a plan is a plain allow. No "approve and accept edits". | `ExitPlanMode` carries no permission suggestion, so there is no mode to take over. An app-built one was measured working and left out by the owner (#661). |
| E17 | "For this session" hands back only suggestions whose destination is the session. | A suggestion naming a settings file would outlive the session and write a file of the user's (#661). **Narrowed by E19 (#674):** the project's local settings are offered behind a button of their own. |
| E18 | No special order for `default_to_no`. | No request in any measurement carried the field (#661). |
| E19 | **A lasting allow for the project is offered after all** (#674, route A; narrows E17): the card hands back Claude's own `localSettings` allow rule, and Claude writes it into `.claude/settings.local.json`. Suggestions for the shared project settings and the user's settings stay unoffered. | The same one-click choice Claude's terminal offers, without the app writing a file of the CLI's (CLAUDE.md rule 11). The price: a click on a card changes a file in the project that outlives the session, and the app does not show the rule afterwards. |
| E20 | **The permission mode can be switched in a running session** (#696): Shift+Tab in the input and a click on the mode in the session line walk the TUI's order. The switch is the session's; it writes nothing to the stored `permissionMode` option (E6), so the next launch starts where that says. | The TUI can do it and the view could not even show the mode. A session-only switch keeps the cascade the one answer to "how does a session start". |
| E21 | **An approval says why it is asked** when Claude says so: the card draws a `reason` line built from `matched_ask_rule`, `decision_reason_type: 'rule'` and `decision_reason` — the rule, the settings it came from, and — where the card offers nothing lasting — that an ask rule leaves nothing lasting to offer. | In auto mode the only questions are ask-rule matches and they carry no suggestion, so a card with only Allow once and Refuse looked like a missing feature. The app reads the fields and writes nothing; removing the rule stays the user's call. |

E8 and E13 are pi-native's half of the trust gate and are recorded in spec 30 (its E5). E15 is not
recorded on any issue and is left out here.

### Billing, for the record

As of September 2026, `claude -p` and Agent SDK usage draws from the user's existing subscription, the same
as the interactive CLI. A move to a separate monthly credit, with overflow at API rates, was announced for
2026-06-15 and paused that day, not cancelled. If it comes back, sessions of this backend fall under it and
sessions of the terminal backend do not. The app shows no notice about it (E2). `/cost` in the view prints
the CLI's own sentence about what the usage draws on.

## The trust gate

Measured on Claude Code 2.1.283, in a folder Claude had never trusted: the project's `SessionStart` hook
started, the project's `CLAUDE.md` was read, and nothing was recorded in Claude's trust store afterwards.
`claude --help` says the same: the trust dialog is skipped in non-interactive mode. A checked-out
repository's hooks and MCP servers would therefore run without the question the terminal asks.

So the descriptor declares `trustBeforeStart`, and the spawn path asks Claude's saved answer through
`projectTrust` before anything is built. `null`, an error and anything but `true` all refuse. The app
then asks the trust question itself, with the confirm the Projects manager uses, and starts again on a yes.
Claude's trust can cover a whole repository, which every checkout of it shares, so the refusal carries that
scope (`sharedGate`) and the launch confirm shows the same "every checkout is trusted too" line the manager
shows. A launch nobody made at the keyboard, such as the restore at start, asks nothing and leaves the
refusal in the tab. The gate is one implementation for both runtime-driven backends; the launch paths and
their tests are listed on #655.

There is no start with the project half left out. A session that silently has less than the user expects
is worse than one that does not start.

## Who owns a row

The rule is spec 30's: two backends over one store cannot both own a row, so the row stays Claude's and
how it was driven is a field of its own. Only the marker is different.

1. **Claude Code writes the marker itself.** `CLAUDE_CODE_ENTRYPOINT` in the child's environment is
   written verbatim into every transcript line (measured): `sdk-switchboard` comes out as
   `"entrypoint":"sdk-switchboard"`, where a terminal session writes `cli` and a user's own `claude -p`
   script writes `sdk-cli`. Nothing of the app's is written into Claude's store.
   `src/backends/claude/transport-marker.js` spells it once, beside the reader.
2. Claude's reader sets `row.transport` once any line carries it. The flag lives in the incremental parse
   state, so an append keeps it.
3. **The launch record names the driver; the row names the owner.** The launch overlay records
   `claude-native`, and Claude's indexer used to stamp that onto the row, which would have put it outside
   Claude's own reconcile. `rowOwnerOf(id)` in `src/backends/index.js` turns the recorded id into the owner
   before the stamp.
4. `backends.openerFor(row)` hands a marked row to claude-native while it can launch, and back to the
   terminal backend when it is off. The transcript is Claude's either way, so resume and fork work from
   both.
5. **The user can choose, per session (#670).** A view picked for a dormant session (Terminal / GUI) — in
   the Resume dialog, with the sidebar row's switch button or from the command palette — is
   stored in `session_meta.opener` and wins over the marker while its backend can launch — the same
   function, with the choice as a second argument, as spec 30 describes. The marker keeps meaning "driven
   over the pipe at least once" (E9 is unchanged); the stored choice is what lets a session driven here go
   back to the terminal without switching claude-native off for every session.
   A stored choice that cannot launch is kept and today's route applies, which has one consequence worth
   knowing: a stored Terminal on a MARKED row with the terminal backend switched off opens in the GUI,
   because the marker then decides. "Can launch" means ready, enabled and installed, the same set for the
   sidebar and the spawn.
   The sidebar row of such a session keeps the owner's backend badge and shows where it opens (a terminal
   or a conversation glyph) right after it, and *Use the default view* in the palette clears the choice. While either half cannot
   launch, the row keeps its badge and no surface offers a view.
   **A RUNNING session is switched in place** (step S3, route B): the row's button, the pane menu's Session
   group and the palette all call `switchSessionView` (`src/renderer/dialogs/dialogs.js`). It refuses while a
   turn runs, while something waits for an answer, and before the first turn (a session still pending has no
   transcript, so there would be nothing to resume), asks, stops the process, waits until the exit has been handled
   and opens the session again with the other view as an explicit choice, which the spawn validates and
   stores as for a dormant one. The exit handler hands that exit to the switch (`takeViewSwitchExit`), so no
   banner is written and the tab stays. Chosen over a main-side sequence with a pre-flight because it reuses
   only existing acts; the price is that the target is checked only by the spawn, after the stop, so a launch
   that fails leaves the session stopped with the ordinary error rather than still running in the old view.
6. **A fork carries the marker of where it was made, not of its parent** (measured 2026-10-06, #670). Claude
   rewrites `entrypoint` on the lines a fork copies: a parent driven over the pipe (every line
   `sdk-switchboard`) forked from a terminal-style launch gave a fork whose copied user and assistant lines
   all read that launch's own entrypoint. So the parent's marker cannot move a fork into the GUI, and a fork
   needs no copy of the parent's stored choice: it starts in the view the parent opens in, and its own lines
   record that view. `scripts/measure-claude-fork-marker.js` repeats the measurement.

**Claude's own `/resume` picker does not list these sessions.** It hides every `sdk-*` entrypoint
(measured), so a session started here is found in Switchboard, not in the CLI's picker. The terminal
backend opens it from the sidebar like any other Claude row.

## How the child is driven

The launch, in `buildLaunch`:

```
claude -p --input-format stream-json --output-format stream-json --verbose
       --include-partial-messages --replay-user-messages --permission-prompt-tool stdio
       --session-id=<id> | --resume=<id> | --resume=<parent> --fork-session --session-id=<new>
       [--permission-mode <mode>] [--model <model>]
```

Each flag is there for a measured reason, and the reasons are in the comment above `buildLaunch`. Session
values are passed as `--flag=value`, so an id can never be read as a flag. The child is started with argv
and no shell (`spawnMode: 'argv'`). On Windows that needs the native `claude.exe`, because an npm
`claude.cmd` cannot start without a shell, and the probe says so rather than failing at spawn.

The version floor is checked only when a session is about to start (`probe({ launch: true })`), because
reading `claude --version` costs a child process and the registry's probe runs on every scan. The floor is
2.1.283 because that is the version every measurement here was taken against, not because an older one is
known to fail.

**Not applied to this backend**, each gated on the descriptor's `transport` and never on an id: the live
binding's settings file, the MCP IDE bridge and `--ide`, the terminal title heuristic, and
`CLAUDE_AFK_TIMEOUT_MS`. The attention hooks the app writes into Claude's global settings reach a piped
child too (measured for a global `SessionStart` hook, inferred for the app's own hooks, spec 05).
`src/app/hooks.js` drops their attention delivery for a session with `transport` and keeps the
per-turn transcript refresh (spec 05, #659).

### Turns, steering and Stop

A turn line is never answered. The core takes the write as the send (`sendAcknowledged: false`), and a
write to an idle session is its busy edge. `result` ends the turn.

The view's three modes map onto the user line's `priority` (measured with a turn of three sequential Bash
calls):

| View | Line | What Claude does |
|---|---|---|
| Send, idle | no `priority` | runs the turn |
| Queue (Enter while a turn runs, by default) | held by the app, then no `priority` | nothing until the running turn ends (#702, below); then it runs as its own turn |
| Steer (Ctrl+Enter while a turn runs, by default) | `priority: 'next'` | injects the line into the running turn at its next tool boundary; the turn ends in one `result` |

Which of the two keys queues and which steers is the global setting `conversationEnterWhileBusy` (#756): `hold`,
the default, is the table above; `steer` swaps them, so plain Enter reaches the running turn as it does in
Claude Code's own terminal UI. The placeholder text, the two buttons' titles and the held prompt's tag name
the current pair, and the first prompt the view ever holds says once how to steer instead. It applies to every
backend the conversation view drives, since each offers Steer. A steered line cannot be withdrawn, which is why
the default stays `hold`.

The protocol's `follow_up` mode maps to `priority: 'later'`, which queues the same way. The view sends
nothing in that mode today. Claude's third priority, `now`, cuts the running turn off and runs the line at
once. It is not offered.

A queued turn starts with nothing written by the app, so the decoder reads every turn's `system/init` as a
busy edge too. A queued line without a priority is written into the transcript as an `enqueue` at once, but
a `later` line is kept in memory and its `enqueue` is written only as the turn before it ends (both
measured), so the transcript cannot always tell the turn-hold that a turn is owed. The core counts the turn
lines it wrote while a turn ran (`agentRpc.turnQueueOf`), and the turn-hold asks that before the row's own
`readTurnQueue`.

Stop sends an `interrupt` control request. The process stays, and the running turn ends with an ordinary
`result` of subtype `error_during_execution`, the same shape a turn that really failed has. The decoder
hears the lines the core writes (`noteSent`) and draws that result as "Stopped." only when a Stop went out
before it. A queued `later` line survives a Stop and runs right after (measured); a queued line without a
priority was not measured against a Stop.

**The app holds the queue (#702).** Once a line is written, Claude owns it: it cannot be withdrawn or
edited, and nothing in the protocol was measured to take one back. So a prompt sent while a turn runs is not
written. `src/app/agent-rpc.js` holds it (`held`, per session, so a view mounted later or in another window
shows the same list) and writes the first one when the session is idle again and no question is open, one
per turn, in order. The view draws each held prompt with **edit** (back into the input, after what is
typed there, its images attached again under fresh numbers) and **×** (withdraw). A Stop pauses the held
prompts (owner decision): they stay, show **send now**, and start nothing by themselves; a new prompt sent
while paused and idle goes at once. The pause is set before the abort goes out, and also while the queue is
still empty, because a runtime may settle the run before it answers the abort (Pi's does) and a prompt may
be queued between the Stop and the turn's end. Only one held prompt is in flight at a time: a runtime that
acknowledges its turns turns busy only when the turn starts, and a second flush before that would land in a
running turn. A held prompt the runtime refuses goes back to the head of the queue, images and all, and
pauses it. While the core still owes a turn it wrote as keys (a trigger, a launcher), nothing is flushed
over it. Held prompts that never went out come back to the input, with their images, if the process ends.
A steer is never held, and neither is a `!` shell line. The turn-hold counts held prompts as owed turns
unless the queue is paused. This applies to pi-native too, whose own follow-up queue the view no longer
feeds.

### Identity

The CLI names its session on every line. The decoder announces a new id as an `identity` op and the core
re-keys through the shared re-key. That covers three moves with one path: a fork, whose first line names
the fork's id; `/clear`, which answers `conversation_reset` and continues under a new id in the same
process; and nothing else, because `/compact` keeps the id (measured). There is no `stateCommand`, since
nothing in the protocol answers "which session are you on".

A fork is launched with its own `--session-id` beside `--fork-session`, so the tab is keyed on the fork
from the first frame. Claude writes the fork's file only with its first turn (measured). Until then an
attach reads the parent's file, which holds the same lines under the same uuids.

### History

A view that mounts reads the conversation from Claude's own transcript file (`entriesFromTranscript`),
because the CLI cannot be asked for it. The entries are Claude's transcript lines, which the Message History
viewer already draws, so a live session and its history look the same. The stream and the file share each
line's uuid, which is the entry key the view skips a duplicate by. The race between the file and the pipe
is handled in the core, as for any backend that reads a transcript (`attachFromTranscript` in
`src/app/agent-rpc.js`).

**The message history viewer reads the same lines the same way (#705).** Several derivations moved out of
this decoder into `src/backends/claude/transcript-view.js`, where Claude's format lives:
- a task's end as a `task-notice`;
- a subagent's report as an `agent-report`;
- a slash command's markup, and what it printed, as plain text. That covers the user line and the
  `system/local_command` line (point 6), which is the form most local output takes (202 of 225 over one
  real store).

claude-native imports them. Claude's descriptor answers `normalizeTranscriptEntries` with them, the hook
Pi's `transcript-view.js` answers for Pi, and templates and claude-native inherit it. So a Claude session's
history shows those lines as the conversation view does. Everything else in the file stays in the history
viewer, bookkeeping included.

In the history viewer, a notice's Open goes to the subagent's row, or else to the call that started it. A
notice read from history carries `historic` and offers no Output, because no running session is there to
read it from.

A subagent's transcript is read through the same hook, and so is its live tail while it runs (#717). The
normaliser reads context across lines, so `src/session/subagent-tail.js` keeps the file's lines and
normalises the whole, then sends only what the new lines added. It reads only up to the last complete
line, counted in bytes, so a line still being written arrives whole on the next pass. The history reading asks
no `isSidechain`, unlike the conversation view: in a subagent's own file every line carries it. An older main
transcript with such lines inline therefore shows their notices and reports as cards too, where it used to
show raw markup. Opening a very large subagent costs one extra read and parse of the file for the tail.

A local command's output loses the terminal codes the transcript writes into it (`/compact`'s "Compacted" is
written dimmed). The stream sends that output without them, measured on 2.1.284. Claude's reader strips the
codes where the output leaves its markup (#714).

### A skill's text (#710)

When the model loads a skill, the `Skill` call's result is one line ("Launching skill: <name>"), and the
skill's whole text follows as a user line of its own. Measured on 2.1.284:
- On the stream, that line carries `isSynthetic: true` and nothing that names the call.
- In the transcript, the same uuid carries `isMeta: true` and `sourceToolUseID`.

The decoder pairs the line with the oldest `Skill` result still waiting. The transcript reader pairs it
through `sourceToolUseID`. Both turn it into more output of that call, which a tool block shows collapsed,
so it is never drawn as a user message. A failed call or the end of the turn drops a pairing that is still
waiting. The order in which parallel calls arrive is assumed, not measured.

A skill the USER types (`/<name>`) streams only its command line. Its text stays in the transcript as an
`isMeta` line without `sourceToolUseID` and is left out on a reopen too, so the reopened view matches the
live one. Whether to show it anyway is still open in #710. Protocol point 10 in
`src/backends/claude-native/rpc-protocol.js` holds the same account.

## Approvals and questions

Claude asks before a tool runs over the control channel (`control_request` / `can_use_tool`), but only with
`--permission-prompt-tool stdio`. With `--permission-prompts host` alone, a `Write` was refused on the spot
and the host was never asked (measured).

This is the difference from pi-native that matters most. **The question here is Claude's own**, asked under
the user's own permission rules, the question the terminal would put. A tool the user's rules allow never
reaches the card. A user whose `defaultMode` is `auto` sees few questions: in auto mode the CLI asks for a
permission only where an `ask` rule of the user's matches, and runs or refuses everything else without one (measured on
2.1.285, see "Why a question is asked in auto mode" below). The card carries one line saying that Claude asks
this under its own permission rules, as it would in a terminal. Pi has no approval step, so pi-native builds its own gate in a
per-spawn extension and calls it a convenience, not a security boundary (spec 30). Claude needs no such
extension.

Three kinds of question arrive, all as `can_use_tool`:

- **An ordinary tool.** The card offers Allow once and Refuse. It offers "For this session" only when the
  CLI sent `permission_suggestions` with `destination: 'session'` (E17), and the button says what it allows:
  the measured suggestion for a `Write` is `setMode acceptEdits`, which lets every later edit through, so the
  button reads "Allow all edits for this session". An allow hands the tool's input back unchanged as
  `updatedInput`, which is why `answerCommand` gets the question it answers. A refusal tells the model the
  user refused the call.

  **What Claude suggests for Bash** (measured on 2.1.283, default mode, no rule of the user's matching):
  `sleep 1; echo 1`, `ls` and `git status` ran without a question at all — Claude allows read-only commands
  itself. `mkdir -p <dir>` asked, with three suggestions: an `addRules` allow for that exact command with
  destination `localSettings` (Claude's "don't ask again for this command in this project"), an
  `addDirectories` for the working directory and a `setMode acceptEdits`, both for the session. The card
  offers the two session ones behind "Allow all edits for this session" and the rule behind "Always allow
  “mkdir -p <dir>” in this project" (E19). A Bash call under an `ask` rule of the user's carries no
  suggestion at all, so the card then offers only Allow once and Refuse — the demo home carried
  `ask: ["Bash"]` from the #661 measurements, which is why every Bash call there asked with no session
  button until the rule was removed.

  **"In this project" (#674).** Offered only where Claude suggested an `addRules` allow for `localSettings`;
  the answer hands back exactly those rules as `updatedPermissions`, and `answerCommand` filters them again,
  so an ask that somehow carried more can never reach another settings file. **Claude writes the rule
  itself** (measured on 2.1.283): `Bash(mkdir -p m8dir)` appeared under `permissions.allow` in the project's
  `.claude/settings.local.json`, the next identical call in that session asked nothing, and a new session ran
  it without a question while a different command still asked. The app writes no file and learns no settings
  format. The button names what it allows — the command for Bash, `Tool(content)` for any other tool, and
  "every <Tool> call" for a rule without content — cut at 60 characters; its tooltip leads with the full rule
  as the settings file spells it, then says where it lands and that it is taken back there or with Claude's
  `/permissions` — the app does not show the rule again once it is written. Rules for
  `projectSettings` (usually committed, so the whole team's) and `userSettings` (every project on the
  machine) are still not offered.

  **Why a question is asked in auto mode** (measured on 2.1.285, `--permission-mode auto`, the app's own
  launch flags). Plain and compound commands — `npm run …`, `cd <dir>; npm run …`, `cd <dir> && …`, a `cd`
  into a worktree, `cd <dir>; git log …; npm run …`, `gh issue create`, `git push --force-with-lease`,
  `npx -y <package>` — ran without a question. `gh pr merge` with no rule was refused by the classifier (`[Merge Without Review]`), and that
  refusal is a tool result, never a request, so it never reaches a card. The only questions came from a
  project `ask` rule (`Bash(gh pr merge:*)`): a plain match carried `decision_reason_type: 'rule'`, a
  compound command carried `matched_ask_rule` (`{ source: 'projectSettings', tool_name, rule_content }`),
  `decision_reason_type: 'other'` and a `decision_reason` sentence of Claude's own — about the `cd` before a
  git command, although the same `cd`-then-git line without a matching rule was not asked at all, so the
  card leads with the rule — and **neither carried a suggestion**: an ask rule wins over every allow, so
  there is nothing lasting to offer (E21). A request carrying a rule AND suggestions was not seen; the card
  then leaves out the "nothing lasting" sentence rather than contradict its own buttons. A compound line that merely contains the matched
  command is asked as a whole, so the other commands in it (an `npm run` beside a `gh pr merge`) look as if
  they were the ones asking.
- **`AskUserQuestion`** is a question, not a permission. The card draws its questions with their options,
  checkboxes where several may be picked, and a free answer. The answer is an allow whose `updatedInput`
  carries `answers`. Several choices are joined with ", ", and a free answer is taken as written (both
  measured).

  **Answered like the CLI (#704).** Read from the CLI's own handling on 2.1.283 (its AskUserQuestion answer
  and decline code in the binary): an answer is `allow` with `updatedInput = { …input, answers, annotations }`,
  where `annotations` is `{ <question>: { preview?, notes? } }` — the picked option's `preview`, and the
  user's note on a single-choice question. "Chat about this" is a `deny` whose feedback begins "The user
  wants to clarify these questions." and lists each question with its answer so far and any note; the model
  then asks what to clarify. In the CLI the user types after that; here the text is typed first, so it is
  added to the decline under "What the user wrote:". The CLI offers notes only where the options carry
  previews; the card offers one on every single-choice question.

  **The answer stays in the conversation (#724).** Once answered, the question used to leave only the
  collapsed `AskUserQuestion` tool row, and the turn after it read as if Claude had decided alone. The line
  that carries the call's result also carries what was asked and chosen: `tool_use_result` on the stream,
  `toolUseResult` in the transcript, the same `{ questions, answers, annotations }` under the same uuid
  (measured on 2.1.289 with `scripts/measure-claude-question-answer.js`). Both paths turn it into a user entry after the call, keyed `<uuid>:answer`, with
  each answered question and its answer in the order asked and the user's note beneath it. The entry carries
  `prompt: true`, because it is the user's own input. A reopened conversation reads it from the transcript,
  never from the card. A declined question ("Chat about this", dismissed) carries a string there and no
  answers, so it draws nothing; what the user wrote for "Chat about this" is still only inside the decline
  sent to the model. The message history viewer does not show the entry: its reading keeps one entry per
  transcript line, because bookmarks are keyed on the position.

  **A card stands in the input's place** (owner decision P1, replacing the first version's A1, where the
  input stayed and doubled as the chat field). As in the CLI, a question, an approval, a plan or a pi-native
  dialog waiting on the user is drawn in a dock where the input was; the input, Send and Steer are hidden,
  and what was typed in the input is kept and comes back with it when the last card closes. Stop stays, so
  the turn can still be ended. Several cards wait one after the other ("1 of 2 waiting for you"). A send that
  still arrives while a card is open (a picker's "insert and send") goes to the card instead. "Chat about
  this" is the question card's last row: its field opens on a click or `c`, Enter sends the decline with the
  text, and a second Enter while the first is out sends nothing; a refused decline leaves the text there.
  The dock is kept to 60 % of the view's height and scrolls inside itself.

  **The card is laid out like the CLI's** (D1–D4, looked at in a terminal on 2.1.283): one question at a time
  behind a row of tabs that tick off as they are answered, and a Submit tab that lists every answer, says
  when one is missing, and holds Submit answers and Dismiss (a single question has no tabs and its buttons
  sit under it). Options are numbered with their description under the label. An option's `preview` — the
  text graphic Claude often attaches, a mock-up or a diagram — is kept by the decoder (it used to be dropped)
  and drawn in a monospace box beside the list for the option in focus or picked, under the list when the view
  is narrow. Each single-choice option has a "note" button that picks it and opens the note field under it
  (the CLI's `n`); "Type something" is the free answer, whose field appears once it is chosen. A line of key
  hints closes the card, as in the CLI.

  Every card is answered from the keyboard, questions, approvals, plans and pi-native's dialogs alike. A card
  takes the focus when it appears only when nobody is typing anywhere else: the focus is on this view's input
  (whatever is typed there, since it is hidden behind the card and kept) or its log, or on nothing (V1). It
  never takes it from another pane's terminal or a
  settings field, where the next Enter would answer a card the user has not read. Otherwise its title names
  the key that reaches it, Alt+A (by key code, so Option+A works on macOS), from anywhere in the view. In a
  card: a digit picks the n-th option of the question in view, or presses the n-th button when the focus is on
  one (buttons are numbered as they stand, and a digit on a disabled one does nothing); the arrows move between
  the options (a radio follows the focus, without pulling it into the free answer's field); Tab or ←/→ switch
  questions; `n` opens a note and `c` "Chat about this"; Enter picks the option in focus and moves on — on a
  checkbox it only moves on, on "Type something" it goes into the field — and answers on the review; a dialog that asks
  for text is focused in its field, not on its OK. Escape dismisses a question card or refuses an approval,
  and never stops the turn — only in the input does it. In a text field Escape only leaves the field. **On a
  plan card Escape does nothing (V2):** "keep planning" ends the turn the way a Stop does, too much for a key
  pressed to get out of a card; it is the second button; Stop ends the turn. A card that had the focus hands
  it to the next card, or back to the input, when it closes — but not when the user has since clicked
  somewhere else.

  **pi-native differs.** It never sends a `questions` card, only its extensions' dialogs (select, confirm,
  input), so "Chat about this", notes and previews do not apply there. Its dialogs are docked in the input's
  place like every card, and the keyboard applies to them the same way. When the view is handed the focus (a
  tab switched to, a grid card, a pane), it goes to the card waiting on the user, not to the hidden input; an
  insert into the hidden input (a picker, a paste, a message taken back to rewrite) is kept there and said so.
- **`ExitPlanMode`** carries the plan as markdown. Approve is a plain allow, and the session goes back to its
  mode from before planning (E16). Keep planning is a deny with `interrupt: true`. It ends the turn with the
  same result a Stop gets, and the decoder draws it as "Kept planning".

A request the CLI withdraws (`control_cancel_request`) closes its card and is not answered. The ask/answer
flow, the registry of open questions and the cards are the shared ones; the two kinds `questions` and
`plan` are neutral vocabulary, and the renderer names no Claude tool.

Every card that holds a tool call marks it, so while a card is open the activity line says the call is
waiting on the user ("Waiting for your answer", "Waiting for you to review the plan") and not that it runs.
Before #666 only the approval card did this. When the last open card closes, and when a turn is sent or a
Stop is taken, the view takes down the attention caption the way a keystroke does in a terminal (spec 05,
#666).

## Slash commands

Claude's local commands work over the pipe: `/cost`, `/context`, `/model` and `/compact` answer, and `/clear`
starts a new session in the same process (measured). A local command answers with an assistant line whose
model is `<synthetic>` and an ordinary `result`, so it is drawn as an entry and busy/ready come from the
same `result` as for any turn. `/login` answers that it is not available in this environment.

**The typed command is never played back (#718, measured on 2.1.284 with `/mcp`, `/cost`, `/context` and
`/compact`).** `--replay-user-messages` returns an ordinary prompt when its turn starts, but for a local
command the stream sends only `system/init`, the output and the `result`; `/compact` even sends its
`system/status` lines before the `init`. The transcript does keep the command, as a user line of
`<command-name>` markup, so a reopened session always showed it. Live, the view's instant echo (#694) waited
for a replay that never came: the output was drawn above a "sending…" line that stayed for good. The decoder
now keeps the turn lines the core writes (`noteSent`) and draws a `/` line itself, as the user's entry, in
front of the first thing its turn shows — unless the turn played it back first, which a skill the user types
does. A line written to an idle session is the next turn's, because the core holds a prompt while a turn runs
(#702); a follow-up written during a turn waits for its own turn, and a steer is never drawn this way. A turn
that ends in nothing but a failure or a Stop still draws its line, in front of that notice, and a replay that
arrives after the line was drawn is not drawn a second time. The entry carries no uuid, since the stream names
none; an attach draws the transcript's markup line instead. One window is not covered: a background task's
turn that starts while a follow-up waits in the CLI is taken for that follow-up's turn, so a `/` follow-up
there keeps the view's "sending…" line.

**`/mcp` is answered by the app (#719).** Over the pipe the CLI prints one line and sends the user to the
terminal for the details, which a session without a terminal cannot follow. The control request `mcp_status`
answers a row per server (measured on 2.1.284): `name`, `status` (`pending` right after the start, then
`connected`, `needs-auth`, `failed` or `disabled`), `error` for a failed one, `serverInfo`, `tools`, `scope`,
`source`, and the server's `config`. So a bare `/mcp` is never written as a turn: the backend's `appCommandOp`
names the `servers` op, the core draws the command as the user's line and asks `serversCommand`, and
`serverList` turns the answer into neutral rows — name, scope, state in words, one of three tones, tool count
and a failed server's error. What it costs, stated:

- **The list opens as a manager, not as a card (#728).** #719 drew it into the conversation, where it was stale
  the moment a server moved. It opens in a dialog instead (`src/renderer/session/servers-dialog.js`); only the
  `/mcp` line stays in the conversation, and the transcript holds nothing for it at all.
- **No turn, no busy edge, never held.** Typed while a turn runs, it is answered at once.
- **A server's `config` is never passed on.** Its URL, arguments, environment and headers may carry secrets,
  so nothing of it leaves the backend's folder. A failed server's error is shown on one line, and any URL in
  it loses its credentials, query and fragment.
- **Only the bare command, and only from the view.** `/mcp` with arguments is the CLI's to answer and goes out
  as a turn, as before; so does `/mcp` typed into the session as keys by a trigger or a launcher, which never
  passes through `sendTurn`.

**Managing a server from `/mcp` (#728).** The dialog is the CLI's own `/mcp`: the servers grouped under the
TUI's headings and in its order (project, local, user, enterprise, managed, agent, then claude.ai, then the
built-ins and plugins under "Built-in MCPs" — read from the binary, 2.1.285), a server's details, and its
actions as a numbered menu. ↑/↓ move, Enter picks, a number runs that action, Esc goes back one level and
closes from the list; a click does the same. Measured against an isolated config home on 2.1.285, and what
each measurement decided:

- **Reconnect** is `mcp_reconnect { serverName }`: the server's process is started again (a new pid). A
  refusal is a sentence ("Server not found: x", a failed server's own error, "… is disabled — enable it
  (mcp_toggle) before reconnecting") and is shown as it is, through the same URL filter as a failed server's
  error. It is not offered while a server waits for a sign-in.
- **Disable and Enable** are `mcp_toggle { serverName, enabled }`, and **they are not scoped to the session**:
  the CLI writes `disabledMcpServers` into the project's entry of Claude's user config, a fresh process in that
  project starts with the server disabled, and a terminal Claude session there is affected too. So Disable
  asks first (owner decision O4), with Cancel as the default choice.
- **Authenticate** is `mcp_authenticate { serverName }`. For a remote OAuth server (`http`/`sse`) or a claude.ai
  connector it answers an `authUrl` and listens on a localhost port for the browser's redirect; a stdio server
  is refused, so it is offered only for those kinds and only while the server needs a sign-in. The view opens
  the page, reads the list again every two seconds, and once the server no longer needs a sign-in reconnects it
  unless it is already up (O3). A redirect the browser could not deliver can be pasted
  (`mcp_oauth_callback_url`). **Not measured end to end**: the test server had no account behind it, so whether
  the CLI brings the server up by itself after the callback is not known — the reconnect covers both answers.
- **Sign out** is `mcp_clear_auth { serverName }`, offered for a connected `http`/`sse` server only; the CLI
  refuses a claude.ai connector's type.
- **View tools** is the dialog's own page: `mcp_status` carries each tool's name and its read-only/destructive
  hints, and no description or schema.
- **No command and no configuration in the details** (O2): the CLI's detail page shows the command line, and its
  arguments can carry a token. The details show the state, a failed server's error, the tool count and the group.
- **No change is pushed.** None of the actions emits a line about the server's state, so the dialog asks
  `mcp_status` again after each one and while a server is still connecting.

The list a `/` completes to comes from the CLI's `initialize` control request, which may be sent more than
once (measured). It is sent when the view asks for the list, not at start: turns work without it, and the
session's capabilities arrive with the first turn's `system/init` anyway. The view's completion (spec 30,
"The input completes as you type") offers the CLI's commands and skills from that list with nothing of
Claude's in the view. `/clear` re-keys the tab and the sidebar row through the shared re-key and empties the
view (checked in the demo for #662).

## Images (#662)

An image pasted into the input or dropped on the conversation goes out with the next turn. It is shown above
the input as a thumbnail with a × to take it back, and an image alone is a turn.

- **Which images a session takes is the backend's declaration**: `rpc.imageInput` = `{ types, maxBytes }`,
  carried to the renderer by `backends-list`. Both runtime-driven backends declare the one `IMAGE_INPUT` in
  `src/backends/rpc-shared.js`: the formats and the per-image size Anthropic's Messages API documents (PNG,
  JPEG, GIF and WebP, 5 MB). The view refuses anything else before it is attached and says why, and
  `agent-rpc.js` checks the same declaration again on every turn, whoever sent it. A backend that declares
  nothing takes no images, and the view says so when one is pasted. A refused image that has a place on
  disk is named in the text instead (below, "Other files"). pi-native (#656) sends the images in
  Pi's `images` field and adds nothing else; spec 30 has its half.
- **Where each image stands in the prompt (#688).** Attaching one types `[Image #n]` at the caret, the
  placeholder Claude Code's TUI uses, and its thumbnail carries the same number. The two are one thing:
  deleting the placeholder from the text removes the image, and the × removes the placeholder. Numbers count
  up within one draft and start at 1 again once nothing is attached. pi-native shares the view, so its
  prompts carry the placeholders too, and Pi receives the images in the same numbered order.
- **On the wire** the turn becomes a content array: the text first, then the images in their numbered order.
  That is what the TUI writes (measured in its transcripts: one text block with the placeholders where each
  image was pasted, then the image blocks), so the n-th image is the one the text calls `[Image #n]`. Until
  #688 it was the images first, the order Anthropic's documentation recommends; the TUI's own pairing won,
  because it is the shape the model gets from Claude Code every day. Measured before the switch (Haiku, one
  image, "What number is in [Image #1]?", three runs each way): text first answered correctly 3 of 3, images
  first 2 of 3. Both orders often `Read` the temporary copy as well (below), so that is not the order's
  doing. A turn without images stays a plain string.
- **What Claude Code does with it** (measured): it keeps the image block in the transcript, stores a copy of
  the image under its own temporary directory, and adds a line naming that copy's path. A model may then
  `Read` the copy as well, which asks for an approval under the default permission mode. The history viewer
  draws the image block in the user's message, live and after a remount.
- **A copy that carries text pastes only the text.** Excel and Word put a rendered picture of the selection
  on the clipboard beside the text, so attaching the image as well would add an unwanted thumbnail to every
  paste of a few cells. That picture has no place on disk; a file copied in a file manager does, so a paste
  holding a file with a path is taken as files whatever text rides along (#699).
- **The size is counted on the encoded image**, the base64 text that goes over the pipe, by the view and by
  main alike. Whether the API's 5 MB counts the file or its encoding is not measured, and the stricter
  reading cannot let through an image the API then refuses; a file of about 3.75 MB is therefore the
  largest that attaches. There is no limit on how many images one turn carries: several large ones can
  still be refused by the API's limit on a whole request, and that answer comes back as the CLI's error.
- **Other files are named, not attached (#699).** A pasted or dropped file that is not an image, and an
  image the session refuses, is written into the text as `@<path>` (`@"…"` when the path holds a space), the
  form the `@` completion writes and the one a terminal session gets as a bare path. Several files give
  several references, in one insert after the image placeholders. The path comes from
  `window.api.getPathForFile`; a file with none (a clipboard bitmap, an image dragged out of a browser) cannot
  be named and the view says so. Measured on Windows: a file copied the way Explorer copies it (a file-drop
  list on the clipboard) reaches the paste handler as a `Files` item with its path and no `text/plain`.
  Claude reads the file the reference names into the turn; Pi does not, so
  there the model reads it itself ("Shared with pi-native, and what is not" has the measurement). Until #699 a drop without an image
  answered "Only images can be dropped into the conversation", a paste of a file did nothing, and the other
  files of a mixed drop were left out without a word.

## Background tasks and session figures (#691)

What the view draws from it, since #691:

- **The session line** under the input: the context fill with a small meter, the model with its window
  (`ctx 34 % · Opus 5.5 (1M)`), and the working state with its elapsed time. The fill turns warm at the
  handoff threshold the sidebar's health badge uses (spec 28). Asked with `get_context_usage` at the start,
  after every settled turn, and during a turn at most 1.5 s after each finished entry (`contextCommand` +
  `contextFromResponse` + `contextDuringTurn` on the `rpc` half, #697); the model id is shown as the TUI names
  it (`claude-haiku-4-5-…` → `Haiku 4.5`).
- **Background buttons** beside it, `2 shells` / `1 agent`, only while something runs, from the `tasks` op the
  decoder sends for every `background_tasks_changed`, plus the foreground agents running in the turn (#768,
  below). A click opens the Background list: per task its
  description, its command or agent type, its elapsed time, **Output** (a shell: the end of the file Claude
  named for that task, read in main by task id — the view never names a path) or **Open** (an agent: its own
  transcript, see below), and **Stop** (`stop_task` for that one task). ↑/↓, Enter, X and Esc work in the list.
- **A card for a task that ended** (`task-notice` entry): ✓ finished, ■ stopped, ✗ failed, with the exit code
  or an agent's time and tokens, and an Output link for a shell. Measured in the app: the injected
  `<task-notification>` user line is **not** sent on the pipe, only written to the transcript, so the live
  card is built from the `task_notification` system line and an injected line for the same task is dropped.
  An attach reads the card back from the transcript line (`origin.kind: 'task-notification'`). A stopped task
  writes no injected line, so its card exists only while the process that drew it runs.
  **The Output link appears only where there is output (#725)**, and the output opens inside the card; a second
  click folds it away, and a failure ("The output file is gone.") is said in the card too. The notice names its
  file to the core: live from the system line's `output_file`, read back from the injected line's
  `<output-file>` tag or, failing that, from the "Output is being written to" sentence of the shell call's result.
  The core stats it once when the card is drawn (in parallel for an attach) and offers Output for a non-empty
  `.output` file; the path never reaches the view. So a card read back after a restart still opens its output,
  for as long as Claude's temporary directory keeps the file. The text is not copied anywhere: a temp directory
  that is cleaned takes the output with it, and the next draw offers no link.
- **Open on an agent (#695)**, in the Background list and on an agent's notice card, opens the view a click on
  its subagent row in the sidebar opens: the agent's own transcript, tailed while it runs. The decoder stamps
  the task with a neutral `subagentId`, and the view looks up the row of this session whose `agentId` is that
  id. Until the scan has listed the row, Open scrolls to the call that started the agent, as it did before,
  and says so.
- **A subagent's report (#701)** is an `agent-report` entry: "Agent report" and the sender above the report,
  with Open when the line names the sender's task. **It is drawn as a card of its own and always closed
  (#729)**: one line with what it is and who sent it, no preview, opened in place by a click or Enter/Space
  on that line. #701 first drew it open in the reply's style, and in a conversation it read as the main
  session answering. The tool-output setting (#687) does not govern it, and a search hit inside a closed
  report opens it. Claude injects the report as a user
  line with `origin: { kind: 'peer', from, senderTaskId, body, handback }` — measured over the transcripts of
  2.1.261–2.1.283, some 700 lines, all this shape, `handback` since 2.1.267. Its text is the same report
  wrapped for the model ("Another Claude session sent a message:", an `<agent-message from="…">` block and a
  paragraph about authority after it), which is what the view drew before. The decoder takes the report from
  `body`, drops the harness's opening paragraph up to "The report follows:", and removes the two-space indent
  the harness puts on every line. A line with no `origin` is recognised only by its whole wrapping (the
  sentence and the `<agent-message from="…">` tag), so a prompt that merely begins with the sentence stays the
  user's. Who wrote it is read from what the line carries: `handback` is a subagent's final report ("Agent
  report"), a `senderTaskId` without it is the session's own subagent writing mid-task ("Message from an
  agent", six such lines measured, with a `name`), and neither is another session writing in ("Message from
  another session", one line measured). The entry is keyed by sender and a hash of its text, not by the
  line's uuid: nothing measured says the stream and the file give an injected line the same one, which is
  the same reason a task notice is keyed by its task. Live, Open carries the call that started the agent
  (from `task_started`), so it can scroll there while the subagent's row is not listed yet. The transcript writes the
  line with `isMeta: true` (measured on 2.1.283 in a session this app drove), so both the decoder and the
  transcript reader take it before their `isMeta` filter, or the report would vanish on a reopen. A
  background agent started over a bare `-p` pipe reported through `task_notification` instead and wrote no
  peer line (measured the same day), so the report shape belongs to the hand-back of an agent the session
  delegated to, not to every background task.
- **The sidebar row** says `◉ n` beside the state while n shells and agents run in the background
  (`showBackgroundTasks`, default on). Main sends the counts to the MAIN window (`agent-background`),
  whichever window renders the session.
- **An elapsed time** on "Running <tool>…".

What was measured before any of it was built:

Measured on Claude Code 2.1.283 over the pipe (`-p`, stream-json both ways, Haiku), with two background Bash
calls and one background agent. What the stream carries, all as `system` lines the decoder drops today:

- **`background_tasks_changed`** — `tasks: [{ task_id, task_type, description }]`, the WHOLE list of what is
  still running, sent on every change (a start, an end, a stop) and `[]` when nothing is. `task_type` is
  `local_bash` for a shell and `local_agent` for an agent. This is the one answer to "how many shells and
  agents are running", without counting starts against ends.
- **`task_started`** — `task_id`, `tool_use_id` (the call that started it), `description`, `task_type`,
  `is_backgrounded`; an agent adds `subagent_type`, `prompt` and `spawn_depth`.
- **`task_updated`** — `task_id` and a `patch` such as `{ status: 'completed' | 'killed', end_time }`.
- **`task_notification`** — `task_id`, `tool_use_id`, `status` (`completed`, `stopped`), `summary`, and the
  path of the task's `output_file` (under Claude's temporary directory); an agent's adds
  `usage: { total_tokens, tool_uses, duration_ms }`. Claude then **starts a turn of its own** (a fresh
  `system/init`) to tell the model, and puts the notification into the conversation as a user message that
  begins `<task-notification>`. Before #691 that line, read back from the transcript on an attach, was what the
  view drew as raw text.
- **Stopping one task**: the control request `{ subtype: 'stop_task', task_id }` answers success, the task
  ends at once (`task_updated` `killed`, `task_notification` `stopped`, the list shrinks) and the others keep
  running. Sent for a task that has already ended, it also answers success.
- **The session's figures**: the control request `{ subtype: 'get_context_usage' }` answers `totalTokens`,
  `maxTokens`, `percentage`, `model` and a breakdown by category. Every `result` line also carries
  `modelUsage.<model>.contextWindow`, and `system/init` names the `model`.
  **Answering it costs no tokens** (measured on Claude Code 2.1.292, Haiku, through a logging proxy in
  front of the API): a fresh session left idle for 60 s sent two `HEAD /api/hello` and a burst of
  `/v1/messages/count_tokens` requests — the breakdown is counted per category — and no `/v1/messages` at
  all. The first `/v1/messages` went out only when a prompt was sent. So the fill a new session shows before
  its first turn is what that turn will carry, not context already spent; a session opened and closed
  without input bills nothing. #758 makes the line say so.

- **An agent task names its subagent** (#695): the `task_id` of a `local_agent` task is the `agentId` of its
  subagent transcript, character for character — the file is `subagents/agent-<task_id>.jsonl` and every line
  in it carries that `agentId`. Measured for a background and a foreground agent in one turn. A foreground
  agent gets a `task_started`, a `task_updated` and a `task_notification` too, but never appears in
  `background_tasks_changed`. The transcript lines carry no `tool_use` id; the call that started the agent is
  named in the `agent-<task_id>.meta.json` beside it (`toolUseId`, `requestShape: background|foreground`).
  The `.output` file of a finished agent was empty in both runs, so it is no stand-in for the transcript.

- **A running subagent wears the agent badge** (#762), on the row and the tab, as it does for a terminal
  Claude session. claude-native keeps `supportsSubagents: false`: the subagents are written to Claude's store,
  so `subagentBackendFor` in `src/session/session-transitions.js` asks the owner of that store (`cliOwnerOf`),
  and Claude's seam finds them. pi-native asks Pi the same way, which has no subagents, so a Pi (GUI) session
  shows none. A template on either asks its base's owner. A session's first subagent is
  seen in the scan's bootstrap walk, because the store answers nothing until `<id>/subagents/` exists; a file
  written after the app opened the session (`session._openedAt`) counts as a spawn there.
  **The edges are the pipe's since #769.** At first they came from the store scan alone — this backend has no
  `SubagentStart` / `SubagentStop` hook — and the scan calls an agent finished after 30 s without a write, and
  for good after about two minutes (#518). A subagent inside a long tool call writes nothing for that long: a
  verifier in a real session was called finished 52 s after its start and reopened several times, and the
  badge and the open transcript's live tail went out with each guess. Every agent, foreground and background,
  gets a `task_started` and an end (`task_updated` or `task_notification`, #768), and its task id is its
  agentId (#695), so the decoder sends a neutral `subagent` op for each edge, once. The core delivers it through
  `hooks.deliverBindSignal` as a binding's `subagent-start` / `subagent-stop` — never as a busy edge, and without
  touching a held ready — and closes every open one when the process exits. The renderer files a binding's
  subagent edge under the source `exact` (`src/renderer/session/subagent-live.js`): no scan guess retracts it, the
  settled one included, and a scan sighting after its end is the file settling, not the agent coming back. The
  scan still opens an agent first when the view saw nothing else, and the exact start takes it over. An open
  transcript stops following the file 2.5 s after the end, because the end can arrive before the agent's last
  lines reach the file and the watch polls once a second. An end goes out under the session id its start went
  out under, so a re-key in between (`/clear`) closes the entry the view holds. Two limits are known and left:
  a window reloaded while an agent runs shows no badge for it until its end, because the start is not replayed
  and the scan has already announced it once; and an agent id that came back after its stated end would not be
  believed, which Claude has not been seen doing (a task id is a new id per agent).
  Measured in the demo instance with Haiku: an agent that wrote nothing for 78 s kept its badge on the row and
  the tab and its open transcript's live tail, while the scan logged `[subagent-complete]` 40 s after the start.
  Both went out with the exact end, the tail took the last entries first, and the view stood at the bottom.

- **A foreground agent is counted in the Background buttons too** (#768). Measured on Claude Code 2.1.293
  (Haiku, one foreground agent per run; `scripts/measure-claude-foreground-agent.js` repeats it): `task_started` with `is_backgrounded: false` and `task_type:
  'local_agent'`, `task_progress` lines while it works (a `description` such as "Running Sleep for 25 seconds"
  and a running `usage`), then `task_updated` `{ status: 'completed' }` and a `task_notification`; no
  `background_tasks_changed` at any point. `stop_task` stops it as it stops a background task: `task_updated`
  `killed`, a `stopped` notification and a success answer at once; the call's `tool_result` reads "[Request
  interrupted by user for tool use]" and the turn goes on. So the decoder keeps the foreground agents from their
  start to that end and sends them in the `tasks` op behind the background list, and the Background list offers
  Open and Stop for them as for any agent. A notification without the `task_updated` ends one too, and a turn's
  `result` drops any left, because a foreground agent cannot outlive the turn that waits for it. The same run
  went 51 s between two writes of the subagent's transcript, which is longer than the scan's 30 s end guess the
  row and tab badge above used until #769. The decoder lives as long as the process, and an attach is handed the core's
  last list, so a view mounted mid-run still counts the agent. The sidebar row then carries both marks for the
  one agent, the agent badge and the `◉` count, as it already did for a background agent; they answer two
  questions (is a subagent of this session live, what runs beside its turn) and are left side by side.

Found by listing the control and message subtypes in the CLI binary first; each one above was then seen on the
pipe. pi-native has no background tasks of its own: Pi runs a tool inside its turn, and the user's own shell
lines are already tracked by the view. Its context fill and window come from `get_session_stats`
(`contextUsage.percent`, `contextWindow`) and its model from `get_state`.

### Why the line and the sidebar drifted apart (#697)

The session line and the sidebar row measure the fill from two sources: the line asks the runtime, the row
reads the last assistant line's `usage` from the transcript (`contextWindow`, spec 28). Measured on 2.1.283
(Haiku, 200k window), they count the same tokens: after every settled turn the runtime's `totalTokens` was
the last API call's `input + cache_read + cache_creation`, the sum the transcript reader takes, within 1 to 8
tokens. The system prompt, tools and memory files in the runtime's breakdown are already inside `cache_read`.
For `opus`, `opus[1m]`, `sonnet` and `sonnet[1m]` the runtime's `maxTokens` matched the window
`resolveClaudeWindow` picks.

What differed was WHEN. The line was asked only when a run settled, while the transcript gains a line with
every API call. In one turn of five sequential `Read` calls the line stayed at 17 % while the sidebar read
18, 34, 43 and 52 %, and the runtime, asked at the same moments, answered 26, 42, 51 and 60 %; both met at
61 % once the turn settled. A request sent mid-turn was answered within 250 ms every time (six of six), so a
busy runtime drops nothing. The fix asks during the turn as well.

Two differences remain and are known. The fill's tooltip on the session line names both, because that is where
the two figures are compared:

- **Before the first turn** the runtime answers an estimate (about 15 % for a fresh Haiku session) and the
  sidebar shows nothing, because the transcript holds no usage yet.
- **After a compaction** the lag runs the other way: the line shows the compacted fill at once (33 % → 17 %
  in the measurement), and the sidebar keeps the old value until the next API call writes a new usage line.
  Measured for `/compact`. An automatic compaction writes the same `compact_boundary` line to the transcript
  and no usage line either, so the sidebar lags the same way. The boundary's `postTokens` counts only the
  kept conversation and is not the fill; the measurement is in spec 28, "Why the LAST turn" (#698).
  The sidebar keeps the old figure but marks it ("before compaction") and raises no handoff badge from it.

## The permission mode (#696)

The session line shows the mode first, in the TUI's words and glyphs (`⏵⏵ accept edits · ctx 34 % · Opus 5.5
(1M)`), coloured like the TUI's (accept edits violet, plan teal, auto amber, bypass and don't-ask red).
**Shift+Tab** in the input and a click on the mode switch to the next one. pi-native has no modes: its line
shows none and Shift+Tab moves the focus as in any text field.

Measured on 2.1.283 over the pipe, before any of it was built:

- **The request** is `{ subtype: 'set_permission_mode', mode }`. It answers success with `{ mode }` in about
  10 ms, needs no `initialize` first and is taken before the first turn as well.
- **Which modes it takes.** `default`, `acceptEdits`, `plan` and `dontAsk` always. `auto` depends on the model:
  refused on Haiku (`auto_mode_model`), taken on Sonnet and Opus. `bypassPermissions` is refused unless the
  session was launched so that it may (`bypass_not_launched`); `--allow-dangerously-skip-permissions` is enough
  for that. An unknown mode is refused with the list of valid ones (`invalid_mode`). A refusal changes nothing
  and sends no status line.
- **Where the CLI says which mode it is in.** A `system/status` line with `permissionMode` follows every change
  at once, even between turns; setting the mode it already has answers success with no status line. Every
  turn's `system/init` names the mode too.
- **When it applies: at once, to the running turn.** Started in `default`, a turn of two sequential `Write`
  calls asked for the first; `acceptEdits` was set while that card was open, and the second `Write` of the
  same turn asked nothing.
- **The TUI's order** (read from the binary, not seen on screen): default → accept edits → plan → bypass
  permissions, where allowed → auto, where available → default. `dontAsk` is never entered by the cycle.

The view walks that order and skips a mode the CLI refuses, so "what this session can enter" is the CLI's own
answer rather than a guess about models and launch flags. A press while the previous one is still out is
dropped.

**Known gap: before the first turn the mode is not known.** Nothing in the protocol answers "which mode are you
in"; the first `system/init` arrives with the first turn. Until then the line shows no mode, and a Shift+Tab
counts the session as being in `default`, so a session launched in another mode takes one press more than
expected — and one launched in `plan` goes to accept edits on that first press, where the TUI would have
gone on to the next mode after plan. A mode outside the cycle (`dontAsk`, which only a launch sets) goes to
`default` on the next press.

Measured again on 2.1.286 for #730, with control requests only and no turn before the check:

- **`initialize`** answers the commands, models and account, and no mode.
- **`get_permission_mode`** does not exist (`Unsupported control request subtype`).
- **`get_settings`** answers `effective.permissions.defaultMode`: the mode the SETTINGS name, merged across
  user, project and local files. It does not see `--permission-mode` (launched with `acceptEdits`, it still
  said the settings' `auto`), and it does not see what the model allows: with `auto` in the user settings
  and no flag, the first `system/init` said `default` on Haiku and `auto` on the default model. A local
  settings file naming `plan` came back as `plan`, and the turn ran in `plan`.

So no request names the mode the session is in. The launch flag, when one is sent, is the answer; without
one, `get_settings` names the configured default, which holds unless the model refuses it.

**What the line shows at the start since #730.** The launch's mode when `--permission-mode` was sent
(`launchMode`, the same condition `buildLaunch` applies), and `default` for a `--restricted` launch without
one, since restricted mode ignores the settings files. Otherwise the settings' `defaultMode` from
`get_settings`, `default` when they name none. The first `system/init` or `system/status` still has the last
word. A `--restricted` launch is drawn without having been measured, taken as `default` because the option's
description says restricted mode ignores the settings files; the first `system/init` corrects it if it is wrong.

**`auto` is decided by the model (#753).** It is the one mode a model can refuse, and a refused `auto` runs in
`default`. Measured on 2.1.292: with `auto` from the settings and with `--permission-mode auto` alike, a Haiku
session's first `system/init` said `default`; Sonnet and Opus ran in `auto` (#730's measurement on 2.1.286). So
the start mode `auto` — from the launch or from the settings — waits for the first `get_context_usage` answer,
whose `model` names the session's model, and `startModeFor` turns it into `auto` for Opus and Sonnet and
`default` for Haiku. A model of another family, or no answer, leaves the line empty until the first
`system/init`, which is the known gap above in its last remaining case. Until #753 every `auto` waited for the
first turn, so a user whose settings name `auto` saw no mode on any new or resumed session.

## Prompt suggestions (#693)

The view shows a suggestion as the empty input's placeholder, greyed and in italics with "Tab to use it";
**Tab** takes it into the input, typing anything or Escape throws it away, and a turn starting drops it. The
launch carries `--prompt-suggestions` the way it carries `--verbose`, so suggestions are on; the backend option
`promptSuggestionsOff` (default `false`) is the way out and leaves the flag off. An opt-out, because a
`configFields` default describes and is never sent — a default of "on" that put the flag on the command line
would be exactly what that rule forbids. The decoder turns the message into a neutral `suggestion` op; the core keeps the last one until
a turn starts, so a view mounted meanwhile offers it too.

Measured on Claude Code 2.1.283 over the pipe, with the app's own launch flags and Haiku:

- **`--prompt-suggestions` alone turns them on.** The CLI decides in this order: the environment variable
  `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` if set; otherwise a server-side feature flag, and even then never in
  non-interactive (`-p`) mode. The flag is the pipe's own switch past that last rule — the CLI's error text
  says it "requires --print and --output-format=stream-json (prompt_suggestion messages are only surfaced in
  stream-json output)". Measured with the flag and without the variable: suggestions arrive.
- **The message** is `{ type: 'prompt_suggestion', suggestion, uuid, session_id }`, one per turn, sent after
  the turn's `result` — measured 4-12 s later — and before the next turn is written.
- **Not every turn gets one.** Two trivial prompts ("Say hi in two words.") got none; a coding conversation got
  one after every turn ("write it", "Take filename from command line arguments?"). The CLI's reasons for
  skipping include `early_conversation`, `last_response_error` and `evaluative` (listed in the binary; which
  applied was not measured).
- **Cost:** the suggestion is a model call of its own, made from the conversation's cached prompt. It does not
  appear in the turn's `result`; what it costs was not measured separately.
- A control request `set_prompt_suggestions_paused` exists; not measured.

## A sent message, before its turn starts (#694)

Point 3 of the protocol notes means a sent line comes back only when its turn starts. Measured on 2.1.283: about
2.2 s for the first turn after the start (the CLI is still starting), about 0.6 s for every later one, and a
line sent while a turn runs not until that turn has ended. So the view draws the message at once, dimmed, at the
end of the log with "sending…" or "queued", and the played-back entry takes its place where its turn runs —
the rule that a queued line is drawn where it ran stays. Matched by text: the played-back line equals the sent
one, or begins with it — a `/` command Claude answers by itself comes back as the command followed by its
output (#680's `typedCommand`). A refused send removes it, a branch switch (a reset of the conversation) drops
any still pending, and a `!` shell line gets none (it is not a turn). Shared with pi-native, which plays a line
back the same way.

## Shared with pi-native, and what is not

**An `@` path in the prompt is read by Claude and not by Pi** (measured on Claude Code 2.1.283 and Pi 0.85.1,
#699). Over the stream-json pipe Claude attaches the file an `@<path>` names before the model sees the turn:
with every file-reading tool disallowed, the model still quoted the content for all four forms tried, which
were quoted absolute with backslashes (`@"…"`), bare absolute with backslashes, bare absolute with forward
slashes, and relative to the session's directory. Pi passes the same text through unexpanded (spec 30, "The
input completes as you type"). One composer therefore produces two outcomes: here the content is in the
turn, and in pi-native the model has to read the file itself.

**Shared**, one implementation each (E7):

- the pipe, the line framing, the request/response wait, the stop and the tree kill: `src/app/agent-rpc.js`;
- the neutral ops the decoder produces (`append`, `partial`, `tool`, `busy`, `notice`, `ask`, `answered`,
  `reset`, and `identity`, which the core handles itself) and the one channel that carries them to the view —
  plus `tasks` (#691) and `subagent` (#769), which only claude-native's decoder sends today;
- the attach sequence contract, the re-key, the open-question registry and its answers, and the count of
  owed turns;
- the conversation view, its composer, its cards and the pickers anchored in it;
- the trust gate (`trustBeforeStart`, #655);
- the row ownership: `transcriptsOf`, `openerFor`, `rowOwnerOf`, `storesRead` (#658);
- busy/ready from the pipe only (#659).

The core learned these as declarations of the `rpc` half in #657, where it used to assume Pi's shape.
`.claude/rules/backends.md` lists them.

**Not shared, on purpose:**

| What | Pi (native) | Claude (native) | Why they differ |
|---|---|---|---|
| The marker | a `custom` entry the runtime extension appends | the `entrypoint` Claude Code writes from the environment | each is the owner's format, and Claude needs nothing written into its store |
| A per-spawn extension | yes: marker, approval gate, session commands | none | Claude asks its own approvals and runs its own slash commands over the pipe |
| Approvals | the app's gate, a convenience | Claude's own permission prompt | Pi has no approval step; Claude has one |
| Identity | asked with `get_state` | read off every line | Claude cannot be asked |
| History on attach | `get_messages` | the transcript file | Claude cannot be asked |
| Turn acknowledgement | every command is answered | a turn line is never answered | the protocols differ |
| Stop | `abort`, plus `abort_bash` for a shell line | an `interrupt` control request | the protocols differ |
| `/login`, `/model`, `/session`, `/tree` | built by the app in the extension | Claude's own, or not available | Pi's are TUI commands that mean nothing over RPC; Claude's local commands answer over the pipe |

### Written twice, and the guard against it (#664)

A side-by-side read of the two backend folders after this backend landed found no line reader, no ask
registry and no busy tracker in either: those were already the core's. What was written twice was small,
and it moved:

- `textOf` and `argsFromText` were word for word the same in both translators, and so were the `/` list's
  one-line description with its 200-character cap and the notice sentences both say in the same situation. They live in
  `src/backends/rpc-shared.js` now. A backend folder may not import `src/app/`, which is why that module
  sits beside the backends.
- The key a tool call carries while its arguments are still streaming is the app's own word, written by
  both decoders and read by Pi's normaliser and by the viewer. It is `src/shared/partial-args.js`, which
  both processes load. The viewer used to hand a Claude call with half its arguments to the finished call's
  renderer, so a streaming `Write` drew with no path and no content until it finished. Both backends'
  streaming calls now draw the text that has arrived so far; a Pi call used to show it wrapped in a JSON
  object under that key.
- The test that checks every protocol export is handed to the core was copied into both backends' test
  files. It is one loop now.

Deliberately NOT merged, because the protocol differs even where the shape looks alike: the assembly of
the streamed message, `answerCommand`, `responseOf`, `sendCommand`, the stop, and how an approval is built
from each CLI's request.

**The guard is `test/runtime-backends.test.js`**, over every backend that declares `transport`, derived from
the registry:

- what a protocol module exports, the descriptor hands to the core, by identity;
- what the `rpc` half declares and what `createDecoder()` returns, `src/app/agent-rpc.js` reads — derived from
  that file's own source, so a backend that grows an `asks()`, an `isBusy()` or an `onData` of its own fails
  by name;
- every op a backend's folder emits is one the core or the conversation view handles;
- no backend folder defines a helper of `rpc-shared.js` again, and every approval it asks carries the fields
  the approval card reads (`APPROVAL_ASK_KEYS`).

What it does not see is private state inside a closure: a busy flag a decoder keeps and never exports. That
limit was accepted when the shape was chosen, over a text scan for such state, which would have needed an
allow-list and read generated TypeScript as code.

## The settings

`permissionMode` (Claude's choices without Dangerous Skip: a session in which no card could ever appear is
already on the list as `bypassPermissions`, in the CLI's own vocabulary, so a second switch for it is left out) and `model`.

Since #685 also the terminal backend's argv options: `worktree` + `worktreeName`, `chrome`, `addDirs`,
`restricted` and `autocompact`, taken from Claude's own declarations. Each was measured on the pipe (Claude
Code 2.1.283, `-p` with stream-json both ways) before it was offered: `--worktree` moves the session into the
worktree, and `system/init` reports that directory as its `cwd`; `--chrome` adds the `claude-in-chrome` MCP
server; `--restricted` removes Bash and WebFetch, and together with `bypassPermissions` fails to start just as
in a terminal; `--add-dir` and `--autocompact` start without complaint. Values ride in the flag
(`--worktree=<name>`), like the session ids. `restricted` carries its own description here: Claude's warns
that it turns off the attention hook, and a piped session takes its busy state from the stream, not the hook.

Two options stay with the terminal. `mcpEmulation` starts the IDE bridge and adds `--ide` at the terminal
spawn site; a piped session answers its approvals on a card, so a diff review through the bridge would be a
second place to answer the same edit. `afkTimeoutSec` times the TUI's question dialog, and a piped session has
no such dialog: the question waits on a card. That one is reasoned, not measured, because there is no dialog
to time out.

A worktree name is typed by the user and becomes part of a path Claude creates, and Claude refuses a worktree
whose path git spells differently from the one it was given (measured on Windows: a project opened with a
folder name in lower case, while git reports it capitalised, failed with "Refusing to use … as an isolation
worktree"; the same project opened with git's spelling worked). That is the CLI's own check, not the pipe's; whether the terminal backend meets it with
the same spelling was not measured.

Every key, its default and what it means: `docs/settings-reference.md`.

## Known gaps

- **The marker leaks into tool children.** A Bash call of a driven session inherits
  `CLAUDE_CODE_ENTRYPOINT`, and a `--settings` env override does not stop it (measured). A nested `claude -p`
  run through that tool would therefore mark its own session as driven, and it would open in claude-native.
  The strip is app-side only: the app removes the variable from every spawn of its own.
- **Settings that fail validation are dropped without a word.** The terminal shows a dialog for them; print
  mode ignores them silently (`claude --help`), and nothing in the stream says so. The view has nothing to
  show.
- **With the terminal Claude backend off and claude-native on**, nothing shows project meta, usage or live
  owners. Each is answered once, by the terminal backend, which reads the same files (see the capability
  notes in `src/backends/claude-native/index.js`).
- **The redraw rate on a streamed turn** is not measured. The stream is about 40 small events a second
  (measured, and cheap for the pipe); what the view's redraw costs at that rate is still open.
- **The version floor is the measured version.** Features are not detected from the `system/init`
  capabilities list, which would be the finer check.

## A compaction's summary (#712)

Measured on 2.1.284 with `/compact`, the stream sends:
1. `system/compact_boundary` (drawn as the "compacted" notice);
2. the summary the model goes on from, as a user line with `isSynthetic: true`;
3. the command's played-back output ("Compacted", `isReplay: true`);
4. an ordinary `result`.

The transcript keeps the summary under the same uuid with `isCompactSummary` and `isVisibleInTranscriptOnly`,
and without `isMeta`. Both paths draw it as a `transcript-meta` note, "Compaction summary", with the text
folded into its details. This is the shape pi-native gives Pi's own summary, and the view reads no Claude
markup for it. The decoder takes a synthetic line as the summary only right after a boundary, and the
turn's end or a model line drops that expectation. Only a manual `/compact` was measured. If an automatic
compaction ordered its lines differently, the live view would show the summary as a user message, while a
reopen would still show the note. Protocol point 11 in
`src/backends/claude-native/rpc-protocol.js` holds the same account.

## Which line is the user's (#709)

The view pins the prompt of the turn being read, and which entry is a prompt is the backend's answer,
carried as `prompt: true`:
- On the stream it is a line played back (`isReplay`, point 3). That copy carries no `promptSource`, and a
  local command's output is played back too, so the reader's rule without that field decides the rest.
- In the transcript, `isUsersPrompt` in Claude's reader decides:
  - `promptSource` set and not `system` (`typed`, `queued`, `suggestion_accepted` and `sdk` were measured).
  - Without that field, the user's text, as long as it is not a local command's output. A slash command the
    user typed counts, including a local one that starts no turn.
  - A compaction summary, the line a Stop leaves behind (`interruptedMessageId`), an `isMeta` line and one
    with an `origin` of its own never count.

pi-native marks a Pi `user` message. A tool result is drawn in the user's role too, but its Pi role is
`toolResult`, so it is not marked. A command taken over from another CLI, and a prompt template such as
`/handoff`, reaches Pi as a user message holding the expanded text, so the bar shows that text rather than
the `/name` typed. The view draws the same text as the user's message, so the two agree. The session metrics (`userMessageCount`,
`largestUserPromptWords`) ask the same function since #706; spec 28 has what that changed.
