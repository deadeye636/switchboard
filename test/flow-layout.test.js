const { test } = require('node:test');
const assert = require('node:assert/strict');
const FS = require('../src/shared/flow-snapshot.js');
const FL = require('../src/shared/flow-layout.js');

const MAIN = { id: 'main', parentLaneId: null, depth: 0, label: 'main', kind: 'main', spawnAnchor: null, returnAnchor: null, summaryOnly: false, sessionRef: null };

let seq = 0;
function step(kind, o = {}) {
  const line = o.line != null ? o.line : ++seq;
  const laneId = o.laneId || 'main';
  return {
    id: FS.flowStepId(laneId, { sourceId: 'f', line, byteOffset: line * 10 }, 0),
    laneId, ordinal: line, turn: o.turn == null ? 1 : o.turn, kind, label: o.label || kind,
    ts: null, source: { sourceId: 'f', line, byteOffset: line * 10 }, checkpoint: null, tokens: null,
    flags: o.flags || [], detail: o.tool ? { tool: o.tool } : {},
  };
}
function snap(steps, lanes) {
  const s = FS.emptyFlowSnapshot();
  s.snapshotId = 't';
  s.lanes = lanes || [MAIN];
  s.steps = steps;
  return s;
}
const tool = (name, o) => step('tool', Object.assign({ tool: name }, o));
const kinds = (lay) => lay.rows.map((r) => r.kind);

test('equivalent adjacent tool calls collapse into one group with a count', () => {
  const s = snap([step('prompt'), tool('Read'), tool('Read'), tool('Read')]);
  const lay = FL.layout(s, FL.emptyCollapseState());
  assert.deepEqual(kinds(lay), ['step', 'group']);
  assert.equal(lay.rows[1].count, 3);
  assert.equal(lay.rows[1].tool, 'Read');
  assert.equal(lay.rows[1].key, 'g:' + s.steps[1].id);
  assert.equal(lay.rows[1].firstStepId, s.steps[1].id);
});

test('a lone tool call stays a plain step row', () => {
  const lay = FL.layout(snap([tool('Read'), tool('Bash'), tool('Read')]), null);
  assert.deepEqual(kinds(lay), ['step', 'step', 'step']);
});

test('O7: a different tool, a different turn or a flag splits the run', () => {
  const diffTool = FL.layout(snap([tool('Read'), tool('Read'), tool('Edit'), tool('Edit')]));
  assert.deepEqual(kinds(diffTool), ['group', 'group']);
  const diffTurn = FL.layout(snap([tool('Read', { turn: 1 }), tool('Read', { turn: 2 })]));
  assert.deepEqual(kinds(diffTurn), ['step', 'step']);
  const flag = { axis: 'risk', code: 'rm', why: 'x', evidence: 'heuristic' };
  const flagged = FL.layout(snap([tool('Bash'), tool('Bash', { flags: [flag] }), tool('Bash'), tool('Bash')]));
  assert.deepEqual(kinds(flagged), ['step', 'step', 'group']);
  assert.equal(flagged.rows[1].flags[0], flag);
});

test('the label stands in for the tool when detail.tool is missing', () => {
  const a = step('tool', { label: 'Grep' });
  const b = step('tool', { label: 'Grep' });
  const c = step('tool', { label: 'Glob' });
  assert.deepEqual(kinds(FL.layout(snap([a, b, c]))), ['group', 'step']);
});

test('never collapsed across a prompt, mode change, compaction, spawn, return, failure or interrupt', () => {
  const fail = { axis: 'outcome', code: 'failed', why: 'x', evidence: 'structured' };
  const breakers = {
    prompt: () => step('prompt', { turn: 1 }),
    mode: () => step('mode'),
    compaction: () => step('compaction'),
    spawn: () => step('agent', { label: 'spawn' }),
    return: () => step('agent', { label: 'return' }),
    interrupt: () => step('interrupt'),
    failure: () => tool('Read', { flags: [fail] }),
  };
  for (const [name, make] of Object.entries(breakers)) {
    const lay = FL.layout(snap([tool('Read'), tool('Read'), make(), tool('Read'), tool('Read')]));
    const groups = lay.rows.filter((r) => r.kind === 'group');
    assert.equal(groups.length, 2, `${name}: two groups, one each side`);
    assert.ok(groups.every((g) => g.count === 2), `${name}: nothing merged across`);
    assert.equal(lay.rows.length, 3, `${name}: group, breaker, group`);
  }
});

test('a prompt that does not change the turn number still splits a run', () => {
  const lay = FL.layout(snap([tool('Read', { turn: 1 }), step('prompt', { turn: 1 }), tool('Read', { turn: 1 })]));
  assert.deepEqual(kinds(lay), ['step', 'step', 'step']);
});

test('expanding one group changes only that group', () => {
  const s = snap([tool('Read'), tool('Read'), step('output'), tool('Edit'), tool('Edit'), tool('Edit')]);
  const closed = FL.layout(s, FL.emptyCollapseState());
  const k1 = closed.rows[0].key;
  const open = FL.layout(s, FL.setGroupExpanded(FL.emptyCollapseState(), k1, true));
  assert.deepEqual(open.rows.map((r) => r.kind), ['group', 'step', 'step', 'step', 'group']);
  assert.equal(open.rows[0].expanded, true);
  assert.equal(open.rows[1].depth, 1);
  assert.equal(open.rows[1].groupKey, k1);
  const keys = (l) => l.rows.map((r) => r.key);
  const memberIds = new Set([s.steps[0].id, s.steps[1].id, k1]);
  assert.deepEqual(keys(open).filter((k) => !memberIds.has(k)), keys(closed).filter((k) => k !== k1));
  assert.equal(open.rows[4].expanded, false);
  assert.equal(open.rows[4].count, 3);
  // collapsing again returns the original rows
  const back = FL.layout(s, FL.setGroupExpanded(FL.setGroupExpanded(FL.emptyCollapseState(), k1, true), k1, false));
  assert.deepEqual(keys(back), keys(closed));
});

test('state helpers do not mutate their input', () => {
  const st = FL.emptyCollapseState();
  const next = FL.setLaneExpanded(FL.setGroupExpanded(st, 'g:x', true), 'a', false);
  // The maps have no prototype (see the prototype-names test), so compare their own entries.
  const plain = (s) => ({ groups: { ...s.groups }, lanes: { ...s.lanes } });
  assert.deepEqual(plain(st), { groups: {}, lanes: {} });
  assert.deepEqual(plain(next), { groups: { 'g:x': true }, lanes: { a: false } });
});

test('keys are stable across a re-layout, a re-read and a grown tail', () => {
  const mk = () => [step('prompt', { line: 1 }), tool('Read', { line: 2 }), tool('Read', { line: 3 }), step('output', { line: 4 })];
  const a = FL.layout(snap(mk()));
  const b = FL.layout(snap(mk()));
  assert.deepEqual(a.rows.map((r) => r.key), b.rows.map((r) => r.key));
  const grown = mk();
  grown.push(tool('Read', { line: 5 }), tool('Read', { line: 6 }));
  const c = FL.layout(snap(grown));
  assert.deepEqual(c.rows.slice(0, 3).map((r) => r.key), a.rows.slice(0, 3).map((r) => r.key));
  const longer = mk();
  longer.splice(3, 0, tool('Read', { line: 9 }));
  const d = FL.layout(snap(longer));
  assert.equal(d.rows[1].key, a.rows[1].key, 'a group that grows keeps its key');
  assert.equal(FL.findRowIndex(a, a.rows[2].key), 2);
  assert.equal(FL.findRowIndex(a, 'nope'), -1);
});

test('turns are grouped by row range', () => {
  const lay = FL.layout(snap([
    step('prompt', { turn: 1 }), tool('Read', { turn: 1 }), tool('Edit', { turn: 1 }),
    step('prompt', { turn: 2 }), tool('Read', { turn: 2 }),
  ]));
  assert.deepEqual(lay.turns, [
    { turn: 1, startRow: 0, endRow: 2 },
    { turn: 2, startRow: 3, endRow: 4 },
  ]);
});

// --- lanes --------------------------------------------------------------

function laneSnapshot({ returned = true } = {}) {
  seq = 0;
  const p = step('prompt');
  const spawn = step('agent', { label: 'spawn' });
  const c1 = step('prompt', { laneId: 'a1' });
  const c2 = tool('Bash', { laneId: 'a1', flags: [{ axis: 'risk', code: 'rm', why: 'deletes', evidence: 'heuristic' }] });
  const c3 = tool('Read', { laneId: 'a1' });
  const ret = step('agent', { label: 'return' });
  const after = tool('Read');
  const lane = {
    id: 'a1', parentLaneId: 'main', depth: 1, label: 'helper', kind: 'agent',
    spawnAnchor: { laneId: 'main', stepId: spawn.id },
    returnAnchor: returned ? { laneId: 'main', stepId: ret.id } : null,
    summaryOnly: false, sessionRef: null,
  };
  return snap([p, spawn, c1, c2, c3, ret, after], [MAIN, lane]);
}

test('a finished agent lane is collapsed by default into one summary row', () => {
  const lay = FL.layout(laneSnapshot());
  assert.deepEqual(kinds(lay), ['step', 'step', 'lane', 'step', 'step']);
  const lane = lay.rows[2];
  assert.equal(lane.key, 'l:a1');
  assert.equal(lane.count, 3);
  assert.equal(lane.col, 1);
  assert.equal(lay.columns.length, 2);
  assert.equal(lay.columns[1].collapsed, true);
});

test('a collapsed lane inherits its members flags, keeping axis and evidence', () => {
  const lay = FL.layout(laneSnapshot());
  assert.deepEqual(lay.rows[2].flags, [{ axis: 'risk', code: 'rm', why: 'deletes', evidence: 'heuristic', count: 1 }]);
});

test('an unfinished lane is open by default; the state toggles it', () => {
  const open = FL.layout(laneSnapshot({ returned: false }));
  assert.equal(open.rows.filter((r) => r.kind === 'lane').length, 0);
  assert.equal(open.rows.filter((r) => r.laneId === 'a1').length, 3);
  const closed = FL.layout(laneSnapshot({ returned: false }), FL.setLaneExpanded(null, 'a1', false));
  assert.equal(closed.rows.filter((r) => r.kind === 'lane').length, 1);
  const expanded = FL.layout(laneSnapshot(), FL.setLaneExpanded(null, 'a1', true));
  assert.deepEqual(kinds(expanded), ['step', 'step', 'step', 'step', 'step', 'step', 'step']);
});

test('a lane below a collapsed lane has no column and no row; its steps are counted', () => {
  seq = 0;
  const spawn = step('agent');
  const x = step('prompt', { laneId: 'a1' });
  const sub = step('agent', { laneId: 'a1' });
  const y = tool('Read', { laneId: 'a2' });
  const y2 = tool('Read', { laneId: 'a2' });
  const a1 = { id: 'a1', parentLaneId: 'main', depth: 1, label: 'one', kind: 'agent', spawnAnchor: { laneId: 'main', stepId: spawn.id }, returnAnchor: { laneId: 'main', stepId: spawn.id }, summaryOnly: false, sessionRef: null };
  const a2 = { id: 'a2', parentLaneId: 'a1', depth: 2, label: 'two', kind: 'agent', spawnAnchor: { laneId: 'a1', stepId: sub.id }, returnAnchor: null, summaryOnly: false, sessionRef: null };
  const lay = FL.layout(snap([spawn, x, sub, y, y2], [MAIN, a1, a2]));
  assert.deepEqual(kinds(lay), ['step', 'lane']);
  assert.equal(lay.rows[1].count, 4);
  assert.deepEqual(lay.columns.map((c) => c.laneId), ['main', 'a1']);
  assert.equal(lay.stats.hiddenSteps, 4);
});

// --- connectors ---------------------------------------------------------

test('a single lane is one rail, not a path per step', () => {
  const steps = [];
  for (let i = 0; i < 500; i++) steps.push(i % 2 ? tool('Read') : tool('Edit'));
  const lay = FL.layout(snap(steps));
  assert.equal(lay.rails.length, 1);
  assert.equal(lay.edges.length, 0);
  const r = FL.connectorsForRows(lay, 100, 140);
  assert.deepEqual(r.connectors, [{ type: 'rail', laneId: 'main', col: 0, fromRow: 100, toRow: 140 }]);
});

test('connectorsForRows returns only edges with an endpoint in the window', () => {
  const lay = FL.layout(laneSnapshot(), FL.setLaneExpanded(null, 'a1', true));
  // rows: 0 prompt, 1 spawn, 2..4 lane steps, 5 return, 6 read
  const spawn = lay.edges.find((e) => e.kind === 'spawn');
  const ret = lay.edges.find((e) => e.kind === 'return');
  assert.equal(spawn.fromRow, 1);
  assert.equal(spawn.toRow, 2);
  assert.equal(ret.fromRow, 4);
  assert.equal(ret.toRow, 5);
  const types = (a, b) => FL.connectorsForRows(lay, a, b).connectors.map((c) => c.type).sort();
  assert.deepEqual(types(0, 0), ['rail']);
  assert.deepEqual(types(1, 1), ['rail', 'spawn']);
  assert.deepEqual(types(3, 3), ['rail', 'rail']);
  assert.deepEqual(types(5, 6), ['rail', 'return']);
  assert.deepEqual(types(6, 0), types(0, 6));
});

test('edges of a collapsed lane run to its summary row', () => {
  const lay = FL.layout(laneSnapshot());
  const spawn = lay.edges.find((e) => e.kind === 'spawn');
  const ret = lay.edges.find((e) => e.kind === 'return');
  assert.equal(spawn.toRow, 2);
  assert.equal(ret.fromRow, 2);
  assert.equal(ret.toRow, 3);
});

test('connectorsForRows honours the cap and says it truncated', () => {
  const lanes = [MAIN];
  const steps = [];
  for (let i = 0; i < 300; i++) {
    const sp = step('agent');
    const ch = step('output', { laneId: 'c' + i });
    lanes.push({ id: 'c' + i, parentLaneId: 'main', depth: 1, label: 'c', kind: 'agent', spawnAnchor: { laneId: 'main', stepId: sp.id }, returnAnchor: null, summaryOnly: false, sessionRef: null });
    steps.push(sp, ch);
  }
  const lay = FL.layout(snap(steps, lanes));
  const all = FL.connectorsForRows(lay, 0, lay.rows.length, 100000);
  assert.equal(all.connectors.length, 301 + 300);
  assert.equal(all.truncated, false);
  const capped = FL.connectorsForRows(lay, 0, lay.rows.length, 50);
  assert.equal(capped.connectors.length, 50);
  assert.equal(capped.truncated, true);
  assert.equal(FL.connectorsForRows(lay, 0, lay.rows.length).connectors.length, FL.DEFAULT_CONNECTOR_CAP);
});

test('collapse state treats prototype names as ordinary keys', () => {
  let state = FL.emptyCollapseState();
  state = FL.setLaneExpanded(state, '__proto__', true);
  state = FL.setGroupExpanded(state, 'constructor', true);
  assert.equal(Object.prototype.hasOwnProperty.call(state.lanes, '__proto__'), true, '__proto__ is stored, not swallowed');
  assert.equal(state.lanes.__proto__, true);
  assert.equal(state.groups.constructor, true);
  assert.equal(Object.getPrototypeOf(FL.emptyCollapseState().lanes), null, 'no inherited keys to read by accident');
});

test('an empty snapshot lays out to nothing', () => {
  const lay = FL.layout(FS.emptyFlowSnapshot());
  assert.deepEqual(lay.rows, []);
  assert.deepEqual(FL.connectorsForRows(lay, 0, 10), { connectors: [], truncated: false });
});

// --- performance ----------------------------------------------------------

test('layout of 20 000 steps stays far inside a generous ceiling', () => {
  seq = 0;
  const steps = [];
  const names = ['Read', 'Edit', 'Bash', 'Grep'];
  for (let t = 0; steps.length < 20000; t++) {
    steps.push(step('prompt', { turn: t }));
    const n = 6 + (t % 7);
    for (let k = 0; k < n; k++) steps.push(tool(names[(t + (k >> 1)) % 4], { turn: t }));
    steps.push(step('output', { turn: t }));
  }
  const s = snap(steps);
  assert.equal(FS.validateSnapshot(s).ok, true);
  const runs = [];
  let lay;
  for (let i = 0; i < 7; i++) {
    const t0 = process.hrtime.bigint();
    lay = FL.layout(s, FL.emptyCollapseState());
    runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const t1 = process.hrtime.bigint();
  FL.connectorsForRows(lay, 1000, 1040);
  const conn = Number(process.hrtime.bigint() - t1) / 1e6;
  runs.sort((a, b) => a - b);
  console.log(`flow-layout: ${steps.length} steps -> ${lay.rows.length} rows; layout min ${runs[0].toFixed(2)} ms, median ${runs[3].toFixed(2)} ms, max ${runs[6].toFixed(2)} ms; connectorsForRows ${conn.toFixed(3)} ms`);
  assert.ok(lay.rows.length < steps.length, 'runs collapsed');
  assert.ok(runs[3] < 200, `median layout ${runs[3]} ms`);
});
