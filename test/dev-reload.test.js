'use strict';
// #665 — a dev run follows an edit under src/: a renderer file reloads the windows, anything else restarts
// the app, and the restart goes through app.quit() so the ordered teardown runs. The old reloader called
// app.exit(0), which skips before-quit/will-quit; with a terminal open the old process never finished
// exiting and the relauncher waited for it for good. It also judged "main process" from the modules loaded
// before its own require line, so an edit to most of src/app reloaded only the renderer.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const devReload = require('../src/app/dev-reload');
const { classifyChange } = devReload;

function fakeElectron() {
  const calls = [];
  const app = new EventEmitter();
  app.isPackaged = false;
  app.relaunch = () => calls.push('relaunch');
  app.quit = () => calls.push('quit');
  app.exit = () => calls.push('exit');
  const reloaded = [];
  const win = { isDestroyed: () => false, webContents: { reloadIgnoringCache: () => reloaded.push('win') } };
  const BrowserWindow = { getAllWindows: () => [win] };
  let listener = null;
  let closed = 0;
  const watcher = new EventEmitter();
  watcher.close = () => { closed++; };
  const watch = (_dir, opts, cb) => { assert.equal(opts.recursive, true); listener = cb; return watcher; };
  return { app, BrowserWindow, watch, calls, reloaded, emit: (f) => listener('change', f), closedCount: () => closed };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

test('a renderer file reloads, everything else under src/ restarts', () => {
  assert.equal(classifyChange('renderer/app.js'), 'reload');
  assert.equal(classifyChange('renderer\\styles\\panes.css'), 'reload');
  // The files the old snapshot missed: required below its line in main.js, or loaded by a worker.
  for (const f of ['app/terminal/spawn.js', 'app/lifecycle.js', 'db/db.js', 'workers/index-worker.js',
    'main.js', 'preload.js', 'shared/worktree-path.js', 'backends/claude/session-reader.js']) {
    assert.equal(classifyChange(f), 'restart', f);
  }
});

test('noise is not followed', () => {
  for (const f of ['', null, undefined, 'app/.spawn.js.swp', '.DS_Store', 'renderer/app.js.map',
    'app/spawn.js~', 'app/dist/x.js']) {
    assert.equal(classifyChange(f), null, String(f));
  }
});

test('a main-process edit restarts through quit, never exit', async () => {
  const e = fakeElectron();
  const handle = devReload.start({ ...e, srcDir: '.', settleMs: 5 });
  e.emit('app\\terminal\\spawn.js');
  await settle();
  assert.deepEqual(e.calls, ['relaunch', 'quit'], 'app.exit would skip the teardown and hang with a PTY open');
  assert.equal(e.closedCount(), 1, 'the watch is closed once the restart is under way');
  handle.close();
});

test('a burst of events restarts once, and a renderer edit in the same burst does not reload first', async () => {
  const e = fakeElectron();
  const handle = devReload.start({ ...e, srcDir: '.', settleMs: 5 });
  e.emit('renderer/app.js');
  e.emit('app/windows.js');
  e.emit('app/windows.js');
  await settle();
  e.emit('app/lifecycle.js');
  await settle();
  assert.deepEqual(e.calls, ['relaunch', 'quit']);
  assert.deepEqual(e.reloaded, []);
  handle.close();
});

test('a renderer-only edit reloads the windows and keeps the main process', async () => {
  const e = fakeElectron();
  const handle = devReload.start({ ...e, srcDir: '.', settleMs: 5 });
  e.emit('renderer/panes/panes-view.js');
  e.emit('renderer/styles.css');
  await settle();
  assert.deepEqual(e.calls, []);
  assert.deepEqual(e.reloaded, ['win']);
  handle.close();
});

test('the watch is closed at will-quit, and a packaged build starts nothing', () => {
  const e = fakeElectron();
  const handle = devReload.start({ ...e, srcDir: '.', settleMs: 5 });
  e.app.emit('will-quit');
  assert.equal(e.closedCount(), 1);
  handle.close();

  const p = fakeElectron();
  p.app.isPackaged = true;
  assert.equal(devReload.start({ ...p, srcDir: '.' }), null);
});

test('a watch that cannot start is reported, not thrown', () => {
  const e = fakeElectron();
  const warned = [];
  const out = devReload.start({
    ...e, srcDir: '.', log: { warn: (m) => warned.push(m) },
    watch: () => { throw new Error('ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'); },
  });
  assert.equal(out, null);
  assert.equal(warned.length, 1);
});
