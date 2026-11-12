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
const { pageScripts } = require('./helpers/page-scripts');

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
  const save = panel.slice(start, end);
  // A group of fields written through a reader object (`...idleMaintenanceReaders()`, the idle maintenance
  // fields both windows share) is part of the save path too: its keys are the object's, so the reader's body
  // joins the slice — only for a reader the save path really spreads or iterates.
  const readers = [...save.matchAll(/(?:\.\.\.|Object\.entries\()(\w+)\(\)/g)].map((m) => m[1]);
  const bodies = [...new Set(readers)].map((name) => {
    const at = panel.indexOf(`function ${name}(`);
    assert.ok(at >= 0, `the save path calls ${name}() and settings-panel.js no longer defines it`);
    const stop = panel.indexOf('\n    }\n', at);
    assert.ok(stop > at, `the end of ${name}() was not found — re-anchor this slice or it reads the rest of the file`);
    return panel.slice(at, stop);
  });
  return [save, ...bodies].join('\n');
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
  // way back is one button in Settings → Maintenance, so leaving must be the easy part.
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

test('the reopen button lives in Maintenance, and its markup says so', () => {
  // Not About: About is a plate to read - version, lineage, license, runtime - and this is a thing you
  // DO, next to the other things you do to an installation.
  const html = read('src/renderer/panels/settings-global-html.js');
  // The SECTION, not the nav button of the same name — the nav is rendered first, so a plain indexOf
  // slices an empty range and the test passes for the wrong reason.
  const start = html.indexOf('<section class="settings-cat" data-cat="maintenance"');
  assert.ok(start > 0, 'the Maintenance section is gone');
  const end = html.indexOf('<section class="settings-cat"', start + 1);
  const maintenance = html.slice(start, end > start ? end : undefined);
  assert.match(maintenance, /sv-show-welcome-tour/, 'the button must sit inside the Maintenance section');
});

test('pane 1 draws the badge the settings screen draws beside a toggle', () => {
  // Two surfaces, two spellings, and they were different: the per-backend page header resolves
  // `icon || colour || id` and shows Claude's Anthropic mark, while the ENABLE LIST - the list this pane
  // is - resolves `colour || id` so the column reads as one set of monograms. Taking the wrong one puts a
  // different badge next to the same backend in the two places.
  const tour = read(TOUR);
  const panel = read('src/renderer/panels/backends-panel.js');
  assert.match(tour, /backendBadgeHtml\(b\.colour \|\| b\.id, 20, \{ monogram: b\.monogram \}\)/);
  assert.match(panel, /data-icon="\$\{esc\(b\.colour \|\| b\.id\)\}" data-size="20"/,
    'the enable list changed its badge key - the tour has to follow it');
});

test('the demo seed marks the tour as seen, but only when nobody has answered', () => {
  // Otherwise every `npm run demo:start` and every drive-app.js run boots behind a modal. And it stamps
  // only an ABSENT key: this script runs on every demo:start, so an unconditional write would make the
  // tour unreachable in the demo — an explicit `welcomeDismissed: false` has to survive it.
  const seed = read('scripts/demo-settings.js');
  assert.match(seed, /welcomeDismissed = true/);
  assert.match(seed, /welcomeDismissed === undefined/);
});

test('the documents figure draws what the app will use, and asks the shared rule (#630)', () => {
  // The figure promises "where the next plan and the next handoff will be written, as you type the names",
  // and it drew the typed name. A value every project replaces — `../plans`, `.` — was therefore drawn as
  // a directory of `my-project/`, leaving the tour as the one surface still claiming such a setting
  // applied. It resolves now, and it must resolve through the SHARED rule: this is the fourth surface to
  // answer "where does a project keep its documents", and the previous three each got it wrong by
  // answering it themselves (CLAUDE.md reflex 12, #623, #630).
  const tour = read(TOUR);
  assert.match(tour, /conventionDirNameProblem\(/,
    'the figure has to ask the shared rule rather than decide for itself');
  assert.match(tour, /function effectiveDirName/,
    'and it draws the effective name, not the typed one');

  // The other direction: no hand-rolled version of the rule beside it. These are the shapes a second copy
  // would take, and each is what somebody reaches for when the import looks like overkill for a figure.
  // The `..` ones are not hypothetical — the first version of this figure decided its own wording with a
  // `..` test and therefore called `docs/..` "outside the project" when it is the root.
  // The anchors are load-bearing: a rename makes `indexOf` return -1, `slice(-1, …)` yields one character,
  // and all four shape checks below pass over nothing at all.
  const from = tour.indexOf('const DIR_PROBLEM_WORDS');
  const to = tour.indexOf('function figDirs');
  assert.ok(from >= 0 && to > from, 'the figure was renamed — re-anchor this slice or it checks nothing');
  const figure = tour.slice(from, to + 2000);
  for (const shape of [/startsWith\(\s*['"]\.\.['"]/, /\\\.\\\./, /=== *['"]\.['"]/, /indexOf\(\s*['"]\.\.['"]/]) {
    assert.ok(!shape.test(figure), `the figure re-derives the rule instead of asking it: ${shape}`);
  }

  // And the rule really is shared — loaded by the page, not required, because the renderer has no require.
  assert.ok(pageScripts('index.html').some(s => s.endsWith('shared/convention-dir-name.js')),
    'index.html has to load the shared rule or the tour throws on the first keystroke');
  const app = read('src/app/convention-dirs.js');
  assert.match(app, /unusableConventionDirName/,
    'the main process asks the same module, or the two answers can drift apart again');
  // …and only where it has no project. A lexical veto in front of `isInside` refuses
  // `../<the project's own name>/.plans`, which climbs out and lands back in, so the filesystem has to
  // decide alone whenever there is something to ask it about.
  assert.match(app, /if \(!projectPath\) return unusableConventionDirName/,
    'the shared rule answers the no-project case, not the case the filesystem can answer');
});

// ── The tour, opened in a window (#761 T9, T9b) ──────────────────────────────────────────────────────
//
// The source checks above hold the wiring; these open the tour against an invented registry and read what
// it writes. The ids are invented too: the tour must work for any CLI that declares a twin, and a test that
// named a real backend would only prove it works for that one.

const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const backendModes = require('../src/shared/backend-modes.js');

const REN = path.join(ROOT, 'src', 'renderer');

// The scripts the tour reads at call time, out of index.html, so a tour that stops being able to reach
// one of them fails here rather than in the app.
function tourPageScripts() {
  const wanted = ['shared/backend-modes.js', 'lib/sidebar-groups.js', 'shared/convention-dir-name.js', 'dialogs/welcome-tour.js'];
  const srcs = pageScripts('index.html');
  return wanted.map((w) => {
    const hit = srcs.find((s) => s.endsWith(w));
    assert.ok(hit, `index.html must load ${w}`);
    return hit;
  });
}

// A CLI with a GUI twin, a CLI with none, and a GUI whose answer to the idle-maintenance row is "limited".
function registry({ twinEnabled = false, idleAnswer = 'limited' } = {}) {
  const base = { status: 'ready', available: true, isProfile: false, configFields: [] };
  return {
    'cli-a': { ...base, id: 'cli-a', label: 'CLI A', enabled: true,
      integrations: { fields: [{ id: 'attentionHooks' }] }, capabilities: { idleMaintenance: { state: 'no' } } },
    'cli-a-gui': { ...base, id: 'cli-a-gui', label: 'CLI A (GUI)', transcriptsOf: 'cli-a', modeLabel: 'GUI',
      transport: 'pipe', enabled: twinEnabled, capabilities: { idleMaintenance: { state: idleAnswer } } },
    'cli-b': { ...base, id: 'cli-b', label: 'CLI B', enabled: false, capabilities: { idleMaintenance: { state: 'no' } } },
  };
}

// A rail item is a number span and a label span; the label is the second.
const railText = (el) => el.querySelectorAll('span')[1].textContent.trim();

async function openTour({ store = {}, backends = registry(), defaultBackendId = '' } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  const writes = [];
  const copy = (o) => JSON.parse(JSON.stringify(o));
  window.api = {
    getSetting: async () => copy(store),
    setSetting: async (_scope, blob) => { writes.push({ route: 'set', blob: copy(blob) }); store = copy(blob); return { ok: true }; },
    mergeSetting: async (_scope, patch) => { writes.push({ route: 'merge', patch: copy(patch) }); store = { ...store, ...copy(patch) }; return { ok: true }; },
    configureAttentionHook: async () => ({ ok: true }),
    notifySettingsChanged: () => {},
    onSettingsChanged: () => {},
  };
  window._backendsById = backends;
  // What backend-registry.js resolves from `backends-list`: the launchable default target.
  window._defaultBackendId = defaultBackendId;
  const ctx = dom.getInternalVMContext();
  for (const rel of tourPageScripts()) {
    vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
  }
  await window.welcomeTour.open();
  const doc = window.document;
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
  const rails = () => [...doc.querySelectorAll('.wt-rail-item')].map(railText);
  const go = (rail) => {
    const el = [...doc.querySelectorAll('.wt-rail-item')].find((e) => railText(e) === rail);
    assert.ok(el, `the tour offers the ${rail} pane (rails: ${rails().join(', ')})`);
    el.click();
  };
  const change = async (el, value) => {
    if (typeof value === 'boolean') el.checked = value; else el.value = value;
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settle();
  };
  // A segment of a CLI's mode switch, pressed by value; a button commits on click, as Enter / Space do.
  const choose = async (value) => {
    const btn = doc.querySelector(`.wt-row .wt-mode-switch [data-choice="${value}"]`);
    assert.ok(btn, `a segment for ${value}`);
    btn.click();
    await settle();
  };
  const press = async (btn) => { btn.click(); await settle(); };
  return { window, doc, writes, rails, go, change, choose, press };
}

const pairGroup = () => backendModes.cliGroups(Object.values(registry())).find((g) => g.owner.id === 'cli-a');

test('the CLIs pane has one entry per CLI, and the mode switch only for a CLI with a twin', async () => {
  const t = await openTour();
  t.go('Your CLIs');
  const rows = [...t.doc.querySelectorAll('.wt-row')];
  assert.deepStrictEqual(rows.map((r) => r.querySelector('.wt-row-label').textContent), ['CLI A', 'CLI B'],
    'the GUI is a mode of CLI A, not a row of its own');
  const [pair, single] = rows;
  const sw = pair.querySelector('.viewer-mode-group.wt-mode-switch[role="group"]');
  assert.ok(sw, 'a CLI with a twin gets the mode switch, in the Configure dialog\'s look');
  assert.equal(pair.querySelector('select'), null, 'no dropdown is left');
  const segs = [...sw.querySelectorAll('button[data-choice]')];
  assert.deepStrictEqual(segs.map((b) => b.textContent), ['Terminal', 'GUI', 'Both']);
  assert.ok(segs.every((b) => b.type === 'button' && b.classList.contains('fp-toolbar-btn') && b.classList.contains('viewer-mode-btn')));
  assert.deepStrictEqual(segs.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent), ['Terminal']);
  assert.ok(pair.querySelector('.settings-toggle input[type="checkbox"]'), 'and its toggle');
  assert.equal(single.querySelector('.wt-mode-switch'), null, 'a CLI with no twin renders exactly its toggle');
  assert.equal(single.querySelectorAll('.settings-toggle input[type="checkbox"]').length, 1);
  t.window.close();
});

test('the mode switch writes what the Backends list writes for the same choice, and moves the target', async () => {
  const t = await openTour({ store: { backendEnabled: { 'cli-a': true, 'cli-b': true }, defaultLaunchTarget: 'cli-a', other: 1 } });
  t.go('Your CLIs');
  const gui = pairGroup().modes.find((m) => m.kind === 'driver').id;
  await t.choose(gui);
  const write = t.writes.at(-1);
  assert.equal(write.route, 'set', 'backendEnabled goes through the whole-blob write, never a shallow merge');
  // The panel's mode change writes `enabledForChoice(group, value)`; the tour must write the same values.
  const expected = backendModes.enabledForChoice(pairGroup(), gui);
  assert.deepStrictEqual(
    Object.fromEntries(pairGroup().ids.map((id) => [id, write.blob.backendEnabled[id]])), expected);
  assert.deepStrictEqual(expected, { 'cli-a': false, 'cli-a-gui': true });
  assert.equal(write.blob.backendEnabled['cli-b'], true, 'another CLI keeps its state');
  assert.equal(write.blob.other, 1, 'and the rest of the blob survives');
  assert.equal(write.blob.defaultLaunchTarget, gui, 'the default target follows the mode (D6)');
  t.window.close();
});

test('a default target outside the group stays where it is', async () => {
  const t = await openTour({ store: { backendEnabled: { 'cli-a': true, 'cli-b': true }, defaultLaunchTarget: 'cli-b' } });
  t.go('Your CLIs');
  await t.choose('cli-a-gui');
  assert.equal(t.writes.at(-1).blob.defaultLaunchTarget, 'cli-b');
  t.window.close();
});

test('with no target stored, the resolved default follows the mode, and is written only when it moves', async () => {
  // A first launch stores no target; the app resolves one (`_defaultBackendId`). Leaving it unwritten when
  // the owner is switched off would let the main process fall to the first enabled backend, while the
  // Backends list moves it to the other mode of the same CLI.
  let t = await openTour({ store: { backendEnabled: { 'cli-a': true, 'cli-b': true } }, defaultBackendId: 'cli-a' });
  t.go('Your CLIs');
  await t.choose('cli-a-gui');
  assert.equal(t.writes.at(-1).blob.defaultLaunchTarget, 'cli-a-gui');
  t.window.close();

  t = await openTour({ store: { backendEnabled: { 'cli-a': true } }, defaultBackendId: 'cli-a' });
  t.go('Your CLIs');
  await t.choose('cli-a|cli-a-gui');
  assert.ok(!('defaultLaunchTarget' in t.writes.at(-1).blob), 'a target that does not move is not written');
  t.window.close();

  t = await openTour({ store: { backendEnabled: { 'cli-a': true, 'cli-b': true } }, defaultBackendId: 'cli-b' });
  t.go('Your CLIs');
  await t.choose('cli-a-gui');
  assert.ok(!('defaultLaunchTarget' in t.writes.at(-1).blob), 'a resolved target outside the group is left alone');
  t.window.close();
});

test('the toggle of a CLI with a twin: off writes every id false, on brings the mode back (D14)', async () => {
  const t = await openTour({ store: { backendEnabled: { 'cli-a': true, 'cli-a-gui': true } } });
  t.go('Your CLIs');
  const toggle = () => t.doc.querySelector('.wt-row .settings-toggle input');
  await t.change(toggle(), false);
  assert.deepStrictEqual(t.writes.at(-1).blob.backendEnabled, { 'cli-a': false, 'cli-a-gui': false });
  assert.ok([...t.doc.querySelectorAll('.wt-row [data-choice]')].every((b) => b.disabled), 'the switch follows the toggle');
  await t.change(toggle(), true);
  assert.deepStrictEqual(t.writes.at(-1).blob.backendEnabled, { 'cli-a': true, 'cli-a-gui': true },
    'the mode it had in this tour, not Terminal');
  assert.equal(t.doc.querySelector('.wt-row [data-choice][aria-pressed="true"]').dataset.choice, 'cli-a|cli-a-gui');
  t.window.close();
});

test('switching on a CLI with no remembered mode enables its owner alone', async () => {
  const t = await openTour({ store: { backendEnabled: { 'cli-a': false, 'cli-a-gui': false } } });
  t.go('Your CLIs');
  await t.change(t.doc.querySelector('.wt-row .settings-toggle input'), true);
  assert.deepStrictEqual(t.writes.at(-1).blob.backendEnabled, { 'cli-a': true, 'cli-a-gui': false });
  t.window.close();
});

test('every segment writes the same backendEnabled as enabledForChoice', async () => {
  for (const c of backendModes.modeChoices(pairGroup())) {
    const t = await openTour({ store: { backendEnabled: { 'cli-a': true } } });
    t.go('Your CLIs');
    await t.choose(c.value);
    const write = t.writes.at(-1);
    assert.equal(write.route, 'set');
    assert.deepStrictEqual(Object.fromEntries(pairGroup().ids.map((id) => [id, write.blob.backendEnabled[id]])),
      backendModes.enabledForChoice(pairGroup(), c.value), c.label);
    t.window.close();
  }
});

test('"Default in the picker" appears only with both modes on and writes pickerModeByBackend whole-blob', async () => {
  let t = await openTour({ store: { backendEnabled: { 'cli-a': true, 'cli-a-gui': false } } });
  t.go('Your CLIs');
  assert.equal(t.doc.querySelector('.wt-picker-mode-switch'), null, 'one mode on: no picker default');
  await t.choose('cli-a|cli-a-gui');
  const segs = () => [...t.doc.querySelectorAll('.wt-picker-mode-switch [data-picker-mode]')];
  assert.deepStrictEqual(segs().map((b) => b.textContent), ['Terminal', 'GUI']);
  assert.ok(segs().every((b) => b.classList.contains('fp-toolbar-btn') && b.classList.contains('viewer-mode-btn')));
  assert.equal(t.doc.querySelector('.wt-picker-mode-switch [aria-pressed="true"]').textContent, 'Terminal', 'the terminal mode until chosen');
  await t.press(segs()[1]);
  const write = t.writes.at(-1);
  assert.equal(write.route, 'set', 'a nested key goes through the whole-blob write');
  assert.deepStrictEqual(write.blob.pickerModeByBackend, { 'cli-a': 'cli-a-gui' }, 'the value the Backends list saves');
  assert.deepStrictEqual(write.blob.backendEnabled, { 'cli-a': true, 'cli-a-gui': true }, 'and the rest of the blob survives');
  assert.equal(t.doc.querySelector('.wt-picker-mode-switch [aria-pressed="true"]').textContent, 'GUI');
  t.window.close();

  t = await openTour({ store: { backendEnabled: { 'cli-a': true, 'cli-a-gui': true }, pickerModeByBackend: { 'cli-a': 'gone' } } });
  t.go('Your CLIs');
  assert.equal(t.doc.querySelector('.wt-picker-mode-switch [aria-pressed="true"]').textContent, 'Terminal',
    'an unknown stored mode shows the terminal mode');
  t.window.close();
});

test('settings-panel writes the picker default key the tour writes', () => {
  assert.match(settingsSaveSource(), /\bpickerModeByBackend\b/);
  assert.match(read(TOUR), /pickerModeByBackend/);
});

test('a CLI with no twin still writes its own backendEnabled flag', async () => {
  const t = await openTour({ store: { backendEnabled: { 'cli-a': true } } });
  t.go('Your CLIs');
  const single = t.doc.querySelectorAll('.wt-row')[1];
  await t.change(single.querySelector('input'), true);
  assert.deepStrictEqual(t.writes.at(-1).blob.backendEnabled, { 'cli-a': true, 'cli-b': true });
  t.window.close();
});

test('the two new panes sit where the plan puts them, and nothing counts the panes', async () => {
  const t = await openTour({ store: { backendEnabled: { 'cli-a-gui': true } } });
  const rails = t.rails();
  assert.equal(rails.indexOf('Session sidebar'), rails.indexOf('Sidebar') + 1, 'after "The sidebar trims itself"');
  assert.equal(rails.indexOf('Keep warm'), rails.indexOf('Attention') + 1, 'after the attention pane');
  assert.ok(!/\b(eight|nine|ten|eleven)\b[^.]{0,20}panes/i.test(read(TOUR)), 'the welcome text must not write down a pane count');
  t.window.close();
});

test('the keep-warm pane is skipped unless an installed, enabled backend answers idleMaintenance', async () => {
  let t = await openTour({ store: { backendEnabled: { 'cli-a-gui': false } } });
  assert.ok(!t.rails().includes('Keep warm'), 'the only backend answering it is switched off');
  t.window.close();
  t = await openTour({ store: { backendEnabled: { 'cli-a-gui': true } }, backends: registry({ idleAnswer: 'no' }) });
  assert.ok(!t.rails().includes('Keep warm'), 'a backend whose hook only declines does not count');
  t.window.close();
  // Switching the GUI on inside the tour brings the pane in without reopening it.
  t = await openTour({ store: { backendEnabled: { 'cli-a': true, 'cli-a-gui': false } } });
  t.go('Your CLIs');
  await t.choose('cli-a|cli-a-gui');
  assert.ok(t.rails().includes('Keep warm'));
  assert.equal(railText(t.doc.querySelector('.wt-rail-item[aria-current="true"]')), 'Your CLIs',
    'the pane on screen stays the pane on screen');
  t.window.close();
});

test('the keep-warm pane writes idleMaintenanceMode as a flat key and redraws its timeline', async () => {
  const t = await openTour({ store: { backendEnabled: { 'cli-a-gui': true } } });
  t.go('Keep warm');
  const select = t.doc.querySelector('.wt-row select');
  assert.deepStrictEqual([...select.options].map((o) => o.value), ['off', 'warm', 'compact', 'warm-compact']);
  assert.equal(select.value, 'off', 'off until somebody chooses it');
  assert.match(t.doc.querySelector('.wt-prose').textContent, /real model turn/);
  const marks = () => [...t.doc.querySelectorAll('.wt-figure svg text')].map((el) => el.textContent);
  assert.ok(!marks().includes('refresh') && !marks().includes('compact'), 'off draws no turn');
  await t.change(select, 'warm-compact');
  assert.deepStrictEqual(t.writes.at(-1), { route: 'merge', patch: { idleMaintenanceMode: 'warm-compact' } });
  assert.ok(marks().includes('refresh') && marks().includes('compact'), 'refresh ticks and a compaction mark');
  t.window.close();
});

test('the session sidebar pane names the sections from lib/sidebar-groups.js and writes sessionSidebarDefault', async () => {
  const t = await openTour();
  t.go('Session sidebar');
  const { SESSION_SIDEBAR_GROUP_NAMES } = require('../src/renderer/lib/sidebar-groups.js');
  const prose = t.doc.querySelector('.wt-prose').textContent;
  for (const g of SESSION_SIDEBAR_GROUP_NAMES) assert.ok(prose.includes(g.label), `the pane names ${g.label}`);
  // Never a second list: no section label is written into the tour itself.
  const src = read(TOUR);
  assert.ok(!SESSION_SIDEBAR_GROUP_NAMES.some((g) => src.includes(`'${g.label}'`)), 'the names are read, not copied');
  const select = t.doc.querySelector('.wt-row select');
  assert.equal(select.value, 'closed');
  const drawn = () => [...t.doc.querySelectorAll('.wt-figure svg text')].map((el) => el.textContent);
  assert.ok(!drawn().includes(SESSION_SIDEBAR_GROUP_NAMES[0].label), 'closed: no sidebar drawn');
  await t.change(select, 'open');
  assert.deepStrictEqual(t.writes.at(-1), { route: 'merge', patch: { sessionSidebarDefault: 'open' } });
  assert.ok(drawn().includes(SESSION_SIDEBAR_GROUP_NAMES[0].label), 'open: the sidebar is drawn with its sections');
  t.window.close();
});
