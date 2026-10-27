'use strict';
// Stopping a running session (#130, #396), shared by the `stop-session` handler and the review runner (spec 39, T4).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { stopSession } = require('../src/app/terminal/stop-session');
const { stripComments } = require('./helpers/strip-comments');

const fakeTimeline = () => {
  const lines = [];
  return { lines, recordLifecycle: (...args) => lines.push(args) };
};
const fakeSession = (over = {}) => {
  const s = { exited: false, kills: 0, ...over };
  s.pty = { kill: () => { s.kills += 1; } };
  return s;
};

test('a running session is marked, recorded with the reason and killed once', () => {
  const timeline = fakeTimeline();
  const s = fakeSession();
  assert.deepEqual(stopSession(s, 'sid', { timeline, reason: 'Stopped by the user.' }), { ok: true });
  assert.equal(s.exited, true);
  assert.equal(s.kills, 1);
  assert.deepEqual(timeline.lines, [['sid', 'stopped', 'Session stopped', 'Stopped by the user.']]);
});

test('the timeline names the real session id when the session has one, and the runner\'s reason', () => {
  const timeline = fakeTimeline();
  stopSession(fakeSession({ realSessionId: 'real' }), 'launch', { timeline, reason: 'Stopped: the review ended.' });
  assert.deepEqual(timeline.lines, [['real', 'stopped', 'Session stopped', 'Stopped: the review ended.']]);
});

test('a session that is gone or already stopped is refused and nothing is recorded', () => {
  const timeline = fakeTimeline();
  assert.deepEqual(stopSession(undefined, 'sid', { timeline }), { ok: false, error: 'not running' });
  const done = fakeSession({ exited: true });
  assert.deepEqual(stopSession(done, 'sid', { timeline }), { ok: false, error: 'not running' });
  assert.equal(done.kills, 0);
  assert.deepEqual(timeline.lines, []);
});

test('a kill that throws still leaves the session marked as stopped', () => {
  const s = { exited: false, pty: { kill: () => { throw new Error('gone'); } } };
  assert.deepEqual(stopSession(s, 'sid', { timeline: fakeTimeline(), reason: 'x' }), { ok: true });
  assert.equal(s.exited, true);
});

test('the stop-session handler goes through the shared function with the user\'s reason', () => {
  const main = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8'));
  assert.match(main, /ipcMain\.handle\('stop-session',[\s\S]{0,120}stopSession\(activeSessions\.get\(sessionId\), sessionId, \{ timeline, reason: 'Stopped by the user\.' \}\)/);
});
