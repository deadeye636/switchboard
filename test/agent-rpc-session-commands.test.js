'use strict';
// The session commands a runtime-driven session answers through the APP rather than inside the runtime
// (#643): the figures, the export and the copy. Driven against a real child on a real pipe through the
// shared harness — see `test/helpers/agent-rpc-harness.js` for why these live in a file of their own.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { harness, stopped, tempDataDir, until, agentRpc, SESSION_CWD } = require('./helpers/agent-rpc-harness');

// #646 — the tree is read over the protocol and handed to the view as rows; the move is asked of the
// runtime and its outcome re-reads the conversation, because moving the leaf is not a turn.
test('/tree hands the view the backend\'s rows, and a move re-reads the conversation', async (t) => {
  const h = harness();
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  await agentRpc.sendTurn('fake-session', { text: 'one', mode: 'prompt' });
  await until(() => h.signals.filter(s => s.kind === 'idle').length === 1);
  await agentRpc.sendTurn('fake-session', { text: 'two', mode: 'prompt' });
  await until(() => h.signals.filter(s => s.kind === 'idle').length === 2);

  await agentRpc.sendTurn('fake-session', { text: '/tree', mode: 'prompt' });
  await until(() => h.sent.some(m => m.op && m.op.op === 'branchTree' && m.op.rows));
  const tree = h.sent.find(m => m.op && m.op.op === 'branchTree').op;
  assert.deepEqual(tree.rows.map(r => [r.id, r.kind, r.current]), [['u1', 'user', false], ['a1', 'assistant', false], ['u2', 'user', false], ['a2', 'assistant', true]]);
  assert.equal(h.sent.filter(m => m.op && m.op.op === 'branchTree').length, 1, 'the request op is answered here, not passed on');

  const res = await agentRpc.navigateBranch('fake-session', 'u2', { summarize: false });
  assert.deepEqual(res, { ok: true });
  await until(() => h.sent.some(m => m.op && m.op.op === 'draft'));
  const after = h.sent.map(m => m.op).filter(Boolean);
  const reset = after.filter(o => o.op === 'reset').pop();
  assert.equal(reset.entries.length, 2, 'the conversation is read again, on the branch the session now stands on');
  assert.equal(after.find(o => o.op === 'draft').text, 'two', 'the picked message comes back for editing');
  assert.match(after.filter(o => o.op === 'notice').pop().text, /Switched to another point/);
  assert.ok(!after.some(o => o.op === 'navigated'), 'the outcome op is answered here too');
});

test('a move is refused for no point, and a failed one says why without re-reading', async (t) => {
  const h = harness();
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  assert.equal((await agentRpc.navigateBranch('fake-session', '', {})).ok, false);
  assert.equal((await agentRpc.navigateBranch('nobody', 'a1', {})).ok, false);
  assert.deepEqual(await agentRpc.navigateBranch('fake-session', 'gone', { summarize: true }), { ok: true });
  await until(() => h.sent.some(m => m.op && m.op.op === 'notice' && /no longer in the session/.test(m.op.text || '')));
  const ops = h.sent.map(m => m.op).filter(Boolean);
  assert.ok(ops.some(o => o.op === 'notice' && /Summarising/.test(o.text)), 'a summary says it is working first');
  assert.ok(!ops.some(o => o.op === 'reset'), 'nothing moved, so nothing is re-read');
});

test('the session\'s figures are fetched by the core and drawn as a notice', async (t) => {
  const h = harness();
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  await agentRpc.sendTurn('fake-session', { text: '/session', mode: 'prompt' });
  await until(() => h.sent.some(m => m.op && m.op.op === 'notice'));
  const notice = h.sent.filter(m => m.op && m.op.op === 'notice').pop().op;
  assert.equal(notice.level, 'info');
  assert.match(notice.text, /^As Pi counts this session: /, 'the source of the figures is named');
  assert.match(notice.text, /2 messages, 1 of them yours and 1 the agent's · 0 tool calls/);
  assert.match(notice.text, /150 tokens \(120 in, 30 out,/);
  assert.match(notice.text, /\$0\.0021/);
  assert.ok(!h.sent.some(m => m.op && m.op.op === 'figures'), 'the request op is answered here, never sent on');
});

// #643 — the same split as the figures, for the two commands whose ANSWER is not the runtime's: where a
// file belongs is the app's question, and a clipboard belongs to the machine.
test('a file of the session lands where the app decided, and the notice offers to open it', async (t) => {
  const dataDir = tempDataDir(t);
  const h = harness({ dataDir });
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  await agentRpc.sendTurn('fake-session', { text: 'hello', mode: 'prompt' });
  await until(() => h.signals.some(s => s.kind === 'idle'));

  await agentRpc.sendTurn('fake-session', { text: '/export', mode: 'prompt' });
  await until(() => h.sent.some(m => m.op && m.op.op === 'notice' && /Session written/.test(m.op.text || '')));
  const notice = h.sent.filter(m => m.op && m.op.op === 'notice').pop().op;
  const written = path.resolve(notice.files[0].path);
  assert.equal(path.dirname(written), path.join(dataDir, 'exports'),
    'nobody named a path, so it went to the app and not into the session\'s own directory');
  assert.match(path.basename(written), /^pi-session-.*\.html$/, 'and the backend named the file');
  assert.equal(fs.existsSync(path.dirname(written)), true, 'the directory was made rather than hoped for');
  assert.ok(!h.sent.some(m => m.op && m.op.op === 'exportFile'), 'the request op is answered here, never sent on');
});

test('a path the user named is taken as given, resolved against the session\'s own directory', async (t) => {
  const h = harness({ dataDir: tempDataDir(t) });
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  await agentRpc.sendTurn('fake-session', { text: 'hello', mode: 'prompt' });
  await until(() => h.signals.some(s => s.kind === 'idle'));

  await agentRpc.sendTurn('fake-session', { text: '/export notes.html', mode: 'prompt' });
  await until(() => h.sent.some(m => m.op && m.op.op === 'notice' && /Session written/.test(m.op.text || '')));
  const notice = h.sent.filter(m => m.op && m.op.op === 'notice').pop().op;
  assert.equal(notice.files[0].path, path.join(SESSION_CWD, 'notes.html'),
    'the session\'s directory is what a relative name means, the way a shell would read it');
});

test('an empty session is refused in the runtime\'s own words, with no file to open', async (t) => {
  const h = harness({ dataDir: tempDataDir(t) });
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  await agentRpc.sendTurn('fake-session', { text: '/export', mode: 'prompt' });
  await until(() => h.sent.some(m => m.op && m.op.op === 'notice'));
  const notice = h.sent.filter(m => m.op && m.op.op === 'notice').pop().op;
  assert.equal(notice.level, 'error');
  assert.match(notice.text, /Nothing to export yet/);
  assert.equal(notice.files, undefined, 'no file means no button rather than a button to nowhere');
});

// The one sentence the CORE words rather than the backend, so it is the one that can go unread.
test('a session with nowhere to write is told so, and nothing is sent to the runtime', async (t) => {
  const h = harness();   // no dataDir: the app cannot name a directory
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  await agentRpc.sendTurn('fake-session', { text: '/export', mode: 'prompt' });
  await until(() => h.sent.some(m => m.op && m.op.op === 'notice'));
  const notice = h.sent.filter(m => m.op && m.op.op === 'notice').pop().op;
  assert.equal(notice.level, 'error');
  assert.match(notice.text, /could not decide where to write/);
  assert.equal(notice.files, undefined);
});

// A parent that does not exist comes back from the runtime as an errno, which reads as a failed export
// rather than as a missing folder — so the app makes the directory for a path the user named too.
test('a user-named path in a directory that does not exist is still written', async (t) => {
  const dataDir = tempDataDir(t);
  const h = harness({ dataDir });
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  await agentRpc.sendTurn('fake-session', { text: 'hello', mode: 'prompt' });
  await until(() => h.signals.some(s => s.kind === 'idle'));

  const target = path.join(dataDir, 'not', 'there', 'yet.html');
  await agentRpc.sendTurn('fake-session', { text: `/export ${target}`, mode: 'prompt' });
  await until(() => h.sent.some(m => m.op && m.op.op === 'notice' && /Session written/.test(m.op.text || '')));
  assert.equal(fs.existsSync(path.dirname(target)), true, 'the directory was made rather than left to fail');
  assert.equal(h.sent.filter(m => m.op && m.op.op === 'notice').pop().op.files[0].path, target);
});

// A `~` the user typed is their home directory. Left alone it would become a directory CALLED `~`
// inside the project — the outcome the default branch exists to avoid, reached by a shell-shaped path.
test('a leading ~ is the user\'s home directory, not a folder in the project', async (t) => {
  const h = harness({ dataDir: tempDataDir(t) });
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  await agentRpc.sendTurn('fake-session', { text: 'hello', mode: 'prompt' });
  await until(() => h.signals.some(s => s.kind === 'idle'));

  await agentRpc.sendTurn('fake-session', { text: '/export ~/switchboard-export-test.html', mode: 'prompt' });
  await until(() => h.sent.some(m => m.op && m.op.op === 'notice' && /Session written/.test(m.op.text || '')));
  const written = h.sent.filter(m => m.op && m.op.op === 'notice').pop().op.files[0].path;
  assert.equal(written, path.join(os.homedir(), 'switchboard-export-test.html'));
  assert.equal(written.includes('~'), false, 'no literal tilde survives into a path');
  // The fixture only echoes the path back, so nothing was written anywhere; the assertion is about
  // what the app ASKED for.
});

test('the last reply is put on the clipboard by the app, and the backend says what happened', async (t) => {
  const h = harness({ dataDir: tempDataDir(t) });
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);

  // Nothing has been said yet: a real answer, and not an error.
  await agentRpc.sendTurn('fake-session', { text: '/copy', mode: 'prompt' });
  await until(() => h.sent.some(m => m.op && m.op.op === 'notice'));
  const empty = h.sent.filter(m => m.op && m.op.op === 'notice').pop().op;
  assert.equal(empty.level, 'info');
  assert.match(empty.text, /nothing to copy/);
  assert.deepEqual(h.clipped, [], 'and the clipboard was left alone');

  await agentRpc.sendTurn('fake-session', { text: 'hello', mode: 'prompt' });
  await until(() => h.signals.some(s => s.kind === 'idle'));
  await agentRpc.sendTurn('fake-session', { text: '/copy', mode: 'prompt' });
  await until(() => h.clipped.length === 1);
  assert.deepEqual(h.clipped, ['pong']);
  const done = h.sent.filter(m => m.op && m.op.op === 'notice').pop().op;
  assert.match(done.text, /on the clipboard \(1 line\)/);
  assert.ok(!h.sent.some(m => m.op && m.op.op === 'lastReply'), 'the request op is answered here, never sent on');
});

// #643 — a `!` line. The runtime runs it, because its own shell is what books the output into the
// session's context; this process starts it, draws it as it goes, and can stop it.
