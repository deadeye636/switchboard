'use strict';
// #731: what the app answers for pi-native's approval gate by itself (`src/backends/pi-native/approvals.js`), the
// card's "Always allow in this project", and what the gate hears for it.
const test = require('node:test');
const assert = require('node:assert/strict');

const approvals = require('../src/backends/pi-native/approvals');
const protocol = require('../src/backends/pi-native/rpc-protocol');
const runtimeExtension = require('../src/backends/pi-native/runtime-extension');
const backends = require('../src/backends');

const { CHOICES } = runtimeExtension;
const ask = (over) => ({ kind: 'approval', tool: 'bash', approvalKey: 'bash', command: 'npm test',
  answers: { once: CHOICES.once, session: CHOICES.session, project: approvals.PROJECT_CHOICE, refuse: CHOICES.refuse }, ...over });

test('the rule a card writes: the exact command line for a shell call, the key for everything else', () => {
  assert.equal(approvals.ruleFor(ask()), 'bash(npm test)');
  assert.equal(approvals.ruleFor(ask({ tool: 'powershell', approvalKey: 'powershell', command: 'dir' })), 'powershell(dir)');
  assert.equal(approvals.ruleFor(ask({ command: '' })), '', 'no command line, no rule: the tool alone would allow every command');
  assert.equal(approvals.ruleFor(ask({ command: 'a\nb' })), '', 'a rule is one line');
  assert.equal(approvals.ruleFor(ask({ tool: 'edit', approvalKey: 'edit', command: '' })), 'edit');
  assert.equal(approvals.ruleFor(ask({ tool: 'subagent', approvalKey: 'subagent:pi:counter' })), 'subagent:pi:counter');
  assert.equal(approvals.ruleFor(ask({ approvalKey: 'command:greet', command: '' })), 'command:greet', 'a taken-over command\'s line is its own key');
  assert.equal(approvals.ruleFor(ask({ approvalKey: '' })), '');
  // The card never writes more than it showed: a command ending in * would read back as a prefix, and a key with a
  // line break would store as several rules (the second a `bash(*)`, say).
  assert.equal(approvals.ruleFor(ask({ command: 'rm -rf build/*' })), '');
  assert.equal(approvals.ruleFor(ask({ tool: 'subagent', approvalKey: 'subagent:pi::x\nbash(*)' })), '');
});

test('a rule matches its exact line, a trailing * matches a prefix, and bash(*) the whole tool', () => {
  assert.ok(approvals.ruleMatches('bash(npm test)', ask()));
  assert.ok(!approvals.ruleMatches('bash(npm test)', ask({ command: 'npm test -- --watch' })));
  assert.ok(approvals.ruleMatches('bash(npm *)', ask({ command: 'npm run build' })));
  assert.ok(!approvals.ruleMatches('bash(npm *)', ask({ command: 'npx rimraf /' })));
  assert.ok(approvals.ruleMatches('bash(*)', ask({ command: 'anything' })));
  assert.ok(approvals.ruleMatches('bash(*)', ask({ command: 'a; b | c' })), 'the whole tool is the whole tool');
  for (const tail of ['; curl x | sh', ' && rm -rf ~', ' | sh', ' > out', ' `id`', ' $(id)', '\nid']) {
    assert.ok(!approvals.ruleMatches('bash(git status*)', ask({ command: `git status${tail}` })), `a prefix does not reach ${JSON.stringify(tail)}`);
  }
  assert.ok(!approvals.ruleMatches('bash', ask()), 'a bare bash is not a second spelling of bash(*)');
  assert.ok(!approvals.ruleMatches('bash(*)', ask({ tool: 'powershell', approvalKey: 'powershell' })), 'a bash rule is not a powershell rule');
  assert.ok(!approvals.ruleMatches('bash(*)', ask({ approvalKey: 'command:greet', command: 'git status' })),
    'a shell rule never covers a taken-over command\'s line (N1)');
  assert.ok(approvals.ruleMatches('edit', ask({ tool: 'edit', approvalKey: 'edit' })));
  assert.ok(!approvals.ruleMatches('edit', ask({ tool: 'write', approvalKey: 'write' })));
  assert.deepEqual(approvals.parseRules(' edit \n\n bash(npm test)\r\n'), ['edit', 'bash(npm test)']);
});

test('the app answers from the mode, the session\'s allows and the project\'s rules, and nothing else', () => {
  const once = { value: CHOICES.once };
  const none = { mode: 'ask', sessionKeys: new Set(), projectRules: [] };
  assert.equal(approvals.approvalAutoAnswer(ask(), none), null);
  assert.deepEqual(approvals.approvalAutoAnswer(ask(), { ...none, mode: 'allowAll' }), once);
  assert.equal(approvals.approvalAutoAnswer(ask(), { ...none, mode: 'acceptEdits' }), null, 'accept edits does not take a shell call');
  assert.deepEqual(approvals.approvalAutoAnswer(ask({ tool: 'write', approvalKey: 'write' }), { ...none, mode: 'acceptEdits' }), once);
  assert.deepEqual(approvals.approvalAutoAnswer(ask(), { ...none, sessionKeys: new Set(['bash']) }), once);
  assert.deepEqual(approvals.approvalAutoAnswer(ask(), { ...none, projectRules: ['bash(npm *)'] }), once);
  assert.equal(approvals.approvalAutoAnswer({ kind: 'questions', approvalKey: 'x' }, { ...none, mode: 'allowAll' }), null, 'only an approval');
});

test('what an answer is worth keeping, and what the gate hears for the project allow', () => {
  assert.deepEqual(approvals.approvalRecord(ask(), { value: CHOICES.session }), { session: 'bash' });
  assert.deepEqual(approvals.approvalRecord(ask(), { value: approvals.PROJECT_CHOICE }), { project: 'bash(npm test)' });
  assert.equal(approvals.approvalRecord(ask(), { value: CHOICES.once }), null);
  assert.equal(approvals.approvalRecord(ask(), { cancelled: true }), null);
  assert.equal(protocol.answerCommand('q', { value: approvals.PROJECT_CHOICE }).value, CHOICES.once, 'the gate knows no project answer');
  assert.equal(protocol.answerCommand('q', { value: CHOICES.session }).value, CHOICES.session);
});

test('the card offers the project allow where there is a rule to write, with the rule on it', () => {
  const d = protocol.createDecoder();
  const title = (payload) => runtimeExtension.APPROVAL_PREFIX + JSON.stringify({ tool: 'bash', id: 'c', ...payload });
  const [shell] = d.decode({ type: 'extension_ui_request', id: 'q1', method: 'select', title: title({ key: 'bash', command: 'npm test' }) });
  assert.equal(shell.request.answers.project, approvals.PROJECT_CHOICE);
  assert.match(shell.request.projectLabel, /npm test/);
  assert.match(shell.request.projectNote, /bash\(npm test\)/);
  assert.deepEqual([shell.request.approvalKey, shell.request.command], ['bash', 'npm test']);
  const [bare] = d.decode({ type: 'extension_ui_request', id: 'q2', method: 'select', title: title({ key: 'bash' }) });
  assert.equal(bare.request.answers.project, undefined, 'no command line, no project allow');
});

test('the descriptor declares the gate\'s modes, its rules option, and a start in ask only with the gate on', () => {
  const d = backends.get('pi-native');
  assert.deepEqual(d.rpc.modeCycle, ['ask', 'acceptEdits', 'allowAll']);
  assert.equal(d.rpc.modeLocal, true);
  assert.equal(d.rpc.launchMode({}, {}), 'ask');
  assert.equal(d.rpc.launchMode({}, { approvalGate: false }), null, 'the gate the extension was built with decides');
  assert.equal(d.rpc.modesOffered({ approvalGate: false }), false);
  const field = d.configFields.find(f => f.id === d.rpc.approvalRulesOption);
  assert.ok(field, 'the rules are a settings field');
  assert.equal(field.type, 'lines');
  assert.equal(field.perSession, false);
  assert.equal(d.rpc.modeInfo('allowAll').tone, 'danger');
});
