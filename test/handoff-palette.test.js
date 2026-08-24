'use strict';
// #469 — the handoff picker's decisions, handed data instead of a keyboard.
//
// The parts worth guarding are the ones that decide what the user sees and what lands in the prompt:
// which handoffs the picker may offer at all, and that the template can never resolve to nothing.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  filterHandoffs, handoffsForProject, handoffInsertText, DEFAULT_HANDOFF_INSERT_TEMPLATE,
} = require('../src/renderer/terminal/handoff-palette');

const handoff = (over) => ({
  filePath: '/proj/here/.handoffs/2026-08-24-a.md',
  filename: '2026-08-24-a.md',
  title: 'Tariff end date',
  createdAt: '2026-08-24T09:00:00Z',
  projectPath: '/proj/here',
  ...over,
});

const HERE = '/proj/here';

test('the filter matches the title and the filename', () => {
  const rows = [
    handoff({ filename: '2026-08-24-tariff-end-date.md', title: 'Remove the end date' }),
    handoff({ filename: '2026-08-20-water-meter.md', title: 'Water meter filter' }),
  ];
  assert.equal(filterHandoffs(rows, 'end date').length, 1);
  // The dated slug is the only handle someone has who saw the file on disk rather than in this list.
  assert.equal(filterHandoffs(rows, 'water-meter').length, 1);
  assert.equal(filterHandoffs(rows, 'WATER').length, 1, 'case does not matter');
  assert.equal(filterHandoffs(rows, '').length, 2, 'a blank query keeps everything');
  assert.equal(filterHandoffs(null, 'x').length, 0);
});

test('a row with only a label still filters', () => {
  // Main sends `title` and `label` as the same string, but a row that lost one must not become
  // unsearchable — the filter reads whichever is there.
  const rows = [handoff({ title: undefined, label: 'Saved packet' })];
  assert.equal(filterHandoffs(rows, 'saved').length, 1);
});

test("only this project's handoffs are offered", () => {
  const rows = handoffsForProject([
    handoff({ filePath: '/p/other.md', projectPath: '/proj/other' }),
    handoff({ filePath: '/p/mine.md', projectPath: HERE }),
  ], HERE);
  // A foreign handoff in a hotkey list is another codebase's context one Enter away.
  assert.deepEqual(rows.map(h => h.filePath), ['/p/mine.md']);
});

test('a terminal with no project is offered nothing, not everything', () => {
  assert.deepEqual(handoffsForProject([handoff(), handoff({ filePath: '/p/b.md' })], null), []);
  assert.deepEqual(handoffsForProject([handoff()], ''), []);
});

test('the insert template substitutes and never resolves to nothing', () => {
  const h = handoff({ title: 'Tariff end date' });
  assert.equal(
    handoffInsertText(h, 'Read {title} at {path} ({filename})'),
    `Read Tariff end date at ${h.filePath} (${h.filename})`,
  );
  // No template, a blank one, and one made only of whitespace all fall back rather than inserting ''.
  assert.equal(handoffInsertText(h, null), DEFAULT_HANDOFF_INSERT_TEMPLATE.replace('{path}', h.filePath));
  assert.equal(handoffInsertText(h, '   '), DEFAULT_HANDOFF_INSERT_TEMPLATE.replace('{path}', h.filePath));
  // A template whose placeholders all resolve to empty would leave an empty prompt line: the path wins.
  assert.equal(handoffInsertText(handoff({ title: '', filename: '' }), '{title} {filename}'), h.filePath);
  assert.equal(handoffInsertText(null, 'x'), '');
});

test('the default template names the path, so a reference is never the packet', () => {
  assert.match(DEFAULT_HANDOFF_INSERT_TEMPLATE, /\{path\}/);
});
