'use strict';
// #452 — the watch behind a live document.
//
// What broke before was invisible: a second panel on the same file got `{ ok: true }` and no watch, one
// panel closing killed the other's liveness, and the change only ever reached the main window. None of
// that raises an error — the document simply stops being true. So these tests use real files and real
// windows-shaped stubs, and assert who was told what.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fileWatch = require('../src/app/file-watch');

fileWatch.init({
  resolvePanelFilePath: (p) => path.resolve(p),
  isSensitivePath: (p) => p.includes('secret'),
});

// The watch debounces at 300 ms; a change has to be given longer than that to arrive.
const SETTLE_MS = 700;
const settle = () => new Promise(r => setTimeout(r, SETTLE_MS));

let nextId = 1;
function fakeWindow() {
  const wc = {
    id: nextId++,
    sent: [],
    destroyed: false,
    handlers: {},
    isDestroyed() { return this.destroyed; },
    send(channel, arg) { this.sent.push([channel, arg]); },
    once(evt, fn) { this.handlers[evt] = fn; },
    on(evt, fn) { this.handlers[evt] = fn; },
    die() { this.destroyed = true; if (this.handlers.destroyed) this.handlers.destroyed(); },
  };
  return wc;
}

function tempFile(name, body = 'one\n') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-watch-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

test.afterEach(() => fileWatch.closeAll());

test('two windows watching one file are both told', async () => {
  const file = tempFile('a.md');
  const a = fakeWindow();
  const b = fakeWindow();

  assert.deepEqual(fileWatch.watchFile(a, file), { ok: true });
  assert.deepEqual(fileWatch.watchFile(b, file), { ok: true }, 'the second requester must not get a hollow ok');

  fs.writeFileSync(file, 'two\n');
  await settle();

  assert.deepEqual(a.sent, [['file-changed', file]]);
  assert.deepEqual(b.sent, [['file-changed', file]], 'the second window is not a spectator');
});

test('a subscriber is answered in the words it asked with', async () => {
  const file = tempFile('b.md');
  // The same file under a second spelling: `/./` resolves away, so both name one file while staying two
  // different strings. (A relative path would not do — a temp dir can sit on another drive.)
  const other = path.dirname(file) + path.sep + '.' + path.sep + path.basename(file);
  const a = fakeWindow();
  const b = fakeWindow();

  fileWatch.watchFile(a, file);
  fileWatch.watchFile(b, other);

  fs.writeFileSync(file, 'changed\n');
  await settle();

  // The panel matches the path it passed to watchFile; answering with the resolved one would silently
  // stop matching for every caller that asked with a relative or ~-prefixed path.
  assert.deepEqual(a.sent, [['file-changed', file]]);
  assert.deepEqual(b.sent, [['file-changed', other]]);
});

test('one window unwatching leaves the other watching', async () => {
  const file = tempFile('c.md');
  const a = fakeWindow();
  const b = fakeWindow();
  fileWatch.watchFile(a, file);
  fileWatch.watchFile(b, file);

  fileWatch.unwatchFile(a, file);

  fs.writeFileSync(file, 'changed\n');
  await settle();

  assert.deepEqual(a.sent, [], 'the one that left hears nothing');
  assert.deepEqual(b.sent, [['file-changed', file]], 'the one that stayed keeps its watch');
});

test('the last unwatch closes the watch', () => {
  const file = tempFile('d.md');
  const a = fakeWindow();
  fileWatch.watchFile(a, file);
  assert.equal(fileWatch.watchStats().length, 1);
  fileWatch.unwatchFile(a, file);
  assert.equal(fileWatch.watchStats().length, 0, 'nothing is left holding a filesystem handle');
});

test('a window that dies takes its subscriptions with it', () => {
  const file = tempFile('e.md');
  const a = fakeWindow();
  const b = fakeWindow();
  fileWatch.watchFile(a, file);
  fileWatch.watchFile(b, file);

  a.die();
  assert.equal(fileWatch.watchStats()[0].subscribers, 1, 'the dead window is gone, the live one is not');

  b.die();
  assert.equal(fileWatch.watchStats().length, 0);
});

test('one window with two names for a file keeps its watch until both are released', () => {
  const file = tempFile('f.md');
  const other = path.dirname(file) + path.sep + '.' + path.sep + path.basename(file);
  const a = fakeWindow();
  fileWatch.watchFile(a, file);
  fileWatch.watchFile(a, other);

  fileWatch.unwatchFile(a, file);
  assert.equal(fileWatch.watchStats().length, 1, 'the other panel in the same window is still open');

  fileWatch.unwatchFile(a, other);
  assert.equal(fileWatch.watchStats().length, 0);
});

test('a sensitive path is refused rather than watched', () => {
  const a = fakeWindow();
  const res = fileWatch.watchFile(a, path.join(os.tmpdir(), 'secret', 'x.md'));
  assert.equal(res.ok, false);
  assert.equal(fileWatch.watchStats().length, 0);
});

test('a file replaced by rename is still watched afterwards', async () => {
  const file = tempFile('g.md');
  const a = fakeWindow();
  fileWatch.watchFile(a, file);

  // The shape a writer takes when it writes a temporary file and moves it over the target: the old
  // handler dropped this event, and on Linux the watch then followed the orphaned inode for good.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, 'replaced\n');
  fs.renameSync(tmp, file);
  await settle();

  assert.ok(fileWatch.watchStats().length === 1, 'the entry survives the rename');
  fs.writeFileSync(file, 'again\n');
  await settle();
  assert.ok(a.sent.length >= 1, 'a write after the rename still reaches the window');
});
