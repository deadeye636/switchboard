'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  EXPORT_VERSION,
  buildExportPayload,
  validateImportPayload,
  mergeImport,
  importProjects,
} = require('../src/app/settings-transfer');

// --- export ---

test('export wraps the blob in a versioned envelope', () => {
  const payload = buildExportPayload({ sidebarWidth: 400 }, '2026-07-12T10:00:00.000Z');
  assert.strictEqual(payload.app, 'switchboard');
  assert.strictEqual(payload.version, EXPORT_VERSION);
  assert.strictEqual(payload.exportedAt, '2026-07-12T10:00:00.000Z');
  assert.deepStrictEqual(payload.global, { sidebarWidth: 400 });
});

test('export drops the keys that cannot mean anything elsewhere', () => {
  const payload = buildExportPayload({
    windowBounds: { x: 0, y: 0, width: 1400, height: 900 },
    db_version: 42,
    sidebarWidth: 400,
  }, '2026-07-12T10:00:00.000Z');
  assert.deepStrictEqual(payload.global, { sidebarWidth: 400 });
});

// The blob's local paths are the POINT of the export — a restore that dropped them would
// arrive with launchers that point nowhere. Only NON_PORTABLE_KEYS are stripped.
test('export keeps the paths the user configured', () => {
  const blob = {
    addedProjects: ['/home/u/work/api'],
    hiddenProjects: ['/home/u/scratch'],
    externalEditorCommand: '/usr/bin/code',
    backendDefaults: { claude: { preLaunchCmd: 'nvm use 20', addDirs: '/home/u/shared' } },
    customLaunchers: [{ id: 'a', name: 'dev', command: 'npm run dev', cwd: '/home/u/work/api' }],
  };
  const payload = buildExportPayload(blob, 'now');
  assert.deepStrictEqual(payload.global, blob);
});

// --- the project list (#167) ---
//
// It used to live in the blob (`hiddenProjects`/`addedProjects`) and rode along for free. It is a TABLE
// now, so it has to be carried on purpose — or an export silently drops the whole list, and a restore
// arrives with every hidden project visible again and, in manual mode, with no projects at all.

test('the project list is exported alongside the blob', () => {
  const states = new Map([
    ['D:\\a', { projectPath: 'D:\\a', registered: 1, hidden: 0 }],
    ['D:\\b', { projectPath: 'D:\\b', registered: 1, hidden: 1 }],
    ['D:\\gone', { projectPath: 'D:\\gone', registered: 0, removedAt: '2026-07-01T00:00:00.000Z' }],
  ]);
  const payload = buildExportPayload({}, 'now', states);

  assert.deepStrictEqual(payload.projects, [
    { projectPath: 'D:\\a', registered: 1, hidden: 0 },
    { projectPath: 'D:\\b', registered: 1, hidden: 1 },
  ], 'what is on the list, and whether it is hidden — a REMOVED project is not on it');
});

test('a tombstone does not travel: it is about the transcripts on THIS disk', () => {
  const states = new Map([['D:\\gone', { projectPath: 'D:\\gone', registered: 0, removedAt: 'now' }]]);
  const payload = buildExportPayload({}, 'now', states);
  assert.deepStrictEqual(payload.projects, [],
    'carrying it over would suppress a project on a machine whose sessions were never removed');
});

test('an import reads the list — and a legacy file\'s allowlist counts as one', () => {
  assert.deepStrictEqual(
    importProjects({ projects: [{ projectPath: 'D:\\a', hidden: 1 }, { projectPath: 'D:\\b' }] }),
    [{ projectPath: 'D:\\a', registered: 1, hidden: 1 }, { projectPath: 'D:\\b', registered: 1, hidden: 0 }]
  );

  // A file written before the register existed. Its list is in the blob, where the list used to live.
  assert.deepStrictEqual(
    importProjects({ global: { addedProjects: ['D:\\a', 'D:\\b'], hiddenProjects: ['D:\\b'] } }),
    [{ projectPath: 'D:\\a', registered: 1, hidden: 0 }, { projectPath: 'D:\\b', registered: 1, hidden: 1 }]
  );
});

test('importing a file with no list at all changes nothing', () => {
  // An older export, or a machine that never had a project. Importing "nothing" must not mean "wipe it".
  assert.deepStrictEqual(importProjects({ global: { sidebarWidth: 400 } }), []);
  assert.deepStrictEqual(importProjects({}), []);
});

test('export of a missing blob is an empty one, not a crash', () => {
  assert.deepStrictEqual(buildExportPayload(null, 'now').global, {});
  assert.deepStrictEqual(buildExportPayload(null, 'now').projects, []);
  assert.deepStrictEqual(buildExportPayload(undefined, 'now').global, {});
});

// --- import validation ---

test('a valid payload passes and yields its global blob', () => {
  const res = validateImportPayload({
    app: 'switchboard', version: 1, exportedAt: 'now', global: { sidebarWidth: 400 },
  });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.global, { sidebarWidth: 400 });
});

test('a foreign JSON is refused — settings are not merged from any file that happens to parse', () => {
  for (const bad of [null, 42, 'nope', [], { global: { a: 1 } }, { app: 'other', version: 1, global: {} }]) {
    const res = validateImportPayload(bad);
    assert.strictEqual(res.ok, false, `should refuse ${JSON.stringify(bad)}`);
    assert.ok(res.error);
  }
});

test('a payload without a usable version is refused', () => {
  for (const version of [undefined, 0, -1, 'one', 1.5]) {
    assert.strictEqual(validateImportPayload({ app: 'switchboard', version, global: {} }).ok, false);
  }
});

// A newer format may have MOVED a key. Merging it blind could corrupt settings in a way no
// per-key check would catch, so refuse rather than guess.
test('a payload from a newer Switchboard is refused, not guessed at', () => {
  const res = validateImportPayload({ app: 'switchboard', version: EXPORT_VERSION + 1, global: { x: 1 } });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /newer version/i);
});

test('a payload with no global object is refused', () => {
  for (const global of [undefined, null, [], 'x']) {
    assert.strictEqual(validateImportPayload({ app: 'switchboard', version: 1, global }).ok, false);
  }
});

test('import strips the non-portable keys a hand-edited file may carry', () => {
  const res = validateImportPayload({
    app: 'switchboard', version: 1,
    global: { db_version: 99, windowBounds: { x: 1 }, sidebarWidth: 400 },
  });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.global, { sidebarWidth: 400 });
});

// --- merge ---

test('merge lets the file win per key and keeps what it does not mention', () => {
  const merged = mergeImport(
    { sidebarWidth: 300, terminalTheme: 'switchboard', logLevel: 'info' },
    { sidebarWidth: 400, terminalFontSize: 14 },
  );
  assert.deepStrictEqual(merged, {
    sidebarWidth: 400,          // file wins
    terminalTheme: 'switchboard', // untouched by the file → kept
    logLevel: 'info',             // untouched by the file → kept
    terminalFontSize: 14,         // new from the file
  });
});

// A file written by a NEWER minor build may carry a setting this build has no name for.
// Dropping it would silently destroy the user's configuration on a round-trip.
test('merge preserves keys this build does not know', () => {
  const merged = mergeImport({ sidebarWidth: 300 }, { someFutureSetting: { deep: true } });
  assert.deepStrictEqual(merged.someFutureSetting, { deep: true });
});

test('merge never lets the file reinstate a non-portable key', () => {
  const merged = mergeImport(
    { windowBounds: { x: 10, y: 10, width: 800, height: 600 } },
    { windowBounds: { x: 9999, y: 9999, width: 100, height: 100 }, sidebarWidth: 400 },
  );
  assert.deepStrictEqual(merged.windowBounds, { x: 10, y: 10, width: 800, height: 600 });
  assert.strictEqual(merged.sidebarWidth, 400);
});

test('merge onto a missing blob is the file itself', () => {
  assert.deepStrictEqual(mergeImport(null, { sidebarWidth: 400 }), { sidebarWidth: 400 });
  assert.deepStrictEqual(mergeImport(undefined, { sidebarWidth: 400 }), { sidebarWidth: 400 });
});

// The export must survive its own import — the round trip is the whole feature.
test('export → import round-trips a real-shaped blob', () => {
  const blob = {
    sidebarWidth: 400,
    backendEnabled: { claude: true, codex: true },
    backendDefaults: { claude: { permissionMode: 'plan' } },
    customLaunchers: [{ id: 'a', name: 'dev', command: 'npm run dev', env: { TOKEN: '$MY_TOKEN' } }],
    windowBounds: { x: 1, y: 2, width: 3, height: 4 },
  };
  const file = JSON.parse(JSON.stringify(buildExportPayload(blob, 'now')));
  const check = validateImportPayload(file);
  assert.strictEqual(check.ok, true);
  const merged = mergeImport({}, check.global);

  const expected = { ...blob };
  delete expected.windowBounds;
  assert.deepStrictEqual(merged, expected);
  // A $VAR reference is a reference, not a secret — it must survive the trip intact.
  assert.strictEqual(merged.customLaunchers[0].env.TOKEN, '$MY_TOKEN');
});
