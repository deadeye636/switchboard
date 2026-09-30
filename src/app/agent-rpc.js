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
const { measured } = require('../perf');

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

// How often the context fill is asked again WHILE a turn runs, for a backend whose runtime answers then
// (`contextDuringTurn`, #697). A turn with several tool calls grows the context with every one, and the
// sidebar reads that growth from the transcript line by line; asked only when the run settles, the session
// line sat at the previous settle — measured 17 % against the sidebar's 52 % in one five-call turn. Each
// finished entry schedules one ask at most this long after it, so a burst of entries costs one request.
const CONTEXT_FOLLOW_MS = 1500;

// How many finished entries are kept for an attach that reads the conversation from the transcript file
// (see `attach`). The file can lag the stream by the entry being written, never by a whole turn, so this
// is a bound on a window of milliseconds rather than a second log of the session.
const RECENT_APPENDS_CAP = 64;

// How long a turn the runtime owes may take to start after the one before it ended. Measured on Claude Code:
// a queued line's `system/init` follows the previous `result` within tens of milliseconds, so this is a
// bound on a miscount, not a wait anyone sees. It is above the turn-hold's first recheck (4 s), so a hold
// asks at least once while the count still stands.
const OWED_GRACE_MS = 10000;

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

// How many shells and agents a session runs in the background (#691), for the sidebar. Always to the MAIN
// window: the sidebar lives there whichever window renders the session (main-process.md, the routing table).
function announceBackground(state) {
  const found = findSession(state.tag);
  const w = ctx.getMainWindow ? ctx.getMainWindow() : null;
  if (!found || !w || w.isDestroyed()) return;
  const counts = { shells: 0, agents: 0, other: 0 };
  for (const t of state.tasks) {
    if (t && t.kind === 'shell') counts.shells++;
    else if (t && t.kind === 'agent') counts.agents++;
    else counts.other++;
  }
  w.webContents.send('agent-background', found.id, counts);
}

/**
 * Start one runtime-driven session.
 *
 * `rpc` is the backend's protocol half (its descriptor's `rpc`), `command`/`args` are the resolved launch,
 * `tag` is the terminal tag spawn.js minted, `forkFrom` the session a fork was started from (handed to the
 * backend's transcript read, see `attachFromTranscript`). Answers the PTY-shaped process spawn.js stores as
 * `session.pty`. Throws if the child cannot be started, so spawn.js's own catch releases what it allocated.
 */
function start({ tag, rpc, command, args, cwd, env, label, timeouts, forkFrom }) {
  if (!ctx) throw new Error('agent-rpc is not initialised');
  if (!rpc || typeof rpc.createDecoder !== 'function' || typeof rpc.responseOf !== 'function') {
    throw new Error('this backend declares no protocol');
  }

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
    forkFrom: forkFrom || null, // the session this one was forked from, for a transcript read before its first turn
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
    navigations: new Set(),  // moves in the branch tree this process asked for and has not heard back on
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
    // The last finished entries sent, for an attach from the transcript file — kept only when the backend
    // can name an entry (`entryKey`), because a merge without a key could only guess what is a repeat.
    recentAppends: [],
    resets: 0,               // how many times the conversation was replaced — see `attachFromTranscript`
    owed: 0,                 // turn lines written while busy that have not started yet — see `turnQueueOf`
    owedTimer: null,
    turnStartedAt: 0,        // when the last turn began, for the turn-hold's "did the queued one start"
    stopping: false,         // a graceful stop is waiting for the child — see `kill`
    tasks: [],               // what runs in the background, as the backend last listed it (#691)
    taskFiles: new Map(),    // task id -> the output file a notice named, kept once it held output (#725)
    suggestion: null,        // the next prompt the runtime proposed after the last turn (#693)
    context: null,           // the context fill and the model, as the backend last read them (#691)
    mode: null,              // the permission mode the runtime last named, in the backend's words (#696)
    contextTimer: null,      // an ask of the fill scheduled during a turn (#697)
    contextAsked: 0,         // the number of the last ask of the fill sent, and of the last one applied —
    contextApplied: 0,       //   an answer older than one already drawn is dropped
    // Prompts sent while a turn runs, held here rather than written to the runtime (#702), so each can still be
    // withdrawn or taken back for editing: `{ id, text, images, at }`, oldest first. `heldPaused` is set by a
    // Stop, after which they wait for the user instead of starting the next turn by themselves.
    held: [],
    heldPaused: false,
    heldInFlight: false,     // a held prompt was written and its turn has not started yet — see flushHeld
  };
  // The tests shorten these; the app never passes them.
  const responseMs = (timeouts && timeouts.responseMs) || RESPONSE_TIMEOUT_MS;
  const startupMs = (timeouts && timeouts.startupMs) || STARTUP_TIMEOUT_MS;
  const contextFollowMs = (timeouts && timeouts.contextFollowMs) || CONTEXT_FOLLOW_MS;

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

  // Nothing is written once a stop has closed stdin: the stream is not destroyed yet, so a write would be
  // accepted and then fail asynchronously, and a turn or an answer would report success about nothing.
  //
  // A decoder that declares `noteSent(line)` hears every line that went out, in its own format. Some of what
  // a runtime answers only means something against what it was asked — Claude ends a turn it was told to
  // stop with the same error it gives a failed one — and the decoder is the only place that reads the answer.
  function write(obj) {
    if (state.exited || state.stopping || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return false;
    try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch { return false; }
    if (typeof state.decoder.noteSent === 'function') {
      try { state.decoder.noteSent(obj); } catch (err) { ctx.log.warn(`[agent-rpc] decoder did not take a sent line: ${err.message}`); }
    }
    return true;
  }

  // One request, one response. The runtime answers under the `id` it was given — where it spells that id is
  // the backend's `responseOf` — and a request whose response never comes is answered with a refusal after
  // RESPONSE_TIMEOUT_MS so nobody awaits it forever.
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

  // A command the backend says the app answers itself (`appCommandOp`, #719): drawn as the user's line and
  // handled as the op the backend named, with nothing written to the runtime — so it is no turn, raises no
  // busy edge and is never held behind one.
  state.answerInApp = (text, op) => {
    sendOp(state, { op: 'append', entry: { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: text.trim() }, prompt: true } });
    handleOp(op);
  };

  // The row is keyed on the session the runtime is on, and the runtime can move (a fork or a new session
  // from inside it). The re-key itself is the one every other backend's live binding goes through.
  function adoptIdentity(id) {
    if (!id || typeof ctx.adoptSessionId !== 'function') return;
    try {
      const moved = ctx.adoptSessionId(tag, String(id));
      if (moved && moved.from && moved.to) {
        ctx.log.info(`[agent-rpc] session ${moved.from} → ${moved.to} (the runtime named it)`);
        // The sidebar's background count under the new id too (#691): the main window re-keys its own copy,
        // and this says it again for a window that missed the move.
        if (state.tasks.length) announceBackground(state);
      }
    } catch (err) {
      ctx.log.warn(`[agent-rpc] could not follow the runtime's session id: ${err.message}`);
    }
  }

  // Two ways a runtime says which session it is on, and a backend declares one or both. A runtime that can
  // be ASKED (`stateCommand` + `sessionIdFromState`) is asked at start and after every settled run; one
  // that ANNOUNCES a move emits an `identity` op when it happens. Asking a runtime that has no such request
  // would build nothing and reject inside the Promise, so a backend without the pair is simply not asked.
  async function followIdentity() {
    if (typeof rpc.stateCommand !== 'function' || typeof rpc.sessionIdFromState !== 'function') return;
    const res = await request(rpc.stateCommand);
    adoptIdentity(res && res.success !== false ? rpc.sessionIdFromState(res) : null);
  }
  state.followIdentity = followIdentity;

  // The context fill and the model (#691), asked where the backend can be asked (`contextCommand` +
  // `contextFromResponse`), at the start and after every settled run — and, where the half declares
  // `contextDuringTurn`, during a turn as well (`followContextSoon`, #697).
  // Not awaited by anyone: an answer that never comes leaves the line as it was.
  async function followContext() {
    if (typeof rpc.contextCommand !== 'function' || typeof rpc.contextFromResponse !== 'function') return;
    const asked = ++state.contextAsked;
    const res = await request(rpc.contextCommand);
    let context = null;
    try { context = res && res.success !== false ? rpc.contextFromResponse(res) : null; } catch { context = null; }
    if (!context || asked < state.contextApplied) return;
    state.contextApplied = asked;
    state.context = context;
    sendOp(state, { op: 'context', context });
  }
  state.followContext = followContext;

  // One ask of the fill, CONTEXT_FOLLOW_MS after the entry that scheduled it, while a turn runs. Only for a
  // runtime measured to answer mid-turn: one that queues the request behind the turn would answer it at the
  // settle anyway, and one that never answers would hold a pending request per entry for the full timeout.
  function followContextSoon() {
    if (rpc.contextDuringTurn !== true || state.contextTimer || state.exited) return;
    state.contextTimer = setTimeout(() => {
      state.contextTimer = null;
      if (state.busy && !state.exited) followContext();
    }, contextFollowMs);
    if (typeof state.contextTimer.unref === 'function') state.contextTimer.unref();
  }

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

  // The owed-turn count, kept at the busy edges (`turnQueueOf`). A turn beginning is the one fact that proves
  // a queued line ran, so it takes one off. A count that no turn ever answers — a line the runtime folded
  // into the running turn after all — is dropped once the session has stayed idle for OWED_GRACE_MS, so a
  // miscount costs one late "finished" and never holds every later one.
  function noteTurnEdge(busy) {
    if (state.owedTimer) { clearTimeout(state.owedTimer); state.owedTimer = null; }
    if (busy) {
      state.turnStartedAt = Date.now();
      if (state.owed > 0) state.owed -= 1;
      return;
    }
    if (state.owed > 0) {
      state.owedTimer = setTimeout(() => { state.owedTimer = null; state.owed = 0; }, OWED_GRACE_MS);
      if (typeof state.owedTimer.unref === 'function') state.owedTimer.unref();
    }
  }

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
        if (op.busy) state.suggestion = null;
        noteTurnEdge(op.busy);
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
        // Either edge ends a held prompt's flight: it started, or the turn it would have started is over.
        state.heldInFlight = false;
        // A paused queue that has run empty has nothing left to pause.
        if (!op.busy && !state.held.length && state.heldPaused) { state.heldPaused = false; tellHeld(); }
        if (!op.busy) { followIdentity(); followContext(); flushHeld(); }
        return;
      case 'suggestion':
        // A next prompt the runtime proposes (#693). Kept until a turn starts, so a view mounted meanwhile
        // offers it too.
        state.suggestion = typeof op.text === 'string' ? op.text : null;
        flushPartial();
        sendOp(state, op);
        return;
      case 'mode':
        // The permission mode the runtime is in now (#696) — kept for a view that mounts later.
        state.mode = op.mode || null;
        flushPartial();
        sendOp(state, op);
        return;
      case 'tasks':
        // What runs in the background (#691): the view draws the list, and the main window's sidebar counts it
        // for a session whose view it may not hold.
        state.tasks = Array.isArray(op.tasks) ? op.tasks : [];
        flushPartial();
        sendOp(state, op);
        announceBackground(state);
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
      case 'branchTree':
        // The user asked for the session's branch tree (#646). Read over the protocol and handed to the view
        // as the backend's neutral rows; not awaited, like the figures.
        flushPartial();
        if (typeof rpc.treeCommand !== 'function' || typeof rpc.treeRows !== 'function') return;
        request(rpc.treeCommand).then((res) => {
          const tree = rpc.treeRows(res);
          if (!tree) { sendOp(state, { op: 'notice', level: 'warning', text: 'The session did not send its branch tree.' }); return; }
          sendOp(state, { op: 'branchTree', rows: tree.rows || [], truncated: !!tree.truncated });
        }).catch((err) => ctx.log.warn(`[agent-rpc] the branch tree was not read: ${err.message}`));
        return;
      case 'servers':
        // The user asked which MCP servers the session has (#719). Read over the protocol and handed to the view
        // as neutral rows, which it opens as a manager (#728) — asked again and acted on through `listServers`
        // and `serverAction`. Not awaited, like the figures, and nothing is appended: a list in the conversation
        // would be stale the moment a server moved.
        flushPartial();
        if (typeof rpc.serversCommand !== 'function' || typeof rpc.serverList !== 'function') return;
        readServers(state).then((list) => {
          if (!list) { sendOp(state, { op: 'notice', level: 'warning', text: 'The session did not list its MCP servers.' }); return; }
          sendOp(state, { op: 'servers', list });
        }).catch((err) => ctx.log.warn(`[agent-rpc] the MCP servers were not read: ${err.message}`));
        return;
      case 'navigated': {
        // A move this process asked for (`navigateBranch`) is done. Only ours: the token is what says so.
        // The leaf moving is not a turn, so nothing else in the stream would redraw the conversation — the
        // runtime's own snapshot is read again and replaces it, the way an attach does.
        if (!state.navigations.delete(op.token)) return;
        flushPartial();
        const notice = typeof rpc.navigatedNotice === 'function' ? rpc.navigatedNotice(op) : null;
        const tell = () => { if (notice && notice.text) sendOp(state, { op: 'notice', level: notice.level || 'info', text: notice.text }); };
        if (!op.ok || typeof rpc.messagesCommand !== 'function') { tell(); return; }
        request(rpc.messagesCommand).then((res) => {
          // Through `handleOp`, like every reset: an attach reading the transcript counts them.
          if (res && res.success !== false) handleOp({ op: 'reset', entries: rpc.entriesFromMessages(res) });
          else sendOp(state, { op: 'notice', level: 'warning', text: 'The session switched, but its conversation could not be read again. Reopen the tab to see it.' });
          // A user message the user picked comes back for editing, into the input (owner decision T8).
          if (op.draft) sendOp(state, { op: 'draft', text: op.draft });
          tell();
        }).catch((err) => ctx.log.warn(`[agent-rpc] the conversation was not read after a switch: ${err.message}`));
        return;
      }
      case 'answered':
        // The runtime stopped waiting on a question by itself (a login whose browser callback won). Only a
        // question still open is closed, and the session leaves "waiting" the way `answerAsk` lets it go.
        if (!state.asks.has(op.id)) return;
        state.asks.delete(op.id);
        flushPartial();
        sendOp(state, op);
        if (!state.asks.size) report(state.busy ? 'busy' : 'idle');
        flushHeld();
        return;
      case 'identity':
        // The runtime announced the session it is on now. Nothing is drawn for it: the re-key tells the
        // renderer through the path every re-key takes.
        flushPartial();
        adoptIdentity(op.sessionId);
        return;
      case 'append': {
        flushPartial();
        // A backend that can name an entry has the name stamped on the op, so a view that took the entry from
        // a transcript snapshot can tell the op for it apart from a new one (see `attachFromTranscript`).
        const split = splitTaskOutput(op.entry);
        if (split) op = { ...op, entry: settleTaskOutput(state, split, statSizeSync(split.file)) };
        const key = typeof rpc.entryKey === 'function' && op.entry ? rpc.entryKey(op.entry) : null;
        if (key) {
          state.recentAppends.push(op.entry);
          if (state.recentAppends.length > RECENT_APPENDS_CAP) state.recentAppends.shift();
        }
        sendOp(state, key ? { ...op, key: String(key) } : op);
        // A finished entry inside a turn is where the context has grown (#697).
        if (state.busy) followContextSoon();
        return;
      }
      case 'reset':
        // The whole conversation was replaced; what was kept for an attach describes the old one, and an
        // attach reading the file right now has to know its read may predate this.
        state.recentAppends = [];
        state.resets += 1;
        flushPartial();
        sendOp(state, op);
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
  // Measured (#707): every line of a turn is parsed and translated here, on main.
  child.stdout.on('data', measured('agent-rpc:output', (chunk) => {
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
      // Is this line the answer to a request of ours? Only the backend can tell: every runtime spells a
      // response and the id it carries its own way. `payload` is what the waiting caller receives, and it
      // carries `success: false` with an `error` when the runtime refused.
      let answer = null;
      try { answer = rpc.responseOf(msg); } catch (err) { ctx.log.warn(`[agent-rpc] response check failed: ${err.message}`); }
      if (answer) {
        state.answered = true;
        const waiting = answer.id != null ? state.pending.get(String(answer.id)) : null;
        if (waiting) {
          clearTimeout(waiting.timer);
          state.pending.delete(String(answer.id));
          // The op number at the moment the answer ARRIVED, not when its reader resumes: the rest of this
          // chunk is parsed and sent before the awaiting code runs, and those ops are newer than the answer.
          flushPartial();
          waiting.resolve({ ...(answer.payload || {}), _seq: state.seq });
        }
        continue;
      }
      let ops = [];
      try { ops = state.decoder.decode(msg) || []; } catch (err) { ctx.log.warn(`[agent-rpc] decode failed: ${err.message}`); }
      for (const op of ops) handleOp(op);
    }
  }));

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
    if (state.contextTimer) { clearTimeout(state.contextTimer); state.contextTimer = null; }
    dropAsks();
    // Held prompts never reached the runtime: each goes back to the input rather than vanishing with the process.
    // With their images, through the view's own take-back — they were never offered to the session, so the
    // "did not take this message" of an `unsent` would be the wrong sentence.
    const back = state.held.splice(0).map(h => ({ text: h.text, images: h.images || [] }));
    state.heldPaused = false;
    state.heldInFlight = false;
    if (back.length) sendOp(state, { op: 'held-back', items: back });
    sendOp(state, { op: 'held', items: [], paused: false });
    // A background task does not outlive the process that ran it; the sidebar stops counting it (#691).
    if (state.tasks.length) { state.tasks = []; announceBackground(state); }
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

  // A runtime that ACKNOWLEDGES a turn answers its line like any request, and a refusal comes back as one.
  // One that does not (`sendAcknowledged: false`) never answers a turn line at all, so waiting for an answer
  // would time every turn out as "no answer" while the runtime works on it. There the write IS the send,
  // and — since nothing in such a stream says a turn began — the write is also the moment the session turns
  // busy. A line written while a turn runs (a steer, a follow-up) changes nothing about that.
  function send({ text, mode, images }) {
    if (rpc.sendAcknowledged === false) {
      const wasBusy = state.busy;
      if (!write(rpc.sendCommand({ id: crypto.randomUUID(), text, mode, busy: wasBusy, images }))) {
        return Promise.resolve({ success: false, error: 'not running' });
      }
      // A turn line written while one runs is a turn the runtime now owes (`turnQueueOf`). A steer is not:
      // it goes into the running turn and starts none of its own.
      if (wasBusy && mode !== 'steer') state.owed += 1;
      if (!wasBusy) handleOp({ op: 'busy', busy: true });
      return Promise.resolve({ success: true });
    }
    return request((id) => rpc.sendCommand({ id, text, mode, busy: state.busy, images }));
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

  // THE HELD QUEUE (#702). A prompt sent while a turn runs is kept here instead of in the runtime's own queue,
  // because once it is written it can be neither withdrawn nor edited. It goes out when the session is idle
  // again and no question is open — one at a time, each as a turn of its own, which is what the runtime's queue
  // did with it. A Stop pauses the queue (owner decision): the user stopped to look, so nothing starts by itself
  // until they send a held prompt or a new one. What the view draws comes from here, so a view that mounts later
  // or in another window shows the same queue.
  function heldView() {
    return { items: state.held.map(h => ({ id: h.id, text: h.text, images: h.images ? h.images.length : 0 })), paused: state.heldPaused };
  }
  function tellHeld() { sendOp(state, { op: 'held', ...heldView() }); }
  //
  // Three guards beyond "idle, not paused, no question open":
  //   - one in flight at a time (`heldInFlight`): a runtime that acknowledges its turns turns busy only when
  //     the turn starts, and until then a second flush would send the next prompt into a running turn, which
  //     Pi refuses. Cleared by the next busy edge, or by the answer when it is a refusal.
  //   - not while the runtime still owes a turn the core wrote as keys (`owed`, a trigger or a launcher): that
  //     line runs first, and a flush on top would be counted against it.
  //   - a refusal puts the prompt back at the head, images and all, and PAUSES the queue, so send now appears
  //     instead of the rest sitting there with nothing to move them.
  function flushHeld() {
    if (state.exited || state.busy || state.heldPaused || state.heldInFlight || state.asks.size || !state.held.length) return;
    if (rpc.sendAcknowledged === false && state.owed > 0) return;
    const item = state.held.shift();
    state.heldInFlight = true;
    tellHeld();
    send(item.images ? { text: item.text, mode: 'prompt', images: item.images } : { text: item.text, mode: 'prompt' }).then((res) => {
      if (state.exited || (res && res.success !== false)) return;
      // Not an answer that says no: the line is in the pipe and runs once it is read (see handBackIfRefused).
      if (res && (res.error === 'not started' || res.error === 'no answer')) return;
      state.heldInFlight = false;
      state.held.unshift(item);
      state.heldPaused = true;
      tellHeld();
      sendOp(state, { op: 'notice', level: 'error', text: 'The session did not take a queued prompt. It is back at the head of the queue, paused.' });
    });
  }
  state.heldView = heldView;
  state.tellHeld = tellHeld;
  state.flushHeld = flushHeld;

  // Stopping takes the process TREE on Windows. Pi runs its tools as children of its own, and a plain kill
  // of the node process leaves a running `bash` behind with nobody to answer it.
  //
  // A backend whose runtime still has something to write when it is told to stop — a transcript it flushes
  // on the way out — declares `gracefulStopMs`: the first stop closes stdin and waits that long for the
  // child to leave by itself, then takes the tree. A second stop while it waits (the quit path's deadline, a
  // user pressing Stop again) does not wait again. A backend that declares nothing is stopped at once, which
  // is what every stop did before.
  //
  // A child that DOES leave by itself during the wait may leave a tool it started still running. Off
  // Windows the process group it was started in is signalled after it went, so that tool goes with it. On
  // Windows there is no such group: `taskkill /T` walks the tree from a pid that no longer exists, so a
  // runtime that orphans its own tools on the way out keeps them. The quit path's own deadline
  // (`session-shutdown.js`) is no help there either, for the same reason.
  function kill() {
    if (state.exited) return;
    const graceMs = Number(rpc.gracefulStopMs) > 0 ? Number(rpc.gracefulStopMs) : 0;
    if (graceMs && !state.stopping) {
      state.stopping = true;
      try { child.stdin.end(); } catch { /* already closed */ }
      const timer = setTimeout(treeKill, graceMs);
      if (typeof timer.unref === 'function') timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        if (process.platform !== 'win32' && child.pid) {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { /* the group is already gone */ }
        }
      });
      return;
    }
    treeKill();
  }

  function treeKill() {
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
  followContext();

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

/**
 * Does this session still owe a turn? `{ queued, turnStarted }` in the turn-hold's shape (#495), or null when
 * this module cannot tell — a session it is not running, or a runtime that acknowledges its turn lines and
 * reports its own queue through the row's backend instead.
 *
 * Asked for a runtime that answers no turn line (`sendAcknowledged: false`). Such a runtime ends one turn and
 * starts the next with nothing in between, and its transcript cannot be asked either: Claude Code keeps a
 * line queued with `priority: 'later'` in memory and writes its `enqueue` only as the turn before it ends
 * (measured) — after the "finished" this answer exists to hold. What it CAN count is what the core wrote.
 *
 * Prompts held here (#702) are owed turns too, for either kind of runtime: the idle edge that ends a turn is
 * the moment the next one is written, so a "finished" announced then would be wrong a moment later. A paused
 * queue owes nothing — it waits for the user.
 */
function turnQueueOf(sessionId, sinceMs = 0) {
  const state = stateFor(sessionId);
  if (!state) return null;
  const held = state.heldPaused ? 0 : state.held.length;
  if (state.rpc.sendAcknowledged !== false) {
    return held ? { queued: held, turnStarted: sinceMs > 0 && state.turnStartedAt > sinceMs } : null;
  }
  return { queued: state.owed + held, turnStarted: sinceMs > 0 && state.turnStartedAt > sinceMs };
}

// --- IPC ---

// What a view needs to draw a session it has just mounted: the conversation so far, the turn being
// streamed, whether it is working, what is queued, and any question still open. The transcript is the
// truth — there is no second log here to fall out of step.
//
// Where the conversation so far comes from is the backend's. A runtime that can be ASKED for it
// (`messagesCommand` + `entriesFromMessages`) answers from what it holds. One that cannot has its
// conversation read from its own transcript file instead (`entriesFromTranscript`, see below).
async function attach(sessionId) {
  const state = stateFor(sessionId);
  if (!state) return { ok: false, error: 'This session is not running.' };
  if (typeof state.rpc.messagesCommand !== 'function' || typeof state.rpc.entriesFromMessages !== 'function') {
    return attachFromTranscript(sessionId, state);
  }
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
    held: state.heldView(),
    asks: [...state.asks.values()],
    tasks: state.tasks,
    context: state.context,
    suggestion: state.suggestion,
    mode: state.mode,
    canSwitchMode: canSwitchMode(state),
  };
}

// The conversation of a runtime that cannot be asked for it, read from the transcript the runtime writes.
// The backend reads its own file (`entriesFromTranscript({ sessionId, cwd, forkFrom })`, sync or a Promise):
// which file and what is in it are its format, and this process names none. `forkFrom` is the session a fork
// was started from, for a runtime that writes a fork's file only with its first turn.
//
// THE SEQUENCE CONTRACT. The view replays every op newer than the `seq` an attach answers and nothing older
// (see `sendOp`). A snapshot taken from a FILE is not taken at one moment the way a runtime's answer is: the
// runtime writes an entry to its file and to the pipe separately, so the file can be behind the ops already
// sent, or ahead of them. Both directions are answered, and both need the backend's `entryKey`:
//
//   - BEHIND. The number is taken AFTER the read, so everything sent before it is the snapshot's business,
//     and the entries sent recently that the file does not have yet are added from `recentAppends`. They go
//     at the end, in the order they were sent — the file's own order is not known for an entry it lacks.
//   - AHEAD. An entry the file already has may still be in the pipe; its op then arrives with a number past
//     the snapshot's and would be drawn a second time. So the snapshot answers the `keys` it holds, every
//     `append` op carries its `key`, and the view skips an op for an entry it already has.
//
// A backend without `entryKey` gets the file alone: without a key there is no telling a repeat from a new
// entry. An entry the runtime sends but never writes to its file (a reply the CLI makes up itself) is added
// from `recentAppends` on every attach while it is among the last ones sent, and is gone after that.
//
// A `reset` while the file is being read replaces the conversation the read may describe, and its own op
// would be at or below the number taken after it — never replayed. The read is then done again, once; a
// session that keeps being replaced during two reads answers a refusal rather than a stale conversation.
//
// No startup wait: nothing is asked of the runtime, and a session that has not written its file yet has an
// empty conversation, which is the truth about it.
async function attachFromTranscript(sessionId, state) {
  const rpc = state.rpc;
  if (typeof rpc.entriesFromTranscript !== 'function') {
    return { ok: false, error: 'This session cannot load its conversation.' };
  }
  let entries;
  let settled = false;
  for (let attempt = 0; attempt < 2 && !settled; attempt++) {
    const resetsBefore = state.resets;
    try {
      entries = await rpc.entriesFromTranscript({ sessionId, cwd: state.cwd, forkFrom: state.forkFrom });
    } catch (err) {
      ctx.log.info(`[agent-rpc] attach ${sessionId}: the transcript was not read (${err.code || err.message})`);
      return { ok: false, error: 'The session could not load its conversation.' };
    }
    // A task notice read back names its output file; whether there is output to offer is decided here, the
    // files stat'ed in parallel rather than one after another on the main thread (#725). Inside the read, so a
    // reset while they are asked is caught by the same check as one during the read.
    entries = await Promise.all((Array.isArray(entries) ? entries : []).map(async (e) => {
      const split = splitTaskOutput(e);
      return split ? settleTaskOutput(state, split, await statSize(split.file)) : e;
    }));
    settled = state.resets === resetsBefore;
  }
  if (state.exited) return { ok: false, error: 'This session is not running.' };
  if (!settled) return { ok: false, error: 'The session changed while its conversation was loaded. Reopen the tab to see it.' };
  const out = entries.slice();
  const seq = state.seq;
  // `keys` names only what came out of the FILE: an entry added from `recentAppends` was sent before the
  // number was taken, so its op is never replayed and there is nothing for the view to skip. A key the view
  // holds for nothing would only wait there to swallow a later entry of a runtime that reuses keys.
  const keys = [];
  if (typeof rpc.entryKey === 'function') {
    const seen = new Set();
    for (const e of out) { const k = rpc.entryKey(e); if (k) { seen.add(String(k)); keys.push(String(k)); } }
    for (const e of state.recentAppends) {
      const k = rpc.entryKey(e);
      if (k && !seen.has(String(k))) { out.push(e); seen.add(String(k)); }
    }
  }
  return {
    ok: true,
    seq,
    keys,
    entries: out,
    partial: state.decoder.currentPartial(),
    busy: state.busy,
    queue: state.queue,
    held: state.heldView(),
    asks: [...state.asks.values()],
    tasks: state.tasks,
    context: state.context,
    suggestion: state.suggestion,
    mode: state.mode,
    canSwitchMode: canSwitchMode(state),
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

// The images a turn carries (#662), checked against what the runtime declared it takes (`rpc.imageInput`:
// `{ types, maxBytes }`). The view checks the same declaration before it attaches anything; this is the
// check that holds whoever sends. Answers the images to send, or a sentence saying why not.
function imagesFor(rpc, raw) {
  if (raw == null) return { images: [] };
  if (!Array.isArray(raw)) return { error: 'The images could not be read.' };
  if (!raw.length) return { images: [] };
  const accepts = rpc.imageInput && typeof rpc.imageInput === 'object' ? rpc.imageInput : null;
  if (!accepts) return { error: 'This session does not take images.' };
  const types = new Set(Array.isArray(accepts.types) ? accepts.types : []);
  const images = [];
  for (const img of raw) {
    const mimeType = img && typeof img.mimeType === 'string' ? img.mimeType : '';
    const data = img && typeof img.data === 'string' ? img.data : '';
    if (!types.has(mimeType)) return { error: 'This session does not take that kind of image.' };
    if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { error: 'The images could not be read.' };
    // Counted on the ENCODED size, the stricter of the two readings: whether the API's limit counts the
    // file or its base64 text is not measured, and the stricter one cannot let through an image that the
    // API then refuses. The view counts the same way.
    if (data.length > Number(accepts.maxBytes || 0)) return { error: 'An image is too large for this session.' };
    images.push({ mimeType, data });
  }
  return { images };
}

async function sendTurn(sessionId, payload) {
  const state = stateFor(sessionId);
  if (!state) return { ok: false, error: 'This session is not running.' };
  const text = String((payload && payload.text) || '');
  const checked = imagesFor(state.rpc, payload && payload.images);
  if (checked.error) return { ok: false, error: checked.error };
  const { images } = checked;
  if (!text.trim() && !images.length) return { ok: false, error: 'Nothing to send.' };
  const mode = SEND_MODES.has(payload && payload.mode) ? payload.mode : 'prompt';
  // A command the app answers itself (#719) goes nowhere near the runtime, busy or not.
  const own = !images.length && typeof state.rpc.appCommandOp === 'function' ? state.rpc.appCommandOp(text) : null;
  if (own && typeof own.op === 'string') {
    state.answerInApp(text, own);
    return { ok: true };
  }
  // A prompt while a turn runs is held (#702) — and so is one behind prompts already waiting, so they keep their
  // order. A queue paused by a Stop does not hold a new one: sending while idle means "now". A shell line is not
  // a turn and runs beside one, so it is never held.
  if (mode === 'prompt' && !/^\s*!/.test(text) && (state.busy || (state.held.length && !state.heldPaused))) {
    const item = { id: crypto.randomUUID(), text, images: images.length ? images : null, at: Date.now() };
    state.held.push(item);
    state.tellHeld();
    state.flushHeld();
    return { ok: true, held: item.id };
  }
  if (text.trim()) state.noteComposerLine(text);
  const res = await state.send(images.length ? { text, mode, images } : { text, mode });
  // A runtime's refusal is its own sentence about the request (Pi's "Agent is streaming…"), not a thrown
  // error that could carry a path, so it is passed on.
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
  // A Stop pauses the held prompts (#702, owner decision): they stay, and wait for the user. Set BEFORE the
  // abort goes out — a runtime can settle the run before it answers the abort (Pi's does), and that idle edge
  // would otherwise send the first held prompt on the very Stop meant to hold it. Also while the queue is
  // still empty but a turn runs, so a prompt queued between the Stop and the turn's end waits too.
  const pausedBefore = state.heldPaused;
  if (state.held.length || state.busy) { state.heldPaused = true; state.tellHeld(); }
  const answers = [];
  if (stopsLine) answers.push(await state.request(state.rpc.shellAbortCommand));
  if (state.busy || !stopsLine) answers.push(await state.request(state.rpc.abortCommand));
  const failed = answers.find(res => !res || res.success === false);
  if (failed && !pausedBefore) { state.heldPaused = false; state.tellHeld(); state.flushHeld(); }
  return failed ? { ok: false, error: 'The session did not stop.' } : { ok: true };
}

// A held prompt (#702): `withdraw` takes it out and hands its text and images back — for the view's edit, or
// just to drop it — and `send` puts it first and lets the queue run again, at once when the session is idle.
function heldAction(sessionId, action, id) {
  const state = stateFor(sessionId);
  if (!state) return { ok: false, error: 'This session is not running.' };
  const i = state.held.findIndex(h => h.id === String(id || ''));
  if (i < 0) return { ok: false, error: 'That prompt has already been sent.' };
  if (action === 'withdraw') {
    const [item] = state.held.splice(i, 1);
    if (!state.held.length) state.heldPaused = false;
    state.tellHeld();
    return { ok: true, text: item.text, images: item.images || [] };
  }
  if (action === 'send') {
    const [item] = state.held.splice(i, 1);
    state.held.unshift(item);
    state.heldPaused = false;
    state.tellHeld();
    state.flushHeld();
    return { ok: true };
  }
  return { ok: false, error: 'Unknown action.' };
}

// --- the branch tree (#646) ---

// Move the session to another point in its tree. The runtime does the move; this process only asks, and
// hears back through a `navigated` op carrying the same token. Refused while a turn runs — the backend's
// command refuses it too, and saying so here spares a round trip that ends in the same sentence.
const TARGET_CAP = 256;
async function navigateBranch(sessionId, target, options) {
  const state = stateFor(sessionId);
  if (!state) return { ok: false, error: 'This session is not running.' };
  if (typeof state.rpc.navigateCommand !== 'function') return { ok: false, error: 'This session cannot switch branches.' };
  const id = String(target == null ? '' : target);
  if (!id || id.length > TARGET_CAP) return { ok: false, error: 'No point in the session was picked.' };
  if (state.busy) return { ok: false, error: 'Wait for the current turn to finish before switching branches.' };
  const summarize = !!(options && options.summarize === true);
  const token = crypto.randomUUID();
  if (state.navigations.size > 8) state.navigations.clear();   // a bound: each is answered within a turn
  state.navigations.add(token);
  // A summary is a model call and can take a while; the notice is the first frame of it.
  if (summarize) sendOp(state, { op: 'notice', level: 'info', text: 'Summarising the branch you are leaving…' });
  const res = await state.request((rid) => state.rpc.navigateCommand(rid, { target: id, summarize, token }));
  if (!res || res.success === false) {
    state.navigations.delete(token);
    return { ok: false, error: 'The session did not take the switch.' };
  }
  return { ok: true };
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
  // The question itself goes to the backend with the answer: a runtime may want part of its own request
  // back (an approval that echoes the input it was asked about).
  const asked = state.asks.get(id);
  state.asks.delete(id);
  const ok = state.write(state.rpc.answerCommand(id, answer || { cancelled: true }, asked));
  if (ok) sendOp(state, { op: 'answered', id });
  // The question ended the busy state (a session waiting on the user is not working); answering it inside
  // a run hands the session back to the agent, and nothing else would say so until the run settles. A
  // question asked outside a run (an extension's own command) leaves the session idle once answered.
  if (ok && !state.asks.size) state.report(state.busy ? 'busy' : 'idle');
  // A question answered while idle may have been all that held the queue back (#702).
  if (ok) state.flushHeld();
  return ok ? { ok: true } : { ok: false, error: 'The session is not running.' };
}

// --- the permission mode (#696) ---

// Whether this session's mode can be switched from the view: the half declares the order, the request and the
// words. Pi has no such modes and declares none, so its view shows and changes nothing.
function canSwitchMode(state) {
  const rpc = state.rpc;
  return Array.isArray(rpc.modeCycle) && rpc.modeCycle.length > 1
    && typeof rpc.setModeCommand === 'function' && typeof rpc.modeInfo === 'function';
}

// The next mode in the backend's order. A mode the runtime refuses — one this session cannot enter — is
// skipped and the one after it is tried, so what is available is the runtime's answer, not a guess here. A
// mode outside the order (or none heard yet) counts as its first. The change is the SESSION's: nothing is
// written to the backend's stored option, and the next launch starts where that option says.
async function cycleMode(sessionId) {
  const state = stateFor(sessionId);
  if (!state) return { ok: false, error: 'This session is not running.' };
  if (!canSwitchMode(state)) return { ok: false, error: 'This session has no permission modes to switch.' };
  const cycle = state.rpc.modeCycle;
  // None heard yet counts as the first mode; a mode outside the order (one only a launch can set) goes to the
  // first mode next, as the TUI's cycle does.
  const current = (state.mode && state.mode.id) || cycle[0];
  const at = cycle.indexOf(current);
  const order = at < 0 ? cycle.slice() : cycle.slice(at + 1).concat(cycle.slice(0, at));
  for (const next of order) {
    const res = await state.request((rid) => state.rpc.setModeCommand(rid, next));
    if (!res || res.success === false) {
      ctx.log.info(`[agent-rpc] permission mode ${next} refused: ${(res && res.error) || 'no answer'}`);
      continue;
    }
    // The runtime also announces the change on its stream; this makes the view right even if that line is late.
    const mode = state.rpc.modeInfo(next);
    state.mode = mode;
    sendOp(state, { op: 'mode', mode });
    return { ok: true, mode };
  }
  return { ok: false, error: 'No other permission mode is available in this session.' };
}

// --- background tasks (#691) ---

// Stop one background task and leave the turn and the other tasks alone. A backend that cannot stop a single
// task declares no `stopTaskCommand`, and the view offers no Stop for it.
async function stopTask(sessionId, taskId) {
  const state = stateFor(sessionId);
  if (!state) return { ok: false, error: 'This session is not running.' };
  if (typeof state.rpc.stopTaskCommand !== 'function') return { ok: false, error: 'This session cannot stop a single task.' };
  const id = String(taskId || '');
  if (!id) return { ok: false, error: 'No task was named.' };
  const res = await state.request((rid) => state.rpc.stopTaskCommand(rid, id));
  return res && res.success !== false ? { ok: true } : { ok: false, error: 'The task did not stop.' };
}

// How much of a task's output the view is handed: the END of it, which is what a running command is judged by.
const TASK_OUTPUT_TAIL = 64 * 1024;

// A task notice whose backend named its output file (`_task.outputFile`, #725): the entry without the path, and
// the path if it is one this process will read — absolute and ending `.output`, the only shape a runtime has
// named. The path can come from a transcript on disk now, not only from the runtime's own stream, so its
// shape is checked rather than trusted — and a network path is refused outright: a stat of `\\host\share\…`
// reaches out to that host (and hands it a Windows login) before it answers. Null for any other entry.
function splitTaskOutput(entry) {
  if (!entry || entry.type !== 'task-notice' || !entry._task || !('outputFile' in entry._task)) return null;
  const { outputFile, ...task } = entry._task;
  const local = typeof outputFile === 'string' && path.isAbsolute(outputFile) && !/^[\\/]{2}/.test(outputFile);
  const file = local && outputFile.endsWith('.output') ? outputFile : null;
  return { entry: { ...entry, _task: task }, file };
}

// The view offers Output only where there is some: a file that exists and is not empty. That is decided when the
// card is drawn; a file removed afterwards is answered by `taskOutput` in the card.
function settleTaskOutput(state, split, size) {
  const id = String(split.entry._task.id || '');
  const hasOutput = !!id && !!split.file && size > 0;
  if (hasOutput) state.taskFiles.set(id, split.file);
  split.entry._task.hasOutput = hasOutput;
  return split.entry;
}

// One stat for a live notice, so its op stays in order with the ones after it; an attach stats in parallel.
function statSizeSync(file) {
  if (!file) return 0;
  try { return fs.statSync(file).size; } catch { return 0; }
}
async function statSize(file) {
  if (!file) return 0;
  try { return (await fs.promises.stat(file)).size; } catch { return 0; }
}

// A task's output, read from the file its runtime named for THAT task — in a notice drawn in this process, read
// back from the transcript by an attach (#725), or heard on the stream while the task runs. The renderer names a
// task, never a path, so this reads no file the runtime did not point at. The path itself is not handed back:
// it sits under the user's temporary directory, and the view only needs the text.
async function taskOutput(sessionId, taskId) {
  const state = stateFor(sessionId);
  if (!state) return { ok: false, error: 'This session is not running.' };
  const id = String(taskId || '');
  const file = state.taskFiles.get(id)
    || (typeof state.decoder.taskOutputFile === 'function' ? state.decoder.taskOutputFile(id) : null);
  if (!file || !path.isAbsolute(file)) return { ok: false, error: 'This task has no output to show.' };
  let handle = null;
  try {
    handle = await fs.promises.open(file, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - TASK_OUTPUT_TAIL);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    return { ok: true, text: buf.toString('utf8'), truncated: start > 0 };
  } catch (err) {
    ctx.log.info(`[agent-rpc] task output not readable: ${err.code || err.message}`);
    return { ok: false, error: err && err.code === 'ENOENT' ? 'The output file is gone.' : 'The output could not be read.' };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

// --- the session's MCP servers (#719, #728) ---

// The backend's rows for the servers, or null when the runtime gave no list.
async function readServers(state) {
  const res = await state.request(state.rpc.serversCommand);
  try { return state.rpc.serverList(res); } catch { return null; }
}

async function listServers(sessionId) {
  const state = stateFor(sessionId);
  if (!state) return { ok: false, error: 'This session is not running.' };
  if (typeof state.rpc.serversCommand !== 'function' || typeof state.rpc.serverList !== 'function') {
    return { ok: false, error: 'This session cannot list its servers.' };
  }
  const list = await readServers(state);
  return list ? { ok: true, list } : { ok: false, error: 'The session did not list its MCP servers.' };
}

// A reconnect waits for the server to come up, and a slow one takes longer than an ordinary request is given.
const SERVER_ACTION_TIMEOUT_MS = 60000;

// One action on one server, in the backend's own vocabulary (`actions` on its rows). The backend builds the
// request and words the answer; an action it does not know builds nothing and is refused here. What the answer
// says goes back as it is, including a sign-in page to open — the view opens it, as it opens any link.
async function serverAction(sessionId, name, action, extra) {
  const state = stateFor(sessionId);
  if (!state) return { ok: false, error: 'This session is not running.' };
  const rpc = state.rpc;
  if (typeof rpc.serverActionCommand !== 'function' || typeof rpc.serverActionResult !== 'function') {
    return { ok: false, error: 'This session cannot manage its servers.' };
  }
  const server = typeof name === 'string' ? name : '';
  const what = typeof action === 'string' ? action : '';
  if (!server || !what) return { ok: false, error: 'No server or action was named.' };
  const opts = extra && typeof extra === 'object' ? extra : {};
  let line = null;
  try { line = rpc.serverActionCommand('probe', server, what, opts); } catch { line = null; }
  if (!line) return { ok: false, error: 'This session cannot do that to a server.' };
  const res = await state.request((rid) => rpc.serverActionCommand(rid, server, what, opts), { timeoutMs: SERVER_ACTION_TIMEOUT_MS });
  ctx.log.info(`[agent-rpc] server ${what} on a session's MCP server: ${res && res.success !== false ? 'done' : 'refused'}`);
  let out;
  try { out = rpc.serverActionResult(res); } catch { out = null; }
  return out && typeof out === 'object' ? out : { ok: false, error: 'The session did not answer.' };
}

/** @param {Electron.IpcMain} ipc */
function registerIpc(ipc) {
  ipc.handle('agent-servers', (_event, sessionId) => listServers(sessionId));
  ipc.handle('agent-server-action', (_event, sessionId, name, action, extra) => serverAction(sessionId, name, action, extra));
  ipc.handle('agent-stop-task', (_event, sessionId, taskId) => stopTask(sessionId, taskId));
  ipc.handle('agent-cycle-mode', (_event, sessionId) => cycleMode(sessionId));
  ipc.handle('agent-task-output', (_event, sessionId, taskId) => taskOutput(sessionId, taskId));
  ipc.handle('agent-attach', (_event, sessionId) => attach(sessionId));
  ipc.handle('agent-send', (_event, sessionId, payload) => sendTurn(sessionId, payload));
  ipc.handle('agent-abort', (_event, sessionId) => abortTurn(sessionId));
  ipc.handle('agent-held', (_event, sessionId, action, id) => heldAction(sessionId, action, id));
  ipc.handle('agent-answer', (_event, sessionId, requestId, answer) => answerAsk(sessionId, requestId, answer));
  ipc.handle('agent-commands', (_event, sessionId) => listCommands(sessionId));
  ipc.handle('agent-arguments', (_event, sessionId, command) => completeArguments(sessionId, command));
  ipc.handle('agent-paths', (_event, sessionId, prefix) => completeSessionPaths(sessionId, prefix));
  ipc.handle('agent-navigate', (_event, sessionId, target, options) => navigateBranch(sessionId, target, options));
}

module.exports = {
  init, registerIpc, start,
  // The turn-hold's question about a session this module drives (main.js wires it in front of the descriptor).
  turnQueueOf,
  // For the tests, which drive a fake child through the same functions the IPC calls.
  attach, sendTurn, abortTurn, answerAsk, listCommands, completeArguments, completeSessionPaths, navigateBranch,
  stopTask, taskOutput, cycleMode, heldAction, listServers, serverAction,
  PARTIAL_INTERVAL_MS, RESPONSE_TIMEOUT_MS, STARTUP_TIMEOUT_MS,
};
