'use strict';
// The task target declaration (#804, spec 41, plan step T4): every backend answers `taskProfile`, the two pipe drivers
// with the options a writing task starts with, and `taskTargets` offers only what can really run one.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { taskTargets, reviewTargets, profileOf } = require('../src/backends/review-targets');

const IDS = ['claude', 'claude-native', 'pi', 'pi-native', 'codex', 'agy', 'hermes'];
const descriptors = IDS.map((id) => require(`../src/backends/${id}`));
const all = new Set(IDS);

test('every backend answers taskProfile, and only the two pipe drivers answer a profile', () => {
  const answers = Object.fromEntries(descriptors.map((d) => [d.id, d.taskProfile()]));
  assert.deepEqual(answers, {
    claude: null,
    // Claude's default mode, sent as a flag: an edit or a command is asked for first.
    'claude-native': { options: { permissionMode: 'default', permissionModeSent: true, promptSuggestionsOff: true } },
    pi: null,
    'pi-native': { options: { approvalGate: true } },
    codex: null,
    agy: null,
    hermes: null,
  });
});

test('a task profile is never the read-only plan mode a review uses', () => {
  const native = descriptors.find((d) => d.id === 'claude-native');
  assert.notEqual(native.taskProfile().options.permissionMode, native.reviewProfile().options.permissionMode);
  assert.notEqual(native.taskProfile().options.permissionMode, 'bypassPermissions');
});

test('the claude-native task launch SENDS --permission-mode default; the stored default of the settings screen still sends nothing', () => {
  // Without the flag an unconfigured Claude starts in auto mode on the models that take it (#776), and a task's edits
  // would never be asked for. The pin is on the argv, not on the profile's words.
  const native = descriptors.find((d) => d.id === 'claude-native');
  const argv = (options) => native.buildLaunch({ cwd: '/w', sessionId: 's1', options }).args;
  const task = argv(native.taskProfile().options);
  assert.equal(task[task.indexOf('--permission-mode') + 1], 'default');
  assert.equal(native.rpc.launchMode(native.taskProfile().options), 'default', 'the session line names the mode the launch sent');
  assert.equal(argv({ permissionMode: 'default' }).includes('--permission-mode'), false, 'a stored default is never sent');
  assert.equal(argv({ permissionMode: 'plan' })[argv({ permissionMode: 'plan' }).indexOf('--permission-mode') + 1], 'plan');
  assert.equal(argv({ permissionMode: 'nonsense', permissionModeSent: true }).includes('--permission-mode'), false);
});

test('the capability row says the same as the hook, with a note for every answer', () => {
  for (const d of descriptors) {
    const row = d.capabilities.task;
    assert.ok(row && typeof row.state === 'string', `${d.id} answers the task row`);
    assert.equal(row.state, d.taskProfile() ? 'yes' : 'no', d.id);
    assert.ok(typeof row.note === 'string' && row.note.length > 0, `${d.id} says why`);
  }
});

test('taskTargets offers the two drivers when they can launch, with the task options, not the review ones', () => {
  assert.deepEqual(taskTargets(descriptors, all).map((t) => [t.id, t.options]), [
    ['claude-native', { permissionMode: 'default', permissionModeSent: true, promptSuggestionsOff: true }],
    ['pi-native', { approvalGate: true }],
  ]);
  assert.deepEqual(taskTargets(descriptors, new Set(['pi-native'])).map((t) => t.id), ['pi-native']);
  assert.deepEqual(taskTargets(descriptors, null), []);
  assert.deepEqual(reviewTargets(descriptors, all)[0].options, { permissionMode: 'plan', promptSuggestionsOff: true },
    'the review targets are unchanged');
});

test('taskTargets leaves out a template, a backend without a pipe, and a bad or declined profile', () => {
  const native = descriptors.find((d) => d.id === 'claude-native');
  const stubs = [
    { ...native, id: 'tpl', isProfile: true },
    { ...native, id: 'no-pipe', transport: undefined },
    { ...native, id: 'throws', taskProfile: () => { throw new Error('x'); } },
    { ...native, id: 'declines', taskProfile: () => null },
    { ...native, id: 'review-only', taskProfile: undefined },
    { ...native, id: 'good', label: 'Good' },
  ];
  assert.deepEqual(taskTargets(stubs, new Set(stubs.map((s) => s.id))).map((t) => t.id), ['good']);
  assert.equal(profileOf(stubs[2], 'taskProfile'), null);
});

test('a returned options object is a copy', () => {
  const [first] = taskTargets(descriptors, all);
  first.options.permissionMode = 'bypassPermissions';
  assert.equal(taskTargets(descriptors, all)[0].options.permissionMode, 'default');
});
