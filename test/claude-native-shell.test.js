'use strict';
// A `!` line in a claude-native session (#786). Claude's stream-json protocol has no shell command, so the app
// runs the line and the next prompt carries it, as the text blocks Claude's terminal interface writes as lines of
// their own (measured on 2.1.285): a caveat, `<bash-input>`, `<bash-stdout>` + `<bash-stderr>`. Tested here: the
// grammar in both directions, every reader that meets such a prompt, and the whole path through a session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const protocol = require('../src/backends/claude-native/rpc-protocol');
const { shellPreface, readSessionFile } = require('../src/backends/claude/session-reader');
const { normalizeTranscriptEntries } = require('../src/backends/claude/transcript-view');
const { harness, stopped, until, agentRpc, tempDataDir, SESSION_CWD } = require('./helpers/agent-rpc-harness');
const claude = require('../src/backends/claude');
const native = require('../src/backends/claude-native');
const { encodeProjectPath } = require('../src/session/encode-project-path');

const RAN = { command: 'git status', stdout: 'nothing to commit\n', stderr: '', exitCode: 0, cancelled: false, truncated: false, failed: false };

test('a `!` line is the app\'s; `!!`, a bare `!` and a prompt are not', () => {
  assert.deepEqual(protocol.appCommandOp('!git status'), { op: 'shell', command: 'git status' });
  assert.deepEqual(protocol.appCommandOp('  ! ls -la  '), { op: 'shell', command: 'ls -la' });
  assert.equal(protocol.appCommandOp('!!ls'), null);
  assert.equal(protocol.appCommandOp('!'), null);
  assert.equal(protocol.appCommandOp('run ls'), null);
  assert.deepEqual(protocol.appCommandOp('/mcp'), { op: 'servers' }, 'the command it answered before still is');
});

test('a finished line is worded from what it wrote and how it ended', () => {
  assert.deepEqual(protocol.shellLineResult(RAN), { status: 'done', output: 'nothing to commit' });
  assert.deepEqual(protocol.shellLineResult({ ...RAN, stderr: 'fatal: nope\n', exitCode: 128 }),
    { status: 'error', output: 'nothing to commit\nfatal: nope\nExit code 128' });
  assert.equal(protocol.shellLineResult({ ...RAN, cancelled: true }).status, 'cancelled');
  assert.match(protocol.shellLineResult({ ...RAN, cancelled: true }).output, /\[cancelled\]$/);
  assert.deepEqual(protocol.shellLineResult({ command: 'x', stdout: '', stderr: '', exitCode: null, failed: true }),
    { status: 'error', output: 'The shell could not be started.' });
  const long = protocol.shellLineResult({ ...RAN, stdout: 'a'.repeat(50000) + 'END' });
  assert.ok(long.output.length < 31000, 'cut to what the model is sent');
  assert.match(long.output, /characters cut/);
  assert.ok(long.output.endsWith('END'), 'keeping the end, where a run says how it went');
});

test('a `/` line does not carry the lines; a prompt does', () => {
  assert.equal(protocol.carriesShellLines('/compact'), false);
  assert.equal(protocol.carriesShellLines('  /cost'), false);
  assert.equal(protocol.carriesShellLines('what did that print?'), true);
});

test('the turn opens with the shell lines, in the terminal interface\'s order, and reads back the same', () => {
  const line = protocol.sendCommand({ text: 'explain', mode: 'prompt', shellLines: [RAN, { ...RAN, command: 'ls', stdout: 'a.txt' }] });
  const content = line.message.content;
  assert.ok(Array.isArray(content));
  assert.match(content[0].text, /^<local-command-caveat>The command below was run directly in Claude Code/);
  assert.equal(content[1].text, '<bash-input>git status</bash-input>');
  assert.equal(content[2].text, '<bash-stdout>nothing to commit\n</bash-stdout><bash-stderr></bash-stderr>');
  assert.equal(content[3].text, '<bash-input>ls</bash-input>');
  assert.deepEqual(content[content.length - 1], { type: 'text', text: 'explain' }, 'the prompt last');

  const back = shellPreface(content);
  assert.deepEqual(back.lines, [{ cmd: 'git status', output: 'nothing to commit' }, { cmd: 'ls', output: 'a.txt' }]);
  assert.deepEqual(back.rest, [{ type: 'text', text: 'explain' }]);
  assert.equal(protocol.sendCommand({ text: 'plain', mode: 'prompt' }).message.content, 'plain', 'a turn with nothing to carry is unchanged');
});

test('what the terminal interface writes is not mistaken for a carried line', () => {
  assert.equal(shellPreface('<bash-input>ls</bash-input>'), null);
  assert.equal(shellPreface([{ type: 'text', text: 'hello <bash-input>ls</bash-input>' }]), null);
});

// Measured on 2.1.296: Claude does not play such a turn back at all, so the decoder draws the prompt itself, in
// front of the first thing the turn shows — the way it draws a `/` line.
test('a carrying turn that is not played back gets its prompt drawn by the decoder', () => {
  const decoder = protocol.createDecoder();
  const written = protocol.sendCommand({ text: 'explain', mode: 'prompt', shellLines: [RAN] });
  decoder.noteSent(written);
  decoder.decode({ type: 'system', subtype: 'init', session_id: 's1' });
  const ops = decoder.decode({ type: 'assistant', uuid: 'a1', session_id: 's1', message: { role: 'assistant', content: [{ type: 'text', text: '128' }] } });
  const appends = ops.filter(o => o.op === 'append');
  assert.equal(appends.length, 2);
  assert.equal(appends[0].entry.prompt, true);
  assert.equal(appends[0].entry.message.content, 'explain', 'the prompt, without the shell lines');
  assert.equal(appends[1].entry.uuid, 'a1');
});

test('should a carrying turn be played back after all, its prompt is drawn once, without the lines', () => {
  const decoder = protocol.createDecoder();
  const written = protocol.sendCommand({ text: 'explain', mode: 'prompt', shellLines: [RAN] });
  decoder.noteSent(written);
  decoder.decode({ type: 'system', subtype: 'init', session_id: 's1' });
  const ops = decoder.decode({ type: 'user', uuid: 'u1', isReplay: true, session_id: 's1', message: written.message });
  const appends = ops.filter(o => o.op === 'append');
  assert.equal(appends.length, 1, 'one entry, and no second copy of the prompt drawn as a due line');
  assert.equal(appends[0].entry.uuid, 'u1');
  assert.equal(appends[0].entry.prompt, true);
  assert.equal(appends[0].entry.message.content, 'explain');
});

test('an attach draws each carried line, then the prompt under its own key', () => {
  const written = protocol.sendCommand({ text: 'explain', mode: 'prompt', shellLines: [RAN] });
  const entries = protocol.conversationEntries([{ type: 'user', uuid: 'u1', message: written.message }]);
  assert.deepEqual(entries.map(e => e.type), ['local-command', 'user']);
  assert.deepEqual(entries[0]._localCmd, { cmd: 'git status', output: 'nothing to commit' });
  assert.equal(protocol.entryKey(entries[0]), 'u1:shell:0');
  assert.equal(protocol.entryKey(entries[1]), 'u1', 'the key its live replay was drawn under');
  assert.equal(entries[1].message.content, 'explain');
});

test('the history viewer gets one entry: the lines as shell blocks, then the prompt', () => {
  const written = protocol.sendCommand({ text: 'explain', mode: 'prompt', shellLines: [RAN] });
  const out = normalizeTranscriptEntries([{ type: 'user', uuid: 'u1', message: written.message }]);
  assert.equal(out.length, 1, 'one entry per line, for the viewer\'s bookmarks');
  const blocks = out[0].message.content;
  assert.deepEqual(blocks[0]._localCmd, { cmd: 'git status', output: 'nothing to commit' });
  assert.ok(!/<bash-/.test(blocks.map(b => b.text).join('')), 'no markup left for the viewer to fold the prompt into');
  assert.equal(blocks[blocks.length - 1].text, 'explain');
});

test('the session reader takes the prompt, not the shell, as what the user wrote', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-claude-shell-'));
  try {
    const written = protocol.sendCommand({ text: 'explain the status', mode: 'prompt', shellLines: [RAN] });
    const file = path.join(dir, 'sess-shell.jsonl');
    fs.writeFileSync(file, [
      { type: 'user', uuid: 'u1', timestamp: '2026-10-13T09:00:00.000Z', message: written.message },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-10-13T09:00:05.000Z', message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'clean' }] } },
    ].map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    const s = readSessionFile(file, 'folder', '/some/project');
    assert.equal(s.summary, 'explain the status');
    assert.equal(s.userMessageCount, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The whole path, against the stand-in for Claude Code: the line runs in the app, the next prompt carries it, the
// replay is drawn as the prompt, and an attach afterwards reads the line back out of the transcript.
test('through a session: run, carry, replay, read back', async (t) => {
  const root = tempDataDir(t);
  const before = claude._roots();
  claude.setRoots([root]);
  t.after(() => claude.setRoots(before));
  const dir = path.join(root, encodeProjectPath(SESSION_CWD));
  fs.mkdirSync(dir, { recursive: true });
  const h = harness({ rpc: native.rpc, fixture: path.join(__dirname, 'fixtures', 'fake-claude-stream.js'), env: { FAKE_TRANSCRIPT_DIR: dir, FAKE_SESSION: 'sess-1', FAKE_TURN_MS: '0' } });
  t.after(() => stopped(h));
  const ops = () => h.sent.filter((m) => m.ch === 'agent-event').map((m) => m.op);

  assert.deepEqual(await agentRpc.sendTurn('launch-id', { text: '!echo native-shell', mode: 'prompt' }), { ok: true });
  await until(() => ops().some((o) => o.op === 'localCommand' && o.status !== 'running'));
  const done = ops().filter((o) => o.op === 'localCommand').pop();
  assert.equal(done.status, 'done');
  assert.match(done.output, /native-shell/);

  await agentRpc.sendTurn('launch-id', { text: 'what did it print?', mode: 'prompt' });
  await until(() => h.signals.some((s) => s.kind === 'idle'));
  const id = h.rekeys.length ? h.rekeys[h.rekeys.length - 1].to : 'launch-id';
  const prompts = ops().filter((o) => o.op === 'append' && o.entry.prompt);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].entry.message.content, 'what did it print?', 'drawn as what was typed');

  const snap = await agentRpc.attach(id);
  assert.equal(snap.ok, true);
  const shells = snap.entries.filter((e) => e.type === 'local-command');
  assert.equal(shells.length, 1, 'read back from the transcript, and not also from what the core held');
  assert.equal(shells[0]._localCmd.cmd, 'echo native-shell');
  assert.match(shells[0]._localCmd.output, /native-shell/);
});
