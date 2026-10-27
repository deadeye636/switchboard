// src/shared/env-expand.js — the ${VAR} / ${VAR:-default} rule shared by every source of neutral MCP rows (#789).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { expand, references } = require('../src/shared/env-expand');

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

test('references finds what expand reports as missing, over a table', () => {
  const env = { SET: 'v', EMPTY: '' };
  const table = [
    ['${SET}', [{ name: 'SET', hasDefault: false }]],
    ['${NOPE}', [{ name: 'NOPE', hasDefault: false }]],
    ['${NOPE:-d}', [{ name: 'NOPE', hasDefault: true }]],
    ['${NOPE:-}', [{ name: 'NOPE', hasDefault: true }]],
    ['plain $HOME text ${}', []],
    ['a${A}b${B:-x}c${EMPTY}', [{ name: 'A', hasDefault: false }, { name: 'B', hasDefault: true }, { name: 'EMPTY', hasDefault: false }]],
    ['${NOPE:-${B}}', [{ name: 'NOPE', hasDefault: true }]],
    ['${{A}}', []],
  ];
  for (const [value, want] of table) {
    assert.deepEqual(references(value), want, value);
    const missing = new Set();
    expand(value, env, missing);
    const unset = references(value).filter((r) => !r.hasDefault && env[r.name] === undefined).map((r) => r.name);
    assert.deepEqual([...missing].sort(), [...new Set(unset)].sort(), value);
  }
});

test('references of a non-string is empty', () => {
  assert.deepEqual(references(undefined), []);
  assert.deepEqual(references(5), []);
  assert.deepEqual(references(null), []);
  assert.deepEqual(references(['${X}']), []);
});

// #794: on Windows a variable name is case-insensitive; a plain copy of the environment is not.
test('foldCase looks a name up case-insensitively, the exact spelling first; without it the lookup is exact', () => {
  const { lookupVar } = require('../src/shared/env-expand');
  const env = { Path: 'C:/bin', HOME: 'h', home: 'lower' };
  const missing = new Set();
  assert.equal(expand('${PATH}', env, missing, { foldCase: true }), 'C:/bin');
  assert.equal(missing.size, 0);
  assert.equal(expand('${home}', env, new Set(), { foldCase: true }), 'lower', 'an exact key wins over a folded one');
  assert.equal(expand('${PATH:-x}', env, new Set(), { foldCase: true }), 'C:/bin');
  const exact = new Set();
  assert.equal(expand('${PATH}', env, exact), '');
  assert.deepEqual([...exact], ['PATH'], 'no fold without the option');
  assert.equal(lookupVar(env, 'path', true), 'C:/bin');
  assert.equal(lookupVar(env, 'path', false), undefined);
  assert.equal(lookupVar(env, 'NOPE', true), undefined);
});
