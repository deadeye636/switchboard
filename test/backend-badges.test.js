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

// The same module, but driven through `refreshBackendCaches()` so the RESOLUTION of the default target
// runs — that is what `resolveDefaultTarget` does, and it is internal (only its result reaches `window`).
async function loadRefreshed({ backends = [], defaultLaunchTarget = 'claude' } = {}) {
  const win = {};
  const ctx = vm.createContext({ window: win, console });
  vm.runInContext(SRC, ctx);
  win.api = {
    backends: { list: async () => ({ backends, defaultLaunchTarget }) },
    sessionBackends: { getAll: async () => ({}) },
  };
  await win.refreshBackendCaches();
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

// There used to be a test here: "one enabled backend that is NOT the default: badge it". It built that
// state by hand — `load({ backends: [ready('codex')], defaultLaunchTarget: 'claude' })` — and #225 made
// the state impossible: with exactly one launchable backend, resolveDefaultTarget lands the default ON
// it. The branch it covered was a patch for the stale default, and it went with it.
//
// The test was green for as long as it existed, over a case the app could reach only while the bug was
// there. That is the same thing this file's neighbours criticise: a fake that cannot distinguish tests
// nothing, and one that constructs a forbidden state tests something that will never happen.
test('one launchable backend IS the default, so it cannot be badged for not being it', async () => {
  const win = await loadRefreshed({ backends: [ready('codex')], defaultLaunchTarget: 'claude' });
  assert.equal(win._defaultBackendId, 'codex', 'the stale claude default resolved onto the one thing that runs');
  assert.equal(win.computeShowAllBadges([]), false,
    'a single-backend user sees an unchanged app — whichever backend it is');
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

// --- the default launch target, resolved (#225) --------------------------------------------------
//
// `_defaultBackendId` is what the sidebar measures a row against, what the handoff preselects, what the
// Stats filter leads with, and what a new session launches. It used to be `stored || 'claude'`, so a
// stored value naming a backend the user had since disabled — or the '' the settings page writes when
// nothing is launchable at all (#212) — came back out as Claude. Every one of those surfaces inherited
// it, and each had its own `|| 'claude'` on top, which is how the guess survived being "fixed" in #162.
//
// The invariant this establishes, and that lets those `|| 'claude'`s go: **`_defaultBackendId` is always
// either launchable or empty.** A caller never needs to second-guess it.

test('the default is empty until the registry has answered — not a guess that reads as a fact', () => {
  const win = {};
  vm.runInContext(SRC, vm.createContext({ window: win, console }));
  assert.equal(win._defaultBackendId, '',
    'before refreshBackendCaches() nothing is known, and "" is what that means');
});

test('a stored default that is still launchable is kept', async () => {
  const win = await loadRefreshed({ backends: [ready('claude'), ready('codex')], defaultLaunchTarget: 'codex' });
  assert.equal(win._defaultBackendId, 'codex', 'what the user picked, while they can still run it');
});

test('a stored default the user has since DISABLED resolves to one that can launch', async () => {
  const win = await loadRefreshed({ backends: [off('claude'), ready('codex')], defaultLaunchTarget: 'claude' });
  assert.equal(win._defaultBackendId, 'codex',
    'the stored value is what they picked, not what is possible now — a default that cannot spawn is a refused launch');
});

test('no stored default resolves to the first launchable, in registration order', async () => {
  const win = await loadRefreshed({ backends: [off('claude'), ready('codex'), ready('pi')], defaultLaunchTarget: '' });
  assert.equal(win._defaultBackendId, 'codex', 'first LAUNCHABLE, not first listed');
});

test('nothing launchable at all: the default is empty, never a backend that cannot start', async () => {
  const win = await loadRefreshed({ backends: [off('claude'), off('codex')], defaultLaunchTarget: 'claude' });
  assert.equal(win._defaultBackendId, '',
    'every backend can be disabled (§5.8); naming one anyway is what #225 removed');
  assert.equal(win.firstLaunchableBackendId(), '');
});

test('firstLaunchableBackendId skips what is disabled or not ready', async () => {
  const win = await loadRefreshed({
    backends: [off('claude'), { id: 'agy', status: 'planned', enabled: true }, ready('hermes')],
    defaultLaunchTarget: '',
  });
  assert.equal(win.firstLaunchableBackendId(), 'hermes',
    'disabled is skipped, and so is a "Coming soon" backend that can never launch');
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
