'use strict';
// #453 — the plan picker's decisions, handed data instead of a keyboard.
//
// The parts worth guarding are the ones that decide what the user sees and what lands in the prompt:
// which group a plan falls into and in what order, that the walk order matches the read order, and that
// the template can never resolve to nothing.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  filterPlans, nextIndex, groupForList, displayOrder, planInsertText, DEFAULT_PLAN_INSERT_TEMPLATE,
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

test('this project comes first, then other projects, then the unattributed', () => {
  const groups = groupForList([
    plan({ filePath: '/p/orphan.md' }),
    plan({ filePath: '/p/other.md', projectPath: '/proj/other', displayName: 'Other' }),
    plan({ filePath: '/p/mine.md', projectPath: HERE, displayName: 'Here' }),
  ], HERE);
  assert.deepEqual(groups.map(g => g.key), ['project', 'proj:/proj/other', 'orphans']);
  assert.equal(groups[0].label, 'This project');
  assert.equal(groups[1].label, 'Other');
});

test('a plan from another project stays reachable rather than being filtered away', () => {
  const rows = [plan({ filePath: '/p/other.md', projectPath: '/proj/other', displayName: 'Other' })];
  const groups = groupForList(rows, HERE);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].plans.length, 1, 'handing another project\'s plan over is a normal thing to do');
});

test('a project falls back to its short name, then to its path', () => {
  const groups = groupForList([
    plan({ filePath: '/a.md', projectPath: '/proj/x', shortName: 'work/x' }),
    plan({ filePath: '/b.md', projectPath: '/proj/y' }),
  ], HERE);
  assert.deepEqual(groups.map(g => g.label), ['work/x', '/proj/y']);
});

test('with no project of its own, everything is simply another project', () => {
  const groups = groupForList([
    plan({ filePath: '/a.md', projectPath: '/proj/x', displayName: 'X' }),
  ], null);
  assert.deepEqual(groups.map(g => g.key), ['proj:/proj/x'], 'nothing claims to be "this project"');
});

test('the walk order is the read order', () => {
  const rows = [
    plan({ filePath: '/p/orphan.md' }),
    plan({ filePath: '/p/other.md', projectPath: '/proj/other' }),
    plan({ filePath: '/p/mine.md', projectPath: HERE }),
  ];
  // The rows arrive sorted by date; if the arrows walked THAT order the highlight would jump around the
  // screen, because the groups render project-first.
  assert.deepEqual(displayOrder(rows, HERE).map(p => p.filePath),
    ['/p/mine.md', '/p/other.md', '/p/orphan.md']);
});

test('the highlight wraps at both ends and an empty list has none', () => {
  assert.equal(nextIndex(0, 3, 1), 1);
  assert.equal(nextIndex(2, 3, 1), 0);
  assert.equal(nextIndex(0, 3, -1), 2);
  assert.equal(nextIndex(-1, 0, 1), -1, 'nothing to highlight means Enter inserts nothing');
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
