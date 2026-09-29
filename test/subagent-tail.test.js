'use strict';
// #717: lines reaching an open subagent transcript are drawn the way a reopen draws them — through the
// backend's normaliser over the whole file — and only what the new lines added is handed out.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createSubagentTail } = require('../src/session/subagent-tail');
const { normalizeTranscriptEntries } = require('../src/backends/claude/transcript-view');

const buf = (...lines) => Buffer.from(lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
const call = { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: {} }] } };
const notice = { type: 'user', uuid: 'n1', timestamp: '2026-01-01T00:00:00.000Z', origin: { kind: 'task-notification' },
  message: { role: 'user', content: '<task-notification><task-id>t1</task-id><tool-use-id>call-1</tool-use-id><summary>Background command "ls" completed (exit code 0)</summary></task-notification>' } };

test('a task end arriving live becomes the notice a reopen draws, with the context of earlier lines', () => {
  const tail = createSubagentTail(normalizeTranscriptEntries);
  tail.prime(buf(call));
  const { entries } = tail.take(buf(notice));
  assert.equal(entries.length, 1);
  assert.equal(entries[0]._task.kind, 'shell', 'the kind comes from the call in a line primed earlier');
  assert.deepEqual(entries[0], normalizeTranscriptEntries([call, notice])[1], 'the same entry a reopen draws');
});

test('each take hands out only the new entries, and a local command reads as text', () => {
  const tail = createSubagentTail(normalizeTranscriptEntries);
  tail.prime(buf({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'go' } }));
  assert.deepEqual(tail.take(buf({ type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })).entries.map(e => e.uuid), ['a2']);
  const cmd = tail.take(buf({ type: 'system', subtype: 'local_command', uuid: 's1', content: '<local-command-stdout>done</local-command-stdout>' }));
  assert.deepEqual(cmd.entries.map(e => [e.uuid, e.type]), [['s1', 'assistant']]);
});

test('in a subagent\'s own file, where every line is a sidechain, the lines are still read', () => {
  const tail = createSubagentTail(normalizeTranscriptEntries);
  tail.prime(Buffer.alloc(0));
  const { entries } = tail.take(buf(
    { ...notice, isSidechain: true },
    { type: 'system', subtype: 'local_command', uuid: 's1', isSidechain: true, content: '<local-command-stdout>out</local-command-stdout>' },
  ));
  assert.deepEqual(entries.map(e => e.type), ['task-notice', 'assistant']);
});

test('a line still being written is left for the next pass, counted in bytes', () => {
  const tail = createSubagentTail(normalizeTranscriptEntries);
  // Invalid UTF-8 in an earlier line must not move the offset: 0xff decodes to a three-byte replacement.
  const start = Buffer.concat([Buffer.from('{"type":"x","v":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
  assert.equal(tail.prime(start), start.length);
  const whole = Buffer.from(JSON.stringify({ type: 'user', uuid: 'u9', message: { role: 'user', content: 'naïve café' } }) + '\n', 'utf8');
  const half = Buffer.from('{"type":"user","uuid":"u1', 'utf8');
  const first = tail.take(Buffer.concat([whole, half]));
  assert.equal(first.consumed, whole.length, 'the half line is not consumed');
  assert.deepEqual(first.entries.map(e => e.uuid), ['u9']);
  assert.deepEqual(tail.take(half), { consumed: 0, entries: [] });
});

test('a backend without the hook gets its lines raw; a hook that fails once sends nothing twice', () => {
  const plain = createSubagentTail(null);
  plain.prime(buf({ a: 1 }));
  assert.deepEqual(plain.take(buf({ b: 2 })).entries, [{ b: 2 }]);
  let fail = true;
  const flaky = createSubagentTail((lines) => { if (fail) { fail = false; throw new Error('no'); } return lines; });
  fail = false;
  flaky.prime(buf({ a: 1 }));
  fail = true;
  assert.deepEqual(flaky.take(buf({ b: 2 })).entries, [{ b: 2 }], 'sent raw while the hook fails');
  assert.deepEqual(flaky.take(buf({ c: 3 })).entries, [{ c: 3 }], 'then only the new line, not b again');
});
