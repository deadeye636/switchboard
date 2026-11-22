'use strict';
// #887: output written into xterm a second time loses its terminal QUERIES, so xterm does not answer them again into a
// CLI that stopped waiting. `src/shared/terminal-queries.js` is the one function; both replay paths call it.
//
// The query shapes below are the ones xterm.js answers; the setting shapes beside them must survive, or a replayed
// screen stops looking the way the CLI drew it. And the two call sites are pinned by reading their source, because
// neither can be reached without Electron and a PTY.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTerminalQueries } = require('../src/shared/terminal-queries');
const { stripComments } = require('./helpers/strip-comments');

const ESC = '\x1b';
const ST = `${ESC}\\`;
const BEL = '\x07';

const QUERIES = {
  'OSC 10 fg, ST': `${ESC}]10;?${ST}`,
  'OSC 11 bg, BEL': `${ESC}]11;?${BEL}`,
  'OSC 12 cursor': `${ESC}]12;?${ST}`,
  'OSC 4 palette entry': `${ESC}]4;3;?${ST}`,
  'DA1 bare': `${ESC}[c`,
  'DA1 with 0': `${ESC}[0c`,
  'DA2': `${ESC}[>c`,
  'DA2 with 0': `${ESC}[>0c`,
  'DA3': `${ESC}[=c`,
  'DSR status': `${ESC}[5n`,
  'DSR cursor position': `${ESC}[6n`,
  'DECXCPR': `${ESC}[?6n`,
  'DECRQM private': `${ESC}[?2026$p`,
  'DECRQM ansi': `${ESC}[4$p`,
  'XTVERSION': `${ESC}[>0q`,
  'DECRQSS': `${ESC}P$qm${ST}`,
  'OSC 10 two slots (fg and bg)': `${ESC}]10;?;?${BEL}`,
  'OSC 4 two pairs': `${ESC}]4;1;?;2;?${ST}`,
  'DA1 zero-padded': `${ESC}[00c`,
  'DA1 with a second parameter': `${ESC}[0;1c`,
  'DA2 with a second parameter': `${ESC}[>0;1c`,
  'DSR zero-padded': `${ESC}[05n`,
  'DSR with a second parameter': `${ESC}[6;0n`,
};

const KEPT = {
  'OSC 10 set': `${ESC}]10;rgb:ffff/0000/0000${ST}`,
  'OSC 11 set': `${ESC}]11;#202020${BEL}`,
  'OSC 4 set': `${ESC}]4;3;rgb:00/ff/00${ST}`,
  'OSC 0 title': `${ESC}]0;title${BEL}`,
  'SGR colour': `${ESC}[31m`,
  'alt screen on': `${ESC}[?1049h`,
  'DECSET sync': `${ESC}[?2026h`,
  'cursor up': `${ESC}[3A`,
  'erase in display': `${ESC}[2J`,
  'DA1 REPLY (not a query)': `${ESC}[?1;2c`,
  'CPR REPLY (not a query)': `${ESC}[12;40R`,
  'DA1 with a non-zero first parameter (xterm does not answer)': `${ESC}[1c`,
  'OSC 10 mixing set and ask (known gap, left whole)': `${ESC}]10;red;?${BEL}`,
};

for (const [name, seq] of Object.entries(QUERIES)) {
  test(`a query is taken out: ${name}`, () => {
    assert.equal(stripTerminalQueries(`a${seq}b`), 'ab');
  });
}

for (const [name, seq] of Object.entries(KEPT)) {
  test(`a sequence that is not a query stays: ${name}`, () => {
    assert.equal(stripTerminalQueries(`a${seq}b`), `a${seq}b`);
  });
}

test('the startup shape Codex sends (two colour queries in one chunk) leaves the rest of the screen intact', () => {
  const chunk = `${ESC}[?2004h${ESC}]10;?${ESC}\\${ESC}]11;?${ESC}\\${ESC}[c>_ OpenAI Codex`;
  assert.equal(stripTerminalQueries(chunk), `${ESC}[?2004h>_ OpenAI Codex`);
});

test('a query cut across two buffered chunks is found once the chunks are joined, as both replay paths do', () => {
  const chunks = ['before', `${ESC}]1`, `1;?${ST}after`];
  assert.equal(stripTerminalQueries(chunks.join('')), 'beforeafter');
});

test('queries between text are removed without touching the text around them', () => {
  assert.equal(stripTerminalQueries(`x${ESC}]10;?${BEL}y${ESC}[6nz`), 'xyz');
});

test('text without ESC comes back as the same string, and a non-string is passed through', () => {
  const s = 'plain text';
  assert.equal(stripTerminalQueries(s), s);
  assert.equal(stripTerminalQueries(''), '');
  assert.equal(stripTerminalQueries(undefined), undefined);
});

// The two seams. A source check, because the main reattach needs a live PTY and the drain needs xterm: it pins the
// regression that will actually happen, which is somebody going back to a per-chunk loop or a bare join.
test('both replay paths strip the queries before writing', () => {
  const spawn = stripComments(fs.readFileSync(path.join(__dirname, '../src/app/terminal/spawn.js'), 'utf8'));
  assert.match(spawn, /stripTerminalQueries\(session\.outputBuffer\.join\(''\)\)/);
  assert.doesNotMatch(spawn, /for \(const chunk of session\.outputBuffer\)/);
  const manager = stripComments(fs.readFileSync(path.join(__dirname, '../src/renderer/terminal/terminal-manager.js'), 'utf8'));
  assert.match(manager, /const data = stripTerminalQueries\(arr\.join\(''\)\);/);
});
