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

// --- #529: a terminal binding's own lifecycle edge ----------------------------------------------------
//
// The third source. A terminal-bound extension states what its CLI is doing; the route that receives it
// knows nothing about which backend sent it, so the vocabulary is neutral and the wording lives here with
// every other source's.

test('a bind waiting edge is attention, and carries the busy edge separately (#529)', () => {
  const sig = classifyAttentionSignal({ source: 'bind', payload: { kind: 'waiting', prompt_kind: 'select' } });
  assert.equal(sig.kind, 'needs-attention');
  assert.equal(sig.reason, 'Waiting for you to choose');
  assert.equal(sig.source, 'bind');
  // The half a caller reading only `kind` would miss: this ends being busy as well as raising attention.
  assert.equal(sig.busy, false);
});

test('every prompt kind Pi can raise has wording (#529)', () => {
  const wording = {};
  for (const kind of ['select', 'confirm', 'input', 'editor', 'custom']) {
    const sig = classifyAttentionSignal({ source: 'bind', payload: { kind: 'waiting', prompt_kind: kind } });
    assert.equal(sig.kind, 'needs-attention');
    assert.match(sig.reason, /^Waiting for you/, `${kind}: says what is wanted`);
    wording[sig.reason] = (wording[sig.reason] || 0) + 1;
  }
  // Not five identical sentences — the prompt kind is the only thing distinguishing them, since the
  // prompt's own title is deliberately not sent.
  assert.ok(Object.keys(wording).length >= 4, 'the kinds are told apart');
});

test('an unknown prompt kind still says something (#529)', () => {
  // Pi may add a sixth kind, and a session that goes silent because we did not recognise a string is the
  // failure this whole signal exists to prevent.
  const sig = classifyAttentionSignal({ source: 'bind', payload: { kind: 'waiting', prompt_kind: 'hologram' } });
  assert.equal(sig.kind, 'needs-attention');
  assert.equal(sig.reason, 'Waiting for your answer');

  const bare = classifyAttentionSignal({ source: 'bind', payload: { kind: 'waiting' } });
  assert.equal(bare.reason, 'Waiting for your answer');
});

test('bind busy and idle pass through; anything else is not a signal (#529)', () => {
  assert.equal(classifyAttentionSignal({ source: 'bind', payload: { kind: 'busy' } }).kind, 'busy');
  assert.equal(classifyAttentionSignal({ source: 'bind', payload: { kind: 'idle' } }).kind, 'idle');
  assert.equal(classifyAttentionSignal({ source: 'bind', payload: {} }), null);
  assert.equal(classifyAttentionSignal({ source: 'bind', payload: { kind: 'nonsense' } }), null);
  assert.equal(classifyAttentionSignal({ source: 'bind', payload: null }), null);
});

test('a bind signal beats the OSC-9 heuristic, both ways round (#529)', () => {
  // Precedence is written as "is it osc9", not as a list of the structured sources — so a source added
  // later cannot lose to a spinner frame on the day it appears.
  const osc9 = { kind: 'needs-attention', reason: 'spinner said something', source: 'osc9' };
  const bind = { kind: 'needs-attention', reason: 'Waiting for you to confirm', source: 'bind' };
  assert.deepEqual(reduceAttention(osc9, bind), bind);
  assert.deepEqual(reduceAttention(bind, osc9), bind);
});
