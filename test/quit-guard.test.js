'use strict';
// Closing the main window kills every PTY the app owns — a Claude in the middle of a turn, a build running
// in a terminal. It used to do that without a word, and an accidental Alt+F4 was enough.
//
// main.js cannot be tested (nothing requires it), so the decision and the wording live in quit-guard.js.
// The wiring — that the question is asked BEFORE anything is torn down — is checked against main.js's
// source, the way the other main-process guards are.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { runningSessions, shouldAskBeforeClose, closeWarning } = require('../quit-guard');

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
  assert.match(w.detail, /Settings → Sessions & CLI/, 'and it says how to switch itself off');
});

test('main.js asks BEFORE it tears anything down — a cancelled close must leave the app intact', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
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
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');

  assert.match(main, /wc\.send\('confirm-close', warning\)/, 'main asks the renderer');
  assert.match(main, /ipcMain\.on\('confirm-close-result'/, 'and listens for the answer');
  assert.match(main, /closeConfirmed = true;\s*\n\s*if \(mainWindow[\s\S]{0,80}\.close\(\)/,
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
