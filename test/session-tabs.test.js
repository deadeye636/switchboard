// Unit coverage for buildTabModel (public/session-tabs.js) — the pure ordering /
// filtering / active-flag logic behind the session tab strip. DOM-free.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTabModel,
  resolveAutoCloseMode,
  resolveAutoCloseDelaySec,
  shouldAutoClose,
  buildTabTooltip,
  projectTailOf,
} = require('../src/renderer/session/session-tabs');

// --- The tab tooltip (#334) --------------------------------------------------

test('the tooltip carries project, backend and state beside the name', () => {
  assert.equal(
    buildTabTooltip({ name: 'Auth refactor', project: 'frontend', backend: 'Claude', state: 'Working' }),
    'Auth refactor\nfrontend · Claude · Working',
  );
});

test('the tooltip leaves out what is not known rather than showing it blank', () => {
  assert.equal(buildTabTooltip({ name: 'Solo' }), 'Solo');
  assert.equal(buildTabTooltip({ name: 'Solo', state: 'Idle' }), 'Solo\nIdle');
  assert.equal(buildTabTooltip({ name: 'Solo', project: 'api', state: '' }), 'Solo\napi');
  // A backend that declares no label costs no separator.
  assert.equal(buildTabTooltip({ name: 'Solo', project: 'api', backend: null, state: 'Idle' }), 'Solo\napi · Idle');
});

test('the tooltip survives an empty call', () => {
  assert.equal(buildTabTooltip(), '');
  assert.equal(buildTabTooltip({}), '');
});

test('projectTailOf reads the last segment of either path flavour', () => {
  assert.equal(projectTailOf('/srv/projects/api-gateway'), 'api-gateway');
  assert.equal(projectTailOf('D:\\work\\frontend'), 'frontend');
  assert.equal(projectTailOf('/srv/projects/api-gateway/'), 'api-gateway');
  assert.equal(projectTailOf(''), '');
  assert.equal(projectTailOf(undefined), '');
});

const S = (sessionId, name, closed = false) => ({ sessionId, name, closed });

test('keeps closed (exited) sessions — a tab exists until destroySession removes it (#256)', () => {
  // Filtering closed here made an exited tab vanish on the next unrelated rebuild, even with auto-close
  // off. A closed session stays in the model, flagged closed, and leaves only via openSessions.delete.
  const out = buildTabModel([S('a', 'A'), S('b', 'B', true), S('c', 'C')], null, []);
  assert.deepEqual(out.map(t => t.sessionId), ['a', 'b', 'c']);
  assert.equal(out.find(t => t.sessionId === 'b').closed, true);
  assert.equal(out.find(t => t.sessionId === 'a').closed, false);
});

test('marks the active session', () => {
  const out = buildTabModel([S('a', 'A'), S('b', 'B')], 'b', []);
  assert.equal(out.find(t => t.sessionId === 'a').active, false);
  assert.equal(out.find(t => t.sessionId === 'b').active, true);
});

test('respects tabOrder; unknown ids keep input order at the end', () => {
  const sessions = [S('a', 'A'), S('b', 'B'), S('c', 'C'), S('d', 'D')];
  // order names c, a explicitly; b and d are unknown → appended in input order.
  const out = buildTabModel(sessions, null, ['c', 'a']);
  assert.deepEqual(out.map(t => t.sessionId), ['c', 'a', 'b', 'd']);
});

test('order ids no longer open are simply ignored', () => {
  const out = buildTabModel([S('a', 'A'), S('b', 'B')], null, ['x', 'b', 'a']);
  assert.deepEqual(out.map(t => t.sessionId), ['b', 'a']);
});

test('carries the label through as name', () => {
  const out = buildTabModel([S('a', 'Auth refactor')], 'a', []);
  assert.equal(out[0].name, 'Auth refactor');
});

test('handles empty / undefined inputs safely', () => {
  assert.deepEqual(buildTabModel([], null, []), []);
  assert.deepEqual(buildTabModel(undefined, null, undefined), []);
  assert.deepEqual(buildTabModel([S('a', 'A')], null, undefined).map(t => t.sessionId), ['a']);
});

// --- Auto-close on exit ---

test('resolveAutoCloseMode defaults to always and validates the value', () => {
  assert.equal(resolveAutoCloseMode(undefined), 'always');
  assert.equal(resolveAutoCloseMode({}), 'always');
  assert.equal(resolveAutoCloseMode({ tabAutoCloseMode: 'bogus' }), 'always');
  assert.equal(resolveAutoCloseMode({ tabAutoCloseMode: 'never' }), 'never');
  assert.equal(resolveAutoCloseMode({ tabAutoCloseMode: 'onSuccess' }), 'onSuccess');
  assert.equal(resolveAutoCloseMode({ tabAutoCloseMode: 'always' }), 'always');
});

test('resolveAutoCloseDelaySec defaults to 5, honours 0, floors, rejects junk', () => {
  assert.equal(resolveAutoCloseDelaySec(undefined), 5);
  assert.equal(resolveAutoCloseDelaySec({}), 5);
  assert.equal(resolveAutoCloseDelaySec({ tabAutoCloseDelaySec: 0 }), 0);
  assert.equal(resolveAutoCloseDelaySec({ tabAutoCloseDelaySec: 12 }), 12);
  assert.equal(resolveAutoCloseDelaySec({ tabAutoCloseDelaySec: 3.9 }), 3);
  assert.equal(resolveAutoCloseDelaySec({ tabAutoCloseDelaySec: -4 }), 5);
  assert.equal(resolveAutoCloseDelaySec({ tabAutoCloseDelaySec: 'x' }), 5);
});

test('shouldAutoClose applies the mode against the exit code', () => {
  assert.equal(shouldAutoClose('never', 0), false);
  assert.equal(shouldAutoClose('never', 1), false);
  assert.equal(shouldAutoClose('onSuccess', 0), true);
  assert.equal(shouldAutoClose('onSuccess', 1), false);
  assert.equal(shouldAutoClose('always', 0), true);
  assert.equal(shouldAutoClose('always', 1), true);
  assert.equal(shouldAutoClose('bogus', 0), false);
});
