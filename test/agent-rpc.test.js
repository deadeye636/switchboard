'use strict';
// src/app/agent-rpc.js (#568) against a real child on a real pipe. The child is a stand-in for
// `pi --mode rpc` (test/fixtures/fake-rpc-agent.js) that answers the way Pi was measured to answer, and the
// protocol half is the runtime-driven Pi backend's own — so what is tested is the core moving a real
// backend's ops, not a mock agreeing with itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const agentRpc = require('../src/app/agent-rpc');
const piNative = require('../src/backends/pi-native');

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-rpc-agent.js');
const TAG = 'tag-1';

function harness({ dataDir } = {}) {
  const activeSessions = new Map();
  const sent = [];
  const signals = [];
  const rekeys = [];
  const clipped = [];
  const window = { isDestroyed: () => false, webContents: { send: (ch, id, op) => sent.push({ ch, id, op }) } };
  agentRpc.init({
    activeSessions,
    getMainWindow: () => window,
    windowForSession: () => window,
    getAppQuitting: () => false,
    // The re-key every live binding goes through, reduced to what it does to the map.
    adoptSessionId: (tag, id) => {
      for (const [key, s] of activeSessions) {
        if (s._terminalTag === tag && key !== id) {
          activeSessions.delete(key);
          activeSessions.set(id, s);
          s.realSessionId = id;
          rekeys.push({ from: key, to: id });
          return { from: key, to: id, kind: 'terminal' };
        }
      }
      return null;
    },
    deliverBindSignal: (sessionId, hook) => signals.push({ sessionId, ...hook }),
    // Electron's own parts arrive through ctx, which is what keeps this module loadable here at all.
    dataDir,
    clipboard: { writeText: (text) => clipped.push(text) },
    log: { info() {}, warn() {}, debug() {} },
  });
  const proc = agentRpc.start({
    tag: TAG, rpc: piNative.rpc, command: process.execPath, args: [FIXTURE], cwd: __dirname, env: process.env, label: 'Fake',
  });
  activeSessions.set('launch-id', { pty: proc, _terminalTag: TAG, exited: false });
  return { activeSessions, sent, signals, rekeys, clipped, proc };
}

const tempDataDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-agent-rpc-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the OS will */ } });
  return dir;
};

const until = async (cond, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 20));
  }
};

test('the session is re-keyed onto the id the runtime names, through the shared re-key', async (t) => {
  const h = harness();
  t.after(() => h.proc.kill());
  await until(() => h.rekeys.length === 1);
  assert.deepEqual(h.rekeys[0], { from: 'launch-id', to: 'fake-session' });
  assert.ok(h.activeSessions.has('fake-session'));
});

test('a typed line and a carriage return are a turn: busy, the ops, then idle through the bind-signal path', async (t) => {
  const h = harness();
  t.after(() => h.proc.kill());
  await until(() => h.rekeys.length === 1);
  // What the seed path, the trigger watcher and a launcher all write into a PTY — bracketed paste and CR.
  h.proc.write('\x1b[200~hello\x1b[201~\r');
  await until(() => h.signals.some(s => s.kind === 'idle'));
  const kinds = h.signals.map(s => s.kind);
  assert.deepEqual(kinds, ['busy', 'idle']);
  assert.equal(h.signals[0].turn_start, true, 'a started run is the turn start that releases a held Stop (#495)');
  assert.equal(h.signals[0].sessionId, 'fake-session');

  const ops = h.sent.filter(m => m.ch === 'agent-event').map(m => m.op);
  const appended = ops.filter(o => o.op === 'append').map(o => o.entry.message.role);
  assert.deepEqual(appended, ['user', 'assistant']);
  assert.ok(ops.some(o => o.op === 'busy' && o.busy === true));
  assert.ok(ops.some(o => o.op === 'busy' && o.busy === false));
  // Partials are coalesced, never reordered: whatever partial went out came before the finished turn.
  const lastPartial = ops.map(o => o.op).lastIndexOf('partial');
  const assistantAppend = ops.findIndex(o => o.op === 'append' && o.entry.message.role === 'assistant');
  assert.ok(lastPartial < assistantAppend || ops[lastPartial].entry === null);
});

test('attach answers the conversation from the runtime, and send/abort answer ok', async (t) => {
  const h = harness();
  t.after(() => h.proc.kill());
  await until(() => h.rekeys.length === 1);
  assert.deepEqual(await agentRpc.sendTurn('fake-session', { text: 'one', mode: 'prompt' }), { ok: true });
  await until(() => h.signals.some(s => s.kind === 'idle'));
  const snap = await agentRpc.attach('fake-session');
  assert.equal(snap.ok, true);
  assert.deepEqual(snap.entries.map(e => e.message.role), ['user', 'assistant']);
  assert.equal(snap.busy, false);
  assert.deepEqual(await agentRpc.abortTurn('fake-session'), { ok: true });
  assert.equal((await agentRpc.sendTurn('fake-session', { text: '   ' })).ok, false, 'an empty turn is refused here');
  assert.equal((await agentRpc.attach('nobody')).ok, false);
});

test('a question blocks until answered: it is reported as waiting, answered once, and gone', async (t) => {
  const h = harness();
  t.after(() => h.proc.kill());
  await until(() => h.rekeys.length === 1);
  await agentRpc.sendTurn('fake-session', { text: 'ask me', mode: 'prompt' });
  await until(() => h.sent.some(m => m.op && m.op.op === 'ask'));
  assert.ok(h.signals.some(s => s.kind === 'waiting' && s.prompt_kind === 'select'));
  const snap = await agentRpc.attach('fake-session');
  assert.equal(snap.asks.length, 1, 'a view mounted while it waits still gets the question');
  assert.deepEqual(agentRpc.answerAsk('fake-session', 'q1', { value: 'Allow once' }), { ok: true });
  assert.equal(agentRpc.answerAsk('fake-session', 'q1', { value: 'Allow once' }).ok, false, 'answered once');
  await until(() => h.sent.some(m => m.op && m.op.op === 'append' && /answered Allow once/.test(JSON.stringify(m.op.entry))));
});

// #642: a question one of pi-native's own commands asks belongs to the command, not to a run. Pi keeps waiting
// on it across a run that starts and settles meanwhile, so the app must too — and when Pi takes it back
// itself, the app closes it and the session stops waiting.
test('a command\'s question outlives a run, and closes when the runtime takes it back', async (t) => {
  const h = harness();
  t.after(() => h.proc.kill());
  await until(() => h.rekeys.length === 1);
  await agentRpc.sendTurn('fake-session', { text: 'command ask', mode: 'prompt' });
  await until(() => h.sent.some(m => m.op && m.op.op === 'ask'));
  await agentRpc.sendTurn('fake-session', { text: 'hello', mode: 'prompt' });
  await until(() => h.signals.some(s => s.kind === 'idle'));
  assert.equal((await agentRpc.attach('fake-session')).asks.length, 1, 'the run settling left it open');
  assert.equal(h.signals[h.signals.length - 1].kind, 'waiting', 'and the session is still waiting on the user');
  assert.ok(!h.sent.some(m => m.op && m.op.op === 'answered'));

  await agentRpc.sendTurn('fake-session', { text: 'take it back', mode: 'prompt' });
  await until(() => h.sent.some(m => m.op && m.op.op === 'answered' && m.op.id === 'c1'));
  assert.equal((await agentRpc.attach('fake-session')).asks.length, 0);
  assert.equal(h.signals[h.signals.length - 1].kind, 'idle');
  assert.equal(agentRpc.answerAsk('fake-session', 'c1', { value: 'a' }).ok, false, 'a question taken back cannot be answered');
});

// #643: the input's autocomplete asks the session through the backend's own protocol half — the command list
// in the app's words, one command's arguments (answered beside the prompt response), and the project's files.
test('the autocomplete: commands, a command\'s arguments, and paths inside the session\'s project', async (t) => {
  const h = harness();
  t.after(() => h.proc.kill());
  await until(() => h.rekeys.length === 1);
  const listed = await agentRpc.listCommands('fake-session');
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.commands.map(c => [c.name, c.kind, c.arguments]), [
    ['model', 'command', true], ['fix-tests', 'template', false], ['skill:search', 'skill', false],
  ], 'the internal completion command is not offered');
  const args = await agentRpc.completeArguments('fake-session', 'model');
  assert.deepEqual(args, { ok: true, items: [{ value: 'openai-codex/gpt-5.6-sol', description: 'GPT 5.6 (current)' }] });
  assert.ok(!h.sent.some(m => m.op && m.op.op === 'notice'), 'the answer is not drawn as a notice');
  const paths = await agentRpc.completeSessionPaths('fake-session', 'fixtures/fake-rpc');
  assert.deepEqual(paths.items, [{ value: 'fixtures/fake-rpc-agent.js', dir: false }], 'relative to the session\'s own directory');
  assert.deepEqual((await agentRpc.completeSessionPaths('fake-session', '../')).items, [], 'nothing outside it');
  assert.equal((await agentRpc.listCommands('nobody')).ok, false);
});

// #643 (W3): the command says only that it was typed, and the CORE fetches the figures over the protocol.
// The whole point of the route is that no number passes through the extension, so the check is that a
// request went out and a notice came back — with the backend's wording, which the core never writes.
test('the session\'s figures are fetched by the core and drawn as a notice', async (t) => {
  const h = harness();
  t.after(() => h.proc.kill());
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
  t.after(() => h.proc.kill());
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
  t.after(() => h.proc.kill());
  await until(() => h.rekeys.length === 1);
  await agentRpc.sendTurn('fake-session', { text: 'hello', mode: 'prompt' });
  await until(() => h.signals.some(s => s.kind === 'idle'));

  await agentRpc.sendTurn('fake-session', { text: '/export notes.html', mode: 'prompt' });
  await until(() => h.sent.some(m => m.op && m.op.op === 'notice' && /Session written/.test(m.op.text || '')));
  const notice = h.sent.filter(m => m.op && m.op.op === 'notice').pop().op;
  assert.equal(notice.files[0].path, path.join(__dirname, 'notes.html'),
    'the session\'s directory is what a relative name means, the way a shell would read it');
});

test('an empty session is refused in the runtime\'s own words, with no file to open', async (t) => {
  const h = harness({ dataDir: tempDataDir(t) });
  t.after(() => h.proc.kill());
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
  t.after(() => h.proc.kill());
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
  t.after(() => h.proc.kill());
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
  t.after(() => h.proc.kill());
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
  t.after(() => h.proc.kill());
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

test('a carriage return inside a bracketed paste is text: a pasted CRLF block is one turn', async (t) => {
  const h = harness();
  t.after(() => h.proc.kill());
  await until(() => h.rekeys.length === 1);
  h.proc.write('\x1b[200~line one\r\nline two\x1b[201~');
  h.proc.write('\r');
  await until(() => h.signals.some(s => s.kind === 'idle'));
  const users = h.sent.filter(m => m.op && m.op.op === 'append' && m.op.entry.message.role === 'user');
  assert.equal(users.length, 1);
  assert.match(JSON.stringify(users[0].op.entry), /line one\\nline two/);
});

test('ops are numbered, and attach says which number its snapshot was taken at', async (t) => {
  const h = harness();
  t.after(() => h.proc.kill());
  await until(() => h.rekeys.length === 1);
  await agentRpc.sendTurn('fake-session', { text: 'one', mode: 'prompt' });
  await until(() => h.signals.some(s => s.kind === 'idle'));
  const seqs = h.sent.filter(m => m.ch === 'agent-event').map(m => m.op.seq);
  assert.ok(seqs.length > 0 && seqs.every((n, i) => n === i + 1), 'numbered in the order they were sent');
  const snap = await agentRpc.attach('fake-session');
  assert.ok(snap.seq >= seqs[seqs.length - 1], 'a snapshot taken after them covers them');
});

test('kill ends the child and the exit handlers run — the path the stop and the quit rely on', async () => {
  const h = harness();
  let exited = null;
  h.proc.onExit((e) => { exited = e; });
  assert.ok(Number.isInteger(h.proc.pid));
  h.proc.kill();
  await until(() => exited !== null);
  assert.equal(typeof exited.exitCode, 'number');
});
