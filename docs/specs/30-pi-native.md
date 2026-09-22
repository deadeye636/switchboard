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
ops: `reset`, `append`, `partial`, `tool`, `busy`, `queue`, `notice`, `ask`. The core adds `answered` itself,
when a question is answered or closed after a settle or an exit, and moves them all on one channel, `agent-event`, routed to the window that renders the session. Nothing outside the backend
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
  side too, or every later mount would draw a dialog nobody can answer. A question one of the session
  commands asked is the exception: Pi keeps waiting on it across a run (see "Pi's own commands").
- **Fork and resume guards** ask the store's owner. `pi-native` has no `liveRefFor` of its own, so
  `backends.recordOwnerOf` hands the question to Pi. Without it a native session could be forked before
  Pi had written it, into a child that dies at once.

## Measured, and what each measurement changed

Everything here was measured against Pi 0.84.4. Later Pi versions were not re-measured.

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

It also asks before every MCP tool taken over from another CLI (#633, spec 31), matched by the `mcp__`
prefix. Whether such a tool only reads is its server's claim, so none is waved through, and "Allow for this
session" covers one tool. A tool of the user's own whose name starts with `mcp__` is asked about as well.

It also asks before the app's own `subagent` tool (#634), for a reason the others do not share. That tool
starts a second Pi, spawned by the subagent section of the per-spawn resources extension (spec 31), and the
child loads neither per-spawn extension, so
nothing it runs ever reaches a question. The delegation is therefore the only call there is to ask about.
The view shows the agent and the task from the call, and one more line the call does not carry: the agent's
tools and model. An agent file without a `tools` line runs with Pi's default tools, `bash`, `edit` and
`write` among them, and that is what a person deciding has to see. The line comes from that subagent
section, which publishes a describer under a registry symbol (`DESCRIBE_KEY` in
`src/backends/pi/subagent-tool.js`); the gate asks it at the moment of the call and adds the answer to the
question's title as `detail`. Without it the question still stands, only without the line. An allow covers
whatever the agent's tools then do. **Allow for this session is per agent for `subagent`**, where every
other gated tool keeps it per tool name: the question named one agent's tools, and allowing a different
agent — possibly one with more tools — on the strength of it would allow more than was shown. Later
delegations to the same agent, with any task, then run without asking; another agent is asked about
again. Since #639 the key also carries where the agent came from (Pi's own directory, or a source's project
or global agents), and a delegation the tool would refuse anyway is blocked without a question. The key
names the agent, not its file, so the promise has a limit: an agent file edited mid-session to carry
more tools, or created for a name that was allowed while it did not exist yet, runs under the earlier
allow. The convenience-not-boundary line covers that; keying on the description as well would re-ask after
every edit to the agent. Decided by the owner over a setting for it, because the settings that exist already cover the
other wish: switching `approvalGate` off. The child's cost line is part of the tool's result text, so the view shows it as
ordinary tool output.

The question comes from the per-spawn extension, not from the app. A `tool_call` handler calls Pi's own
`ctx.ui.select`, which RPC mode turns into an `extension_ui_request`. The select's title is a line for
the app, not for a person: a prefix plus `{ tool, id, detail, by }`, which the decoder recognises and turns into an
`ask` of kind `approval`. The view draws the call that question is about, found by its id in the
conversation it already holds, through the viewer's own tool renderer: the command, the diff, the
content. It offers three answers:

- **Allow once**
- **Allow for this session**: remembered per tool (per agent for `subagent`, per command for a command's
  shell line), in the extension, for the life of the process.
  Anything lasting is the setting, where it stays visible and can be taken back.
- **Refuse**: the call is blocked with a reason the agent reads ("The user did not allow this bash
  call.") and answers.

**A command taken over from another CLI asks too** (#632, spec 31). Its inline shell lines run inside the
resources extension and never go through a tool, so no `tool_call` sees them. Where the gate is on, it
publishes its question under a registry symbol (`Symbol.for('switchboard.approval.ask')`), and the command
bridge asks it before running a line the command file permits. A line the file does not permit is refused
before it gets that far, so nobody is asked about it. The title carries `by`, and the view says "Your command
/x wants to run a shell line" instead of naming an agent tool. Allow for this session is keyed to that one
command (`command:<name>`) and never to `bash`, because a harmless `git status` in the user's own command must
not unlock the agent's shell. With the gate off, and in terminal Pi, the file's own permission decides alone.

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

## Pi's own commands (#642, #643)

`/login`, `/model`, `/compact` and the rest are commands of Pi's terminal interface. Over RPC a line that
starts with `/` is looked up only among extension commands, prompt templates and skills. Measured on Pi
0.84.4, `/login` and `/model` went to the model as plain text, and each cost a turn in which the model read
files and guessed at what was meant.

The runtime extension therefore registers them (`src/backends/pi-native/session-commands.js`), whether
the approval gate is on or not:

| Command | What it does here |
|---|---|
| `/login [provider]` | Asks for subscription or API key, then the provider, and runs Pi's own login. A subscription login shows the login page as a button, plus a field for the redirect URL. An API key is typed into a masked field. |
| `/logout [provider]` | Removes a login or an API key that `/login` saved. Environment variables and `models.json` stay as they are, as in Pi. |
| `/model [name]` | Switches the model for this session only. A name picks directly, several matches are offered, and a long list asks for the provider first. Nothing is written to Pi's settings, so the model the app launches with stays the app's setting. |
| `/thinking [level]` | Sets the thinking level and reads back what Pi applied, since a model that offers fewer levels is clamped. |
| `/compact [instructions]` | Runs Pi's compaction. While a turn is running it refuses and says so, and Pi's own compaction events say how it went. |
| `/session` | What the session has cost so far: messages, the four token counts and their total, the spend, and the context reading when Pi has one. Answered by the app, not by the command — see below. |
| `/export [file]` | Writes the session to an HTML file. Answered by the app, which decides where it goes — see below. |
| `/copy` | Puts the agent's last reply on the system clipboard. Answered by the app, because a clipboard belongs to the machine. |
| `/name [name]` | Names the session through `pi.setSessionName`. With no argument it asks on a card. Answered inside the extension. |
| `/reload` | Reloads Pi's extensions, skills, prompt templates and context files through `ctx.reload()`. Answered inside the extension. |
| `!cmd` | Not a command at all: a shell line, caught in Pi's own `input` event and run by Pi's own shell, so its output joins the session's context — see below. |

The rest of Pi's terminal commands (`/tree`, `/new`, `/settings` …) answer with a line saying
where that function lives in the app, or that it is not offered yet. The list is `TUI_ONLY` in that file.
Registering those names changes one thing: a prompt template or another extension's command with the same
name used to run over RPC and now gets the line instead, and a command taken over from another CLI under such
a name is skipped. That is the precedence Pi's terminal interface already has.

Five things decide how it is built:

- **The login uses a field Pi does not document.** `ctx.modelRegistry` is the documented read-only facade.
  The `ModelRuntime` behind it, with `login`, `logout` and `listCredentials`, is its `runtime` field,
  private in Pi's types and public at run time. The command checks for it, and where a Pi version lacks it
  the message sends the user to `/login` in the terminal backend, which writes the same `auth.json`.
- **The commands are registered at load, not at `session_start`.** A built-in of Pi's terminal interface
  wins over an extension command or a template with the same name. The command bridge registers another
  CLI's commands at `session_start` and skips a name Pi already has, so registering ours first gives the
  same precedence here. Two extensions registering one name would have Pi rename both (`name:1`, `name:2`),
  and then `/name` would reach neither.
- **A handler returns at once and its command runs on.** Pi sends its response to `prompt` only when the
  handler has returned (measured), and `agent-rpc.js` gives up on a response after 20 seconds. A login
  waits minutes on the user, and without this the view reported that the message never arrived.
- **A question Pi takes back has to be closed by us.** An OAuth login races the pasted redirect URL
  against Pi's own loopback callback. When the browser wins, Pi aborts the prompt, and RPC mode resolves
  the question locally without telling the client. So the command says so itself with a marker notice,
  the decoder turns that into `answered`, and `agent-rpc.js` closes the question and lets the session
  leave "waiting". Measured by calling the loopback port directly: the card closes, and the failed token
  exchange is reported in one line.
- **A command's question outlives a run.** `agent-rpc.js` drops every open question when a run settles,
  because a tool call's question ends with its run. A command's question does not: Pi keeps waiting on it
  with no timeout. Dropped, the card would be gone while Pi still held the provider's credential queue, and
  every later `/login` to that provider would hang with nothing on screen. Such a question arrives marked
  `lasting`, a settled run leaves it open and the session stays "waiting". Only an answer, a dismissal, Pi
  taking it back or the process ending closes it.

Markers carry what `ctx.ui` has no field for: a notice can carry a page to open, a question can be masked
and named, a notice can say Pi stopped waiting on a question, and a notice can say that a command whose
answer is the app's was typed. The prefixes are declared together at the top of `session-commands.js` —
read them there rather than from a list here. They are decoded in
`rpc-protocol.js`, and the renderer only gets plain fields: `links` and `files` on a notice, `secret` and
`lasting` on an ask.
The page opens through the existing `open-external` handler, which accepts only http(s). What Pi says about
a failure is passed on in one line, except where it could name a local path: an errno error is named by its
code, which Pi sometimes leaves only in the text (`describeFailure`).

### `/session` is registered by the extension and answered by the app (W3)

**Not because the extension could not answer it.** `ctx.getContextUsage()` and
`ctx.sessionManager.getEntries()` are both documented, and Pi computes its own `getSessionStats()` from the
second — so a handler could have produced every field itself. What that would mean is re-implementing Pi's
accounting in generated TypeScript: which kinds of entry count as a message, how a cached token is booked,
what a compaction summary does to the total. Two implementations of one arithmetic drift, against a Pi
version nobody pinned, and the copy in this repo would be the wrong one. So the command asks Pi for Pi's
own answer, over the documented `get_session_stats`.

Three routes were weighed: reaching for a private field the way the login above does; having the app
recognise `/session` in the text field before it is sent; or registering the command here and letting the
app answer it. The third is the one built. The handler says one marker and nothing else — no figure ever
passes through the extension. The decoder turns that marker into `{ op: 'figures' }`, which carries no
numbers either; `agent-rpc.js` answers it by sending the backend's `statsCommand` and drawing the sentence
the backend's `statsNotice` builds, so the shape of Pi's figures stays inside the backend folder and the
core learns no field of it.

**What registering the name costs.** An extension command is dispatched BEFORE prompt templates —
`AgentSession.prompt` tries `_tryExecuteExtensionCommand` first and returns if that handled the line
(measured, Pi 0.85.1) — so a `session` prompt template of the user's own is shadowed by this, exactly as
every name in `TUI_ONLY` already shadows one. That is the price of the command being resolvable at all,
and it is the same price the section above states for those.

**The card names Pi as the source, and that is a decision.** These are the runtime's counters for the
session it is running; Switchboard's statistics view counts the same session from its transcript. The two
are close and need not agree — a turn Pi has not written out yet is in one and not the other — and two
figures with different provenance and no label is how somebody spends an afternoon looking for a bug in
arithmetic that is doing what it should.

**Nothing in the card is worded as a breakdown**, because Pi's counts are not one: `totalMessages` counts
every message entry it holds, including tool results, bash executions and compaction summaries, while
`userMessages` and `assistantMessages` count two of those kinds and `toolCalls` counts invocations rather
than messages. In a plain session they reconcile and read like a partition; one `/compact` later they do
not. Token figures are printed unrounded for the same reason — a rounded part stops adding up to a rounded
total in front of the reader — and only the context WINDOW, which is a capacity and not a summand, is
abbreviated.

This is **not** the rest of #572. That issue's open half is the status bar's usage segment, which is about
an account's plan limits rather than a session's spend, and it needs a measurement of its own first:
whether Pi writes anything resembling a plan limit at all.

### Which side answers a command is decided by where the answer LIVES (#643)

`/session` set the pattern and the four commands after it fall on both sides of it. The question is not
"can the extension do this" — it is "whose answer is it":

- **`/name` and `/reload` are answered inside the extension**, because Pi's extension API holds the whole
  answer: `pi.setSessionName(name)` and `ctx.reload()`. Relaying either through the app would be a round
  trip ending in the same call.
- **`/export` and `/copy` are answered by the app**, for `/session`'s reason. Where a file the app produced
  belongs is the app's question; a clipboard belongs to the machine rather than to a session. Each command
  says only that it was typed — `/export` carries what was typed after it and no path of its own.

**`/name` writes one name, not two.** Pi writes the name into its session file and Pi's own parser reads it
back as the row's `customTitle` (`src/backends/pi/parser.js`), so the sidebar follows without the app
keeping a name of its own beside it. The card says so, because the row moves when Pi has written the file
rather than when the command returns.

**And a name written into the transcript OUTRANKS a later rename in the sidebar** — a session named this
way cannot be renamed from the app for good. `index-writes.js` promotes a `customTitle` to the row's name
on every parse, and the row reads `meta.name` first, so the next parse of Pi's file puts the typed name
back. That is not new and not this feature's: it is how a CLI's own title has always beaten a UI rename,
for Claude's `/title` as much as for Pi's `/name` in a terminal session. What IS new is that pi-native can
now reach it, so it is written down here rather than discovered by somebody whose rename kept reverting.

**`/export` never writes into the project unless asked to.** Measured on Pi 0.85.1: `export_html` with no
`outputPath` answers a RELATIVE name and the file lands in the runtime's working directory, which is the
user's project — an untracked file appearing in somebody's repository is not an answer to what they asked.
So the app always names the path: `<data dir>/exports/` when nobody named one, and a path the user DID name
resolved against the session's own directory, the way a shell would read it. The backend names the FILE
(`exportFileName` — the format is the runtime's, so the extension is too) and the app names the directory.
The notice carries the file as a `files` entry, drawn as a button that goes to the OS default application
through the existing `open-path` handler. That is a separate field from `links` on purpose: a page goes to
the browser, a file goes to the default application and past main's sensitive-path guard.

**Two things `/export <path>` does that a reader should not have to discover.** It overwrites without
asking, the way a shell `>` does — `/export package.json` destroys it — and a path the app cannot hand to
the OS opener afterwards still gets written: `open-path` returns silently for a sensitive path (`~/.ssh/…`
and the like), so the file is there, the notice names it, and the button does nothing. Neither is worth a
guard of its own: the first is what naming a file means, and the second is one shared handler's behaviour
that the terminal's own context menu relies on. They are written down because they are the two ways this
command surprises somebody.

**The export marker is the first one that carries a SIDE EFFECT rather than something to draw**, and that
was taken deliberately. Any extension in that Pi session can reach `ctx.ui.notify` and therefore ask the
app to write the file anywhere — but an extension runs unsandboxed in Pi's process with `node:fs`, so it
could already write anywhere this app can. A skill cannot reach it (it is instructions to the model) and
neither can the model (it can only call tools). `session-commands.js` carries the reasoning next to the
markers, for the next marker with a side effect rather than for this one.

**`/reload` is terminal for its own handler.** Pi tears the extension instance down and builds a new one,
so the notice goes out before the call and nothing is said after it. Two consequences are deliberate: every
"Allow for this session" the approval gate had granted is forgotten, because that set lived in the replaced
instance — the resources were reloaded, so asking again is the honest answer — and the app's `/` list is
briefly stale, which the composer's own reuse window heals without anyone telling it.

### A `!` line is not a command (#643)

In Pi's terminal interface `!ls` runs a shell line and puts its output into the conversation. Over RPC
that prefix means nothing — only a `/` line is looked up, and `!ls` goes to the model as text.

So it is caught in Pi's own `input` event, which fires for a line that arrived over RPC too (measured:
`source: "rpc"`), and a handler returning `{ action: "handled" }` stops it before skill and template
expansion. The handler says a marker; the app sends Pi's own `bash`. That is the point of the round trip:
**Pi's shell runs it and Pi books the output into its context**, so the next turn sees it — verified by
running `!echo MARKER` and asking the model what the last command printed. Running it inside the
extension with `node:child_process` would be a second shell whose output nothing would read.

The `!` grammar therefore lives entirely in `src/backends/pi-native/`. No core branch, nothing in the
composer: a runtime that spells its shell escape differently, or has none, changes nothing outside its
own folder.

**`!!` is refused rather than quietly run as `!`.** In Pi's terminal interface the second `!` means "keep
the output out of the context", and the RPC `bash` has no such option. Accepting the line and booking the
output anyway would break exactly the promise it makes.

Three things about how it is drawn, each decided by a measurement:

- **It cannot use the `partial` slot.** A shell line and an assistant turn can be live AT ONCE — measured:
  a `bash` sent mid-turn completed while the assistant was still streaming. So it is an ordinary entry,
  keyed by the id its request went out under, replaced as its output grows. The growing text is
  accumulated in the decoder, so a view that re-mounts mid-command gets the whole output on the next
  delta rather than the remainder — and the main process stamps the COMMAND onto every op it forwards
  for that line, because a view that mounted late has not seen the op that named it and would otherwise
  draw output under an empty heading, with no Stop.
  **The ops are coalesced like the streamed turn**, at the same interval and for the same reason: each
  one carries the whole output so far, and a chatty command writes a delta at a time. Anything that needs
  ordering flushes both streams, since they share one order in the view. And main forwards an op only for
  a line it started itself: one it did not start has no request behind it, so nothing would ever end it
  and the view would offer Stop for it until the tab closed.
- **Stop had to learn a second thing to stop.** A shell line raises no busy edge — the agent is not
  working — and the Stop control was gated on `busy` alone, so a running command had nothing to stop it.
  It is offered while either is running now, and Escape reaches the same abort. And the abort itself is a
  different command: measured, a plain `abort` answers success and leaves the shell line running to
  completion, because `abort` is about the turn. `abort_bash` is what ends it.
  **Each is sent only when there is something for it to stop**: both when a line is running beside a turn,
  which is one press ending both, and only `abort_bash` for a line running on its own — so stopping a
  command does not also kill a reply that was streaming beside it.
- **A stopped line KEEPS what it had already printed.** The first reading of this said the opposite, and
  it was taken from a command that had printed nothing when it was stopped — an empty answer there means
  "there was nothing", not "it was discarded". Re-measured against a command that was writing at the
  time: every line of it came back. The marker says the line was stopped; the output above it stands.
  That marker is `[cancelled]`, which is not a word chosen here: it is what the Message History reader
  writes for the SAME execution when it reads it back out of the transcript, and the two are asserted
  against each other rather than each against a string written twice. A line that reads one way live and
  another after a re-mount is the drift that pinning exists to prevent.

**A shell line runs only when this window's composer sent it.** The runtime raises its marker for every
turn that reaches the session, and a turn is not only what somebody typed: the trigger watcher, a seed
prompt and a custom launcher all write into one. A `!` line arriving that way would run a command with
nothing asked — and the decision not to put a typed `!` line through the approval gate was taken about a
person at a keyboard, not about a file dropped in a directory. So the composer records the line it sent
and a marker is honoured only against that record, once.

It fails CLOSED, deliberately: a line wrongly taken for injected does not run, which is an annoyance,
while one wrongly taken for typed runs a command nobody asked for. It matches the TEXT rather than
trusting the order, so a typed line and an injected one overlapping still come out right, and an injected
line SAYS it was not run rather than disappearing — what it asked for was a command, and silence would
read as the app losing it.

The alternative weighed and not taken was putting an injected `!` line through the approval gate. It
keeps the capability, but a trigger runs when nobody is watching, and a card nobody answers blocks it —
so the capability would be unreliable exactly where it is used.

### `/fork`, `/clone` and `/tree` are refused, and not because they are out of reach

A first reading of Pi's **RPC** surface alone concluded that `/tree` and `/reload` could not be built at
all. That was wrong, and it is written down here because the conclusion was handed to the owner as a fact.
The extension API is the wider of the two: `ctx.fork(entryId, { position })` is `/fork` and `/clone`,
`ctx.navigateTree(targetId, …)` moves the leaf, `ctx.reload()` exists, and so do `ctx.newSession()` and
`ctx.switchSession()`. `/reload` is built for that reason.

What refuses `/fork` and `/clone` is what they would do to the tab. Both REPLACE the session the runtime is
on — measured: the session id and the session file both change under the running process, and the session
that was forked from is left on disk. So the tab the user is looking at would silently become a different
session. The sidebar's own Fork already answers this and answers it the other way round, by opening the
copy in a tab of its own, and two routes that disagree about which session the user is left looking at is
worth refusing outright. Their `TUI_ONLY` lines name the sidebar rather than saying "not yet".

`/tree` is a different refusal: it is reachable and it is not a command, it is a surface. The branch
browser is a tree with filter modes, and after a jump the conversation has to be re-read — and the leaf
moving is not a turn, so nothing in the event flow announces it. That is its own piece of work: **#646**,
which carries the measurements above so they are not taken again.

## The input completes as you type (#643)

The text field offers what a CLI's own prompt offers. The text before the caret decides what
(`src/renderer/session/composer-completion.js`):

| Typed | Offered | Where the list comes from |
|---|---|---|
| `/` and a name, at the start of the field | Pi's commands, prompt templates and skills, including the commands taken over from another CLI | Pi's RPC `get_commands`, turned into `{ name, description, kind, arguments }` by `rpc-protocol.js` |
| `/model `, `/thinking `, `/login `, `/logout ` and the start of an argument | that command's arguments: available models, thinking levels, providers, saved logins | a command of the runtime extension (below) |
| `@` at the start of a word, also after a command (`/skill:review @src/`) | the project's files and directories | `src/app/path-completion.js` |

The list uses the palette's rows. Arrow keys move through it, Tab or Enter takes a row, Escape closes it.
While the list is open, those keys are the list's. Escape therefore closes a suggestion and does not stop a
running turn, and the next Escape does. Taking a command that has arguments opens its argument list straight
away, and taking a directory opens its contents. A row is taken only while the text before the caret still
asks what the list answered: the caret can move with a click or Home without any input event, and writing
the row where the list was opened would cut the text apart. A list that only repeats what is typed stays
closed, so Enter sends. The lines that stand in for Pi's terminal-only commands are not offered, since they
only say the command is not available here.

Pi's commands can declare `getArgumentCompletions`, but only its terminal interface reads it, and RPC has no
command for it. So the runtime extension registers one more command, `switchboard-complete`. The app sends it
with the command it wants the arguments of and a token. Pi runs an extension command at once, even while a turn
is streaming, and the command reaches neither the model nor the transcript. The command answers with a
marked notice before Pi's response to the prompt. The decoder keeps that answer under its token and never
draws it, and `agent-rpc.js` collects it when the response arrives. The command list leaves this command out,
and it marks a command as having arguments only while this command is registered. Otherwise the app's
question would reach the model as a prompt.

An `@` path is completed in main against the session's working directory, with asynchronous reads only, so
a large project does not hold up the main process. A prefix with a `/` lists that directory, the way a shell
completes. A bare name is searched for across the project in a walk that yields between directories and
checks a budget of entries and time for every entry. A finished walk is kept for a few seconds while the
user types, and one that ran out of budget only briefly. The directory a prefix names is checked with
`isAtOrInside` on real paths before it is read, so `@../` and a link pointing out answer nothing. The walk
names a link as what it points at but never descends into it. A prefix running through an `.asar` is refused
before its path is resolved, because statting one holds it open for the life of the process
(`build-dirs.js`). Build output, dependencies and VCS stores are skipped, and hidden entries are offered only
when the typed part starts with a dot. A path with a space is written `@"…"`, and completion carries on
inside the open quote.

## Another CLI's skills, commands, agents and MCP servers

Both Pi backends can take over another CLI's skills, commands, agents and MCP servers through the
`resourcesFrom` setting (#632, #639, #633). How that works, and what does not come along (hooks, servers other
than stdio), is in spec 31, "What comes along and what does not". The parts specific to this backend are the
questions before a command's shell line and before an MCP tool, described under Approvals above.

## Known gaps

- **Detach and the grid** (E3) — #636.
- **The command palette's insert entries** (run a skill, insert a plan, a handoff, a variable) ask for a
  terminal and are absent for such a session; the keyboard chords in the text field work — #637.
- **The login rests on an undocumented field** (see "Pi's own commands"). A Pi that drops it gets a
  message pointing at the terminal backend's `/login` instead of a login.
- **A device-code login cannot be cancelled from the view.** It asks no question, only polls, so there is no
  card to dismiss. It ends when the code expires or the session is stopped.
- **A login is ended by its card, not by Stop.** Esc and Stop abort a run, and a login is not one. A second
  `/login` to a provider whose first login is still open waits behind it in Pi's queue and shows no card
  until the first one ends. Dismissing the open card ends it.
- **`/fork`, `/clone` and `/tree` answer with a line instead**, and that is a REFUSAL rather than a gap —
  the section above says what each costs, and `/tree` is #646. Session statistics, the export, the copy,
  the name, the reload and `!cmd` used to be on this list and are built; they are in the table above.
- **The pre-launch command** is not offered: there is no shell to put it in front of. The universal field
  is left off descriptors that declare `transport`.
- **A Pi run this app did not start** is not marked, so it opens in the terminal backend. That is correct:
  it was not driven over RPC.
