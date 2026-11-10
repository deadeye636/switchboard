'use strict';
// src/app/process-usage.js (#834): a session's process tree with CPU and memory, one shared sample for all sessions.
const test = require('node:test');
const assert = require('node:assert/strict');

const usage = require('../src/app/process-usage');

const sessions = (entries) => () => new Map(entries.map(([id, pid]) => [id, { pty: { pid } }]));

// A fake of @vscode/windows-process-tree: the list of process.pid's descendants and the CPU pass over it.
function fakeTree(list, cpuOf = () => 1) {
  const calls = { list: 0, cpu: 0 };
  return {
    calls,
    ProcessDataFlag: { Memory: 1 },
    getProcessList(root, cb, flags) { calls.list++; calls.root = root; calls.flags = flags; setImmediate(() => cb(list)); },
    getProcessCpuUsage(l, cb) { calls.cpu++; setImmediate(() => cb(l.map((p) => ({ ...p, cpu: cpuOf(p) })))); },
  };
}

const LIST = [
  { pid: 10, ppid: process.pid, name: 'pwsh.exe', memory: 100 },
  { pid: 11, ppid: 10, name: 'claude.exe', memory: 300 },
  { pid: 12, ppid: 11, name: 'node.exe', memory: 50 },
  { pid: 20, ppid: process.pid, name: 'bash.exe', memory: 10 },
  { pid: 30, ppid: process.pid, name: 'conhost.exe', memory: 5 },
];

test('cpu time and ps output: every spelling ps uses, a path name, a name with spaces', () => {
  assert.equal(usage.parseCpuTime('00:01'), 1);
  assert.equal(usage.parseCpuTime('1:02:03'), 3723);
  assert.equal(usage.parseCpuTime('2-00:00:01'), 172801);
  assert.equal(usage.parseCpuTime('0:01.50'), 1.5);
  assert.equal(usage.parseCpuTime('garbage'), null);
  const rows = usage.parsePsOutput('  10     1  2048 00:00:02 /usr/bin/zsh\n  11    10   512 0:01.00 Code Helper (Renderer)\nbad line\n');
  assert.deepEqual(rows, [
    { pid: 10, ppid: 1, memory: 2048 * 1024, time: 2, name: 'zsh' },
    { pid: 11, ppid: 10, memory: 512 * 1024, time: 1, name: 'Code Helper (Renderer)' },
  ]);
});

test('a session is its root and everything under it, in tree order with a depth; another session is not in it', () => {
  const procs = new Map(LIST.map((p) => [p.pid, { ...p, cpu: p.pid === 11 ? 2.5 : 0.5 }]));
  const out = usage.sessionUsage(procs, [['a', 10], ['b', 20], ['gone', 99], ['none', null]]);
  assert.deepEqual(out.a.rows.map((r) => [r.pid, r.depth]), [[10, 0], [11, 1], [12, 2]]);
  assert.deepEqual(out.a.total, { cpu: 3.5, memory: 450, count: 3 });
  assert.equal(out.a.running, true);
  assert.deepEqual(out.b.rows.map((r) => r.pid), [20]);
  assert.deepEqual(out.gone, { running: false, total: { cpu: null, memory: 0, count: 0 }, rows: [], truncated: false });
  assert.equal(out.none.running, false);
});

test('a tree past the row cap keeps its total and says it is cut', () => {
  const procs = new Map([[1, { pid: 1, ppid: 0, name: 'root', memory: 1, cpu: 0 }]]);
  for (let i = 2; i < 2 + usage.MAX_ROWS + 5; i++) procs.set(i, { pid: i, ppid: 1, name: 'child', memory: 1, cpu: 0 });
  const out = usage.sessionUsage(procs, [['s', 1]]);
  assert.equal(out.s.rows.length, usage.MAX_ROWS);
  assert.equal(out.s.total.count, usage.MAX_ROWS + 6, 'the root and every child');
  assert.equal(out.s.truncated, true);
});

test('Windows: one list from this process and one CPU pass, shared by requests that come together or soon after', async () => {
  const tree = fakeTree(LIST);
  usage.init({ platform: 'win32', nativeTree: tree, activeSessions: sessions([['a', 10], ['b', 20]]) });
  const [one, two] = await Promise.all([usage.usageOf(['a']), usage.usageOf(['b'])]);
  const three = await usage.usageOf(['a', 'b']);
  assert.equal(tree.calls.list, 1, 'one sample for three requests');
  assert.equal(tree.calls.cpu, 1);
  assert.equal(tree.calls.root, process.pid);
  assert.equal(tree.calls.flags, 1, 'memory is asked for');
  assert.equal(one.supported, true);
  assert.deepEqual(one.sessions.a.rows.map((r) => r.name), ['pwsh.exe', 'claude.exe', 'node.exe']);
  assert.deepEqual(Object.keys(two.sessions), ['b']);
  assert.deepEqual(Object.keys(three.sessions), ['a', 'b']);
});

test('Windows without the native module answers that it is not installed, and nothing throws', async () => {
  usage.init({ platform: 'win32', nativeTree: null, activeSessions: sessions([['a', 10]]) });
  const res = await usage.usageOf(['a']);
  assert.equal(res.ok, true);
  assert.equal(res.supported, false);
  assert.match(res.message, /not installed/);
});

test('ps: CPU is the time used between two samples as a share of all cores; the first sample has none', async () => {
  let n = 0;
  const outputs = ['  10 1 1000 00:00:01 bash\n  11 10 2000 00:00:00 node\n', '  10 1 1000 00:00:01 bash\n  11 10 2000 00:00:03 node\n'];
  const run = (file, args, opts, cb) => {
    assert.equal(file, 'ps');
    assert.deepEqual(args, ['-A', '-o', 'pid=,ppid=,rss=,time=,comm=']);
    const out = outputs[n++];
    setImmediate(() => cb(null, out));
    return { stdin: { end() {} } };
  };
  usage.init({ platform: 'linux', execFile: run, activeSessions: sessions([['a', 10]]) });
  const first = await usage.usageOf(['a']);
  assert.equal(first.sessions.a.total.cpu, null, 'no CPU before a second sample');
  assert.equal(first.sessions.a.total.memory, 3000 * 1024);
  await new Promise((r) => setTimeout(r, usage.REUSE_MS + 50));
  const second = await usage.usageOf(['a']);
  assert.ok(second.sessions.a.rows[1].cpu > 0, 'node used CPU in between');
  assert.equal(second.sessions.a.rows[0].cpu, 0, 'bash did not');
});

test('a native call that never answers, or throws in its callback, fails the sample and frees the next one', async () => {
  let answer = 'never';
  const tree = {
    ProcessDataFlag: { Memory: 1 },
    getProcessList(root, cb) {
      if (answer === 'never') return;
      setImmediate(() => cb(LIST));
    },
    getProcessCpuUsage(l, cb) {
      setImmediate(() => { try { cb(null); } catch { /* the module's own thread */ } });
    },
  };
  usage.init({ platform: 'win32', nativeTree: tree, nativeTimeoutMs: 30, activeSessions: sessions([['a', 10]]), log: { debug() {}, warn() {}, info() {} } });
  const hung = await usage.usageOf(['a']);
  assert.equal(hung.ok, false, 'a callback that never comes is given up');
  answer = 'now';
  const next = await usage.usageOf(['a']);
  assert.equal(next.ok, true, 'and the next request is not stuck behind it');
  assert.deepEqual(next.sessions.a.rows.map((r) => r.pid), [10, 11, 12], 'a CPU pass with no list keeps the list');

  const throwing = { ProcessDataFlag: { Memory: 1 }, getProcessList() { throw new Error('native boom'); }, getProcessCpuUsage() {} };
  usage.init({ platform: 'win32', nativeTree: throwing, activeSessions: sessions([['a', 10]]), log: { debug() {}, warn() {}, info() {} } });
  assert.equal((await usage.usageOf(['a'])).ok, false, 'a throw is an answer, not an uncaught exception');
});

test('a ps baseline older than the bound gives no CPU instead of a long average', async () => {
  let n = 0;
  const outputs = ['  10 1 1000 00:00:00 bash\n', '  10 1 1000 00:01:00 bash\n'];
  const run = (file, args, opts, cb) => { const out = outputs[n++]; setImmediate(() => cb(null, out)); return { stdin: { end() {} } }; };
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    usage.init({ platform: 'linux', execFile: run, activeSessions: sessions([['a', 10]]) });
    await usage.usageOf(['a']);
    now += 60 * 60 * 1000;
    const later = await usage.usageOf(['a']);
    assert.equal(later.sessions.a.rows[0].cpu, null);
  } finally { Date.now = realNow; }
});

test('a failed sample is worded, never the raw error', async () => {
  const run = (file, args, opts, cb) => { setImmediate(() => cb(new Error('spawn ps failed in /secret/path'))); return { stdin: { end() {} } }; };
  usage.init({ platform: 'darwin', execFile: run, activeSessions: sessions([]), log: { debug() {}, warn() {}, info() {} } });
  const res = await usage.usageOf(['a']);
  assert.equal(res.ok, false);
  assert.ok(!res.error.includes('/secret/path'), 'no raw text');
});

test('registerIpc binds process-usage and passes the ids through', async () => {
  usage.init({ platform: 'win32', nativeTree: fakeTree(LIST), activeSessions: sessions([['a', 10]]) });
  const handlers = {};
  usage.registerIpc({ handle: (name, fn) => { handlers[name] = fn; } });
  const res = await handlers['process-usage']({}, ['a', 42, '']);
  assert.deepEqual(Object.keys(res.sessions), ['a']);
});
