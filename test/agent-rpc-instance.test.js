'use strict';
// src/app/agent-rpc.js: a protocol half that keeps state per session (#734, spec 49 T2). A half that declares
// `createInstance(spawn)` gets one instance per start, laid over the half, and that instance is the session's `rpc` —
// its decoder and its commands share state, which is what a runtime needs when a stop has to name the turn that runs.
// The instance here wraps pi-native's own half and the Pi stand-in, so the session around it is the real one; a half
// without `createInstance` is covered by every other agent-rpc test file, which runs unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');

const { harness, stopped, until, agentRpc, piNative } = require('./helpers/agent-rpc-harness');

// A half over pi-native's that counts the turns its decoder sees start and puts the count on every abort it builds.
function countingHalf(record) {
  return {
    ...piNative.rpc,
    createInstance(spawn) {
      record.spawns.push(spawn);
      const own = { turns: 0, sent: [] };
      record.instances.push(own);
      return {
        createDecoder(args) {
          const inner = piNative.rpc.createDecoder(args);
          return {
            ...inner,
            decode(msg) {
              const ops = inner.decode(msg) || [];
              if (ops.some(op => op && op.op === 'busy' && op.busy === true)) own.turns += 1;
              return ops;
            },
            noteSent(line) { own.sent.push(line); },
          };
        },
        abortCommand: (id) => ({ ...piNative.rpc.abortCommand(id), turn: own.turns }),
      };
    },
  };
}

test('the instance is the session\'s rpc: its decoder and its commands share one state', async (t) => {
  const record = { spawns: [], instances: [] };
  const h = harness({ rpc: countingHalf(record) });
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  assert.equal(record.instances.length, 1, 'one instance per start');

  assert.deepEqual(await agentRpc.sendTurn('fake-session', { text: 'one', mode: 'prompt' }), { ok: true });
  await until(() => h.signals.some(s => s.kind === 'idle'));
  assert.equal(record.instances[0].turns, 1, 'the decoder the core runs is the instance\'s');

  assert.deepEqual(await agentRpc.abortTurn('fake-session'), { ok: true });
  const abort = record.instances[0].sent.find(line => line.type === 'abort');
  assert.ok(abort, 'the abort went out through the instance\'s command');
  assert.equal(abort.turn, 1, 'and carried what the decoder learned');
});

test('the instance gets the launch data untouched, the session facts and a working link', async (t) => {
  const record = { spawns: [], instances: [] };
  const init = { opaque: { nested: true } };
  const options = { model: 'm' };
  const h = harness({ rpc: countingHalf(record), init, options, forkFrom: 'parent-session' });
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);

  const spawn = record.spawns[0];
  assert.equal(spawn.init, init, 'init is handed over as the same object');
  assert.deepEqual(spawn.init, { opaque: { nested: true } }, 'and nothing in it was changed');
  assert.equal(spawn.options, options);
  assert.equal(spawn.forkFrom, 'parent-session');
  assert.equal(typeof spawn.cwd, 'string');
  assert.equal(typeof spawn.env, 'object');
  assert.deepEqual(Object.keys(spawn.link).sort(), ['request', 'write']);

  // Called once the session runs, the link is the core's own request: the runtime answers it like any other.
  const res = await spawn.link.request((id) => piNative.rpc.stateCommand(id));
  assert.equal(res.success, true);
  assert.equal(res.data.sessionId, 'fake-session');
  assert.equal(spawn.link.write(piNative.rpc.stateCommand('by-hand')), true, 'write answers whether the line went out');
});

test('every key the instance does not answer still reads the half', async (t) => {
  const record = { spawns: [], instances: [] };
  const h = harness({ rpc: countingHalf(record) });
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  // Identity comes through the half's `stateCommand` + `sessionIdFromState`, which the instance does not declare.
  assert.ok(h.activeSessions.has('fake-session'));
  const snap = await agentRpc.attach('fake-session');
  assert.equal(snap.ok, true, 'the attach reads the half\'s `messagesCommand`');
});

test('a link called while the instance is built answers as for a stopped session, and works once it runs', async (t) => {
  let early = null;
  let link = null;
  const h = harness({
    rpc: {
      ...piNative.rpc,
      createInstance(spawn) {
        link = spawn.link;
        early = { wrote: spawn.link.write(piNative.rpc.stateCommand('early')), asked: spawn.link.request((id) => piNative.rpc.stateCommand(id)) };
        return {};
      },
    },
  });
  t.after(() => stopped(h));
  assert.equal(early.wrote, false);
  assert.deepEqual(await early.asked, { success: false, error: 'not running' });
  await until(() => h.rekeys.length === 1);
  assert.equal((await link.request((id) => piNative.rpc.stateCommand(id))).success, true);
});

test('an instance that is not a plain object refuses the start before any child runs', () => {
  class Session { abortCommand(id) { return { id }; } }
  for (const answer of [null, undefined, 'text', 3, new Session(), new Map()]) {
    assert.throws(
      () => harness({ rpc: { ...piNative.rpc, createInstance: () => answer } }),
      /could not set up its protocol/,
      `createInstance answering ${String(answer)}`,
    );
  }
});
