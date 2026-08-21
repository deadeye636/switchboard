// Unit coverage for what session-tabs.js still owns: the tooltips (#334), the project-path
// splitter, the auto-close rules and the rename resolution. All pure, all DOM-free.
//
// buildTabModel and its cases went with #385 — it ordered a strip that no longer exists against a
// stored key that no longer exists, and had no caller left.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveAutoCloseMode,
  resolveAutoCloseDelaySec,
  shouldAutoClose,
  buildTabTooltip,
  buildSessionBarTooltip,
  resolveRenameTarget,
  projectTailOf,
  sessionProjectName,
} = require('../src/renderer/session/session-tabs');

// --- The tab tooltip (#334) --------------------------------------------------

test('the tooltip carries project, backend and state beside the name', () => {
  assert.equal(
    buildTabTooltip({ name: 'Auth refactor', project: 'frontend', backend: 'Claude', state: 'Working' }),
    'Auth refactor\nfrontend · Claude · Working',
  );
});

test('the tooltip leaves out what is not known rather than showing it blank', () => {
  assert.equal(buildTabTooltip({ name: 'Solo' }), 'Solo');
  assert.equal(buildTabTooltip({ name: 'Solo', state: 'Idle' }), 'Solo\nIdle');
  assert.equal(buildTabTooltip({ name: 'Solo', project: 'api', state: '' }), 'Solo\napi');
  // A backend that declares no label costs no separator.
  assert.equal(buildTabTooltip({ name: 'Solo', project: 'api', backend: null, state: 'Idle' }), 'Solo\napi · Idle');
});

test('the tooltip survives an empty call', () => {
  assert.equal(buildTabTooltip(), '');
  assert.equal(buildTabTooltip({}), '');
});

// #460: why the state line can never say working or idle for this session. Its own line, because it is a
// sentence and the line above it is a list of words — and it is the only place the reason is readable at
// the tab, the toast that used to carry it having faded eight seconds after it appeared.
test('the tooltip carries a note about the state on its own line', () => {
  assert.equal(
    buildTabTooltip({
      name: 'Solo', project: 'api', backend: 'Codex', state: 'Running',
      note: 'Codex has not recorded this session in its store.',
    }),
    ['Solo', 'api · Codex · Running', 'Codex has not recorded this session in its store.'].join('\n'),
  );
});

test('no note costs no line', () => {
  assert.equal(buildTabTooltip({ name: 'Solo', state: 'Idle', note: '' }), 'Solo\nIdle');
  assert.equal(buildTabTooltip({ name: 'Solo', state: 'Idle', note: null }), 'Solo\nIdle');
});

test('the session bar tooltip carries the note too', () => {
  // The pane's action row shows the same session; a reason readable at the tab and not at the row under
  // it would be a fact that depends on where you point.
  const text = buildSessionBarTooltip({
    name: 'Solo', project: 'api', backend: 'Codex', state: 'Running',
    note: 'Codex has not recorded this session in its store.',
  });
  assert.equal(text.split('\n').slice(0, 3).join('\n'),
    ['Solo', 'api · Codex · Running', 'Codex has not recorded this session in its store.'].join('\n'));
});

test('projectTailOf reads the last segment of either path flavour', () => {
  assert.equal(projectTailOf('/srv/projects/api-gateway'), 'api-gateway');
  assert.equal(projectTailOf('D:\\work\\frontend'), 'frontend');
  assert.equal(projectTailOf('/srv/projects/api-gateway/'), 'api-gateway');
  assert.equal(projectTailOf(''), '');
  assert.equal(projectTailOf(undefined), '');
});

// #435: the session bar named the FOLDER even where the user had renamed the project — the sidebar
// showed the new name and the header beside it still showed the directory. The two lookups it needs
// belong to the window that owns the project list, so they arrive on `window`; run each case with the
// stub the app would otherwise provide.
function withWindow(stub, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = stub;
  try { return fn(); } finally {
    if (had) globalThis.window = prev; else delete globalThis.window;
  }
}

// What the app really wires: the pure helper decides, the lookup only supplies the custom name.
const appWindow = (customName) => ({
  projectDisplayNameForSession: () => customName,
  projectDisplayLabel: require('../src/renderer/lib/project-name').projectDisplayLabel,
});

test('a renamed project is named by the user, not by its folder', () => {
  const session = { sessionId: 's1', projectPath: 'D:\\work\\switchboard' };
  assert.equal(withWindow(appWindow('Alpha Service'), () => sessionProjectName(session)), 'Alpha Service');
});

test('without a display name it stays exactly what it showed before', () => {
  const session = { sessionId: 's1', projectPath: 'D:\\work\\switchboard' };
  assert.equal(withWindow(appWindow(''), () => sessionProjectName(session)), 'switchboard');
  // Whitespace is not a name — projectDisplayLabel trims, and the folder wins.
  assert.equal(withWindow(appWindow('   '), () => sessionProjectName(session)), 'switchboard');
});

test('a window without the project list falls back rather than throwing', () => {
  const session = { sessionId: 's1', projectPath: '/srv/projects/api-gateway' };
  assert.equal(withWindow({}, () => sessionProjectName(session)), 'api-gateway');
  assert.equal(withWindow(appWindow('Alpha'), () => sessionProjectName(null)), 'Alpha');
  assert.equal(withWindow({}, () => sessionProjectName(null)), '');
});

// --- Auto-close on exit ---

test('resolveAutoCloseMode defaults to always and validates the value', () => {
  assert.equal(resolveAutoCloseMode(undefined), 'always');
  assert.equal(resolveAutoCloseMode({}), 'always');
  assert.equal(resolveAutoCloseMode({ tabAutoCloseMode: 'bogus' }), 'always');
  assert.equal(resolveAutoCloseMode({ tabAutoCloseMode: 'never' }), 'never');
  assert.equal(resolveAutoCloseMode({ tabAutoCloseMode: 'onSuccess' }), 'onSuccess');
  assert.equal(resolveAutoCloseMode({ tabAutoCloseMode: 'always' }), 'always');
});

test('resolveAutoCloseDelaySec defaults to 5, honours 0, floors, rejects junk', () => {
  assert.equal(resolveAutoCloseDelaySec(undefined), 5);
  assert.equal(resolveAutoCloseDelaySec({}), 5);
  assert.equal(resolveAutoCloseDelaySec({ tabAutoCloseDelaySec: 0 }), 0);
  assert.equal(resolveAutoCloseDelaySec({ tabAutoCloseDelaySec: 12 }), 12);
  assert.equal(resolveAutoCloseDelaySec({ tabAutoCloseDelaySec: 3.9 }), 3);
  assert.equal(resolveAutoCloseDelaySec({ tabAutoCloseDelaySec: -4 }), 5);
  assert.equal(resolveAutoCloseDelaySec({ tabAutoCloseDelaySec: 'x' }), 5);
});

test('shouldAutoClose applies the mode against the exit code', () => {
  assert.equal(shouldAutoClose('never', 0), false);
  assert.equal(shouldAutoClose('never', 1), false);
  assert.equal(shouldAutoClose('onSuccess', 0), true);
  assert.equal(shouldAutoClose('onSuccess', 1), false);
  assert.equal(shouldAutoClose('always', 0), true);
  assert.equal(shouldAutoClose('always', 1), true);
  assert.equal(shouldAutoClose('bogus', 0), false);
});

// --- The session bar's tooltip (#358) ----------------------------------------
//
// The row shows the name and the project. Everything it used to spell out beside them is in here, and
// the point of the builder is that it never says the same thing twice — that repetition on the row is
// what the issue was about.

test('the bar tooltip carries the AI title, the pty title and the id under the tab tooltip', () => {
  assert.equal(
    buildSessionBarTooltip({
      name: 'Auth refactor',
      aiTitle: 'Refactor the auth middleware',
      ptyTitle: 'claude — running tests',
      sessionId: 'abc-123',
      project: 'frontend',
      backend: 'Claude',
      state: 'Working',
    }),
    'Auth refactor\nfrontend · Claude · Working\nRefactor the auth middleware\nclaude — running tests\nabc-123');
});

test('the bar tooltip drops a line that repeats the name it is attached to', () => {
  // The everyday case: no manual rename, so the displayed name IS the AI title, and the CLI's own title
  // tracks it. Repeating it twice under itself is exactly the noise this replaced.
  assert.equal(
    buildSessionBarTooltip({
      name: 'Review the handoff',
      aiTitle: 'Review the handoff',
      ptyTitle: 'Review the handoff',
      sessionId: 'abc-123',
      project: 'switchboard',
    }),
    'Review the handoff\nswitchboard\nabc-123');
});

test('the bar tooltip keeps the pty title when it differs from the AI title', () => {
  assert.equal(
    buildSessionBarTooltip({ name: 'Renamed', aiTitle: 'Renamed', ptyTitle: 'npm test', sessionId: 'x' }),
    'Renamed\nnpm test\nx');
});

test('the bar tooltip is the id alone when there is nothing else to say', () => {
  assert.equal(buildSessionBarTooltip({ name: 'x', sessionId: 'x' }), 'x',
    'a session whose name IS its id says it once');
  assert.equal(buildSessionBarTooltip({ sessionId: 'only-id' }), 'only-id');
  assert.equal(buildSessionBarTooltip(), '');
});

test('the bar tooltip treats a CLI title with an activity glyph as the same sentence', () => {
  // What Claude actually writes: the AI title with a spinner in front. Two different strings, one
  // sentence — and the everyday case for a renamed session, so it would be noise on every tooltip.
  assert.equal(
    buildSessionBarTooltip({
      name: 'Renamed by hand',
      aiTitle: 'Review the handoff',
      ptyTitle: '✳ Review the handoff',
      sessionId: 'abc-123',
      project: 'switchboard',
    }),
    'Renamed by hand\nswitchboard\nReview the handoff\nabc-123');
  // …and a leading marker does not make it match the NAME either.
  assert.equal(
    buildSessionBarTooltip({ name: 'Review the handoff', ptyTitle: '✳ Review the handoff', sessionId: 'x' }),
    'Review the handoff\nx');
  // A title that is only a marker carries nothing to show.
  assert.equal(buildSessionBarTooltip({ name: 'A', ptyTitle: '✳ ', sessionId: 'x' }), 'A\nx');
});

// --- What a typed name means (#95, #358) -------------------------------------
//
// One rule, three surfaces. It used to be written out three times and the sidebar's copy compared
// against the RAW automatic title while the field showed the cleaned one — so confirming a rename
// without editing anything stored the cleaned string as a manual name and switched the automatic
// title off for good.

test('an empty name drops the override so the automatic title applies again', () => {
  assert.equal(resolveRenameTarget('', 'Review the handoff'), null);
  assert.equal(resolveRenameTarget('   ', 'Review the handoff'), null);
  assert.equal(resolveRenameTarget(null, 'Review the handoff'), null);
});

test('a name equal to the automatic title is not stored as a manual one', () => {
  // Otherwise a click that changed nothing freezes today's AI title, and a better one later never lands.
  assert.equal(resolveRenameTarget('Review the handoff', 'Review the handoff'), null);
  assert.equal(resolveRenameTarget('  Review the handoff  ', 'Review the handoff'), null);
});

test('anything else is the session\'s name from then on', () => {
  assert.equal(resolveRenameTarget('Auth refactor', 'Review the handoff'), 'Auth refactor');
  assert.equal(resolveRenameTarget('  Auth refactor  ', 'Review the handoff'), 'Auth refactor');
  // No automatic title to compare against — the typed name simply wins.
  assert.equal(resolveRenameTarget('Auth refactor', ''), 'Auth refactor');
  assert.equal(resolveRenameTarget('Auth refactor', null), 'Auth refactor');
});
