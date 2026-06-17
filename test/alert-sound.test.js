const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_NEXT_ATTENTION_BINDING,
  shouldPlayAttentionSound,
  isNextAttentionKey,
} = require('../public/alert-sound');

test('plays the cue when a session newly enters attention and sound is enabled', () => {
  assert.equal(
    shouldPlayAttentionSound({
      prev: new Set(),
      next: new Set(['s1']),
      settings: { sound: true },
    }),
    true
  );
});

test('does not play when the attention set is unchanged (already in set)', () => {
  assert.equal(
    shouldPlayAttentionSound({
      prev: new Set(['s1']),
      next: new Set(['s1']),
      settings: { sound: true },
    }),
    false
  );
});

test('does not play for a ready session (not present in the attention set)', () => {
  // A response-ready transition never adds to the attention set, so prev === next.
  assert.equal(
    shouldPlayAttentionSound({
      prev: new Set(['s1']),
      next: new Set(['s1']),
      settings: { sound: true },
    }),
    false
  );
});

test('does not play when sound is disabled, even on new attention', () => {
  assert.equal(
    shouldPlayAttentionSound({
      prev: new Set(),
      next: new Set(['s1']),
      settings: { sound: false },
    }),
    false
  );
});

test('does not play when settings are missing', () => {
  assert.equal(shouldPlayAttentionSound({ prev: [], next: ['s1'] }), false);
});

test('accepts arrays as well as Sets for prev/next', () => {
  assert.equal(
    shouldPlayAttentionSound({ prev: ['s1'], next: ['s1', 's2'], settings: { sound: true } }),
    true
  );
});

test('isNextAttentionKey matches the default Cmd/Ctrl+Shift+A binding', () => {
  assert.equal(isNextAttentionKey({ metaKey: true, shiftKey: true, key: 'a' }), true);
  assert.equal(isNextAttentionKey({ ctrlKey: true, shiftKey: true, key: 'A' }), true);
  // macOS reports key as 'a' but code is reliable when modifiers rewrite the key
  assert.equal(isNextAttentionKey({ metaKey: true, shiftKey: true, code: 'KeyA' }), true);
});

test('isNextAttentionKey rejects near-misses', () => {
  assert.equal(isNextAttentionKey({ metaKey: true, key: 'a' }), false); // no shift
  assert.equal(isNextAttentionKey({ shiftKey: true, key: 'a' }), false); // no mod
  assert.equal(isNextAttentionKey({ metaKey: true, shiftKey: true, altKey: true, key: 'a' }), false); // alt
  assert.equal(isNextAttentionKey({ metaKey: true, shiftKey: true, key: 'g' }), false); // wrong key
  assert.equal(isNextAttentionKey(null), false);
});

test('isNextAttentionKey honours a custom binding override', () => {
  const binding = { key: 'j', mod: true, shift: false, alt: false };
  assert.equal(isNextAttentionKey({ ctrlKey: true, key: 'j' }, binding), true);
  assert.equal(isNextAttentionKey({ ctrlKey: true, shiftKey: true, key: 'j' }, binding), false);
  assert.equal(isNextAttentionKey({ metaKey: true, shiftKey: true, key: 'a' }, binding), false);
});

test('exports a sane default binding', () => {
  assert.deepEqual(DEFAULT_NEXT_ATTENTION_BINDING, { key: 'a', mod: true, shift: true, alt: false });
});
