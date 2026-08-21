'use strict';
// "This backend has no record of the session", held as a state (#460).
//
// #151 established the fact and the sentence; what it got wrong was the shelf life. The sentence went
// out as a toast that faded after eight seconds, while the condition it explains lasts as long as the
// session — look away and all that is left is a tab that never says working or idle. So the fact is
// published as a list instead: every window gets it, a window that opens or reloads can ask for it, and
// it disappears the moment it stops being true.
//
// Free of Electron: the module takes its windows through ctx, the way live-owners.js does.

const test = require('node:test');
const assert = require('node:assert/strict');

const notice = require('../src/app/store-record-notice');

function fakeWindow(sent, { destroyed = false } = {}) {
  return {
    isDestroyed: () => destroyed,
    webContents: { send: (channel, payload) => sent.push([channel, payload]) },
  };
}

function setup({ detached = [] } = {}) {
  const sent = [];
  const main = fakeWindow(sent);
  notice.init({
    getMainWindow: () => main,
    getDetachedWindows: () => detached,
  });
  return { sent, main };
}

const lastList = (sent) => sent[sent.length - 1][1];

test('a notice is published to the window and readable afterwards', () => {
  const { sent } = setup();

  notice.notice('s1', 'Codex has not recorded this session.');

  assert.deepEqual(sent, [['store-record-notice', [{ sessionId: 's1', message: 'Codex has not recorded this session.' }]]]);
  assert.deepEqual(notice.current(), [{ sessionId: 's1', message: 'Codex has not recorded this session.' }]);
});

test('the same notice again is not re-sent', () => {
  const { sent } = setup();

  notice.notice('s1', 'same');
  notice.notice('s1', 'same');
  notice.notice('s1', 'same');

  assert.equal(sent.length, 1, 'a repeat of what is already published changes nothing');
});

test('the broadcast is always the WHOLE list, never a delta', () => {
  // A window that missed one message would otherwise keep a marker for a session that paired minutes
  // ago: there is no tick here to correct it, so every message has to be the complete answer.
  const { sent } = setup();

  notice.notice('s1', 'one');
  notice.notice('s2', 'two');

  assert.deepEqual(lastList(sent).map((e) => e.sessionId), ['s1', 's2']);
});

test('clearing takes one out and leaves the rest', () => {
  const { sent } = setup();
  notice.notice('s1', 'one');
  notice.notice('s2', 'two');

  notice.clear('s1');

  assert.deepEqual(lastList(sent), [{ sessionId: 's2', message: 'two' }]);
});

test('clearing something that was never published sends nothing', () => {
  // Both callers clear more ids than they published — the exit handler runs for every session, and a
  // session noticed before adoption is cleared under both of its ids. A broadcast per no-op would
  // repaint every window's sidebar for nothing.
  const { sent } = setup();
  notice.notice('s1', 'one');
  const before = sent.length;

  notice.clear('s2');
  notice.clear('');
  notice.clear(undefined);

  assert.equal(sent.length, before);
});

test('an empty message is not a notice', () => {
  const { sent } = setup();

  notice.notice('s1', '');
  notice.notice('', 'text');

  assert.equal(sent.length, 0);
  assert.deepEqual(notice.current(), []);
});

test('every window hears it, and a destroyed one is skipped rather than thrown at', () => {
  const sent = [];
  const main = fakeWindow(sent);
  const detached = fakeWindow(sent);
  const gone = fakeWindow(sent, { destroyed: true });
  notice.init({ getMainWindow: () => main, getDetachedWindows: () => [detached, gone] });

  notice.notice('s1', 'one');

  // A session drawn in a window of its own must carry the same explanation as the main window's row.
  assert.equal(sent.length, 2, 'main and the detached window, not the destroyed one');
});

test('init clears what a previous run published', () => {
  const first = setup();
  notice.notice('s1', 'one');
  assert.equal(notice.current().length, 1);

  setup();
  assert.deepEqual(notice.current(), [], 'a fresh app does not inherit the last one\'s markers');
  assert.equal(first.sent.length, 1, 'and the old window is not written to again');
});

test('registerIpc answers with the list as it stands', () => {
  const handlers = {};
  setup();
  notice.registerIpc({ handle: (channel, fn) => { handlers[channel] = fn; } });
  notice.notice('s1', 'one');

  // This is what a window asks on open or reload. It reads the published list and never re-decides:
  // deciding costs a walk of the backend's whole store, and a reload must not be able to trigger one.
  assert.deepEqual(handlers['store-record-notice:get'](), [{ sessionId: 's1', message: 'one' }]);
});
