// #635 — the neutral words a hook's MOMENT is mapped through, so no backend names another's events.
//
// The same guard `tool-vocabulary.test.js` is for tools, one concept along: a source maps its own event
// names onto these words, a target declares which of its own events is each word, and a word in neither
// list would be a name one side invented — the join between the two would then silently drop the hook.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { HOOK_EVENT_WORDS, isHookEventWord } = require('../src/backends/hook-events');
const { EVENT_WORDS } = require('../src/backends/claude/hooks-config');
const { EVENT_FOR_WORD, WORD_FOR_TOOL } = require('../src/backends/pi/hooks-section');
const { isToolWord } = require('../src/backends/tool-vocabulary');
const backends = require('../src/backends');

test('the vocabulary is a fixed list of distinct words', () => {
  assert.ok(Object.isFrozen(HOOK_EVENT_WORDS));
  assert.equal(new Set(HOOK_EVENT_WORDS).size, HOOK_EVENT_WORDS.length);
  assert.equal(isHookEventWord('agent-idle'), true);
  assert.equal(isHookEventWord('Stop'), false, 'a CLI\'s own event name is not a word');
  assert.equal(isHookEventWord('agent_settled'), false, 'and neither is the other CLI\'s');
  assert.equal(isHookEventWord(undefined), false);
});

test('every source maps its own event names onto words of the vocabulary', () => {
  for (const word of Object.values(EVENT_WORDS)) {
    assert.ok(isHookEventWord(word), `a source maps an event onto "${word}", which is not in the vocabulary`);
  }
  assert.ok(Object.keys(EVENT_WORDS).length, 'the source maps something');
});

test('every target answers each word with one of its own events, and no word is left unanswered', () => {
  for (const word of Object.keys(EVENT_FOR_WORD)) {
    assert.ok(isHookEventWord(word), `the target answers "${word}", which is not in the vocabulary`);
  }
  // Unlike the tool vocabulary, a word nothing answers would be a moment the core hands over and the
  // target then drops — visible only as a hook that never fires, which is this feature's worst failure.
  for (const word of HOOK_EVENT_WORDS) {
    assert.ok(EVENT_FOR_WORD[word], `nothing answers "${word}", so a hook on it would be taken and never run`);
  }
});

test('a source that declares a hook dialect names every word it can produce', () => {
  const dialects = backends.list()
    .filter((b) => !b.isProfile)
    .map((b) => [b.id, backends.get(b.id).sharedResources])
    .filter(([, shared]) => shared && shared.hookDialect);
  assert.ok(dialects.length >= 1, 'at least one backend offers hooks');
  for (const [id, shared] of dialects) {
    const names = shared.hookDialect.eventNames || {};
    for (const word of Object.values(EVENT_WORDS)) {
      assert.ok(names[word], `${id} can produce "${word}" but its dialect has no name to put in the payload`);
    }
    for (const word of Object.keys(names)) {
      assert.ok(isHookEventWord(word), `${id} names "${word}", which is not in the vocabulary`);
    }
    assert.ok(typeof backends.get(id).listSharedHooks === 'function', `${id} declares a hook dialect but answers no hooks`);
  }
});

test('the target maps its own tool names onto the tool vocabulary, for a matcher to be compared against', () => {
  const words = Object.values(WORD_FOR_TOOL);
  assert.ok(words.length);
  for (const w of words) assert.ok(isToolWord(w), `the target maps a tool onto "${w}", which is not in the vocabulary`);
});
