'use strict';
// Codex's highlights (spec 46, #826, plan T22): how a shell call is found in a rollout, the escalation request, the
// permission flag, the heuristic access-denied outcome, the guardian's request and verdict and how they are paired, and the
// whole of it read through the real reader on `fixtures/flow/codex-flags.jsonl` with its guardian rollout
// `fixtures/flow/codex-flags-guardian.jsonl`. The command list itself is tested in `flow-claude-flags.test.js` (it is shared).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateSnapshot } = require('../src/shared/flow-snapshot');
const { readSessionFlow } = require('../src/backends/codex/flow-reader');
const CF = require('../src/backends/codex/flow-flags');

const FIX = path.join(__dirname, 'fixtures', 'flow');
const MAIN_ID = '00000000-0000-4000-8000-000000000005';
const GUARDIAN_ID = '00000000-0000-4000-8000-000000000006';
const codes = (flags) => flags.map((f) => f.code).sort();

// --- Reading the call ---

test('shellCallsOf: an exec script with a JSON object literal gives its command and escalation', () => {
  const input = 'const r = await tools.exec_command({"cmd":"git status","sandbox_permissions":"require_escalated","justification":"why"});';
  assert.deepEqual(CF.shellCallsOf('custom_tool_call', 'exec', input), [{ command: 'git status', escalated: true, justification: 'why' }]);
});

test('shellCallsOf: the JavaScript spelling (unquoted keys, single quotes) is read; a template with ${} is an unknown command', () => {
  const plain = "await tools.exec_command({ cmd: 'ls -la', workdir: '<project>' });";
  assert.deepEqual(CF.shellCallsOf('custom_tool_call', 'exec', plain), [{ command: 'ls -la', escalated: false, justification: '' }]);
  const tpl = "const d = '/x';\nawait tools.exec_command({ cmd: `rm -rf ${d}`, sandbox_permissions: 'require_escalated' });";
  const [call] = CF.shellCallsOf('custom_tool_call', 'exec', tpl);
  assert.equal(call.command, null, 'a command built in code is not read');
  assert.equal(call.escalated, true, 'the escalation request is still read');
  const concat = "await tools.exec_command({ cmd: 'rm -rf ' + dir });";
  assert.equal(CF.shellCallsOf('custom_tool_call', 'exec', concat)[0].command, null, 'a concatenation is not a plain string');
});

test('shellCallsOf: several calls in one script, in order; a script without one gives none', () => {
  const input = "await tools.exec_command({cmd:'a'});\nawait tools.shell_command({cmd:'b'});";
  assert.deepEqual(CF.shellCallsOf('custom_tool_call', 'exec', input).map((c) => c.command), ['a', 'b']);
  assert.deepEqual(CF.shellCallsOf('custom_tool_call', 'exec', 'text("hello")'), []);
  assert.deepEqual(CF.shellCallsOf('custom_tool_call', 'apply_patch', "tools.exec_command({cmd:'a'})"), [], 'not the exec tool');
});

test('shellCallsOf: a shell function call carries JSON; an argv takes its last element; other tools and bad JSON give none', () => {
  assert.equal(CF.shellCallsOf('function_call', 'exec_command', '{"cmd":"ls"}')[0].command, 'ls');
  assert.equal(CF.shellCallsOf('function_call', 'shell', '{"command":["bash","-lc","git reset --hard"]}')[0].command, 'git reset --hard');
  assert.equal(CF.shellCallsOf('function_call', 'shell', '{"command":"pwd","sandbox_permissions":"require_escalated"}')[0].escalated, true);
  assert.deepEqual(CF.shellCallsOf('function_call', 'read_file', '{"cmd":"ls"}'), []);
  assert.deepEqual(CF.shellCallsOf('function_call', 'exec_command', '{not json'), []);
  assert.deepEqual(CF.shellCallsOf('function_call', 'exec_command', ''), []);
});

// --- Flags of a call ---

test('callFlags: escalation is structured risk and says it was asked, not that it ran; a destructive command adds a heuristic mark', () => {
  const flags = CF.callFlags({ command: 'git push --force', escalated: true, justification: 'publish' });
  assert.deepEqual(codes(flags), ['destructive:git-force-push', 'escalation-requested']);
  const esc = flags.find((f) => f.code === 'escalation-requested');
  assert.equal(esc.axis, 'risk');
  assert.equal(esc.evidence, 'structured');
  assert.match(esc.why, /publish/);
  assert.match(esc.why, /not that it ran/);
  assert.equal(flags.find((f) => f.code.startsWith('destructive:')).evidence, 'heuristic');
  assert.deepEqual(CF.callFlags({ command: 'ls', escalated: false, justification: '' }), []);
  assert.deepEqual(CF.callFlags({ command: null, escalated: false, justification: '' }), []);
});

test('callFlags: a PowerShell-shaped command is matched in the PowerShell dialect (one mark for rm -r, PowerShell wording)', () => {
  const flags = CF.callFlags({ command: 'Remove-Item -Recurse -Force $env:USERPROFILE', escalated: false, justification: '' });
  assert.deepEqual(codes(flags), ['destructive:remove-item-recurse']);
});

test('modeFlag: only danger-full-access is risk; never with a sandbox confines the session and is not flagged', () => {
  const f = CF.modeFlag('never', 'danger-full-access');
  assert.equal(f.code, 'mode-danger-full-access');
  assert.equal(f.axis, 'risk');
  assert.equal(f.evidence, 'structured');
  assert.match(f.why, /nothing asks/);
  assert.match(CF.modeFlag('on-request', 'danger-full-access').why, /on-request/);
  assert.equal(CF.modeFlag('never', 'workspace-write'), null);
  assert.equal(CF.modeFlag('never', 'read-only'), null);
  assert.equal(CF.modeFlag('on-request', 'workspace-write'), null);
});

test('accessDeniedFlag: a failed call with an access error is a heuristic outcome; not when escalated, unsandboxed or successful', () => {
  const text = "Access to the path '<project>/x' is denied.";
  const f = CF.accessDeniedFlag(text, 1, { escalated: false, sandbox: 'workspace-write' });
  assert.equal(f.code, 'access-denied');
  assert.equal(f.axis, 'outcome');
  assert.equal(f.evidence, 'heuristic');
  assert.ok(CF.accessDeniedFlag('touch: Permission denied', 1, { escalated: false, sandbox: 'read-only' }));
  assert.equal(CF.accessDeniedFlag(text, 1, { escalated: true, sandbox: 'workspace-write' }), null);
  assert.equal(CF.accessDeniedFlag(text, 1, { escalated: false, sandbox: 'danger-full-access' }), null);
  assert.equal(CF.accessDeniedFlag(text, 0, { escalated: false, sandbox: 'workspace-write' }), null);
  assert.equal(CF.accessDeniedFlag(text, null, { escalated: false, sandbox: 'workspace-write' }), null);
  assert.equal(CF.accessDeniedFlag('No such file or directory', 1, { escalated: false, sandbox: 'workspace-write' }), null);
});

// --- The guardian ---

test('guardianRequestOf: the LAST request object wins over the quoted transcript; argv gives its last element', () => {
  const quoted = JSON.stringify({ command: ['pwsh.exe', '-Command', 'echo quoted'], sandbox_permissions: 'require_escalated' });
  const req = JSON.stringify({ command: ['pwsh.exe', '-Command', 'rm -rf /x'], cwd: '<project>', sandbox_permissions: 'require_escalated', tool: 'exec_command' });
  const text = `Review.\n>>> TRANSCRIPT START\n[1] user: ${quoted}\n>>> APPROVAL REQUEST\n${req}\n>>> END`;
  assert.deepEqual(CF.guardianRequestOf(text), { command: 'rm -rf /x' });
  assert.deepEqual(CF.guardianRequestOf(JSON.stringify({ command: 'ls', sandbox_permissions: 'x' })), { command: 'ls' });
  assert.equal(CF.guardianRequestOf('no request here'), null);
  assert.equal(CF.guardianRequestOf(null), null);
});

test('guardianRequestOf: braces inside the command do not matter, however many; an escaped key inside a string is skipped', () => {
  const ps = 'Get-ChildItem | ForEach-Object { if ($_.Length -gt 0) { @{ a = { 1 }; b = { 2 }; c = @{ d = { 3 } } } } }';
  const req = JSON.stringify({ command: ['pwsh.exe', '-Command', ps], sandbox_permissions: 'require_escalated' });
  assert.deepEqual(CF.guardianRequestOf(`>>> APPROVAL REQUEST\n${req}`), { command: ps });
  const tricky = 'echo "\\"sandbox_permissions\\" { {"';
  const req2 = JSON.stringify({ command: tricky, sandbox_permissions: 'require_escalated' });
  assert.deepEqual(CF.guardianRequestOf(req2), { command: tricky });
});

test('guardianVerdictOf: the short and the full verdict, a fenced one; prose and a verdict without outcome are none', () => {
  assert.deepEqual(CF.guardianVerdictOf('{"outcome":"allow"}'), { outcome: 'allow', riskLevel: '', userAuthorization: '', rationale: '' });
  const full = CF.guardianVerdictOf('```json\n{"risk_level":"high","user_authorization":"low","outcome":"deny","rationale":"r"}\n```');
  assert.deepEqual(full, { outcome: 'deny', riskLevel: 'high', userAuthorization: 'low', rationale: 'r' });
  assert.equal(CF.guardianVerdictOf('I think this is fine.'), null);
  assert.equal(CF.guardianVerdictOf('{"risk_level":"low"}'), null);
  assert.equal(CF.guardianVerdictOf('{broken'), null);
});

test('matchVerdicts: by order, confirmed by text; an unseen review leaves a gap and never shifts; an unknown command is never paired', () => {
  const allow = { outcome: 'allow' };
  const deny = { outcome: 'deny' };
  const esc = [{ command: 'a' }, { command: null }, { command: 'b' }, { command: 'c' }];
  const turns = [
    { command: 'a', verdict: allow },
    { command: 'x', verdict: allow },         // a review of a call this reader did not see
    { command: 'b  ', verdict: deny },        // whitespace is folded
  ];
  assert.deepEqual(CF.matchVerdicts(esc, turns), [allow, null, deny, null], 'c had no review: a rule already approved it');
  // Two identical commands pair in order.
  assert.deepEqual(CF.matchVerdicts([{ command: 'a' }, { command: 'a' }], [{ command: 'a', verdict: allow }, { command: 'a', verdict: deny }]), [allow, deny]);
  // A turn whose request could not be read is never paired.
  assert.deepEqual(CF.matchVerdicts([{ command: 'a' }], [{ command: null, verdict: deny }]), [null]);
  // An unreviewed call does not cost a later, different call its verdict.
  const vB = { outcome: 'allow', tag: 'B' };
  const vA = { outcome: 'deny', tag: 'A' };
  assert.deepEqual(CF.matchVerdicts([{ command: 'A' }, { command: 'B' }, { command: 'A' }], [{ command: 'B', verdict: vB }, { command: 'A', verdict: vA }]), [null, vB, vA]);
});

test('shellCallsOf: an adversarial script of unreadable literals stays bounded', () => {
  const bad = 'await tools.exec_command({a: ('.repeat(3000);
  const unclosed = "await tools.exec_command({cmd: 'x".repeat(3000);
  for (const script of [bad, unclosed]) {
    const t0 = process.hrtime.bigint();
    for (let k = 0; k < 10; k++) CF.shellCallsOf('custom_tool_call', 'exec', script);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 10;
    assert.ok(ms < 100, `one script took ${ms.toFixed(1)} ms`);
  }
});

test('verdictFlags: allow is a structured outcome; anything else is refused; risk above low is structured risk', () => {
  assert.deepEqual(CF.verdictFlags(null), []);
  assert.deepEqual(codes(CF.verdictFlags({ outcome: 'allow', riskLevel: 'low', userAuthorization: '', rationale: '' })), ['guardian-allowed']);
  // No `deny` was measured on a real rollout: this case is synthetic and stands for every answer that is not allow.
  const refused = CF.verdictFlags({ outcome: 'deny', riskLevel: 'high', userAuthorization: 'low', rationale: 'shared branch' });
  assert.deepEqual(codes(refused), ['guardian-refused', 'guardian-risk-high']);
  for (const f of refused) assert.equal(f.evidence, 'structured');
  assert.match(refused.find((f) => f.code === 'guardian-refused').why, /"deny".*shared branch/);
  assert.match(refused.find((f) => f.code === 'guardian-risk-high').why, /user_authorization low/);
  assert.deepEqual(codes(CF.verdictFlags({ outcome: 'abstain', riskLevel: '', userAuthorization: '', rationale: '' })), ['guardian-refused']);
});

// --- Through the reader ---

const two = (n) => String(n).padStart(2, '0');
const rel = (ms, id) => {
  const d = new Date(ms);
  const day = `${d.getFullYear()}/${two(d.getMonth() + 1)}/${two(d.getDate())}`;
  return `${day}/rollout-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}-${id}.jsonl`;
};
const T0 = Date.parse('2026-01-01T14:00:00.000Z');
const MAIN_REL = rel(T0, MAIN_ID);

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-codex-flags-'));
  for (const [r, content] of Object.entries(files)) {
    const f = path.join(root, r);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const fixtureText = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');

async function readTree(withGuardian) {
  const files = { [MAIN_REL]: fixtureText('codex-flags.jsonl') };
  if (withGuardian) files[rel(T0 + 30000, GUARDIAN_ID)] = fixtureText('codex-flags-guardian.jsonl');
  const t = tree(files);
  try {
    const file = path.join(t.root, MAIN_REL);
    const sources = [
      { sourceId: 'main', role: 'transcript', laneHint: 'main', file },
      { sourceId: 'agents', role: 'rollout-scan', laneHint: 'agents', file: path.dirname(file) },
    ];
    const snap = await readSessionFlow(sources, {});
    assert.deepEqual(validateSnapshot(snap).errors, []);
    return snap;
  } finally {
    t.cleanup();
  }
}
const toolSteps = (snap) => snap.steps.filter((s) => s.kind === 'tool');

test('reader: each call carries exactly its flags; the guardian verdicts reach the escalated calls they reviewed', async () => {
  const snap = await readTree(true);
  assert.equal(snap.lanes.length, 1, 'the guardian rollout is never a lane');
  const tools = toolSteps(snap);
  assert.equal(tools.length, 6);
  assert.deepEqual(tools.map((s) => codes(s.flags)), [
    [],                                                                                             // ls
    ['destructive:git-reset-hard'],                                                                 // heuristic only
    ['destructive:rm-recursive', 'escalation-requested', 'guardian-allowed', 'guardian-risk-medium'],
    ['escalation-requested'],                                                                       // built in code: no mark, no verdict
    ['destructive:git-force-push', 'escalation-requested', 'guardian-refused', 'guardian-risk-high'],
    ['access-denied', 'tool-error'],                                                                // failed with an access error
  ]);
});

test('reader: without the guardian rollout the escalated calls keep their request and get no verdict', async () => {
  const snap = await readTree(false);
  const tools = toolSteps(snap);
  assert.deepEqual(codes(tools[2].flags), ['destructive:rm-recursive', 'escalation-requested']);
  assert.deepEqual(codes(tools[4].flags), ['destructive:git-force-push', 'escalation-requested']);
});

test('reader: a switch to danger-full-access puts the risk on the mode step only; the start under workspace-write has none', async () => {
  const snap = await readTree(true);
  const modes = snap.steps.filter((s) => s.kind === 'mode');
  assert.equal(modes.length, 1);
  assert.deepEqual(codes(modes[0].flags), ['mode-danger-full-access']);
  assert.deepEqual(codes(snap.steps[0].flags), []);
  assert.equal(snap.steps.filter((s) => s.flags.some((f) => f.code === 'mode-danger-full-access')).length, 1);
});

test('reader: a session that STARTS without a sandbox carries the risk on its start step', async () => {
  const text = fixtureText('codex-flags.jsonl').replace('"approval_policy":"on-request","approvals_reviewer":"auto_review","sandbox_policy":{"type":"workspace-write"}',
    '"approval_policy":"never","approvals_reviewer":"auto_review","sandbox_policy":{"type":"danger-full-access"}');
  const t = tree({ [MAIN_REL]: text });
  try {
    const file = path.join(t.root, MAIN_REL);
    const snap = await readSessionFlow([{ sourceId: 'main', role: 'transcript', laneHint: 'main', file }], {});
    assert.deepEqual(validateSnapshot(snap).errors, []);
    assert.deepEqual(codes(snap.steps[0].flags), ['mode-danger-full-access']);
    assert.equal(snap.steps.filter((s) => s.kind === 'mode').length, 0, 'the same policy twice is no mode change');
    assert.equal(toolSteps(snap)[5].flags.some((f) => f.code === 'access-denied'), false, 'no sandbox: an access error is no sandbox block');
  } finally {
    t.cleanup();
  }
});

test('reader: a guardian whose parent is a CHILD lane flags that lane; another session\'s guardian is not read', async () => {
  const PARENT_ID = '00000000-0000-4000-8000-000000000002';
  const CHILD_ID = '00000000-0000-4000-8000-000000000007';
  const OTHER_ID = '00000000-0000-4000-8000-000000000099';
  const P0 = Date.parse('2026-01-01T13:00:00.000Z');
  const toChild = (s) => s.split('2026-01-01T14:00:').join('2026-01-01T13:00:');
  const child = toChild(fixtureText('codex-flags.jsonl')).replace(
    `"id":"${MAIN_ID}","cwd":"<project>","cli_version":"0.0.0-fake","source":"exec"`,
    `"id":"${CHILD_ID}","cwd":"<project>","cli_version":"0.0.0-fake","source":{"subagent":{"thread_spawn":{"parent_thread_id":"${PARENT_ID}","depth":1,"agent_path":"/root/flags","agent_nickname":"Nick"}}}`);
  const guardian = toChild(fixtureText('codex-flags-guardian.jsonl')).split(MAIN_ID).join(CHILD_ID);
  const foreign = toChild(fixtureText('codex-flags-guardian.jsonl')).split(MAIN_ID).join(OTHER_ID);
  const parentRel = rel(P0, PARENT_ID);
  // Same second as the child and a smaller uuid: the guardian's name sorts BEFORE its parent's, so it must wait for the child.
  const guardianRel = rel(P0 + 1000, '00000000-0000-4000-8000-000000000001');
  const foreignRel = rel(P0 + 31000, '00000000-0000-4000-8000-000000000098');
  const t = tree({
    [parentRel]: fixtureText('codex-parent.jsonl'),
    [rel(P0 + 1000, CHILD_ID)]: child,
    [guardianRel]: guardian,
    [foreignRel]: foreign,
  });
  try {
    const file = path.join(t.root, parentRel);
    let seen = [];
    const snap = await readSessionFlow([
      { sourceId: 'main', role: 'transcript', laneHint: 'main', file },
      { sourceId: 'agents', role: 'rollout-scan', laneHint: 'agents', file: path.dirname(file) },
    ], { onFiles: (f) => { seen = f.map((x) => path.basename(x.file)); } });
    assert.deepEqual(validateSnapshot(snap).errors, []);
    const lane = snap.lanes.find((l) => l.id === 'agent:' + CHILD_ID);
    assert.ok(lane, 'the child is a lane');
    const tools = snap.steps.filter((s) => s.laneId === lane.id && s.kind === 'tool');
    assert.deepEqual(codes(tools[2].flags), ['destructive:rm-recursive', 'escalation-requested', 'guardian-allowed', 'guardian-risk-medium']);
    assert.deepEqual(codes(tools[4].flags), ['destructive:git-force-push', 'escalation-requested', 'guardian-refused', 'guardian-risk-high']);
    assert.ok(seen.includes(path.basename(guardianRel)), 'the guardian file is reported for the staleness check');
    assert.ok(!seen.includes(path.basename(foreignRel)), 'another session\'s guardian is not read');
  } finally {
    t.cleanup();
  }
});

test('reader: the capabilities say partial approvals and heuristic patterns, each with its limitation', async () => {
  const snap = await readTree(true);
  assert.equal(snap.capabilities.approvals.state, 'partial');
  assert.equal(snap.capabilities.destructivePatterns.state, 'yes');
  const lim = (id) => snap.limitations.find((l) => l.id === id);
  assert.match(lim(snap.capabilities.approvals.limitationId).text, /guardian/);
  assert.match(lim(snap.capabilities.destructivePatterns.limitationId).text, /heuristic/);
});
