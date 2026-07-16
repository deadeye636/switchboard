const test = require('node:test');
const assert = require('node:assert/strict');

const { afkTimeoutToEnvMs, resolveAfkTimeoutSec, normalizeAfkInput } = require('../src/app/terminal/afk-timeout');

// --- afkTimeoutToEnvMs ---

test('afkTimeoutToEnvMs: empty / nullish → null (Claude default)', () => {
  assert.equal(afkTimeoutToEnvMs(''), null);
  assert.equal(afkTimeoutToEnvMs(undefined), null);
  assert.equal(afkTimeoutToEnvMs(null), null);
});

test('afkTimeoutToEnvMs: seconds → milliseconds string', () => {
  assert.equal(afkTimeoutToEnvMs('120'), '120000');
  assert.equal(afkTimeoutToEnvMs(90), '90000');
});

test('afkTimeoutToEnvMs: 0 → max int (off / never)', () => {
  assert.equal(afkTimeoutToEnvMs('0'), '2147483647');
  assert.equal(afkTimeoutToEnvMs(0), '2147483647');
});

test('afkTimeoutToEnvMs: negative / non-numeric → null (invalid → default)', () => {
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

test('resolveAfkTimeoutSec: nothing set → empty (inherit default)', () => {
  assert.equal(resolveAfkTimeoutSec('', '', ''), '');
  assert.equal(resolveAfkTimeoutSec(undefined, undefined, undefined), '');
});

// --- normalizeAfkInput ---

test('normalizeAfkInput: trims, keeps 0 (=off), floors seconds, drops invalid', () => {
  assert.equal(normalizeAfkInput('  120 '), '120');
  assert.equal(normalizeAfkInput('90.7'), '90');
  assert.equal(normalizeAfkInput('0'), '0');
  assert.equal(normalizeAfkInput(''), '');
  assert.equal(normalizeAfkInput('-3'), '');
  assert.equal(normalizeAfkInput('xyz'), '');
});
