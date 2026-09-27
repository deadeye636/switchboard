'use strict';
// src/app/storage-flush.js (#669): after a re-key, Chromium is asked once, a moment later, to commit the
// renderer's localStorage, so the renamed restore state survives a kill. A window that went away meanwhile is
// left alone, and a missing API or a throw breaks nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { flushStorageSoon, FLUSH_DELAY_MS } = require('../src/app/storage-flush');

function fakeContents({ destroyed = false, throws = false } = {}) {
  const wc = { flushed: 0, destroyed, isDestroyed: () => wc.destroyed,
    session: { flushStorageData: () => { if (throws) throw new Error('boom'); wc.flushed++; } } };
  return wc;
}

test('flushes once, after the delay, not at once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wc = fakeContents();
  flushStorageSoon(wc);
  assert.equal(wc.flushed, 0, 'the renderer has not written yet');
  t.mock.timers.tick(FLUSH_DELAY_MS);
  assert.equal(wc.flushed, 1);
});

test('a window gone meanwhile, a throw, or nothing to flush breaks nothing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gone = fakeContents();
  flushStorageSoon(gone);
  gone.destroyed = true;
  const throwing = fakeContents({ throws: true });
  flushStorageSoon(throwing);
  flushStorageSoon(null);
  flushStorageSoon({ isDestroyed: () => false });
  assert.doesNotThrow(() => t.mock.timers.tick(FLUSH_DELAY_MS));
  assert.equal(gone.flushed, 0);
});

// Wiring: both places that tell the renderer about a re-key ask for the flush right after.
test('both re-key broadcasts ask for the flush', () => {
  for (const rel of ['src/session/session-transitions.js', 'src/watch/adopt.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const send = src.indexOf("send('session-forked'");
    assert.ok(send >= 0, `${rel} sends session-forked`);
    const flush = src.indexOf('flushStorageSoon(', send);
    assert.ok(flush > send && flush - send < 400, `${rel} flushes right after it sends session-forked`);
  }
});
