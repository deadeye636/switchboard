// #233's acceptance line: "a row whose backend declines subagents does not resolve to a Claude store path."
//
// WHY THIS EXISTS:
//   `read-subagent-jsonl` and `start-subagent-watch` used to resolve a subagent's file by calling Claude's
//   `resolveJsonlPath` directly, against Claude's store root. It was harmless only because Claude is the
//   only backend declaring supportsSubagents — the first other one would have had its rows resolved inside
//   Claude's store. The routing now goes through the descriptor, and this pins the three ways that has to
//   behave: the owner resolves, a decliner is never asked, and nothing at all fails safe.
//
//   It is a separate module from main.js precisely so it can be loaded here (main.js requires Electron).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveSubagentFile } = require('../src/session/subagent-transcript');

const CLAUDE_STORE = '/store/claude/projects/proj/parent-1/subagents/agent-a1.jsonl';

// A backend that owns subagents: mints its own row id and resolves its own path.
function ownerBackend(overrides = {}) {
  return {
    id: 'claude', label: 'Claude', supportsSubagents: true,
    subagentSessionId: (p, a) => `sub:${p}:${a}`,
    transcriptPathFor: () => CLAUDE_STORE,
    ...overrides,
  };
}

// A backend that says it has no subagents. It must never be asked for an id, and its rows must never be
// resolved by someone else's hook.
function declining(id) {
  return {
    id, label: id, supportsSubagents: false,
    subagentSessionId: () => { throw new Error(`${id} must not be asked to mint a subagent id`); },
    transcriptPathFor: () => `/store/${id}/wrong.jsonl`,
  };
}

const registry = (...list) => ({ list: () => list });

test('the owning backend resolves its own subagent transcript', () => {
  const rows = { 'sub:parent-1:a1': { sessionId: 'sub:parent-1:a1', folder: 'proj' } };
  const res = resolveSubagentFile(
    { backends: registry(ownerBackend()), getCachedSession: (k) => rows[k] || null },
    'parent-1', 'a1',
  );
  assert.deepEqual(res, { filePath: CLAUDE_STORE });
});

test('a backend that declines subagents is never asked — and its row never resolves to another store', () => {
  // The row exists under the DECLINER's own id shape. Nothing may resolve it, and asking the decliner to
  // mint an id would throw (see `declining`), so a green run also proves it was skipped, not just missed.
  const rows = { 'codex:parent-1:a1': { sessionId: 'codex:parent-1:a1', folder: 'proj' } };
  const res = resolveSubagentFile(
    { backends: registry(declining('codex'), declining('hermes')), getCachedSession: (k) => rows[k] || null },
    'parent-1', 'a1',
  );
  assert.ok(res.error, 'a declining backend must not produce a path');
  assert.equal(res.filePath, undefined);
});

test('a decliner sitting BEFORE the owner does not shadow it', () => {
  const rows = { 'sub:parent-1:a1': { sessionId: 'sub:parent-1:a1', folder: 'proj' } };
  const res = resolveSubagentFile(
    { backends: registry(declining('codex'), ownerBackend(), declining('pi')), getCachedSession: (k) => rows[k] || null },
    'parent-1', 'a1',
  );
  assert.deepEqual(res, { filePath: CLAUDE_STORE });
});

test('no cached row: an error, not a reconstructed path', () => {
  const res = resolveSubagentFile(
    { backends: registry(ownerBackend()), getCachedSession: () => null },
    'parent-1', 'a1',
  );
  assert.match(res.error, /not found in cache/);
});

test('an owner that cannot say where the transcript lives says so rather than returning nothing', () => {
  const rows = { 'sub:parent-1:a1': { sessionId: 'sub:parent-1:a1' } };
  const res = resolveSubagentFile(
    { backends: registry(ownerBackend({ transcriptPathFor: () => null })), getCachedSession: (k) => rows[k] || null },
    'parent-1', 'a1',
  );
  assert.match(res.error, /cannot say where/);
});

test('a backend whose id minting throws is skipped, not fatal', () => {
  const rows = { 'sub:parent-1:a1': { sessionId: 'sub:parent-1:a1' } };
  const broken = ownerBackend({ id: 'broken', subagentSessionId: () => { throw new Error('boom'); } });
  const res = resolveSubagentFile(
    { backends: registry(broken, ownerBackend()), getCachedSession: (k) => rows[k] || null },
    'parent-1', 'a1',
  );
  assert.deepEqual(res, { filePath: CLAUDE_STORE });
});

test('missing parent or agent id resolves nothing', () => {
  const deps = { backends: registry(ownerBackend()), getCachedSession: () => ({ sessionId: 'x' }) };
  assert.ok(resolveSubagentFile(deps, '', 'a1').error);
  assert.ok(resolveSubagentFile(deps, 'parent-1', '').error);
});
