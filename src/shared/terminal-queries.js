// --- Terminal queries in REPLAYED output (#887) ---
//
// A CLI asks its terminal questions by writing them to stdout: its colours (OSC 10/11/12, OSC 4), its device
// attributes (DA1/DA2), the cursor position and status (DSR), a mode (DECRQM), a setting (DECRQSS). xterm.js answers
// each one through `onData`, and the answer goes back to the PTY like a keystroke. That is right the first time, when
// the CLI is waiting for it.
//
// Output this app writes into xterm a SECOND time is not asked again by anyone. The main process replays a session's
// buffered output when a view reattaches (`src/app/terminal/spawn.js`), and xterm had already answered those queries
// live in the view that went away. Without this module xterm answered them again, into the live CLI, which was no
// longer waiting: measured with Codex, a reattach left `[?1;2c]10;rgb:…]11;rgb:…` in its composer (the ESC bytes
// lost on the way in), and an Enter sent it as a turn.
//
// The renderer's hidden-tab drain (`drainReplayBuffer` in `src/renderer/terminal/terminal-manager.js`) writes output
// that NO xterm has seen yet (live render off, a grid card out of view). Its queries were never answered, and after
// this module they never are: a CLI that asked shortly before the reveal and still waits gets no reply and falls back
// on its own timeout (prompt_toolkit's cursor-position query, for one). Answering late was the worse of the two: a
// late answer is typed text to a CLI that stopped waiting. A query cut across the moment the tab hid (its head
// written live, its tail buffered) completes in xterm's parser at the drain and is still answered late; this module
// cannot see it.
//
// Only questions are taken out: a sequence that SETS a colour or a mode is not touched, because the screen must still
// look the way the CLI drew it. An OSC colour sequence that mixes setting and asking (`OSC 10;red;?`) is left alone
// too, so its query part is still answered on replay: a known gap, rare enough not to parse slot by slot.
//
// THE LIST COVERS what xterm.js answers (its report paths in `@xterm/xterm` 6.0.0, read): DA1 and DA2 on a zero first
// parameter, DSR 5 and 6 and private DSR 6, DECRQM in both forms, OSC 4/10/11/12 asking, DECRQSS. It removes a little
// more than that on purpose, so a newer xterm that learns them is covered: DA3 (`CSI = c`), XTVERSION (`CSI > q`) and
// OSC 13-19 asking. A request xterm learns to answer that is not here comes back as stray input after a reattach.
// `test/terminal-queries.test.js` asserts each shape is removed and the setting forms are kept.
'use strict';

// One alternation, one pass. A lone ESC written right before a query still joins the text after it once the query is
// gone (`ESC` + query + `[31m` becomes SGR 31): contrived, no CLI writes it, and left as it is.
const TERMINAL_QUERY = new RegExp([
  // OSC 10-19 with every slot asking, OSC 4 with every pair asking; ended by BEL or ST.
  '\\x1b\\](?:1[0-9](?:;\\?)+|4(?:;\\d+;\\?)+)(?:\\x07|\\x1b\\\\)',
  // DA1 / DA2 / DA3 with a zero (or no) first parameter: `CSI c`, `CSI 0c`, `CSI 0;1c`, `CSI > c`, `CSI = c`.
  '\\x1b\\[[>=]?0*(?:;\\d*)*c',
  // DSR status / cursor position, private DSR 6: `CSI 5n`, `CSI 6n`, `CSI 05n`, `CSI ? 6n`.
  '\\x1b\\[0*[56](?:;\\d*)*n',
  '\\x1b\\[\\?0*6(?:;\\d*)*n',
  // DECRQM, ANSI and private: `CSI 4 $ p`, `CSI ? 2026 $ p`.
  '\\x1b\\[\\??\\d+\\$p',
  // XTVERSION: `CSI > q`, `CSI > 0 q`.
  '\\x1b\\[>0?q',
  // DECRQSS: `DCS $ q <setting> ST`.
  '\\x1bP\\$q[^\\x1b\\x07]*(?:\\x07|\\x1b\\\\)',
].join('|'), 'g');

/** `text` without the terminal queries in it, for output that is written into a terminal again. */
function stripTerminalQueries(text) {
  if (typeof text !== 'string' || text.indexOf('\x1b') === -1) return text;
  return text.replace(TERMINAL_QUERY, '');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { stripTerminalQueries };
}
