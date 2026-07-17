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

// The case that had no test, which is why the defect lived here (#225): with NOTHING launchable this
// substituted a synthetic `{id:'claude'}` list. Two lies for the price of one — the row offered a New
// session on a backend that cannot spawn, and hid the picker while doing it, because a fabricated list
// of exactly one entry trips the single-backend rule and looks deliberate. Every backend can be
// disabled (§5.8), so this is reachable, not hypothetical.
test('with no backend enabled it invents none — there is nothing to launch, and it says so', () => {
  for (const empty of [[], null, undefined]) {
    const t = resolveHandoffTarget('codex', empty, 'claude');
    assert.deepStrictEqual(t.options, [], 'the list is empty because the truth is empty');
    assert.strictEqual(t.canLaunch, false, 'the caller must be able to tell that nothing can run');
    assert.strictEqual(t.selected, '', 'selecting a backend that does not exist is the bug, not the fix');
    assert.strictEqual(t.showPicker, false, 'an empty select is not a choice, it is a puzzle');
  }
});

test('canLaunch is true whenever there is something to run', () => {
  assert.strictEqual(resolveHandoffTarget('codex', LAUNCHABLE, 'claude').canLaunch, true);
  assert.strictEqual(resolveHandoffTarget(null, [{ id: 'pi', label: 'Pi' }], 'pi').canLaunch, true);
});

// The default is a CANDIDATE, not an answer: a user can disable the backend they once picked as their
// default, and since #212 the settings page writes '' when nothing is launchable. Neither may select a
// backend that is not on the list.
test('a default that is not launchable does not get selected', () => {
  const t = resolveHandoffTarget(null, [{ id: 'codex', label: 'Codex' }], 'claude');
  assert.strictEqual(t.selected, 'codex', 'it falls to what CAN run, not to the stale default');

  const noDefault = resolveHandoffTarget(null, [{ id: 'codex', label: 'Codex' }], '');
  assert.strictEqual(noDefault.selected, 'codex', 'no default at all resolves the same way');
});

// This file used to end with a test called "no launchable backends at all still yields something
// runnable", asserting `selected === 'claude'` and `options.length === 1` against an EMPTY list, with no
// comment saying why. Its own name is the defect: if nothing is launchable then nothing is runnable, and
// the 'claude' it returned could not spawn — being disabled is precisely why the list was empty. It
// pinned the fabrication instead of justifying it, which is how the fabrication survived #212.
// Replaced by the two tests above (#225).
