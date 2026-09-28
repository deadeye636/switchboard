'use strict';
// claude-native (#660): Claude Code driven over its stream-json pipe. This file holds what can be asked without
// a child — the translator, the launch, the version floor, the descriptor's wiring. The core driving a real
// child through this backend's protocol half is `claude-native-rpc.test.js`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backends = require('../src/backends');
const claude = require('../src/backends/claude');
const protocol = require('../src/backends/claude-native/rpc-protocol');
const version = require('../src/backends/claude-native/version');
const { TRANSPORT_ENTRYPOINT_ENV, TRANSPORT_ENTRYPOINT } = require('../src/backends/claude/transport-marker');
const { encodeProjectPath } = require('../src/session/encode-project-path');

const native = () => backends.get('claude-native');
const decodeAll = (lines) => { const d = protocol.createDecoder(); return lines.flatMap(l => d.decode(l)); };
const opNames = (ops) => ops.map(o => o.op);

// --- the translator ---

test('a streamed reply is drawn as it is written, and each finished block becomes an entry under its uuid', () => {
  const d = protocol.createDecoder();
  const s = { session_id: 's1', parent_tool_use_id: null };
  assert.deepEqual(opNames(d.decode({ ...s, type: 'stream_event', event: { type: 'message_start' } })), ['identity', 'partial']);
  d.decode({ ...s, type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  const delta = d.decode({ ...s, type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } } });
  assert.deepEqual(delta[0].entry.message.content, [{ type: 'text', text: 'Hel' }]);
  d.decode({ ...s, type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } } });
  assert.equal(d.currentPartial().message.content[0].text, 'Hello');
  const done = d.decode({ ...s, type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } });
  assert.deepEqual(opNames(done), ['partial', 'append']);
  assert.equal(done[0].entry, null, 'the finished block leaves the partial, so it is not drawn twice');
  assert.equal(done[1].entry.uuid, 'a1');
  assert.equal(protocol.entryKey(done[1].entry), 'a1');
  // The next block of the same model message streams into an emptied partial.
  d.decode({ ...s, type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Bash' } } });
  const args = d.decode({ ...s, type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"l' } } });
  assert.deepEqual(args[0].entry.message.content, [{ type: 'tool_use', id: 't1', name: 'Bash', input: { _partial: '{"command":"l' } }]);
  assert.deepEqual(d.decode({ ...s, type: 'stream_event', event: { type: 'message_stop' } }), [{ op: 'partial', entry: null }]);
});

test('a tool call runs from its block to its result', () => {
  const ops = decodeAll([
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out', is_error: false }] } },
    { type: 'user', uuid: 'u3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'bad' }], is_error: true }] } },
  ]);
  assert.deepEqual(ops.filter(o => o.op === 'tool'), [
    { op: 'tool', id: 't1', status: 'running', output: '' },
    { op: 'tool', id: 't1', status: 'done', output: 'out' },
    { op: 'tool', id: 't2', status: 'error', output: 'bad' },
  ]);
});

test('every turn opens with system/init and ends with result — the busy edges of a turn nothing of ours wrote', () => {
  const ops = decodeAll([
    { type: 'result', subtype: 'success', is_error: false, result: 'A' },
    { type: 'system', subtype: 'init' },
    { type: 'user', uuid: 'u9', isReplay: true, message: { role: 'user', content: 'queued' } },
    { type: 'result', subtype: 'success', is_error: false, result: 'B' },
  ]);
  assert.deepEqual(ops.filter(o => o.op === 'busy').map(o => o.busy), [false, true, false]);
  assert.equal(ops.find(o => o.op === 'append').entry.message.content, 'queued', 'the queued line is drawn when it runs');
});

test('a failed turn says so, in the CLI\'s own words', () => {
  const ops = decodeAll([{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Credit balance is too low'] }]);
  assert.deepEqual(ops, [{ op: 'notice', level: 'error', text: 'Credit balance is too low' }, { op: 'busy', busy: false }]);
  const failedCall = decodeAll([{ type: 'assistant', uuid: 'a1', error: 'authentication_failed', message: { role: 'assistant', content: [{ type: 'text', text: 'Please run /login' }] } }]);
  assert.deepEqual(failedCall.find(o => o.op === 'notice'), { op: 'notice', level: 'error', text: 'Please run /login' });
});

test('a turn ended by Stop is drawn as stopped; a Stop that ended nothing leaves the next failure alone', () => {
  const stopped = protocol.createDecoder();
  stopped.noteSent(protocol.abortCommand('i1'));
  const ops = stopped.decode({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['[ede_diagnostic] result_type=user'] });
  assert.deepEqual(ops, [{ op: 'notice', level: 'info', text: 'Stopped.' }, { op: 'busy', busy: false }]);
  const after = stopped.decode({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Credit balance is too low'] });
  assert.equal(after[0].level, 'error', 'the stop is spent by the turn it ended');

  const idleStop = protocol.createDecoder();
  idleStop.noteSent(protocol.abortCommand('i2'));
  idleStop.noteSent(protocol.sendCommand({ text: 'next' }));
  idleStop.decode({ type: 'system', subtype: 'init' });
  const failed = idleStop.decode({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Credit balance is too low'] });
  assert.deepEqual(failed[0], { op: 'notice', level: 'error', text: 'Credit balance is too low' }, 'a turn that starts after the Stop is not the one it stopped');
});

test('a local command\'s <synthetic> reply is an entry, never a shell line of the core\'s', () => {
  const ops = decodeAll([{ type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Total cost: $0.00' }] } }]);
  assert.deepEqual(opNames(ops), ['append']);
  assert.ok(!ops.some(o => o.op === 'localCommand'));
});

test('/clear: the conversation is reset, and the new id is announced before anything about the new session', () => {
  const ops = decodeAll([
    { type: 'result', session_id: 'old', subtype: 'success', is_error: false },
    { type: 'conversation_reset' },
    { type: 'system', subtype: 'init', session_id: 'new' },
    { type: 'result', session_id: 'new', subtype: 'success', is_error: false },
  ]);
  assert.deepEqual(opNames(ops), ['identity', 'busy', 'partial', 'reset', 'identity', 'busy', 'busy']);
  assert.deepEqual(ops.filter(o => o.op === 'identity').map(o => o.sessionId), ['old', 'new']);
  // The ordering the hooks depend on (#659): the re-key comes first on the line that names the new id, so the
  // busy edge of the new session is already reported under the new id.
  const newAt = ops.findIndex(o => o.op === 'identity' && o.sessionId === 'new');
  assert.equal(ops[newAt + 1].op, 'busy');
  assert.deepEqual(decodeAll([{ type: 'result', session_id: 'x' }, { type: 'result', session_id: 'x' }]).filter(o => o.op === 'identity').length, 1,
    'an id is announced once, not on every line');
});

test('a subagent\'s own stream is not a turn of this conversation', () => {
  const ops = decodeAll([
    { type: 'stream_event', parent_tool_use_id: 't1', event: { type: 'message_start' } },
    { type: 'assistant', parent_tool_use_id: 't1', uuid: 'x', message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] } },
    { type: 'user', parent_tool_use_id: 't1', uuid: 'y', message: { role: 'user', content: 'sub prompt' } },
  ]);
  assert.deepEqual(ops, []);
});

test('an approval arrives as an ask, a withdrawn one closes, and the answer echoes the tool\'s input', () => {
  const [ask] = decodeAll([{ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 't1', input: { command: 'ls' }, description: 'List' } }]);
  assert.equal(ask.op, 'ask');
  assert.equal(ask.request.id, 'r1');
  assert.equal(ask.request.kind, 'approval');
  assert.equal(ask.request.toolCallId, 't1');
  assert.equal(ask.request.message, 'List');
  assert.match(ask.request.note, /Claude Code asks this under its own permission rules/,
    'the card says whose question it is — not the pi-native gate\'s "convenience, not a boundary"');
  assert.deepEqual(Object.keys(ask.request.answers), ['once', 'refuse'], 'no suggestion from the CLI, no "for this session"');
  assert.deepEqual(decodeAll([{ type: 'control_cancel_request', request_id: 'r1' }]), [{ op: 'answered', id: 'r1' }]);
  assert.deepEqual(decodeAll([{ type: 'control_request', request_id: 'r2', request: { subtype: 'hook_callback' } }]), []);

  const allow = protocol.answerCommand('r1', { value: ask.request.answers.once }, ask.request);
  assert.deepEqual(allow, { type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { command: 'ls' } } } });
  for (const answer of [{ value: ask.request.answers.refuse }, { cancelled: true }, {}]) {
    const r = protocol.answerCommand('r1', answer, ask.request).response.response;
    assert.equal(r.behavior, 'deny', JSON.stringify(answer));
    assert.ok(r.message);
  }
});

// #661, measured on 2.1.283: a Write with no rule matched carried `setMode acceptEdits` for the session.
test('"allow for this session" is offered only for what the CLI suggested for the session, and hands it back', () => {
  const suggestions = [
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'localSettings' },
  ];
  const [ask] = decodeAll([{ type: 'control_request', request_id: 'w1', request: { subtype: 'can_use_tool', tool_name: 'Write', tool_use_id: 't2', input: { file_path: 'b.txt', content: 'hi' }, permission_suggestions: suggestions } }]);
  assert.deepEqual(Object.keys(ask.request.answers), ['once', 'session', 'project', 'refuse']);
  assert.equal(ask.request.sessionLabel, 'Allow all edits for this session', 'the button says a mode switch reaches every later edit');
  const r = protocol.answerCommand('w1', { value: ask.request.answers.session }, ask.request).response.response;
  assert.equal(r.behavior, 'allow');
  assert.deepEqual(r.updatedInput, { file_path: 'b.txt', content: 'hi' });
  assert.deepEqual(r.updatedPermissions, [suggestions[0]], '"for this session" hands back only what is for the session');

  const [onlyFile] = decodeAll([{ type: 'control_request', request_id: 'w2', request: { subtype: 'can_use_tool', tool_name: 'Write', input: {}, permission_suggestions: [suggestions[1]] } }]);
  assert.deepEqual(Object.keys(onlyFile.request.answers), ['once', 'project', 'refuse'], 'nothing for the session, no session button');
  assert.equal(protocol.answerCommand('w2', { value: protocol.ALLOW_SESSION }, onlyFile.request).response.response.updatedPermissions, undefined);
});

// #674: the lasting allow Claude's own terminal offers — the project's LOCAL settings only.
test('"in this project" hands back only the local-settings allow rule, and names the command', () => {
  const measured = [   // the suggestions a `mkdir` carried, measured on 2.1.283
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'mkdir -p m7dir' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'addDirectories', directories: ['/work'], destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ];
  const [ask] = decodeAll([{ type: 'control_request', request_id: 'b1', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 't9', input: { command: 'mkdir -p m7dir' }, permission_suggestions: measured } }]);
  assert.deepEqual(Object.keys(ask.request.answers), ['once', 'session', 'project', 'refuse']);
  assert.equal(ask.request.projectLabel, 'Always allow “mkdir -p m7dir” in this project');
  assert.match(ask.request.projectNote, /settings\.local\.json/, 'the tooltip says where the rule lands and how it is taken back');
  assert.match(ask.request.projectNote, /^Rule: Bash\(mkdir -p m7dir\)\./, 'and leads with the full rule, which the label may cut short');
  const label = (rules) => decodeAll([{ type: 'control_request', request_id: 'l', request: { subtype: 'can_use_tool', tool_name: 'X', input: {},
    permission_suggestions: [{ type: 'addRules', rules, behavior: 'allow', destination: 'localSettings' }] } }])[0].request.projectLabel;
  assert.equal(label([{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }]), 'Always allow “WebFetch(domain:example.com)” in this project',
    'another tool\'s content is shown with its tool');
  assert.equal(label([{ toolName: 'Bash' }]), 'Always allow every Bash call in this project', 'a rule without content says it allows every call');
  assert.match(label([{ toolName: 'Bash', ruleContent: 'x'.repeat(100) }]), /…” in this project$/, 'a long command is cut in the label');
  const r = protocol.answerCommand('b1', { value: protocol.ALLOW_PROJECT }, ask.request).response.response;
  assert.equal(r.behavior, 'allow');
  assert.deepEqual(r.updatedInput, { command: 'mkdir -p m7dir' });
  assert.deepEqual(r.updatedPermissions, [measured[0]], 'only the project rule, not the session ones');

  // A rule for the shared project settings or the user's settings is not offered, and a crafted ask carrying
  // one cannot hand it back either.
  const wide = [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf x' }], behavior: 'allow', destination: 'projectSettings' },
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'userSettings' },
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'curl' }], behavior: 'deny', destination: 'localSettings' },
  ];
  const [none] = decodeAll([{ type: 'control_request', request_id: 'b2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'x' }, permission_suggestions: wide } }]);
  assert.deepEqual(Object.keys(none.request.answers), ['once', 'refuse']);
  const crafted = { ...none.request, projectPermissions: wide };
  const c = protocol.answerCommand('b2', { value: protocol.ALLOW_PROJECT }, crafted).response.response;
  assert.equal(c.behavior, 'deny', 'no local allow rule to hand back: the answer is not an allow');
  assert.equal(c.updatedPermissions, undefined);

  // A dismissed card never writes a rule.
  assert.equal(protocol.answerCommand('b1', { cancelled: true, value: protocol.ALLOW_PROJECT }, ask.request).response.response.behavior, 'deny');
});

test('AskUserQuestion is a question card, and its answers go back in updatedInput', () => {
  const input = { questions: [
    { question: 'Which toppings?', header: 'Toppings', multiSelect: true, options: [{ label: 'Cheese', description: 'Classic' }, { label: 'Ham' }] },
    { question: 'Which size?', header: 'Size', multiSelect: false, options: [{ label: 'Small' }, { label: 'Large' }] },
  ] };
  const [ask] = decodeAll([{ type: 'control_request', request_id: 'a1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 't3', input, requires_user_interaction: true } }]);
  assert.equal(ask.request.kind, 'questions');
  assert.deepEqual(ask.request.questions.map(q => [q.question, q.header, q.multiSelect, q.options.map(o => o.label)]),
    [['Which toppings?', 'Toppings', true, ['Cheese', 'Ham']], ['Which size?', 'Size', false, ['Small', 'Large']]]);
  const r = protocol.answerCommand('a1', { answers: { 'Which toppings?': 'Cheese, Ham', 'Which size?': ' Medium ', 'Not asked': 'x' } }, ask.request).response.response;
  assert.equal(r.behavior, 'allow');
  assert.deepEqual(r.updatedInput, { ...input, answers: { 'Which toppings?': 'Cheese, Ham', 'Which size?': 'Medium' } },
    'the input unchanged, the answers beside it — only for questions that were asked');
  for (const answer of [{ cancelled: true }, { answers: {} }, {}]) {
    assert.equal(protocol.answerCommand('a1', answer, ask.request).response.response.behavior, 'deny', JSON.stringify(answer));
  }
  const [odd] = decodeAll([{ type: 'control_request', request_id: 'a2', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: 'nope' } } }]);
  assert.equal(odd.request.kind, 'approval', 'a question the card cannot draw is still asked, as an approval');
});

test('ExitPlanMode is a plan card: approve lets it start, keep planning ends the turn as kept, not failed', () => {
  const input = { plan: '# Plan\n\n1. Do it', planFilePath: 'plans/x.md' };
  const decoder = protocol.createDecoder();
  const [ask] = decoder.decode({ type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', tool_use_id: 't4', input } });
  assert.equal(ask.request.kind, 'plan');
  assert.equal(ask.request.plan, input.plan);
  assert.deepEqual(Object.keys(ask.request.answers), ['approve', 'keep'], 'no "approve and accept edits" (#661 E16)');
  assert.deepEqual(protocol.answerCommand('p1', { value: ask.request.answers.approve }, ask.request).response.response,
    { behavior: 'allow', updatedInput: input });
  for (const answer of [{ value: ask.request.answers.keep }, { cancelled: true }]) {
    const r = protocol.answerCommand('p1', answer, ask.request).response.response;
    assert.equal(r.behavior, 'deny');
    assert.equal(r.interrupt, true, 'keep planning ends the turn');
  }
  // Measured: that interrupt ends the turn with the same result a Stop gets.
  decoder.noteSent(protocol.answerCommand('p1', { value: ask.request.answers.keep }, ask.request));
  const ops = decoder.decode({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['[ede_diagnostic] result_type=user'] });
  assert.equal(ops[0].level, 'info');
  assert.match(ops[0].text, /Kept planning/);
});

test('the CLI\'s bookkeeping lines are not drawn', () => {
  assert.deepEqual(decodeAll([
    { type: 'user', uuid: 'm', isMeta: true, message: { role: 'user', content: '<local-command-caveat>' } },
    { type: 'rate_limit_event' },
    { type: 'system', subtype: 'status', status: 'requesting' },
    { type: 'system', subtype: 'commands_changed', commands: [] },
  ]), []);
  assert.deepEqual(decodeAll([{ type: 'system', subtype: 'compact_boundary' }]).map(o => o.level), ['info']);
});

// --- commands ---

test('the three send modes map onto Claude\'s priorities', () => {
  assert.equal(protocol.sendCommand({ text: 'a', mode: 'prompt' }).priority, undefined);
  assert.equal(protocol.sendCommand({ text: 'a', mode: 'prompt', busy: true }).priority, undefined, 'a plain line queues by itself');
  assert.equal(protocol.sendCommand({ text: 'a', mode: 'steer' }).priority, 'next');
  assert.equal(protocol.sendCommand({ text: 'a', mode: 'follow_up' }).priority, 'later');
  assert.deepEqual(protocol.sendCommand({ text: 'hi' }).message, { role: 'user', content: 'hi' });
});

test('a turn with images is a content array, text first as the TUI writes it, and a turn without stays a string (#662, #688)', () => {
  const img = { mimeType: 'image/png', data: 'AAAA' };
  const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  assert.deepEqual(protocol.sendCommand({ text: 'what is [Image #1]', images: [img] }).message.content,
    [{ type: 'text', text: 'what is [Image #1]' }, block]);
  const second = { mimeType: 'image/jpeg', data: 'BBBB' };
  assert.deepEqual(protocol.sendCommand({ text: '[Image #1] vs [Image #2]', images: [img, second] }).message.content.slice(1)
    .map(b => b.source.data), ['AAAA', 'BBBB'], 'the images keep their numbered order');
  assert.deepEqual(protocol.sendCommand({ text: '  ', images: [img, img] }).message.content, [block, block],
    'no empty text block beside images alone');
  assert.equal(protocol.sendCommand({ text: 'hi', images: [] }).message.content, 'hi');
  assert.equal(protocol.sendCommand({ text: 'a', mode: 'steer', images: [img] }).priority, 'next', 'images change no priority');
  assert.deepEqual(native().rpc.imageInput, protocol.IMAGE_INPUT, 'the declaration the core and the view read');
  assert.ok(protocol.IMAGE_INPUT.types.includes('image/png') && protocol.IMAGE_INPUT.maxBytes > 0);
});

test('a control response answers the request it names, success and refusal alike', () => {
  assert.deepEqual(protocol.responseOf({ type: 'control_response', response: { subtype: 'success', request_id: 'x', response: { a: 1 } } }),
    { id: 'x', payload: { success: true, data: { a: 1 } } });
  assert.deepEqual(protocol.responseOf({ type: 'control_response', response: { subtype: 'error', request_id: 'x', error: 'no' } }),
    { id: 'x', payload: { success: false, error: 'no' } });
  assert.equal(protocol.responseOf({ type: 'assistant' }), null);
  assert.equal(protocol.abortCommand('i').request.subtype, 'interrupt');
  assert.equal(protocol.commandsCommand('c').request.subtype, 'initialize');
  assert.deepEqual(protocol.commandsFromResponse({ data: { commands: [{ name: 'compact', description: 'a\n  b' }, { name: '' }, null] } }),
    [{ name: 'compact', description: 'a b', kind: 'command', arguments: false }]);
});

test('an attach reads the conversation\'s own lines out of the transcript', () => {
  const lines = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [] } },
    { type: 'user', uuid: 'm1', isMeta: true, message: { role: 'user', content: 'meta' } },
    { type: 'assistant', uuid: 's1', isSidechain: true, message: { role: 'assistant', content: [] } },
    { type: 'attachment', uuid: 'x1' },
    { type: 'queue-operation' },
    { type: 'user', message: { role: 'user', content: 'no uuid' } },
  ];
  assert.deepEqual(protocol.conversationEntries(lines).map(l => l.uuid), ['u1', 'a1']);
});

test('a reopened session shows a local command\'s output as the same entry the live stream sent (#681)', () => {
  // The shapes measured on Claude Code 2.1.283 for `/cost`: the stream sends a synthetic assistant line, the
  // transcript keeps a system/local_command line under the same uuid.
  const text = 'You are currently using your subscription to power your Claude Code usage';
  const transcript = [
    { type: 'user', uuid: 'cav', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat: …</local-command-caveat>' } },
    { type: 'user', uuid: 'cmd', message: { role: 'user', content: '<command-name>/usage</command-name>\n            <command-message>usage</command-message>\n            <command-args></command-args>' } },
    { type: 'system', subtype: 'local_command', uuid: 'out', level: 'info', isMeta: false, timestamp: '2026-09-27T21:00:00.000Z', content: `<local-command-stdout>${text}</local-command-stdout>` },
    { type: 'system', subtype: 'local_command', uuid: 'empty', content: '<local-command-stdout></local-command-stdout>' },
    { type: 'system', subtype: 'local_command', content: `<local-command-stdout>${text}</local-command-stdout>` },
    { type: 'system', subtype: 'compact_boundary', uuid: 'cb', content: 'Conversation compacted' },
    { type: 'system', subtype: 'local_command', uuid: 'meta', isMeta: true, content: `<local-command-stdout>${text}</local-command-stdout>` },
    { type: 'system', subtype: 'local_command', uuid: 'side', isSidechain: true, content: `<local-command-stdout>${text}</local-command-stdout>` },
    // A command typed while a turn ran is written as a system line of command markup; it reads as typed.
    { type: 'system', subtype: 'local_command', uuid: 'queued', content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>' },
  ];
  const attached = protocol.conversationEntries(transcript);
  assert.deepEqual(attached.map(e => e.uuid), ['cmd', 'out', 'queued'],
    'the empty output, the uuid-less, meta and sidechain lines and other system lines stay out');
  assert.equal(attached[2].type, 'user');
  assert.equal(attached[2].message.content, '/model opus');

  const live = decodeAll([
    { type: 'assistant', uuid: 'out', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] } },
  ]).find(o => o.op === 'append').entry;
  const reopened = attached[1];
  assert.equal(protocol.entryKey(reopened), protocol.entryKey(live), 'one key, so the view never draws it twice');
  assert.equal(reopened.type, live.type);
  assert.deepEqual(reopened.message.content, live.message.content);
  assert.equal(reopened.message.model, '<synthetic>');
});

test('slash-command markup reads as the command, and a local command\'s output as its text (#680)', () => {
  const clear = '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>';
  const lines = [
    { type: 'user', uuid: 'c1', message: { role: 'user', content: clear } },
    { type: 'user', uuid: 'o1', message: { role: 'user', content: '<local-command-stdout></local-command-stdout>' } },
    { type: 'user', uuid: 'o2', message: { role: 'user', content: '<local-command-stdout>Total cost: $0.01</local-command-stdout>' } },
    { type: 'user', uuid: 'c2', message: { role: 'user', content: [{ type: 'text', text: '<command-name>/model</command-name><command-args>opus</command-args>' }] } },
    { type: 'user', uuid: 'p1', message: { role: 'user', content: 'what does <command-name> mean?' } },
    { type: 'user', uuid: 'c3', message: { role: 'user', content: '<command-name>/clear</command-name><command-message>clear</command-message><command-args/>' } },
    { type: 'user', uuid: 'e1', message: { role: 'user', content: '<local-command-stderr>Error: unknown model</local-command-stderr>' } },
    { type: 'user', uuid: 'c4', message: { role: 'user', content: '<command-name>/cost</command-name><local-command-stdout>Total cost: $0.02</local-command-stdout>' } },
    // A skill invocation expands into markup AND prose: that is a real prompt, and it is left as written.
    { type: 'user', uuid: 's1', message: { role: 'user', content: '<command-name>/review</command-name>\nReview the diff for bugs.' } },
  ];
  const shown = protocol.conversationEntries(lines);
  assert.deepEqual(shown.map(l => [l.uuid, l.message.content]), [
    ['c1', '/clear'],
    // An empty output says nothing and is left out.
    ['o2', 'Total cost: $0.01'],
    // A command the user gave arguments to reads as they typed it, arguments included.
    ['c2', '/model opus'],
    ['p1', 'what does <command-name> mean?'],
    // The self-closing form of an empty argument list.
    ['c3', '/clear'],
    // An error a local command printed reads as its text, like its output does.
    ['e1', 'Error: unknown model'],
    // A line carrying the command and what it printed keeps both.
    ['c4', '/cost\nTotal cost: $0.02'],
    ['s1', '<command-name>/review</command-name>\nReview the diff for bugs.'],
  ]);
  assert.equal(lines[0].message.content, clear, 'the transcript line itself is not changed');

  // The live stream draws the same line the same way, and an empty output appends nothing.
  const ops = decodeAll([
    { type: 'user', uuid: 'c1', message: { role: 'user', content: clear } },
    { type: 'user', uuid: 'o1', message: { role: 'user', content: '<local-command-stdout></local-command-stdout>' } },
  ]);
  const appended = ops.filter(o => o.op === 'append').map(o => o.entry.message.content);
  assert.deepEqual(appended, ['/clear']);
});

test('entriesFromTranscript finds the session under the project\'s folder, and by its id when the folder differs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-claude-native-'));
  const before = claude._roots();
  claude.setRoots([root]);
  t.after(() => { claude.setRoots(before); fs.rmSync(root, { recursive: true, force: true }); });
  const cwd = path.join(root, 'work', 'proj');
  const line = (uuid) => JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: uuid } });
  fs.mkdirSync(path.join(root, encodeProjectPath(cwd)), { recursive: true });
  fs.writeFileSync(path.join(root, encodeProjectPath(cwd), 's1.jsonl'), line('u1') + '\n{"half\n');
  fs.mkdirSync(path.join(root, 'elsewhere'));
  fs.writeFileSync(path.join(root, 'elsewhere', 's2.jsonl'), line('u2') + '\n');
  const read = native().rpc.entriesFromTranscript;
  assert.deepEqual((await read({ sessionId: 's1', cwd })).map(e => e.uuid), ['u1'], 'a half-written line is skipped');
  assert.deepEqual((await read({ sessionId: 's2', cwd })).map(e => e.uuid), ['u2']);
  assert.deepEqual(await read({ sessionId: 'nothing-yet', cwd }), [], 'no file yet is an empty conversation');
  assert.deepEqual((await read({ sessionId: 'fork-1', cwd, forkFrom: 's1' })).map(e => e.uuid), ['u1'],
    'a fork with no file of its own yet reads the one it was forked from');
  fs.writeFileSync(path.join(root, encodeProjectPath(cwd), 'fork-1.jsonl'), line('u1') + '\n' + line('u3') + '\n');
  assert.deepEqual((await read({ sessionId: 'fork-1', cwd, forkFrom: 's1' })).map(e => e.uuid), ['u1', 'u3'],
    'once the fork has written its file, that file answers');
});

// --- the descriptor ---

test('the launch: print mode, stream-json both ways, approvals over the pipe, the marker, no shell', () => {
  const d = native();
  const fresh = d.buildLaunch({ cwd: '/p', sessionId: 'abc', options: {} });
  assert.deepEqual(fresh.args.slice(0, 10), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio']);
  assert.ok(fresh.args.includes('--session-id=abc'), 'a value is joined to its flag');
  assert.equal(fresh.spawnMode, 'argv');
  assert.deepEqual(fresh.env, { [TRANSPORT_ENTRYPOINT_ENV]: TRANSPORT_ENTRYPOINT });
  assert.ok(d.buildLaunch({ sessionId: 'abc', resume: true }).args.includes('--resume=abc'));
  const fork = d.buildLaunch({ sessionId: 'new', forkFrom: 'old' }).args;
  assert.ok(fork.includes('--resume=old') && fork.includes('--fork-session'));
  assert.ok(fork.includes('--session-id=new'), 'a fork is started under the id its tab is keyed on (measured: the CLI takes it)');
});

test('the permission mode is sent only when chosen, and the skip flag is not offered (#653 E6)', () => {
  const d = native();
  const argsFor = (options) => d.buildLaunch({ sessionId: 's', options }).args;
  assert.ok(!argsFor({}).includes('--permission-mode'), 'unset: Claude\'s own defaultMode applies');
  assert.ok(!argsFor({ permissionMode: 'default' }).includes('--permission-mode'));
  assert.deepEqual(argsFor({ permissionMode: 'plan', model: 'haiku' }).slice(-4), ['--permission-mode', 'plan', '--model', 'haiku']);
  assert.ok(!argsFor({ permissionMode: 'dangerously-skip', dangerouslySkipPermissions: true }).some(a => /dangerously|permission-mode/.test(a)));
  const field = d.configFields.find(f => f.id === 'permissionMode');
  assert.ok(!field.choices.includes('dangerously-skip'));
  assert.equal(field.default, 'default');
  assert.ok(!d.configFields.some(f => f.appliesAt === 'spawn'), 'nothing here is applied at a terminal spawn site');
});

test('the terminal backend\'s argv options are offered and sent; the two spawn-site ones are not (#685)', () => {
  const d = native();
  const argsFor = (options) => d.buildLaunch({ sessionId: 's', options }).args;
  const ids = d.configFields.map(f => f.id);
  for (const id of ['worktree', 'worktreeName', 'chrome', 'addDirs', 'restricted', 'autocompact']) assert.ok(ids.includes(id), id);
  for (const id of ['mcpEmulation', 'afkTimeoutSec']) assert.ok(!ids.includes(id), `${id} needs a terminal`);
  assert.equal(d.configFields.find(f => f.id === 'worktreeName').requires, 'worktree', 'Claude\'s declaration, taken as it is');
  assert.doesNotMatch(d.configFields.find(f => f.id === 'restricted').description, /attention hook/, 'no hook to lose on a pipe');
  assert.deepEqual(argsFor({}).filter(a => /worktree|chrome|add-dir|restricted|autocompact/.test(a)), [], 'nothing unchosen is sent');
  assert.ok(argsFor({ worktree: true }).includes('--worktree'));
  assert.ok(argsFor({ worktree: true, worktreeName: 'b1' }).includes('--worktree=b1'));
  assert.ok(!argsFor({ worktreeName: 'b1' }).some(a => a.startsWith('--worktree')), 'a name alone means nothing');
  assert.deepEqual(argsFor({ addDirs: 'a, b' }).filter(a => a.startsWith('--add-dir')), ['--add-dir=a', '--add-dir=b']);
  const all = argsFor({ chrome: true, restricted: true, autocompact: '500k' });
  for (const flag of ['--chrome', '--restricted', '--autocompact=500k']) assert.ok(all.includes(flag), flag);
});

test('the descriptor drives Claude\'s rows: the marker, the trust gate, off by default, Claude\'s store answers', () => {
  const d = native();
  assert.equal(d.transport, 'rpc');
  assert.equal(d.transcriptsOf, 'claude');
  assert.equal(d.trustBeforeStart, true);
  assert.equal(d.rpc.sendAcknowledged, false);
  assert.equal(d.rpc.stateCommand, undefined, 'the stream names the session itself');
  assert.equal(d.rpc.gracefulStopMs, undefined, 'measured: nothing is lost on an immediate stop');
  for (const k of ['projectTrust', 'transcriptPathFor', 'deleteSessions', 'rewriteProjectPath', 'resolveLineage', 'contextWindow', 'PARSER_SCHEMA_VERSION', 'cliHomeEnv', 'listResources']) {
    assert.strictEqual(d[k], claude[k], `${k} is Claude's own answer, forwarded`);
  }
  for (const k of ['supportsLiveRebinding', 'buildLiveBinding', 'projectMeta', 'usage', 'liveOwnersCached', 'discoverSessions', 'parseSession']) {
    assert.ok(!d[k], `${k} stays with the terminal backend`);
  }
  assert.equal(backends.isEnabled(d, {}), false, 'off until the user switches it on');
  try {
    backends.init({ getGlobalSettings: () => ({ backendEnabled: { 'claude-native': true } }) });
    assert.equal(backends.openerFor({ backendId: 'claude', transport: 'rpc' }), 'claude-native');
    assert.equal(backends.openerFor({ backendId: 'claude' }), 'claude');
    backends.init({ getGlobalSettings: () => ({ backendEnabled: { 'claude-native': false } }) });
    assert.equal(backends.openerFor({ backendId: 'claude', transport: 'rpc' }), 'claude', 'switched off, the row is the terminal backend\'s');
  } finally {
    backends.init({ getGlobalSettings: () => ({}) });
  }
});

// "Every part of the protocol is handed to the core" is one loop over every runtime-driven backend now, in
// `test/runtime-backends.test.js` (#664).

// What hangs off `launch.command === 'claude'` in the spawn path is about a terminal, and claude-native's
// command IS `claude`. A source check, because node-pty is required at module load and there is no seam that
// reaches the spawn site (the same answer `spawn-first-resize.test.js` gives).
test('spawn.js gives a pipe-driven session no MCP bridge, no OSC-title heuristic and no AFK variable', () => {
  const { stripComments } = require('./helpers/strip-comments');
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'terminal', 'spawn.js'), 'utf8'));
  assert.match(src, /const isClaudeBinary = launch\.command === 'claude' && !backend\.transport;/);
  assert.match(src, /if \(!backend\.transport\) \{\s*const g = \(\(ctx\.getSetting\('global'\)/, 'the AFK block is skipped for a piped child (#653 E11)');
});

// --- the version floor ---

test('a Claude Code older than the one this was measured against is refused; one that cannot be read is not', async (t) => {
  assert.deepEqual(version.parseVersion('2.1.283 (Claude Code)'), [2, 1, 283]);
  assert.equal(version.parseVersion('nonsense'), null);
  assert.equal(version.olderThan([2, 1, 282]), true);
  assert.equal(version.olderThan([2, 1, 283]), false);
  assert.equal(version.olderThan([2, 2, 0]), false);
  assert.equal(version.olderThan([1, 99, 999]), true);

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cn-ver-')), 'claude.exe');
  fs.writeFileSync(file, 'x');
  t.after(() => { version.resetCache(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); });
  let runs = 0;
  const run = (out, status = 0) => async () => { runs += 1; return { status, stdout: out }; };
  version.resetCache();
  assert.deepEqual(await version.installedVersion(file, { run: run('2.1.300 (Claude Code)') }), [2, 1, 300]);
  assert.deepEqual(await version.installedVersion(file, { run: run('9.9.9') }), [2, 1, 300], 'an answer is kept while the binary is the same file');
  assert.equal(runs, 1);
  fs.writeFileSync(file, 'xy');
  assert.deepEqual(await version.installedVersion(file, { run: run('2.1.301') }), [2, 1, 301], 'a changed binary is asked again');
  version.resetCache();
  assert.equal(await version.installedVersion(file, { run: run('', 1) }), null, 'a failed probe asserts nothing');
});

// F4 of the #660 review: `list()` asks every registered backend's probe on the scan path, switched on or not,
// so the probe it gets may not start a child. Only the spawn path's `{ launch: true }` reaches the version.
test('the registry\'s probe walks PATH only; the version is asked only for a launch', async (t) => {
  const d = native();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cn-probe-')), process.platform === 'win32' ? 'claude.exe' : 'claude');
  fs.writeFileSync(file, 'x');
  const { findOnPath } = require('../src/backends/file-store');
  const realPath = process.env.PATH;
  process.env.PATH = path.dirname(file);
  t.after(() => {
    process.env.PATH = realPath;
    version.resetCache();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
  assert.equal(String(findOnPath('claude')).toLowerCase(), file.toLowerCase(), 'the stand-in is what the probe finds (PATHEXT spells the extension its own way)');
  version.resetCache();
  assert.deepEqual(d.probe(), { ok: true }, 'the registry\'s answer is synchronous');
  // Nothing was asked: the version cache is still empty, so the next read runs its child.
  let runs = 0;
  await version.installedVersion(file, { run: async () => { runs += 1; return { status: 1, stdout: '' }; } });
  assert.equal(runs, 1, 'the registry\'s probe started no child');
  version.resetCache();
  const launch = d.probe({ launch: true });
  assert.equal(typeof launch.then, 'function', 'a launch gets a Promise');
  assert.deepEqual(await launch, { ok: true }, 'a version that could not be read does not refuse the launch');
});

// #691, in the shapes measured on 2.1.283 (spec 32, "Background tasks and session figures").
test('background tasks: the running list is Claude\'s own, a start adds the call behind it, the notice replaces the tags', () => {
  const d = protocol.createDecoder();
  const all = (line) => d.decode(line);
  all({ type: 'assistant', uuid: 'u1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } }] } });
  all({ type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Command running in background with ID: b1. Output is being written to: /tmp/x/tasks/b1.output' }] } });
  let tasks = all({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'Dev server' }] });
  assert.deepEqual(tasks.map(o => o.op), ['tasks']);
  tasks = all({ type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_1', description: 'Dev server', task_type: 'local_bash', is_backgrounded: true });
  const [t1] = tasks[0].tasks;
  assert.equal(t1.kind, 'shell');
  assert.equal(t1.detail, 'npm run dev', 'the command the call ran');
  assert.equal(t1.toolUseId, 'toolu_1');
  assert.ok(Number.isFinite(t1.startedAt));
  assert.equal(d.taskOutputFile('b1'), '/tmp/x/tasks/b1.output', 'readable while it still runs');
  // The live notice comes from the system line: the injected user line is not sent on the pipe (measured).
  const live = all({ type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 'toolu_1', status: 'completed', output_file: '/tmp/x/tasks/b1-final.output', summary: 'Background command "Dev server" completed (exit code 0)' });
  assert.equal(d.taskOutputFile('b1'), '/tmp/x/tasks/b1-final.output', 'the notification\'s file wins');
  assert.equal(live.length, 1);
  assert.equal(live[0].entry.type, 'task-notice');
  assert.deepEqual({ ...live[0].entry._task, tokens: undefined, toolUses: undefined, durationMs: undefined }, {
    id: 'b1', toolUseId: 'toolu_1', kind: 'shell', status: 'completed', description: 'Dev server',
    summary: 'Background command "Dev server" completed (exit code 0)', result: '', exitCode: 0,
    tokens: undefined, toolUses: undefined, durationMs: undefined,
  });
  assert.ok(!JSON.stringify(live[0].entry).includes('/tmp/x'), 'no path in the entry');
  assert.deepEqual(all({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })[0].tasks, []);
  const injected = {
    type: 'user', uuid: 'u3', origin: { kind: 'task-notification' },
    message: { role: 'user', content: '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<output-file>/tmp/x</output-file>\n<status>completed</status>\n<summary>Background command "Dev server" completed (exit code 0)</summary>\n</task-notification>' },
  };
  assert.deepEqual(all(injected), [], 'the injected line for a task already drawn is not drawn again');
  // A decoder that never saw the system line (a line replayed on its own) draws it from the user line, keyed.
  const alone = protocol.createDecoder().decode(injected);
  assert.equal(alone[0].entry.type, 'task-notice');
  assert.equal(alone[0].entry.uuid, 'u3');
  // One key for the live notice and the one read back, so an attach neither loses nor doubles it.
  assert.equal(protocol.entryKey(live[0].entry), 'task-notice:b1');
  assert.equal(protocol.entryKey(alone[0].entry), 'task-notice:b1');
  assert.equal(protocol.entryKey({ type: 'user', uuid: 'u9' }), 'u9', 'every other entry keeps its uuid');
});

test('an agent\'s notice from the transcript carries its kind and cost, and stop and the figures are control requests', () => {
  const lines = [
    { type: 'assistant', uuid: 'a', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_9', name: 'Agent', input: { subagent_type: 'general-purpose' } }] } },
    { type: 'user', uuid: 'b', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>\n<task-id>a9</task-id>\n<tool-use-id>toolu_9</tool-use-id>\n<status>completed</status>\n<summary>Agent "Review" finished</summary>\n<result>all good</result>\n<usage><subagent_tokens>24212</subagent_tokens><tool_uses>3</tool_uses><duration_ms>1229</duration_ms></usage>\n</task-notification>' } },
  ];
  const entries = protocol.conversationEntries(lines);
  const notice = entries.find(e => e.type === 'task-notice');
  assert.equal(notice._task.kind, 'agent');
  assert.equal(notice._task.description, 'Review');
  assert.equal(notice._task.result, 'all good');
  assert.deepEqual([notice._task.tokens, notice._task.toolUses, notice._task.durationMs], [24212, 3, 1229]);
  assert.deepEqual(protocol.stopTaskCommand('r1', 'b1'), { type: 'control_request', request_id: 'r1', request: { subtype: 'stop_task', task_id: 'b1' } });
  assert.deepEqual(protocol.contextCommand('r2').request, { subtype: 'get_context_usage' });
  assert.deepEqual(
    protocol.contextFromResponse({ success: true, data: { totalTokens: 37984, maxTokens: 200000, percentage: 19, model: 'claude-haiku-4-5-20251001' } }),
    { percent: 19, tokens: 37984, window: 200000, model: 'Haiku 4.5' });
  assert.equal(protocol.contextFromResponse({ success: true, data: { model: 'claude-opus-5-5[1m]' } }).model, 'Opus 5.5');
  assert.equal(protocol.contextFromResponse({ success: false, error: 'no' }), null);
});
