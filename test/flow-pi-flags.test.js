'use strict';
// Pi's highlights (spec 46, #826, plan T23): the shared command list on `bash` calls, and the pi-native gate's refusal as a
// structured outcome only in a session the transport marker says was driven over the pipe. Read through the real reader on
// small hand-built sessions. The command list itself is tested in `flow-claude-flags.test.js` (it is shared).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateSnapshot } = require('../src/shared/flow-snapshot');
const { readSessionFlow } = require('../src/backends/pi/flow-reader');
const PF = require('../src/backends/pi/flow-flags');

const T = '2026-01-01T14:00:00.000Z';
const header = () => ({ type: 'session', version: 3, id: 's1', timestamp: T, cwd: '<project>' });
const marker = () => ({ type: 'custom', customType: 'switchboard-transport', data: { transport: 'rpc' }, timestamp: T });
const entry = (message) => ({ type: 'message', timestamp: T, message });
const user = (text) => entry({ role: 'user', content: [{ type: 'text', text }] });
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 };
const call = (id, name, args) => entry({ role: 'assistant', model: 'pi-fake-model', provider: 'fake', content: [{ type: 'toolCall', id, name, arguments: args }], usage });
const result = (id, name, isError, text) => entry({ role: 'toolResult', toolCallId: id, toolName: name, isError, content: [{ type: 'text', text }] });
const codes = (flags) => flags.map((f) => f.code).sort();

async function readLinesOf(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-pi-flags-'));
  const file = path.join(dir, 's.jsonl');
  let prev = null;
  const chained = lines.map((l, i) => {
    if (l.type === 'session') return l;
    const out = { ...l, id: `n${i}`, parentId: prev };
    prev = out.id;
    return out;
  });
  fs.writeFileSync(file, chained.map((l) => JSON.stringify(l)).join('\n') + '\n');
  try {
    const snap = await readSessionFlow([{ sourceId: 'main', role: 'transcript', laneHint: 'main', file }], {});
    assert.deepEqual(validateSnapshot(snap).errors, []);
    return snap;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const tools = (snap) => snap.steps.filter((s) => s.kind === 'tool');

test('commandFlags: bash commands only, POSIX dialect, heuristic', () => {
  const f = PF.commandFlags('bash', { command: 'git reset --hard HEAD~1' });
  assert.deepEqual(codes(f), ['destructive:git-reset-hard']);
  assert.equal(f[0].evidence, 'heuristic');
  assert.equal(f[0].axis, 'risk');
  assert.deepEqual(PF.commandFlags('bash', { command: 'rm -rf node_modules' }), []);
  assert.deepEqual(PF.commandFlags('bash', { command: 'echo "rm -rf /"' }), []);
  assert.deepEqual(PF.commandFlags('read', { command: 'rm -rf /' }), [], 'not a shell tool');
  // Pi's powershell tool: the PowerShell dialect, so `rm -r` there carries the Remove-Item wording.
  assert.deepEqual(codes(PF.commandFlags('powershell', { command: 'Remove-Item -Recurse -Force C:\\' })), ['destructive:remove-item-recurse']);
  assert.deepEqual(codes(PF.commandFlags('powershell', { command: 'rm -r -Force ~' })), ['destructive:remove-item-recurse']);
  assert.deepEqual(codes(PF.commandFlags('bash', { command: 'rm -r -f ~' })), ['destructive:rm-recursive']);
  assert.deepEqual(PF.commandFlags('constructor', { command: 'rm -rf /' }), [], 'a prototype name is no tool');
  assert.deepEqual(PF.commandFlags('bash', {}), []);
  assert.deepEqual(PF.commandFlags('bash', null), []);
});

test('isGateRefusal: the exact reason text, the tool named in it, and only with a transport', () => {
  assert.equal(PF.isGateRefusal('The user did not allow this bash call.', 'bash', 'rpc'), true);
  assert.equal(PF.isGateRefusal('  The user did not allow this bash call.\n', 'bash', 'rpc'), true);
  assert.equal(PF.isGateRefusal('The user did not allow this bash call.', 'bash', null), false, 'terminal Pi has no gate');
  assert.equal(PF.isGateRefusal('The user did not allow this edit call.', 'bash', 'rpc'), false, 'another tool');
  assert.equal(PF.isGateRefusal('The user did not allow this bash call. Also more.', 'bash', 'rpc'), false);
  assert.equal(PF.isGateRefusal('This delegation cannot run.', 'subagent', 'rpc'), false, 'a block without a question is not a refusal');
});

test('reader (pi-native): a refused destructive call carries the risk mark AND a denial that replaces the plain error', async () => {
  const snap = await readLinesOf([
    header(), marker(), user('clean up'),
    call('t1', 'bash', { command: 'rm -rf ~' }), result('t1', 'bash', true, 'The user did not allow this bash call.'),
    call('t2', 'bash', { command: 'git push --force origin main' }), result('t2', 'bash', false, 'ok'),
    call('t3', 'bash', { command: 'false' }), result('t3', 'bash', true, 'exit 1'),
    call('t4', 'read', { path: 'README.md' }), result('t4', 'read', false, 'text'),
  ]);
  const [t1, t2, t3, t4] = tools(snap);
  assert.deepEqual(codes(t1.flags), ['destructive:rm-recursive', 'permission-denied']);
  const denied = t1.flags.find((f) => f.code === 'permission-denied');
  assert.equal(denied.axis, 'outcome');
  assert.equal(denied.evidence, 'structured');
  assert.equal(t1.detail.refused, true);
  assert.deepEqual(codes(t2.flags), ['destructive:git-force-push'], 'a risky call that ran has no outcome flag');
  assert.deepEqual(codes(t3.flags), ['tool-error']);
  assert.equal(t3.detail.refused, undefined);
  assert.deepEqual(t4.flags, []);
});

test('reader (terminal Pi): the same refusal text is a plain error and no denial; the risk mark stays', async () => {
  const snap = await readLinesOf([
    header(), user('clean up'),
    call('t1', 'bash', { command: 'rm -rf ~' }), result('t1', 'bash', true, 'The user did not allow this bash call.'),
  ]);
  const [t1] = tools(snap);
  assert.deepEqual(codes(t1.flags), ['destructive:rm-recursive', 'tool-error']);
  assert.equal(t1.detail.refused, undefined);
});

test('reader: the user\'s own ! shell line is an event and is not matched', async () => {
  const snap = await readLinesOf([header(), entry({ role: 'bashExecution', command: 'rm -rf ~', output: '', exitCode: 0 })]);
  for (const s of snap.steps) assert.ok(!s.flags.some((f) => f.code.startsWith('destructive:')), s.kind);
});

test('reader: the capability says yes with a heuristic limitation', async () => {
  const snap = await readLinesOf([header(), user('a')]);
  assert.equal(snap.capabilities.destructivePatterns.state, 'yes');
  const lim = snap.limitations.find((l) => l.id === snap.capabilities.destructivePatterns.limitationId);
  assert.match(lim.text, /heuristic/);
  assert.ok(!snap.limitations.some((l) => l.id === 'patterns-later'));
});
