'use strict';
// Codex's session-flow reader (spec 46, #826, plan T14) on the hand-built fixture `test/fixtures/flow/codex-rollout.jsonl`
// (see its README for what is measured and what is guessed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateSnapshot } = require('../src/shared/flow-snapshot');
const { readSessionFlow } = require('../src/backends/codex/flow-reader');
const { writeOversizedLine } = require('./helpers/flow-fixture-gen');

const FIXTURE = path.join(__dirname, 'fixtures', 'flow', 'codex-rollout.jsonl');
const src = (file) => [{ sourceId: 'main', role: 'transcript', laneHint: 'main', file }];

async function read(file, opts) {
  const snap = await readSessionFlow(src(file), opts || {});
  assert.deepEqual(validateSnapshot(snap).errors, [], 'every snapshot passes validateSnapshot');
  return snap;
}

function tmpFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-codex-'));
  const file = path.join(dir, 'r.jsonl');
  fs.writeFileSync(file, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const line = (type, payload) => ({ timestamp: '2026-01-01T12:00:00.000Z', type, payload });
const tokenCount = (input, total) => line('event_msg', {
  type: 'token_count',
  info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: input }, model_context_window: 50000 },
});
const userText = (text) => line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

test('kinds, order, ordinals and turn numbers follow the rollout', async () => {
  const snap = await read(FIXTURE);
  assert.deepEqual(snap.steps.map(s => s.kind), [
    'start', 'instructions', 'prompt', 'thinking', 'tool', 'tool', 'tool', 'output', 'compaction', 'mode', 'prompt', 'output', 'interrupt',
  ]);
  assert.deepEqual(snap.steps.map(s => s.ordinal), snap.steps.map((_, i) => i));
  assert.deepEqual(snap.steps.map(s => s.turn), [null, null, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2]);
  assert.equal(snap.complete, true);
  assert.equal(snap.lanes.length, 1);
  assert.equal(snap.lanes[0].kind, 'main');
  assert.equal(snap.steps.find(s => s.kind === 'prompt').label, 'List the files.');
  assert.ok(snap.steps.every(s => Number.isFinite(s.ts)));
});

test('the AGENTS.md message is one estimated instruction block, and neither it nor the environment block is a prompt', async () => {
  const snap = await read(FIXTURE);
  const files = snap.steps.filter(s => s.kind === 'instructions');
  assert.equal(files.length, 1);
  assert.equal(files[0].parentStepId, snap.steps[0].id);
  assert.equal(files[0].tokens.basis, 'estimated');
  assert.ok(files[0].detail.characters > 0);
  assert.equal(snap.steps.filter(s => s.kind === 'prompt').length, 2);
  assert.ok(!snap.steps.some(s => /environment_context|AGENTS/.test(s.detail.text || '')));
  assert.equal(snap.capabilities.instructionFiles.state, 'block');
});

test('step ids are stable across a re-read and unique', async () => {
  const a = await read(FIXTURE);
  const b = await read(FIXTURE);
  assert.deepEqual(a.steps.map(s => s.id), b.steps.map(s => s.id));
  assert.equal(new Set(a.steps.map(s => s.id)).size, a.steps.length);
  assert.ok(a.steps.every(s => !/[\\/]/.test(s.id) || s.id.includes('main')), 'no path in an id');
});

test('a call and its output are one step, paired by call id; an array output and a string output both read', async () => {
  const snap = await read(FIXTURE);
  const tools = snap.steps.filter(s => s.kind === 'tool');
  assert.deepEqual(tools.map(s => s.detail.tool), ['exec', 'update_plan', 'exec_command']);
  assert.equal(tools[0].detail.status, 'ok');
  assert.match(tools[0].detail.result, /a\.txt/);
  assert.match(tools[1].detail.result, /Plan updated/);
  assert.match(tools[2].label, /^exec_command: cat missing\.txt/);
});

test('a non-zero exit code puts an outcome flag on the call; a quoted code in the middle of the output does not', async () => {
  const snap = await read(FIXTURE);
  const failed = snap.steps.find(s => s.detail.tool === 'exec_command');
  assert.equal(failed.detail.status, 'error');
  assert.equal(failed.detail.exitCode, 1);
  assert.deepEqual(failed.flags.map(f => [f.axis, f.code, f.evidence]), [['outcome', 'tool-error', 'heuristic']]);
  assert.deepEqual(snap.steps.find(s => s.detail.tool === 'exec').flags, []);
  const t = tmpFile([
    line('response_item', { type: 'function_call', name: 'exec_command', call_id: 'c', arguments: '{"cmd":"x"}' }),
    line('response_item', { type: 'function_call_output', call_id: 'c', output: 'ok\nthe log said Exit code: 7 once\nbye' }),
  ]);
  try {
    const s = await read(t.file);
    assert.deepEqual(s.steps.find(x => x.kind === 'tool').flags, []);
  } finally { t.cleanup(); }
});

test('checkpoints: last_token_usage input, the reported window, measured; a repeated record is one request', async () => {
  const snap = await read(FIXTURE);
  const cps = snap.steps.filter(s => s.checkpoint && s.kind !== 'compaction');
  assert.deepEqual(cps.map(s => s.checkpoint.input.value), [2000, 900]);
  for (const s of cps) {
    assert.equal(s.checkpoint.input.basis, 'measured');
    assert.equal(s.checkpoint.window.value, 100000);
    assert.equal(s.checkpoint.window.basis, 'measured');
    assert.equal(s.checkpoint.model, 'gpt-fake');
  }
  assert.equal(snap.steps[0].tokens.value, 2000);
  assert.equal(snap.steps[0].tokens.basis, 'measured');
  assert.equal(snap.steps[0].detail.model, 'gpt-fake');
  assert.equal(snap.capabilities.contextCheckpoints.state, 'yes');
});

test('compaction: before is the last non-zero input, after the next one; the zero record and the summarising call are skipped', async () => {
  const snap = await read(FIXTURE);
  const c = snap.steps.find(s => s.kind === 'compaction');
  assert.equal(c.detail.before, 2000);
  assert.equal(c.detail.after, 900);
  assert.equal(c.detail.windowNumber, 1);
  assert.equal(c.checkpoint.input.value, 2000);
  // the summarising call's usage (2300 in the fixture) is nowhere
  assert.ok(!JSON.stringify(snap).includes('2300'));
  assert.ok(!snap.steps.some(s => s.checkpoint && s.checkpoint.input.value === 0));
});

test('a compaction with no later request ends with an unknown "after"', async () => {
  const t = tmpFile([tokenCount(700, 700), line('compacted', { window_number: 2 })]);
  try {
    const s = await read(t.file);
    const c = s.steps.find(x => x.kind === 'compaction');
    assert.equal(c.detail.before, 700);
    assert.equal(c.detail.after, 'unknown');
  } finally { t.cleanup(); }
});

test('interrupt comes from turn_aborted', async () => {
  const snap = await read(FIXTURE);
  const i = snap.steps.find(s => s.kind === 'interrupt');
  assert.equal(i.detail.reason, 'interrupted');
  assert.equal(i.detail.durationMs, 60000);
  assert.equal(snap.steps[snap.steps.length - 1], i);
});

test('mode: the first policy is the start step\'s, a step appears on change only', async () => {
  const snap = await read(FIXTURE);
  assert.equal(snap.steps[0].detail.mode, 'on-request, workspace-write');
  const modes = snap.steps.filter(s => s.kind === 'mode');
  assert.equal(modes.length, 1, 'turn_context t2 repeats nothing but the policy that changed');
  assert.deepEqual([modes[0].detail.from, modes[0].detail.to], ['on-request, workspace-write', 'never, workspace-write']);
});

test('capabilities are declared truthfully and every non-full one names a limitation', async () => {
  const snap = await read(FIXTURE);
  assert.equal(snap.capabilities.agents.state, 'partial');
  assert.equal(snap.capabilities.approvals.state, 'no');
  assert.equal(snap.capabilities.destructivePatterns.state, 'no');
  for (const c of Object.values(snap.capabilities)) {
    if (c.limitationId) assert.ok(snap.limitations.some(l => l.id === c.limitationId));
  }
});

test('the step cap stops the read with complete false and a limitation', async () => {
  const snap = await read(FIXTURE, { maxSteps: 4 });
  assert.equal(snap.steps.length, 4);
  assert.equal(snap.complete, false);
  assert.ok(snap.limitations.some(l => l.id === 'step-cap'));
});

test('the size cap stops the read the same way', async () => {
  const snap = await read(FIXTURE, { maxBytes: 1500 });
  assert.equal(snap.complete, false);
  assert.ok(snap.limitations.some(l => l.id === 'size-cap'));
  assert.ok(snap.steps.length < 13);
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
  const missing = await readSessionFlow(src(path.join(os.tmpdir(), 'no-such-flow-codex.jsonl')), {});
  assert.equal(missing.complete, false);
  assert.ok(missing.limitations.some(l => l.id === 'read-failed'));
  assert.equal(validateSnapshot(missing).ok, true);
  const none = await readSessionFlow([], {});
  assert.equal(none.complete, false);
  assert.ok(none.limitations.some(l => l.id === 'nothing-read'));
  assert.equal(validateSnapshot(none).ok, true);
});

test('a malformed line and an unknown record type are ignored', async () => {
  const t = tmpFile(['{not json', JSON.stringify({ type: 'mystery', payload: { type: 'x' } }), userText('Hello there.')]);
  try {
    const s = await read(t.file);
    assert.deepEqual(s.steps.map(x => x.kind), ['start', 'prompt']);
  } finally { t.cleanup(); }
});

test('the snapshot carries no path and no raw vendor record', async () => {
  const text = JSON.stringify(await read(FIXTURE));
  assert.ok(!text.includes(FIXTURE));
  assert.ok(!/encrypted_content|replacement_history|latest_token_usage_record/.test(text));
});

const rec = (p) => line('response_item', p);
const msgUser = (text) => userText(text);
const reason = () => rec({ type: 'reasoning', summary: [] });

test('a checkpoint after an aborted turn or a new prompt does not land on an earlier turn\'s step', async () => {
  const t = tmpFile([
    msgUser('first'), reason(), line('event_msg', { type: 'turn_aborted', reason: 'interrupted' }),
    msgUser('second'), reason(), tokenCount(500, 500),
  ]);
  try {
    const s = await read(t.file);
    const thinking = s.steps.filter(x => x.kind === 'thinking');
    assert.equal(thinking[0].checkpoint, null);
    assert.equal(thinking[1].checkpoint.input.value, 500);
  } finally { t.cleanup(); }
});

test('two compactions in a row: the first ends with an unknown after, the second has no before', async () => {
  const t = tmpFile([tokenCount(700, 700), line('compacted', { window_number: 1 }), line('compacted', { window_number: 2 }), msgUser('go'), reason(), tokenCount(300, 1000)]);
  try {
    const s = await read(t.file);
    const [a, b] = s.steps.filter(x => x.kind === 'compaction');
    assert.equal(a.detail.before, 700);
    assert.equal(a.detail.after, 'unknown');
    assert.equal(b.detail.before, 'unknown');
    assert.equal(b.detail.after, 300);
  } finally { t.cleanup(); }
});

test('token_count records without a running total are never merged as duplicates', async () => {
  const noTotal = (i) => line('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: i }, model_context_window: 50000 } });
  const t = tmpFile([msgUser('a'), reason(), noTotal(400), reason(), noTotal(400)]);
  try {
    const s = await read(t.file);
    assert.equal(s.steps.filter(x => x.checkpoint).length, 2);
  } finally { t.cleanup(); }
});

test('a user shell line is an event step that starts no turn', async () => {
  const t = tmpFile([
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<user_shell_command>\n<command>\nls -la\n</command>\n<result>\nExit code: 0\n</result>\n</user_shell_command>' }] }),
    msgUser('real prompt'),
  ]);
  try {
    const s = await read(t.file);
    assert.deepEqual(s.steps.map(x => x.kind), ['start', 'event', 'prompt']);
    assert.equal(s.steps[1].label, 'Shell command: ls -la');
    assert.equal(s.steps[1].turn, null);
    assert.equal(s.steps[2].turn, 1);
  } finally { t.cleanup(); }
});

// --- T15: subagent lanes ---

const FIX = path.join(__dirname, 'fixtures', 'flow');
const PARENT_ID = '00000000-0000-4000-8000-000000000002';
const CHILD_ID = '00000000-0000-4000-8000-000000000003';
const two = (n) => String(n).padStart(2, '0');
// A rollout's place in the store, as Codex files it: the day folder and the name begin with the start time in LOCAL time.
const rel = (ms, id) => {
  const d = new Date(ms);
  const day = `${d.getFullYear()}/${two(d.getMonth() + 1)}/${two(d.getDate())}`;
  return `${day}/rollout-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}-${id}.jsonl`;
};
const T0 = Date.parse('2026-01-01T13:00:00.000Z');

// A rollout store laid out the way Codex files it: <root>/<year>/<month>/<day>/rollout-<start>-<id>.jsonl.
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-codex-tree-'));
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const fixtureText = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');
const headerLine = (id, source) => JSON.stringify({ timestamp: '2026-01-01T13:00:02.000Z', type: 'session_meta', payload: { id, cwd: '<project>', source } }) + '\n';
const spawnSource = (parent, agentPath, depth) => ({ subagent: { thread_spawn: { parent_thread_id: parent, depth: depth || 1, agent_path: agentPath, agent_nickname: 'Nick' } } });
const PARENT_REL = rel(T0, PARENT_ID);
const standard = () => tree({
  [PARENT_REL]: fixtureText('codex-parent.jsonl'),
  [rel(T0 + 1000, CHILD_ID)]: fixtureText('codex-child.jsonl'),
  [rel(T0 + 10000, '00000000-0000-4000-8000-000000000004')]: fixtureText('codex-guardian.jsonl'),
});
async function readTree(t, opts, relPath = PARENT_REL) {
  const file = path.join(t.root, relPath);
  const sources = [{ sourceId: 'main', role: 'transcript', laneHint: 'main', file }, { sourceId: 'agents', role: 'rollout-scan', laneHint: 'agents', file: path.dirname(file) }];
  const snap = await readSessionFlow(sources, opts || {});
  assert.deepEqual(validateSnapshot(snap).errors, []);
  return snap;
}

test('a spawned child is a lane: depth, label, anchors by task name and by the child message; the guardian is never a lane', async () => {
  const t = standard();
  try {
    const snap = await readTree(t);
    assert.equal(snap.lanes.length, 2, 'main and the one child; the guardian rollout is skipped');
    const lane = snap.lanes[1];
    assert.equal(lane.id, 'agent:' + CHILD_ID);
    assert.equal(lane.kind, 'agent');
    assert.equal(lane.parentLaneId, 'main');
    assert.equal(lane.depth, 1);
    assert.equal(lane.label, 'Fake: worker');
    const spawn = snap.steps.find(s => s.id === lane.spawnAnchor.stepId);
    assert.equal(spawn.detail.tool, 'spawn_agent');
    assert.equal(spawn.laneId, 'main');
    const ret = snap.steps.find(s => s.id === lane.returnAnchor.stepId);
    assert.equal(ret.kind, 'agent');
    assert.equal(ret.laneId, 'main');
    assert.match(ret.detail.text, /Three files/);
    assert.ok(snap.steps.filter(s => s.laneId === lane.id).length >= 3);
    assert.deepEqual(snap.steps.map(s => s.ordinal), snap.steps.map((_, i) => i));
    assert.ok(!snap.steps.some(s => s.laneId === lane.id && /rm -rf/.test(s.detail.input || '')), 'no guardian step in the child lane');
    assert.equal(snap.capabilities.agents.state, 'partial');
    assert.equal(snap.complete, true);
  } finally { t.cleanup(); }
});

test('a child turn started by another agent is a prompt marked startedBy agent; ids are stable on a re-read', async () => {
  const t = standard();
  try {
    const a = await readTree(t);
    const b = await readTree(t);
    const lane = 'agent:' + CHILD_ID;
    const prompt = a.steps.find(s => s.laneId === lane && s.kind === 'prompt');
    assert.equal(prompt.detail.startedBy, 'agent');
    assert.equal(prompt.turn, 1);
    assert.deepEqual(a.steps.map(s => s.id), b.steps.map(s => s.id));
    assert.equal(new Set(a.steps.map(s => s.id)).size, a.steps.length);
    assert.equal(a.steps.find(s => s.laneId === lane && s.kind === 'start').label, 'Agent start');
  } finally { t.cleanup(); }
});

test('a lane whose result never reached the parent has no return anchor and stays open', async () => {
  const parent = fixtureText('codex-parent.jsonl').split('\n').filter(l => l && !l.includes('agent_message') && !l.includes('inter_agent_communication_metadata')).join('\n') + '\n';
  const t = tree({ [PARENT_REL]: parent, [rel(T0 + 1000, CHILD_ID)]: fixtureText('codex-child.jsonl') });
  try {
    const snap = await readTree(t);
    assert.equal(snap.lanes[1].returnAnchor, null);
    assert.notEqual(snap.lanes[1].spawnAnchor, null);
  } finally { t.cleanup(); }
});

test('lane.waiting is set only by an explicit wait call with no answer; another unanswered call is not a wait', async () => {
  const t = standard();
  try {
    const snap = await readTree(t);
    assert.ok(snap.lanes.every(l => l.waiting === undefined), 'the fixture wait was answered');
  } finally { t.cleanup(); }
  const call = (name, id) => line('response_item', { type: 'function_call', name, call_id: id, arguments: '{}' });
  const w = tmpFile([call('wait_agent', 'w1')]);
  const x = tmpFile([call('exec_command', 'x1')]);
  try {
    assert.equal((await read(w.file)).lanes[0].waiting, true);
    assert.equal((await read(x.file)).lanes[0].waiting, undefined);
  } finally { w.cleanup(); x.cleanup(); }
  const empty = await readSessionFlow([], {});
  assert.equal(validateSnapshot({ ...empty, lanes: [{ id: 'main', kind: 'main', waiting: 'yes' }] }).ok, false);
});

test('a message to another agent is an event on the sender lane', async () => {
  const f = tmpFile([
    line('response_item', { type: 'function_call', name: 'send_message', call_id: 'm1', arguments: '{"target":"/root/helper","message":"Please stop early."}' }),
    line('response_item', { type: 'function_call_output', call_id: 'm1', output: 'sent' }),
  ]);
  try {
    const snap = await read(f.file);
    const e = snap.steps.find(s => s.kind === 'event');
    assert.equal(e.label, 'Message to helper: Please stop early.');
    assert.equal(e.detail.tool, 'send_message');
    assert.equal(e.detail.result, 'sent');
  } finally { f.cleanup(); }
});

test('only rollouts inside the parent window are opened; a child in a later day folder inside it is found, nested ones too', async () => {
  const LATE = '00000000-0000-4000-8000-0000000000bb';
  const GRAND = '00000000-0000-4000-8000-0000000000cc';
  const id = (n) => '00000000-0000-4000-8000-0000000000' + n;
  const start = new Date(2026, 0, 1, 23, 58, 0).getTime();   // local time: the parent runs across local midnight
  const line1 = (ms, type, payload) => JSON.stringify({ timestamp: new Date(ms).toISOString(), type, payload }) + '\n';
  const header = (ms, hid, source) => line1(ms, 'session_meta', { id: hid, cwd: '<project>', source });
  const parent = header(start, PARENT_ID, 'exec') + line1(start + 4 * 60000, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] });
  const t = tree({
    [rel(start, PARENT_ID)]: parent,
    [rel(start + 3 * 60000, LATE)]: header(start + 3 * 60000, LATE, spawnSource(PARENT_ID, '/root/late')),
    [rel(start + 3.5 * 60000, GRAND)]: header(start + 3.5 * 60000, GRAND, spawnSource(LATE, '/root/late/deep', 2)),
    // outside the window (parent first line - 2 min - 1 h for the clock change .. last line + 2 min): named like children of the parent, never opened
    [rel(start - 90 * 60000, id('dd'))]: header(start, id('dd'), spawnSource(PARENT_ID, '/root/early')),
    [rel(start + 30 * 60000, id('ee'))]: header(start, id('ee'), spawnSource(PARENT_ID, '/root/after')),
    [rel(start + 3 * 86400000, id('ff'))]: header(start, id('ff'), spawnSource(PARENT_ID, '/root/days-later')),
    // inside the window: an ordinary session and a child of another session are opened and skipped
    [rel(start + 2 * 60000, id('aa'))]: header(start + 2 * 60000, id('aa'), 'exec'),
    [rel(start + 2.5 * 60000, id('ab'))]: header(start + 2.5 * 60000, id('ab'), spawnSource(id('99'), '/root/x')),
  });
  try {
    let stats = null;
    const snap = await readTree(t, { onScan: (s) => { stats = s; } }, rel(start, PARENT_ID));
    assert.deepEqual(snap.lanes.map(l => l.id), ['main', 'agent:' + LATE, 'agent:' + GRAND]);
    const byId = Object.fromEntries(snap.lanes.map(l => [l.id, l]));
    assert.equal(byId['agent:' + LATE].parentLaneId, 'main');
    assert.equal(byId['agent:' + GRAND].parentLaneId, 'agent:' + LATE);
    assert.equal(byId['agent:' + GRAND].depth, 2);
    assert.equal(byId['agent:' + LATE].spawnAnchor, null, 'no spawn call named it');
    assert.equal(stats.read, 4, 'LATE, GRAND, the ordinary session and the other session\'s child; none of the three outside the window');
    assert.equal(snap.complete, true);
    // a window of one day lists one folder; the folder the window crosses into is the second
    assert.equal(stats.dirs, 2);
  } finally { t.cleanup(); }
});

test('a header is judged from its first 4 KB: a large non-child is not read on, a large child is', async () => {
  const big = 'x'.repeat(40 * 1024);
  const BIG_CHILD = '00000000-0000-4000-8000-0000000000b1';
  const head = (id, source) => JSON.stringify({ timestamp: new Date(T0 + 1000).toISOString(), type: 'session_meta', payload: { id, source, base_instructions: big } }) + '\n';
  const t = tree({
    [PARENT_REL]: fixtureText('codex-parent.jsonl'),
    [rel(T0 + 1000, BIG_CHILD)]: head(BIG_CHILD, spawnSource(PARENT_ID, '/root/big')),
    [rel(T0 + 2000, '00000000-0000-4000-8000-0000000000b2')]: head('00000000-0000-4000-8000-0000000000b2', 'exec'),
    [rel(T0 + 3000, '00000000-0000-4000-8000-0000000000b3')]: head('00000000-0000-4000-8000-0000000000b3', { subagent: { other: 'guardian' } }),
  });
  try {
    let stats = null;
    const snap = await readTree(t, { onScan: (s) => { stats = s; } });
    assert.deepEqual(snap.lanes.map(l => l.id), ['main', 'agent:' + BIG_CHILD]);
    assert.equal(stats.read, 3);
    assert.ok(stats.bytes < 3 * 4096 + 50 * 1024, 'only the child was read past the head: ' + stats.bytes);
    assert.ok(stats.bytes >= 3 * 4096, 'each opened rollout cost its head');
  } finally { t.cleanup(); }
});

test('the rollouts read are reported by file and size, and no path is in the snapshot', async () => {
  const t = standard();
  try {
    let reported = null;
    const snap = await readTree(t, { onFiles: (l) => { reported = l; } });
    assert.equal(reported.length, 1);
    assert.ok(reported[0].file.endsWith(path.basename(rel(T0 + 1000, CHILD_ID))));
    assert.equal(reported[0].size, fs.statSync(reported[0].file).size);
    assert.ok(!JSON.stringify(snap).includes(t.root));
  } finally { t.cleanup(); }
});

test('without a scan source nothing is searched; the caps and an abort cover the child files too', async () => {
  const t = standard();
  try {
    const file = path.join(t.root, PARENT_REL);
    const alone = await readSessionFlow([{ sourceId: 'main', laneHint: 'main', file }], {});
    assert.equal(alone.lanes.length, 1);
    const full = await readTree(t);
    const capped = await readTree(t, { maxSteps: full.steps.length - 2 });
    assert.equal(capped.complete, false);
    assert.ok(capped.limitations.some(l => l.id === 'step-cap'));
    assert.equal(capped.steps.length, full.steps.length - 2);
    const ctl = new AbortController();
    ctl.abort();
    const aborted = await readTree(t, { signal: ctl.signal });
    assert.equal(aborted.complete, false);
    assert.ok(aborted.limitations.some(l => l.id === 'aborted'));
  } finally { t.cleanup(); }
});

// --- T15 verifier fixes ---

const MIN = 60000;
const tsl = (ms, type, payload) => JSON.stringify({ timestamp: new Date(ms).toISOString(), type, payload }) + '\n';
const hdr = (ms, hid, source, extra) => tsl(ms, 'session_meta', Object.assign({ id: hid, cwd: '<project>', source }, extra));
const chat = (ms, text) => tsl(ms, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const call = (ms, name, id, args) => tsl(ms, 'response_item', { type: 'function_call', name, call_id: id, arguments: JSON.stringify(args || {}) });
const START = new Date(2026, 0, 1, 10, 0, 0).getTime();
const uid = (n) => '00000000-0000-4000-8000-0000000001' + String(n).padStart(2, '0');

test('a child whose first line is longer than the header cap is still a lane; one whose fields cannot be read makes the snapshot incomplete', async () => {
  const BIG = uid(1);
  const LOST = uid(2);
  const filler = 'x'.repeat(100 * 1024);
  const t = tree({
    [rel(START, PARENT_ID)]: hdr(START, PARENT_ID, 'exec') + chat(START + MIN, 'hi'),
    // `source` precedes the filler, as in a real header: the fields are taken from the bytes read
    [rel(START + 10000, BIG)]: hdr(START + 10000, BIG, spawnSource(PARENT_ID, '/root/big'), { base_instructions: filler }),
  });
  try {
    const snap = await readTree(t, {}, rel(START, PARENT_ID));
    assert.deepEqual(snap.lanes.map(l => l.id), ['main', 'agent:' + BIG]);
    assert.equal(snap.lanes[1].label, 'Nick');
    assert.equal(snap.complete, true);
  } finally { t.cleanup(); }
  // the id comes after the filler: a thread_spawn is seen, the id is not
  const lost = '{"timestamp":"' + new Date(START + 20000).toISOString() + '","type":"session_meta","payload":{"source":' + JSON.stringify(spawnSource(PARENT_ID, '/root/lost')) + ',"base_instructions":"' + filler + '","id":"' + LOST + '"}}\n';
  const t2 = tree({ [rel(START, PARENT_ID)]: hdr(START, PARENT_ID, 'exec') + chat(START + MIN, 'hi'), [rel(START + 20000, LOST)]: lost });
  try {
    const snap = await readTree(t2, {}, rel(START, PARENT_ID));
    assert.equal(snap.lanes.length, 1);
    assert.equal(snap.complete, false);
    assert.ok(snap.limitations.some(l => l.id === 'agent-header-unreadable'));
  } finally { t2.cleanup(); }
});

test('waiting: only the last wait call, and only while unanswered and no later turn began or was aborted', async () => {
  const lanes = async (lines) => { const f = tmpFile(lines); try { return (await read(f.file)).lanes[0]; } finally { f.cleanup(); } };
  const w = (id) => line('response_item', { type: 'function_call', name: 'wait_agent', call_id: id, arguments: '{}' });
  const out = (id) => line('response_item', { type: 'function_call_output', call_id: id, output: '{"timed_out":true}' });
  assert.equal((await lanes([w('a')])).waiting, true);
  assert.equal((await lanes([w('a'), out('a')])).waiting, undefined, 'answered');
  assert.equal((await lanes([w('a'), out('a'), w('b')])).waiting, true, 'the last one is open');
  assert.equal((await lanes([w('a'), line('event_msg', { type: 'turn_aborted', reason: 'interrupted' })])).waiting, undefined, 'the turn was aborted');
  assert.equal((await lanes([w('a'), userText('next question')])).waiting, undefined, 'a new turn began');
  assert.equal((await lanes([w('a'), line('inter_agent_communication_metadata', { trigger_turn: true }), line('response_item', { type: 'agent_message', author: '/root/boss', recipient: '/root', content: [{ type: 'input_text', text: 'go' }] })])).waiting, undefined, 'a turn started by another agent');
});

test('a rollout named up to an hour before the window is still opened (the clock change); one much earlier is not', async () => {
  const t = tree({
    [rel(START, PARENT_ID)]: hdr(START, PARENT_ID, 'exec') + chat(START + MIN, 'hi'),
    [rel(START - 50 * MIN, uid(3))]: hdr(START, uid(3), 'exec'),
    [rel(START - 5 * 3600000, uid(4))]: hdr(START, uid(4), 'exec'),
  });
  try {
    let stats = null;
    await readTree(t, { onScan: (x) => { stats = x; } }, rel(START, PARENT_ID));
    assert.equal(stats.read, 1);
  } finally { t.cleanup(); }
});

test('a lane re-parented onto main (a chain too deep) loses its anchors, which named steps of the lane it came from', async () => {
  const N = 11;
  const names = (i) => 'n' + i;
  const pathOf = (i) => '/root/' + Array.from({ length: i }, (_, k) => names(k + 1)).join('/');
  const files = { [rel(START, PARENT_ID)]: hdr(START, PARENT_ID, 'exec') + call(START + 1000, 'spawn_agent', 'c0', { task_name: names(1) }) };
  for (let i = 1; i <= N; i++) {
    const at = START + i * 5000;
    files[rel(at, uid(10 + i))] = hdr(at, uid(10 + i), spawnSource(i === 1 ? PARENT_ID : uid(9 + i), pathOf(i), i))
      + (i < N ? call(at + 1000, 'spawn_agent', 'c' + i, { task_name: names(i + 1) }) : chat(at + 1000, 'end'));
  }
  const t = tree(files);
  try {
    const snap = await readTree(t, {}, rel(START, PARENT_ID));
    assert.equal(snap.lanes.length, N + 1);
    const moved = snap.lanes.filter(l => l.id !== 'main' && l.parentLaneId === 'main' && l.depth === 1 && l.spawnAnchor === null);
    assert.ok(moved.length >= 1, 'a lane beyond the depth bound hangs on main with no anchor');
    for (const l of snap.lanes) if (l.spawnAnchor) assert.equal(l.spawnAnchor.laneId, l.parentLaneId, 'an anchor always lies in the parent lane');
  } finally { t.cleanup(); }
});

test('a child that ran past the parent window widens it: its own child, spawned later, is found', async () => {
  const C1 = uid(21);
  const C2 = uid(22);
  const t = tree({
    [rel(START, PARENT_ID)]: hdr(START, PARENT_ID, 'exec') + chat(START + 2 * MIN, 'parent ends'),
    // the child's last line is 10 minutes after the parent's; its own child starts 8 minutes in (outside the parent's window)
    [rel(START + MIN, C1)]: hdr(START + MIN, C1, spawnSource(PARENT_ID, '/root/a')) + chat(START + 10 * MIN, 'child still working'),
    [rel(START + 8 * MIN, C2)]: hdr(START + 8 * MIN, C2, spawnSource(C1, '/root/a/b', 2)) + chat(START + 9 * MIN, 'grandchild'),
  });
  try {
    const snap = await readTree(t, {}, rel(START, PARENT_ID));
    assert.deepEqual(snap.lanes.map(l => l.id), ['main', 'agent:' + C1, 'agent:' + C2]);
    assert.equal(snap.lanes[2].parentLaneId, 'agent:' + C1);
    assert.equal(snap.lanes[2].depth, 2);
  } finally { t.cleanup(); }
});

test('the demo fixtures are in time order: the child runs between the parent\'s spawn call and the child\'s message', async () => {
  const t = standard();
  try {
    const snap = await readTree(t);
    const lane = snap.lanes[1];
    const at = (anchor) => snap.steps.find(x => x.id === anchor.stepId).ts;
    const mine = snap.steps.filter(x => x.laneId === lane.id).map(x => x.ts);
    assert.ok(Math.min(...mine) >= at(lane.spawnAnchor), 'starts after the spawn call');
    assert.ok(Math.max(...mine) <= at(lane.returnAnchor), 'ends before its result reaches the parent');
  } finally { t.cleanup(); }
});
