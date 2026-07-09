'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { decideOsc94 } = require('../osc-busy.js');

test('progress levels latch busy when no hooks are registered', () => {
  for (const level of ['1', '2', '3']) {
    assert.strictEqual(decideOsc94(level, { cliBusy: false, hooksEnabled: false }), 'set');
  }
});

test('progress levels are ignored while already busy (no duplicate edge)', () => {
  assert.strictEqual(decideOsc94('3', { cliBusy: true, busySource: 'osc94', hooksEnabled: false }), 'ignore');
});

test('with hooks enabled a progress sequence never sets busy (#120)', () => {
  // UserPromptSubmit/Stop bracket the turn. A TUI dialog emits progress without a
  // turn, which is exactly what latched busy with no way to clear it.
  for (const level of ['1', '2', '3']) {
    assert.strictEqual(decideOsc94(level, { cliBusy: false, hooksEnabled: true }), 'ignore');
  }
});

test('4;0 releases a latch this module set', () => {
  assert.strictEqual(decideOsc94('0', { cliBusy: true, busySource: 'osc94' }), 'clear');
});

test('4;0 heals a stale latch even once hooks are enabled', () => {
  assert.strictEqual(decideOsc94('0', { cliBusy: true, busySource: 'osc94', hooksEnabled: true }), 'clear');
});

test('4;0 never clears a busy state it did not establish', () => {
  // OSC 0 is self-clearing via its idle glyph; a hook-driven turn ends on Stop.
  assert.strictEqual(decideOsc94('0', { cliBusy: true, busySource: 'osc0' }), 'ignore');
  assert.strictEqual(decideOsc94('0', { cliBusy: true, busySource: null }), 'ignore');
});

test('4;0 on an idle session is a no-op', () => {
  assert.strictEqual(decideOsc94('0', { cliBusy: false, busySource: null }), 'ignore');
});

test('unknown levels and missing state are ignored', () => {
  assert.strictEqual(decideOsc94('7', { cliBusy: false }), 'ignore');
  assert.strictEqual(decideOsc94(undefined, {}), 'ignore');
  assert.strictEqual(decideOsc94('1'), 'set');
});
