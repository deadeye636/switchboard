'use strict';
// #507 T3: Codex' `readTurnDigest` — its rollout as neutral messages, from one bounded tail read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fileStore = require('../src/backends/file-store');
const codex = require('../src/backends/codex');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-turn-digest-'));
test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function write(lines) {
  const file = path.join(dir, `rollout-${n++}.jsonl`);
  fs.writeFileSync(file, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}
const item = (payload, ts = '2026-01-01T00:00:00Z') => ({ timestamp: ts, type: 'response_item', payload });
const msg = (role, text, ts) => item({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] }, ts);

test('a small rollout is answered whole, not partial, as neutral messages', async () => {
  const file = write([
    { timestamp: '2026-01-01T00:00:00Z', type: 'session_meta', payload: { id: 'x', cwd: '/p' } },
    msg('developer', 'SECRET-DEVELOPER-PREAMBLE'),
    msg('user', '# AGENTS.md instructions for /p\n<INSTRUCTIONS>SECRET-INJECTED</INSTRUCTIONS>'),
    msg('user', 'fix the bug', '2026-01-01T00:00:01Z'),
    item({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'SECRET-REASONING' }] }),
    item({ type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' }),
    item({ type: 'function_call_output', call_id: 'c1', output: 'SECRET-TOOL-OUTPUT' }),
    { timestamp: '2026-01-01T00:00:02Z', type: 'event_msg', payload: { type: 'token_count', info: null } },
    { timestamp: '2026-01-01T00:00:02Z', type: 'future_kind', payload: { type: 'message', role: 'user', content: 'UNKNOWN-KIND' } },
    msg('assistant', 'Done.', '2026-01-01T00:00:03Z'),
  ]);
  const res = await codex.readTurnDigest({ filePath: file }, {});
  assert.equal(res.partial, false);
  assert.deepEqual(res.messages.map(m => [m.role, m.text]), [['user', 'fix the bug'], ['assistant', ''], ['assistant', 'Done.']]);
  assert.deepEqual(res.messages[1].tools, ['shell']);
  assert.equal(res.messages[0].at, '2026-01-01T00:00:01Z');
  const all = JSON.stringify(res);
  for (const s of ['SECRET-DEVELOPER-PREAMBLE', 'SECRET-INJECTED', 'SECRET-REASONING', 'SECRET-TOOL-OUTPUT', 'UNKNOWN-KIND']) {
    assert.ok(!all.includes(s), `${s} never reaches the digest`);
  }
});

test('a rollout larger than the window is partial, reads at most the cap, and starts on a whole line', async () => {
  const filler = 'x'.repeat(2000);
  const lines = [];
  for (let i = 0; i < 400; i++) lines.push(msg('user', `q${i} ${filler}`), msg('assistant', `a${i}`));
  const file = write(lines);
  assert.ok(fs.statSync(file).size > fileStore.MAX_TAIL_BYTES);
  const asked = [];
  const real = fileStore.readFileTailAsync;
  fileStore.readFileTailAsync = (f, bytes) => { asked.push(bytes); return real(f, bytes); };
  let res;
  try { res = await codex.readTurnDigest({ filePath: file }, {}); } finally { fileStore.readFileTailAsync = real; }
  assert.deepEqual(asked, [fileStore.MAX_TAIL_BYTES], 'one read, at the cap');
  assert.equal(res.partial, true);
  assert.equal(res.messages[res.messages.length - 1].text, 'a399');
  assert.match(res.messages[0].text, /^(q\d+ x{2000}|a\d+)$/);
});

test('maxMessages keeps the newest and says older ones were left out', async () => {
  const file = write([msg('user', 'one'), msg('assistant', 'two'), msg('user', 'three')]);
  const res = await codex.readTurnDigest({ filePath: file }, { maxMessages: 2 });
  assert.deepEqual(res.messages.map(m => m.text), ['two', 'three']);
  assert.equal(res.partial, true);
});

test('a missing file, no row and an aborted signal answer null', async () => {
  assert.equal(await codex.readTurnDigest({ filePath: path.join(dir, 'gone.jsonl') }, {}), null);
  assert.equal(await codex.readTurnDigest(null, {}), null);
  const ac = new AbortController();
  ac.abort();
  assert.equal(await codex.readTurnDigest({ filePath: write([msg('user', 'x')]) }, { signal: ac.signal }), null);
});
