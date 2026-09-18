# 30 — Pi driven through its runtime, not through a terminal

Issue #568. The backend is `src/backends/pi-native/`, the core half is `src/app/agent-rpc.js`, and the
surface is `src/renderer/session/conversation-view.js`.

## What changes for the user

Every other backend is a CLI in a PTY. The app types into it and reads its transcript off disk afterwards.
Pi also has an RPC mode, `pi --mode rpc`: one JSON command per line in, responses and events out. The
backend described here starts Pi that way. It has no terminal. The app draws the conversation from Pi's
events and sends turns down the same pipe.

The terminal backend (`src/backends/pi/`) stays. Anyone who wants Pi's own TUI keeps it, and no backend
carries two surfaces that have to be kept in step. An unfinished conversation view takes nothing away.

## Decisions

| | Decision | Why |
|---|---|---|
| E1 | The **installed** `pi` runs over RPC. It is not bundled. | The issue asked for a bundled copy so Pi could be patched. Measured: 129 MB unpacked, ESM, and it would have to run as its own process from outside the asar. Nothing needs patching yet, so bundling waits for a reason and becomes an issue of its own. |
| E2 | A session this backend ran is **marked in its own transcript**. The row stays Pi's. | Both backends read one store, and a row can have one owner. See "Who owns a row". |
| E3 | Single view and panes only. **No detach, no grid card.** | A detached window mounts a session by replaying its PTY, and there is no PTY here. A detach is refused with a sentence, and the grid says once, when it opens, that such sessions are not in it. |
| E4 | One commit per step, not pushed without a look. | — |

## Who owns a row

The scan reconciles per backend. Its delete-diff is `cachedRowsOfBackend(id)`, so a row stamped with the
sibling's id would drop out of the owner's diff, and a transcript deleted from disk would leave its row
behind for good. The row therefore keeps `backendId: 'pi'`, and how the session was **driven** is a
field of its own:

1. The per-spawn extension (`src/backends/pi-native/runtime-extension.js`) appends a Pi `custom` entry,
   `switchboard-transport` with `{ transport: 'rpc' }`, unless the session already carries one. Pi
   holds it and writes it with the first message, so a session nobody wrote to leaves no transcript
   and no orphaned marker (measured on 0.84.4).
2. Pi's parser reads it into `row.transport`, stored in the `session_cache.transport` column (an appended
   migration, parser version 7). `src/backends/pi/transport-marker.js` is the one spelling of the marker
   both sides use.
3. `backends.openerFor(row)` answers which backend OPENS a row. A backend that declares
   `transcriptsOf: <owner>` and the same `transport` claims a marked row, but only while it could
   launch. Switched off, the row goes back to its owner, which runs the same binary over the same file.
4. `src/index/projects-view.js` puts that answer in the payload's `backendId`, and the spawn path's
   cache fallback asks the same function. The renderer resolves badge, surface and resume from the one
   field it always read.

The marker says the session was driven over RPC **at least once**. Only this backend writes it and
nothing removes it, so a session that went native once opens native afterwards, even if someone later
resumed it in Pi's TUI by hand. That is the price of a marker only one side writes. Switching the backend
off is the way back: `openerFor` then answers the owner, and so does the spawn path, even for a session
whose launch record still names the native backend.

`test/backend-parity.test.js` holds the shape: a backend with `transcriptsOf` declares no discovery, no
parser and none of the live-record hooks. With them it could reconcile rows or adopt records, and its
file-tail state would compete with the edges from its own pipe. Its row-level hooks are the owner's
own functions, not copies.

## How the child is driven

`src/app/terminal/spawn.js` runs unchanged up to the spawn: backend resolution, the launch guards,
`buildLaunch`, the environment and the prompt templates (#569 works over RPC, because Pi expands a
template before it sends a `prompt`). Then, for a descriptor with `transport`, it starts a child on a
pipe through `agent-rpc.start()` instead of `pty.spawn()`. The launch has to name a real executable: there
is no shell to resolve Pi's npm `.cmd` shim, so the descriptor resolves it to `node <cli.js>`
(`src/backends/pi/exec-command.js`).

**The child is wrapped to look like a PTY.** `stop-session` calls `session.pty.kill()`, the quit path reads
`session.pty.pid`, the exit handler hangs off `onExit`, and the trigger watcher writes into `session.pty`.
Giving the child those members lets all of that run without learning about a second kind of session.
`kill()` takes the process **tree** on Windows, because Pi runs its tools as its own children.

**`write()` does something.** Text followed by a carriage return is a turn, and ESC or Ctrl+C on their own
abort. The seed prompt, the trigger watcher and a launcher all send exactly that into a PTY, so each
reaches this backend without knowing what it is.

### What crosses to the renderer

The backend's `rpc` half (`src/backends/pi-native/rpc-protocol.js`) turns Pi's lines into the app's own
ops: `reset`, `append`, `partial`, `tool`, `busy`, `queue`, `notice`, `ask`, `answered`. The core moves them
on one channel, `agent-event`, routed to the window that renders the session. Nothing outside the backend
folder knows a Pi event name.

Entries have the shape the Message History viewer already draws, produced by Pi's own normaliser
(`src/backends/pi/transcript-view.js`), so a live session and its history look the same. The one addition
is a partial: `message_update` carries a delta and no snapshot, so the turn being streamed is assembled
by `contentIndex`. It is sent at most every 60 ms, and anything else that happens flushes it first, so
nothing is reordered.

### State and identity

- **Busy and idle** come from `agent_start` and `agent_settled`, not `agent_end`, which Pi says "may still
  be followed by retry, compaction, or queued continuations" (the reading #573 took for the terminal
  backend). They go through `hooks.deliverBindSignal`, the function a terminal's binding extension
  reaches, so the turn-hold, the inbox and the timeline cannot tell the two apart.
- **A question** an extension opens (`ctx.ui.select` and friends) reaches the client as
  `extension_ui_request`. It is reported as `waiting`, drawn in the conversation, and answered with
  `extension_ui_response`. Answering it inside a run reports `busy` again, because nothing else would
  until the run settles.
- **Identity** comes from `get_state`, at start and after every settled run, through the re-key every
  live binding uses (`adoptSessionId`). Pi names the session within seconds of starting, long before its
  first message.
- **History** is the transcript. A view that mounts or remounts asks `get_messages`. No second event
  log is kept that could fall out of step with it. A snapshot is taken at one moment while ops keep
  flowing, so every op carries a sequence number, the answer carries the number it was taken at, and the
  view holds what arrives while it waits and replays only what is newer. Without that, a turn that
  finished while a view was mounting was drawn and then wiped by the reset.
- **Questions Pi stopped waiting on** (a run that settled, a process that ended) are closed on the main
  side too, or every later mount would draw a dialog nobody can answer.
- **Fork and resume guards** ask the store's owner. `pi-native` has no `liveRefFor` of its own, so
  `backends.recordOwnerOf` hands the question to Pi. Without it a native session could be forked before
  Pi had written it, into a child that dies at once.

## Measured, and what each measurement changed

- A failed model call is not an error response. It arrives as an assistant turn with
  `stopReason: 'error'` and an `errorMessage`, which covers both a lapsed login and an exhausted account.
  The decoder turns it into a notice, or the user would see an empty turn and nothing else.
- `tool_execution_start` arrives before an extension's `tool_call` handler runs, so a tool that waits on
  an approval is already running by the protocol's account.
- The re-key lands about three seconds after the spawn. `seedSessionWhenReady` used to look its
  session up by the launch id, found nothing after the re-key, and dropped the seed without a word. It
  now follows the entry object, which the re-key moves unchanged. Any backend re-keyed during the wait
  benefits. A session on a pipe is also seeded at once: it has no screen that settles, and the pipe
  queues the command until Pi reads it.
- A carriage return inside a bracketed paste is text, as it is to a terminal, so a pasted CRLF block is
  one turn and not several.
- A renderer reload leaves the child running. Opening the session again reattaches and loads the
  conversation from `get_messages`.

## Input (step B)

The view has a text field, not a terminal. Enter sends a turn. While the agent is working, the turn is
**queued** as a follow-up, because Pi refuses a `prompt` that arrives mid-run unless it is told what to do
with it. That choice is made in the main process against the session's own busy state, not in the window,
which hears about a settled run one op later and could otherwise queue a message behind a run that has
already ended. Ctrl+Enter (Cmd+Enter on macOS) **steers** the running turn: Pi delivers the message after the
current tool calls and before the next model call. Escape and the Stop button abort. The buttons follow
the state: Send when idle, and Queue, Steer and Stop while a turn runs.

Measured in the demo: a steer sent while the agent was counting with one `bash` call per number arrived
between two calls, and the agent stopped where the message told it to.

The skill, plan, handoff and variable pickers open in the field on the same shortcuts as in a terminal.
They are handed an anchor instead of a terminal, the view's own element with a `focus()` back into the
field, so the palette sits in the lower half of the conversation as it would in a terminal.
`insertResolvedText` asks the entry for a conversation **before** it looks at the terminal it was given.
The text lands in the field with its line breaks, and a skill's `submit` sends it. Before this, the text
would have gone down the pipe as keystrokes with no Enter after them, and waited there unseen.

What goes into the pipe directly — the seed, a staged prompt, the trigger watcher — still takes the PTY
path (`write()`), and that path treats text plus a carriage return as a turn.

## Approvals and tool rendering (step C)

Pi has no approval step. Its project trust decides what gets **loaded**, and an enabled tool then runs
without asking. A conversation the app draws looks supervised, and a session that only looks supervised
is the worse failure, so this backend asks before `bash`, `powershell` (Pi's built-in Windows shell, off
unless the `tools` option enables it), `edit` and `write`. It never asks before the read-only tools. The `approvalGate` option switches it off, and it is **on** by default.

It also asks before the app's own `subagent` tool (#634), for a reason the others do not share. That tool
starts a second Pi, spawned by the subagent extension, and the child loads neither per-spawn extension, so
nothing it runs ever reaches a question. The delegation is therefore the only call there is to ask about.
The view shows the agent and the task from the call, and one more line the call does not carry: the agent's
tools and model. An agent file without a `tools` line runs with Pi's default tools, `bash`, `edit` and
`write` among them, and that is what a person deciding has to see. The line comes from the subagent
extension, which publishes a describer under a registry symbol (`DESCRIBE_KEY` in
`src/backends/pi/subagent-tool.js`); the gate asks it at the moment of the call and adds the answer to the
question's title as `detail`. Without it the question still stands, only without the line. An allow covers
whatever the agent's tools then do. **Allow for this session is per tool name**, as for every gated tool,
so for `subagent` it allows every later delegation in the session, to any agent and with any task, and
none of them asks again. The child's cost line is part of the tool's result text, so the view shows it as
ordinary tool output.

The question comes from the per-spawn extension, not from the app. A `tool_call` handler calls Pi's own
`ctx.ui.select`, which RPC mode turns into an `extension_ui_request`. The select's title is a line for
the app, not for a person: a prefix plus `{ tool, id, detail }`, which the decoder recognises and turns into an
`ask` of kind `approval`. The view draws the call that question is about, found by its id in the
conversation it already holds, through the viewer's own tool renderer: the command, the diff, the
content. It offers three answers:

- **Allow once**
- **Allow for this session**: remembered per tool, in the extension, for the life of the process.
  Anything lasting is the setting, where it stays visible and can be taken back.
- **Refuse**: the call is blocked with a reason the agent reads ("The user did not allow this bash
  call.") and answers.

Anything that is not an explicit allow blocks: a dismissed question, one that threw, an answer the
extension does not recognise. The question is handed the run's abort signal. Pi's `abort` waits for the
run to go idle, and a handler still waiting on an answer would hold it forever. With the signal, Stop
resolves the open question to "no" and the call is blocked.

While the question is open the status line says it is waiting for an answer, and the tool's activity
line says it waits for approval, not that it runs. Both the dialog and the setting say what the gate is
not. **It is a convenience, not a security boundary.** It runs inside the agent's own process, a Pi
started outside the app does not have it, and a tool an extension registers under another name is not
covered.

Measured in the demo: Refuse blocked the call and the agent reported that it had not run. Allow for this
session asked once, and a second `bash` call in the next turn ran without a question. With the option off
there was no question, and the command ran.

**Tool calls are drawn as what they are**, for this backend and in the Message History of the terminal
backend. Pi's normaliser maps its built-in tools onto the vocabulary the viewer has renderers for:
`bash` and `powershell` to a command block, `edit` to a diff (several replacements in one call are one diff
with a marker line between them, and the other argument shapes Pi itself accepts are normalised the way
Pi does it), `write` to its content, `read`, `grep` and `find` to their one-line summaries. The
mapping is Pi's own answer, from its own argument shapes, so the renderer learns no Pi tool. A tool it
does not know is still drawn as JSON.

## The renderer

`createTerminalEntry` is the one place every launch path goes through, and it hands a session whose
backend declares `transport` to `createConversationEntry`. That entry carries `terminal: null`, and every
site that assumed an xterm checks for one: fit, repaint, WebGL, font, theme, focus, the grid's
scrollback, the exit banner, the launch-error writes (`writeEntryError`). The view draws entries with
`renderJsonlEntry` and `buildToolResultMap`, and redraws a tool call when its result arrives.

`backends-list` carries `transport` to the renderer. `pageKeyTarget` and `newlineKeySequence` are
deliberately absent on this backend, because they are answers for an xterm it never mounts, and the
terminal-key tests check that.

## Known gaps

- **Detach and the grid** (E3).
- **The command palette's insert entries** (run a skill, insert a plan, a handoff, a variable) ask for a
  terminal and are absent for such a session; the keyboard chords in the text field work.
- **The pre-launch command** is not offered: there is no shell to put it in front of. The universal field
  is left off descriptors that declare `transport`.
- **A Pi run this app did not start** is not marked, so it opens in the terminal backend. That is correct:
  it was not driven over RPC.
