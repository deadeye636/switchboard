// Main-side per-session notifications (#847): replace by id, clear per platform, no leak.
// A fake `electron` is injected so the real module runs without an app.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const MODULE = path.join(__dirname, '..', 'src', 'app', 'notifications.js');

function load(platform) {
  const made = [];
  const removed = [];
  class FakeNotification {
    constructor(options) {
      this.options = options;
      this.handlers = {};
      this.closed = 0;
      this.shown = 0;
      made.push(this);
    }
    static isSupported() { return true; }
    static remove(id) { removed.push(id); }
    on(name, fn) { this.handlers[name] = fn; }
    show() { this.shown += 1; }
    close() { this.closed += 1; }
  }
  const fakeElectron = {
    app: {}, ipcMain: {}, Menu: {}, Tray: class {}, nativeImage: {}, Notification: FakeNotification,
  };
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'electron' ? fakeElectron : realLoad.call(this, request, ...rest);
  };
  delete require.cache[MODULE];
  let mod;
  try { mod = require(MODULE); } finally { Module._load = realLoad; }

  const handlers = {};
  const sent = [];
  const win = {
    isDestroyed: () => false, isMinimized: () => false, show() {}, focus() {},
    webContents: { send: (...args) => sent.push(args) },
  };
  mod.init({ getMainWindow: () => win, log: { error() {}, warn() {} } });
  mod.registerIpc({ on: (name, fn) => { handlers[name] = fn; } });

  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  return {
    made, removed, sent, mod,
    notify: (payload) => handlers.notify({}, payload),
    clear: (payload) => handlers['notify-clear']({}, payload),
    restore: () => Object.defineProperty(process, 'platform', original),
  };
}

const payload = (sessionId, extra = {}) => ({
  title: `T ${sessionId}`, body: 'b', sessionId, project: 'alpha', projectKey: '/p/alpha', ...extra,
});

test('win32: id and group are set, a second event for the session closes and replaces the first', () => {
  const t = load('win32');
  try {
    t.notify(payload('s1'));
    t.notify(payload('s1'));
    assert.equal(t.made.length, 2);
    assert.equal(t.made[0].options.id, 'sess:s1');
    assert.equal(t.made[0].options.groupTitle, 'alpha');
    assert.match(t.made[0].options.groupId, /^proj:[0-9a-f]{12}$/);
    assert.equal(t.made[0].options.groupId, t.made[1].options.groupId);
    assert.equal(t.made[0].closed, 1, 'the old entry is closed');
    assert.equal(t.mod._liveEntries.get('sess:s1'), t.made[1]);
    // The replaced entry reports its close late; it must not drop the new one.
    t.made[0].handlers.close();
    assert.equal(t.mod._liveEntries.get('sess:s1'), t.made[1]);
  } finally { t.restore(); }
});

test('win32: clear closes the kept object and empties the map', () => {
  const t = load('win32');
  try {
    t.notify(payload('s1'));
    t.notify(payload('s2'));
    t.notify({ title: 'x', body: 'y', summary: true });
    t.clear({ sessionIds: ['s1'], summary: true });
    assert.equal(t.made[0].closed, 1);
    assert.equal(t.made[1].closed, 0);
    assert.equal(t.made[2].closed, 1);
    assert.deepEqual([...t.mod._liveEntries.keys()], ['sess:s2']);
    assert.deepEqual(t.removed, []);
  } finally { t.restore(); }
});

test('darwin: clear uses Notification.remove with the entry id', () => {
  const t = load('darwin');
  try {
    t.notify(payload('s1'));
    t.clear({ sessionIds: ['s1'] });
    assert.deepEqual(t.removed, ['sess:s1']);
    assert.equal(t.made[0].closed, 0);
    assert.equal(t.mod._liveEntries.size, 0);
  } finally { t.restore(); }
});

test('linux: plain toast without id or group, clear does nothing', () => {
  const t = load('linux');
  try {
    t.notify(payload('s1'));
    assert.deepEqual(Object.keys(t.made[0].options).sort(), ['body', 'title']);
    t.clear({ sessionIds: ['s1'], summary: true });
    assert.deepEqual(t.removed, []);
    assert.equal(t.made[0].closed, 0);
    assert.equal(t.mod._liveEntries.size, 0);
  } finally { t.restore(); }
});

test('click and a close the user caused forget the entry; click still focuses the session', () => {
  const t = load('win32');
  try {
    t.notify(payload('s1'));
    t.notify(payload('s2'));
    t.made[0].handlers.click();
    t.made[1].handlers.close({ reason: 'userCanceled' });
    assert.equal(t.mod._liveEntries.size, 0);
    assert.deepEqual(t.sent, [['focus-session', 's1']]);
  } finally { t.restore(); }
});

// Measured on Windows (#847): a toast that times out fires 'close' and moves into the Action Center. Dropping
// it there left the entry behind after the session was read, because nothing was left to call close() on.
test('a timed-out toast is kept, so reading the session still removes it from the Action Center', () => {
  const t = load('win32');
  try {
    t.notify(payload('s1'));
    t.made[0].handlers.close({ reason: 'timedOut' });
    t.made[0].handlers.close({ reason: 'applicationHidden' });
    t.made[0].handlers.close();
    assert.equal(t.mod._liveEntries.size, 1, 'still kept');
    t.clear({ sessionIds: ['s1'] });
    assert.equal(t.made[0].closed, 1, 'the clear closes it');
    assert.equal(t.mod._liveEntries.size, 0);
  } finally { t.restore(); }
});

test('an overlong session id is hashed to stay inside the 64-character tag limit', () => {
  const t = load('win32');
  try {
    t.notify(payload('x'.repeat(100)));
    assert.ok(t.made[0].options.id.length <= 64);
    t.clear({ sessionIds: ['x'.repeat(100)] });
    assert.equal(t.made[0].closed, 1);
  } finally { t.restore(); }
});
