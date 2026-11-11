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
  assert.equal(snap.capabilities.agents.state, 'no');
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
