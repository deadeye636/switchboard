'use strict';
// The review target declaration (#507 slice 2b, spec 39, T3): every backend answers `reviewProfile`, the two pipe
// drivers with their read-only options, and `reviewTargets` offers only what can really run a review.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { reviewTargets, profileOf } = require('../src/backends/review-targets');

const IDS = ['claude', 'claude-native', 'pi', 'pi-native', 'codex', 'agy', 'hermes'];
const descriptors = IDS.map((id) => require(`../src/backends/${id}`));
const all = new Set(IDS);

test('every backend answers reviewProfile, and only the two pipe drivers answer a profile', () => {
  const answers = Object.fromEntries(descriptors.map((d) => [d.id, d.reviewProfile()]));
  assert.deepEqual(answers, {
    claude: null,
    'claude-native': { options: { permissionMode: 'plan', promptSuggestionsOff: true } },
    pi: null,
    'pi-native': { options: { approvalGate: true } },
    codex: null,
    agy: null,
    hermes: null,
  });
  for (const d of descriptors) assert.equal(typeof d.reviewProfile, 'function', d.id);
});

test('the capability row says the same as the hook, with a note for every no', () => {
  for (const d of descriptors) {
    const row = d.capabilities.review;
    assert.ok(row && typeof row.state === 'string', `${d.id} answers the review row`);
    assert.equal(row.state, d.reviewProfile() ? 'yes' : 'no', d.id);
    assert.ok(typeof row.note === 'string' && row.note.length > 0, `${d.id} says why`);
  }
});

test('reviewTargets offers the two drivers when they can launch, with their own options', () => {
  assert.deepEqual(reviewTargets(descriptors, all).map((t) => [t.id, t.options]), [
    ['claude-native', { permissionMode: 'plan', promptSuggestionsOff: true }],
    ['pi-native', { approvalGate: true }],
  ]);
  assert.deepEqual(reviewTargets(descriptors, new Set(['pi-native'])).map((t) => t.id), ['pi-native'], 'a backend that cannot launch is not offered');
  assert.deepEqual(reviewTargets(descriptors, new Set()), []);
  assert.deepEqual(reviewTargets(descriptors, null), [], 'no launchable set offers nothing');
});

test('reviewTargets leaves out a template, a backend without a pipe or an answer reader, and a bad profile', () => {
  const native = descriptors.find((d) => d.id === 'claude-native');
  const stubs = [
    { ...native, id: 'tpl', isProfile: true },
    { ...native, id: 'no-pipe', transport: undefined },
    { ...native, id: 'no-reader', rpc: { ...native.rpc, assistantTextOf: undefined } },
    { ...native, id: 'throws', reviewProfile: () => { throw new Error('x'); } },
    { ...native, id: 'no-options', reviewProfile: () => ({}) },
    { ...native, id: 'declines', reviewProfile: () => null },
    { ...native, id: 'good', label: 'Good' },
  ];
  const ids = new Set(stubs.map((s) => s.id));
  assert.deepEqual(reviewTargets(stubs, ids).map((t) => [t.id, t.label]), [['good', 'Good']]);
  assert.equal(profileOf(stubs[3]), null);
  assert.equal(profileOf(null), null);
});

test('a returned options object is a copy: a caller cannot change the descriptor\'s profile', () => {
  const [first] = reviewTargets(descriptors, all);
  first.options.permissionMode = 'bypassPermissions';
  assert.deepEqual(reviewTargets(descriptors, all)[0].options, { permissionMode: 'plan', promptSuggestionsOff: true });
});
