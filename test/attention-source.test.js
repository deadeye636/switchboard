const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyAttentionSignal,
  classifyHookEvent,
  reduceAttention,
} = require('../src/shared/attention-source');

// --- OSC-9 path: parity with the old inline regex from app.js:409 ---

test('osc9 payloads that previously matched still classify as needs-attention', () => {
  const messages = [
    'Claude Code needs your attention',
    'Claude Code needs your approval for the plan',
    'Claude needs your permission to use Bash',
    'Claude Code wants to enter plan mode',
  ];
  for (const message of messages) {
    const result = classifyAttentionSignal({ source: 'osc9', payload: message });
    assert.equal(result.kind, 'needs-attention', `expected needs-attention for: ${message}`);
    assert.equal(result.reason, message);
    assert.equal(result.source, 'osc9');
  }
});

test('osc9 non-matching payloads return null', () => {
  assert.equal(classifyAttentionSignal({ source: 'osc9', payload: 'Build complete' }), null);
  assert.equal(classifyAttentionSignal({ source: 'osc9', payload: '' }), null);
  assert.equal(classifyAttentionSignal({ source: 'osc9', payload: undefined }), null);
});

test('osc9 "waiting for your input" classifies as ready', () => {
  const result = classifyAttentionSignal({ source: 'osc9', payload: 'Claude is waiting for your input' });
  assert.equal(result.kind, 'ready');
  assert.equal(result.source, 'osc9');
});

// --- Hook path: structured events map straight through ---

test('hook Notification permission_prompt maps to needs-attention with a reason', () => {
  const result = classifyAttentionSignal({
    source: 'hook',
    payload: {
      session_id: 'abc',
      hook_event_name: 'Notification',
      matcher: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    },
  });
  assert.equal(result.kind, 'needs-attention');
  assert.equal(result.reason, 'Claude needs your permission to use Bash');
  assert.equal(result.source, 'hook');
});

test('hook Notification falls back to a descriptive reason when message is empty', () => {
  const result = classifyAttentionSignal({
    source: 'hook',
    payload: { hook_event_name: 'Notification', matcher: 'permission_prompt' },
  });
  assert.equal(result.kind, 'needs-attention');
  assert.equal(result.reason, 'Claude needs permission');
});

test('hook Notification idle_prompt maps to ready (not a blocker)', () => {
  const result = classifyAttentionSignal({
    source: 'hook',
    payload: { hook_event_name: 'Notification', matcher: 'idle_prompt' },
  });
  assert.equal(result.kind, 'ready');
});

test('hook Stop maps to ready', () => {
  const result = classifyAttentionSignal({
    source: 'hook',
    payload: { hook_event_name: 'Stop' },
  });
  assert.equal(result.kind, 'ready');
  assert.equal(result.source, 'hook');
});

test('hook PermissionRequest maps to needs-attention', () => {
  const result = classifyHookEvent({ hook_event_name: 'PermissionRequest' });
  assert.equal(result.kind, 'needs-attention');
});

test('hook UserPromptSubmit maps to busy (Working)', () => {
  const result = classifyAttentionSignal({
    source: 'hook',
    payload: { hook_event_name: 'UserPromptSubmit' },
  });
  assert.equal(result.kind, 'busy');
  assert.equal(result.source, 'hook');
  assert.equal(result.reason, 'Agent working');
});

// Subagent lifecycle (#119). Payloads verified against the installed CLI: both
// events carry the PARENT session_id plus the subagent's agent_id.
test('hook SubagentStart maps to subagent-live-start and keeps the agent identity', () => {
  const result = classifyAttentionSignal({
    source: 'hook',
    payload: { hook_event_name: 'SubagentStart', agent_id: 'a123', agent_type: 'general-purpose' },
  });
  assert.equal(result.kind, 'subagent-live-start');
  assert.equal(result.agentId, 'a123');
  assert.equal(result.agentType, 'general-purpose');
  assert.equal(result.source, 'hook');
});

test('hook SubagentStop maps to subagent-live-stop and keeps the agent id', () => {
  const result = classifyAttentionSignal({
    source: 'hook',
    payload: { hook_event_name: 'SubagentStop', agent_id: 'a123' },
  });
  assert.equal(result.kind, 'subagent-live-stop');
  assert.equal(result.agentId, 'a123');
});

test('SubagentStop must not map to ready — it would end the parent turn (#119)', () => {
  // The payload's session_id is the PARENT's, so treating a finished subagent as
  // "agent finished responding" would flip the parent to Ready while it still works.
  const result = classifyHookEvent({ hook_event_name: 'SubagentStop', agent_id: 'a1' });
  assert.notEqual(result.kind, 'ready');
});

test('PreToolUse and PostToolUse are no longer subagent signals (#119)', () => {
  // SubagentStart/Stop replaced them: PostToolUse fires on the async tool return,
  // and PreToolUse carries no agent id.
  for (const ev of ['PreToolUse', 'PostToolUse']) {
    for (const tool of ['Agent', 'Task', 'Bash']) {
      assert.equal(classifyAttentionSignal({ source: 'hook', payload: { hook_event_name: ev, tool_name: tool } }), null);
    }
  }
});

test('unknown hook events return null', () => {
  assert.equal(classifyAttentionSignal({ source: 'hook', payload: { hook_event_name: 'PreToolUse' } }), null);
  assert.equal(classifyAttentionSignal({ source: 'hook', payload: {} }), null);
  assert.equal(classifyAttentionSignal({ source: 'hook', payload: null }), null);
});

test('unknown source returns null', () => {
  assert.equal(classifyAttentionSignal({ source: 'mystery', payload: 'anything' }), null);
  assert.equal(classifyAttentionSignal(null), null);
});

// --- Precedence: hook beats osc9 for the same session ---

test('hook signal takes precedence over a conflicting osc9 signal', () => {
  const osc9 = { kind: 'needs-attention', reason: 'Claude needs your attention', source: 'osc9' };
  const hook = { kind: 'needs-attention', reason: 'Claude needs your permission to use mcp__db__query', source: 'hook' };

  // osc9 arrives first, then hook → hook wins
  assert.equal(reduceAttention(osc9, hook), hook);
  // hook arrives first, then osc9 → hook stays
  assert.equal(reduceAttention(hook, osc9), hook);
});

test('reduceAttention handles missing operands and same-source latest-wins', () => {
  const a = { kind: 'needs-attention', reason: 'a', source: 'osc9' };
  const b = { kind: 'needs-attention', reason: 'b', source: 'osc9' };
  assert.equal(reduceAttention(null, a), a);
  assert.equal(reduceAttention(a, null), a);
  assert.equal(reduceAttention(a, b), b);
});
