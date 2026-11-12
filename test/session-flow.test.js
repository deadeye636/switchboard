'use strict';
// The Flow tab's main-side module (spec 46, #826, plan T6): worker lifecycle, cancel and supersede, clean failures,
// quit, fingerprints, no path in any answer, the window hint, and one real worker run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { validateSnapshot, emptyFlowSnapshot } = require('../src/shared/flow-snapshot');
const { stripComments } = require('./helpers/strip-comments');
const sessionFlow = require('../src/app/session-flow');

const FIXTURE = path.join(__dirname, 'fixtures', 'flow', 'claude-main.jsonl');
const log = { debug() {}, info() {}, warn() {} };

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'session-flow-')); }

/** A worker that does nothing until the test drives it. */
function fakeWorkers() {
  const made = [];
  const create = (workerData, limits) => {
    const w = new EventEmitter();
    w.workerData = workerData; w.limits = limits; w.terminated = 0;
    w.terminate = () => { w.terminated++; return Promise.resolve(); };
    made.push(w);
    return w;
  };
  return { made, create };
}

function setup(over = {}) {
  const dir = tmpDir();
  const file = path.join(dir, 's1.jsonl');
  fs.writeFileSync(file, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
  const rows = { s1: { sessionId: 's1', backendId: 'claude', filePath: file, projectPath: dir, lastModel: 'claude-opus-4-6', lastInputTokens: 1000 } };
  const w = fakeWorkers();
  let quitting = false;
  sessionFlow.init({
    getCachedSession: (id) => rows[id] || null,
    getSetting: () => null,
    getAppQuitting: () => quitting,
    log,
    createWorker: w.create,
    timeoutMs: 30000,
    ...over,
  });
  return { dir, file, rows, w, quit: () => { quitting = true; }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function assertCancelled(snap) {
  assert.deepEqual(validateSnapshot(snap).errors, []);
  assert.equal(snap.complete, false);
  assert.ok(snap.limitations.some(l => l.id === 'read-cancelled'));
}
// Waits until the fake factory has made `n` workers (the request first stats and reads the head, asynchronously).
const tick = async (w, n = 1) => { for (let i = 0; i < 200 && (!w || w.made.length < n); i++) await new Promise(r => setTimeout(r, 10)); };
const goodSnapshot = () => emptyFlowSnapshot();

// every string anywhere in the value, keys included
function strings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach(x => strings(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); strings(x, out); }
  return out;
}
function assertNoPath(answer, dir) {
  const all = strings(answer);
  assert.ok(!all.includes('sources') && !all.includes('file'), 'no sources/file key');
  for (const s of all) {
    assert.ok(!(dir && s.includes(dir)), 'no temp path: ' + s.slice(0, 80));
    assert.ok(!/^[A-Za-z]:[\\/]/.test(s) && !/^\/(home|Users|tmp|var)\//.test(s), 'no absolute path: ' + s.slice(0, 80));
  }
}

test('a worker result is returned as the snapshot, with the fingerprint and no path', async () => {
  const t = setup();
  try {
    const p = sessionFlow.getSessionFlow('s1');
    await tick(t.w, 1);
    assert.equal(t.w.made.length, 1);
    assert.deepEqual(t.w.made[0].limits, { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 });
    assert.equal(t.w.made[0].workerData.backendId, 'claude');
    t.w.made[0].emit('message', { type: 'result', snapshot: goodSnapshot(), loadMs: 1, readMs: 2, replyBytes: 3 });
    const a = await p;
    assert.deepEqual(validateSnapshot(a).errors, []);
    assert.equal(a.fingerprint.size, fs.statSync(t.file).size);
    assertNoPath(a, t.dir);
    assert.equal(t.w.made[0].terminated, 1, 'the worker is terminated after its reply');
  } finally { t.cleanup(); }
});

test('an unknown session and a session without a flow answer a plain refusal', async () => {
  const t = setup();
  try {
    const unknown = await sessionFlow.getSessionFlow('nope');
    assert.equal(unknown.complete, false);
    assert.ok(unknown.limitations.some(l => l.id === 'session-unknown'));
    assert.deepEqual(validateSnapshot(unknown).errors, []);
    t.rows.s2 = { sessionId: 's2', backendId: 'agy' };
    assert.equal(await sessionFlow.getSessionFlow('s2'), null, 'a backend without a flow answers null');
  } finally { t.cleanup(); }
});

test('a supporting backend whose row has no transcript file yet answers a no-transcript snapshot, not null', async () => {
  const t = setup();
  try {
    t.rows.s3 = { sessionId: 's3', backendId: 'claude' };
    const a = await sessionFlow.getSessionFlow('s3');
    assert.ok(a, 'not null');
    assert.equal(a.complete, false);
    assert.ok(a.limitations.some(l => l.id === 'no-transcript' && /Nothing has been written/.test(l.text)));
    assert.deepEqual(validateSnapshot(a).errors, []);
    assert.equal(t.w.made.length, 0, 'no worker for nothing to read');
    assert.equal(await sessionFlow.getStatus('s3'), 'unknown');
  } finally { t.cleanup(); }
});

test('cancel terminates the worker and the call answers cancelled', async () => {
  const t = setup();
  try {
    const p = sessionFlow.getSessionFlow('s1');
    await tick(t.w, 1);
    assert.equal(sessionFlow.cancelSessionFlow('s1'), undefined);
    assertCancelled(await p);
    assert.equal(t.w.made[0].terminated, 1);
    assert.equal(sessionFlow.cancelSessionFlow('s1'), undefined);
  } finally { t.cleanup(); }
});

test('a second call supersedes the first: the first worker is terminated and a stale reply is dropped', async () => {
  const t = setup();
  try {
    const first = sessionFlow.getSessionFlow('s1');
    await tick(t.w, 1);
    const second = sessionFlow.getSessionFlow('s1');
    await tick(t.w, 2);
    assert.equal(t.w.made.length, 2);
    assert.equal(t.w.made[0].terminated, 1);
    t.w.made[0].emit('message', { type: 'result', snapshot: goodSnapshot() });   // stale
    assertCancelled(await first);
    t.w.made[1].emit('message', { type: 'result', snapshot: goodSnapshot() });
    assert.equal((await second).complete, true);
  } finally { t.cleanup(); }
});

for (const [name, fire, id] of [
  ['a crash', (w) => w.emit('error', new Error('boom C:\\Users\\someone\\secret.jsonl')), 'worker-crashed'],
  ['an exit without a reply', (w) => w.emit('exit', 1), 'worker-crashed'],
  ['out of memory', (w) => w.emit('error', Object.assign(new Error('oom'), { code: 'ERR_WORKER_OUT_OF_MEMORY' })), 'worker-memory'],
]) {
  test(`${name} answers a clean incomplete snapshot with a limitation, no raw message`, async () => {
    const t = setup();
    try {
      const p = sessionFlow.getSessionFlow('s1');
      await tick(t.w, 1);
      fire(t.w.made[0]);
      const a = await p;
      assert.equal(a.complete, false);
      assert.ok(a.limitations.some(l => l.id === id));
      assert.deepEqual(validateSnapshot(a).errors, []);
      assert.ok(!JSON.stringify(a).includes('secret'));
      assertNoPath(a, t.dir);
    } finally { t.cleanup(); }
  });
}

test('the wall-clock timeout terminates the worker and answers a limitation', async () => {
  const t = setup({ timeoutMs: 30 });
  const keepAlive = setInterval(() => {}, 1000);   // the production timer is unref'd, so the test loop needs a ref
  try {
    const a = await sessionFlow.getSessionFlow('s1');
    assert.equal(a.complete, false);
    assert.ok(a.limitations.some(l => l.id === 'worker-timeout'));
    assert.equal(t.w.made[0].terminated, 1);
  } finally { clearInterval(keepAlive); t.cleanup(); }
});

test('quitting terminates every active worker and drops the reply', async () => {
  const t = setup();
  try {
    t.rows.s2 = { ...t.rows.s1, sessionId: 's2' };
    const a = sessionFlow.getSessionFlow('s1');
    const b = sessionFlow.getSessionFlow('s2');
    await tick(t.w, 2);
    t.quit();
    sessionFlow.terminateAll();
    assertCancelled(await a);
    assertCancelled(await b);
    assert.equal(t.w.made.every(w => w.terminated === 1), true);
    assertCancelled(await sessionFlow.getSessionFlow('s1'));   // nothing starts after quit
    assert.equal(t.w.made.length, 2);
  } finally { t.cleanup(); }
});

test('status: unchanged, grew, rewritten, shrunk, missing, and unknown before a first read', async () => {
  const t = setup();
  try {
    assert.equal((await sessionFlow.getStatus('s1')), 'unknown');
    const p = sessionFlow.getSessionFlow('s1');
    await tick(t.w, 1);
    t.w.made[0].emit('message', { type: 'result', snapshot: goodSnapshot() });
    await p;
    assert.equal((await sessionFlow.getStatus('s1')), 'unchanged');
    const original = fs.readFileSync(t.file);
    fs.appendFileSync(t.file, '{"type":"user"}\n');
    assert.equal((await sessionFlow.getStatus('s1')), 'grew');
    fs.writeFileSync(t.file, Buffer.concat([Buffer.from('X'), original.subarray(1), Buffer.from('{"type":"user"}\n')]));
    assert.equal((await sessionFlow.getStatus('s1')), 'rewritten', 'head changed, larger file');
    fs.writeFileSync(t.file, original.subarray(0, 10));
    assert.equal((await sessionFlow.getStatus('s1')), 'rewritten', 'shrunk');
    fs.rmSync(t.file);
    assert.equal(await sessionFlow.getStatus('s1'), 'unknown', 'a source that cannot be stat-ed');
    assert.equal(await sessionFlow.getStatus('nope'), 'unknown');
  } finally { t.cleanup(); }
});

test('the window hint is the descriptor answer with the user variables and stored launch options', async () => {
  const settings = { global: { backendEnv: { claude: { ANTHROPIC_MODEL: 'claude-opus-4-6[1m]' } } } };
  const t = setup({ getSetting: (k) => settings[k] || null });
  try {
    const p = sessionFlow.getSessionFlow('s1');
    await tick(t.w, 1);
    assert.deepEqual(t.w.made[0].workerData.windowHint, { windowTokens: 1000000, model: 'claude-opus-4-6' });
    t.w.made[0].emit('message', { type: 'result', snapshot: goodSnapshot() });
    await p;
  } finally { t.cleanup(); }
  const plain = setup();
  try {
    const p = sessionFlow.getSessionFlow('s1');
    await tick(plain.w, 1);
    assert.deepEqual(plain.w.made[0].workerData.windowHint, { windowTokens: 200000, model: 'claude-opus-4-6' });
    plain.w.made[0].emit('message', { type: 'result', snapshot: goodSnapshot() });
    await p;
  } finally { plain.cleanup(); }
});

test('no *Sync call on the request and status path', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'session-flow.js'), 'utf8'));
  assert.deepEqual(src.match(/\b\w+Sync\b/g) || [], []);
  assert.ok(/fs\.promises\.open/.test(src));
});

test('a real worker reads the fixture into a valid snapshot with the fingerprint and no path', async () => {
  sessionFlow.init({
    getCachedSession: () => ({ sessionId: 'real', backendId: 'claude', filePath: FIXTURE, projectPath: null }),
    getSetting: () => null, getAppQuitting: () => false, log,
  });
  const a = await sessionFlow.getSessionFlow('real');
  assert.deepEqual(validateSnapshot(a).errors, []);
  assert.equal(a.complete, true);
  assert.ok(a.steps.length > 5);
  assert.equal(a.fingerprint.size, fs.statSync(FIXTURE).size);
  assertNoPath(a, path.dirname(FIXTURE));
  assert.equal((await sessionFlow.getStatus('real')), 'unchanged');
});

test('cancel and generation are per window: closing the viewer in window 2 does not cancel window 1', async () => {
  const t = setup();
  try {
    const p1 = sessionFlow.getSessionFlow('s1', 1);
    await tick(t.w, 1);
    const p2 = sessionFlow.getSessionFlow('s1', 2);
    await tick(t.w, 2);
    assert.equal(t.w.made[0].terminated, 0, 'window 2 starting a read did not supersede window 1');
    sessionFlow.cancelSessionFlow('s1', 2);
    assert.equal(t.w.made[0].terminated, 0, 'window 2 cancelling left window 1 alone');
    assert.ok(t.w.made[1].terminated >= 1);
    t.w.made[0].emit('message', { type: 'result', snapshot: goodSnapshot() });
    const a = await p1;
    assert.equal(a.complete, true, 'window 1 got its snapshot');
    assertCancelled(await p2);
    // The fingerprint is per window too: window 2 has no snapshot of its own yet.
    assert.equal(await sessionFlow.getStatus('s1', 1), 'unchanged');
    assert.equal(await sessionFlow.getStatus('s1', 2), 'unknown');
  } finally { t.cleanup(); }
});

test('the window hint is asked without a synchronous read: contextWindowAsync is awaited, contextWindow is not called', async () => {
  const backends = require('../src/backends');
  const real = backends.get('claude');
  const orig = { contextWindow: real.contextWindow, contextWindowAsync: real.contextWindowAsync };
  let asyncCalls = 0;
  real.contextWindow = () => { throw new Error('the synchronous hook must not be used on the request path'); };
  real.contextWindowAsync = async () => { asyncCalls++; await new Promise(r => setTimeout(r, 5)); return { windowTokens: 123000 }; };
  const t = setup();
  try {
    const p = sessionFlow.getSessionFlow('s1');
    await tick(t.w, 1);
    assert.equal(asyncCalls, 1);
    assert.deepEqual(t.w.made[0].workerData.windowHint, { windowTokens: 123000 });
    t.w.made[0].emit('message', { type: 'result', snapshot: goodSnapshot() });
    await p;
  } finally {
    real.contextWindow = orig.contextWindow; real.contextWindowAsync = orig.contextWindowAsync;
    t.cleanup();
  }
  // Claude's own async answer reads no file synchronously.
  const claude = require('../src/backends/claude');
  const src = claude.contextWindowAsync.toString();
  assert.ok(!/\b\w+Sync\(/.test(src), 'contextWindowAsync has no *Sync call of its own');
  assert.equal(typeof claude.contextWindowAsync, 'function');
});

// --- status notices subagent files (T13) ---

async function readOnce(t) {
  const n = t.w.made.length + 1;
  const p = sessionFlow.getSessionFlow('s1');
  await tick(t.w, n);
  t.w.made[n - 1].emit('message', { type: 'result', snapshot: goodSnapshot() });
  return p;
}
const subDirOf = (t) => path.join(t.dir, 's1', 'subagents');
function writeSub(t, name, text) {
  fs.mkdirSync(subDirOf(t), { recursive: true });
  fs.writeFileSync(path.join(subDirOf(t), name), text);
}

test('status: a subagent file that grew, or a new one, is "grew" while the main transcript is unchanged', async () => {
  const t = setup();
  try {
    writeSub(t, 'agent-a.jsonl', '{"type":"user"}\n');
    await readOnce(t);
    assert.equal(await sessionFlow.getStatus('s1'), 'unchanged', 'nothing moved');
    fs.appendFileSync(path.join(subDirOf(t), 'agent-a.jsonl'), '{"type":"user"}\n');
    assert.equal(await sessionFlow.getStatus('s1'), 'grew', 'a listed file grew');
    await readOnce(t);   // a second read re-fingerprints
    assert.equal(await sessionFlow.getStatus('s1'), 'unchanged');
    writeSub(t, 'agent-b.jsonl', '{"type":"user"}\n');
    assert.equal(await sessionFlow.getStatus('s1'), 'grew', 'a new file');
  } finally { t.cleanup(); }
});

test('status: a subagent directory that appears after the read is "grew"; one that never existed is "unchanged"', async () => {
  const t = setup();
  try {
    await readOnce(t);
    assert.equal(await sessionFlow.getStatus('s1'), 'unchanged', 'no directory, no subagents');
    writeSub(t, 'agent-a.jsonl', 'x\n');
    assert.equal(await sessionFlow.getStatus('s1'), 'grew');
  } finally { t.cleanup(); }
});

test('status: a removed or shrunk subagent file is "rewritten"; other files in the directory are ignored', async () => {
  const t = setup();
  try {
    writeSub(t, 'agent-a.jsonl', '{"type":"user"}\n{"type":"user"}\n');
    writeSub(t, 'agent-a.meta.json', '{}');
    await readOnce(t);
    writeSub(t, 'agent-a.meta.json', '{"changed":true}');
    assert.equal(await sessionFlow.getStatus('s1'), 'unchanged', 'only .jsonl files count');
    writeSub(t, 'agent-a.jsonl', 'x\n');
    assert.equal(await sessionFlow.getStatus('s1'), 'rewritten', 'shrunk');
    fs.rmSync(path.join(subDirOf(t), 'agent-a.jsonl'));
    assert.equal(await sessionFlow.getStatus('s1'), 'rewritten', 'removed');
  } finally { t.cleanup(); }
});

test('status cost: one stat of the main file, one readdir and a stat per listed subagent file; no path in the answer', async () => {
  const t = setup();
  const realStat = fs.promises.stat;
  const realReaddir = fs.promises.readdir;
  try {
    for (const n of ['agent-a.jsonl', 'agent-b.jsonl', 'agent-c.jsonl']) writeSub(t, n, '{"type":"user"}\n');
    await readOnce(t);
    let stats = 0;
    let readdirs = 0;
    fs.promises.stat = (...a) => { stats++; return realStat.apply(fs.promises, a); };
    fs.promises.readdir = (...a) => { readdirs++; return realReaddir.apply(fs.promises, a); };
    const answer = await sessionFlow.getStatus('s1');
    assert.equal(answer, 'unchanged');
    assert.equal(readdirs, 1);
    assert.equal(stats, 1 + 3);
    assertNoPath(answer, t.dir);
    // A new name needs no stat of its own.
    fs.promises.stat = realStat;
    writeSub(t, 'agent-d.jsonl', 'x\n');
    stats = 0;
    fs.promises.stat = (...a) => { stats++; return realStat.apply(fs.promises, a); };
    assert.equal(await sessionFlow.getStatus('s1'), 'grew');
    assert.ok(stats <= 1 + 3, `stats ${stats}`);
  } finally {
    fs.promises.stat = realStat;
    fs.promises.readdir = realReaddir;
    t.cleanup();
  }
});

test('the subagent directory is found by its source role, not by a backend id', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'session-flow.js'), 'utf8'));
  assert.ok(/role === 'subagents-dir'/.test(src));
  assert.ok(!/['"]claude['"]/.test(src.replace(/LEGACY_SESSION_BACKEND = 'claude'/, '')), 'no backend id beyond the grandfathered default');
});

// --- status above the cap, and the odd read-time cases (T13 follow-up) ---

function fillSubs(t, n) {
  fs.mkdirSync(subDirOf(t), { recursive: true });
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(subDirOf(t), 'agent-' + String(i).padStart(4, '0') + '.jsonl'), 'x\n');
}

test('status above the 200-file cap: an early-sorting new file is "grew", not "rewritten"; a late one is seen too', async () => {
  const t = setup();
  try {
    fillSubs(t, 205);
    await readOnce(t);
    assert.equal(await sessionFlow.getStatus('s1'), 'unchanged', 'nothing moved');
    writeSub(t, 'agent-0000a.jsonl', 'x\n');   // sorts inside the window and pushes the 200th name out of it
    assert.equal(await sessionFlow.getStatus('s1'), 'grew');
  } finally { t.cleanup(); }
  const late = setup();
  try {
    fillSubs(late, 205);
    await readOnce(late);
    writeSub(late, 'zz.jsonl', 'x\n');         // sorts past the window: only the count shows it
    assert.equal(await sessionFlow.getStatus('s1'), 'grew');
  } finally { late.cleanup(); }
});

test('status stats at most 200 subagent files, one after the other', async () => {
  const t = setup();
  const realStat = fs.promises.stat;
  try {
    fillSubs(t, 230);
    await readOnce(t);
    let inFlight = 0;
    let peak = 0;
    let stats = 0;
    fs.promises.stat = async (...a) => { stats++; inFlight++; peak = Math.max(peak, inFlight); try { return await realStat.apply(fs.promises, a); } finally { inFlight--; } };
    assert.equal(await sessionFlow.getStatus('s1'), 'unchanged');
    assert.equal(stats, 1 + 200);
    assert.equal(peak, 1, 'never in parallel');
  } finally { fs.promises.stat = realStat; t.cleanup(); }
});

test('status: a directory that could not be listed at the read is listed again later', async () => {
  const t = setup();
  try {
    fs.mkdirSync(path.join(t.dir, 's1'), { recursive: true });
    fs.writeFileSync(subDirOf(t), 'not a directory');   // readdir fails with ENOTDIR, not ENOENT
    await readOnce(t);
    assert.equal(await sessionFlow.getStatus('s1'), 'unchanged', 'still unreadable: the main transcript decides');
    fs.rmSync(subDirOf(t));
    assert.equal(await sessionFlow.getStatus('s1'), 'unchanged', 'readable and empty');
    writeSub(t, 'agent-a.jsonl', 'x\n');
    assert.equal(await sessionFlow.getStatus('s1'), 'grew', 'watching resumed');
  } finally { t.cleanup(); }
});

test('status: a file the read could not stat does not report "grew" on every poll', async () => {
  const t = setup();
  const realStat = fs.promises.stat;
  try {
    writeSub(t, 'agent-a.jsonl', 'x\n');
    writeSub(t, 'agent-b.jsonl', 'x\n');
    fs.promises.stat = (f, ...a) => (String(f).endsWith('agent-b.jsonl') ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })) : realStat.call(fs.promises, f, ...a));
    await readOnce(t);
    assert.equal(await sessionFlow.getStatus('s1'), 'unchanged', 'still cannot be stat-ed: no change');
    assert.equal(await sessionFlow.getStatus('s1'), 'unchanged');
    fs.promises.stat = realStat;
    assert.equal(await sessionFlow.getStatus('s1'), 'grew', 'a successful stat is the first change');
  } finally { fs.promises.stat = realStat; t.cleanup(); }
});

test('the snapshot handed to the renderer carries no subagent state and no path in its fingerprint', async () => {
  const t = setup();
  try {
    writeSub(t, 'agent-a.jsonl', 'x\n');
    const snap = await readOnce(t);
    assert.ok(snap.fingerprint && typeof snap.fingerprint.size === 'number');
    const all = strings(snap.fingerprint);
    assert.ok(!all.includes('subs') && !all.includes('sizes'), 'no subagent bookkeeping');
    assertNoPath(snap.fingerprint, t.dir);
    assertNoPath(snap, t.dir);
  } finally { t.cleanup(); }
});

// --- status notices the extra rollouts a reader reports (T15) ---

test('status: a rollout the reader reported (a Codex subagent) that grew is "grew", a shrunk or removed one "rewritten"', async () => {
  const t = setup();
  try {
    const child = path.join(t.dir, 'child.jsonl');
    fs.writeFileSync(child, '{"type":"x"}\n');
    const n = t.w.made.length + 1;
    const p = sessionFlow.getSessionFlow('s1');
    await tick(t.w, n);
    t.w.made[n - 1].emit('message', { type: 'result', snapshot: goodSnapshot(), files: [{ file: child, size: fs.statSync(child).size }] });
    const snap = await p;
    assertNoPath(snap, t.dir);
    assert.equal(await sessionFlow.getStatus('s1'), 'unchanged');
    fs.appendFileSync(child, '{"type":"x"}\n');
    assert.equal(await sessionFlow.getStatus('s1'), 'grew');
    fs.writeFileSync(child, '');
    assert.equal(await sessionFlow.getStatus('s1'), 'rewritten');
    fs.rmSync(child);
    assert.equal(await sessionFlow.getStatus('s1'), 'rewritten');
  } finally { t.cleanup(); }
});
