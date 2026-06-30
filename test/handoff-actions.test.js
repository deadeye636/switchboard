const { test } = require('node:test');
const assert = require('node:assert');
const { computeHandoffActions } = require('../public/handoff-actions.js');

test('running session with project → guided + copy + new session', () => {
  const a = computeHandoffActions({ canAskRunning: true, handoffLibrary: false, hasProject: true });
  assert.strictEqual(a.mode, 'running');
  assert.strictEqual(a.confirm, 'Hand off (guided)');
  assert.strictEqual(a.secondary, 'Copy Packet');
  assert.strictEqual(a.tertiary, 'New session');
});

test('running session library on → unchanged (guided already covers save/resume)', () => {
  const a = computeHandoffActions({ canAskRunning: true, handoffLibrary: true, hasProject: true });
  assert.strictEqual(a.mode, 'running');
  assert.strictEqual(a.secondary, 'Copy Packet');
  assert.strictEqual(a.tertiary, 'New session');
});

test('not running, project, library OFF → copy + new session, no save', () => {
  const a = computeHandoffActions({ canAskRunning: false, handoffLibrary: false, hasProject: true });
  assert.strictEqual(a.mode, 'local');
  assert.strictEqual(a.confirm, 'Copy Handoff');
  assert.strictEqual(a.secondary, null);
  assert.strictEqual(a.tertiary, 'New session');
});

test('not running, project, library ON → copy + save + new session', () => {
  const a = computeHandoffActions({ canAskRunning: false, handoffLibrary: true, hasProject: true });
  assert.strictEqual(a.mode, 'local');
  assert.strictEqual(a.secondary, 'Save to library');
  assert.strictEqual(a.tertiary, 'New session');
});

test('no project → no new-session, no save, even with library on', () => {
  const a = computeHandoffActions({ canAskRunning: false, handoffLibrary: true, hasProject: false });
  assert.strictEqual(a.mode, 'local');
  assert.strictEqual(a.secondary, null);
  assert.strictEqual(a.tertiary, null);
});

test('running but no project falls back to local mode', () => {
  const a = computeHandoffActions({ canAskRunning: true, handoffLibrary: false, hasProject: false });
  assert.strictEqual(a.mode, 'local');
  assert.strictEqual(a.tertiary, null);
});

test('missing input is treated as all-false (local, copy only)', () => {
  const a = computeHandoffActions();
  assert.strictEqual(a.mode, 'local');
  assert.strictEqual(a.confirm, 'Copy Handoff');
  assert.strictEqual(a.secondary, null);
  assert.strictEqual(a.tertiary, null);
});
