'use strict';
// The alternate-screen tracker, and the one thing the app does with its answer (#561).
//
// `src/app/terminal/spawn.js` used to decide which screen buffer a CLI was on by running `includes()`
// over each raw PTY chunk. ConPTY hands a TUI's output over in small reads and cuts them wherever it
// likes, so a six- or eight-byte escape sequence split across two reads matched neither half and the
// transition was simply never seen. Nothing recovered it: the flag then kept whatever it last said for
// the life of the session, and on reattach the app ACTS on that flag — a stale `true` forces a freshly
// mounted xterm into the alternate screen for a CLI that has left it.
//
// The PTY has no seam a test can reach (node-pty is required at module load), so the boundary cases run
// against `scanAltScreen`, which is the function the onData handler calls. The reattach decision is
// exercised through `openTerminal` for real.
const test = require('node:test');
const assert = require('node:assert/strict');

const spawn = require('../src/app/terminal/spawn');

const ESC = '\x1b';
const ENTER_1049 = `${ESC}[?1049h`;
const LEAVE_1049 = `${ESC}[?1049l`;
const ENTER_47 = `${ESC}[?47h`;
const LEAVE_47 = `${ESC}[?47l`;

const SEQUENCES = [
  { name: '?1049h (enter, modern)', seq: ENTER_1049, expected: true },
  { name: '?1049l (leave, modern)', seq: LEAVE_1049, expected: false },
  { name: '?47h (enter, legacy)', seq: ENTER_47, expected: true },
  { name: '?47l (leave, legacy)', seq: LEAVE_47, expected: false },
];

/** Feed chunks through the tracker the way the onData handler does, and report the final flag. */
function track(chunks, start = null) {
  let state = start;
  let carry = '';
  for (const chunk of chunks) {
    const r = spawn.scanAltScreen(carry, chunk);
    carry = r.carry;
    if (r.altScreen !== null) state = r.altScreen;
  }
  return state;
}

// The acceptance bullet, at every byte position rather than at one convenient one: a boundary after the
// ESC, after the `[`, mid-parameter, and immediately before the final letter are four different ways for
// a substring search to miss, and only the last of them is obvious.
test('a sequence cut at ANY interior byte is still detected', () => {
  for (const { name, seq, expected } of SEQUENCES) {
    for (let cut = 1; cut < seq.length; cut++) {
      const chunks = [seq.slice(0, cut), seq.slice(cut)];
      assert.equal(track(chunks), expected,
        `${name} split after byte ${cut} of ${seq.length}`);
    }
  }
});

// The same, with the ordinary output a TUI actually surrounds its mode switches with. Without it the
// carry could be "the whole previous chunk" and still pass the test above.
test('a sequence cut at any interior byte is detected between real output', () => {
  for (const { name, seq, expected } of SEQUENCES) {
    for (let cut = 1; cut < seq.length; cut++) {
      const chunks = [
        `some output\r\n${seq.slice(0, cut)}`,
        `${seq.slice(cut)}${ESC}[2J${ESC}[H drawing`,
      ];
      assert.equal(track(chunks), expected,
        `${name} split after byte ${cut} of ${seq.length}, padded`);
    }
  }
});

// ConPTY reads have been measured as low as five bytes, which is shorter than every sequence here.
test('a sequence dribbled in one byte at a time is detected', () => {
  for (const { name, seq, expected } of SEQUENCES) {
    assert.equal(track(seq.split('')), expected, `${name}, one byte per chunk`);
  }
});

// The observation in #561: the CLI entered the alternate screen and left it again, and only the EXIT was
// missed. That is the direction that hurts, because the flag is then stuck at true.
test('an enter seen whole and a leave split across the boundary still ends OFF', () => {
  for (let cut = 1; cut < LEAVE_1049.length; cut++) {
    const chunks = [
      `${ENTER_1049}full screen frame`,
      `more frames${LEAVE_1049.slice(0, cut)}`,
      `${LEAVE_1049.slice(cut)}back to the prompt`,
    ];
    assert.equal(track(chunks), false, `leave split after byte ${cut}`);
  }
});

// The carry is the tail of the previous SCAN, not of the previous raw chunk, so it rolls forward and a
// sequence spread over three or more reads is still whole somewhere.
test('a sequence spread over three chunks is detected', () => {
  assert.equal(track([`${ESC}[?1`, '04', '9h']), true, 'enter in three pieces');
  assert.equal(track([`${ESC}[?10`, '4', '9l']), false, 'leave in three pieces');
});

// The predecessor applied "on" and then "off" unconditionally, so whichever came LAST in the chunk lost.
test('the last transition in a chunk wins, not the one that is checked last', () => {
  assert.equal(track([`${LEAVE_1049}prompt${ENTER_1049}`]), true,
    'leave then enter ends ON');
  assert.equal(track([`${ENTER_1049}frame${LEAVE_1049}`]), false,
    'enter then leave ends OFF');
});

// With a naive `carry + chunk` scan the carried bytes are read a second time, so a transition that sat
// in the carry can overrule the one that just arrived.
test('a transition already answered in the carry does not overrule the next one', () => {
  assert.equal(track([`padding${LEAVE_1049}`, ENTER_1049]), true,
    'the leave was answered on the previous chunk; the enter is the current answer');
  assert.equal(track([`padding${ENTER_1049}`, LEAVE_1049]), false,
    'and the same in the other direction');
});

// A property rather than a hand-picked example. The reference is a DIFFERENT implementation on purpose
// — one scan of the whole stream, no chunks and no carry at all — so it cannot share a bug with the
// thing it checks. What it catches is a carry rule that drops a transition or answers one twice, and
// neither of those shows up reliably in cases a person thought to write down.
test('any three-way split agrees with a scan of the undivided stream', () => {
  const whole = (stream) => {
    let end = -1;
    let state = null;
    for (const { seq, expected } of SEQUENCES) {
      const at = stream.lastIndexOf(seq);
      if (at >= 0 && at + seq.length - 1 > end) { end = at + seq.length - 1; state = expected; }
    }
    return state;
  };
  const streams = [
    `a${ENTER_1049}bb${LEAVE_1049}c`,
    `${ENTER_47}x${ENTER_1049}`,
    `${LEAVE_1049}${ENTER_1049}`,
    `${ENTER_1049}${LEAVE_47}`,
    `q${LEAVE_47}q${ENTER_47}`,
  ];
  const mismatches = [];
  let checked = 0;
  for (const stream of streams) {
    for (let i = 1; i < stream.length; i++) {
      for (let j = i + 1; j < stream.length; j++) {
        checked++;
        const chunks = [stream.slice(0, i), stream.slice(i, j), stream.slice(j)];
        if (track(chunks) !== whole(stream)) mismatches.push(JSON.stringify(chunks));
      }
    }
  }
  assert.equal(mismatches.length, 0,
    `${mismatches.length} of ${checked} three-way splits disagreed, first: ${mismatches[0]}`);
});

test('a chunk with no transition leaves the flag where it was', () => {
  assert.equal(track(['plain output', `${ESC}[32mcoloured${ESC}[0m`], true), true,
    'a true flag survives');
  assert.equal(track([`${ESC}[?25l`, `${ESC}[?1000h`], true), true,
    'other private modes are not screen-buffer switches');
  assert.equal(spawn.scanAltScreen('', 'nothing here').altScreen, null,
    'and the scan reports "no transition" rather than a state');
});

test('the carry never grows past what a split sequence needs', () => {
  const long = 'x'.repeat(5000);
  assert.equal(spawn.scanAltScreen('', long).carry.length, 7,
    'seven bytes: one less than the longest sequence');
  assert.equal(spawn.scanAltScreen('abcdefg', 'z').carry, 'bcdefgz',
    'and it is the tail of carry+chunk, so it rolls forward');
});

// --- What the replay says -------------------------------------------------------------------------

test('the replay buffer is read with the same boundary tolerance', () => {
  assert.equal(spawn.altScreenFromReplay([]), null, 'an empty buffer says nothing');
  assert.equal(spawn.altScreenFromReplay(['hello', 'world']), null, 'nor does one with no sequence');
  assert.equal(spawn.altScreenFromReplay([`a${ENTER_1049}`, 'b']), true, 'an enter that is whole');
  assert.equal(spawn.altScreenFromReplay([`a${ENTER_1049}`, `b${LEAVE_1049}`]), false,
    'the LAST transition in the buffer is the one xterm ends on');
  assert.equal(spawn.altScreenFromReplay([`a${ESC}[?10`, `49l b`]), false,
    'a transition split across two buffer entries');
});

// --- The reattach decision ------------------------------------------------------------------------

// A minimal ctx: the reattach branch returns before anything else in the file is reached.
function setup(sessions) {
  const sent = [];
  const ctx = {
    sent,
    activeSessions: new Map(sessions),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } }),
    getAppQuitting: () => false,
    ensureProjectAdded: () => {},
    log: { info() {}, warn() {}, error() {}, silly() {} },
  };
  spawn.init(ctx);
  return ctx;
}

const replayed = (ctx) => ctx.sent.filter((a) => a[0] === 'terminal-data').map((a) => a[2]);

// The acceptance bullet that is about consequences: forcing the alternate screen on a session that is
// not in it is worse than leaving one that is in it to the replayed output. So where the bytes about to
// be replayed disagree with the flag, the bytes win and nothing is injected.
test('a stale alt-screen flag is NOT injected when the replay says the session left it', async () => {
  const session = {
    exited: false, isPlainTerminal: false, altScreen: true, mcpServer: null,
    outputBuffer: [`${ENTER_1049}a frame`, `and another${LEAVE_1049}`, 'back at the prompt'],
  };
  const ctx = setup([['s', session]]);

  const r = await spawn.openTerminal('s', process.cwd(), false, {});
  assert.equal(r.reattached, true);
  assert.equal(replayed(ctx)[0], `${ENTER_1049}a frame`,
    'the replay starts immediately — no injected escape in front of it');
  assert.equal(replayed(ctx).includes(ENTER_1049), false,
    'and the enter sequence was never sent on its own');
});

test('a leave split across two buffer entries also suppresses the injection', async () => {
  const session = {
    exited: false, isPlainTerminal: false, altScreen: true, mcpServer: null,
    outputBuffer: [`${ENTER_1049}a frame`, `and another${ESC}[?104`, '9l back at the prompt'],
  };
  const ctx = setup([['s', session]]);

  await spawn.openTerminal('s', process.cwd(), false, {});
  assert.equal(replayed(ctx)[0], `${ENTER_1049}a frame`, 'nothing was injected in front of the replay');
});

// The other half of the same bullet: the injection is not removed on a guess. Where the buffer says
// nothing — the case it exists for, a transition that has scrolled out of the ring buffer — the flag
// still decides, exactly as it did before.
test('a buffer that carries no transition leaves the flag in charge', async () => {
  const session = {
    exited: false, isPlainTerminal: false, altScreen: true, mcpServer: null,
    outputBuffer: ['a frame', 'and another'],
  };
  const ctx = setup([['s', session]]);

  await spawn.openTerminal('s', process.cwd(), false, {});
  assert.deepEqual(replayed(ctx), [ENTER_1049, 'a frame', 'and another', `${ESC}[?25l`],
    'injected, then the buffer, then the cursor hide');
});

test('a session that never entered the alternate screen is never put into it', async () => {
  const session = {
    exited: false, isPlainTerminal: false, altScreen: false, mcpServer: null,
    outputBuffer: ['plain output'],
  };
  const ctx = setup([['s', session]]);

  await spawn.openTerminal('s', process.cwd(), false, {});
  assert.deepEqual(replayed(ctx), ['plain output', `${ESC}[?25l`]);
});

test('a plain terminal is never put into the alternate screen either', async () => {
  const session = {
    exited: false, isPlainTerminal: true, altScreen: true, mcpServer: null,
    outputBuffer: ['shell output'],
  };
  const ctx = setup([['s', session]]);

  await spawn.openTerminal('s', process.cwd(), false, {});
  assert.deepEqual(replayed(ctx), ['shell output'], 'no injection and no cursor hide');
});
