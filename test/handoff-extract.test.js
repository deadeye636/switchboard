const { test } = require('node:test');
const assert = require('node:assert');
const { extractLatestAssistantText } = require('../public/handoff-extract.js');

test('returns the latest assistant text (string content)', () => {
  const entries = [
    { type: 'user', message: { content: 'hi' } },
    { type: 'assistant', message: { content: 'first' } },
    { type: 'assistant', message: { content: 'latest' } },
  ];
  assert.strictEqual(extractLatestAssistantText(entries), 'latest');
});

test('joins text blocks from array content, ignoring non-text blocks', () => {
  const entries = [
    { type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'x' },
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
    ] } },
  ];
  assert.strictEqual(extractLatestAssistantText(entries), 'Hello world');
});

test('skips trailing non-assistant entries', () => {
  const entries = [
    { type: 'assistant', message: { content: 'packet' } },
    { type: 'user', message: { content: 'thanks' } },
  ];
  assert.strictEqual(extractLatestAssistantText(entries), 'packet');
});

test('tolerates malformed / empty input', () => {
  assert.strictEqual(extractLatestAssistantText(null), '');
  assert.strictEqual(extractLatestAssistantText([]), '');
  assert.strictEqual(extractLatestAssistantText([{ type: 'assistant' }]), '');
  assert.strictEqual(extractLatestAssistantText([{ type: 'assistant', message: { content: [] } }]), '');
});

test('falls back past an empty assistant turn to an earlier non-empty one', () => {
  const entries = [
    { type: 'assistant', message: { content: 'earlier' } },
    { type: 'assistant', message: { content: [] } },
  ];
  // latest non-empty wins; the empty trailing assistant yields '' so we keep scanning back
  assert.strictEqual(extractLatestAssistantText(entries), 'earlier');
});
