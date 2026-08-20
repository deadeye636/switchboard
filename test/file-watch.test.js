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
    // The other half of a WebContents' lifetime, and the half that had no stub until #455: a reload is
    // not a death, and the module has to tell a reload from a hash change and from a subframe.
    navigate({ isInPlace = false, isMainFrame = true } = {}) {
      const fn = this.handlers['did-start-navigation'];
      if (fn) fn({}, 'file:///renderer/index.html', isInPlace, isMainFrame);
    },
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

// --- looking for a file that went away, and knowing when to stop (#455) --------
//
// Re-establishing the watch on the path was right; looking exactly once, 120 ms later, was not. What
// made it hard to see is that the failure had no shape: the entry kept its subscribers and reported
// `watching: false`, which is what a brand-new entry reports too. So these tests assert `state`, and
// they assert it in all three of its values — the middle one is the whole point.

const stateOf = (file) => (fileWatch.watchStats().find(s => s.path === path.resolve(file)) || {}).state;

test('a watched file is reported as watched', () => {
  const file = tempFile('h.md');
  fileWatch.watchFile(fakeWindow(), file);
  assert.equal(stateOf(file), 'watching');
});

test('a file that comes back late is picked up, and the window is told', async () => {
  const file = tempFile('i.md');
  const a = fakeWindow();
  fileWatch.watchFile(a, file);

  // Gone for well past the first look. The old code checked once at 120 ms, found nothing, and was done.
  fs.rmSync(file);
  await new Promise(r => setTimeout(r, 500));
  assert.equal(stateOf(file), 'waiting', 'it has not given up while the window is bounded');

  fs.writeFileSync(file, 'back\n');
  await new Promise(r => setTimeout(r, 2000));

  assert.equal(stateOf(file), 'watching', 'the watch was re-established on the path');
  assert.ok(a.sent.length >= 1, 'and the subscriber was told the file it is showing has moved');

  a.sent.length = 0;
  fs.writeFileSync(file, 'and again\n');
  await settle();
  assert.ok(a.sent.length >= 1, 'the re-established watch is a real one, not a state flag');
});

test('a file that never comes back stops being looked for, and says so', async () => {
  // Thirty seconds is the real window; a test that waits it out is a test nobody runs.
  fileWatch.init({
    resolvePanelFilePath: (p) => path.resolve(p),
    isSensitivePath: (p) => p.includes('secret'),
    rewatchWindowMs: 400,
  });
  try {
    const file = tempFile('j.md');
    const a = fakeWindow();
    fileWatch.watchFile(a, file);

    fs.rmSync(file);
    await new Promise(r => setTimeout(r, 1200));

    assert.equal(stateOf(file), 'gave-up', 'it stopped, and that is a state rather than a silence');
    assert.equal(fileWatch.watchStats()[0].subscribers, 1, 'the panel is still open, so it keeps its place');
  } finally {
    fileWatch.init({
      resolvePanelFilePath: (p) => path.resolve(p),
      isSensitivePath: (p) => p.includes('secret'),
    });
  }
});

test('reopening the document revives an entry that had given up', async () => {
  fileWatch.init({
    resolvePanelFilePath: (p) => path.resolve(p),
    isSensitivePath: (p) => p.includes('secret'),
    rewatchWindowMs: 400,
  });
  try {
    const file = tempFile('k.md');
    const a = fakeWindow();
    fileWatch.watchFile(a, file);
    fs.rmSync(file);
    await new Promise(r => setTimeout(r, 1200));
    assert.equal(stateOf(file), 'gave-up');

    // The user reopens the file. That is the moment to try again — and a second window arriving at a
    // dead entry used to be handed `{ ok: true }` and no watch at all.
    fs.writeFileSync(file, 'a new one\n');
    const b = fakeWindow();
    assert.deepEqual(fileWatch.watchFile(b, file), { ok: true });
    assert.equal(stateOf(file), 'watching');

    fs.writeFileSync(file, 'written\n');
    await settle();
    assert.ok(b.sent.length >= 1, 'the revived watch reaches the window that revived it');
    assert.ok(a.sent.length >= 1, 'and the one that was already there');
  } finally {
    fileWatch.init({
      resolvePanelFilePath: (p) => path.resolve(p),
      isSensitivePath: (p) => p.includes('secret'),
    });
  }
});

test('closing the last panel leaves no retry running', async () => {
  const file = tempFile('l.md');
  const a = fakeWindow();
  fileWatch.watchFile(a, file);
  fs.rmSync(file);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(stateOf(file), 'waiting');

  fileWatch.unwatchFile(a, file);
  assert.equal(fileWatch.watchStats().length, 0);

  // If a timer were still pending it would re-create nothing, but it would keep the process awake and
  // fire against an entry that is gone. Bringing the file back must produce no subscriber and no entry.
  fs.writeFileSync(file, 'back\n');
  await new Promise(r => setTimeout(r, 600));
  assert.equal(fileWatch.watchStats().length, 0, 'nothing was resurrected behind the closed panel');
  assert.deepEqual(a.sent, [], 'and the window that left hears nothing');
});

// --- a window that navigates away is not a window that is still reading --------
//
// The reload half of a WebContents' lifetime had no test at all: the stub never fired
// `did-start-navigation`, so only the `destroyed` path was covered. A reload re-runs `watch-file` from
// scratch, and a panel that was open before it is not open after it.

test('a window that navigates away releases its subscriptions', () => {
  const file = tempFile('m.md');
  const a = fakeWindow();
  const b = fakeWindow();
  fileWatch.watchFile(a, file);
  fileWatch.watchFile(b, file);

  a.navigate();
  assert.equal(fileWatch.watchStats()[0].subscribers, 1, 'the reloading window let go');

  b.navigate();
  assert.equal(fileWatch.watchStats().length, 0);
});

test('an in-page navigation is not a reload and keeps the watch', () => {
  const file = tempFile('n.md');
  const a = fakeWindow();
  fileWatch.watchFile(a, file);

  a.navigate({ isInPlace: true });
  assert.equal(fileWatch.watchStats()[0].subscribers, 1, 'a hash change is not a new document');

  a.navigate({ isMainFrame: false });
  assert.equal(fileWatch.watchStats()[0].subscribers, 1, 'nor is a subframe navigating');
});
