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
  for (const f of ['src/shared/flow-snapshot.js', 'src/shared/flow-layout.js', 'src/shared/flow-text.js', 'src/renderer/session/flow-view.js']) {
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

// --- Refresh with lanes (T13) ---

function laneSnap(steps, finished) {
  const snap = mkSnap(steps);
  snap.lanes.push({ id: 'agent:x', parentLaneId: 'main', depth: 1, label: 'helper', kind: 'agent', spawnAnchor: { laneId: 'main', stepId: 's1' }, returnAnchor: finished ? { laneId: 'main', stepId: 's1' } : null });
  return snap;
}
const base = () => [
  mkStep(0, { kind: 'prompt', detail: {} }),
  mkStep(1, { kind: 'agent', detail: {} }),
  mkStep(2, { laneId: 'agent:x', kind: 'prompt', detail: {} }),
  mkStep(3, { laneId: 'agent:x', kind: 'output', detail: {} }),
];
const more = () => base().concat([mkStep(4, { laneId: 'agent:x', kind: 'output', detail: {} }), mkStep(5, { kind: 'output', detail: {} })]);

function reselect(prev, next, collapse, sel) {
  const lay = FlowLayout.layout(next, collapse);
  const map = FlowView.buildStepRowMap(next, lay.rows, lay.order);
  return { lay, idx: FlowView.resolveSelection(next, lay.rows, map, sel.key, sel.stepId) };
}

test('refresh: a selected step in a lane that finished meanwhile resolves to its summary row', () => {
  const open = FlowLayout.layout(laneSnap(base(), false), FlowLayout.emptyCollapseState());
  const selRow = open.rows.find((r) => r.key === 's3');
  assert.ok(selRow, 'the step has a row while the lane is open');
  const r = reselect(null, laneSnap(more(), true), FlowLayout.emptyCollapseState(), { key: selRow.key, stepId: selRow.firstStepId });
  assert.equal(r.lay.rows[r.idx].kind, 'lane');
  assert.equal(r.lay.rows[r.idx].key, 'l:agent:x');
});

test('refresh: an explicit choice survives, in both directions, whatever the lane did meanwhile', () => {
  // The user expanded a lane that is finished now: it stays expanded and the selected step keeps its own row.
  const expanded = FlowLayout.setLaneExpanded(FlowLayout.emptyCollapseState(), 'agent:x', true);
  const r1 = reselect(null, laneSnap(more(), true), expanded, { key: 's3', stepId: 's3' });
  assert.equal(r1.lay.rows[r1.idx].key, 's3');
  // The user collapsed a lane that was still open: it stays collapsed after the lane grew.
  const collapsed = FlowLayout.setLaneExpanded(FlowLayout.emptyCollapseState(), 'agent:x', false);
  const r2 = reselect(null, laneSnap(more(), false), collapsed, { key: 's3', stepId: 's3' });
  assert.equal(r2.lay.rows[r2.idx].key, 'l:agent:x');
  // No choice at all: an open lane is expanded, a finished one collapsed.
  assert.equal(FlowLayout.layout(laneSnap(more(), false), FlowLayout.emptyCollapseState()).rows.some((r) => r.kind === 'lane'), false);
  assert.equal(FlowLayout.layout(laneSnap(more(), true), FlowLayout.emptyCollapseState()).rows.some((r) => r.kind === 'lane'), true);
});

test('refresh: a selected lane summary whose lane is expanded now falls back to the lane first step', () => {
  const lay = FlowLayout.layout(laneSnap(base(), true), FlowLayout.emptyCollapseState());
  const sum = lay.rows.find((r) => r.kind === 'lane');
  const expanded = FlowLayout.setLaneExpanded(FlowLayout.emptyCollapseState(), 'agent:x', true);
  const r = reselect(null, laneSnap(more(), true), expanded, { key: sum.key, stepId: sum.firstStepId });
  assert.equal(r.lay.rows[r.idx].key, 's2');
  assert.equal(FlowView.resolveSelection(laneSnap(more(), true), r.lay.rows, new Map(), 'nope', null), -1);
});

test('refresh: the scroll anchor on a lane row survives the lane growing and finishing', () => {
  const before = FlowLayout.layout(laneSnap(base(), false), FlowLayout.emptyCollapseState());
  const at = before.rows.findIndex((r) => r.key === 's3');
  const anchor = FlowView.captureAnchor(laneSnap(base(), false), before.rows, at * ROW + 9, ROW);
  assert.equal(anchor.stepId, 's3');
  const next = laneSnap(more(), false);
  const after = FlowLayout.layout(next, FlowLayout.emptyCollapseState());
  const top = FlowView.restoreAnchor(next, after.rows, FlowView.buildStepRowMap(next, after.rows, after.order), anchor, ROW);
  assert.equal(top, after.rows.findIndex((r) => r.key === 's3') * ROW + 9);
  // The lane finished: the anchored step is inside the summary now and the anchor lands on that row.
  const fin = laneSnap(more(), true);
  const folded = FlowLayout.layout(fin, FlowLayout.emptyCollapseState());
  const top2 = FlowView.restoreAnchor(fin, folded.rows, FlowView.buildStepRowMap(fin, folded.rows, folded.order), anchor, ROW);
  assert.equal(Math.floor(top2 / ROW), folded.rows.findIndex((r) => r.kind === 'lane'));
});

// --- T24: marks and the detail panel ---

const FlowText = require('../src/shared/flow-text.js');

test('flagChips: glyph and word per mark, risk first, heuristic marked in the text, at most two plus a count', () => {
  const flags = [
    { axis: 'outcome', code: 'permission-denied', why: 'refused', evidence: 'structured' },
    { axis: 'risk', code: 'destructive:git-force-push', why: 'force', evidence: 'heuristic' },
    { axis: 'lifecycle', code: 'skill-granted-tools', why: 'g', evidence: 'structured' },
  ];
  const { chips, more } = FlowText.flagChips(flags, 2);
  assert.deepEqual(chips.map((c) => c.text), ['▲ ~destructive: git force push', '■ permission denied']);
  assert.equal(chips[0].heuristic, true);
  assert.match(chips[0].title, /^risk, heuristic: force$/);
  assert.equal(more, 1);
  const counted = FlowText.flagChips([{ axis: 'risk', code: 'x', why: '', evidence: 'structured', count: 3 }]);
  assert.equal(counted.chips[0].text, '▲ x ×3');
  assert.deepEqual(FlowText.flagChips([]).chips, []);
  assert.equal(FlowText.flagChips([{ axis: 'odd', code: '', why: '', evidence: 'x' }]).chips[0].text, '• flag');
});

test('rowText and rowBadge name a quiet group in words', () => {
  const row = { kind: 'group', quiet: true, count: 5, tool: null };
  assert.equal(FlowText.rowText(row, []), '5 steps without a highlight');
  assert.equal(FlowText.rowBadge(row), 'steps');
  assert.equal(FlowText.rowText({ kind: 'group', count: 2, tool: 'Read' }, []), '2 × Read');
});

test('detailOf: a step lists its fields, its detail rows and every flag with evidence and sentence', () => {
  const s = mkStep(1, { turn: 3, ts: Date.parse('2026-01-01T12:00:00Z'), detail: { tool: 'Bash', input: 'rm -rf /', nested: { a: 1 }, empty: '' },
    flags: [{ axis: 'risk', code: 'destructive:rm-recursive', why: 'Looks destructive.', evidence: 'heuristic' }] });
  const lay = FlowLayout.layout(mkSnap([s]), FlowLayout.emptyCollapseState());
  const d = FlowView.detailOf(lay.rows[0], lay.columns);
  assert.equal(d.title, 'Bash 1');
  const f = Object.fromEntries(d.fields);
  assert.equal(f.Kind, 'tool');
  assert.equal(f.Turn, '3');
  assert.equal(f.Lane, 'Main');
  assert.ok(f.Time);
  assert.equal(f.input, 'rm -rf /');
  assert.equal(f.nested, '{"a":1}');
  assert.ok(!('empty' in f), 'an empty value is no row');
  assert.deepEqual(d.flags.map((x) => [x.axis, x.word, x.evidence, x.why]), [['risk', 'destructive: rm recursive', 'heuristic', 'Looks destructive.']]);
  assert.equal(FlowView.detailOf(null, []), null);
});

test('highlights only: a selected step resolves to its quiet group, and back to itself when the mode is off again', () => {
  const steps = [mkStep(1, { kind: 'prompt', label: 'go' }), mkStep(2, { detail: { tool: 'Read' } }), mkStep(3, { detail: { tool: 'Edit' } }), mkStep(4, { kind: 'output' })];
  const s = mkSnap(steps);
  const normal = FlowLayout.layout(s, FlowLayout.emptyCollapseState());
  const before = normal.rows.findIndex((r) => r.key === 's3');
  assert.ok(before >= 0);
  const anchor = FlowView.captureAnchor(s, normal.rows, before * ROW + 7, ROW);
  const on = FlowLayout.setHighlightsOnly(FlowLayout.emptyCollapseState(), true);
  const quiet = FlowLayout.layout(s, on);
  const map = FlowView.buildStepRowMap(s, quiet.rows, quiet.order);
  const at = FlowView.resolveSelection(s, quiet.rows, map, 's3', 's3');
  assert.equal(quiet.rows[at].quiet, true, 'the selection lands on the quiet group that holds the step');
  assert.equal(quiet.rows[at].count, 3);
  assert.equal(Math.floor(FlowView.restoreAnchor(s, quiet.rows, map, anchor, ROW) / ROW), at, 'the scroll anchor follows too');
  const off = FlowLayout.layout(s, FlowLayout.setHighlightsOnly(on, false));
  const back = FlowView.resolveSelection(s, off.rows, FlowView.buildStepRowMap(s, off.rows, off.order), quiet.rows[at].key, 's3');
  assert.equal(off.rows[back].key, 's3', 'off again: the step itself, not the group key that no longer exists');
});

test('placeEvents (#851): a re-key is drawn as what it was, not as a fork', () => {
  const T = Date.parse('2026-01-01T12:00:00Z');
  const snap = mkSnap([mkStep(1, { ts: T, kind: 'start' })]);
  const placed = FlowView.placeEvents(snap, [
    { kind: 'cleared', label: 'Session cleared', at: T + 1 },
    { kind: 'plan-accepted', label: 'Plan accepted', at: T + 2 },
    { kind: 'id-adopted', label: 'Session id changed', at: T + 3 },
  ]);
  assert.deepEqual(placed.map((m) => m.word), ['cleared', 'plan accepted', 'id changed']);
});

test('placeEvents (T25): Events lifecycle marks go to the last main-lane step written before them, others are ignored', () => {
  const T = Date.parse('2026-01-01T12:00:00Z');
  const steps = [mkStep(1, { ts: T, kind: 'start' }), mkStep(2, { ts: T + 1000 }), mkStep(3, { ts: T + 5000 }),
    mkStep(4, { ts: T + 2000, laneId: 'agent:x' })];
  const snap = mkSnap(steps);
  const events = [
    { kind: 'stopped', label: 'Session stopped', detail: 'user', at: T + 6000 },
    { kind: 'needs-attention', label: 'Needs human attention', at: new Date(T + 1500).toISOString() },
    { kind: 'forked', label: 'Session forked', at: T - 9999 },
    { kind: 'busy', label: 'Agent working', at: T + 1200 },
    { kind: 'stopped', label: 'bad time', at: 'not a date' },
  ];
  const placed = FlowView.placeEvents(snap, events);
  assert.deepEqual(placed.map((m) => [m.kind, m.stepId]), [['forked', 's1'], ['needs-attention', 's2'], ['stopped', 's3']]);
  assert.equal(placed[1].word, 'needs attention');
  assert.equal(placed[2].detail, 'user');
  // A child lane's step is never the anchor, and an untimed snapshot places nothing.
  assert.ok(!placed.some((m) => m.stepId === 's4'));
  assert.deepEqual(FlowView.placeEvents(mkSnap([mkStep(1)]), events), []);
  assert.deepEqual(FlowView.placeEvents(snap, []), []);
  // The snapshot is not touched: the sources stay apart.
  assert.ok(snap.steps.every((s) => s.flags.length === 0));
});

test('placeEvents edge cases: equal and unsorted ts, before every step, an empty label, the cap, no main lane kind', () => {
  const T = Date.parse('2026-01-01T12:00:00Z');
  // Out of order on the main lane, and two steps with the same ts: the later ordinal wins among equals.
  const steps = [mkStep(1, { ts: T + 3000 }), mkStep(2, { ts: T + 1000 }), mkStep(3, { ts: T + 1000 })];
  const snap = mkSnap(steps);
  const one = (at, extra) => FlowView.placeEvents(snap, [Object.assign({ kind: 'stopped', label: 'Session stopped', at }, extra || {})])[0];
  assert.equal(one(T + 1000).stepId, 's3');
  assert.equal(one(T + 2000).stepId, 's3');
  assert.equal(one(T + 9000).stepId, 's1', 'newer than the snapshot: the last timed step');
  const early = one(T - 1);
  assert.equal(early.stepId, 's2');
  assert.equal(early.before, true);
  assert.equal(one(T + 1000).before, false);
  assert.equal(one(T + 1000, { label: '' }).label, 'stopped', 'an empty label falls back to the word');
  // At most 200, the newest kept.
  const many = [];
  for (let i = 0; i < 250; i++) many.push({ kind: 'needs-attention', label: 'n', at: T + i });
  const capped = FlowView.placeEvents(snap, many);
  assert.equal(capped.length, 200);
  assert.equal(capped[0].at, T + 50);
  // A snapshot whose lanes name no `main` kind falls back to its first lane.
  const alt = mkSnap([mkStep(1, { ts: T })]);
  alt.lanes[0].kind = 'agent';
  assert.equal(FlowView.placeEvents(alt, [{ kind: 'forked', label: 'f', at: T }]).length, 1);
});

test('detailOf: an estimated checkpoint says "estimated" once in the panel', () => {
  const s = mkStep(1, { checkpoint: { input: { value: 3100, basis: 'measured' }, window: { value: 1000000, basis: 'estimated' } } });
  const lay = FlowLayout.layout(mkSnap([s]), FlowLayout.emptyCollapseState());
  const ctx = Object.fromEntries(FlowView.detailOf(lay.rows[0], lay.columns).fields).Context;
  assert.equal((ctx.match(/estimated/g) || []).length, 1, ctx);
});

test('detailOf carries the Events marks it is given, apart from the flags', () => {
  const lay = FlowLayout.layout(mkSnap([mkStep(1)]), FlowLayout.emptyCollapseState());
  const marks = [{ stepId: 's1', kind: 'stopped', word: 'stopped', label: 'Session stopped', detail: '', at: 1 }];
  const d = FlowView.detailOf(lay.rows[0], lay.columns, marks);
  assert.deepEqual(d.events, marks);
  assert.deepEqual(d.flags, []);
  assert.deepEqual(FlowView.detailOf(lay.rows[0], lay.columns).events, []);
});

test('detailOf: a long value is cut; a lane summary lists its count and the flags it inherited with their counts', () => {
  const long = mkStep(1, { detail: { result: 'x'.repeat(5000) } });
  const lay = FlowLayout.layout(mkSnap([long]), FlowLayout.emptyCollapseState());
  const v = Object.fromEntries(FlowView.detailOf(lay.rows[0], lay.columns).fields).result;
  assert.ok(v.length <= 600 && v.endsWith('…'));
  const summary = { kind: 'lane', laneId: 'main', count: 7, flags: [{ axis: 'outcome', code: 'tool-error', why: 'w', evidence: 'structured', count: 2 }] };
  const d = FlowView.detailOf(summary, lay.columns);
  assert.equal(Object.fromEntries(d.fields).Steps, '7');
  assert.equal(d.flags[0].count, 2);
});
