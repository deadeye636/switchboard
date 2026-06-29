// Unit coverage for buildTabModel (public/session-tabs.js) — the pure ordering /
// filtering / active-flag logic behind the session tab strip. DOM-free.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTabModel } = require('../public/session-tabs');

const S = (sessionId, name, closed = false) => ({ sessionId, name, closed });

test('filters out closed sessions', () => {
  const out = buildTabModel([S('a', 'A'), S('b', 'B', true), S('c', 'C')], null, []);
  assert.deepEqual(out.map(t => t.sessionId), ['a', 'c']);
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
