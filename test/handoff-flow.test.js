const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HANDOFF_STEPS,
  createHandoffState,
  nextHandoffStep,
  advanceHandoff,
  cancelHandoff,
  isHandoffCancelled,
  isHandoffComplete,
  isHandoffTerminal,
  extractLatestAssistantText,
} = require('../public/handoff-flow');

const {
  buildHandoffTemplate,
  buildHandoffRequestPrompt,
} = require('../public/session-health');

test('createHandoffState starts at the confirm step, not terminal', () => {
  const state = createHandoffState();
  assert.equal(state.step, 'confirm');
  assert.equal(isHandoffCancelled(state), false);
  assert.equal(isHandoffComplete(state), false);
  assert.equal(isHandoffTerminal(state), false);
});

test('happy path advances confirm → requested → captured → forked → switched → done', () => {
  let state = createHandoffState();

  assert.equal(nextHandoffStep(state).action, 'request-packet');
  state = advanceHandoff(state);
  assert.equal(state.step, 'requested');

  assert.equal(nextHandoffStep(state).action, 'capture-packet');
  state = advanceHandoff(state);
  assert.equal(state.step, 'captured');

  assert.equal(nextHandoffStep(state).action, 'launch-session');
  state = advanceHandoff(state);
  assert.equal(state.step, 'forked');

  assert.equal(nextHandoffStep(state).action, 'seed-session');
  state = advanceHandoff(state);
  assert.equal(state.step, 'switched');

  assert.equal(nextHandoffStep(state).action, 'finish');
  state = advanceHandoff(state);
  assert.equal(isHandoffComplete(state), true);
  assert.equal(nextHandoffStep(state).terminal, true);
});

test('the step order matches the documented sequence', () => {
  assert.deepEqual(HANDOFF_STEPS, ['confirm', 'requested', 'captured', 'forked', 'switched']);
});

test('cancel from any step is terminal and reports abort', () => {
  for (const step of HANDOFF_STEPS) {
    let state = createHandoffState();
    // Walk to the target step.
    while (state.step !== step) state = advanceHandoff(state);
    const cancelled = cancelHandoff(state);
    assert.equal(isHandoffCancelled(cancelled), true);
    assert.equal(isHandoffTerminal(cancelled), true);
    assert.equal(nextHandoffStep(cancelled).action, 'abort');
    // The original step is preserved for inspection.
    assert.equal(cancelled.step, step);
  }
});

test('advancing or cancelling a terminal state is a no-op (immutably)', () => {
  const done = advanceHandoff({ step: 'switched', cancelled: false, done: false });
  assert.equal(isHandoffComplete(done), true);
  assert.deepEqual(advanceHandoff(done), done);

  const cancelled = cancelHandoff(createHandoffState());
  // cancelHandoff is idempotent on an already-cancelled state.
  assert.equal(isHandoffCancelled(cancelHandoff(cancelled)), true);
});

test('extractLatestAssistantText pulls the last assistant turn from array content', () => {
  const entries = [
    { type: 'user', message: { role: 'user', content: 'do the thing' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first reply' }] } },
    { type: 'user', message: { role: 'user', content: 'now hand off' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '# Handoff\n' },
          { type: 'text', text: 'Goal: ship it' },
        ],
      },
    },
  ];
  assert.equal(extractLatestAssistantText(entries), '# Handoff\nGoal: ship it');
});

test('extractLatestAssistantText handles string content and ignores tool/non-text blocks', () => {
  const entries = [
    { type: 'assistant', message: { content: 'plain string reply' } },
  ];
  assert.equal(extractLatestAssistantText(entries), 'plain string reply');

  const withTool = [
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: {} },
          { type: 'text', text: 'the summary' },
        ],
      },
    },
  ];
  assert.equal(extractLatestAssistantText(withTool), 'the summary');
});

test('extractLatestAssistantText returns empty string for malformed input', () => {
  assert.equal(extractLatestAssistantText(null), '');
  assert.equal(extractLatestAssistantText(undefined), '');
  assert.equal(extractLatestAssistantText([]), '');
  assert.equal(extractLatestAssistantText([{ type: 'user', message: { content: 'hi' } }]), '');
  assert.equal(extractLatestAssistantText([{ type: 'assistant' }]), '');
});

// Seeding text: the request prompt and local template must carry enough context
// to seed a fresh session (goal, project, previous session id).
test('handoff seed text includes goal, project, and previous session id', () => {
  const session = {
    sessionId: 'abc-123',
    name: 'Refactor billing module',
    projectPath: '/Users/me/projects/billing',
    userMessageCount: 42,
  };

  const requestPrompt = buildHandoffRequestPrompt(session);
  assert.match(requestPrompt, /Refactor billing module/);
  assert.match(requestPrompt, /\/Users\/me\/projects\/billing/);
  assert.match(requestPrompt, /abc-123/);
  // Must instruct the agent not to keep working.
  assert.match(requestPrompt, /Do not continue/i);

  const template = buildHandoffTemplate(session);
  assert.match(template, /Refactor billing module/);
  assert.match(template, /\/Users\/me\/projects\/billing/);
  assert.match(template, /abc-123/);
});
