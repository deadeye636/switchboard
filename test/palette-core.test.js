'use strict';
// #462 — the popover every insert picker opens, tested where it is pure.
//
// These two functions were the variable palette's until the third picker made a shared core the only
// sane place for them, and the cases they cover are the ones that were found by looking at a wrong
// palette on screen: a highlight that walked off the end, a palette hanging over the card below it.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  nextIndex, clampIndex, pageStep, paletteGeometry, paletteMetaWithDate,
} = require('../src/renderer/terminal/palette-core');

test('the highlight wraps at both ends', () => {
  assert.equal(nextIndex(0, 3, 1), 1);
  assert.equal(nextIndex(2, 3, 1), 0);   // past the end → first
  assert.equal(nextIndex(0, 3, -1), 2);  // before the start → last
  assert.equal(nextIndex(1, 3, -1), 0);
});

test('an empty list has no highlight, so Enter cannot insert', () => {
  assert.equal(nextIndex(0, 0, 1), -1);
  assert.equal(nextIndex(-1, 0, -1), -1);
});

test('a highlight of -1 moving forward lands on the first row', () => {
  // After a filter emptied the list and a new one refilled it, the index is restored from -1.
  assert.equal(nextIndex(-1, 3, 1), 1);
  assert.equal(nextIndex(-1, 3, -1), 2);
});

// --- Page and Home/End (#506) ---
// The arrows wrap; a page jump must not. Landing back at the top after PageDown reads as a scroll
// that went wrong, so these stop at the ends instead.

test('a page jump stops at the ends instead of wrapping', () => {
  assert.equal(clampIndex(0, 50, 10), 10);
  assert.equal(clampIndex(45, 50, 10), 49);   // past the end → last row, not the first
  assert.equal(clampIndex(4, 50, -10), 0);    // before the start → first row, not the last
  assert.equal(clampIndex(20, 50, -10), 10);
});

test('Home and End are the same walk with an unbounded step', () => {
  assert.equal(clampIndex(17, 50, -Infinity), 0);
  assert.equal(clampIndex(17, 50, Infinity), 49);
  assert.equal(clampIndex(0, 1, Infinity), 0);
});

test('an empty list has no highlight for a page key either', () => {
  assert.equal(clampIndex(0, 0, 10), -1);
  assert.equal(clampIndex(-1, 0, -Infinity), -1);
});

test('a page is as many whole rows as the list shows at once', () => {
  assert.equal(pageStep(300, 24), 12);
  assert.equal(pageStep(310, 24), 12);   // a half-visible row is not a row
  assert.equal(pageStep(20, 24), 1);     // a list shorter than one row still steps
});

test('an unmeasurable list falls back rather than standing still', () => {
  // Before the first row is drawn there is nothing to measure, and a step of 0 would make the key dead.
  for (const [listHeight, rowHeight] of [[0, 24], [300, 0], [NaN, 24], [300, undefined]]) {
    assert.equal(pageStep(listHeight, rowHeight), 10);
  }
});

// --- Where the palette sits ---
// The anchor is "the lower half of the terminal", but a small grid card makes half of it all chrome
// and no list, and a terminal near the viewport edge must not push the footer off-screen.

const R = (top, height, left = 0, width = 800) => ({ top, height, left, width });

test('a tall terminal gets exactly its lower half', () => {
  const g = paletteGeometry(R(50, 800), 900);
  assert.deepEqual(g, { left: 0, width: 800, top: 450, height: 400 });
});

test('the palette never spills below its own terminal', () => {
  // A card shorter than the minimum height gets covered entirely rather than overhanging the card
  // below it — overhang would put the palette on top of a DIFFERENT session.
  const rect = R(300, 200);
  const g = paletteGeometry(rect, 1000);
  assert.ok(g.top + g.height <= rect.top + rect.height,
    `palette ${g.top}+${g.height} overhangs terminal bottom ${rect.top + rect.height}`);
  // It keeps the usable minimum and sits flush with the card's bottom instead of overhanging it.
  assert.equal(g.height, 190);
  assert.equal(g.top, 310);
});

test('a terminal at the viewport bottom keeps the footer on screen', () => {
  const g = paletteGeometry(R(700, 180), 900);
  assert.ok(g.top + g.height <= 900 - 8, `bottom ${g.top + g.height} is off-screen`);
  assert.ok(g.top >= 8);
});

test('a terminal scrolled above the viewport still lands on screen', () => {
  const g = paletteGeometry(R(-500, 400), 900);
  assert.ok(g.top >= 8);
  assert.ok(g.height >= 1);
});

test('the minimum height applies only where the terminal can carry it', () => {
  // Room to spare → the floor lifts a short-but-not-tiny palette to something usable.
  assert.equal(paletteGeometry(R(0, 300), 900).height, 190);
  // No room → the terminal's own height wins, never more.
  assert.equal(paletteGeometry(R(0, 120), 900).height, 120);
});

test('left and width always track the terminal', () => {
  const g = paletteGeometry(R(0, 600, 137, 421), 900);
  assert.equal(g.left, 137);
  assert.equal(g.width, 421);
});

// --- The pickers agree on the shape the core requires ---
//
// A picker is a plain description, so a missing key is not a syntax error anywhere — it is a palette
// that opens and then throws on the first render. This is the guard that says so at test time.
const REQUIRED = ['id', 'shortcut', 'placeholder', 'ariaLabel', 'listLabel', 'failedText',
  'load', 'filter', 'rowKey', 'row', 'emptyText', 'noMatchText', 'pick'];

test('every picker config carries what the core reads', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  // Two homes, because the fourth picker is not a terminal one: the command palette (#274) belongs to
  // the app, not to a session, and lives in shell/. Scanning only terminal/ left it unguarded — the gap
  // this test exists to close.
  const dirs = [
    path.join(__dirname, '..', 'src', 'renderer', 'terminal'),
    path.join(__dirname, '..', 'src', 'renderer', 'shell'),
  ];
  const files = dirs.flatMap(dir => fs.readdirSync(dir)
    .filter(f => /palette\.js$/.test(f) && f !== 'palette-core.js')
    .map(f => path.join(dir, f)));
  assert.ok(files.length >= 4, `expected the picker files to be found, saw ${files.length}`);
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const key of REQUIRED) {
      assert.ok(new RegExp('(^|\\s)' + key + ':').test(src), `${path.basename(file)} declares no ${key}`);
    }
  }
});

// --- The row's date (#475) ---
//
// The pickers were the one place the app dropped it: the Plans list has shown it all along, and a picker
// is where "which of these five" actually gets decided. It lives here rather than in each picker because
// the wording has to be the app's one answer to that question, `formatDate`.
//
// `formatDate` is a free global of lib/utils.js, which node does not load — so it is planted on the
// global here, which is also how the absent case gets covered.

test('the file and the date, separated', () => {
  global.formatDate = () => '3d ago';
  try {
    assert.equal(paletteMetaWithDate('2026-08-24-a.md', '2026-08-22T09:00:00Z'), '2026-08-24-a.md · 3d ago');
    assert.equal(paletteMetaWithDate('.handoffs/a.md', '2026-08-22T09:00:00Z'), '.handoffs/a.md · 3d ago');
  } finally { delete global.formatDate; }
});

test('a date that cannot be read leaves the filename alone', () => {
  global.formatDate = () => '3d ago';
  try {
    assert.equal(paletteMetaWithDate('a.md', null), 'a.md', 'no date at all');
    assert.equal(paletteMetaWithDate('a.md', 'not a date'), 'a.md', 'an unparseable one');
    assert.equal(paletteMetaWithDate('a.md', ''), 'a.md');
  } finally { delete global.formatDate; }
});

test('a formatter that throws or is absent costs the date, never the row', () => {
  assert.equal(paletteMetaWithDate('a.md', '2026-08-22T09:00:00Z'), 'a.md', 'no formatter loaded');
  global.formatDate = () => { throw new Error('x'); };
  try {
    assert.equal(paletteMetaWithDate('a.md', '2026-08-22T09:00:00Z'), 'a.md');
  } finally { delete global.formatDate; }
});

test('nothing to name is not a row that says nothing', () => {
  global.formatDate = () => '3d ago';
  try {
    assert.equal(paletteMetaWithDate('', '2026-08-22T09:00:00Z'), '3d ago',
      'a row with no filename still says when');
    assert.equal(paletteMetaWithDate(null, null), '');
  } finally { delete global.formatDate; }
});
