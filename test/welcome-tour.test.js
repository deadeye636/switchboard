'use strict';
// The welcome tour's wiring guards (#146).
//
// The tour writes settings from a second surface, and the one thing that must stay true is that it is a
// second surface and not a second HOME: every key it writes is also written by the settings screen, which
// stays the complete list. A key that exists only in the tour is a setting nobody can find again.
//
// This checks KEYS, not labels. Requiring the tour to use the settings screen's wording was the first
// plan and it does not survive contact: the screen says `IDE emulation (MCP bridge)`, which is jargon in
// an introduction. So the tour writes its own words and the where-line on each pane names the screen and
// section the setting lives in; what a test can hold is that the key is not a stranger.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stripComments } = require('./helpers/strip-comments');

const ROOT = path.join(__dirname, '..');
const read = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const TOUR = 'src/renderer/dialogs/welcome-tour.js';
const PANEL = 'src/renderer/panels/settings-panel.js';

// The settings screen's SAVE PATH, not the whole file: a key named in a comment or read for display
// somewhere in settings-panel.js would satisfy a whole-file match while nothing there writes it.
function settingsSaveSource() {
  const panel = read(PANEL);
  const start = panel.indexOf('function persistSettings');
  assert.ok(start > 0, 'settings-panel.js no longer has persistSettings — find the save path again');
  const end = panel.indexOf('window.api.setSetting(settingsKey', start);
  assert.ok(end > start, 'the save path no longer ends in setSetting(settingsKey)');
  return panel.slice(start, end);
}

test('every flat setting the tour writes is also written by the settings screen', () => {
  const tour = read(TOUR);
  const panel = settingsSaveSource();

  // `{ type: 'flat', key: 'sessionMaxAgeDays', … }` — the only shape the tour uses for a plain global.
  const keys = [...tour.matchAll(/type:\s*'flat',\s*key:\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 8, `expected the tour to write several flat settings, found ${keys.length}`);

  const missing = keys.filter((key) => !new RegExp(`\\b${key}\\b`).test(panel));
  assert.deepStrictEqual(missing, [], `written by the tour, not by the settings screen: ${missing.join(', ')}`);
});

test('the two capability ids the tour names are DECLARED by a backend', () => {
  // Not `flat` keys, so the check above cannot see them. They also do not appear in settings-panel.js by
  // name — that screen renders whatever a descriptor declares and names no id either — so the home to
  // check is the descriptor. An id nothing declares is a pane that can never render.
  const tour = read(TOUR);
  const backendsDir = path.join(ROOT, 'src', 'backends');
  const declared = fs.readdirSync(backendsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(backendsDir, e.name, 'index.js'))
    .filter((f) => fs.existsSync(f))
    .map((f) => stripComments(fs.readFileSync(f, 'utf8')))
    .join('\n');

  for (const id of ['attentionHooks', 'mcpEmulation']) {
    assert.match(tour, new RegExp(`'${id}'`), `the tour should still name the ${id} capability`);
    assert.match(declared, new RegExp(`id:\\s*'${id}'`), `${id} is named by the tour and declared by no backend`);
  }
  // And the hook needs its second call: the flag alone stores an intent nothing acts on.
  assert.match(tour, /configureAttentionHook/);
});

test('a cleared number field means the default, never 0', () => {
  // 0 means "no limit" for these keys, so a blank field committing 0 would make the sidebar unlimited on
  // the way past. The settings screen answers the same input with the default (`parseLimit`).
  const tour = read(TOUR);
  assert.match(tour, /el\.value\.trim\(\) === ''[\s\S]{0,140}fallback/);
  assert.match(tour, /control\.max \? Math\.min/, 'and the screen caps these fields, so the tour does too');
});

test('the other windows are told about a write', () => {
  // A detached window loads the same shell (#390) and DOES listen for settings-changed; the broadcast
  // skips only the sender, and the sender is us.
  assert.match(read(TOUR), /notifySettingsChanged/);
});

test('the tour writes the nested settings through set-setting, never through a shallow merge', () => {
  const tour = read(TOUR);

  // `merge-setting` is a shallow spread (src/app/settings.js). Merging `backendEnabled` would replace the
  // whole map and drop every other backend's state; merging `backendDefaults` would drop every other
  // backend's options. Both have to be a read-modify-write on the whole blob.
  for (const key of ['backendEnabled', 'backendDefaults']) {
    assert.ok(
      !new RegExp(`mergeSetting\\([^)]*${key}`).test(tour),
      `${key} must not go through mergeSetting — a shallow merge drops the rest of the map`,
    );
  }
  assert.ok(/setSetting\('global'/.test(tour), 'the nested writes need set-setting');
  assert.ok(/getSetting\('global'\)/.test(tour), 'a set-setting write must re-read the blob first');
});

test('a control write re-applies the settings in this window', () => {
  // `broadcastSettingsChanged` skips the sender (src/app/windows.js), and the tour runs in the window
  // that writes — so without this call the display mode, the sidebar numbers, the close behaviours and
  // the shortcuts would all appear to do nothing until the next launch.
  assert.match(read(TOUR), /reapplyGlobalSettings\s*\(\s*\)/);
});

test('the tour names no backend: it asks the registry which one declares a capability', () => {
  const tour = read(TOUR);
  // The capability ids it may name…
  assert.match(tour, /'attentionHooks'/);
  assert.match(tour, /'mcpEmulation'/);
  // …and the resolution that keeps a backend id out of this file. `test/backend-integrations.test.js`
  // holds the general form of this; this asserts the mechanism exists rather than that no id appears.
  assert.match(tour, /backendDeclaringIntegration/);
  assert.match(tour, /backendDeclaringOption/);
});

test('welcomeDismissed rides export/import and is not stripped', () => {
  const transfer = read('src/app/settings-transfer.js');
  const match = transfer.match(/NON_PORTABLE_KEYS\s*=\s*\[([^\]]*)\]/);
  assert.ok(match, 'NON_PORTABLE_KEYS not found');
  assert.ok(
    !/welcomeDismissed/.test(match[1]),
    'welcomeDismissed is a portable key on purpose — a machine set up from another one is not a first launch',
  );
});

test('the first-launch trigger is gated on the main window and runs after the restore', () => {
  const tour = read(TOUR);
  assert.match(tour, /isDetachedWindow/, 'detached windows load the same shell (#390) and must not each open a copy');

  const app = read('src/renderer/app.js');
  // The call is chained onto the boot promise rather than placed inside it: the restore ends in
  // showSession → terminal.focus(), and the boot callback returns early on three paths.
  assert.match(app, /welcomeTour\?\.maybeShowOnLaunch/);
});

test('the reopen relay lives in src/app/, not in main.js', () => {
  assert.match(read('src/app/windows.js'), /ipc\.on\('show-welcome-tour'/);
  assert.ok(
    !/show-welcome-tour/.test(read('src/main.js')),
    'a new IPC handler belongs in an src/app/ module (test/main-no-new-ipc.test.js says so too)',
  );
});

test('the reopen relay raises the main window and addresses it alone', () => {
  const windows = read('src/app/windows.js');
  const handler = windows.slice(windows.indexOf("ipc.on('show-welcome-tour'"));
  const body = handler.slice(0, handler.indexOf('\n  });'));
  assert.match(body, /isMinimized\(\)/, 'the settings window is a child — hiding it does not un-minimise the parent');
  assert.match(body, /getMainWindow\(\)/);
  assert.ok(
    !/broadcast/i.test(body),
    'every window loads the same shell (#390): a broadcast would open the tour in detached windows too',
  );
});

test('there are four ways out of the tour', () => {
  // It opens by itself on the first launch after an update, in front of somebody who did not ask for it.
  // Nothing in it holds work a stray click could lose — every control writes as it is changed — and the
  // way back is one button in Settings → About, so leaving must be the easy part.
  const tour = read(TOUR);
  assert.match(tour, /wt-close/, 'a × in the corner');
  assert.match(tour, /wt-skip/, 'a labelled button in the actions row');
  assert.match(tour, /'Escape'/, 'Escape');
  // Bound to the DOCUMENT in the capture phase, not to the overlay: a click on the dialog's padding or on
  // a figure moves activeElement off the overlay, and the key would then reach the app's own handlers.
  assert.match(tour, /document\.addEventListener\('keydown'[\s\S]{0,40}true\)/);
  assert.match(tour, /e\.target === overlay/, 'a click on the backdrop');
  // And the label says what it does. "Skip" reads as "skip this pane" from pane 2 onwards.
  assert.match(tour, /Close the tour/);
});

test('both surfaces say when the attention hook was not installed', () => {
  // Main returns `{ devBlocked }` / `{ ok: false, error }` "so the renderer can note why the toggle
  // didn't take effect" (src/app/hooks.js) — and until #146/O19 nobody noted it in either place, so the
  // toggle read as on with no hook behind it. The tour was the first; the settings screen followed.
  assert.match(read(TOUR), /devBlocked/, 'the tour must say it');
  assert.match(read(PANEL), /devBlocked/, 'and so must the settings screen');
  assert.match(read(PANEL), /noteHookOutcome/);
  // A dialog rather than an inline note, and that is forced: Save closes the panel and Apply rebuilds it,
  // so anything written into the DOM there is gone before it can be read.
  assert.match(read(PANEL), /noteHookOutcome[\s\S]{0,900}showControlMessage/);
});

test('the demo seed marks the tour as seen, but only when nobody has answered', () => {
  // Otherwise every `npm run demo:start` and every drive-app.js run boots behind a modal. And it stamps
  // only an ABSENT key: this script runs on every demo:start, so an unconditional write would make the
  // tour unreachable in the demo — an explicit `welcomeDismissed: false` has to survive it.
  const seed = read('scripts/demo-settings.js');
  assert.match(seed, /welcomeDismissed = true/);
  assert.match(seed, /welcomeDismissed === undefined/);
});
