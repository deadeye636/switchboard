const { test } = require('node:test');
const assert = require('node:assert');
const { extractLatestAssistantText } = require('../src/renderer/handoff/handoff-extract.js');

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

// --- the resume picker's rules (#148) ------------------------------------------------------------
// A handoff resume starts a NEW session, so it may run on any backend. These rules used to live inside
// a DOM callback, where the "unavailable source" case silently swapped the user onto whatever backend
// happened to sort first.

const { resolveHandoffTarget } = require('../src/renderer/handoff/handoff-extract.js');

const LAUNCHABLE = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'pi', label: 'Pi' },
];

test('the picker defaults to the backend that wrote the packet', () => {
  const t = resolveHandoffTarget('codex', LAUNCHABLE, 'claude');
  assert.strictEqual(t.selected, 'codex');
  assert.strictEqual(t.sourceAvailable, true);
  assert.strictEqual(t.warning, null);
  assert.strictEqual(t.showPicker, true);
});

test('an unavailable source is announced, not silently swapped', () => {
  // Hermes wrote the packet, but it has since been disabled/uninstalled.
  const t = resolveHandoffTarget('hermes', LAUNCHABLE, 'claude');
  assert.strictEqual(t.warning, 'hermes', 'the row must say which backend it came from');
  assert.strictEqual(t.sourceAvailable, false);
  assert.strictEqual(t.selected, 'claude', 'and fall back to the default, visibly');
});

test('a handoff saved before backends existed has no source, and claims none', () => {
  const t = resolveHandoffTarget(null, LAUNCHABLE, 'codex');
  assert.strictEqual(t.selected, 'codex', 'it just uses the default backend, like a new session');
  assert.strictEqual(t.warning, null, 'unknown provenance is not a warning — it is simply unknown');
});

test('a single-backend user gets no picker at all', () => {
  const t = resolveHandoffTarget('claude', [{ id: 'claude', label: 'Claude Code' }], 'claude');
  assert.strictEqual(t.showPicker, false, 'the app must look untouched for them');

  const legacy = resolveHandoffTarget(null, [{ id: 'claude', label: 'Claude Code' }], 'claude');
  assert.strictEqual(legacy.showPicker, false);
});

test('a single-backend user WHOSE packet came from elsewhere still sees the picker', () => {
  // Only Claude is enabled now, but the packet came from Codex — hiding that would be a lie.
  const t = resolveHandoffTarget('codex', [{ id: 'claude', label: 'Claude Code' }], 'claude');
  assert.strictEqual(t.showPicker, true);
  assert.strictEqual(t.warning, 'codex');
});

test('no launchable backends at all still yields something runnable', () => {
  const t = resolveHandoffTarget('codex', [], 'claude');
  assert.strictEqual(t.selected, 'claude');
  assert.strictEqual(t.options.length, 1);
});
