'use strict';
// #717: lines reaching an open subagent transcript are drawn the way a reopen draws them — through the
// backend's normaliser over the whole file — and only what the new lines added is handed out.
const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createSubagentTail, followSubagentFile } = require('../src/session/subagent-tail');
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

// A CLI that compacts its transcript in place (Claude Code's `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC`) rewrites the file
// instead of appending to it. The follower must not read on from an offset taken in the old file.
function tempTranscript(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-tail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'agent.jsonl');
}
const line = (uuid, text) => ({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } });

test('the follower hands out appended entries and nothing while the file is unchanged', (t) => {
  const file = tempTranscript(t);
  fs.writeFileSync(file, buf(line('a1', 'one')));
  const follower = followSubagentFile(file, normalizeTranscriptEntries);
  assert.equal(follower.poll(), null, 'what was there at open is already drawn');
  fs.appendFileSync(file, buf(line('a2', 'two')));
  assert.deepEqual(follower.poll(), { reset: false, entries: normalizeTranscriptEntries([line('a1', 'one'), line('a2', 'two')]).slice(1) });
  assert.equal(follower.poll(), null);
});

test('a file that shrank is read again whole and answered as a reset', (t) => {
  const file = tempTranscript(t);
  fs.writeFileSync(file, buf(line('a1', 'x'.repeat(400)), line('a2', 'two')));
  const follower = followSubagentFile(file, normalizeTranscriptEntries);
  fs.writeFileSync(file, buf(line('a2', 'two')));
  const update = follower.poll();
  assert.equal(update.reset, true);
  assert.deepEqual(update.entries.map(e => e.uuid), ['a2']);
  fs.appendFileSync(file, buf(line('a3', 'three')));
  assert.deepEqual(follower.poll().entries.map(e => e.uuid), ['a3'], 'after the reset it follows the new file');
});

test('a rewrite that has already grown past the old offset is still caught', (t) => {
  const file = tempTranscript(t);
  fs.writeFileSync(file, buf(line('a1', 'one'), line('a2', 'two')));
  const follower = followSubagentFile(file, normalizeTranscriptEntries);
  // Smaller first, then more lines than were cut: the old offset now lands mid-line.
  fs.writeFileSync(file, buf(line('a2', 'two'), line('a3', 'three'), line('a4', 'x'.repeat(200))));
  const update = follower.poll();
  assert.equal(update.reset, true, 'the bytes before the old offset are not the ones read there');
  assert.deepEqual(update.entries.map(e => e.uuid), ['a2', 'a3', 'a4']);
});

test('a reset of a file emptied in place answers an empty list, so the view clears', (t) => {
  const file = tempTranscript(t);
  fs.writeFileSync(file, buf(line('a1', 'one')));
  const follower = followSubagentFile(file, null);
  fs.writeFileSync(file, '');
  assert.deepEqual(follower.poll(), { reset: true, entries: [] });
});

test('a rewrite to the very same size is caught by the fingerprint', (t) => {
  const file = tempTranscript(t);
  fs.writeFileSync(file, buf(line('a1', 'aaaa'), line('a2', 'bbbb')));
  const follower = followSubagentFile(file, normalizeTranscriptEntries);
  fs.writeFileSync(file, buf(line('a1', 'aaaa'), line('a2', 'cccc')));
  const update = follower.poll();
  assert.equal(update.reset, true);
  assert.deepEqual(update.entries.map(e => e.message.content[0].text), ['aaaa', 'cccc']);
  assert.equal(follower.poll(), null, 'an unchanged file of the same size hands out nothing');
});

test('a half-written line and a growth shorter than the fingerprint are taken without a reset', (t) => {
  const file = tempTranscript(t);
  fs.writeFileSync(file, buf(line('a1', 'one')));
  const follower = followSubagentFile(file, null);
  const next = JSON.stringify(line('a2', 'two')) + '\n';
  fs.appendFileSync(file, next.slice(0, 10));
  assert.equal(follower.poll(), null, 'ten bytes of a line are not a line');
  fs.appendFileSync(file, next.slice(10));
  assert.deepEqual(follower.poll(), { reset: false, entries: [line('a2', 'two')] });
});

test('a file missing when the view opened is followed from its first line', (t) => {
  const file = tempTranscript(t);
  const follower = followSubagentFile(file, null);
  fs.writeFileSync(file, buf(line('a1', 'one')));
  assert.deepEqual(follower.poll(), { reset: false, entries: [line('a1', 'one')] });
});
