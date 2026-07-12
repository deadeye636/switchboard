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

// #148 — a handoff is not a Claude feature. The packet is pre-filled from the last assistant turn of
// whichever backend wrote it, and every backend nests that turn differently. Getting it wrong is
// SILENT: the review dialog just comes up empty and the user retypes what the agent already wrote.

test('Codex: reads the assistant turn out of a response_item payload', () => {
  const entries = [
    { type: 'session_meta', payload: { id: 's', cwd: '/p' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hand off please' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '## Handoff\nstate: green' }] } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ];
  assert.strictEqual(extractLatestAssistantText(entries), '## Handoff\nstate: green');
});

test('Pi: reads the assistant turn out of the nested message', () => {
  const entries = [
    { type: 'session', version: 3, id: 's', cwd: '/p' },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hand off' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'packet body' }], stopReason: 'stop' } },
  ];
  assert.strictEqual(extractLatestAssistantText(entries), 'packet body');
});

test('Hermes: reads plain-string content (its DB rows are text, not blocks)', () => {
  const entries = [
    { type: 'message', message: { role: 'user', content: 'hand off' } },
    { type: 'message', message: { role: 'assistant', content: 'the packet' } },
  ];
  assert.strictEqual(extractLatestAssistantText(entries), 'the packet');
});

test('the LAST assistant turn wins, whatever backend wrote the ones before it', () => {
  const entries = [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'older claude turn' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'newer codex turn' }] } },
  ];
  assert.strictEqual(extractLatestAssistantText(entries), 'newer codex turn');
});

test('a user turn is never mistaken for the packet', () => {
  const entries = [
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'the packet' }] } },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'thanks' }] } },
  ];
  assert.strictEqual(extractLatestAssistantText(entries), 'the packet');
});
