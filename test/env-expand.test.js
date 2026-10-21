// src/shared/env-expand.js — the ${VAR} / ${VAR:-default} rule shared by every source of neutral MCP rows (#789).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { expand } = require('../src/shared/env-expand');

test('${VAR} takes the value from the environment', () => {
  const missing = new Set();
  assert.equal(expand('a-${X}-b', { X: 'v' }, missing), 'a-v-b');
  assert.equal(expand('${X}${Y}', { X: '1', Y: '2' }, missing), '12');
  assert.equal(missing.size, 0);
});

test('a default is used when the variable is unset', () => {
  const missing = new Set();
  assert.equal(expand('${X:-fallback}', {}, missing), 'fallback');
  assert.equal(expand('${X:-}', {}, missing), '');
  assert.equal(expand('${X:-a b/c}', {}, missing), 'a b/c');
  assert.equal(missing.size, 0);
});

test('a default also replaces an EMPTY value, a set value wins over it', () => {
  const missing = new Set();
  assert.equal(expand('${X:-d}', { X: '' }, missing), 'd');
  assert.equal(expand('${X:-d}', { X: 'v' }, missing), 'v');
  assert.equal(missing.size, 0);
});

test('a bare reference to a set-but-empty variable is empty and not missing', () => {
  const missing = new Set();
  assert.equal(expand('x${X}y', { X: '' }, missing), 'xy');
  assert.equal(missing.size, 0);
});

test('a variable with no value and no default expands to empty and is reported', () => {
  const missing = new Set();
  assert.equal(expand('a${NOPE}b${ALSO}', {}, missing), 'ab');
  assert.deepEqual([...missing].sort(), ['ALSO', 'NOPE']);
});

test('text that is not a well-formed reference is left alone', () => {
  const missing = new Set();
  assert.equal(expand('plain $HOME text', { HOME: 'h' }, missing), 'plain $HOME text');
  assert.equal(expand('${}', {}, missing), '${}');
  assert.equal(expand('${1X}', {}, missing), '${1X}');
  assert.equal(expand('${X', { X: 'v' }, missing), '${X');
  assert.equal(expand('$${X}', { X: 'v' }, missing), '$v', 'no escape syntax: the inner reference still expands');
  assert.equal(missing.size, 0);
});

test('the default is not expanded again (no nesting)', () => {
  const missing = new Set();
  // The default stops at the first `}`: the reference ends there, its default is the text `${Y`, and the
  // last `}` stays literal.
  assert.equal(expand('${X:-${Y}}', { Y: 'v' }, missing), '${Y}');
});

test('a non-string is returned as it came', () => {
  const missing = new Set();
  assert.equal(expand(undefined, {}, missing), undefined);
  assert.equal(expand(5, {}, missing), 5);
  assert.equal(expand(null, {}, missing), null);
});
