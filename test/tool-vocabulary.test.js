// #639 — the neutral words an agent's tools are mapped through, so no backend names another's tools.
//
// Both halves of every mapping must land on a word in `src/backends/tool-vocabulary.js`: a source's
// `agentDialect.toolWords` values here, a target's own table in the test for that target. A word that is
// in neither list would be a name one side invented, and the join between the two would silently drop it.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TOOL_WORDS, isToolWord } = require('../src/backends/tool-vocabulary');
const backends = require('../src/backends');

test('the vocabulary is a fixed list of distinct words', () => {
  assert.ok(Object.isFrozen(TOOL_WORDS));
  assert.equal(new Set(TOOL_WORDS).size, TOOL_WORDS.length);
  assert.equal(isToolWord('shell'), true);
  assert.equal(isToolWord('Bash'), false, 'a CLI\'s own tool name is not a word');
  assert.equal(isToolWord(undefined), false);
});

test('every source agent dialect maps its tool names onto words of the vocabulary', () => {
  const dialects = backends.list()
    .filter((b) => !b.isProfile)
    .map((b) => [b.id, backends.get(b.id).sharedResources])
    .filter(([, shared]) => shared && shared.agentDialect);
  assert.ok(dialects.length >= 1, 'at least one backend offers agents');
  for (const [id, shared] of dialects) {
    const words = Object.values(shared.agentDialect.toolWords || {});
    assert.ok(words.length, `${id} maps no tool at all`);
    for (const w of words) assert.ok(isToolWord(w), `${id} maps a tool onto "${w}", which is not in the vocabulary`);
    // An agent dialect is offered only with the agent directories it describes.
    assert.ok(shared.sources.some((s) => /agents/.test(s)), `${id} declares an agent dialect but offers no agent directory`);
  }
});
