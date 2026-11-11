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

// --- lane columns, row order, connectors (T12) -------------------------------

const laneOf = (id, parent, spawn, ret, depth) => ({
  id, parentLaneId: parent, depth: depth || 1, label: id, kind: 'agent',
  spawnAnchor: { laneId: parent, stepId: spawn.id }, returnAnchor: ret ? { laneId: parent, stepId: ret.id } : null,
  summaryOnly: false, sessionRef: null,
});
const withTs = (s, ts) => Object.assign(s, { ts });
const colsOf = (lay) => Object.fromEntries(lay.columns.map((c) => [c.laneId, c.col]));

/** Two agents spawned one after the other whose steps overlap in time, under one main turn. */
function parallelSnapshot({ finished = false } = {}) {
  seq = 0;
  const p = withTs(step('prompt'), 1);
  const s1 = withTs(step('agent', { label: 'spawn a' }), 2);
  const s2 = withTs(step('agent', { label: 'spawn b' }), 3);
  const a1 = withTs(step('prompt', { laneId: 'a', turn: 1 }), 4);
  const b1 = withTs(step('prompt', { laneId: 'b', turn: 1 }), 5);
  const a2 = withTs(step('output', { laneId: 'a', turn: 1 }), 6);
  const b2 = withTs(step('output', { laneId: 'b', turn: 1 }), 7);
  const after = withTs(step('output', { turn: 2 }), 20);
  const lanes = [MAIN, laneOf('a', 'main', s1, finished ? s1 : null), laneOf('b', 'main', s2, finished ? s2 : null)];
  return { snapshot: snap([p, s1, s2, after, a1, a2, b1, b2], lanes), ids: { p, s1, s2, a1, a2, b1, b2, after } };
}

test('rows interleave: a child lane sits between its spawn row and the parent next step', () => {
  const { snapshot, ids } = parallelSnapshot();
  const lay = FL.layout(snapshot, FL.emptyCollapseState());
  const keys = lay.rows.map((r) => r.key);
  assert.deepEqual(keys, [ids.p, ids.s1, ids.s2, ids.a1, ids.b1, ids.a2, ids.b2, ids.after].map((s) => s.id));
  // Ordinal stays the order inside each lane.
  for (const lane of ['main', 'a', 'b']) {
    const ords = lay.rows.filter((r) => r.laneId === lane).map((r) => r.step.ordinal);
    assert.deepEqual(ords, ords.slice().sort((x, y) => x - y));
  }
  assert.equal(lay.order.length, snapshot.steps.length);
});

test('without timestamps a child runs to its end right after its spawn row', () => {
  const lay = FL.layout(laneSnapshot(), FL.setLaneExpanded(null, 'a1', true));
  assert.deepEqual(lay.rows.map((r) => r.laneId), ['main', 'main', 'a1', 'a1', 'a1', 'main', 'main']);
});

test('a child lane does not open or split a turn band', () => {
  const { snapshot } = parallelSnapshot();
  const lay = FL.layout(snapshot, FL.emptyCollapseState());
  assert.deepEqual(lay.turns.map((t) => t.turn), [1, 2]);
  assert.ok(lay.rows.filter((r) => r.laneId !== 'main').every((r) => r.turn === 1), 'child rows take the band they sit in');
  assert.equal(lay.rows.find((r) => r.laneId === 'a').step.turn, 1, 'the step keeps its own number');
});

test('two overlapping agents sit side by side, right of their parent', () => {
  const { snapshot } = parallelSnapshot();
  const lay = FL.layout(snapshot, FL.emptyCollapseState());
  assert.deepEqual(colsOf(lay), { main: 0, a: 1, b: 2 });
  assert.equal(lay.stats.cols, 3);
  assert.equal(lay.rows.filter((r) => r.laneStart).length, 2, 'one header row per child lane');
});

test('sequential agents share a column (a free column is reused)', () => {
  seq = 0;
  const s1 = step('agent');
  const x1 = step('output', { laneId: 'a' });
  const s2 = step('agent');
  const x2 = step('output', { laneId: 'b' });
  const lay = FL.layout(snap([s1, x1, s2, x2], [MAIN, laneOf('a', 'main', s1), laneOf('b', 'main', s2)]));
  assert.deepEqual(colsOf(lay), { main: 0, a: 1, b: 1 });
});

test('nesting two deep: each lane one column right of its parent', () => {
  seq = 0;
  const s1 = step('agent');
  const x = step('prompt', { laneId: 'a1' });
  const s2 = step('agent', { laneId: 'a1' });
  const y = step('output', { laneId: 'a2' });
  const z = step('output', { laneId: 'a1' });
  const lay = FL.layout(snap([s1, x, s2, y, z], [MAIN, laneOf('a1', 'main', s1), laneOf('a2', 'a1', s2, null, 2)]));
  assert.deepEqual(colsOf(lay), { main: 0, a1: 1, a2: 2 });
  assert.deepEqual(lay.rows.map((r) => r.laneId), ['main', 'a1', 'a1', 'a2', 'a1']);
  assert.equal(lay.rows[3].col, 2);
});

test('a finished parallel pair collapses to one summary row each', () => {
  const { snapshot } = parallelSnapshot({ finished: true });
  const lay = FL.layout(snapshot, FL.emptyCollapseState());
  assert.equal(lay.rows.filter((r) => r.kind === 'lane').length, 2);
  assert.deepEqual(lay.rows.map((r) => r.kind), ['step', 'step', 'step', 'lane', 'lane', 'step']);
  assert.equal(lay.stats.hiddenSteps, 4);
});

// Graph shape: rails, dots and bars live in the gutter on the left (x < gutterWidth(cols)); every card is the box to
// the right of it, one per row. A connector touches no card when every box it is drawn as ends inside the gutter, and
// that holds for the rails as well as the edges. The turn of a spawn / return is in the gap just outside a row.
const ROW = 40;
function cardRects(lay) {
  const x = FL.gutterWidth(lay.stats.cols);
  return lay.rows.map((r, i) => ({ x, y: i * ROW, w: 100000, h: ROW }));
}
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function crossings(lay) {
  const cards = cardRects(lay);
  const bad = [];
  const gutter = FL.gutterWidth(lay.stats.cols);
  const all = FL.connectorsForRows(lay, 0, lay.rows.length, 100000);
  assert.equal(all.truncated, false);
  for (const c of all.connectors) {
    for (const r of FL.connectorRects(c, ROW)) {
      if (r.x < 0 || r.x + r.w > gutter) bad.push({ c: c.type + ':' + c.laneId, why: 'outside the gutter', r });
      for (const card of cards) if (overlaps(r, card)) { bad.push({ c: c.type + ':' + c.laneId, why: 'over a card', r }); break; }
    }
  }
  for (const e of lay.edges) {
    if (e.kind === 'spawn') assert.equal(e.gapRow, e.toRow);
    else assert.equal(e.gapRow, e.fromRow + 1);
  }
  return bad;
}

test('no rail or connector touches a card (parallel, nested and sequential layouts)', () => {
  const { snapshot } = parallelSnapshot();
  const lay0 = FL.layout(snapshot);
  assert.ok(FL.connectorsForRows(lay0, 0, 99).connectors.some((c) => c.type === 'rail'), 'rails are checked too');
  assert.deepEqual(crossings(lay0), []);
  const nested = laneSnapshot({ returned: false });
  assert.deepEqual(crossings(FL.layout(nested)), []);
  const open = laneSnapshot();
  assert.deepEqual(crossings(FL.layout(open, FL.setLaneExpanded(null, 'a1', true))), []);
  seq = 0;
  const sp = withTs(step('agent'), 1);
  const other = withTs(step('agent', { laneId: 'o' }), 2);
  const c1 = withTs(step('output', { laneId: 'c' }), 3);
  const o2 = withTs(step('output', { laneId: 'o' }), 4);
  const lanes = [MAIN, laneOf('o', 'main', sp), laneOf('c', 'main', sp)];
  const lay = FL.layout(snap([sp, other, c1, o2], lanes));
  assert.deepEqual(crossings(lay), []);
  assert.equal(new Set(lay.columns.map((c) => c.col)).size, 3);
});

test('the checker really sees a card hit (a connector moved into the card area)', () => {
  const { snapshot } = parallelSnapshot();
  const lay = FL.layout(snapshot);
  const rect = FL.connectorRects(FL.connectorsForRows(lay, 0, 9).connectors.find((c) => c.type === 'rail'), ROW)[0];
  const moved = Object.assign({}, rect, { x: FL.gutterWidth(lay.stats.cols) + 4 });
  assert.ok(cardRects(lay).some((card) => overlaps(moved, card)));
});

test('connectors in a window: a long vertical that passes through is still listed', () => {
  const { snapshot } = parallelSnapshot();
  const lay = FL.layout(snapshot);
  const ret = FL.connectorsForRows(lay, 5, 5).connectors; // no return edge on open lanes; spawn edges end at rows 3 and 4
  assert.deepEqual(ret.filter((c) => c.type !== 'rail'), []);
  const spawns = FL.connectorsForRows(lay, 2, 2).connectors.filter((c) => c.type === 'spawn');
  assert.equal(spawns.length, 2, 'spawn b starts here; spawn a runs down the parent gutter through here');
});

test('a lane is waiting only when the snapshot says so', () => {
  const { snapshot } = parallelSnapshot();
  assert.ok(FL.layout(snapshot).rails.every((r) => !('waiting' in r)));
  snapshot.lanes[1].waiting = true;
  const lay = FL.layout(snapshot);
  assert.equal(lay.rails.find((r) => r.laneId === 'a').waiting, true);
  assert.equal(FL.connectorsForRows(lay, 0, 9).connectors.find((c) => c.type === 'rail' && c.laneId === 'a').waiting, true);
});

test('a lane whose spawn step is missing is appended, not lost', () => {
  seq = 0;
  const a = step('prompt');
  const lost = step('agent'); // not in the snapshot
  const x = step('output', { laneId: 'o' });
  const lay = FL.layout(snap([a, x], [MAIN, laneOf('o', 'main', lost)]));
  assert.deepEqual(lay.rows.map((r) => r.laneId), ['main', 'o']);
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
  assert.ok(runs[3] < 80, `median layout ${runs[3]} ms`); // measured about 12 ms; the ceiling catches a real regression, not load noise
});

test('layout of 200 overlapping lanes (20 000 steps) stays inside the ceiling', () => {
  seq = 0;
  const lanes = [MAIN];
  const steps = [];
  const spawns = [];
  for (let i = 0; i < 200; i++) { const sp = withTs(step('agent'), i); spawns.push(sp); steps.push(sp); }
  for (let i = 0; i < 200; i++) {
    lanes.push(laneOf('c' + i, 'main', spawns[i], i % 2 ? spawns[i] : null));
    for (let k = 0; k < 99; k++) steps.push(withTs(step(k % 3 ? 'tool' : 'output', { laneId: 'c' + i, tool: 'Read' }), 1000 + k * 7 + i));
  }
  const s = snap(steps, lanes);
  const runs = [];
  let lay;
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint();
    lay = FL.layout(s, FL.emptyCollapseState());
    runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  runs.sort((a, b) => a - b);
  console.log(`flow-layout: ${steps.length} steps, 200 parallel lanes -> ${lay.rows.length} rows, ${lay.stats.cols} columns; layout min ${runs[0].toFixed(2)} ms, median ${runs[2].toFixed(2)} ms`);
  assert.equal(lay.order.length, steps.length);
  assert.ok(runs[2] < 250, `median layout ${runs[2]} ms`); // measured about 50 ms with 200 lanes active at once
});

test('two adjacent spawn calls stay two rows, each with its own connector (never a run)', () => {
  seq = 0;
  const s1 = tool('Agent');
  const s2 = tool('Agent');
  const x1 = step('output', { laneId: 'a' });
  const x2 = step('output', { laneId: 'b' });
  const lay = FL.layout(snap([s1, s2, x1, x2], [MAIN, laneOf('a', 'main', s1), laneOf('b', 'main', s2)]));
  assert.deepEqual(kinds(lay), ['step', 'step', 'step', 'step']);
  const spawns = lay.edges.filter((e) => e.kind === 'spawn');
  assert.equal(spawns.length, 2);
  assert.notEqual(spawns[0].fromRow, spawns[1].fromRow);
  // A return anchor is never grouped either, and plain equivalent calls around them still are.
  const t1 = tool('Read');
  const t2 = tool('Read');
  const r = tool('Agent');
  const r2 = tool('Agent');
  const c = step('output', { laneId: 'c' });
  const lay2 = FL.layout(snap([t1, t2, r, r2, c], [MAIN, laneOf('c', 'main', r, r2)]));
  assert.deepEqual(kinds(lay2), ['group', 'step', 'lane', 'step']); // the finished lane is one summary between its two anchors
});

test('a capped window keeps the spawn and return edges and drops rails first', () => {
  const { snapshot } = parallelSnapshot({ finished: false });
  const lay = FL.layout(snapshot);
  const all = FL.connectorsForRows(lay, 0, 99, 1000);
  const edges = all.connectors.filter((c) => c.type !== 'rail').length;
  const capped = FL.connectorsForRows(lay, 0, 99, edges);
  assert.equal(capped.truncated, true);
  assert.equal(capped.connectors.filter((c) => c.type !== 'rail').length, edges);
  assert.equal(capped.connectors.filter((c) => c.type === 'rail').length, 0);
});

test('a second root lane keeps snapshot order and does not jump before main', () => {
  seq = 0;
  const a = step('prompt');
  const b = step('output');
  const x = step('prompt', { laneId: 'r2' });
  const root2 = { id: 'r2', parentLaneId: null, depth: 0, label: 'r2', kind: 'session', spawnAnchor: null, returnAnchor: null, summaryOnly: false, sessionRef: null };
  const lay = FL.layout(snap([a, b, x], [MAIN, root2]));
  assert.deepEqual(lay.rows.map((r) => r.laneId), ['main', 'main', 'r2']);
});

test('gutter geometry: one column per lane in use, the dot on the rail', () => {
  assert.equal(FL.gutterWidth(1), FL.COL_W + 20);
  assert.equal(FL.gutterWidth(3), 3 * FL.COL_W + 20);
  assert.equal(FL.railX(2) - FL.dotX(2), 3); // an 8 px dot is centred on a 2 px rail
});
