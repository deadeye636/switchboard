'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  sessionTagName,
  sessionTagOptions,
  toggleSessionTag,
} = require('../public/session-tags-logic.js');

const defs = [
  { name: 'bug', color: '#e06c75', hidden: 0, disabled: 0 },
  { name: 'review', color: null, hidden: 0, disabled: 0 },
  { name: 'archived-idea', color: '#61afef', hidden: 0, disabled: 1 },
  { name: 'noisy', color: '#98c379', hidden: 1, disabled: 0 },
];

test('sessionTagName reads both a row and a plain name', () => {
  assert.strictEqual(sessionTagName({ tag: 'bug' }), 'bug');
  assert.strictEqual(sessionTagName('bug'), 'bug');
  assert.strictEqual(sessionTagName(null), '');
});

test('sessionTagOptions offers the catalogue and marks what is assigned', () => {
  const options = sessionTagOptions(defs, [{ tag: 'review' }]);
  assert.deepStrictEqual(options.map(o => o.name), ['bug', 'review', 'noisy']);
  assert.deepStrictEqual(options.map(o => o.assigned), [false, true, false]);
  assert.strictEqual(options[0].color, '#e06c75');
  assert.strictEqual(options[1].color, null);
});

test('sessionTagOptions drops disabled tags but keeps hidden ones', () => {
  const names = sessionTagOptions(defs, []).map(o => o.name);
  // disabled renders no chip anywhere, so assigning it would be invisible (#138)
  assert.ok(!names.includes('archived-idea'));
  // hidden only drops out of a filter bar — its chips still render
  assert.ok(names.includes('noisy'));
});

test('sessionTagOptions takes a selection of plain names too', () => {
  const options = sessionTagOptions(defs, ['bug']);
  assert.strictEqual(options.find(o => o.name === 'bug').assigned, true);
});

test('sessionTagOptions tolerates missing input', () => {
  assert.deepStrictEqual(sessionTagOptions(null, null), []);
  assert.deepStrictEqual(sessionTagOptions(undefined, undefined), []);
});

test('toggleSessionTag adds and removes', () => {
  assert.deepStrictEqual(toggleSessionTag([], 'bug'), ['bug']);
  assert.deepStrictEqual(toggleSessionTag(['bug'], 'review'), ['bug', 'review']);
  assert.deepStrictEqual(toggleSessionTag(['bug', 'review'], 'bug'), ['review']);
});

test('toggleSessionTag keeps a tag the picker never showed', () => {
  // 'archived-idea' is disabled, so it is not in the picker — but it IS assigned,
  // and the save replaces the whole set. Toggling something else must not drop it.
  const assigned = [{ tag: 'archived-idea' }, { tag: 'bug' }];
  assert.deepStrictEqual(toggleSessionTag(assigned, 'review'), ['archived-idea', 'bug', 'review']);
  assert.deepStrictEqual(toggleSessionTag(assigned, 'bug'), ['archived-idea']);
});

test('toggleSessionTag trims and ignores an empty name', () => {
  assert.deepStrictEqual(toggleSessionTag(['bug'], '  review '), ['bug', 'review']);
  assert.deepStrictEqual(toggleSessionTag(['bug'], '   '), ['bug']);
  assert.deepStrictEqual(toggleSessionTag(['bug'], null), ['bug']);
});

test('toggleSessionTag does not duplicate an existing tag', () => {
  assert.deepStrictEqual(toggleSessionTag(['bug', 'bug'], 'review'), ['bug', 'bug', 'review']);
  // toggling an existing one removes the first occurrence, so a repeated click settles
  assert.deepStrictEqual(toggleSessionTag(['bug'], 'bug'), []);
});
