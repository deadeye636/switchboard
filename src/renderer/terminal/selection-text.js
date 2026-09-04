// --- Copy text for a terminal selection (#467) ---
//
// `terminal.getSelection()` puts a line break between two rows only where the second is NOT
// `isWrapped`. Under ConPTY that flag arrives from the PTY: xterm's own legacy heuristics run only
// below build 21376 (`src/app/terminal/conpty.js`), so on Windows 11 they never run. A row painted out
// to the LAST column leaves the wrap pending, and whatever is painted next inherits it — which is every
// repaint of a CLI whose prompt box is exactly `cols` wide. The separator line above the prompt and the
// prompt row itself then arrive welded, and a paste shows one long line where the terminal showed two.
//
// The flag is stale STATE, not a misreading of the buffer: a window resize reflows the buffer, rebuilds
// the flags from the text, and the copy is correct again until the next full-width repaint. That is why
// the bug looks intermittent, and why nothing that keeps trusting `isWrapped` alone can fix it.
//
// So the copy text is BUILT from the rows instead of read out of xterm. Two rules, and the second may
// only ever ADD a break:
//
//   1. `isWrapped` false still means a new line. In that direction the flag was never observed wrong,
//      and honouring it keeps every copy that is correct today correct.
//   2. Where the flag says "wrapped", the boundary has to READ like continuing text. A box-drawing
//      character on either side of it, a rule of repeated punctuation, or a blank row above is a border
//      the CLI painted, not a wrap.
//
// Whitespace at the boundary is deliberately NOT a break: prose wraps right after a space about one
// line in six at 112 columns, and breaking there would cut every long wrapped line into pieces — the
// exact thing acceptance bullet 2 of #467 forbids.
//
// Two things it gets wrong, both known and both the cheaper half of the trade:
//
//   - A line that genuinely wrapped ACROSS one of the shapes above is broken anyway — a full-width
//     progress bar of block elements continuing into ` 57%`, a table of contents whose dot leaders run
//     past the last column, a box dash sitting in ordinary prose at exactly the wrap column. A row that
//     is full of block or rule characters is overwhelmingly the pending-wrap case rather than a wrap, so
//     the rule is kept and the rare loss accepted.
//   - A row that was painted SHORT after the stale flag was set is still welded, because a row that does
//     not reach the last column ends in the padding spaces this treats as ordinary text. That fails back
//     to the behaviour before this module, not to something worse.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // Box Drawing + Block Elements. A CLI paints its frame out of this range, and nothing that wraps as
  // ordinary text begins or ends with one.
  const DRAWING = /[─-▟]/;

  const lastCharOf = (row) => (row ? row[row.length - 1] : '');
  const firstCharOf = (row) => (row ? row[0] : '');

  /**
   * A row of nothing but one repeated non-alphanumeric character — `────`, `----`, `====`.
   *
   * The box-drawing test above misses a frame drawn in ASCII, and a separator row is what this whole
   * module exists for, so the question is asked twice.
   */
  function isRuleRow(row) {
    const s = String(row || '').trim();
    if (s.length < 8) return false;
    const c = s[0];
    if (/[\p{L}\p{N}\s]/u.test(c)) return false;
    for (let i = 1; i < s.length; i++) if (s[i] !== c) return false;
    return true;
  }

  /** Does `cur` read as the continuation of `prev`, or is the boundary a border? */
  function continuesLine(prev, cur) {
    if (!cur || !cur.isWrapped) return false;
    const above = String((prev && prev.row) || '');
    const below = String(cur.row || '');
    if (!above.trim()) return false;                 // a blank row continues into nothing
    if (isRuleRow(above) || isRuleRow(below)) return false;
    const left = lastCharOf(above);
    const right = firstCharOf(below);
    if (!left || !right) return false;
    if (DRAWING.test(left) || DRAWING.test(right)) return false;
    return true;
  }

  /**
   * Join the selected rows into clipboard text.
   *
   * `rows` are `{ text, isWrapped, row }`: the SELECTED part of the row, right-trimmed the way xterm
   * trims it; the row's wrap flag; and the row's full untrimmed contents — the last one is read only at
   * its two ends, and as a whole for the rule test.
   *
   * `trustFlagAlone` reproduces xterm's own rule. It is here so the caller can prove its reconstruction
   * matches what xterm produced before applying the repair on top of it.
   */
  function joinSelectionRows(rows, eol, trustFlagAlone) {
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      // xterm normalises the non-breaking spaces a TUI pads with; a copy that keeps them pastes
      // characters no editor shows and no search finds.
      const text = String(r.text || '').replace(/ /g, ' ');
      const join = i > 0 && (trustFlagAlone ? !!r.isWrapped : continuesLine(rows[i - 1], r));
      if (join) out[out.length - 1] += text;
      else out.push(text);
    }
    return out.join(eol);
  }

  const xtermSelectionText = (rows, eol) => joinSelectionRows(rows, eol, true);
  const repairedSelectionText = (rows, eol) => joinSelectionRows(rows, eol, false);

  /**
   * Read the rows the selection covers out of the live buffer.
   *
   * Returns null whenever the buffer cannot answer — an older xterm, a stubbed terminal in a test, a
   * selection that outran the scrollback. The caller then keeps whatever xterm said.
   */
  function readSelectedRows(terminal) {
    if (!terminal || typeof terminal.getSelectionPosition !== 'function') return null;
    const range = terminal.getSelectionPosition();
    if (!range || !range.start || !range.end) return null;
    const buffer = terminal.buffer && terminal.buffer.active;
    if (!buffer || typeof buffer.getLine !== 'function') return null;

    const cols = terminal.cols || undefined;
    const startY = range.start.y;
    const endY = range.end.y;
    if (!(endY >= startY)) return null;
    const rows = [];
    for (let y = startY; y <= endY; y++) {
      const line = buffer.getLine(y);
      if (!line || typeof line.translateToString !== 'function') return null;
      // The same slicing xterm does: the first row starts where the drag did, the last ends where it
      // ended (exclusive), and everything between is the whole row.
      const from = y === startY ? range.start.x : 0;
      const to = y === endY ? range.end.x : undefined;
      rows.push({
        text: line.translateToString(true, from, to),
        isWrapped: !!line.isWrapped,
        row: line.translateToString(false, 0, cols),
      });
    }
    return rows;
  }

  function defaultEol() {
    const platform = typeof window !== 'undefined' && window.api ? window.api.platform : '';
    return platform === 'win32' ? '\r\n' : '\n';
  }

  /**
   * The selection as clipboard text — `terminal.getSelection()` with the pending-wrap defect repaired.
   *
   * The repair is applied only after the reconstruction has been shown to reproduce xterm's own answer
   * for THIS selection. That check is what keeps the alt+drag column selection (a different slicing
   * that xterm exposes no flag for), a future xterm and every stubbed terminal on their existing
   * behaviour rather than on a rebuild that guessed.
   */
  function terminalSelectionText(terminal, eolOverride) {
    let native = '';
    try {
      native = terminal && typeof terminal.getSelection === 'function' ? terminal.getSelection() : '';
    } catch { return ''; }
    if (!native) return native;

    let rows = null;
    try { rows = readSelectedRows(terminal); } catch { rows = null; }
    if (!rows || !rows.length) return native;

    // Take the line ending from what xterm just produced, so the repaired text keeps it. Only a
    // selection that came back as a single line has none to take — and that is the case the defect
    // itself produces, hence the platform fallback.
    const eol = eolOverride
      || (native.includes('\r\n') ? '\r\n' : (native.includes('\n') ? '\n' : defaultEol()));

    if (xtermSelectionText(rows, eol) !== native) return native;
    return repairedSelectionText(rows, eol);
  }

  return {
    isRuleRow,
    continuesLine,
    joinSelectionRows,
    xtermSelectionText,
    repairedSelectionText,
    readSelectedRows,
    terminalSelectionText,
  };
});
