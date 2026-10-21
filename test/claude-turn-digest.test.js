'use strict';
// #507 T2: Claude's `readTurnDigest` — its transcript as neutral messages, from one bounded tail read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fileStore = require('../src/backends/file-store');
const backends = require('../src/backends');
const claude = require('../src/backends/claude');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-digest-'));
test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function write(lines) {
  const file = path.join(dir, `t${n++}.jsonl`);
  fs.writeFileSync(file, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}
const user = (content, extra) => ({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content }, ...extra });
const assistant = (content, extra) => ({ type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content }, ...extra });

test('a small transcript is answered whole, not partial, as neutral messages', async () => {
  const file = write([
    user('fix the bug'),
    assistant([{ type: 'thinking', thinking: 'SECRET-REASONING' }, { type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'SECRET-TOOL-OUTPUT' }]),
    assistant([{ type: 'text', text: 'Done.' }]),
  ]);
  const res = await claude.readTurnDigest({ filePath: file }, {});
  assert.equal(res.partial, false);
  assert.deepEqual(res.messages.map(m => [m.role, m.text]), [['user', 'fix the bug'], ['assistant', 'Looking.'], ['assistant', 'Done.']]);
  assert.deepEqual(res.messages[1].tools, ['Read']);
  assert.equal(res.messages[0].at, '2026-01-01T00:00:00Z');
  const all = JSON.stringify(res);
  assert.ok(!all.includes('SECRET-REASONING') && !all.includes('SECRET-TOOL-OUTPUT'), 'thinking and tool results never reach text');
});

test('sidechain, meta and task-notification lines are not the conversation', async () => {
  const file = write([
    user('kept'),
    user('sidechain words', { isSidechain: true }),
    user('meta words', { isMeta: true }),
    user('<task-notification><task-id>x</task-id></task-notification>'),
    assistant([{ type: 'text', text: 'reply' }]),
  ]);
  const res = await claude.readTurnDigest({ filePath: file }, {});
  assert.deepEqual(res.messages.map(m => m.text), ['kept', 'reply']);
});

test('a transcript larger than the window is partial, reads at most the cap, and starts on a whole line', async () => {
  const filler = 'x'.repeat(2000);
  const lines = [];
  for (let i = 0; i < 400; i++) lines.push(user(`q${i} ${filler}`), assistant([{ type: 'text', text: `a${i}` }]));
  const file = write(lines);
  assert.ok(fs.statSync(file).size > fileStore.MAX_TAIL_BYTES);
  const asked = [];
  const real = fileStore.readFileTailAsync;
  fileStore.readFileTailAsync = (f, bytes) => { asked.push(bytes); return real(f, bytes); };
  let res;
  try { res = await claude.readTurnDigest({ filePath: file }, {}); } finally { fileStore.readFileTailAsync = real; }
  assert.deepEqual(asked, [fileStore.MAX_TAIL_BYTES], 'one read, at the cap');
  assert.equal(res.partial, true);
  assert.ok(res.messages.length > 0);
  assert.equal(res.messages[res.messages.length - 1].text, 'a399');
  // The cut first line is dropped, so the oldest message is a whole one.
  assert.match(res.messages[0].text, /^(q\d+ x{2000}|a\d+)$/);
});

test('maxMessages keeps the newest and says older ones were left out', async () => {
  const file = write([user('one'), assistant([{ type: 'text', text: 'two' }]), user('three')]);
  const res = await claude.readTurnDigest({ filePath: file }, { maxMessages: 2 });
  assert.deepEqual(res.messages.map(m => m.text), ['two', 'three']);
  assert.equal(res.partial, true);
});

test('a missing file, no row and an aborted signal answer null', async () => {
  assert.equal(await claude.readTurnDigest({ filePath: path.join(dir, 'gone.jsonl') }, {}), null);
  assert.equal(await claude.readTurnDigest(null, {}), null);
  const ac = new AbortController();
  ac.abort();
  assert.equal(await claude.readTurnDigest({ filePath: write([user('x')]) }, { signal: ac.signal }), null);
});

test('a template on Claude and claude-native forward the hook', () => {
  assert.equal(backends.get('claude-native').readTurnDigest, claude.readTurnDigest);
});
