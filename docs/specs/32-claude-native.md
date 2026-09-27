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
| E10 | Image input is in scope, through the same view code as pi-native's (#656). | Built in #662; see "Images". Paste and drop only, no file picker; the view refuses a format or size the backend does not declare, and a model that cannot read images gets the CLI's own error (owner, #662). |
| E11 | No AFK timeout for a piped child, for now. | `CLAUDE_AFK_TIMEOUT_MS` is about a terminal left alone. |
| E12 | A driver's store is read while the driver is on, even with its owner switched off. | Without it a new session never reached the sidebar with the owner off (#658). |
| E14 | A stop waits only where the CLI needs time to finish its transcript. | Measured: a child killed the moment its `result` arrived had already written the turn's last line, so claude-native declares no `gracefulStopMs`. |
| E16 | Approving a plan is a plain allow. No "approve and accept edits". | `ExitPlanMode` carries no permission suggestion, so there is no mode to take over. An app-built one was measured working and left out by the owner (#661). |
| E17 | "For this session" hands back only suggestions whose destination is the session. | A suggestion naming a settings file would outlive the session and write a file of the user's (#661). **Narrowed by E19 (#674):** the project's local settings are offered behind a button of their own. |
| E18 | No special order for `default_to_no`. | No request in any measurement carried the field (#661). |
| E19 | **A lasting allow for the project is offered after all** (#674, route A; narrows E17): the card hands back Claude's own `localSettings` allow rule, and Claude writes it into `.claude/settings.local.json`. Suggestions for the shared project settings and the user's settings stay unoffered. | The same one-click choice Claude's terminal offers, without the app writing a file of the CLI's (CLAUDE.md rule 11). The price: a click on a card changes a file in the project that outlives the session, and the app does not show the rule afterwards. |

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
| Queue (Enter while a turn runs) | no `priority` | queues the line and runs it as its own turn after the running one ends |
| Steer (Ctrl+Enter while a turn runs) | `priority: 'next'` | injects the line into the running turn at its next tool boundary; the turn ends in one `result` |

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

## Approvals and questions

Claude asks before a tool runs over the control channel (`control_request` / `can_use_tool`), but only with
`--permission-prompt-tool stdio`. With `--permission-prompts host` alone, a `Write` was refused on the spot
and the host was never asked (measured).

This is the difference from pi-native that matters most. **The question here is Claude's own**, asked under
the user's own permission rules, the question the terminal would put. A tool the user's rules allow never
reaches the card. A user whose `defaultMode` is `auto` sees few or no questions, because the CLI asks none
(measured). The card carries one line saying that Claude asks this under its own permission rules, as it
would in a terminal. Pi has no approval step, so pi-native builds its own gate in a
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
- **`AskUserQuestion`** is a question, not a permission. The card draws its questions with their options,
  checkboxes where several may be picked, and a free answer. The answer is an allow whose `updatedInput`
  carries `answers`. Several choices are joined with ", ", and a free answer is taken as written (both
  measured).
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
  nothing takes no images, and the view says so when one is pasted. pi-native (#656) sends the images in
  Pi's `images` field and adds nothing else; spec 30 has its half.
- **On the wire** the turn becomes a content array, the images first and then the text, which is the order
  Anthropic's documentation recommends. A turn without images stays a plain string.
- **What Claude Code does with it** (measured): it keeps the image block in the transcript, stores a copy of
  the image under its own temporary directory, and adds a line naming that copy's path. A model may then
  `Read` the copy as well, which asks for an approval under the default permission mode. The history viewer
  draws the image block in the user's message, live and after a remount.
- **A copy that carries text pastes only the text.** Excel and Word put a rendered picture of the selection
  on the clipboard beside the text, so attaching the image as well would add an unwanted thumbnail to every
  paste of a few cells. An image is attached from a paste only when the clipboard holds no text.
- **The size is counted on the encoded image**, the base64 text that goes over the pipe, by the view and by
  main alike. Whether the API's 5 MB counts the file or its encoding is not measured, and the stricter
  reading cannot let through an image the API then refuses; a file of about 3.75 MB is therefore the
  largest that attaches. There is no limit on how many images one turn carries: several large ones can
  still be refused by the API's limit on a whole request, and that answer comes back as the CLI's error.
- **A drop that holds no image** says so rather than doing nothing.

## Shared with pi-native, and what is not

**Shared**, one implementation each (E7):

- the pipe, the line framing, the request/response wait, the stop and the tree kill: `src/app/agent-rpc.js`;
- the neutral ops the decoder produces (`append`, `partial`, `tool`, `busy`, `notice`, `ask`, `answered`,
  `reset`, and `identity`, which the core handles itself) and the one channel that carries them to the view;
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
already on the list as `bypassPermissions`, in the CLI's own vocabulary, so a second switch for it is left out) and `model`. The terminal backend's other
options are not offered yet. Every key, its default and what it means: `docs/settings-reference.md`.

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
