'use strict';
// The staged-prompt DELIVERY (#614) — the half `test/prompt-queue.test.js` cannot reach.
//
// WHY THIS EXISTS:
//   `deliverStagedPrompts` is where the gate is assembled out of live answers, where the hold after a
//   send is enforced, where the re-entrancy guard sits and where the item is actually removed. None of
//   that is in the pure module, and `test/prompt-staging-wiring.test.js` reads the source as text — it
//   can see that the function is CALLED and not what it does. Measured before this file existed:
//   changing the gate's dirty check to a constant `false` left the whole suite green, which is the exact
//   defect the feature is built to prevent (typing over a line the user is halfway through).
//
//   The renderer's classic scripts share one lexical scope, so the test builds that scope the way
//   `test/handoff-command-action.test.js` does: the pure module first (prompt-staging.js calls
//   `createPromptQueue()` at parse time), then the wiring, with every free global stubbed. Timers are
//   fakes held in an array — nothing here waits on a real clock, and a leaked timer would keep the test
//   process alive.
//
// WHAT THIS HARNESS CANNOT SHOW, and it cost a whole round to learn:
//   `window.api` here is an ordinary object. In the app it is a `contextBridge` object behind
//   `contextIsolation: true`, which is IMMUTABLE from the renderer — assigning to a property of it does
//   nothing at all and raises no error. An earlier version of this feature took the dirty-line signal by
//   wrapping `window.api.sendInput`; every test in this file passed, and in a live window the property was
//   still the untouched native function, the dirty set stayed empty while typing, and the staged prompt
//   merged into the half-typed line exactly as before.
//
//   So: these tests prove the LOGIC of the seam, never that it is reached. What holds the app to it is
//   `test/prompt-staging-wiring.test.js` ("nothing outside the seam calls window.api.sendInput"), and
//   after that, the click. Do not add an assertion here about `window.api` being wrapped or patched — a
//   fake cannot answer that question, and one that appears to is lying.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SHELL = path.join(__dirname, '..', 'src', 'renderer', 'shell');
const QUEUE = fs.readFileSync(path.join(SHELL, 'prompt-queue.js'), 'utf8');
const STAGING = fs.readFileSync(path.join(SHELL, 'prompt-staging.js'), 'utf8');

const SID = 'session-a';

/**
 * Build the renderer scope this feature runs in.
 *
 * `status` is what `getSessionStatus` will answer for every session; `owned` is whether this window holds
 * the session's terminal (`openSessions`), which is the thing that differs between the window that
 * mounted it and every other window loading the same shell (#390).
 */
function load({ status = 'running', owned = true, sessions = [SID] } = {}) {
  const sent = [];
  const timers = [];
  const renders = { count: 0 };
  const toasts = [];

  const ctx = vm.createContext({});
  ctx.window = ctx;
  ctx.console = console;
  ctx.sessionMap = new Map();
  ctx.openSessions = new Map();
  for (const id of sessions) {
    ctx.sessionMap.set(id, { sessionId: id, name: id });
    if (owned) ctx.openSessions.set(id, { session: { sessionId: id, name: id } });
  }
  ctx.getSessionRuntimeState = () => ({});
  ctx.getSessionStatus = () => ({ key: status });
  ctx.refreshSidebar = () => { renders.count += 1; };
  ctx.cleanDisplayName = (s) => (s || '').trim();
  ctx.showControlToast = (o) => { toasts.push(o); };
  // Reached through a replaceable hook rather than by swapping `window.api` later, so a test can watch a
  // single send without rebuilding the object the whole scope already closed over.
  const hooks = { onSend: (id, data) => { sent.push({ id, data }); } };
  ctx.window.api = { sendInput: (id, data) => hooks.onSend(id, data) };
  // Fake timers: recorded, never fired unless a test fires them.
  ctx.setTimeout = (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; };
  ctx.clearTimeout = (h) => { if (timers[h - 1]) timers[h - 1].cleared = true; };

  vm.runInContext(QUEUE, ctx);
  vm.runInContext(STAGING, ctx);
  const armed = () => timers.filter(t => !t.cleared);
  // `write` is any renderer writer of a session's stdin — a keystroke, the context menu's paste, the seed
  // insert. Every one of them calls the seam, which is what the app does since the tap was found not to
  // work (see the note at the top of this file).
  const write = (id, data) => ctx.sendSessionInput(id, data);
  return {
    ctx, sent, timers, armed, renders, toasts, hooks, write,
    status: (s) => { ctx.getSessionStatus = () => ({ key: s }); },
  };
}

test('a deliverable pass sends the staged prompt exactly once, with a carriage return', () => {
  const h = load();
  h.ctx.stagePromptForSession(SID, 'run the tests');
  assert.deepEqual(h.sent, [{ id: SID, data: 'run the tests\r' }]);
});

test('a second pass in the same moment sends nothing more — the queue is empty', () => {
  const h = load();
  h.ctx.stagePromptForSession(SID, 'one');
  h.ctx.deliverStagedPrompts();
  h.ctx.deliverStagedPrompts();
  assert.equal(h.sent.length, 1);
});

test('a dirty prompt line blocks the send — the user is halfway through a line of their own', () => {
  const h = load();
  h.ctx.markPromptLineFromInput(SID, 'h');     // the user starts typing
  h.ctx.stagePromptForSession(SID, 'do the thing');
  assert.deepEqual(h.sent, [], 'a staged prompt must never be typed on top of an unsent line');
  assert.equal(h.ctx.stagedPromptCountFor(SID), 1, 'and the item stays staged rather than being dropped');
  assert.equal(h.ctx.stagedPromptHeldByLine(SID), true, 'the row has to be able to SAY it is held');
});

test('the same pass sends as soon as the line is submitted', () => {
  const h = load();
  h.ctx.markPromptLineFromInput(SID, 'h');
  h.ctx.stagePromptForSession(SID, 'later');
  h.ctx.markPromptLineFromInput(SID, '\r');    // a submit starts a turn; the status edge drives delivery
  h.ctx.deliverStagedPrompts();
  assert.deepEqual(h.sent, [{ id: SID, data: 'later\r' }]);
});

// ENCODES A LIVE MEASUREMENT. This test asserted the opposite — that Esc releases the hold and delivers,
// because it empties the composer and starts no turn. In Claude Code 2.1.267 it does not: the staged
// prompt went into the line that was still there and the CLI answered
// `half typed by handow summarise what you counted in one sentence.`
//
// Only a submit clears the line now, so there is no keystroke that releases a hold at all.
test('Esc does NOT release the hold — it is not a terminal fact that it empties a composer', () => {
  const h = load();
  h.write(SID, 'half typed by hand');
  h.ctx.stagePromptForSession(SID, 'Now summarise what you counted in one sentence.');
  assert.deepEqual(h.sent, [{ id: SID, data: 'half typed by hand' }]);
  h.write(SID, '\x1b');
  assert.deepEqual(h.sent, [{ id: SID, data: 'half typed by hand' }, { id: SID, data: '\x1b' }],
    'the Esc itself goes to the pty, and nothing else does');
  assert.equal(h.ctx.stagedPromptCountFor(SID), 1, 'the prompt is still staged');
  assert.equal(h.ctx.stagedPromptHeldByLine(SID), true, 'and still held, so the chip still says so');
});

test('the submit is the one release — and it is the user’s own turn that carries it', () => {
  const h = load();
  h.write(SID, 'half typed by hand');
  h.ctx.stagePromptForSession(SID, 'Now summarise what you counted in one sentence.');
  h.write(SID, '\x1b');                        // no release
  assert.equal(h.ctx.stagedPromptCountFor(SID), 1);
  h.write(SID, '\r');                          // the user sends their own line
  h.ctx.deliverStagedPrompts();                // …and the status edge that follows delivers ours
  assert.deepEqual(h.sent.map(s => s.data),
    ['half typed by hand', '\x1b', '\r', 'Now summarise what you counted in one sentence.\r']);
});

test('the terminal answering the CLI is not a dirty line (a wheel notch used to block forever)', () => {
  const h = load();
  h.ctx.markPromptLineFromInput(SID, '\x1b[<64;10;20M');   // one wheel notch, SGR mouse report
  h.ctx.markPromptLineFromInput(SID, '\x1b[?1;2c');        // the terminal naming itself
  h.ctx.stagePromptForSession(SID, 'still deliverable');
  assert.deepEqual(h.sent, [{ id: SID, data: 'still deliverable\r' }]);
});

test('a window that does not hold the terminal never delivers', () => {
  // `sessionMap` and the status model are in EVERY window; the dirty-line signal is only in the window
  // that mounted the terminal. So a window without it reads `running` with a clean line for a session
  // somebody is typing into elsewhere — and would submit on top of them.
  const h = load({ owned: false });
  h.ctx.stagePromptForSession(SID, 'not mine to send');
  assert.deepEqual(h.sent, []);
  assert.equal(h.ctx.stagedPromptCountFor(SID), 1, 'the item waits rather than being lost');
});

test('the item is removed only after a send', () => {
  const h = load({ status: 'busy' });
  h.ctx.stagePromptForSession(SID, 'one');
  h.ctx.deliverStagedPrompts();
  assert.equal(h.ctx.stagedPromptCountFor(SID), 1, 'a blocked pass must not consume the item');
  h.status('running');
  h.ctx.deliverStagedPrompts();
  assert.deepEqual(h.sent, [{ id: SID, data: 'one\r' }]);
  assert.equal(h.ctx.stagedPromptCountFor(SID), 0);
});

test('only one item goes per pass — the next waits for the session to be ready again', () => {
  const h = load();
  h.ctx.stagePromptForSession(SID, 'first');
  h.ctx.stagePromptForSession(SID, 'second');
  assert.deepEqual(h.sent.map(s => s.data), ['first\r']);
  h.ctx.deliverStagedPrompts();
  assert.equal(h.sent.length, 1, 'the hold after a delivery is what stops two prompts stacking up');
  assert.equal(h.ctx.stagedPromptCountFor(SID), 1);
});

test('a re-entrant call from inside the send does not double-send', () => {
  // `window.api.sendInput` is synchronous and the renderer shares one thread, but the status refresh this
  // feature hangs off is called from many places; the guard is what stops one of them re-entering the
  // loop mid-pass and handing the same session a second item.
  const h = load();
  let reentered = 0;
  h.hooks.onSend = (id, data) => {
    h.sent.push({ id, data });
    reentered += 1;
    if (reentered === 1) assert.equal(h.ctx.deliverStagedPrompts(), false, 'a re-entrant pass sends nothing');
  };
  h.ctx.stagePromptForSession(SID, 'a');
  h.ctx.stagePromptForSession(SID, 'b');
  assert.equal(h.sent.length, 1);
});

test('each session is gated on its own — one blocked queue does not hold up another', () => {
  const h = load({ sessions: [SID, 'session-b'] });
  h.ctx.markPromptLineFromInput(SID, 'x');
  h.ctx.stagePromptForSession(SID, 'blocked');
  h.ctx.stagePromptForSession('session-b', 'free');
  assert.deepEqual(h.sent, [{ id: 'session-b', data: 'free\r' }]);
});

test('staging repaints the sidebar once, not twice', () => {
  // The delivery repaints when it sends. Painting before it as well meant two full sidebar renders for
  // one gesture, the first drawing a chip the second immediately removed.
  const h = load();
  h.renders.count = 0;
  h.ctx.stagePromptForSession(SID, 'go');
  assert.equal(h.renders.count, 1);
});

test('a blocked queue arms a re-check, and the last item takes it away again', () => {
  // The delivery rides status edges, and the two states that produce none — a line the user never
  // submits, a terminal in another window — would otherwise wait for a change that is not coming.
  const h = load({ owned: false });
  h.ctx.stagePromptForSession(SID, 'waiting');
  assert.equal(h.armed().length, 1, 'something is staged and cannot move: a re-check has to exist');
  h.ctx.discardStagedPrompts(SID);
  assert.equal(h.armed().length, 0, 'and nothing keeps waking the renderer for an empty queue');
});

test('the exit discards the queue AND what this window believed about the prompt line', () => {
  // A relaunch reuses the session id for the backends that keep it, so a `dirty` flag left over from
  // before the exit would meet a fresh process with an empty line and block it from the first moment.
  const h = load();
  h.ctx.markPromptLineFromInput(SID, 'x');
  h.ctx.stagePromptForSession(SID, 'gone with the process');
  assert.equal(h.ctx.discardStagedPromptsOnExit(SID), 1);
  assert.equal(h.toasts.length, 1, 'a prompt that never arrives must not disappear silently');
  h.ctx.stagePromptForSession(SID, 'after the relaunch');
  assert.deepEqual(h.sent, [{ id: SID, data: 'after the relaunch\r' }]);
});

test('tearing the terminal down clears the line state on its own', () => {
  // The same belief, the other lifecycle event: a re-mount of the same id must not come up blocked.
  const h = load();
  h.ctx.markPromptLineFromInput(SID, 'x');
  h.ctx.clearPromptLineState(SID);
  h.ctx.stagePromptForSession(SID, 'fresh');
  assert.deepEqual(h.sent, [{ id: SID, data: 'fresh\r' }]);
});

test('a fork moves the queue, the line state and the hold onto the new id', () => {
  const h = load({ sessions: [SID, 'session-new'], status: 'busy' });
  h.ctx.stagePromptForSession(SID, 'carried over');
  h.ctx.markPromptLineFromInput(SID, 'x');
  h.ctx.rekeyStagedPrompts(SID, 'session-new');
  assert.equal(h.ctx.stagedPromptCountFor(SID), 0);
  assert.equal(h.ctx.stagedPromptCountFor('session-new'), 1);
  assert.equal(h.ctx.stagedPromptHeldByLine('session-new'), true);
});

test('a delivery shortens a fallback that was already armed, rather than waiting it out', () => {
  // The queue sat blocked, so the long fallback is armed. The moment an item goes out, the wakeup that
  // matters is the end of that delivery's hold — leaving the long one in place would make the second
  // item wait a quarter of a minute for nothing.
  const h = load({ status: 'busy' });
  h.ctx.stagePromptForSession(SID, 'first');
  h.ctx.stagePromptForSession(SID, 'second');
  const long = h.armed()[0].ms;
  h.status('running');
  h.ctx.deliverStagedPrompts();
  const armed = h.armed();
  assert.equal(armed.length, 1, 'still exactly one timer');
  assert.ok(armed[0].ms < long, `the re-check moved in from ${long} ms to the delivery hold`);
});

test('the staging dialog is not dismissible — it holds work the user typed', () => {
  // `.claude/rules/renderer.md`: a stray backdrop click or a reflexive Escape must not throw away
  // something the user cannot get back. Cancel is the way out, and it is labelled.
  const h = load();
  let opts = null;
  h.ctx.showControlDialog = (o) => { opts = o; return Promise.resolve(null); };
  h.ctx.promptForStagedPrompt({ sessionId: SID, name: SID });
  assert.equal(opts.dismissible, false);
});

test('the submit that clears the line repaints the sidebar once, not twice', () => {
  // The submit changes the chip's waiting state, and the delivery that the following status edge triggers
  // repaints too. One keystroke must not cost two full sidebar renders.
  const h = load({ status: 'busy' });
  h.write(SID, 'half typed');
  h.ctx.stagePromptForSession(SID, 'held');
  h.renders.count = 0;
  h.write(SID, '\r');
  assert.equal(h.renders.count, 1, 'the waiting state changed: exactly one render');
  h.status('running');
  h.ctx.deliverStagedPrompts();
  assert.deepEqual(h.sent.map(s => s.data), ['half typed', '\r', 'held\r']);
  assert.equal(h.renders.count, 2, 'and one more when the prompt actually goes out');
});

test('a dirty edge with nothing delivered still repaints, so the chip can say it is held', () => {
  const h = load({ status: 'busy' });
  h.ctx.stagePromptForSession(SID, 'held');
  h.renders.count = 0;
  h.ctx.markPromptLineFromInput(SID, 'h');   // the line goes dirty: the chip has to change
  assert.equal(h.renders.count, 1);
  h.ctx.markPromptLineFromInput(SID, 'i');   // …and not again per character
  assert.equal(h.renders.count, 1);
});

// --- The seam: every renderer writer of the prompt line, not just the terminal ---
//
// Reproduces the defect measured in a running session. `terminal.onData` was the only observed writer, so
// text put into the line by anything else left the gate reading "clean" and the staged prompt was
// submitted on top of it — the transcript ran the two together and the CLI said the message looked like
// it got sent mid-typing. Each of these fails against the old explicit-call wiring.

test('text written by something that is not the terminal marks the line, and holds the delivery', () => {
  const h = load({ status: 'busy' });
  h.ctx.stagePromptForSession(SID, 'Now summarise what you counted in one sentence.');
  h.write(SID, 'half typed');          // not a keystroke: any writer reaching the pty through preload
  h.status('running');                 // the session finishes its turn
  h.ctx.deliverStagedPrompts();
  assert.deepEqual(h.sent, [{ id: SID, data: 'half typed' }],
    'the staged prompt must not be appended to a line somebody else filled');
  assert.equal(h.ctx.stagedPromptCountFor(SID), 1, 'it waits instead');
  assert.equal(h.ctx.stagedPromptHeldByLine(SID), true);
});

test('the delivery goes AROUND the seam, so it never marks the line it just submitted', () => {
  const h = load();
  h.ctx.stagePromptForSession(SID, 'go');
  assert.deepEqual(h.sent, [{ id: SID, data: 'go\r' }]);
  assert.equal(h.ctx.stagedPromptHeldByLine(SID), false);
  assert.equal(h.ctx.stagedPromptCountFor(SID), 0);
});

test('the seam forwards every write through, unchanged and exactly once', () => {
  // It observes; it must never swallow, duplicate or rewrite what a writer sends.
  const h = load();
  h.write(SID, 'hello');
  h.write(SID, '\x1b[200~pasted\x1b[201~');
  assert.deepEqual(h.sent, [{ id: SID, data: 'hello' }, { id: SID, data: '\x1b[200~pasted\x1b[201~' }]);
});

test('a throw inside the signal never breaks the user typing', () => {
  const h = load();
  h.ctx.stagedPromptCountFor = () => { throw new Error('boom'); };
  h.write(SID, 'x');
  assert.deepEqual(h.sent, [{ id: SID, data: 'x' }], 'the write still reached the pty');
});

// --- What each writer's chunk means for the line ---
//
// One test per shape actually sent by `src/renderer/**`, because these are whole chunks rather than
// single keystrokes and the exact-match reading of a submit was wrong for every one of them.

test('a context-menu paste leaves text in the line', () => {
  const h = load({ status: 'busy' });
  h.ctx.stagePromptForSession(SID, 'staged');
  h.write(SID, '\x1b[200~pasted text\x1b[201~');
  assert.equal(h.ctx.stagedPromptHeldByLine(SID), true, 'a bracketed paste does not submit');
});

test('the seed insert ends in a return and therefore submits', () => {
  // `app.js` sends the whole thing in one call: bracketed paste plus the carriage return. Read as
  // "typing", this left the line dirty forever over text nobody could see.
  const h = load({ status: 'busy' });
  h.ctx.stagePromptForSession(SID, 'staged');
  h.write(SID, '\x1b[200~seed text\x1b[201~\r');
  assert.equal(h.ctx.stagedPromptHeldByLine(SID), false);
});

test('paste-and-submit: the paste holds, the return that follows releases', () => {
  const h = load({ status: 'busy' });
  h.ctx.stagePromptForSession(SID, 'staged');
  h.write(SID, '\x1b[200~pasted\x1b[201~');
  assert.equal(h.ctx.stagedPromptHeldByLine(SID), true);
  h.write(SID, '\r');
  assert.equal(h.ctx.stagedPromptHeldByLine(SID), false);
});

test('the newline chord inserts a line and does NOT submit — either declared shape', () => {
  // Shift+Enter sends what the backend declares: `\x1b\r` for one CLI, the kitty protocol's `\x1b[13;2u`
  // for the rest. The first ends in a carriage return and must still read as typing.
  for (const chord of ['\x1b\r', '\x1b[13;2u']) {
    const h = load({ status: 'busy' });
    h.ctx.stagePromptForSession(SID, 'staged');
    h.write(SID, chord);
    assert.equal(h.ctx.stagedPromptHeldByLine(SID), true,
      `${JSON.stringify(chord)} inserts a newline in the composer — the line is fuller, not sent`);
  }
});

test('the space key marks the line like any other character', () => {
  const h = load({ status: 'busy' });
  h.ctx.stagePromptForSession(SID, 'staged');
  h.write(SID, ' ');
  assert.equal(h.ctx.stagedPromptHeldByLine(SID), true);
});
