'use strict';
// #467 — what a terminal selection puts on the clipboard.
//
// The defect this pins is not in this repo's code at all: under ConPTY `IBufferLine.isWrapped` arrives
// from the PTY, and a row painted out to the last column leaves a wrap PENDING that the next row
// inherits. xterm's `getSelection()` breaks lines on that flag alone, so a CLI whose prompt box is
// exactly `cols` wide hands out text with the break missing — and a window resize reflows the buffer,
// clears the stale flags and hides the whole thing again until the next full-width repaint.
//
// So the assertions below are written the way the bug appears: rows whose flags say "wrapped" while the
// text says "border". The measured case in the issue is the first test — 112 columns, four buffer rows,
// three clipboard lines.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const {
  isRuleRow,
  continuesLine,
  xtermSelectionText,
  repairedSelectionText,
  terminalSelectionText,
} = require('../src/renderer/terminal/selection-text');

const COLS = 112;
const pad = (s) => (s.length >= COLS ? s.slice(0, COLS) : s + ' '.repeat(COLS - s.length));

/** `{ text, isWrapped, row }` for one buffer row, the shape the join functions take. */
function row(text, wrapped, { from = 0, to = COLS } = {}) {
  const full = pad(text);
  return { text: full.slice(from, to).replace(/\s+$/, ''), isWrapped: !!wrapped, row: full };
}

/**
 * A terminal stub with just enough xterm in it: a buffer of padded rows, a selection range, and a
 * `getSelection()` that answers with xterm's own rule. That last part matters — the helper only applies
 * its repair once its reconstruction has reproduced what xterm said.
 */
function terminalOver(rows, { range, native } = {}) {
  const sel = range || { start: { x: 0, y: 0 }, end: { x: COLS, y: rows.length - 1 } };
  const lines = rows.map(r => ({
    isWrapped: !!r.wrapped,
    translateToString(trimRight, start = 0, end = COLS) {
      const s = pad(r.text).slice(start, end === undefined ? COLS : end);
      return trimRight ? s.replace(/\s+$/, '') : s;
    },
  }));
  const built = rows.map((r, i) => row(r.text, r.wrapped, {
    from: i === sel.start.y ? sel.start.x : 0,
    to: i === sel.end.y ? sel.end.x : COLS,
  }));
  return {
    cols: COLS,
    getSelectionPosition: () => sel,
    buffer: { active: { getLine: (y) => lines[y] } },
    getSelection: () => (native !== undefined ? native : xtermSelectionText(built, '\r\n')),
  };
}

const BOX = '─'.repeat(COLS);

// ---------------------------------------------------------------------------
// The measured case
// ---------------------------------------------------------------------------

test('the prompt box: four rows come back as four lines, not three', () => {
  const rows = [
    row(BOX, false),
    row('> ', true),                       // falsely marked wrapped — the whole bug
    row(BOX, false),
    row('  Opus 5 (1M context) | model', false),
  ];
  assert.equal(xtermSelectionText(rows, '\r\n').split('\r\n').length, 3, 'xterm welds two rows — the defect');
  const repaired = repairedSelectionText(rows, '\r\n').split('\r\n');
  assert.equal(repaired.length, 4);
  assert.equal(repaired[0], BOX);
  assert.equal(repaired[1], '>');
});

test('an ASCII frame breaks too — the box-drawing test alone would miss it', () => {
  const rule = '-'.repeat(COLS);
  const rows = [row(rule, false), row('> ', true)];
  assert.equal(repairedSelectionText(rows, '\n'), rule + '\n' + '>');
});

// ---------------------------------------------------------------------------
// What must keep working: a line the terminal itself wrapped stays one line
// ---------------------------------------------------------------------------

test('a genuinely wrapped line stays a single line', () => {
  const rows = [row('a'.repeat(COLS), false), row('bcdef', true)];
  assert.equal(repairedSelectionText(rows, '\n'), 'a'.repeat(COLS) + 'bcdef');
});

test('a wrap that lands right after a space still joins', () => {
  // Prose at 112 columns breaks after a space about one line in six. Treating a whitespace boundary as
  // a border would cut every one of those in half.
  // The space itself is gone either way — xterm right-trims every row it translates, wrapped ones
  // included, and that is its behaviour to keep. What must not happen is a second line.
  const rows = [row('x'.repeat(COLS - 1) + ' ', false), row('word', true)];
  assert.equal(repairedSelectionText(rows, '\n'), 'x'.repeat(COLS - 1) + 'word');
});

test('the repair only ever ADDS breaks — a row xterm did not join is never joined', () => {
  const rows = [row('a'.repeat(COLS), false), row('bcdef', false)];
  assert.equal(repairedSelectionText(rows, '\n'), xtermSelectionText(rows, '\n'));
});

// ---------------------------------------------------------------------------
// The boundary rules
// ---------------------------------------------------------------------------

test('a row that begins with box drawing is a border, not a continuation', () => {
  const rows = [row('a'.repeat(COLS), false), row('╭── Prompt', true)];
  assert.equal(repairedSelectionText(rows, '\n').split('\n').length, 2);
});

test('a blank row continues into nothing', () => {
  const rows = [row('', false), row('text', true)];
  assert.equal(repairedSelectionText(rows, '\n'), '\ntext');
});

test('isRuleRow: repeated punctuation only, and long enough to mean it', () => {
  assert.equal(isRuleRow('='.repeat(40)), true);
  assert.equal(isRuleRow('─'.repeat(9)), true);
  assert.equal(isRuleRow('---'), false, 'three dashes is punctuation in a sentence');
  assert.equal(isRuleRow('aaaaaaaaaaaa'), false);
  assert.equal(isRuleRow('            '), false);
});

test('continuesLine: an unwrapped row is never joined, whatever the boundary reads like', () => {
  assert.equal(continuesLine(row('a'.repeat(COLS), false), row('b', false)), false);
});

// ---------------------------------------------------------------------------
// The wrapper, against a buffer
// ---------------------------------------------------------------------------

test('terminalSelectionText repairs what getSelection() welded', () => {
  const term = terminalOver([
    { text: BOX, wrapped: false },
    { text: '> ', wrapped: true },
    { text: BOX, wrapped: false },
  ]);
  assert.equal(term.getSelection().split('\r\n').length, 2);
  assert.equal(terminalSelectionText(term).split('\r\n').length, 3);
});

test('it keeps the line ending xterm used', () => {
  const rows = [{ text: BOX, wrapped: false }, { text: '> ', wrapped: true }, { text: 'tail', wrapped: false }];
  const crlf = terminalOver(rows);
  assert.ok(terminalSelectionText(crlf).includes('\r\n'));
  const lf = terminalOver(rows, { native: xtermSelectionText([row(BOX, false), row('> ', true), row('tail', false)], '\n') });
  const out = terminalSelectionText(lf);
  assert.ok(out.includes('\n') && !out.includes('\r'));
});

test('the slicing matches xterm: first row from the drag, last row to it, exclusive', () => {
  // Against a literal rather than against `xtermSelectionText`, which is what the stub's own
  // `getSelection()` computes — otherwise the equality guard below would be true by construction and
  // nothing would pin the reconstruction itself.
  const term = terminalOver(
    [{ text: 'hello world', wrapped: false }, { text: 'second line', wrapped: false }],
    { range: { start: { x: 6, y: 0 }, end: { x: 6, y: 1 } } },
  );
  assert.equal(term.getSelection(), 'world\r\nsecond');
  assert.equal(terminalSelectionText(term), 'world\r\nsecond');
});

test('a selection the reconstruction cannot reproduce is handed back untouched', () => {
  // An alt+drag column selection slices every row to the same columns, and xterm exposes no flag for
  // it. The reconstruction then disagrees with `getSelection()` — and disagreeing means keeping xterm's
  // answer, not overwriting it with a rebuild that guessed.
  const term = terminalOver(
    [{ text: BOX, wrapped: false }, { text: '> ', wrapped: true }],
    { native: 'AB\r\nCD' },
  );
  assert.equal(terminalSelectionText(term), 'AB\r\nCD');
});

test('a terminal with no buffer to read falls back to getSelection()', () => {
  const stub = { hasSelection: () => true, getSelection: () => 'plain text' };
  assert.equal(terminalSelectionText(stub), 'plain text');
});

test('an empty selection stays empty', () => {
  assert.equal(terminalSelectionText({ getSelection: () => '' }), '');
});

// ---------------------------------------------------------------------------
// Every copy path goes through it
// ---------------------------------------------------------------------------

test('a task quote is the same text a copy would produce (#526)', () => {
  // The quote had the identical defect on a different surface: it read `getSelection()` verbatim, so a
  // quote spanning a prompt box arrived welded exactly as the clipboard used to. Three entry points, two
  // call sites — the context menu and the selection action bar share `runTerminalMenuAction`.
  const menu = read('src/renderer/terminal/terminal-context-menu.js');
  const manager = read('src/renderer/terminal/terminal-manager.js');
  assert.match(menu, /quote: terminal\.hasSelection\(\) \? terminalCopyText\(terminal\)/);
  assert.match(manager, /terminal\.hasSelection\(\) \? terminalCopyText\(terminal\)/);
  for (const [rel, src] of [['terminal-context-menu.js', menu], ['terminal-manager.js', manager]]) {
    assert.equal(
      /quote:[^\n]*terminal\.getSelection\(\)/.test(src), false,
      `${rel} quotes xterm's selection text verbatim — build it instead (#526)`,
    );
  }
});

test('the search prefill deliberately keeps xterm\'s own text', () => {
  // A search needle must not carry breaks this module inserted. Pinned so a later pass that "finishes
  // the job" has to argue with this line first.
  const manager = read('src/renderer/terminal/terminal-manager.js');
  assert.match(manager, /const sel = terminal\.getSelection\(\);\s*\n\s*if \(sel\) \{ searchInput\.value = sel;/);
});

test('no copy path reads getSelection() straight into the clipboard', () => {
  // The four paths of the acceptance: the context menu and the selection action bar (both through
  // runTerminalMenuAction's `copy`), copy-on-select, and Ctrl+C. The right-click `copy-paste` mode is a
  // fifth. A regression here is silent — the text still copies, it just copies wrong.
  for (const rel of ['src/renderer/terminal/terminal-context-menu.js', 'src/renderer/terminal/terminal-manager.js']) {
    const src = read(rel);
    const offenders = src.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /writeClipboard\(\s*terminal\.getSelection\(\)/.test(line));
    assert.deepEqual(offenders, [], `${rel} copies xterm's selection text verbatim — build it instead (#467)`);
  }
});

test('the renderer loads selection-text.js before the two files that copy', () => {
  const order = JSON.parse(read('test/fixtures/script-order.json'))['index.html'];
  const at = (name) => order.indexOf(name);
  assert.ok(at('selection-text.js') >= 0, 'index.html must load selection-text.js');
  assert.ok(at('selection-text.js') < at('terminal-context-menu.js'));
  assert.ok(at('selection-text.js') < at('terminal-manager.js'));
});
