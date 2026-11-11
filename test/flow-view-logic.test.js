'use strict';
// Pure helpers of the Flow tab (spec 46, T8 + T9) and a jsdom smoke test of the windowing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const FlowView = require('../src/renderer/session/flow-view.js');
const FlowLayout = require('../src/shared/flow-layout.js');

const ROW = FlowView.ROW_H;

function mkStep(i, over) {
  return Object.assign({
    id: 's' + i, laneId: 'main', ordinal: i, turn: 1, kind: 'tool', label: 'Bash ' + i, ts: null,
    source: { sourceId: 'a', line: i, byteOffset: i }, checkpoint: null, tokens: null, flags: [], detail: { tool: 'Bash' },
  }, over || {});
}
function mkSnap(steps) {
  const caps = {};
  for (const id of ['agents', 'instructionFiles', 'contextCheckpoints', 'permissionMode', 'approvals', 'compaction', 'interrupt', 'destructivePatterns', 'timestamps']) {
    caps[id] = { state: id === 'instructionFiles' ? 'perFile' : 'yes', limitationId: null };
  }
  return {
    schemaVersion: 1, snapshotId: 'x', fingerprint: null, capabilities: caps, limitations: [],
    lanes: [{ id: 'main', parentLaneId: null, depth: 0, label: 'Main', kind: 'main', spawnAnchor: null, returnAnchor: null }],
    steps, nextCursor: null, complete: true,
  };
}

test('computeSlice: index arithmetic with overscan, clamped', () => {
  assert.deepEqual(FlowView.computeSlice(0, 400, 40, 1000, 10), { start: 0, end: 20 });
  assert.deepEqual(FlowView.computeSlice(4000, 400, 40, 1000, 10), { start: 90, end: 120 });
  assert.deepEqual(FlowView.computeSlice(39960, 400, 40, 1000, 10), { start: 989, end: 1000 });
  assert.deepEqual(FlowView.computeSlice(0, 400, 40, 0, 10), { start: 0, end: 0 });
  assert.deepEqual(FlowView.computeSlice(-50, 0, 40, 5, 10), { start: 0, end: 5 });
});

test('buildStepRowMap: hidden group members map to their group row', () => {
  const snap = mkSnap([mkStep(0, { kind: 'prompt', label: 'hi', detail: {} }), mkStep(1), mkStep(2), mkStep(3), mkStep(4, { kind: 'output', detail: {} })]);
  const lay = FlowLayout.layout(snap, FlowLayout.emptyCollapseState());
  const map = FlowView.buildStepRowMap(snap, lay.rows);
  const g = lay.rows.findIndex((r) => r.kind === 'group');
  assert.ok(g > 0);
  for (const id of ['s1', 's2', 's3']) assert.equal(map.get(id), g);
  assert.equal(map.get('s0'), 0);
  assert.equal(map.get('s4'), g + 1);
  // Expanded: every member has a row of its own.
  const open = FlowLayout.layout(snap, FlowLayout.setGroupExpanded(FlowLayout.emptyCollapseState(), lay.rows[g].groupKey, true));
  const map2 = FlowView.buildStepRowMap(snap, open.rows);
  assert.equal(new Set([map2.get('s1'), map2.get('s2'), map2.get('s3')]).size, 3);
});

test('anchor: capture and restore keep the step and the pixel offset across a re-layout', () => {
  const steps = [];
  for (let i = 0; i < 50; i++) steps.push(mkStep(i, { kind: i % 2 ? 'output' : 'prompt', detail: {}, turn: i }));
  const snap = mkSnap(steps);
  const lay = FlowLayout.layout(snap, FlowLayout.emptyCollapseState());
  const anchor = FlowView.captureAnchor(snap, lay.rows, 10 * ROW + 7, ROW);
  assert.equal(anchor.stepId, 's10');
  assert.equal(anchor.offset, 7);
  // New steps appended: same place.
  const grown = mkSnap(steps.concat([mkStep(50, { kind: 'output', detail: {}, turn: 50 })]));
  const lay2 = FlowLayout.layout(grown, FlowLayout.emptyCollapseState());
  const map2 = FlowView.buildStepRowMap(grown, lay2.rows);
  assert.equal(FlowView.restoreAnchor(grown, lay2.rows, map2, anchor, ROW), 10 * ROW + 7);
  // The anchored step vanished: nearest surviving ordinal at or after it.
  const gone = mkSnap(steps.filter((s) => s.id !== 's10'));
  const lay3 = FlowLayout.layout(gone, FlowLayout.emptyCollapseState());
  const map3 = FlowView.buildStepRowMap(gone, lay3.rows);
  const top = FlowView.restoreAnchor(gone, lay3.rows, map3, anchor, ROW);
  assert.equal(Math.floor(top / ROW), map3.get('s11'));
  assert.equal(FlowView.restoreAnchor(gone, lay3.rows, map3, null, ROW), null);
});

test('anchor on a collapsed group row survives the group growing', () => {
  const mk = (n) => mkSnap([mkStep(0, { kind: 'prompt', detail: {} })].concat(Array.from({ length: n }, (_, i) => mkStep(i + 1))));
  const a = mk(3);
  const la = FlowLayout.layout(a, FlowLayout.emptyCollapseState());
  const anchor = FlowView.captureAnchor(a, la.rows, ROW + 3, ROW);
  assert.equal(anchor.stepId, 's1');
  const b = mk(6);
  const lb = FlowLayout.layout(b, FlowLayout.emptyCollapseState());
  assert.equal(FlowView.restoreAnchor(b, lb.rows, FlowView.buildStepRowMap(b, lb.rows), anchor, ROW), ROW + 3);
});

test('shouldPoll: all conditions, and the end-pending exception', () => {
  const on = { viewerOpen: true, flowVisible: true, windowVisible: true, running: true, endPending: false };
  assert.equal(FlowView.shouldPoll(on), true);
  for (const k of ['viewerOpen', 'flowVisible', 'windowVisible']) assert.equal(FlowView.shouldPoll({ ...on, [k]: false }), false, k);
  assert.equal(FlowView.shouldPoll({ ...on, running: false }), false);
  assert.equal(FlowView.shouldPoll({ ...on, running: false, endPending: true }), true);
  assert.equal(FlowView.shouldPoll({ ...on, running: false, endPending: true, windowVisible: false }), false);
  assert.equal(FlowView.shouldPoll(null), false);
});

test('statusMeansNewSteps', () => {
  assert.equal(FlowView.statusMeansNewSteps('grew'), true);
  assert.equal(FlowView.statusMeansNewSteps('rewritten'), true);
  assert.equal(FlowView.statusMeansNewSteps('unchanged'), false);
  assert.equal(FlowView.statusMeansNewSteps('unknown'), false);
});

test('bannerItems: limitations with the capabilities that point at them', () => {
  const snap = mkSnap([]);
  snap.limitations = [{ id: 'l1', text: 'No approvals recorded.' }, { id: 'l2', text: 'Read stopped at the cap.' }];
  snap.capabilities.approvals = { state: 'no', limitationId: 'l1' };
  snap.capabilities.instructionFiles = { state: 'block', limitationId: 'l1' };
  const items = FlowView.bannerItems(snap);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0].caps.sort(), ['Approvals', 'Instruction files']);
  assert.deepEqual(items[1].caps, []);
  assert.deepEqual(FlowView.bannerItems(mkSnap([])), []);
});

test('checkpointInfo: measured fill, estimated is labelled, unknown says so', () => {
  const step = (inp, win) => ({ checkpoint: { input: inp, window: win } });
  const m = FlowView.checkpointInfo(step({ value: 50000, basis: 'measured' }, { value: 200000, basis: 'measured' }));
  assert.equal(m.pct, 25);
  assert.equal(m.estimated, false);
  assert.match(m.text, /25%/);
  const e = FlowView.checkpointInfo(step({ value: 50000, basis: 'measured' }, { value: 1000000, basis: 'estimated' }));
  assert.equal(e.estimated, true);
  assert.match(e.text, /estimated/);
  const u = FlowView.checkpointInfo(step({ value: null, basis: 'unknown' }, { value: 1, basis: 'measured' }));
  assert.equal(u.pct, null);
  assert.match(u.text, /unknown/);
  assert.equal(FlowView.checkpointInfo({ checkpoint: null }), null);
});

test('smoke: a big snapshot keeps the DOM bounded; close drops everything', async () => {
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); } catch { return; }
  const dom = new JSDOM(`<!DOCTYPE html><body>
    <div id="timeline-viewer" style="display:flex">
      <div id="timeline-viewer-tabs"><button id="timeline-tab-events"></button><button id="timeline-tab-flow"></button></div>
      <div id="timeline-viewer-filters"></div><div id="timeline-viewer-body"></div>
      <div id="flow-view" style="display:none"><button id="flow-refresh-btn"></button><span id="flow-hint" hidden></span><span id="flow-status"></span>
        <div id="flow-banner" hidden></div><div id="flow-message" hidden></div>
        <div id="flow-scroller"><div id="flow-spacer"><div id="flow-rails"></div><div id="flow-slice"></div></div></div></div>
    </div></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const steps = [];
  for (let i = 0; i < 6000; i++) steps.push(mkStep(i, { kind: i % 2 ? 'output' : 'prompt', detail: {}, turn: i, label: 'step ' + i }));
  const snap = mkSnap(steps);
  w.api = { getSessionFlow: async () => snap, cancelSessionFlow: async () => {}, getSessionFlowStatus: async () => 'unchanged' };
  const ctx = dom.getInternalVMContext();
  for (const f of ['src/shared/flow-snapshot.js', 'src/shared/flow-layout.js', 'src/renderer/session/flow-view.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
  }
  // The scroller has no layout in jsdom: clientHeight is 0, the view falls back to its default viewport.
  w.eval(`FlowView.attach({ sessionId: 'sess1' })`);
  w.document.getElementById('timeline-tab-flow').click();
  await new Promise((r) => setTimeout(r, 20));
  const st = w.eval('FlowView.debugStats()');
  assert.equal(st.steps, 6000);
  assert.equal(st.rows, 6000);
  assert.ok(st.nodes < 1500, 'DOM bounded, got ' + st.nodes);
  assert.equal(st.timerArmed, false, 'not running: no timer');
  // Close: the viewer hidden stops everything.
  w.document.getElementById('timeline-viewer').style.display = 'none';
  await new Promise((r) => setTimeout(r, 20));
  const after = w.eval('FlowView.debugStats()');
  assert.equal(after.open, false);
  assert.equal(after.cached, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(after.observers)), { resize: false, mutation: false, visibility: false });
  w.close();
});

test('instruction card: characters and estimated tokens, worded; unknown shows nothing', () => {
  const step = { checkpoint: null, detail: { characters: 4800 }, tokens: { value: 1200, unit: 'tokens', basis: 'estimated' } };
  const info = FlowView.checkpointInfo(step);
  assert.equal(info.estimated, true);
  assert.equal(info.text, '4.8k chars · ~1.2k tokens · estimated');
  assert.equal(FlowView.checkpointInfo({ checkpoint: null, detail: {}, tokens: { value: null, basis: 'unknown' } }), null);
});

test('bannerSummary: a count, plus the window limitation when it is short', () => {
  const items = [
    { id: 'a', text: 'Subagent lanes are not drawn yet.', caps: ['Agents'] },
    { id: 'b', text: 'The window is an inference.', caps: ['Context checkpoints'] },
  ];
  assert.equal(FlowView.bannerSummary(items), '2 limitations: The window is an inference.');
  assert.equal(FlowView.bannerSummary([items[0]]), '1 limitation');
  items[1].text = 'x'.repeat(200);
  assert.equal(FlowView.bannerSummary(items), '2 limitations');
});

test('isCancelledAnswer: only an answer with no steps whose limitation is read-cancelled', () => {
  const cancelled = { steps: [], limitations: [{ id: 'read-cancelled', text: 'x' }] };
  assert.equal(FlowView.isCancelledAnswer(cancelled), true);
  assert.equal(FlowView.isCancelledAnswer({ steps: [{ id: 's' }], limitations: cancelled.limitations }), false);
  assert.equal(FlowView.isCancelledAnswer({ steps: [], limitations: [{ id: 'worker-timeout', text: 'x' }] }), false);
  assert.equal(FlowView.isCancelledAnswer(null), false);
});

test('row lookup by id and ordinal on a layout whose rows are not in ordinal order (T12)', () => {
  // Snapshot order: main steps, then the child's; the layout puts the child between the spawn row and the next main step.
  const snap = mkSnap([
    mkStep(0, { kind: 'prompt', detail: {} }),
    mkStep(1, { kind: 'agent', detail: {} }),
    mkStep(2, { kind: 'output', detail: {} }),
    mkStep(3, { laneId: 'c', kind: 'prompt', detail: {} }),
    mkStep(4, { laneId: 'c' }),
    mkStep(5, { laneId: 'c' }),
    mkStep(6, { laneId: 'c' }),
  ]);
  snap.lanes.push({ id: 'c', parentLaneId: 'main', depth: 1, label: 'helper', kind: 'agent', spawnAnchor: { laneId: 'main', stepId: 's1' }, returnAnchor: null });
  const lay = FlowLayout.layout(snap, FlowLayout.emptyCollapseState());
  assert.deepEqual(lay.rows.map((r) => r.laneId), ['main', 'main', 'c', 'c', 'main']);
  // A collapsed group of the child: its hidden members follow the group in ROW order, not in snapshot order.
  const map = FlowView.buildStepRowMap(snap, lay.rows, lay.order);
  assert.equal(map.get('s2'), 4);
  assert.equal(map.get('s3'), 2);
  assert.equal(map.get('s4'), 3);
  assert.equal(map.get('s5'), 3);
  assert.equal(map.get('s6'), 3);
  // A vanished step falls back to the nearest surviving ordinal and is then looked up by id.
  assert.equal(FlowView.resolveRowForStep(snap, map, 'gone', 5), 3);
  assert.equal(FlowView.resolveRowForStep(snap, map, 'gone', 99), 3);
  assert.equal(FlowView.resolveRowForStep(snap, map, 's2', null), 4);
  // A lane summary row stands for every step of its collapsed lane.
  const folded = FlowLayout.layout(snap, FlowLayout.setLaneExpanded(null, 'c', false));
  const m2 = FlowView.buildStepRowMap(snap, folded.rows, folded.order);
  assert.equal(folded.rows[2].kind, 'lane');
  for (const id of ['s3', 's4', 's5', 's6']) assert.equal(m2.get(id), 2);
});

test('laneTagInfo: depth in words above 1, the parent named in the title (T12)', () => {
  const columns = [
    { laneId: 'main', label: 'Main', depth: 0, parentLaneId: null },
    { laneId: 'a', label: 'Survey tests', depth: 1, parentLaneId: 'main' },
    { laneId: 'n', label: 'Nested probe', depth: 2, parentLaneId: 'a' },
  ];
  assert.deepEqual(FlowView.laneTagInfo(columns, 'a'), { text: '▾ Survey tests', title: 'Started by Main. Click to collapse this lane.' });
  const n = FlowView.laneTagInfo(columns, 'n');
  assert.equal(n.text, '▾ depth 2 · Nested probe');
  assert.match(n.title, /Started by Survey tests/);
  assert.match(FlowView.laneTagInfo([{ laneId: 'z', label: '', depth: 1, parentLaneId: null }], 'z').title, /Started by main/);
  assert.equal(FlowView.laneTagInfo([], 'q').text, '▾ agent');
});

test('a step of a lane below a collapsed lane maps to the summary and never uses up a main group (G2)', () => {
  const lane = (id, parent, anchorStep, ret) => ({ id, parentLaneId: parent, depth: parent === 'main' ? 1 : 2, label: id, kind: 'agent', spawnAnchor: { laneId: parent, stepId: anchorStep }, returnAnchor: ret ? { laneId: parent, stepId: ret } : null });
  const snap = mkSnap([
    mkStep(0, { kind: 'agent', detail: {}, ts: 1 }),
    mkStep(1, { laneId: 'a', kind: 'prompt', detail: {}, ts: 2 }),
    mkStep(2, { laneId: 'a', kind: 'agent', detail: {}, ts: 3 }),
    mkStep(3, { ts: 4, detail: { tool: 'Read' } }),
    mkStep(4, { laneId: 'n', kind: 'output', detail: {}, ts: 5 }),
    mkStep(5, { ts: 6, detail: { tool: 'Read' } }),
    mkStep(6, { laneId: 'n', kind: 'output', detail: {}, ts: 7 }),
    mkStep(7, { ts: 8, detail: { tool: 'Read' } }),
  ]);
  snap.lanes.push(lane('a', 'main', 's0', 's0'), lane('n', 'a', 's2', null));
  const lay = FlowLayout.layout(snap, FlowLayout.emptyCollapseState());
  assert.deepEqual(lay.rows.map((r) => r.kind), ['step', 'lane', 'group']);
  const map = FlowView.buildStepRowMap(snap, lay.rows, lay.order);
  for (const id of ['s1', 's2', 's4', 's6']) assert.equal(map.get(id), 1, id);
  for (const id of ['s3', 's5', 's7']) assert.equal(map.get(id), 2, id);
});
