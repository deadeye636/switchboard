'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  applySubagentEdge,
  isSubagentLive,
  liveSubagentCount,
  liveSubagentParents,
} = require('../src/renderer/session/subagent-live.js');

const P = 'parent-1';

test('a spawn edge makes the agent live and reports the flip', () => {
  const live = new Map();
  assert.strictEqual(applySubagentEdge(live, P, 'a1', true, 'scan'), true);
  assert.strictEqual(isSubagentLive(live, P, 'a1'), true);
});

test('a repeated spawn edge from the same source is not a flip', () => {
  const live = new Map();
  applySubagentEdge(live, P, 'a1', true, 'scan');
  assert.strictEqual(applySubagentEdge(live, P, 'a1', true, 'scan'), false);
});

test('the scan may retract what the scan set', () => {
  const live = new Map();
  applySubagentEdge(live, P, 'a1', true, 'scan');
  assert.strictEqual(applySubagentEdge(live, P, 'a1', false, 'scan'), true);
  assert.strictEqual(isSubagentLive(live, P, 'a1'), false);
});

test('the scan must not retract a hook-tracked subagent (#121)', () => {
  // A subagent inside a long tool call writes nothing, so the stable-mtime
  // heuristic declares it finished while it is still running.
  const live = new Map();
  applySubagentEdge(live, P, 'a1', true, 'hook');
  assert.strictEqual(applySubagentEdge(live, P, 'a1', false, 'scan'), false);
  assert.strictEqual(isSubagentLive(live, P, 'a1'), true, 'hook-tracked agent stays live');
});

test('SubagentStop retracts a hook-tracked subagent', () => {
  const live = new Map();
  applySubagentEdge(live, P, 'a1', true, 'hook');
  assert.strictEqual(applySubagentEdge(live, P, 'a1', false, 'hook'), true);
  assert.strictEqual(isSubagentLive(live, P, 'a1'), false);
});

test('a hook may retract what the scan set', () => {
  const live = new Map();
  applySubagentEdge(live, P, 'a1', true, 'scan');
  assert.strictEqual(applySubagentEdge(live, P, 'a1', false, 'hook'), true);
});

test('a later scan sighting cannot downgrade hook ownership', () => {
  // Otherwise the scan would regain the right to retract the agent.
  const live = new Map();
  applySubagentEdge(live, P, 'a1', true, 'hook');
  assert.strictEqual(applySubagentEdge(live, P, 'a1', true, 'scan'), false, 'no visible flip');
  assert.strictEqual(applySubagentEdge(live, P, 'a1', false, 'scan'), false, 'still hook-owned');
  assert.strictEqual(isSubagentLive(live, P, 'a1'), true);
});

test('a hook sighting upgrades a scan-owned entry without a repaint', () => {
  const live = new Map();
  applySubagentEdge(live, P, 'a1', true, 'scan');
  assert.strictEqual(applySubagentEdge(live, P, 'a1', true, 'hook'), false, 'already visible');
  assert.strictEqual(applySubagentEdge(live, P, 'a1', false, 'scan'), false, 'now hook-owned');
});

test('retracting an unknown agent is a no-op', () => {
  const live = new Map();
  assert.strictEqual(applySubagentEdge(live, P, 'ghost', false, 'hook'), false);
});

test('junk input is ignored', () => {
  const live = new Map();
  assert.strictEqual(applySubagentEdge(live, null, 'a1', true), false);
  assert.strictEqual(applySubagentEdge(live, P, null, true), false);
  assert.strictEqual(applySubagentEdge(null, P, 'a1', true), false);
  assert.strictEqual(live.size, 0);
});

test('count and parents are derived per parent session', () => {
  const live = new Map();
  applySubagentEdge(live, P, 'a1', true, 'hook');
  applySubagentEdge(live, P, 'a2', true, 'scan');
  applySubagentEdge(live, 'parent-2', 'a3', true, 'hook');
  assert.strictEqual(liveSubagentCount(live, P), 2);
  assert.strictEqual(liveSubagentCount(live, 'parent-2'), 1);
  assert.strictEqual(liveSubagentCount(live, 'parent-3'), 0);
  assert.deepStrictEqual([...liveSubagentParents(live)].sort(), ['parent-1', 'parent-2']);
});
