'use strict';
// The neutral shape of a session's flow (spec 46, #826): the vocabulary and the validator, plus the two
// properties the hook family promises at the registry (a lazy reader, and no caller in the scan paths).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { stripComments } = require('./helpers/strip-comments');
const flow = require('../src/shared/flow-snapshot');

function minimal() {
  const snap = flow.emptyFlowSnapshot();
  snap.lanes.push({ id: 'main', parentLaneId: null, depth: 0, label: 'main', kind: 'main', spawnAnchor: null, returnAnchor: null, summaryOnly: false, sessionRef: null });
  const source = { sourceId: 'main', line: 1, byteOffset: 0 };
  snap.steps.push({
    id: flow.flowStepId('main', source, 0), laneId: 'main', ordinal: 0, turn: 1, kind: 'prompt', label: 'hello', ts: null,
    source, checkpoint: { input: { value: 10, unit: 'tokens', basis: 'measured', note: '' }, window: { value: 200000, unit: 'tokens', basis: 'estimated', note: '' }, model: 'm' },
    tokens: null, flags: [{ axis: 'risk', code: 'x', why: 'because', evidence: 'heuristic' }], detail: {},
  });
  return snap;
}

test('an empty snapshot is valid, and so is a minimal one with a lane and a step', () => {
  assert.deepEqual(flow.validateSnapshot(flow.emptyFlowSnapshot()), { ok: true, errors: [] });
  assert.deepEqual(flow.validateSnapshot(minimal()), { ok: true, errors: [] });
});

test('a snapshot survives a JSON round trip (it crosses a worker boundary)', () => {
  const snap = minimal();
  assert.deepEqual(flow.validateSnapshot(JSON.parse(JSON.stringify(snap))), { ok: true, errors: [] });
});

test('a version this code does not know is declined, not guessed', () => {
  for (const v of [0, 2, '1', undefined]) {
    const snap = minimal();
    snap.schemaVersion = v;
    const r = flow.validateSnapshot(snap);
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /schemaVersion/);
  }
  assert.equal(flow.validateSnapshot(null).ok, false);
});

test('an unknown step kind, lane kind, evidence basis, flag axis or capability state is rejected', () => {
  const cases = [
    [s => { s.steps[0].kind = 'banana'; }, /kind 'banana'/],
    [s => { s.lanes[0].kind = 'banana'; }, /kind 'banana'/],
    [s => { s.steps[0].checkpoint.input.basis = 'guessed'; }, /basis 'guessed'/],
    [s => { s.steps[0].tokens = { value: 1, unit: 'tokens', basis: 'guessed', note: '' }; }, /tokens: evidence basis/],
    [s => { s.steps[0].flags[0].axis = 'mood'; }, /axis must be one of/],
    [s => { s.steps[0].flags[0].evidence = 'vibes'; }, /evidence must be one of/],
    [s => { s.capabilities.agents.state = 'maybe'; }, /capabilities.agents.state/],
    [s => { s.capabilities.instructionFiles.state = 'yes'; }, /capabilities.instructionFiles.state/],
    [s => { delete s.capabilities.compaction; }, /capabilities.compaction is missing/],
    [s => { s.steps[0].laneId = 'nowhere'; }, /names no lane/],
    [s => { s.steps.push({ ...s.steps[0] }); }, /duplicate step id/],
    [s => { s.complete = 'yes'; }, /complete must be a boolean/],
    [s => { s.capabilities.agents = { state: 'partial', limitationId: 'nope' }; }, /names no limitation/],
  ];
  for (const [mutate, expected] of cases) {
    const snap = minimal();
    mutate(snap);
    const r = flow.validateSnapshot(snap);
    assert.equal(r.ok, false, String(expected));
    assert.ok(r.errors.some(e => expected.test(e)), `${expected} not in ${JSON.stringify(r.errors)}`);
  }
});

test('the stable step id is deterministic and depends on lane, source, line, offset and part', () => {
  const src = { sourceId: 'main', line: 7, byteOffset: 120 };
  const a = flow.flowStepId('main', src, 0);
  assert.equal(a, flow.flowStepId('main', { ...src }, 0));
  assert.equal(a, flow.flowStepId('main', src), 'part defaults to 0');
  assert.notEqual(a, flow.flowStepId('agent-1', src, 0));
  assert.notEqual(a, flow.flowStepId('main', { ...src, sourceId: 'other' }, 0));
  assert.notEqual(a, flow.flowStepId('main', { ...src, line: 8 }, 0));
  assert.notEqual(a, flow.flowStepId('main', { ...src, byteOffset: 121 }, 0));
  assert.notEqual(a, flow.flowStepId('main', src, 1));
});

test('step ids never collide across a synthetic 20k-step input, and a snapshot of it validates', () => {
  const snap = minimal();
  snap.steps.length = 0;
  const lanes = ['main', 'agent-1', 'agent-2', 'agent-3'];
  for (const id of lanes.slice(1)) snap.lanes.push({ id, parentLaneId: 'main', depth: 1, label: id, kind: 'agent', spawnAnchor: null, returnAnchor: null, summaryOnly: false, sessionRef: null });
  const seen = new Set();
  let n = 0;
  for (let line = 1; n < 20000; line++) {
    for (const laneId of lanes) {
      for (let part = 0; part < 2; part++) {
        const source = { sourceId: laneId, line, byteOffset: line * 97 };
        const id = flow.flowStepId(laneId, source, part);
        assert.ok(!seen.has(id), id);
        seen.add(id);
        snap.steps.push({ id, laneId, ordinal: n++, turn: null, kind: 'event', label: '', ts: null, source, checkpoint: null, tokens: null, flags: [], detail: {} });
      }
    }
  }
  assert.ok(snap.steps.length >= 20000);
  assert.deepEqual(flow.validateSnapshot(snap), { ok: true, errors: [] });
});

test('parentStepId is optional and, when present, must name a step of the snapshot', () => {
  const snap = minimal();
  snap.steps[0].parentStepId = snap.steps[0].id;
  assert.equal(flow.validateSnapshot(snap).ok, true);
  snap.steps[0].parentStepId = 'ghost';
  const r = flow.validateSnapshot(snap);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /parentStepId 'ghost' names no step/.test(e)), JSON.stringify(r.errors));
});

test('a capability that is not fully there must name a limitation; instructionFiles is full only as perFile', () => {
  const cases = [
    [s => { s.capabilities.agents = { state: 'no', limitationId: null }; }, /must carry a limitationId/],
    [s => { s.capabilities.compaction = { state: 'partial' }; }, /must carry a limitationId/],
    [s => { s.capabilities.instructionFiles = { state: 'block', limitationId: null }; }, /must carry a limitationId/],
    [s => { s.capabilities.instructionFiles = { state: 'none', limitationId: 'ghost' }; }, /names no limitation/],
  ];
  for (const [mutate, expected] of cases) {
    const snap = minimal();
    mutate(snap);
    const r = flow.validateSnapshot(snap);
    assert.equal(r.ok, false, String(expected));
    assert.ok(r.errors.some(e => expected.test(e)), JSON.stringify(r.errors));
  }
  const ok = minimal();
  ok.capabilities.agents = { state: 'yes', limitationId: null };
  ok.capabilities.instructionFiles = { state: 'perFile', limitationId: null };
  assert.equal(flow.validateSnapshot(ok).ok, true);
  const empty = flow.emptyFlowSnapshot();
  assert.ok(empty.limitations.some(l => l.id === empty.capabilities.agents.limitationId), 'the default names its own limitation');
});

test('a step source carries no path, links point at real lanes and steps, limitation ids are unique, errors are capped', () => {
  const cases = [
    [s => { s.steps[0].source.file = 'x'; }, /key 'file'/],
    [s => { s.steps[0].source = null; }, /source must be an object/],
    [s => { s.steps[0].label = 5; }, /label must be a string/],
    [s => { s.steps[0].turn = 'one'; }, /turn must be null or a number/],
    [s => { s.lanes[0].parentLaneId = 'ghost'; }, /parentLaneId 'ghost'/],
    [s => { s.lanes[0].spawnAnchor = { laneId: 'main', stepId: 'ghost' }; }, /spawnAnchor/],
    [s => { s.lanes[0].returnAnchor = { laneId: 'ghost', stepId: s.steps[0].id }; }, /returnAnchor/],
    [s => { s.limitations.push({ id: 'dup', text: 'a' }, { id: 'dup', text: 'b' }); }, /duplicate limitation id/],
  ];
  for (const [mutate, expected] of cases) {
    const snap = minimal();
    mutate(snap);
    const r = flow.validateSnapshot(snap);
    assert.equal(r.ok, false, String(expected));
    assert.ok(r.errors.some(e => expected.test(e)), `${expected} not in ${JSON.stringify(r.errors)}`);
  }
  const good = minimal();
  good.lanes[0].spawnAnchor = { laneId: 'main', stepId: good.steps[0].id };
  assert.equal(flow.validateSnapshot(good).ok, true);
  const bad = minimal();
  bad.steps = Array.from({ length: 500 }, (_, i) => ({ ...bad.steps[0], id: 'x' + i, kind: 'banana' }));
  const r = flow.validateSnapshot(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length <= 51, 'capped at the first 50 plus one note');
  assert.match(r.errors[r.errors.length - 1], /more problems omitted/);
});

test('shared constants handed out are frozen', () => {
  assert.ok(Object.isFrozen(flow));
  assert.ok(Object.isFrozen(flow.FLOW_STEP_KINDS));
});

test('loaded as a classic script the module adds one global and no helper names', () => {
  const vm = require('node:vm');
  const ctx = { self: undefined };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'flow-snapshot.js'), 'utf8'), ctx);
  assert.equal(typeof ctx.FlowSnapshot.validateSnapshot, 'function');
  assert.deepEqual(vm.runInContext('typeof isObject + typeof checkEvidence + typeof FLOW_SCHEMA_VERSION', ctx), 'undefinedundefinedundefined');
});

test('the vocabulary names the four evidence bases and the four flag axes of the spec', () => {
  assert.deepEqual([...flow.FLOW_EVIDENCE_BASES], ['measured', 'estimated', 'included', 'unknown']);
  assert.deepEqual([...flow.FLOW_FLAG_AXES], ['risk', 'outcome', 'attention', 'lifecycle']);
  assert.equal(flow.FLOW_SCHEMA_VERSION, 1);
});

test('requiring the backend registry loads no flow reader (spec 46: lazy, never at descriptor load)', async () => {
  const backends = require('../src/backends');
  backends.list();
  const loaded = Object.keys(require.cache).map(f => f.split(path.sep).join('/'));
  const readers = loaded.filter(f => /\/src\/backends\/(?:[^/]+\/)?flow-(?:reader|lines|capabilities)[^/]*\.js$/.test(f));
  assert.deepEqual(readers, [], 'a flow reader module was loaded with the registry');
  // …and the hook does load it, on use.
  const pi = backends.get('pi'); // any reader proves the lazy load; each is covered by its own test
  const snap = await pi.readSessionFlow([], {});
  assert.equal(flow.validateSnapshot(snap).ok, true);
  assert.ok(Object.keys(require.cache).some(f => /flow-reader\.js$/.test(f)), 'the first call should load the reader');
});

test('sessionFlow is never called from the scan, the watchers or the workers', () => {
  // A source check: there is no seam to run these paths against. `sessionFlow` is on-demand and per row, so a call in the
  // scan loop or a list projection would put a transcript lookup in front of every row.
  const roots = ['src/index', 'src/workers', 'src/watch', 'src/db'];
  // The one exemption, with its reason: src/workers/flow-worker.js IS the Flow tab's reader (T6): main starts it per request and it calls
  // the descriptor's `readSessionFlow`. It never calls `sessionFlow`, which is checked below.
  const READER = path.join('src', 'workers', 'flow-worker.js');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && full.endsWith(READER)) {
        assert.ok(!/sessionFlow/.test(stripComments(fs.readFileSync(full, 'utf8'))), 'the flow worker reads; it never asks sessionFlow');
      } else if (entry.name.endsWith('.js') && /sessionFlow|readSessionFlow/.test(stripComments(fs.readFileSync(full, 'utf8')))) offenders.push(full);
    }
  };
  for (const r of roots) walk(path.join(__dirname, '..', r));
  assert.deepEqual(offenders, [], 'sessionFlow belongs to the Flow tab\'s on-demand path; ask it per session in src/app/');
  const main = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8'));
  assert.ok(!/sessionFlow/.test(main), 'backends-list sends the static capability answer; main.js must not call sessionFlow');
});
