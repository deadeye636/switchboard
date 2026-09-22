'use strict';
// A `!` line in a runtime-driven session (#643): the shell line the user types into the composer, run by
// the runtime's own shell so its output joins the session's context. Driven against a real child on a
// real pipe through the shared harness — see `test/helpers/agent-rpc-harness.js` for why these live in a
// file of their own.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { harness, stopped, tempDataDir, until, agentRpc } = require('./helpers/agent-rpc-harness');
const { stripComments } = require('./helpers/strip-comments');

test('a shell line is drawn while it runs and replaced by its result', async (t) => {
  const h = harness({ dataDir: tempDataDir(t) });
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);

  await agentRpc.sendTurn('fake-session', { text: '!echo hi', mode: 'prompt' });
  await until(() => h.sent.some(m => m.op && m.op.op === 'localCommand' && m.op.status !== 'running'));
  const drawn = h.sent.filter(m => m.op && m.op.op === 'localCommand').map(m => m.op);

  assert.equal(drawn[0].command, 'echo hi', 'the command is named on the first op, before anything has run');
  assert.equal(drawn[0].status, 'running');
  assert.equal(drawn[0].output, '', 'said before the request goes out, so a slow line is visible at once');
  assert.ok(drawn.some(o => o.status === 'running' && o.output === 'ran echo hi\n'), 'the output arrives while it runs');

  const done = drawn[drawn.length - 1];
  assert.equal(done.status, 'done');
  assert.match(done.output, /ran echo hi/);
  assert.match(done.output, /\[exit 0\]/, 'the runtime words the ending, not the core');
  assert.equal(new Set(drawn.map(o => o.id)).size, 1, 'one id throughout, so the view replaces rather than appends');
  assert.ok(!h.sent.some(m => m.op && m.op.op === 'shell'), 'the request op is answered here, never sent on');
});

// A shell line the user started must outlive the request timeout — `!npm test` runs for minutes, and a
// timeout would report a failure about a command that is working. There is no seam to reach that from
// here (crossing the real 20 s would make this file the slowest in the suite for one assertion), so this
// is a SOURCE check, and what it really pins is the regression that will happen: somebody tidying the
// option away because every other request has a timer.
test('the shell request is the one that carries no timeout', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'agent-rpc.js'), 'utf8'));
  const at = src.indexOf('rpc.shellCommand(');
  assert.ok(at >= 0, 'the shell line still goes out through the descriptor\'s command');
  assert.equal(src.indexOf('rpc.shellCommand(', at + 1), -1, 'and from exactly one place, so this reads the right call');
  assert.match(src.slice(at, at + 160), /timeoutMs:\s*0/, 'with no timer: the child exiting is the bound, not a clock');
});

test('a shell line is not a turn: no busy edge, and nothing reaches the model', async (t) => {
  const h = harness({ dataDir: tempDataDir(t) });
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  await agentRpc.sendTurn('fake-session', { text: '!slow forever', mode: 'prompt' });
  await until(() => h.sent.some(m => m.op && m.op.op === 'localCommand'));
  // The fixture answers nothing until it is stopped. Nothing turned into a turn, and no busy edge was
  // reported: a shell line is not the agent working.
  assert.deepEqual(h.signals.map(s => s.kind), [], 'a shell line is not a turn');
  assert.ok(!h.sent.some(m => m.op && m.op.op === 'append'), 'and it never became a message to the model');
});

// Stop has two things to end since #643, and the plain abort is not the one that ends a shell line.
test('Stop ends a running shell line as well as the turn', async (t) => {
  const h = harness({ dataDir: tempDataDir(t) });
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  await agentRpc.sendTurn('fake-session', { text: '!slow forever', mode: 'prompt' });
  await until(() => h.sent.some(m => m.op && m.op.op === 'localCommand'));

  assert.deepEqual(await agentRpc.abortTurn('fake-session'), { ok: true });
  await until(() => h.sent.some(m => m.op && m.op.op === 'localCommand' && m.op.status === 'cancelled'));
  const last = h.sent.filter(m => m.op && m.op.op === 'localCommand').pop().op;
  assert.equal(last.status, 'cancelled');
  assert.match(last.output, /ran slow forever/, 'what the line had already printed stands');
  assert.match(last.output, /\[cancelled\]/, 'marked the way the history viewer marks the same execution');
  assert.equal(last.command, 'slow forever', 'and it still says which line it was');
});

// Every op forwarded for a line carries the command, not only the first: a view that mounts MID-command
// has never seen the op that named it, and would draw the output under an empty heading with no Stop.
test('every op for a shell line names the command, so a view that mounts late draws it whole', async (t) => {
  const h = harness({ dataDir: tempDataDir(t) });
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  await agentRpc.sendTurn('fake-session', { text: '!echo hi', mode: 'prompt' });
  await until(() => h.sent.some(m => m.op && m.op.op === 'localCommand' && m.op.status !== 'running'));
  const drawn = h.sent.filter(m => m.op && m.op.op === 'localCommand').map(m => m.op);
  assert.ok(drawn.length >= 2);
  for (const op of drawn) assert.equal(op.command, 'echo hi', 'including the ones produced by the runtime\'s own events');
});

// The runtime raises the marker for EVERY turn that reaches the session, and a turn is not only what
// somebody typed: the trigger watcher, a seed prompt and a launcher all write into one. A `!` line
// arriving that way must not run a command.
test('a shell line written into the session from elsewhere is not run', async (t) => {
  const h = harness({ dataDir: tempDataDir(t) });
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);

  // Exactly what the trigger watcher, the seed prompt and a launcher do: text and a carriage return.
  h.proc.write('!echo from-a-trigger\r');
  // A longer budget than the default: these two tests cost several round trips to a real child, and the
  // suite's own concurrency is enough to push that past five seconds on a busy machine.
  await until(() => h.sent.some(m => m.op && m.op.op === 'notice'), 20000);
  const notice = h.sent.filter(m => m.op && m.op.op === 'notice').pop().op;
  assert.equal(notice.level, 'warning');
  assert.match(notice.text, /only runs when it is typed here/);
  assert.ok(!h.sent.some(m => m.op && m.op.op === 'localCommand'), 'and nothing was run or drawn');

  // The same line typed into the composer still runs, so the guard is about the way in and not the text.
  await agentRpc.sendTurn('fake-session', { text: '!echo from-a-trigger', mode: 'prompt' });
  await until(() => h.sent.some(m => m.op && m.op.op === 'localCommand'), 20000);
  assert.equal(h.sent.filter(m => m.op && m.op.op === 'localCommand')[0].op.command, 'echo from-a-trigger');
});

test('a composer line is spent once, so a repeat from elsewhere does not ride on it', async (t) => {
  const h = harness({ dataDir: tempDataDir(t) });
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  await agentRpc.sendTurn('fake-session', { text: '!echo once', mode: 'prompt' });
  // Counted once the first line has FINISHED, or the count is taken mid-stream and the ops that follow
  // it look like a second line having run.
  await until(() => h.sent.some(m => m.op && m.op.op === 'localCommand' && m.op.status !== 'running'), 20000);
  const ran = h.sent.filter(m => m.op && m.op.op === 'localCommand').length;

  h.proc.write('!echo once\r');
  await until(() => h.sent.some(m => m.op && m.op.op === 'notice' && /typed here/.test(m.op.text || '')), 20000);
  assert.equal(h.sent.filter(m => m.op && m.op.op === 'localCommand').length, ran,
    'the second one is refused although the composer sent that very text a moment ago');
});

// An op for a line this process never started can never be ended by it — nothing is pending for that id —
// so a view would offer Stop for it until the tab closes.
test('an op for a shell line nobody here started is dropped', async (t) => {
  const h = harness({ dataDir: tempDataDir(t) });
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  const before = h.sent.filter(m => m.op && m.op.op === 'localCommand').length;
  // Straight into the decoder's path, as if the runtime had reported output for a line of its own.
  const state = h.activeSessions.get('fake-session').pty._agent;
  for (const op of state.decoder.decode({ type: 'bash_execution_update', id: 'not-ours', delta: 'x' })) {
    assert.equal(op.op, 'localCommand', 'the backend does turn it into one');
  }
  await new Promise(r => setTimeout(r, 150));
  assert.equal(h.sent.filter(m => m.op && m.op.op === 'localCommand').length, before, 'and this process forwards none of it');
});

test('Stop on a session with no shell line running is the abort it always was', async (t) => {
  const h = harness({ dataDir: tempDataDir(t) });
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  assert.deepEqual(await agentRpc.abortTurn('fake-session'), { ok: true });
  assert.ok(!h.sent.some(m => m.op && m.op.op === 'localCommand'), 'nothing was drawn for a line nobody ran');
});
