// #426 — the renderer half of presence: does ordinary use still report a sign of life?
//
// `app/presence.js` can only answer "the user was away" if something reports activity, and the listeners
// that did lived in the banner #402 deleted. Nothing took them over, so `lastActivityAt` never left null
// and the whole recap — the inbox entry (#402) and its survival across a reload (#422) — was unreachable
// from real use while both looked correct. Every check had called `reportPresenceActivity` itself.
//
// So this fires REAL events at a real DOM rather than asserting the source mentions a listener: a regex
// guard would have passed against a file that registers the listener and never sends anything.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src', 'renderer', 'shell', 'away-overview-view.js');

/** The file in a jsdom window, with the one thing it touches at parse time stubbed. */
function loadInDom() {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', {
    url: 'http://localhost/', runScripts: 'outside-only',
  });
  const { window } = dom;
  const reports = [];
  Object.defineProperty(window, 'api', {
    value: {
      reportPresenceActivity: () => reports.push(Date.now()),
      onPresenceReturned: () => {},
      getPendingAbsence: async () => null,
      discardAbsence: async () => true,
    },
    writable: true,
    configurable: true,
  });
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), dom.getInternalVMContext(),
    { filename: 'away-overview-view.js' });
  return { window, reports };
}

test('#426: a keystroke is a sign of life', () => {
  const { window, reports } = loadInDom();
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }));
  assert.equal(reports.length, 1, 'without this, no gap is ever an absence and the recap never appears');
});

test('#426: a pointer press and a wheel turn are too', () => {
  for (const type of ['pointerdown', 'wheel']) {
    const { window, reports } = loadInDom();
    window.dispatchEvent(new window.Event(type));
    assert.equal(reports.length, 1, `${type} should report`);
  }
});

test('#426: a mouse MOVE is not — a nudged desk is not the user', () => {
  const { window, reports } = loadInDom();
  window.dispatchEvent(new window.Event('mousemove'));
  assert.deepEqual(reports, [], 'inferring presence from a moved pointer is what this must never do');
});

test('#426: the reporting is throttled, not one message per keystroke', () => {
  const { window, reports } = loadInDom();
  for (let i = 0; i < 25; i++) window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'x' }));
  assert.equal(reports.length, 1, 'typing a sentence must not be twenty-five IPC messages');
});

test('#426: the window coming back reports even inside the throttle window', () => {
  const { window, reports } = loadInDom();
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }));
  window.dispatchEvent(new window.Event('focus'));
  assert.equal(reports.length, 2,
    'coming back IS the moment the answer changes — that report is the one that must not be skipped');
});

test('#426: a main process without the channel does not take the renderer down', () => {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', {
    url: 'http://localhost/', runScripts: 'outside-only',
  });
  Object.defineProperty(dom.window, 'api', { value: {}, writable: true, configurable: true });
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), dom.getInternalVMContext(),
    { filename: 'away-overview-view.js' });
  assert.doesNotThrow(() => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'a' })));
});
