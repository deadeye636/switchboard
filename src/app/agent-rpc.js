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
const { completePaths } = require('./path-completion');

let ctx = null;

/**
 * @param {object} context
 * @param {Map} context.activeSessions
 * @param {() => Electron.BrowserWindow|null} context.getMainWindow  a GETTER — see the ctx rule.
 * @param {(id: string) => Electron.BrowserWindow|null} [context.windowForSession]
 * @param {(tag: string, id: string) => object|null} context.adoptSessionId
 * @param {(sessionId: string, hook: object) => void} context.deliverBindSignal
 * @param {() => boolean} context.getAppQuitting
 * @param {object} context.log
 */
function init(context) {
  ctx = context;
}

// How long a request may wait for its response. `get_messages` on a long session is the slowest thing
// asked, and it is asked when a tab mounts — long enough not to fail a big transcript, short enough that a
// wedged child does not leave a view waiting forever.
const RESPONSE_TIMEOUT_MS = 20000;

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
function start({ tag, rpc, command, args, cwd, env, label }) {
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
    queue: { steering: [], followUp: [] },
    busy: false,
    typed: '',               // what `write()` has collected towards the next carriage return
    partialTimer: null,
    partialOp: null,
    stderrTail: '',
    exited: false,
    seq: 0,                  // the number of the last op sent — see sendOp
  };

  function flushPartial() {
    if (state.partialTimer) { clearTimeout(state.partialTimer); state.partialTimer = null; }
    if (state.partialOp) { const op = state.partialOp; state.partialOp = null; sendOp(state, op); }
  }

  function write(obj) {
    if (state.exited || !child.stdin || child.stdin.destroyed) return false;
    try { child.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; }
  }

  // One request, one response. Pi echoes the `id` it was given; a request whose response never comes is
  // answered with a refusal after RESPONSE_TIMEOUT_MS so nobody awaits it forever.
  function request(build) {
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        resolve({ success: false, error: 'no answer' });
      }, RESPONSE_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
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
        if (turn.trim()) send({ text: turn, mode: 'prompt' });
      } else {
        state.typed += ch;   // a pasted \r stays until the line endings are folded below
      }
    }
    state.typed = state.typed.replace(/\r\n?/g, '\n');
  }

  function send({ text, mode }) {
    return request((id) => rpc.sendCommand({ id, text, mode, busy: state.busy }));
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
  if (!res || res.success === false) return { ok: false, error: 'The session did not answer.' };
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

const SEND_MODES = new Set(['prompt', 'steer', 'follow_up']);

async function sendTurn(sessionId, payload) {
  const state = stateFor(sessionId);
  if (!state) return { ok: false, error: 'This session is not running.' };
  const text = String((payload && payload.text) || '');
  if (!text.trim()) return { ok: false, error: 'Nothing to send.' };
  const mode = SEND_MODES.has(payload && payload.mode) ? payload.mode : 'prompt';
  const res = await state.send({ text, mode });
  // Pi's refusal is its own sentence about the request ("Agent is streaming…"), not a thrown error that
  // could carry a path, so it is passed on.
  return res && res.success !== false ? { ok: true } : { ok: false, error: (res && res.error) || 'The session refused the message.' };
}

async function abortTurn(sessionId) {
  const state = stateFor(sessionId);
  if (!state) return { ok: false, error: 'This session is not running.' };
  const res = await state.request(state.rpc.abortCommand);
  return res && res.success !== false ? { ok: true } : { ok: false, error: 'The session did not stop.' };
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
  PARTIAL_INTERVAL_MS, RESPONSE_TIMEOUT_MS,
};
