'use strict';
// #857 — the task picker's decisions, handed data instead of a keyboard: what a template makes of a task,
// and what the filter matches. The popover and the keys are the click test's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { filterTaskRows, taskInsertText, DEFAULT_TASK_INSERT_TEMPLATE } = require('../src/renderer/terminal/task-palette');
const settings = require('../src/app/settings');
const { SETTING_DEFAULTS } = settings;

test('taskInsertTemplate cascades: default, then global, then the project', () => {
  const store = { global: {}, 'project:/p': {} };
  settings.init({ db: { getSetting: (key) => store[key] }, log: { info() {}, warn() {}, error() {} } });
  assert.equal(settings.effectiveSettings('/p').taskInsertTemplate, '{title} (task #{id})');
  store.global.taskInsertTemplate = 'G {title}';
  assert.equal(settings.effectiveSettings('/p').taskInsertTemplate, 'G {title}');
  assert.equal(settings.effectiveSettings('/other').taskInsertTemplate, 'G {title}');
  store['project:/p'].taskInsertTemplate = 'P {id}';
  assert.equal(settings.effectiveSettings('/p').taskInsertTemplate, 'P {id}');
  assert.equal(settings.effectiveSettings('/other').taskInsertTemplate, 'G {title}', 'another project keeps the global text');
});

const task = (over) => ({ id: 7, title: ' Fix it ', status: 'open', note: 'see the log', ...over });

test('the default template reproduces the text a task row inserted before there was one', () => {
  assert.equal(DEFAULT_TASK_INSERT_TEMPLATE, '{title} (task #{id})');
  assert.equal(SETTING_DEFAULTS.taskInsertTemplate, DEFAULT_TASK_INSERT_TEMPLATE);
  assert.equal(taskInsertText(task(), undefined), 'Fix it (task #7)');
  assert.equal(taskInsertText(task(), '   '), 'Fix it (task #7)', 'a blank template means the default');
});

test('a template substitutes title, id, status and note', () => {
  assert.equal(taskInsertText(task(), 'Work on {title} [{id}, {status}]: {note}'), 'Work on Fix it [7, open]: see the log');
  assert.equal(taskInsertText(task({ note: null }), '{title}|{note}|'), 'Fix it||');
  assert.equal(taskInsertText(task({ status: 'in_progress' }), '{status}'), 'in_progress');
});

test('plain is the bare title, and a template that resolves to nothing falls back to it', () => {
  assert.equal(taskInsertText(task(), 'Do {title}', true), 'Fix it');
  assert.equal(taskInsertText(task({ note: '' }), '{note}'), 'Fix it');
  assert.equal(taskInsertText(null, 'x'), '');
  assert.equal(taskInsertText(task({ title: '  ' }), '{id}'), '');
});

test('values are data: no replacement patterns, no second substitution', () => {
  assert.equal(taskInsertText(task({ title: 'a $& b $\' c' }), '{title}!'), 'a $& b $\' c!');
  assert.equal(taskInsertText(task({ note: 'x $` y' }), '{note}'), 'x $` y');
  assert.equal(taskInsertText(task({ title: 'about {note}' }), '{title} / {note}'), 'about {note} / see the log');
});

test('a task without an id reads as its bare title', () => {
  assert.equal(taskInsertText(task({ id: null }), undefined), 'Fix it');
  assert.equal(taskInsertText(task({ id: undefined }), 'No {id}'), 'Fix it');
});

test('the filter matches the title and the note', () => {
  const rows = [task({ id: 1, title: 'Alpha', note: '' }), task({ id: 2, title: 'Beta', note: 'mentions ALPHA' }), task({ id: 3, title: 'Gamma', note: '' })];
  assert.deepEqual(filterTaskRows(rows, 'alpha').map(t => t.id), [1, 2]);
  assert.equal(filterTaskRows(rows, '').length, 3);
  assert.equal(filterTaskRows(null, 'x').length, 0);
});

test('the picker is wired: hotkey, command-palette row, the conversation input, the terminal key handler, the setting', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  assert.match(read('src/renderer/shell/shortcuts.js'), /insertTask: \{ primary: true, alt: false, shift: true, key: 'y' \}/);
  assert.match(read('src/renderer/shell/shortcuts.js'), /id: 'insertTask'/);
  assert.match(read('src/renderer/terminal/terminal-manager.js'), /matchShortcut\('insertTask'/);
  assert.match(read('src/renderer/session/conversation-view.js'), /insertTask: \(\) =>/);
  assert.match(read('src/renderer/terminal/task-palette.js'), /shortcutId: 'insertTask'/);
  assert.match(read('src/renderer/panels/settings-global-html.js'), /id="sv-task-insert-template"/);
  assert.match(read('src/renderer/panels/settings-panel.js'), /settings\.taskInsertTemplate =/);
  const panel = read('src/renderer/panels/settings-panel.js');
  assert.match(panel, /useGlobalCheckbox\('taskInsertTemplate'\)/, 'a project can override it');
  assert.match(panel, /taskInsertTemplate: \(\) => \(settingsViewerBody\.querySelector\('#sv-task-insert-template'\)/, 'and the override is saved');
  assert.match(panel, /fieldValue\('taskInsertTemplate', '\{title\} \(task #\{id\}\)'\)/);
});
