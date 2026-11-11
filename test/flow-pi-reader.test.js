'use strict';
// Pi's session-flow reader (spec 46, #826, plan T16) on the hand-built fixture `test/fixtures/flow/pi-session.jsonl`
// (see its README for what is measured and what is guessed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateSnapshot } = require('../src/shared/flow-snapshot');
const { readSessionFlow } = require('../src/backends/pi/flow-reader');
const modelWindows = require('../src/backends/pi/model-windows');
const { writeOversizedLine } = require('./helpers/flow-fixture-gen');

const FIXTURE = path.join(__dirname, 'fixtures', 'flow', 'pi-session.jsonl');
const src = (file) => [{ sourceId: 'main', role: 'transcript', laneHint: 'main', file }];

async function read(file, opts) {
  const snap = await readSessionFlow(src(file), opts || {});
  assert.deepEqual(validateSnapshot(snap).errors, [], 'every snapshot passes validateSnapshot');
  return snap;
}

function tmpFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-pi-'));
  const file = path.join(dir, 's.jsonl');
  // An entry with no id of its own gets one, chained to the entry before it (a linear session).
  let prev = null;
  lines = lines.map((l, i) => {
    if (typeof l === 'string' || l.type === 'session') return l;
    const out = l.id ? l : { ...l, id: `n${i}`, parentId: prev };
    prev = out.id;
    return out;
  });
  fs.writeFileSync(file, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const T = '2026-01-01T14:00:00.000Z';
const header = (cwd) => ({ type: 'session', version: 3, id: 's1', timestamp: T, cwd: cwd || '<project>' });
const entry = (message) => ({ type: 'message', timestamp: T, message });
const user = (text) => entry({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (content, usage, extra) => entry({ role: 'assistant', model: 'pi-fake-model', provider: 'fake', content, usage, ...(extra || {}) });
const usage = (input, cacheRead) => ({ input, output: 5, cacheRead: cacheRead || 0, cacheWrite: 0, totalTokens: input + 5 });

test('kinds, order, ordinals and turn numbers follow the transcript', async () => {
  const snap = await read(FIXTURE);
  assert.deepEqual(snap.steps.map(s => s.kind), [
    'start', 'instructions', 'instructions', 'prompt', 'tool', 'tool', 'tool', 'compaction',
  ]);
  assert.deepEqual(snap.steps.map(s => s.ordinal), snap.steps.map((_, i) => i));
  assert.deepEqual(snap.steps.map(s => s.turn), [null, null, null, 1, 1, 1, 1, 1]);
  assert.equal(snap.complete, true);
  assert.equal(snap.lanes.length, 1);
  assert.equal(snap.lanes[0].kind, 'main');
  assert.equal(snap.steps.find(s => s.kind === 'prompt').label, 'Show the readme and run the tests.');
  assert.ok(snap.steps.every(s => Number.isFinite(s.ts)));
  assert.ok(snap.steps.filter(s => s.kind === 'tool').every(s => typeof s.detail.tool === 'string'));
});

test('project_context splits into one instruction step per file, labelled without an absolute path', async () => {
  const snap = await read(FIXTURE);
  const files = snap.steps.filter(s => s.kind === 'instructions');
  assert.equal(files.length, 2);
  assert.deepEqual(files.map(f => f.label), ['<project>/AGENTS.md', '<project>/CLAUDE.md']);
  for (const f of files) {
    assert.equal(f.parentStepId, snap.steps[0].id);
    assert.equal(f.tokens.basis, 'estimated');
    assert.equal(f.tokens.value, Math.ceil(f.detail.characters / 4));
  }
  assert.equal(files[0].detail.characters, 'Fake rules.'.length);
  assert.equal(snap.capabilities.instructionFiles.state, 'perFile');
  assert.ok(!snap.limitations.some(l => l.id === 'instructions-not-recorded'));
});

test('instruction labels are relative to the session cwd, then home, and never absolute', async () => {
  const cwd = path.resolve(os.tmpdir(), 'flow-pi-proj');
  const inside = path.join(cwd, 'sub', 'AGENTS.md');
  const t = tmpFile([
    header(cwd),
    entry({ role: 'system', sections: { project_context: `<project_context><project_instructions path="${inside.replace(/\\/g, '\\\\')}">abcd</project_instructions></project_context>` } }),
  ]);
  try {
    const snap = await read(t.file);
    assert.equal(snap.steps.find(s => s.kind === 'instructions').label, 'sub/AGENTS.md');
    assert.ok(!JSON.stringify(snap).includes(os.tmpdir().replace(/\\/g, '\\\\')));
  } finally { t.cleanup(); }
});

test('an older session without sections is a limitation, not an error', async () => {
  const t = tmpFile([header(), user('hello')]);
  try {
    const snap = await read(t.file);
    assert.equal(snap.complete, true);
    assert.ok(snap.limitations.some(l => l.id === 'instructions-not-recorded'));
    assert.ok(snap.limitations.some(l => l.id === 'instructions-version'));
    assert.equal(snap.steps.filter(s => s.kind === 'instructions').length, 0);
  } finally { t.cleanup(); }
});

test('a system message with no project files is not a limitation', async () => {
  const t = tmpFile([header(), entry({ role: 'system', sections: { project_context: '' } }), user('hello')]);
  try {
    const snap = await read(t.file);
    assert.ok(!snap.limitations.some(l => l.id === 'instructions-not-recorded'));
    assert.equal(snap.steps.filter(s => s.kind === 'instructions').length, 0);
  } finally { t.cleanup(); }
});

test('checkpoints are input + cacheRead + cacheWrite, measured, on the first step of the request; the window is unknown off-catalog', async () => {
  const snap = await read(FIXTURE);
  const cps = snap.steps.filter(s => s.checkpoint);
  const values = cps.filter(s => s.kind === 'tool').map(s => s.checkpoint.input.value);
  assert.deepEqual(values, [2000, 2500]);
  assert.equal(cps[0].checkpoint.input.basis, 'measured');
  assert.equal(cps[0].checkpoint.window.basis, 'unknown');
  assert.equal(cps[0].checkpoint.model, 'pi-fake-model');
  assert.equal(snap.steps[0].tokens.value, 2000);
  assert.equal(snap.capabilities.contextCheckpoints.state, 'partial');
});

test('the window comes from Pi\'s own model catalog when it lists the model', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-pi-agent-'));
  const saved = { a: process.env.PI_CODING_AGENT_DIR, s: process.env.SWITCHBOARD_STORE_PI };
  fs.writeFileSync(path.join(dir, 'models-store.json'), JSON.stringify({ fake: { models: [{ id: 'pi-fake-model', contextWindow: 100000 }] } }));
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.SWITCHBOARD_STORE_PI;
  modelWindows._resetCache();
  try {
    const snap = await read(FIXTURE);
    const cp = snap.steps.find(s => s.checkpoint).checkpoint;
    assert.equal(cp.window.value, 100000);
    assert.equal(cp.window.basis, 'measured');
  } finally {
    if (saved.a === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.a;
    if (saved.s !== undefined) process.env.SWITCHBOARD_STORE_PI = saved.s;
    modelWindows._resetCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compaction: before is tokensBefore, after is the next non-zero request input, never its usage', async () => {
  const fixture = await read(FIXTURE);
  const c = fixture.steps.find(s => s.kind === 'compaction');
  assert.equal(c.detail.before, 2525);
  assert.equal(c.detail.after, 'unknown', 'no request after it in the fixture');
  assert.equal(c.checkpoint.input.value, 2525);
  assert.equal(c.checkpoint.input.basis, 'measured');
  const t = tmpFile([
    header(), user('a'), assistant([{ type: 'text', text: 'x' }], usage(100, 50)),
    { type: 'compaction', timestamp: T, summary: 's', tokensBefore: 150, usage: { input: 9999, output: 1 } },
    user('b'), assistant([{ type: 'text', text: 'y' }], usage(30, 0)),
  ]);
  try {
    const snap = await read(t.file);
    const comp = snap.steps.find(s => s.kind === 'compaction');
    assert.equal(comp.detail.before, 150);
    assert.equal(comp.detail.after, 30);
    assert.ok(!JSON.stringify(snap).includes('9999'));
  } finally { t.cleanup(); }
});

test('a tool result with isError is a structured outcome flag; the gate text in a TERMINAL session is no refusal', async () => {
  // The fixture has no transport marker: terminal Pi has no gate, so the text is a plain error (T23; the pi-native case is in
  // `flow-pi-flags.test.js`).
  const snap = await read(FIXTURE);
  const read1 = snap.steps.find(s => s.detail.tool === 'read');
  const bash = snap.steps.find(s => s.detail.tool === 'bash');
  assert.equal(read1.flags.length, 0);
  assert.equal(read1.detail.status, 'ok');
  assert.deepEqual(bash.flags.map(f => [f.axis, f.code, f.evidence]), [['outcome', 'tool-error', 'structured']]);
  assert.equal(bash.detail.refused, undefined);
  const t = tmpFile([
    header(), user('a'),
    assistant([{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'x' } }], usage(10)),
    entry({ role: 'toolResult', toolCallId: 't1', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'command not found' }] }),
  ]);
  try {
    const s2 = await read(t.file);
    const step = s2.steps.find(s => s.kind === 'tool');
    assert.equal(step.flags.length, 1);
    assert.equal(step.detail.refused, undefined, 'an ordinary failure is not a refusal');
  } finally { t.cleanup(); }
});

test('the subagent tool is one collapsed node with the summary line parsed, and no lane', async () => {
  const snap = await read(FIXTURE);
  const sub = snap.steps.find(s => s.detail.tool === 'subagent');
  assert.equal(sub.kind, 'tool');
  assert.equal(sub.detail.kind, 'agent');
  assert.equal(sub.detail.agent, 'scout');
  assert.equal(sub.detail.turns, 3);
  assert.equal(sub.detail.inputTokens, 2100);
  assert.equal(sub.detail.outputTokens, 340);
  assert.equal(sub.detail.costUsd, 0.0123);
  assert.equal(sub.detail.model, 'pi-fake-model');
  assert.equal(snap.lanes.length, 1);
  assert.equal(snap.capabilities.agents.state, 'partial');
  assert.equal(snap.capabilities.agents.limitationId, 'agents-summary-only');
});

test('a thinking block and text are steps; the first step of a request carries its checkpoint', async () => {
  const t = tmpFile([header(), user('a'), assistant([{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Hello' }], usage(40))]);
  try {
    const snap = await read(t.file);
    assert.deepEqual(snap.steps.map(s => s.kind), ['start', 'prompt', 'thinking', 'output']);
    assert.equal(snap.steps[2].checkpoint.input.value, 40);
    assert.equal(snap.steps[3].checkpoint, null);
  } finally { t.cleanup(); }
});

test('an aborted turn with no usage is an interrupt and no checkpoint', async () => {
  const t = tmpFile([
    header(), user('a'), assistant([{ type: 'text', text: 'partial' }], usage(100)),
    user('b'), assistant([], { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, { stopReason: 'aborted' }),
  ]);
  try {
    const snap = await read(t.file);
    const kinds = snap.steps.map(s => s.kind);
    assert.equal(kinds[kinds.length - 1], 'interrupt');
    assert.equal(snap.steps.filter(s => s.checkpoint).length, 1);
    assert.equal(snap.steps[snap.steps.length - 1].turn, 2);
  } finally { t.cleanup(); }
});

test('the start step says there is no approval step in a terminal, and names the gate once the transport marker is seen', async () => {
  const terminal = await read(FIXTURE);
  assert.match(terminal.steps[0].detail.approvals, /no approval step/);
  const t = tmpFile([header(), { type: 'custom', customType: 'switchboard-transport', data: { transport: 'rpc' }, timestamp: T }, user('a')]);
  try {
    const snap = await read(t.file);
    assert.match(snap.steps[0].detail.approvals, /gate/);
    assert.equal(snap.capabilities.permissionMode.state, 'no');
    assert.equal(snap.capabilities.approvals.state, 'partial');
  } finally { t.cleanup(); }
});

test('ids are stable across two reads of the same file', async () => {
  const a = await read(FIXTURE);
  const b = await read(FIXTURE);
  assert.deepEqual(a.steps.map(s => s.id), b.steps.map(s => s.id));
  assert.equal(new Set(a.steps.map(s => s.id)).size, a.steps.length);
});

test('the step cap stops the read with complete false and a limitation', async () => {
  const snap = await read(FIXTURE, { maxSteps: 3 });
  assert.equal(snap.steps.length, 3);
  assert.equal(snap.complete, false);
  assert.ok(snap.limitations.some(l => l.id === 'step-cap'));
});

test('an aborted read returns what it has, incomplete, with an aborted limitation', async () => {
  const ctl = new AbortController();
  ctl.abort();
  const snap = await read(FIXTURE, { signal: ctl.signal });
  assert.equal(snap.complete, false);
  assert.ok(snap.limitations.some(l => l.id === 'aborted'));
});

test('an oversize line is skipped unread and shown as one event', async () => {
  const big = writeOversizedLine(300 * 1024, { head: 1, tail: 1 });
  try {
    const snap = await read(big.path, { maxLineBytes: 64 * 1024 });
    assert.equal(snap.complete, false);
    assert.ok(snap.limitations.some(l => l.id === 'line-over-cap'));
    assert.equal(snap.steps.filter(s => s.kind === 'event').length, 1);
    assert.equal(snap.steps.find(s => s.kind === 'event').tokens.basis, 'unknown');
  } finally { big.cleanup(); }
});

test('a missing file and no sources are incomplete snapshots, not throws', async () => {
  const missing = await readSessionFlow(src(path.join(os.tmpdir(), 'no-such-flow-pi.jsonl')), {});
  assert.equal(missing.complete, false);
  assert.ok(missing.limitations.some(l => l.id === 'read-failed'));
  assert.equal(validateSnapshot(missing).ok, true);
  const none = await readSessionFlow([], {});
  assert.equal(none.complete, false);
  assert.ok(none.limitations.some(l => l.id === 'nothing-read'));
  assert.equal(validateSnapshot(none).ok, true);
});

const withId = (id, parentId, e) => ({ ...e, id, parentId });

test('only the active branch is shown: the steps of an abandoned branch, its turns, checkpoints and compaction `after` are dropped', async () => {
  const t = tmpFile([
    header(),
    withId('a1', null, user('first')),
    withId('a2', 'a1', assistant([{ type: 'text', text: 'abandoned answer' }], usage(900))),
    withId('a3', 'a2', user('abandoned follow-up')),
    // the user went back to a1 (/tree) and asked again
    withId('b2', 'a1', assistant([{ type: 'text', text: 'kept answer' }], usage(100))),
    withId('c1', 'b2', { type: 'compaction', timestamp: T, summary: 's', tokensBefore: 120 }),
    withId('b3', 'c1', user('second')),
    withId('b4', 'b3', assistant([{ type: 'text', text: 'done' }], usage(40))),
  ]);
  try {
    const snap = await read(t.file);
    assert.deepEqual(snap.steps.map(s => s.kind), ['start', 'prompt', 'output', 'compaction', 'prompt', 'output']);
    assert.deepEqual(snap.steps.map(s => s.label), ['Session start', 'first', 'kept answer', 'Compaction', 'second', 'done']);
    assert.deepEqual(snap.steps.map(s => s.ordinal), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(snap.steps.map(s => s.turn), [null, 1, 1, 1, 2, 2]);
    const comp = snap.steps.find(s => s.kind === 'compaction');
    assert.equal(comp.detail.before, 120);
    assert.equal(comp.detail.after, 40);
    assert.equal(snap.steps[0].tokens.value, 100, 'the start total is the first request on the branch');
    assert.deepEqual(snap.steps.filter(s => s.checkpoint && s.kind === 'output').map(s => s.checkpoint.input.value), [100, 40]);
    assert.ok(!snap.limitations.some(l => l.id === 'tree-linear'));
    assert.equal(new Set(snap.steps.map(s => s.id)).size, snap.steps.length);
  } finally { t.cleanup(); }
});

test('a user bashExecution is a shell event and starts no turn', async () => {
  const t = tmpFile([header(), user('a'), entry({ role: 'bashExecution', command: 'git status\nmore', output: 'x', exitCode: 0 })]);
  try {
    const snap = await read(t.file);
    const ev = snap.steps.find(s => s.kind === 'event');
    assert.equal(ev.label, 'Shell command: git status');
    assert.equal(ev.turn, 1);
    assert.equal(snap.steps.filter(s => s.kind === 'prompt').length, 1);
  } finally { t.cleanup(); }
});

test('a failed model call is an event with the error text and no checkpoint', async () => {
  const t = tmpFile([
    header(), user('a'),
    assistant([], { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, { stopReason: 'error', errorMessage: 'rate limit reached' }),
  ]);
  try {
    const snap = await read(t.file);
    const ev = snap.steps.find(s => s.kind === 'event');
    assert.equal(ev.label, 'The model call failed');
    assert.equal(ev.detail.text, 'rate limit reached');
    assert.equal(snap.steps.filter(s => s.checkpoint).length, 0);
  } finally { t.cleanup(); }
});

test('a compaction keeps the history before it: the chain is not re-rooted, only abandoned siblings are dropped', async () => {
  const t = tmpFile([
    header(),
    withId('a1', null, user('before the compaction')),
    withId('a2', 'a1', assistant([{ type: 'text', text: 'early answer' }], usage(500))),
    withId('c1', 'a2', { type: 'compaction', timestamp: T, summary: 's', firstKeptEntryId: 'a2', tokensBefore: 520 }),
    withId('b1', 'c1', user('after the compaction')),
    withId('b2', 'b1', assistant([{ type: 'text', text: 'late answer' }], usage(60))),
  ]);
  try {
    const snap = await read(t.file);
    assert.deepEqual(snap.steps.map(s => s.label), ['Session start', 'before the compaction', 'early answer', 'Compaction', 'after the compaction', 'late answer']);
    assert.equal(snap.steps.find(s => s.kind === 'compaction').detail.after, 60);
  } finally { t.cleanup(); }
});

test('a line skipped over the cap does not cut the history before it', async () => {
  const big = 'x'.repeat(200 * 1024);
  const t = tmpFile([
    header(),
    withId('a1', null, user('early prompt')),
    withId('a2', 'a1', assistant([{ type: 'text', text: 'early answer' }], usage(500))),
    JSON.stringify(withId('s1', 'a2', entry({ role: 'toolResult', toolCallId: 'none', toolName: 'read', content: [{ type: 'text', text: big }] }))),
    withId('b1', 's1', user('late prompt')),
    withId('b2', 'b1', assistant([{ type: 'text', text: 'late answer' }], usage(60))),
  ]);
  try {
    const snap = await read(t.file, { maxLineBytes: 64 * 1024 });
    assert.equal(snap.complete, false);
    const labels = snap.steps.map(s => s.label);
    for (const l of ['early prompt', 'early answer', 'late prompt', 'late answer']) assert.ok(labels.includes(l), l);
  } finally { t.cleanup(); }
});

test('an over-cap line at a branch switch: its head gives the real link, so the kept branch is right', async () => {
  const big = 'x'.repeat(200 * 1024);
  // Pi writes type, id and parentId first; the head of the skipped line names its parent.
  const skipped = JSON.stringify({ type: 'message', id: 'b1', parentId: 'a1', timestamp: T, message: { role: 'toolResult', toolCallId: 'none', toolName: 'read', content: [{ type: 'text', text: big }] } });
  const t = tmpFile([
    header(),
    withId('a1', null, user('shared start')),
    withId('c1', 'a1', assistant([{ type: 'text', text: 'abandoned answer' }], usage(900))),
    skipped,
    withId('d1', 'b1', user('kept prompt')),
  ]);
  try {
    const snap = await read(t.file, { maxLineBytes: 64 * 1024 });
    const labels = snap.steps.map(s => s.label);
    assert.ok(labels.includes('shared start') && labels.includes('kept prompt'));
    assert.ok(!labels.includes('abandoned answer'), 'the sibling left by the fork-back is dropped');
    assert.equal(snap.complete, false);
  } finally { t.cleanup(); }
});

test('an unparsable line mid-file is a gap: earlier history stays, the read is incomplete, and a half last line is not counted', async () => {
  const t = tmpFile([
    header(),
    withId('a', null, user('first')),
    withId('b', 'a', assistant([{ type: 'text', text: 'second' }], usage(10))),
    '{"type":"message","id":"c","parentId":"b","timestamp":"2026-01-01T14:00:00.000Z","message":{broken',
    withId('d', 'c', user('fourth')),
  ]);
  try {
    const snap = await read(t.file);
    const labels = snap.steps.map(s => s.label);
    for (const l of ['first', 'second', 'fourth']) assert.ok(labels.includes(l), l);
    assert.equal(snap.complete, false);
    assert.ok(snap.limitations.some(l => l.id === 'line-unparsed'));
  } finally { t.cleanup(); }
  const unlinked = tmpFile([header(), withId('a', null, user('first')), '{"oops": broken', withId('d', 'zz', user('later'))]);
  try {
    const snap = await read(unlinked.file);
    assert.ok(snap.steps.some(s => s.label === 'first'), 'a head with no link falls back to the bridge');
  } finally { unlinked.cleanup(); }
  const half = tmpFile([header(), withId('a', null, user('first')), '{"type":"message","id":"b","par']);
  try {
    const snap = await read(half.file);
    assert.equal(snap.complete, true, 'a half last line (a transcript being written) is not a fault');
  } finally { half.cleanup(); }
});
