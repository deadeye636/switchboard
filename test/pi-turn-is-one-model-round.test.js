'use strict';
// #573 — what a Pi tool round REACHES, end to end, rather than what the template looks like.
//
// `test/pi-live-binding.test.js` reads the generated extension as text, which is the right guard for a
// file nothing else executes. It cannot answer the question this issue opens with: a brief flicker of the
// busy indicator is one thing, an inbox entry per tool round is another. So this file RUNS the generated
// handlers, posts what they post through the real ingest (`src/app/hooks.js`), and reads the two surfaces
// a user actually sees — the session record behind the "while you were away" recap (`src/app/timeline.js`)
// and the renderer's own status/inbox state (`renderer/shell/attention-engine.js`).
//
// The replayed sequence is Pi 0.84.4's own, and the loop is not an inference: Pi's lifecycle diagram in
// `docs/extensions.md` brackets `turn_start` … `turn_end` with "repeats while LLM calls tools", and names
// the event a host is supposed to read instead — "Use `agent_settled` for status integrations that need to
// know Pi will not continue running automatically."
//
// RUNNING GENERATED TYPESCRIPT. The template is TypeScript because Pi loads it, so the few type-only
// pieces are removed by name below. Every removal must apply and the result must parse, so a template that
// grows syntax this does not know fails loudly here rather than quietly replaying nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const liveBinding = require('../src/backends/pi/live-binding');
const hooks = require('../src/app/hooks');
const timeline = require('../src/app/timeline');
const turnHold = require('../src/app/turn-hold');
const turnQueue = require('../src/backends/pi/turn-queue');
const { normalizeTimelineEvent, isDuplicateOf } = require('../src/db/timeline-record');

const TAG = 'terminal-tag-1';
const SESSION = '11111111-2222-4333-8444-555555555555';

// --- the generated extension, executed ----------------------------------------------------------------

// Type-only syntax, named one by one. A blanket "strip everything after a colon" would eat
// `body: JSON.stringify(...)` as readily as a parameter type.
const TYPE_ONLY = [
  [/^import type .*\n\n?/m, ''],
  [/\(ctx: any,/g, '(ctx,'],
  [/kind\?: "busy" \| "idle" \| "waiting"/g, 'kind'],
  [/promptKind\?: string/g, 'promptKind'],
  [/turnStart\?: boolean/g, 'turnStart'],
  [/\(event: any, ctx\)/g, '(event, ctx)'],
  [/export default function\(pi: ExtensionAPI\)/, 'globalThis.__piExtension = function(pi)'],
];

function loadExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-round-'));
  const written = liveBinding.writeBindingExtension({
    dir, tag: TAG, sessionUrl: hooks.sessionBindUrl(TAG),
  });
  let source = fs.readFileSync(written.cleanup, 'utf8');
  for (const [pattern, replacement] of TYPE_ONLY) {
    const next = source.replace(pattern, replacement);
    assert.notEqual(next, source, `the template no longer contains ${pattern} — this reader is stale`);
    source = next;
  }
  liveBinding.removeBindingExtension(written.cleanup);

  const handlers = new Map();
  const posted = [];
  const sandbox = {
    globalThis: null,
    fetch: async (_url, init) => { posted.push(JSON.parse(init.body)); },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // A parse error here is the second half of the guard above: a template shape this reader did not
  // recognise cannot silently replay nothing.
  new vm.Script(source, { filename: 'pi-live-<tag>.ts' }).runInContext(sandbox);
  sandbox.__piExtension({ on: (event, handler) => handlers.set(event, handler) });

  // The context Pi hands an extension, reduced to what this template asks it for.
  const ctx = {
    sessionManager: { getSessionId: () => SESSION },
    hasPendingMessages: () => false,
  };
  const emit = async (event, payload = {}) => {
    const handler = handlers.get(event);
    if (handler) await handler(payload, ctx);
  };
  return { emit, posted, subscribed: [...handlers.keys()] };
}

// --- the ingest, and the two surfaces behind it -------------------------------------------------------

let server = null;
async function ensureServer() {
  if (server && server.listening) return;
  server = hooks.startAttentionHookServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
}
test.after(() => new Promise((resolve) => (server ? server.close(resolve) : resolve())));

function postToIngest(url, payload, token) {
  const u = new URL(url);
  const req = { method: 'POST', url: u.pathname + u.search, _handlers: {}, on(ev, fn) { this._handlers[ev] = fn; } };
  hooks.handleHookRequest(req, { writeHead() {}, end() {} }, token);
  req._handlers.data?.(JSON.stringify(payload));
  req._handlers.end?.();
}

// The renderer, with the real engine loaded into a document. Only what the engine reads is provided; a
// name it reaches for that is not here throws, which is what keeps this from drifting into a stub.
function renderer() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only',
  });
  const { window } = dom;
  const context = dom.getInternalVMContext();
  Object.assign(window, {
    attentionSessions: new Set(),
    responseReadySessions: new Set(),
    sessionBusyState: new Map(),
    attentionReason: new Map(),
    finishedAt: new Map(),
  });
  // Nothing here is looking at the session — the flag, the ready class and the chime are all conditioned
  // on that, so a focused session would hide exactly the behaviour under test.
  window.activeSessionId = null;
  window.appGlobalSettings = { notifications: { sound: true } };
  window.refreshSessionStatusViews = () => {};
  window.getAllKnownSessionsForStatus = () => [];
  window.reduceAttention = (_prev, next) => next;
  window.shouldPlayAttentionSound = () => false;
  window.sessionRowEls = () => [];
  // Loaded, not stubbed: the engine reaches it on every needs-attention signal (#615).
  for (const file of ['terminal/terminal-attention-notice.js', 'shell/attention-engine.js']) {
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', ...file.split('/')), 'utf8'),
      context, { filename: file },
    );
  }
  return {
    window,
    onCliBusyState: (sessionId, busy, exact) => {
      // shell/session-ipc.js's whole handler.
      context.__id = sessionId; context.__busy = busy;
      vm.runInContext(exact ? 'setExactActivity(__id, __busy)' : 'setActivity(__id, __busy)', context);
    },
  };
}

// One replay: the generated handlers → the ingest → the record and the renderer.
async function replay(events) {
  // The record's own duplicate rule, with the events a second apart — which is what a tool round costs.
  // Recording everything would let a per-round entry hide behind a merge that cannot happen in a session.
  const written = [];
  let clock = Date.now();
  timeline.init({
    recordTimelineEvent: (input) => {
      const event = normalizeTimelineEvent(input, (clock += 1000));
      const previous = [...written].reverse().find((e) => e.kind === event.kind);
      if (isDuplicateOf(event, previous)) return null;
      written.push(event);
      return event;
    },
    log: { debug() {}, warn() {} },
  });

  hooks.init({
    getMainWindow: () => null,
    getSetting: () => ({}),
    activeSessions: new Map(),
    indexWorker: { postFile() {} },
    isPackaged: true,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    adoptSessionId: () => null,
    sendTimelineSignal: (sessionId, signal) => timeline.recordSignal(sessionId, signal),
  });
  // After `init`, because the server's own listening handler reports through `ctx.log`.
  await ensureServer();
  const ext = loadExtension();
  const view = renderer();

  const url = hooks.sessionBindUrl(TAG);
  const token = new URL(url).searchParams.get('t');
  const posted = [];
  for (const [event, payload] of events) {
    ext.posted.length = 0;
    await ext.emit(event, payload);
    for (const body of ext.posted) {
      posted.push([event, body.kind]);
      postToIngest(url, body, token);
      // The ingest sends `cli-busy-state` to the main window; with no window there is nothing to capture,
      // so the same decision is made here and handed to the renderer. It is the ingest's own line.
      const signal = require('../src/shared/attention-source')
        .classifyAttentionSignal({ source: 'bind', payload: body });
      if (signal) {
        const busy = typeof signal.busy === 'boolean' ? signal.busy : signal.kind === 'busy';
        view.onCliBusyState(SESSION, busy, true);
      }
    }
  }
  return { written, view, ext, posted };
}

const kinds = (written) => written.map((e) => e.kind);

// One prompt that makes the agent call a single tool: two model rounds, one piece of work.
const ONE_TOOL_CALL = [
  ['turn_start', {}],
  ['turn_end', {}],
  ['turn_start', {}],
  ['turn_end', {}],
  ['agent_settled', {}],
];

test('a prompt that calls a tool is ONE turn in the record, not one per model round (#573)', async () => {
  const { written } = await replay(ONE_TOOL_CALL);
  assert.deepEqual(kinds(written), ['busy', 'idle', 'response-ready'],
    'the recap lists "Ready for review" once per piece of work, not once per tool the agent used');
});

test('the row does not go Ready between two model rounds (#573)', async () => {
  // Stopped at the FIRST round ending, which is the moment the user sees. Replaying past it would let the
  // next round's `busy` clear a "Ready" that was shown — the flicker is the finding, not the end state.
  const { view } = await replay(ONE_TOOL_CALL.slice(0, 2));
  assert.equal(view.window.sessionBusyState.get(SESSION), true, 'the session is still working');
  assert.equal(view.window.responseReadySessions.has(SESSION), false,
    'a tool round is not a turn ending, so nothing is waiting to be read');
  assert.equal(view.window.finishedAt.has(SESSION), false,
    'and no finish is stamped — the running-inbox reads that stamp');
});

test('the run settling still ends the turn on both surfaces', async () => {
  const { written, view } = await replay(ONE_TOOL_CALL);
  assert.deepEqual(kinds(written).slice(-2), ['idle', 'response-ready']);
  assert.equal(view.window.sessionBusyState.get(SESSION), false);
  assert.equal(view.window.responseReadySessions.has(SESSION), true,
    'an unfocused session whose work is over is ready for review');
});

test('a UI prompt answered between two model rounds returns the agent to work (#529 through #573)', async () => {
  // `ui_prompt_end` reports whichever state the prompt interrupted. Tracking the model ROUND rather than
  // the run would answer `idle` here — the same wrong statement by another door, and one this issue's fix
  // would not have covered.
  //
  // The waiting prompt itself DOES end the busy state, and that is #529 working: a CLI blocked on a
  // question has stopped working, and the row says so while the inbox raises it.
  const { posted, view } = await replay([
    ['turn_start', {}],
    ['turn_end', {}],
    ['ui_prompt_start', { kind: 'confirm' }],
    ['ui_prompt_end', {}],
  ]);
  assert.deepEqual(posted, [
    ['turn_start', 'busy'],
    ['ui_prompt_start', 'waiting'],
    ['ui_prompt_end', 'busy'],
  ], 'the round ending states nothing, and answering the question puts the agent back to work');
  assert.equal(view.window.sessionBusyState.get(SESSION), true);
  assert.equal(view.window.responseReadySessions.has(SESSION), false,
    'the answered question is not a finished piece of work');
});

test('the extension subscribes to no event that reports a model round ending', async () => {
  const { ext } = await replay([]);
  assert.equal(ext.subscribed.includes('turn_end'), false);
  assert.deepEqual(ext.subscribed.sort(), [
    'agent_settled', 'session_info_changed', 'session_start', 'turn_start', 'ui_prompt_end', 'ui_prompt_start',
  ]);
});

// --- what the turn hold does with it, which is nothing ------------------------------------------------

test('the turn hold cannot cover the gap between two model rounds', async () => {
  // The issue says `ctx.hasPendingMessages()` does not answer this, and it is right: measured in Pi
  // 0.84.4's `dist/core/agent-session.js`, it is `pendingMessageCount > 0` over the steering and
  // follow-up queues. Between two rounds of one run nothing is queued, so the answer is `false`, the hold
  // declines, and the `idle` is delivered. Pinned because it is the reason the fix cannot sit in the core.
  turnQueue._reset();
  turnHold._reset();
  const transcript = `2026-01-01T00-00-00-000Z_${SESSION}.jsonl`;
  turnHold.init({
    readTurnQueue: (sessionId, sinceMs) => turnQueue.readTurnQueue(transcript, sinceMs),
    log: { info() {}, warn() {}, debug() {} },
  });

  turnQueue.noteTurnQueue(SESSION, { pending: false, turnStart: true });
  let delivered = false;
  assert.equal(turnHold.holdReady(SESSION, () => { delivered = true; }), false,
    'nothing is queued, so nothing is held — the core has no evidence to withhold on');
  assert.equal(delivered, false, 'and the hold delivers nothing itself; the caller does');
});
