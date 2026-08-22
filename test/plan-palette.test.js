'use strict';
// #453 — the plan picker's decisions, handed data instead of a keyboard.
//
// The parts worth guarding are the ones that decide what the user sees and what lands in the prompt:
// which plans the picker may offer at all, and that the template can never resolve to nothing.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  filterPlans, plansForProject, planInsertText, DEFAULT_PLAN_INSERT_TEMPLATE,
} = require('../src/renderer/terminal/plan-palette');

const plan = (over) => ({
  filePath: '/plans/a.md', filename: 'a.md', title: 'A plan', modified: '2026-08-01T00:00:00Z', ...over,
});

const HERE = '/proj/here';

test('the filter matches the title and the filename', () => {
  const rows = [
    plan({ filename: 'hazy-zooming-pebble.md', title: 'Remove the end date' }),
    plan({ filename: 'starry-dazzling-wand.md', title: 'Water meter filter' }),
  ];
  assert.equal(filterPlans(rows, 'end date').length, 1);
  // The slug is the only handle someone has who saw the file on disk rather than in this list.
  assert.equal(filterPlans(rows, 'pebble').length, 1);
  assert.equal(filterPlans(rows, 'ZOOMING').length, 1, 'case does not matter');
  assert.equal(filterPlans(rows, '').length, 2, 'a blank query keeps everything');
  assert.equal(filterPlans(null, 'x').length, 0);
});

test('only this project\'s plans are offered', () => {
  const rows = plansForProject([
    plan({ filePath: '/p/orphan.md' }),
    plan({ filePath: '/p/other.md', projectPath: '/proj/other', displayName: 'Other' }),
    plan({ filePath: '/p/mine.md', projectPath: HERE, displayName: 'Here' }),
  ], HERE);
  // A foreign plan in a hotkey list is a foreign codebase's instructions one Enter away, and a plan
  // nothing could attribute is unknown rather than local.
  assert.deepEqual(rows.map(p => p.filePath), ['/p/mine.md']);
});

test('the order the rows arrived in is kept', () => {
  const rows = plansForProject([
    plan({ filePath: '/p/newer.md', projectPath: HERE }),
    plan({ filePath: '/p/other.md', projectPath: '/proj/other' }),
    plan({ filePath: '/p/older.md', projectPath: HERE }),
  ], HERE);
  // The rows arrive sorted by date and nothing reorders them, so the list the arrows walk is the list
  // the eye reads and the highlight index is simply the row number.
  assert.deepEqual(rows.map(p => p.filePath), ['/p/newer.md', '/p/older.md']);
});

test('a terminal with no project of its own is offered nothing', () => {
  const rows = [
    plan({ filePath: '/a.md', projectPath: '/proj/x', displayName: 'X' }),
    plan({ filePath: '/b.md' }),
  ];
  // "I cannot tell which project this is" is not a licence to offer every project's plans.
  assert.deepEqual(plansForProject(rows, null), []);
  assert.deepEqual(plansForProject(rows, ''), []);
});

test('plansForProject survives a missing list', () => {
  assert.deepEqual(plansForProject(null, HERE), []);
  assert.deepEqual(plansForProject([null, undefined], HERE), []);
});

test('the template substitutes every placeholder', () => {
  const p = plan({ filePath: '/plans/x.md', filename: 'x.md', title: 'Do the thing' });
  assert.equal(planInsertText(p, 'Read {path} — it is “{title}” ({filename})'),
    'Read /plans/x.md — it is “Do the thing” (x.md)');
});

test('an empty or whitespace template falls back to the default', () => {
  const p = plan({ filePath: '/plans/x.md' });
  // A hotkey that inserts an empty string is indistinguishable from one that is broken.
  assert.equal(planInsertText(p, ''), DEFAULT_PLAN_INSERT_TEMPLATE.replace('{path}', '/plans/x.md'));
  assert.equal(planInsertText(p, '   '), DEFAULT_PLAN_INSERT_TEMPLATE.replace('{path}', '/plans/x.md'));
  assert.equal(planInsertText(p, null), DEFAULT_PLAN_INSERT_TEMPLATE.replace('{path}', '/plans/x.md'));
});

test('a template of nothing but placeholders that resolve empty still yields the path', () => {
  const p = plan({ filePath: '/plans/x.md', title: '', filename: '' });
  assert.equal(planInsertText(p, '{title}{filename}'), '/plans/x.md');
});

test('the default names the file and says what to do with it', () => {
  assert.match(DEFAULT_PLAN_INSERT_TEMPLATE, /\{path\}/);
  assert.ok(DEFAULT_PLAN_INSERT_TEMPLATE.trim().split(/\s+/).length > 1, 'a bare path is not an instruction');
});

test('no plan inserts nothing', () => {
  assert.equal(planInsertText(null, 'x {path}'), '');
});

// The default lives twice by necessity — once in SETTING_DEFAULTS (main) and once in the settings panel's
// `fieldValue` fallback (renderer, which cannot require main). Two literals that happen to agree until one
// is edited is exactly the shape #237 had to be dug out of, so they are pinned against each other.
test('the panel fallback matches SETTING_DEFAULTS', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const settings = require('../src/app/settings');
  const expected = settings.SETTING_DEFAULTS.planInsertTemplate;
  assert.equal(expected, DEFAULT_PLAN_INSERT_TEMPLATE, 'the palette module and the main process must agree');

  const panel = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/panels/settings-panel.js'), 'utf8');
  const m = /fieldValue\('planInsertTemplate', '([^']*)'\)/.exec(panel);
  assert.ok(m, 'the settings panel must read planInsertTemplate with an explicit fallback');
  assert.equal(m[1], expected, 'the panel fallback drifted from SETTING_DEFAULTS');
});
