'use strict';
// The main window's size, position and display mode are persisted by Electron (`windowStatePersistence`,
// #846). windows.js pulls in Electron, so the wiring is checked against its source, as quit-guard.test.js does.
// What matters: the window is named (persistence has no effect without a name), it asks for persistence,
// it still gets the saved `windowBounds` in the constructor as the fallback, and what Electron restored is
// checked against the displays there are now. Comments are stripped first, so a commented-out line
// cannot pass.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { stripComments } = require('./helpers/strip-comments');

const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'windows.js'), 'utf8'));
const ctorStart = src.indexOf('const mainWindow = new BrowserWindow({');
const ctor = src.slice(ctorStart, src.indexOf('});', ctorStart));
const restoreStart = src.indexOf("mainWindow.once('persisted-state-restored'");
const restoreGuard = src.slice(restoreStart, src.indexOf('});', src.indexOf('mainWindow.setBounds(', restoreStart)) + 3);

test('the main window is created with a name and windowStatePersistence', () => {
  assert.ok(ctorStart > 0, 'main window constructor not found');
  assert.match(ctor, /name:\s*MAIN_WINDOW_STATE_NAME/);
  assert.match(src, /const MAIN_WINDOW_STATE_NAME = '[^']+'/);
  assert.match(ctor, /windowStatePersistence:\s*true/);
});

test('the fallback bounds (size and position) still reach the constructor, behind the on-screen guard', () => {
  assert.match(ctor, /\.\.\.bounds/);
  assert.match(src, /ctx\.getSetting\('global'\)\?\.windowBounds/);
  assert.match(src, /positionOnScreen\(savedBounds\.x, savedBounds\.y\)/);
  assert.match(src, /bounds\.x = savedBounds\.x/);
  assert.match(src, /bounds\.y = savedBounds\.y/);
  assert.match(src, /screen\.getAllDisplays\(\)/);
});

test('what Electron restored is checked against the displays, and only an off-screen window is moved', () => {
  assert.ok(restoreStart > 0, 'no persisted-state-restored guard');
  assert.match(restoreGuard, /isMaximized\(\)/);
  assert.match(restoreGuard, /positionOnScreen\(restored\.x, restored\.y\)\) return;/);
  assert.match(restoreGuard, /getPrimaryDisplay\(\)\.workArea/);
});

test('no setBounds outside that guard: nothing overwrites a good restore', () => {
  const outside = src.slice(0, restoreStart) + src.slice(restoreStart + restoreGuard.length);
  assert.doesNotMatch(outside, /mainWindow\.setBounds\(/);
});

test('the fallback writer saves normal bounds, on move/resize and on close', () => {
  assert.match(src, /mainWindow\.getNormalBounds\(\)/);
  assert.match(src, /mainWindow\.on\('resize', saveBounds\)/);
  assert.match(src, /mainWindow\.on\('move', saveBounds\)/);
  assert.match(src, /clearTimeout\(boundsTimer\);\s*writeFallbackBounds\(\);/);
});
