'use strict';
// #705, #714: the message history viewer reads a Claude transcript through Claude's own normaliser, so the
// lines Claude injects under the user's role become the entries the conversation view draws for them, and a
// local command's output loses the terminal codes the transcript keeps.
const test = require('node:test');
const assert = require('node:assert/strict');

const view = require('../src/backends/claude/transcript-view');
const { localCommandOutput } = require('../src/backends/claude/session-reader');
const backends = require('../src/backends');

const ESC = String.fromCharCode(27);

test('a subagent report and a task end become the conversation view\'s entries', () => {
  const lines = [
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Agent', input: {} }] } },
    { type: 'user', uuid: 'r1', toolUseResult: { agentId: 'sub-1', status: 'async_launched' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'launched' }] } },
    { type: 'user', uuid: 'p1', isMeta: true, origin: { kind: 'peer', from: 'sub-1', senderTaskId: 'sub-1', handback: true, body: 'Intro.\nThe report follows:\n  Done.' },
      message: { role: 'user', content: 'Another Claude session sent a message: <agent-message from="sub-1">…</agent-message>' } },
    { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-2', name: 'Bash', input: {} }] } },
    { type: 'user', uuid: 'n1', origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<task-notification><task-id>t1</task-id><tool-use-id>call-2</tool-use-id><status>completed</status><summary>Background command "npm test" completed (exit code 0)</summary></task-notification>' } },
  ];
  const out = view.normalizeTranscriptEntries(lines);
  const report = out.find(e => e.type === 'agent-report');
  assert.equal(report.uuid, 'p1');
  assert.deepEqual([report._report.kind, report._report.subagentId, report._report.toolUseId, report._report.text], ['report', 'sub-1', 'call-1', 'Done.']);
  const notice = out.find(e => e.type === 'task-notice');
  assert.deepEqual([notice._task.id, notice._task.kind, notice._task.description, notice._task.exitCode, notice._task.historic],
    ['t1', 'shell', 'npm test', 0, true]);
  assert.equal(out.length, lines.length, 'nothing else is dropped: the history viewer shows the whole file');
});

test('a slash command reads as what was typed, and its output as text without terminal codes (#714)', () => {
  const out = view.normalizeTranscriptEntries([
    { type: 'user', uuid: 'c1', message: { role: 'user', content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>' } },
    { type: 'user', uuid: 'o1', message: { role: 'user', content: `<local-command-stdout>${ESC}[2mCompacted ${ESC}[22m</local-command-stdout>` } },
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'a prompt' } },
    { type: 'user', uuid: 'm1', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat</local-command-caveat>' } },
  ]);
  assert.deepEqual(out.map(e => [e.uuid, e.message.content]), [
    ['c1', '/compact'], ['o1', 'Compacted'], ['u1', 'a prompt'], ['m1', '<local-command-caveat>Caveat</local-command-caveat>'],
  ]);
  assert.equal(localCommandOutput(`<local-command-stderr>${ESC}[31mfailed${ESC}[0m</local-command-stderr>`), 'failed');
  // A command that printed nothing keeps its place, empty: the viewer's bookmarks are keyed on positions.
  const kept = view.normalizeTranscriptEntries([
    { type: 'user', uuid: 'e1', message: { role: 'user', content: '<local-command-stdout></local-command-stdout>' } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: 'next' } },
  ]);
  assert.deepEqual(kept.map(e => [e.uuid, e.message.content]), [['e1', ''], ['u2', 'next']]);
});

test('a local command written as a system line reads as the conversation view reads it (#714)', () => {
  const out = view.normalizeTranscriptEntries([
    { type: 'system', subtype: 'local_command', uuid: 's1', content: `<local-command-stdout>${ESC}[1mContext Usage${ESC}[22m</local-command-stdout>` },
    { type: 'system', subtype: 'local_command', uuid: 's2', content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>' },
    { type: 'system', subtype: 'local_command', uuid: 's3', content: '<local-command-stdout></local-command-stdout>' },
  ]);
  assert.deepEqual(out.map(e => [e.uuid, e.type, JSON.stringify(e.message.content)]), [
    ['s1', 'assistant', JSON.stringify([{ type: 'text', text: 'Context Usage' }])],
    ['s2', 'user', JSON.stringify('/model opus')],
    ['s3', 'user', JSON.stringify('')],
  ]);
});

test('Claude and claude-native answer the history viewer\'s hook with the one normaliser', () => {
  assert.equal(backends.get('claude').normalizeTranscriptEntries, view.normalizeTranscriptEntries);
  assert.equal(backends.get('claude-native').normalizeTranscriptEntries, view.normalizeTranscriptEntries);
});

// The derivations moved here from claude-native's decoder (#705); a copy back beside the decoder is how two
// views would start reading the same line differently again.
test('claude-native defines none of the shared derivations itself', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { stripComments } = require('./helpers/strip-comments');
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'backends', 'claude-native', 'rpc-protocol.js'), 'utf8'));
  for (const name of Object.keys(view)) {
    assert.doesNotMatch(src, new RegExp(`(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=)`), `${name} is defined again in claude-native`);
  }
});
