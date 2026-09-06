'use strict';

// Where the trigger watcher looks, when nothing overrides it (#587).
//
// A trigger file is an instruction to type into a running session. Composed from `os.homedir()`, the
// directory belonged to the MACHINE rather than to the instance, so the installed app, a `npm start`
// dev run and an isolated demo run all watched one folder — whichever noticed a file first consumed
// it, and the other two never saw it. A demo run that promises to touch nothing real could execute a
// trigger meant for the real install.
//
// WHY A SOURCE CHECK: `start()` is the module's only export, and reaching the resolver through it means
// standing up an `fs.watch` on a real directory — which is what makes `test/trigger-watcher.test.js`
// the slowest file in the suite. What is being pinned here is one decision, not a behaviour: which
// variable the default is composed from, and that it is read per call rather than frozen at module
// load, because `main.js` sets `SWITCHBOARD_DATA_DIR` after this module can be required.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { stripComments } = require('./helpers/strip-comments');

const SRC = path.join(__dirname, '..', 'src', 'watch', 'trigger-watcher.js');
const CODE = stripComments(fs.readFileSync(SRC, 'utf8'));

test('the default triggers directory follows the data directory, not the home directory (#587)', () => {
  assert.match(CODE, /function defaultTriggersDir\(\)[\s\S]*?SWITCHBOARD_DATA_DIR/,
    'the default has to be composed from SWITCHBOARD_DATA_DIR, so a dev or demo instance keeps its '
    + 'triggers to itself');

  assert.match(CODE, /function defaultTriggersDir\(\)[\s\S]*?['"]triggers['"]/,
    'and it is still a `triggers` directory under it');

  assert.ok(!/const\s+DEFAULT_TRIGGERS_DIR\s*=/.test(CODE),
    'a module-level constant would freeze the answer before main.js sets SWITCHBOARD_DATA_DIR, which '
    + 'is the shape this fix exists to remove');
});

test('the env var still wins, and the packaged fallback is still the historical path (#587)', () => {
  assert.match(CODE, /process\.env\.SWITCHBOARD_TRIGGERS_DIR\s*\|\|\s*defaultTriggersDir\(\)/,
    'an explicit SWITCHBOARD_TRIGGERS_DIR overrides everything, as it always did');

  assert.match(CODE, /function defaultTriggersDir\(\)[\s\S]*?os\.homedir\(\)[\s\S]*?['"]\.switchboard['"]/,
    'a packaged app sets no data-dir variable, so it must keep reading ~/.switchboard/triggers — '
    + 'changing that would strand every trigger a harness already writes');
});

test('the stripper is doing its job, so a comment cannot satisfy these checks', () => {
  // A positive control: without it, a stripper that returned an empty string would let the two
  // "must not contain" assertions above pass while reading nothing at all.
  assert.ok(CODE.includes('getTriggersDir'), 'the stripped source must still hold the resolver');
  assert.ok(!CODE.includes('belongs to the instance that owns those sessions'),
    'the prose explaining the decision must be gone, or the check is reading the comment');
});
