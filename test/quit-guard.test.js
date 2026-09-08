'use strict';
// Closing the main window kills every PTY the app owns — a Claude in the middle of a turn, a build running
// in a terminal. It used to do that without a word, and an accidental Alt+F4 was enough.
//
// The window itself cannot be tested (windows.js pulls in Electron), so the decision and the wording live
// in quit-guard.js. The wiring — that the question is asked BEFORE anything is torn down — is checked
// against app/windows.js's source, the way the other main-process guards are. It moved there from main.js
// with #213's extraction 2; the assertions follow the code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { runningSessions, survivingSessions, shouldAskBeforeClose, closeWarning } = require('../src/app/quit-guard');

const live = (over = {}) => ({ exited: false, projectPath: 'D:\\a', ...over });

test('runningSessions: an exited PTY is not a loss', () => {
  const map = new Map([
    ['a', live()],
    ['b', live({ exited: true })],
    ['c', live({ projectPath: 'D:\\b' })],
    ['d', null],
  ]);
  assert.equal(runningSessions(map).length, 2);
  assert.equal(runningSessions(new Map()).length, 0);
  assert.equal(runningSessions(null).length, 0);
});

test('nothing running: no question — closing is closing', () => {
  assert.equal(shouldAskBeforeClose([], {}), false);
});

test('something running: ask, and ask by DEFAULT — a settings blob that predates the option still gets it', () => {
  assert.equal(shouldAskBeforeClose([live()], {}), true);
  assert.equal(shouldAskBeforeClose([live()], { confirmQuitWithRunningSessions: true }), true);
  assert.equal(shouldAskBeforeClose([live()], undefined), true);
});

test('only an explicit off switches it off', () => {
  assert.equal(shouldAskBeforeClose([live()], { confirmQuitWithRunningSessions: false }), false);
});

test('the question names sessions and terminals apart — they are not the same loss', () => {
  const w = closeWarning([live(), live(), live({ isPlainTerminal: true })]);
  assert.match(w.message, /^2 sessions and 1 terminal still running\./);

  assert.match(closeWarning([live()]).message, /^1 session still running\./);
  assert.match(closeWarning([live({ isPlainTerminal: true })]).message, /^1 terminal still running\./);
});

test('the question says WHERE, and how many in each place', () => {
  const w = closeWarning([
    live({ projectPath: 'D:\\x' }),
    live({ projectPath: 'D:\\x' }),
    live({ projectPath: 'D:\\y', isPlainTerminal: true }),
  ]);
  // The dialog ellipsises the VALUE and gives the label a narrow fixed column, so the count is the label
  // and the path is the value — the other way round, a long path runs straight through the count.
  assert.deepEqual(w.details, [
    { label: '2 sessions', value: 'D:\\x' },
    { label: '1 terminal', value: 'D:\\y' },
  ], 'one row per place — the same project twice is one place, and the row says what is in it');
});

test('it does not list forty projects to say it', () => {
  const many = Array.from({ length: 9 }, (_, i) => live({ projectPath: 'D:\\p' + i }));
  const w = closeWarning(many);
  assert.equal(w.details.length, 7, 'six places, then one row that counts the rest');
  assert.deepEqual(w.details[6], { label: '', value: '…and 3 more' });
});

test('the native fallback carries the same thing as text — a renderer that cannot answer must not trap the app', () => {
  const w = closeWarning([live({ projectPath: 'D:\\x' })]);
  assert.match(w.detail, /D:\\x/);
  assert.match(w.detail, /Settings → Sessions/, 'and it says how to switch itself off');
});

test('windows.js asks BEFORE it tears anything down — a cancelled close must leave the app intact', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'windows.js'), 'utf8');
  const handler = src.slice(src.indexOf("mainWindow.on('close'"));
  const guardAt = handler.indexOf('confirmCloseWithRunningSessions()');
  const destroyAt = handler.indexOf('settingsWindow.destroy()');

  assert.ok(guardAt > -1, 'the close handler asks');
  assert.ok(destroyAt > -1, 'and it is the one that destroys the settings window');
  assert.ok(guardAt < destroyAt,
    'ask first: a close the user cancels would otherwise still have taken the settings window with it');
  assert.match(handler.slice(guardAt, guardAt + 200), /event\.preventDefault\(\)/,
    'and a no actually cancels the close');
});

test('the question goes to the app\'s own dialog, and the yes comes back to close for real', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'windows.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');

  assert.match(main, /wc\.send\('confirm-close', warning\)/, 'main asks the renderer');
  assert.match(main, /ipc\.on\('confirm-close-result'/, 'and listens for the answer');
  assert.match(main, /closeConfirmed = true;[\s\S]{0,120}\.close\(\)/,
    'a yes closes again, past the guard');
  assert.match(preload, /onConfirmClose/, 'the binding exists');
  assert.match(preload, /confirmCloseResult/);
  assert.match(app, /onConfirmClose\(async \(warning\) => \{/, 'the renderer puts the app\'s dialog up');
  assert.match(app, /dismissible: false/,
    'and a stray backdrop click is not an answer to a question about work you cannot get back');

  // The native box stays as the fallback for a renderer that cannot answer — without it a crashed
  // renderer would leave a window that can never be closed.
  assert.match(main, /isCrashed\(\)[\s\S]{0,400}showMessageBoxSync/);
});

// --- What closing does NOT stop (#608) ------------------------------------------------------------
//
// The dialog counted `activeSessions` and said "Closing Switchboard stops them" about everything it
// listed. A CLI running under a daemon of its own is not in that map and is not stopped by the quit —
// measured, one was still holding its session the next day. The old wording was therefore both silent
// about those sessions and wrong about them at the same time.

const held = (over = {}) => ({ sessionId: 's-1', kind: 'background', name: 'a job', ...over });

test('#608: a surviving session is named, and NOT as something closing stops', () => {
  const w = closeWarning([live()], [held({ name: 'a handoff job' })]);
  assert.match(w.message, /1 session still running\. Closing Switchboard stops it/,
    'the first group keeps its wording — those really are stopped');
  assert.match(w.message, /will KEEP running afterwards/,
    'and the second group is told apart, because that sentence is false about it');
  assert.ok(w.details.some(d => d.value === 'a handoff job' && d.label === 'keeps running'));
});

test('#608: no surviving sessions changes nothing about the dialog', () => {
  const before = closeWarning([live()], []);
  assert.doesNotMatch(before.message, /KEEP running/);
  assert.deepEqual(before, closeWarning([live()]),
    'the second argument is additive — an app with nothing outside it sees the dialog it always saw');
});

test('#608: a cold or missing owner list says nothing rather than guessing', () => {
  for (const cold of [undefined, null, []]) {
    assert.doesNotMatch(closeWarning([live()], cold).message, /KEEP running/);
  }
  assert.deepEqual(survivingSessions(null), []);
  assert.deepEqual(survivingSessions([null, {}, held()]), [held()],
    'an entry with no session id is not an entry');
});

test('#608: the native fallback text carries the surviving rows too', () => {
  const w = closeWarning([live()], [held({ name: 'a handoff job' })]);
  assert.match(w.detail, /a handoff job — keeps running/,
    'the native box has no detail rows, so anything only in `details` would be invisible there');
});

test('#608: a long list of survivors is capped like the first group', () => {
  const many = Array.from({ length: 9 }, (_, i) => held({ sessionId: `s-${i}`, name: `job ${i}` }));
  const w = closeWarning([live()], many);
  assert.equal(w.details.filter(d => d.label === 'keeps running').length, 6);
  assert.ok(w.details.some(d => d.value === '…and 3 more'));
});

// The half that is easy to lose: the switch that turns the dialog off is asked about the sessions the
// quit STOPS, and a surviving session must not resurrect a dialog the user has switched off.
test('#608: the surviving list does not reopen a dialog the user turned off', () => {
  assert.equal(shouldAskBeforeClose([live()], { confirmQuitWithRunningSessions: false }), false);
  assert.equal(shouldAskBeforeClose([], {}), false,
    'nothing of ours is running — today that is silence, and #608 records it as a decision');
});

test('#608: the confirm button stops claiming to stop what it does not', () => {
  assert.equal(closeWarning([live()], []).confirmLabel, 'Close and stop them',
    'with nothing surviving, the click really does stop everything listed');
  assert.equal(closeWarning([live()], [held()]).confirmLabel, 'Close anyway',
    'one session on the list that keeps running makes "stop them" a false claim about the button too');
});

// One survivor and several are a different sentence, and the first draft only read wrong with exactly
// one: "1 session … the process holding them".
test('#608: both sentences agree with their own counts', () => {
  const one = closeWarning([live()], [held()]).message;
  assert.match(one, /1 session still running\. Closing Switchboard stops it/,
    'this half predates #608 and read "stops them" about a single session');
  assert.match(one, /1 session will KEEP running/);
  assert.match(one, /the process holding it and cannot stop it\./);

  const two = closeWarning([live(), live()], [held(), held({ sessionId: 's-2' })]).message;
  assert.match(two, /2 sessions still running\. Closing Switchboard stops them/);
  assert.match(two, /2 sessions will KEEP running/);
  assert.match(two, /the processes holding them and cannot stop them\./);
});
