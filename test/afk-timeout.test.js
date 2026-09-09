const test = require('node:test');
const assert = require('node:assert/strict');

const { afkTimeoutToEnvMs, resolveAfkTimeoutSec } = require('../src/app/terminal/afk-timeout');

// --- afkTimeoutToEnvMs ---

test('afkTimeoutToEnvMs: empty / nullish → null (the CLI decides)', () => {
  assert.equal(afkTimeoutToEnvMs(''), null);
  assert.equal(afkTimeoutToEnvMs(undefined), null);
  assert.equal(afkTimeoutToEnvMs(null), null);
});

test('afkTimeoutToEnvMs: seconds → milliseconds string', () => {
  assert.equal(afkTimeoutToEnvMs('120'), '120000');
  assert.equal(afkTimeoutToEnvMs(90), '90000');
});

// 0 means "do not auto-continue", and since #559 that is spelled by sending NO variable. Measured against
// CLI 2.1.266: the timer's enable gate asks whether `CLAUDE_AFK_TIMEOUT_MS` is defined at all, so a value
// its int reader accepts switches auto-continue on even where the setting says never — the old
// `2147483647` sentinel enabled the timer it was meant to disable, and overruled the CLI's own
// `askUserQuestionTimeout` to do it.
test('afkTimeoutToEnvMs: 0 → null (off is the absence of the variable)', () => {
  assert.equal(afkTimeoutToEnvMs('0'), null);
  assert.equal(afkTimeoutToEnvMs(0), null);
});

test('afkTimeoutToEnvMs: negative / non-numeric → null (invalid → the CLI decides)', () => {
  assert.equal(afkTimeoutToEnvMs('-5'), null);
  assert.equal(afkTimeoutToEnvMs('abc'), null);
  assert.equal(afkTimeoutToEnvMs('off'), null);
});

// --- resolveAfkTimeoutSec (cascade) ---

test('resolveAfkTimeoutSec: session override wins', () => {
  assert.equal(resolveAfkTimeoutSec('30', '120', '0'), '30');
});

test('resolveAfkTimeoutSec: empty session falls through to project, then global', () => {
  assert.equal(resolveAfkTimeoutSec('', '120', '0'), '120');
  assert.equal(resolveAfkTimeoutSec('', '', '0'), '0');
  assert.equal(resolveAfkTimeoutSec(undefined, null, '90'), '90');
});

// `0` and `''` both end at "send no variable", which is why they read as the same answer — and they are
// not. `0` wins its scope; `''` asks the next one. Without this the field's description says the wrong
// thing for the one case where it matters: a wider scope holding a positive value.
test('resolveAfkTimeoutSec: 0 switches it off at its scope, empty defers to the wider one', () => {
  assert.equal(resolveAfkTimeoutSec('0', '', '90'), '0');
  assert.equal(resolveAfkTimeoutSec('', '', '90'), '90');
  assert.equal(resolveAfkTimeoutSec('', '0', '90'), '0');
  // And what each of those then sends: nothing for the off answer, the wider value for the deferring one.
  assert.equal(afkTimeoutToEnvMs(resolveAfkTimeoutSec('0', '', '90')), null);
  assert.equal(afkTimeoutToEnvMs(resolveAfkTimeoutSec('', '', '90')), '90000');
});

test('resolveAfkTimeoutSec: nothing set → empty (inherit default)', () => {
  assert.equal(resolveAfkTimeoutSec('', '', ''), '');
  assert.equal(resolveAfkTimeoutSec(undefined, undefined, undefined), '');
});
