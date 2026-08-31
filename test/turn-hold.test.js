'use strict';
// #495 — a `Stop` that arrives while the CLI still owes a turn.
//
// Claude fires `UserPromptSubmit` when a prompt is ENQUEUED, not when it is sent. If the running turn
// ends before the queue drains, the `Stop` of the OLD turn lands after that busy edge and overwrites it,
// and the turn the queued prompt starts announces nothing — its event was spent 41 seconds earlier. The
// session then works while its row says "Ready", which is the one thing the attention inbox must never
// get wrong.
//
// The measured order, from a real session (the gap between the `Stop` and the prompt was 72 ms):
//
//   19:19:54.369  enqueue                → UserPromptSubmit → busy
//   19:20:35.093  Stop (the OLD turn)    → ready
//   19:20:35.131  dequeue                → no hook
//   19:20:35.165  the queued prompt runs, silently
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readTurnQueue } = require('../src/backends/claude/turn-queue');
const turnHold = require('../src/app/turn-hold');
const hooks = require('../src/app/hooks');

const TOKEN = 'a-known-token';
const SESSION = 'sess-495';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-turn-hold-'));
}

function writeTranscript(dir, entries) {
  const file = path.join(dir, SESSION + '.jsonl');
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

const queueOp = (operation, content) => (content === undefined
  ? { type: 'queue-operation', operation, sessionId: SESSION }
  : { type: 'queue-operation', operation, sessionId: SESSION, content });

const userPrompt = (timestamp, text) => ({ type: 'user', timestamp, message: { role: 'user', content: text } });
const toolResult = (timestamp) => ({
  type: 'user',
  timestamp,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
});
const assistantTurn = (timestamp) => ({
  type: 'assistant', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
});

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- reading the queue out of Claude's transcript ------------------------------------------------

test('turn queue: an enqueue with no removal is a prompt the CLI still owes', () => {
  const dir = tmpDir();
  const file = writeTranscript(dir, [queueOp('enqueue', 'do the thing')]);
  assert.equal(readTurnQueue(file).queued, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('turn queue: every way a prompt leaves the queue closes it', () => {
  const dir = tmpDir();
  // Measured over 116 real transcripts: an `enqueue` is always followed by exactly one of these three.
  for (const closing of ['remove', 'dequeue', 'popAll']) {
    const file = writeTranscript(dir, [queueOp('enqueue', 'x'), queueOp(closing, closing === 'remove' ? 'x' : undefined)]);
    assert.equal(readTurnQueue(file).queued, 0, closing);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('turn queue: two queued, one taken, one still owed', () => {
  const dir = tmpDir();
  const file = writeTranscript(dir, [
    queueOp('enqueue', 'first'), queueOp('enqueue', 'second'), queueOp('dequeue'),
  ]);
  assert.equal(readTurnQueue(file).queued, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('turn queue: popAll empties whatever is queued, however much', () => {
  const dir = tmpDir();
  const file = writeTranscript(dir, [
    queueOp('enqueue', 'a'), queueOp('enqueue', 'b'), queueOp('enqueue', 'c'), queueOp('popAll'),
  ]);
  assert.equal(readTurnQueue(file).queued, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('turn queue: a closure with no enqueue before it does not hide a real one', () => {
  const dir = tmpDir();
  // A truncated or rotated file can start mid-pair. Counting into the negative would then swallow the
  // enqueue that follows — the one prompt that is genuinely still owed.
  const file = writeTranscript(dir, [queueOp('remove', 'older'), queueOp('enqueue', 'newer')]);
  assert.equal(readTurnQueue(file).queued, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('turn queue: an enqueue pushed out of the tail window is still counted', () => {
  const dir = tmpDir();
  // Measured over 1570 real enqueue/closure pairs: 7 are further apart than the 128 KB window and the
  // widest is 985 KB. A verbose turn writes past its own queued prompt, and a window that lost sight of
  // it reports an empty queue — no hold is taken, and #495 is back with no timeout behind it.
  const noise = Array.from({ length: 700 }, (_, i) => (
    { type: 'assistant', timestamp: '2026-08-31T17:20:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(300), n: i }] } }
  ));
  const file = writeTranscript(dir, [queueOp('enqueue', 'still waiting'), ...noise]);
  assert.ok(fs.statSync(file).size > 128 * 1024, 'the fixture has to exceed the window to prove anything');

  assert.equal(readTurnQueue(file).queued, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('turn queue: an injected user entry is not the user starting a turn', () => {
  const dir = tmpDir();
  const stop = Date.parse('2026-08-31T17:20:35.093Z');
  // A skill's body and a system reminder are written as `user` entries with an ordinary text block —
  // 452 of them in the store this was measured against. Counting one as a turn start releases the held
  // signal WITHOUT delivering it, and takes the timeout that would have rescued the session with it.
  const file = writeTranscript(dir, [{
    type: 'user',
    isMeta: true,
    timestamp: '2026-08-31T17:20:36.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: …' }] },
  }]);
  assert.equal(readTurnQueue(file, stop).turnStarted, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('turn queue: a tool result is not a turn starting', () => {
  const dir = tmpDir();
  const stop = Date.parse('2026-08-31T17:20:35.093Z');
  // Every tool call writes a `user` entry. Reading those as "the user said something" would report a
  // turn start on each one.
  const file = writeTranscript(dir, [toolResult('2026-08-31T17:20:53.340Z')]);
  assert.equal(readTurnQueue(file, stop).turnStarted, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('turn queue: the queued prompt IS a turn starting, and only after the Stop', () => {
  const dir = tmpDir();
  const stop = Date.parse('2026-08-31T17:20:35.093Z');
  const before = writeTranscript(dir, [userPrompt('2026-08-31T17:19:00.000Z', 'earlier')]);
  assert.equal(readTurnQueue(before, stop).turnStarted, false);

  const after = writeTranscript(dir, [userPrompt('2026-08-31T17:20:35.165Z', 'du machst das komplett')]);
  assert.equal(readTurnQueue(after, stop).turnStarted, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('turn queue: a subagent line is not the parent session starting a turn', () => {
  const dir = tmpDir();
  const stop = Date.parse('2026-08-31T17:20:35.093Z');
  const file = writeTranscript(dir, [{ ...assistantTurn('2026-08-31T17:25:00.000Z'), isSidechain: true }]);
  assert.equal(readTurnQueue(file, stop).turnStarted, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('turn queue: a transcript that is not there answers null, not zero', () => {
  assert.equal(readTurnQueue(path.join(os.tmpdir(), 'sb-495-does-not-exist.jsonl')), null);
  assert.equal(readTurnQueue(null), null);
});

// --- holding the signal --------------------------------------------------------------------------

function holdCtx(answers, over = {}) {
  const logged = [];
  turnHold.init({
    log: {
      info: (m) => logged.push(m), warn: (m) => logged.push(m), debug: () => {}, error: () => {},
    },
    recheckMs: 5,
    maxHoldMs: 40,
    readTurnQueue: (sessionId, sinceMs) => answers(sessionId, sinceMs),
    ...over,
  });
  return logged;
}

test('turn hold: a backend that cannot answer changes nothing', () => {
  holdCtx(() => null);
  let delivered = 0;
  assert.equal(turnHold.holdReady(SESSION, () => { delivered++; }), false);
  assert.equal(delivered, 0, 'holdReady does not deliver — it answers whether the caller should');
  turnHold._reset();
});

test('turn hold: an ordinary turn boundary is delivered at once', () => {
  holdCtx(() => ({ queued: 0, turnStarted: false }));
  assert.equal(turnHold.holdReady(SESSION, () => {}), false);
  turnHold._reset();
});

test('turn hold: a queued prompt holds the signal back', () => {
  holdCtx(() => ({ queued: 1, turnStarted: false }));
  let delivered = 0;
  assert.equal(turnHold.holdReady(SESSION, () => { delivered++; }), true);
  assert.equal(delivered, 0);
  turnHold._reset();
});

test('turn hold: the queued prompt runs — the held signal is dropped, never delivered', async () => {
  let turnStarted = false;
  holdCtx(() => ({ queued: turnStarted ? 0 : 1, turnStarted }));
  let delivered = 0;
  assert.equal(turnHold.holdReady(SESSION, () => { delivered++; }), true);

  turnStarted = true;               // the dequeued prompt writes its first entry
  await wait(30);
  assert.equal(delivered, 0, 'the busy state was right; that turn ends with its OWN Stop');
  turnHold._reset();
});

test('turn hold: the queue is cancelled — the signal arrives late rather than never', async () => {
  let queued = 1;
  holdCtx(() => ({ queued, turnStarted: false }));
  let delivered = 0;
  turnHold.holdReady(SESSION, () => { delivered++; });

  queued = 0;                       // the user changed their mind; no hook will ever say so
  await wait(30);
  assert.equal(delivered, 1);
  turnHold._reset();
});

test('turn hold: a hold nothing resolves ends in the honest answer, not in "Working" forever', async () => {
  const logged = holdCtx(() => ({ queued: 1, turnStarted: false }));   // never drains, never runs
  let delivered = 0;
  turnHold.holdReady(SESSION, () => { delivered++; });

  await wait(120);
  assert.equal(delivered, 1);
  assert.ok(logged.some(m => /delivered anyway/.test(m)), 'and it says so');
  turnHold._reset();
});

test('turn hold: any newer signal releases a held one without delivering it', async () => {
  holdCtx(() => ({ queued: 1, turnStarted: false }));
  let delivered = 0;
  turnHold.holdReady(SESSION, () => { delivered++; });

  turnHold.cancel(SESSION);
  await wait(60);
  assert.equal(delivered, 0);
  turnHold._reset();
});

// --- through the hook server, in the order it actually happened -----------------------------------

function fakeRes() {
  const res = {
    statusCode: null,
    writeHead(code) { res.statusCode = code; },
    end(chunk) { res.body = chunk == null ? '' : String(chunk); },
  };
  return res;
}

function fakeReq(url, body) {
  const listeners = {};
  const req = {
    method: 'POST',
    url,
    on(event, fn) {
      listeners[event] = fn;
      if (event === 'end') {
        queueMicrotask(() => {
          if (body != null && listeners.data) listeners.data(body);
          fn();
        });
      }
      return req;
    },
    destroy() { req.destroyed = true; },
  };
  return req;
}

function hookCtx() {
  const sent = [];
  hooks.init({
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
    }),
    getSetting: () => ({}),
    activeSessions: new Map(),
    indexWorker: { postFile: () => {} },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    isPackaged: true,
    holdReady: (sessionId, deliver) => turnHold.holdReady(sessionId, deliver),
    cancelHeldReady: (sessionId) => turnHold.cancel(sessionId),
  });
  return sent;
}

function post(payload) {
  const res = fakeRes();
  hooks.handleHookRequest(fakeReq('/switchboard-attention-hook?t=' + TOKEN, JSON.stringify(payload)), res, TOKEN);
  return new Promise(resolve => setTimeout(() => resolve(res), 0));
}

const stopEvent = { hook_event_name: 'Stop', session_id: SESSION };
const promptEvent = { hook_event_name: 'UserPromptSubmit', session_id: SESSION };

test('hook ingest: a Stop with a prompt still queued sends no "ready" (#495)', async () => {
  holdCtx(() => ({ queued: 1, turnStarted: false }));
  const sent = hookCtx();

  await post(stopEvent);
  assert.deepEqual(sent, [], 'the row must not flip to Ready while the CLI still owes a turn');
  turnHold._reset();
});

test('hook ingest: a Stop with an empty queue still ends the turn', async () => {
  holdCtx(() => ({ queued: 0, turnStarted: false }));
  const sent = hookCtx();

  await post(stopEvent);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.kind, 'ready');
  turnHold._reset();
});

test('hook ingest: the measured order — enqueue, Stop, the prompt runs', async () => {
  // A real transcript, appended to between the POSTs exactly as the CLI wrote it.
  const dir = tmpDir();
  let file = writeTranscript(dir, [
    userPrompt('2026-08-31T17:18:00.000Z', 'the turn that is about to end'),
    queueOp('enqueue', 'du machst das komplett'),
  ]);
  // The fixture keeps the instants the session actually carried, so the 72 ms between the `Stop` and the
  // prompt is the measured one rather than a made-up gap. `holdReady` stamps the Stop with `Date.now()` —
  // right in the app, where both happen now — so the recheck is told the Stop's REAL instant instead.
  const STOP_MS = Date.parse('2026-08-31T17:20:35.093Z');
  holdCtx(() => readTurnQueue(file, STOP_MS));
  const sent = hookCtx();

  await post(promptEvent);                       // 17:19:54 — the enqueue fires the hook
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.kind, 'busy');

  await post(stopEvent);                         // 17:20:35.093 — the OLD turn's Stop
  assert.equal(sent.length, 1, 'held: a prompt is still queued');

  // 17:20:35.131 dequeue, then 17:20:35.165 the prompt itself — neither fires a hook.
  file = writeTranscript(dir, [
    queueOp('enqueue', 'du machst das komplett'),
    queueOp('dequeue'),
    userPrompt('2026-08-31T17:20:35.165Z', 'du machst das komplett'),
    assistantTurn('2026-08-31T17:20:40.000Z'),
  ]);
  await wait(30);
  assert.equal(sent.length, 1, 'and the held "ready" is dropped, because the turn really did start');

  turnHold._reset();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hook ingest: a new turn releases a held signal instead of leaving it pending', async () => {
  holdCtx(() => ({ queued: 1, turnStarted: false }));
  const sent = hookCtx();

  await post(stopEvent);
  assert.deepEqual(sent, []);
  await post(promptEvent);                       // the user types again
  await wait(60);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.kind, 'busy', 'and the stale "ready" never arrives behind it');
  turnHold._reset();
});

test('turn queue: an unchanged transcript is read once, however often it is asked', () => {
  const dir = tmpDir();
  // The recheck loop asks every few seconds for up to a minute while a signal is held, and a transcript
  // over the window is read WHOLE. That only repeats while nothing is happening — the moment the queued
  // turn starts the file grows and the first ask releases the hold — so the repeating case is exactly
  // the one where the file has not changed.
  const noise = Array.from({ length: 700 }, (_, i) => (
    { type: 'assistant', timestamp: '2026-08-31T17:20:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(300), n: i }] } }
  ));
  const file = writeTranscript(dir, [queueOp('enqueue', 'still waiting'), ...noise]);

  const realReadFileSync = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (...args) => {
    if (String(args[0]).endsWith('.jsonl')) reads++;
    return realReadFileSync(...args);
  };
  try {
    assert.equal(readTurnQueue(file).queued, 1);
    const afterFirst = reads;
    assert.ok(afterFirst > 0, 'the first ask has to read the file');
    for (let i = 0; i < 15; i++) assert.equal(readTurnQueue(file).queued, 1);
    assert.equal(reads, afterFirst, 'and every ask after it answers from the memo');
  } finally {
    fs.readFileSync = realReadFileSync;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('turn queue: the memo is keyed on the content, so an appended transcript is re-read', () => {
  const dir = tmpDir();
  const file = writeTranscript(dir, [queueOp('enqueue', 'still waiting')]);
  assert.equal(readTurnQueue(file).queued, 1);

  // The queued prompt is taken and its turn begins — the answer must move with the file.
  fs.appendFileSync(file, JSON.stringify(queueOp('dequeue')) + '\n'
    + JSON.stringify(userPrompt('2026-08-31T17:20:35.165Z', 'du machst das komplett')) + '\n');
  const after = readTurnQueue(file, Date.parse('2026-08-31T17:20:35.093Z'));
  assert.equal(after.queued, 0);
  assert.equal(after.turnStarted, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
