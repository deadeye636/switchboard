'use strict';
// Bare PageUp/PageDown should be a Switchboard terminal shortcut, not a per-backend TUI accident.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'terminal', 'terminal-manager.js'), 'utf8');

test('bare PageUp/PageDown scroll the terminal viewport, not the PTY', () => {
  assert.match(SRC, /e\.key === 'PageUp' \|\| e\.key === 'PageDown'/,
    'the terminal key handler must recognise both page keys');
  assert.match(SRC, /!e\.shiftKey && !e\.ctrlKey && !e\.altKey && !e\.metaKey/,
    'only bare page keys should be intercepted; modifier chords keep their existing behaviour');
  assert.match(SRC, /terminal\.scrollPages\(e\.key === 'PageUp' \? -1 : 1\)/,
    'PageUp scrolls up and PageDown scrolls down through xterm');
  assert.match(SRC, /return false;\n    }\n\n    \/\/ Shift\+Enter/s,
    'the page keys are swallowed before xterm can forward them to the backend process');
});
