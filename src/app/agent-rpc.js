// A session driven over a runtime protocol instead of a terminal (#568).
//
// Every other backend is a CLI in a PTY: bytes in, bytes out, and the app reads the transcript afterwards.
// A backend that declares `transport` runs its binary as a child process on a PIPE instead — commands in,
// events out — and the app draws the conversation itself. This module owns that pipe for every such
// session, and it is backend-blind: the backend's `rpc` half turns lines into the app's own ops and the
// app's requests into lines (`src/backends/<id>/rpc-protocol.js` for the one that exists).
//
// WHY THE PROCESS IS WRAPPED TO LOOK LIKE A PTY. `src/app/terminal/spawn.js` builds the session object and
// hands it to everything that already knows how to stop, quit, re-key and clean up a session:
// `stop-session` calls `session.pty.kill()`, the quit path (`session-shutdown.js`) reads `session.pty.pid`,
// the exit handler hangs off `onExit`, and the trigger watcher writes into `session.pty`. Giving the child
// the same four members is what lets all of that run unchanged, instead of teaching each of them a second
// kind of session. `resize`, `pause` and `resume` are answered and do nothing — there is no screen.
//
// `write(data)` is kept MEANINGFUL rather than stubbed: text followed by a carriage return is a turn. That
// is what the renderer's seed prompt, the trigger watcher and a launcher all send into a PTY, so each of
// them reaches a runtime-driven session without knowing it is one.
//
// What crosses to the renderer is the backend's neutral ops on one channel, `agent-event`, routed to the
// window that renders the session — the same routing `terminal-data` gets, for the same reason. What this
// module reports about the session's STATE (busy, idle) goes through `hooks.deliverBindSignal`, the path a
// terminal's binding extension takes, so the turn-hold, the attention inbox and the timeline cannot tell
// the two apart.
'use strict';

const { spawn: spawnChild, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { completePaths } = require('./path-completion');

let ctx = null;

// Where a file the app produced goes when the user named none. Under the app's own data directory, and
// deliberately NOT beside the session: a runtime asked to export itself with no path writes into its
// working directory, which is the user's project — measured, and an untracked file appearing in somebody's
// repository is not an answer to what they asked. A path the user DID name is theirs and is taken as given,
// resolved against the session's own directory the way a shell would.
const EXPORT_DIR_NAME = 'exports';

/**
 * @param {object} context
 * @param {Map} context.activeSessions
 * @param {() => Electron.BrowserWindow|null} context.getMainWindow  a GETTER — see the ctx rule.
 * @param {(id: string) => Electron.BrowserWindow|null} [context.windowForSession]
 * @param {(tag: string, id: string) => object|null} context.adoptSessionId
 * @param {(sessionId: string, hook: object) => void} context.deliverBindSignal
 * @param {() => boolean} context.getAppQuitting
 * @param {string} [context.dataDir]  where a file a session produced goes when nobody named a path
 * @param {Electron.Clipboard} [context.clipboard]  arrives through ctx like every other Electron part,
 *   so this module stays loadable under `node --test`
 * @param {object} context.log
 */
function init(context) {
  ctx = context;
}

// How long a request may wait for its response. `get_messages` on a long session is the slowest thing
// asked, and it is asked when a tab mounts — long enough not to fail a big transcript, short enough that a
// wedged child does not leave a view waiting forever.
const RESPONSE_TIMEOUT_MS = 20000;

// How long a runtime may take to answer ANYTHING after it was started (#647). A request written before the
// runtime reads its input waits in the pipe and is answered once it does — Pi attaches its reader only after
// its extensions have loaded and `session_start` has run, which includes the resources extension's MCP
// servers (up to their own 5 s cap) and a TypeScript compile per extension. Several sessions starting at
// once — a restore after a restart — stretch that, and measuring the ordinary timeout from the spawn told a
// view mounting into a healthy session that it "did not answer". So until the first response arrives a
// request waits at least until this much time has passed since the start; after that the ordinary timeout
// applies. The child exiting still resolves everything at once, so this is a bound on a runtime that is
// alive and silent, not on one that died.
const STARTUP_TIMEOUT_MS = 120000;

// How often a streamed turn is redrawn at most. Pi sends a delta per token; forwarding every one would
// rebuild the partial message in the renderer a few hundred times a second. The LAST partial always goes
// out, and anything else that happens flushes it first, so nothing is reordered and nothing is dropped.
const PARTIAL_INTERVAL_MS = 60;

// The session this state belongs to, found by the tag spawn.js minted for it. The TAG, not an id: the id is
// what changes when the session is re-keyed onto the one Pi names, and the tag is what `adoptSessionId` and
// every other re-key already follow.
function findSession(tag) {
  if (!ctx || !ctx.activeSessions) return null;
  for (const [id, s] of ctx.activeSessions) {
    if (s && s._terminalTag === tag) return { id, session: s };
  }
  return null;
}

/**
 * The absolute file a `/export`-shaped request should write to, or null when it cannot be named.
 * `named` is what the user typed after the command; empty means they named nothing.
 *
 * The backend names the FILE (its format is its own — `exportFileName`), the app names the DIRECTORY.
 *
 * The directory is created for BOTH branches, and that is what the runtime is being spared: it is handed
 * a path, and a parent that does not exist comes back as an errno the user reads as a failed export
 * rather than as a missing folder. `/export out/session.html` in a project with no `out/` is the case.
 *
 * A leading `~` is expanded, because it is a path the USER typed and they mean their home directory.
 * Left alone, `path.resolve` would make it a directory called `~` inside the project — which is exactly
 * the outcome the default branch exists to avoid, reached by a shell-shaped path. This is not the
 * CLI-home rule in `.claude/rules/main-process.md`: that one is about composing a backend's store path,
 * and this is one character somebody typed.
 */
function expandHome(p) {
  if (p !== '~' && !/^~[\\/]/.test(p)) return p;
  return path.join(os.homedir(), p.slice(1));
}

function exportTarget(rpc, state, sessionLabel, named) {
  const typed = String(named || '').trim();
  const file = typed
    ? path.resolve(state.cwd || process.cwd(), expandHome(typed))
    : (typeof rpc.exportFileName === 'function' && ctx && ctx.dataDir
      ? path.join(ctx.dataDir, EXPORT_DIR_NAME, rpc.exportFileName(sessionLabel))
      : '');
  if (!file) return null;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { return null; }
  return file;
}

function stateFor(sessionId) {
  const s = ctx && ctx.activeSessions ? ctx.activeSessions.get(sessionId) : null;
  return s && s.pty && s.pty._agent && !s.exited ? s.pty._agent : null;
}

// Every op carries a sequence number. A view that mounts mid-turn asks for the conversation so far, and the
// runtime's answer is a snapshot taken at one moment while ops keep flowing — the ones already in the
// snapshot must not be applied a second time, and the ones after it must not be lost under the reset. The
// view keeps what arrives while it waits and replays only what is newer than the snapshot's number.
function sendOp(state, op) {
  state.seq += 1;
  const found = findSession(state.tag);
  if (!found) return;
  const w = ctx.windowForSession ? ctx.windowForSession(found.id) : ctx.getMainWindow();
  if (w && !w.isDestroyed()) w.webContents.send('agent-event', found.id, { ...op, seq: state.seq });
}

/**
 * Start one runtime-driven session.
 *
 * `rpc` is the backend's protocol half (its descriptor's `rpc`), `command`/`args` are the resolved launch,
 * `tag` is the terminal tag spawn.js minted. Answers the PTY-shaped process spawn.js stores as
 * `session.pty`. Throws if the child cannot be started, so spawn.js's own catch releases what it allocated.
 */
function start({ tag, rpc, command, args, cwd, env, label, timeouts }) {
  if (!ctx) throw new Error('agent-rpc is not initialised');
  if (!rpc || typeof rpc.createDecoder !== 'function') throw new Error('this backend declares no protocol');

  const child = spawnChild(command, args || [], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // Its own process group off Windows, so a stop can take Pi's tool children with it (see `kill`).
    detached: process.platform !== 'win32',
  });
  // Attached BEFORE anything can throw: a spawn that fails asynchronously (a directory deleted under it)
  // reports through 'error', and one with no listener goes to the process's uncaught-exception handler.
  if (child) child.on('error', (err) => { if (ctx && ctx.log) ctx.log.warn(`[agent-rpc] child error: ${err.code || err.message}`); });
  if (!child || !child.pid) {
    // A spawn that found nothing reports it through 'error' rather than throwing. Make it throw here, where
    // the caller can still release what it allocated for this session.
    try { child && child.kill(); } catch { /* nothing to stop */ }
    throw new Error(`${label || 'The agent'} could not be started.`);
  }

  const exitHandlers = [];
  const state = {
    tag,
    rpc,
    child,
    label: label || 'The agent',
    cwd,                     // the session's project: what an `@` in its input completes against
    decoder: rpc.createDecoder(),
    pending: new Map(),      // request id -> { resolve, timer }
    asks: new Map(),         // request id -> the ask the renderer has not answered yet
    // Shell lines this process started that have not reported back: id -> the command text. The TEXT is
    // kept because every op forwarded for that line carries it — a view that mounts mid-command has
    // never seen the op that named it, and would otherwise draw output under an empty heading.
    localCommands: new Map(),
    localOps: new Map(),     // id -> the newest running op not sent yet (coalesced, like the partial)
    localTimer: null,
    composerLines: new Set(), // shell lines the composer sent that the runtime has not raised yet
    queue: { steering: [], followUp: [] },
    busy: false,
    typed: '',               // what `write()` has collected towards the next carriage return
    partialTimer: null,
    partialOp: null,
    stderrTail: '',
    exited: false,
    seq: 0,                  // the number of the last op sent — see sendOp
    startedAt: Date.now(),
    answered: false,         // has the runtime answered any request yet — see STARTUP_TIMEOUT_MS
  };
  // The tests shorten both; the app never passes them.
  const responseMs = (timeouts && timeouts.responseMs) || RESPONSE_TIMEOUT_MS;
  const startupMs = (timeouts && timeouts.startupMs) || STARTUP_TIMEOUT_MS;

  // Both streamed things at once: the assistant turn being written, and any shell line writing beside it.
  // They are separate streams and can run together, but they share ONE order in the view, so whatever
  // needs ordering flushes both — a notice drawn between two halves of a command's output would read as
  // part of it.
  function flushPartial() {
    if (state.partialTimer) { clearTimeout(state.partialTimer); state.partialTimer = null; }
    if (state.partialOp) { const op = state.partialOp; state.partialOp = null; sendOp(state, op); }
    flushLocalOps();
  }

  function flushLocalOps(only) {
    if (only !== undefined) {
      const op = state.localOps.get(only);
      state.localOps.delete(only);
      if (op) sendOp(state, op);
      if (!state.localOps.size && state.localTimer) { clearTimeout(state.localTimer); state.localTimer = null; }
      return;
    }
    if (state.localTimer) { clearTimeout(state.localTimer); state.localTimer = null; }
    if (!state.localOps.size) return;
    const ops = [...state.localOps.values()];
    state.localOps.clear();
    for (const op of ops) sendOp(state, op);
  }

  function write(obj) {
    if (state.exited || !child.stdin || child.stdin.destroyed) return false;
    try { child.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; }
  }

  // One request, one response. Pi echoes the `id` it was given; a request whose response never comes is
  // answered with a refusal after RESPONSE_TIMEOUT_MS so nobody awaits it forever.
  //
  // Two options, each for one caller and each the opposite of a default:
  //
  //   `id`         the runtime echoes it on events of its OWN before the response lands — a shell line's
  //                output arrives under it — so the caller has to know the id in advance.
  //   `timeoutMs`  0 means no timer at all, and the only caller that asks for it is a shell line the
  //                USER started: `!npm test` runs for minutes, and a timeout would report a failure
  //                about a command that is working. Nothing is leaked by it — the child exiting resolves
  //                every pending request (see the exit handler), which is the real bound here.
  //
  // A request sent before the runtime has answered anything waits out its start as well (#647), and one that
  // still finds it silent then resolves as `not started` rather than `no answer`: a runtime that never
  // began reading is a different failure from one that stopped answering, and the view says which.
  function request(build, { id: fixedId, timeoutMs = responseMs } = {}) {
    const id = fixedId || crypto.randomUUID();
    return new Promise((resolve) => {
      const wait = timeoutMs > 0 && !state.answered
        ? Math.max(timeoutMs, startupMs - (Date.now() - state.startedAt))
        : timeoutMs;
      const timer = wait > 0 ? setTimeout(() => {
        state.pending.delete(id);
        resolve({ success: false, error: state.answered ? 'no answer' : 'not started' });
      }, wait) : null;
      if (timer && typeof timer.unref === 'function') timer.unref();
      state.pending.set(id, { resolve, timer });
      if (!write(build(id))) {
        clearTimeout(timer);
        state.pending.delete(id);
        resolve({ success: false, error: 'not running' });
      }
    });
  }
  state.request = request;
  state.write = write;

  // Which session is Pi on? Asked at start and after every settled run, because the answer is what the row
  // is keyed on and Pi can move (a fork or a new session from inside it). The re-key itself is the one
  // every other backend's live binding goes through.
  async function followIdentity() {
    const res = await request(rpc.stateCommand);
    const id = res && res.success !== false ? rpc.sessionIdFromState(res) : null;
    if (!id || typeof ctx.adoptSessionId !== 'function') return;
    try {
      const moved = ctx.adoptSessionId(tag, id);
      if (moved && moved.from && moved.to) ctx.log.info(`[agent-rpc] session ${moved.from} → ${moved.to} (the runtime named it)`);
    } catch (err) {
      ctx.log.warn(`[agent-rpc] could not follow the runtime's session id: ${err.message}`);
    }
  }
  state.followIdentity = followIdentity;

  // A SHELL LINE RUNS ONLY IF THIS WINDOW'S COMPOSER SENT IT.
  //
  // The runtime raises its shell-line marker for every turn that reaches the session, and a turn does not
  // only come from somebody typing: the trigger watcher, a seed prompt and a custom launcher all write
  // into a session through `write()` below. A `!` line arriving that way would run a command with nothing
  // asked — and the decision not to put a typed `!` line through the approval gate was taken about a
  // person at a keyboard, not about a file dropped in a directory.
  //
  // So the composer says what it sent, and a marker is honoured only against that. It fails CLOSED on
  // purpose: a line wrongly taken for injected does not run, which is an annoyance, while one wrongly
  // taken for typed runs a command nobody asked for. Matching the TEXT rather than trusting an order
  // keeps that true when a typed line and an injected one overlap.
  //
  // The reader must spell the command exactly as the backend's marker does, which is why both sides trim
  // the line and then trim what follows the `!`.
  const SHELL_LINE = /^\s*!\s*(?!\s*!)(.+)$/s;
  function shellLineOf(text) {
    const m = SHELL_LINE.exec(String(text == null ? '' : text));
    const command = m ? m[1].trim() : '';
    return command || null;
  }
  function noteComposerLine(text) {
    const command = shellLineOf(text);
    if (!command) return;
    // A bound, not a cache: these are consumed within a second of being sent, and one left behind means
    // the runtime never raised the marker for it.
    if (state.composerLines.size > 16) state.composerLines.clear();
    state.composerLines.add(command);
  }
  state.noteComposerLine = noteComposerLine;

  function report(kind, extra) {
    const found = findSession(tag);
    if (!found || typeof ctx.deliverBindSignal !== 'function') return;
    const pending = state.queue.steering.length + state.queue.followUp.length > 0;
    try { ctx.deliverBindSignal(found.id, { kind, pending, ...(extra || {}) }); } catch (err) {
      ctx.log.warn(`[agent-rpc] state not delivered: ${err.message}`);
    }
  }

  state.report = report;

  // Questions Pi stopped waiting on — a run that settled, a process that ended — are closed here too, or
  // every later mount would draw a dialog nobody can answer any more. A `lasting` question belongs to
  // something outside the run (a command the user typed) and Pi keeps waiting on it, so a settled run leaves
  // it open; only the process ending takes it.
  function dropAsks({ keepLasting = false } = {}) {
    for (const [id, request] of state.asks) {
      if (keepLasting && request && request.lasting) continue;
      sendOp(state, { op: 'answered', id });
      state.asks.delete(id);
    }
  }

  function handleOp(op) {
    switch (op.op) {
      case 'partial':
        // Coalesced: only the newest partial matters, and the timer bounds how long it may wait.
        state.partialOp = op;
        if (!state.partialTimer) {
          state.partialTimer = setTimeout(flushPartial, PARTIAL_INTERVAL_MS);
          if (typeof state.partialTimer.unref === 'function') state.partialTimer.unref();
        }
        return;
      case 'localCommand': {
        // A shell line writes a delta at a time and every op carries the whole output so far, so it is
        // coalesced exactly as the streamed turn above is. Without it `!npm test` sends one full-buffer
        // message and costs one full re-render per delta, which `ping -n 6` is far too quiet to show.
        //
        // Two things are decided here rather than in the backend, because both are about THIS process's
        // own bookkeeping: an op for a line this process did not start is dropped — nothing would ever
        // end it, so the view would keep offering Stop for it forever — and the command TEXT is stamped
        // on, so a view that mounts mid-command draws the line complete.
        const command = state.localCommands.get(op.id);
        if (command === undefined) return;
        state.localOps.set(op.id, { ...op, command });
        if (!state.localTimer) {
          state.localTimer = setTimeout(flushLocalOps, PARTIAL_INTERVAL_MS);
          if (typeof state.localTimer.unref === 'function') state.localTimer.unref();
        }
        return;
      }
      case 'busy':
        flushPartial();
        if (state.busy === op.busy) return;
        state.busy = op.busy;
        ctx.log.info(`[agent-rpc] session=${(findSession(tag) || {}).id || tag.slice(0, 8)} → ${op.busy ? 'BUSY' : 'IDLE'}`);
        // `turn_start` because an RPC `agent_start` IS a turn beginning — the one fact that releases a
        // held "finished" (#495) — and only the start says so, never the settle.
        report(op.busy ? 'busy' : 'idle', op.busy ? { turn_start: true } : undefined);
        if (!op.busy) {
          dropAsks({ keepLasting: true });
          // Still waiting on a question that outlived the run: the session is waiting on the user, not idle.
          const open = state.asks.values().next().value;
          if (open) report('waiting', { prompt_kind: open.method });
        }
        sendOp(state, op);
        if (!op.busy) followIdentity();
        return;
      case 'queue':
        state.queue = { steering: op.steering || [], followUp: op.followUp || [] };
        flushPartial();
        sendOp(state, op);
        return;
      case 'ask':
        state.asks.set(op.request.id, op.request);
        flushPartial();
        // A session blocked on a question is waiting on the user, which the inbox has to hear about —
        // the same edge a terminal's binding posts for an extension's prompt (#529).
        report('waiting', { prompt_kind: op.request.method });
        sendOp(state, op);
        return;
      case 'figures':
        // The user asked the session for its own figures. The backend says only THAT it was asked — what
        // the numbers are, and what they are called, is a question only its protocol can put to the
        // runtime, so the core sends what the backend hands it and draws the sentence it gets back. Not
        // awaited: an answer that never comes must not hold the stream this runs on.
        flushPartial();
        if (typeof rpc.statsCommand !== 'function' || typeof rpc.statsNotice !== 'function') return;
        request(rpc.statsCommand).then((res) => {
          // The backend words an unanswered request too, so there is no silent branch here: a command that
          // draws nothing at all reads as one that did not run.
          const notice = rpc.statsNotice(res);
          if (notice && notice.text) sendOp(state, { op: 'notice', level: notice.level || 'info', text: notice.text });
        }).catch((err) => ctx.log.warn(`[agent-rpc] the session's figures were not reported: ${err.message}`));
        return;
      case 'exportFile': {
        // The user asked for a file of this session. WHERE it goes is the app's question and nobody
        // else's; what it is called and what is in it are the runtime's. Not awaited, for the same
        // reason the figures are not: an answer that never comes must not hold this stream.
        flushPartial();
        if (typeof rpc.exportCommand !== 'function' || typeof rpc.exportNotice !== 'function') return;
        const found = findSession(tag);
        const target = exportTarget(rpc, state, (found && found.id) || tag, op.args);
        if (!target) {
          sendOp(state, { op: 'notice', level: 'error', text: 'Switchboard could not decide where to write the file.' });
          return;
        }
        request((id) => rpc.exportCommand(id, { outputPath: target })).then((res) => {
          const notice = rpc.exportNotice(res);
          if (!notice || !notice.text) return;
          // The runtime may answer a path relative to its own directory, so it is resolved before it is
          // offered — a button that opens a path this process would resolve against ITS cwd opens
          // whatever happens to sit there.
          const file = notice.path ? path.resolve(state.cwd || process.cwd(), String(notice.path)) : '';
          sendOp(state, {
            op: 'notice',
            level: notice.level || 'info',
            text: notice.text,
            ...(file ? { files: [{ path: file, label: 'Open the file' }] } : {}),
          });
        }).catch((err) => ctx.log.warn(`[agent-rpc] the session was not written to a file: ${err.message}`));
        return;
      }
      case 'shell': {
        // The user asked to run a shell line. The runtime runs it, because its own shell is what books the
        // output into the session's context — the next prompt then carries it to the model. This process
        // only starts it, says so on screen, and remembers that one is running so Stop can reach it.
        flushPartial();
        if (typeof rpc.shellCommand !== 'function' || typeof rpc.shellResult !== 'function') return;
        const command = String(op.command || '');
        if (!command) return;
        // Only a line this window's composer sent — see `noteComposerLine`. A turn written into the
        // session from somewhere else says so rather than running, because what it asked for is a
        // command and refusing it silently would read as the app losing the line.
        if (!state.composerLines.delete(command)) {
          sendOp(state, {
            op: 'notice',
            level: 'warning',
            text: 'A shell line only runs when it is typed here. This one arrived with a message sent into the session, so it was not run.',
          });
          return;
        }
        const id = crypto.randomUUID();
        state.localCommands.set(id, command);
        // Said before the request goes out, so a command that takes a minute has something on screen from
        // the first frame rather than from its last.
        sendOp(state, { op: 'localCommand', id, command, status: 'running', output: '' });
        request(() => rpc.shellCommand(id, { command }), { id, timeoutMs: 0 }).then((res) => {
          state.localCommands.delete(id);
          // Whatever was still waiting to be drawn for this line is dropped rather than sent: the result
          // below carries the whole output, so flushing first would draw the same text twice.
          state.localOps.delete(id);
          const result = rpc.shellResult(res);
          sendOp(state, { op: 'localCommand', id, command, status: result.status, output: result.output });
        }).catch((err) => {
          state.localCommands.delete(id);
          state.localOps.delete(id);
          ctx.log.warn(`[agent-rpc] a shell line did not report back: ${err.message}`);
        });
        return;
      }
      case 'lastReply':
        // The user asked for the agent's last reply on the clipboard. The runtime hands back the text,
        // this process does the copying — a clipboard belongs to the machine rather than to a session —
        // and the backend words what happened, whichever way it went, so there is one sentence-writer.
        flushPartial();
        if (typeof rpc.lastReplyCommand !== 'function' || typeof rpc.lastReplyText !== 'function'
          || typeof rpc.copiedNotice !== 'function') return;
        request(rpc.lastReplyCommand).then((res) => {
          const text = rpc.lastReplyText(res);
          let copied = false;
          if (text != null && ctx.clipboard && typeof ctx.clipboard.writeText === 'function') {
            try { ctx.clipboard.writeText(String(text)); copied = true; } catch { copied = false; }
          }
          const notice = rpc.copiedNotice({ text, copied });
          if (notice && notice.text) sendOp(state, { op: 'notice', level: notice.level || 'info', text: notice.text });
        }).catch((err) => ctx.log.warn(`[agent-rpc] the last reply was not copied: ${err.message}`));
        return;
      case 'answered':
        // The runtime stopped waiting on a question by itself (a login whose browser callback won). Only a
        // question still open is closed, and the session leaves "waiting" the way `answerAsk` lets it go.
        if (!state.asks.has(op.id)) return;
        state.asks.delete(op.id);
        flushPartial();
        sendOp(state, op);
        if (!state.asks.size) report(state.busy ? 'busy' : 'idle');
        return;
      default:
        flushPartial();
        sendOp(state, op);
    }
  }

  // Strict JSONL: records end at LF and nothing else. Node's readline also splits on U+2028/U+2029, which are
  // legal inside a JSON string, so it is not used — Pi's own RPC document says the same.
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (ctx.getAppQuitting && ctx.getAppQuitting()) return;
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { ctx.log.debug(`[agent-rpc] unreadable line (${line.length} bytes)`); continue; }
      if (msg && msg.type === 'response') {
        state.answered = true;
        const waiting = msg.id != null ? state.pending.get(String(msg.id)) : null;
        if (waiting) {
          clearTimeout(waiting.timer);
          state.pending.delete(String(msg.id));
          // The op number at the moment the answer ARRIVED, not when its reader resumes: the rest of this
          // chunk is parsed and sent before the awaiting code runs, and those ops are newer than the answer.
          flushPartial();
          waiting.resolve({ ...msg, _seq: state.seq });
        }
        continue;
      }
      let ops = [];
      try { ops = state.decoder.decode(msg) || []; } catch (err) { ctx.log.warn(`[agent-rpc] decode failed: ${err.message}`); }
      for (const op of ops) handleOp(op);
    }
  });

  // Kept for the log only. Stderr is the child's own voice and can name any path on the machine, so it is
  // never sent to a window (#444) — the exit notice says what happened in words of our own.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    state.stderrTail = (state.stderrTail + chunk).slice(-2000);
  });
  child.stdin.on('error', () => { /* the child went away; the exit handler says so */ });
  child.on('exit', (code, signal) => {
    if (state.exited) return;
    state.exited = true;
    flushPartial();
    dropAsks();
    for (const [, waiting] of state.pending) { clearTimeout(waiting.timer); waiting.resolve({ success: false, error: 'exited' }); }
    state.pending.clear();
    if (state.stderrTail.trim()) ctx.log.info(`[agent-rpc] stderr before exit: ${state.stderrTail.trim().slice(-600)}`);
    const exitCode = code == null ? (signal ? 1 : 0) : code;
    for (const h of exitHandlers) { try { h({ exitCode }); } catch (err) { ctx.log.warn(`[agent-rpc] exit handler failed: ${err.message}`); } }
  });

  // Text followed by a carriage return is a turn; ESC or Ctrl+C on their own stop the running one. See the
  // header for why this is not a stub. A carriage return INSIDE a bracketed paste is text, as it is to a
  // terminal — a pasted CRLF block must not be cut into several turns. Text written without a return waits
  // in `typed` for the one that follows it, which is how the trigger watcher sends: the text, then `\r`.
  function writeKeys(data) {
    const raw = String(data == null ? '' : data);
    if (raw === '\x1b' || raw === '\x03') { request(rpc.abortCommand); return; }
    let i = 0;
    while (i < raw.length) {
      if (raw.startsWith('\x1b[200~', i)) { state.inPaste = true; i += 6; continue; }
      if (raw.startsWith('\x1b[201~', i)) { state.inPaste = false; i += 6; continue; }
      const ch = raw[i++];
      if (ch === '\r' && !state.inPaste) {
        const turn = state.typed.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
        state.typed = '';
        if (turn.trim()) handBackIfRefused(turn, send({ text: turn, mode: 'prompt' }));
      } else {
        state.typed += ch;   // a pasted \r stays until the line endings are folded below
      }
    }
    state.typed = state.typed.replace(/\r\n?/g, '\n');
  }

  function send({ text, mode }) {
    return request((id) => rpc.sendCommand({ id, text, mode, busy: state.busy }));
  }

  // A turn written as keys — the seed prompt, the trigger watcher, a launcher — has nobody waiting on its
  // answer, so a refusal used to vanish (#648). The composer's own send reports back to the view that sent
  // it; this is the same for everything else: the text goes back into the view's input, unsent, with a line
  // saying so. A process that has ended says that itself, and a refusal then would only repeat it.
  function handBackIfRefused(text, pending) {
    pending.then((res) => {
      if (state.exited || (res && res.success !== false)) return;
      // A timeout is not a refusal: the line is still in the pipe and runs once the runtime reads it, so
      // handing it back would invite the user to send it twice. Only an answer that says no is handed back.
      if (res && (res.error === 'not started' || res.error === 'no answer')) {
        ctx.log.info(`[agent-rpc] a written turn got no answer yet (${res.error}); left in the pipe`);
        return;
      }
      flushPartial();
      sendOp(state, { op: 'unsent', text });
      ctx.log.info(`[agent-rpc] a written turn was not taken (${(res && res.error) || 'refused'}); handed back to the view`);
    });
  }
  state.send = send;

  // Stopping takes the process TREE on Windows. Pi runs its tools as children of its own, and a plain kill
  // of the node process leaves a running `bash` behind with nobody to answer it.
  function kill() {
    if (state.exited) return;
    const pid = child.pid;
    if (process.platform === 'win32' && pid) {
      const tk = execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      if (tk && tk.stdin) tk.stdin.end();
    } else {
      // The whole group it was started in (`detached` above), so a running tool goes with it.
      try { process.kill(-pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
    }
  }

  followIdentity();

  return {
    pid: child.pid,
    _agent: state,
    _isDisposed: false,
    write: writeKeys,
    kill,
    // Something to tell the user that is not a turn — the spawn path's "started a new one instead".
    notice: (level, text) => sendOp(state, { op: 'notice', level, text }),
    onData() { /* ops go out on `agent-event`, not as terminal bytes */ },
    onExit(handler) { if (typeof handler === 'function') exitHandlers.push(handler); },
    resize() {},
    pause() {},
    resume() {},
  };
}

// --- IPC ---

// What a view needs to draw a session it has just mounted: the conversation so far (from the runtime,
// which holds the transcript), the turn being streamed, whether it is working, what is queued, and any
// question still open. The transcript is the truth — there is no second log here to fall out of step.
async function attach(sessionId) {
  const state = stateFor(sessionId);
  if (!state) return { ok: false, error: 'This session is not running.' };
  const res = await state.request(state.rpc.messagesCommand);
  if (!res || res.success === false) {
    // Logged with the time since the start, because the case this exists for (#647) was never measured:
    // the next one says whether the runtime was still starting, had stopped answering, or refused.
    const reason = (res && res.error) || 'refused';
    ctx.log.info(`[agent-rpc] attach ${sessionId} failed (${reason}) ${Date.now() - state.startedAt} ms after the start`);
    return { ok: false, error: attachFailure(reason, Date.now() - state.startedAt) };
  }
  return {
    ok: true,
    seq: res._seq || 0,
    entries: state.rpc.entriesFromMessages(res),
    partial: state.decoder.currentPartial(),
    busy: state.busy,
    queue: state.queue,
    asks: [...state.asks.values()],
  };
}

// What the view says when the conversation could not be loaded — one sentence per failure, because they want
// different things from the user: a session that is not running can be relaunched, one still starting after
// the startup bound is wedged, and one that stopped answering may recover on its own.
function attachFailure(reason, waitedMs) {
  switch (reason) {
    case 'not running': case 'exited': return 'This session is not running.';
    case 'not started': return `The session did not start answering within ${Math.max(1, Math.round(waitedMs / 60000))} minute${Math.round(waitedMs / 60000) > 1 ? 's' : ''}.`;
    case 'no answer': return 'The session did not answer.';
    default: return 'The session could not load its conversation.';
  }
}

const SEND_MODES = new Set(['prompt', 'steer', 'follow_up']);

async function sendTurn(sessionId, payload) {
  const state = stateFor(sessionId);
  if (!state) return { ok: false, error: 'This session is not running.' };
  const text = String((payload && payload.text) || '');
  if (!text.trim()) return { ok: false, error: 'Nothing to send.' };
  const mode = SEND_MODES.has(payload && payload.mode) ? payload.mode : 'prompt';
  state.noteComposerLine(text);
  const res = await state.send({ text, mode });
  // Pi's refusal is its own sentence about the request ("Agent is streaming…"), not a thrown error that
  // could carry a path, so it is passed on.
  return res && res.success !== false ? { ok: true } : { ok: false, error: (res && res.error) || 'The session refused the message.' };
}

// Stop. It ends the agent's turn — and, since #643, a shell line the user started, which is a SECOND
// thing to stop and not the same one: measured on Pi 0.85.1, a plain abort answers success while the
// command runs on to completion, because an abort is about the turn and a shell line is not one. So both
// go out when a shell line is running, that one first: it is the thing the user can see working.
//
// A stopped line keeps what it had already printed (measured), so what the user is left with is the
// output up to the moment they pressed Stop, marked as stopped. The backend words that.
//
// EACH IS SENT ONLY WHEN THERE IS SOMETHING FOR IT TO STOP. Both, when a shell line is running beside a
// turn — that is one press of Stop ending both, which is what Stop means — but a shell line running on
// its own does not get the turn aborted as well, and an idle session with a shell line does not report
// "The session did not stop" because the abort it did not need answered oddly.
async function abortTurn(sessionId) {
  const state = stateFor(sessionId);
  if (!state) return { ok: false, error: 'This session is not running.' };
  const stopsLine = state.localCommands.size > 0 && typeof state.rpc.shellAbortCommand === 'function';
  const answers = [];
  if (stopsLine) answers.push(await state.request(state.rpc.shellAbortCommand));
  if (state.busy || !stopsLine) answers.push(await state.request(state.rpc.abortCommand));
  const failed = answers.find(res => !res || res.success === false);
  return failed ? { ok: false, error: 'The session did not stop.' } : { ok: true };
}

// --- the input's autocomplete (#643) ---

// What a `/` can complete to: the backend's own list, in the app's words (`{ name, description, kind,
// arguments }`). A backend that declares no such command answers an empty list, not an error.
async function listCommands(sessionId) {
  const state = stateFor(sessionId);
  if (!state) return { ok: false, error: 'This session is not running.' };
  if (typeof state.rpc.commandsCommand !== 'function' || typeof state.rpc.commandsFromResponse !== 'function') return { ok: true, commands: [] };
  const res = await state.request(state.rpc.commandsCommand);
  if (!res || res.success === false) return { ok: false, error: 'The session did not answer.' };
  return { ok: true, commands: state.rpc.commandsFromResponse(res) };
}

// What one command takes as an argument: `{ value, description }` rows. The backend's answer arrives beside
// the response to its request, and its decoder holds it under the token the request carried.
async function completeArguments(sessionId, command) {
  const state = stateFor(sessionId);
  if (!state) return { ok: false, error: 'This session is not running.' };
  if (typeof state.rpc.argumentsCommand !== 'function' || typeof state.decoder.takeCompletions !== 'function') return { ok: true, items: [] };
  const token = crypto.randomUUID();
  const res = await state.request((id) => state.rpc.argumentsCommand(id, { command: String(command || ''), token }));
  const items = state.decoder.takeCompletions(token);
  if (!res || res.success === false) return { ok: false, error: 'The session did not answer.' };
  return { ok: true, items: Array.isArray(items) ? items : [] };
}

// What an `@` can complete to: the files of the session's own project, never outside it (./path-completion.js).
async function completeSessionPaths(sessionId, prefix) {
  const state = stateFor(sessionId);
  if (!state) return { ok: false, error: 'This session is not running.' };
  let items = [];
  try { items = await completePaths(state.cwd, String(prefix == null ? '' : prefix)); } catch { items = []; }
  return { ok: true, items };
}

function answerAsk(sessionId, requestId, answer) {
  const state = stateFor(sessionId);
  if (!state) return { ok: false, error: 'This session is not running.' };
  const id = String(requestId || '');
  if (!state.asks.has(id)) return { ok: false, error: 'That question is no longer open.' };
  state.asks.delete(id);
  const ok = state.write(state.rpc.answerCommand(id, answer || { cancelled: true }));
  if (ok) sendOp(state, { op: 'answered', id });
  // The question ended the busy state (a session waiting on the user is not working); answering it inside
  // a run hands the session back to the agent, and nothing else would say so until the run settles. A
  // question asked outside a run (an extension's own command) leaves the session idle once answered.
  if (ok && !state.asks.size) state.report(state.busy ? 'busy' : 'idle');
  return ok ? { ok: true } : { ok: false, error: 'The session is not running.' };
}

/** @param {Electron.IpcMain} ipc */
function registerIpc(ipc) {
  ipc.handle('agent-attach', (_event, sessionId) => attach(sessionId));
  ipc.handle('agent-send', (_event, sessionId, payload) => sendTurn(sessionId, payload));
  ipc.handle('agent-abort', (_event, sessionId) => abortTurn(sessionId));
  ipc.handle('agent-answer', (_event, sessionId, requestId, answer) => answerAsk(sessionId, requestId, answer));
  ipc.handle('agent-commands', (_event, sessionId) => listCommands(sessionId));
  ipc.handle('agent-arguments', (_event, sessionId, command) => completeArguments(sessionId, command));
  ipc.handle('agent-paths', (_event, sessionId, prefix) => completeSessionPaths(sessionId, prefix));
}

module.exports = {
  init, registerIpc, start,
  // For the tests, which drive a fake child through the same functions the IPC calls.
  attach, sendTurn, abortTurn, answerAsk, listCommands, completeArguments, completeSessionPaths,
  PARTIAL_INTERVAL_MS, RESPONSE_TIMEOUT_MS, STARTUP_TIMEOUT_MS,
};
