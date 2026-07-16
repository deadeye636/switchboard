'use strict';
// The provider badge on a session row: WHEN is every row badged?
//
// The decision follows the backends you RUN — ready and enabled — not the sessions that happen to be on
// screen. Deriving it from the visible sessions made the badges come and go with the list: someone running
// Claude and Codex saw them vanish the moment the Codex rows were filtered out, scrolled past the fold, or
// simply not started yet — and the remaining Claude rows then looked like the rows of a single-backend app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'backends', 'backend-registry.js'), 'utf8');

// backend-registry.js is a renderer IIFE that hangs everything off `window`. Run it against a stub.
function load({ backends = [], defaultLaunchTarget = 'claude' } = {}) {
  const win = {};
  const ctx = vm.createContext({ window: win, console });
  vm.runInContext(SRC, ctx);
  win._backendsById = {};
  for (const b of backends) win._backendsById[b.id] = b;
  win._defaultBackendId = defaultLaunchTarget;
  return win;
}

const ready = (id) => ({ id, status: 'ready', enabled: true });
const off = (id) => ({ id, status: 'ready', enabled: false });

test('two enabled backends: every row is badged, even before a second one has ever run', () => {
  const win = load({ backends: [ready('claude'), ready('codex')] });
  // Nothing but Claude sessions on screen — the Codex ones are filtered away, or not started yet.
  assert.equal(win.computeShowAllBadges([{ sessionId: 's1', backendId: 'claude' }]), true);
  assert.equal(win.computeShowAllBadges([]), true, 'and with no sessions at all');
});

test('one enabled backend, and it is the default: no badges — the app looks unchanged', () => {
  const win = load({ backends: [ready('claude'), off('codex')] });
  assert.equal(win.computeShowAllBadges([{ sessionId: 's1', backendId: 'claude' }]), false);
});

test('one enabled backend that is NOT the default: badge it — it is not what you would assume', () => {
  const win = load({ backends: [ready('codex')], defaultLaunchTarget: 'claude' });
  assert.equal(win.computeShowAllBadges([]), true);
});

test('a disabled backend does not make the app mixed-mode (its cached sessions survive, §5.8)', () => {
  const win = load({ backends: [ready('claude'), off('codex'), off('pi')] });
  assert.equal(win.computeShowAllBadges([{ sessionId: 's1', backendId: 'codex' }]), false,
    'the old Codex row is still badged individually — it is not the default — but the Claude rows are not');
});

test('before the backend probes answer, the sessions are all there is to go on', () => {
  const win = load({ backends: [] });
  assert.equal(win.computeShowAllBadges([{ sessionId: 'a', backendId: 'claude' }]), false);
  assert.equal(win.computeShowAllBadges([
    { sessionId: 'a', backendId: 'claude' },
    { sessionId: 'b', backendId: 'codex' },
  ]), true);
});

test('sessionBackendId: the row\'s own column first, the launch overlay second, Claude last', () => {
  const win = load({ backends: [ready('claude'), ready('codex')] });
  win._sessionBackendMap = { s2: { backendId: 'pi' } };

  assert.equal(win.sessionBackendId({ sessionId: 's1', backendId: 'codex' }), 'codex',
    'a session that says what it is, is what it says — this is what a just-launched row now carries');
  assert.equal(win.sessionBackendId({ sessionId: 's2' }), 'pi', 'the launch overlay knows the rest');
  assert.equal(win.sessionBackendId({ sessionId: 's3' }), 'claude',
    'no provenance at all: it predates the multi-LLM era, so it is Claude');
});
