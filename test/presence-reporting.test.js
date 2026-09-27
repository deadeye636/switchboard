// #426, #673 — the renderer half of presence: does ordinary use still report a sign of life, in EVERY window?
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
const { pageScripts, rendererPages } = require('./helpers/page-scripts');

// It moved out of `away-overview-view.js` at #673, so the pages that never load that file report too.
const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const SRC = path.join(RENDERER, 'shell', 'presence-report.js');

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
    },
    writable: true,
    configurable: true,
  });
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), dom.getInternalVMContext(),
    { filename: 'presence-report.js' });
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

test('#673: a focus does not use up the throttle — the first keystroke after it reports at once', () => {
  // A focus may carry no input (an unlock, a focus the app caused), and main discards such a report
  // against the OS idle time. The keystroke that follows is the real return and must not wait 15 s.
  const { window, reports } = loadInDom();
  window.dispatchEvent(new window.Event('focus'));
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }));
  assert.equal(reports.length, 2);
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'b' }));
  assert.equal(reports.length, 2, 'the keystroke started the throttle as usual');
});

test('#426: a main process without the channel does not take the renderer down', () => {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', {
    url: 'http://localhost/', runScripts: 'outside-only',
  });
  Object.defineProperty(dom.window, 'api', { value: {}, writable: true, configurable: true });
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), dom.getInternalVMContext(),
    { filename: 'presence-report.js' });
  assert.doesNotThrow(() => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'a' })));
});

test('#673: every page loads the reporter — review in the settings, changes or diff window is presence', () => {
  // The recap fired for time spent reviewing in a window of the app's own, because those pages never
  // loaded the file the listeners lived in. The pages are read from the directory, so a page added later
  // that omits the tag fails here by name.
  const pages = rendererPages();
  assert.ok(pages.length >= 4, `expected the renderer's pages, found: ${pages.join(', ')}`);
  for (const page of pages) {
    assert.ok(pageScripts(page).includes('shell/presence-report.js'),
      `${page} must load shell/presence-report.js`);
  }
});

test('#673: the reporter is the only one — the recap view no longer registers a second copy', () => {
  // Two copies would mean two throttles, so a keystroke in the main window would send two reports.
  const view = fs.readFileSync(path.join(RENDERER, 'shell', 'away-overview-view.js'), 'utf8');
  const { stripComments } = require('./helpers/strip-comments');
  assert.doesNotMatch(stripComments(view), /reportPresenceActivity/);
});
