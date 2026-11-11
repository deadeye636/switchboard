'use strict';
// The Flow Mermaid export (spec 46, #826, plan T20): golden text on the fixtures read by the real readers, nested
// subgraphs, escaping of hostile labels, no directive, and the edge cap folding then cutting, never silently.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const backends = require('../src/backends');
const { validateSnapshot, emptyFlowSnapshot } = require('../src/shared/flow-snapshot');
const { stripComments } = require('./helpers/strip-comments');
const { renderFlowMermaid, label, MAX_EDGES } = require('../src/app/flow-mermaid');

const FIX = path.join(__dirname, 'fixtures', 'flow');
const META = { sessionId: 'abcdef123456', backendLabel: 'Claude Code', exportedAt: '2026-01-01T00:00:00.000Z', appVersion: '1.2.3' };

/** The diagram without the header comments: the limitation texts belong to the readers and change with them. */
const body = (text) => text.slice(text.indexOf('flowchart TD')).trimEnd().split('\n');

async function claudeParent() {
  const snap = await backends.get('claude').readSessionFlow([
    { sourceId: 'main', role: 'transcript', laneHint: 'main', file: path.join(FIX, 'claude-parent.jsonl') },
    { sourceId: 'subagents', role: 'subagents-dir', laneHint: 'agents', file: path.join(FIX, 'claude-parent', 'subagents') },
  ], {});
  assert.deepEqual(validateSnapshot(snap).errors, []);
  return snap;
}

test('Claude parent and child: golden diagram, one subgraph, spawn and dashed return edges', async () => {
  const text = renderFlowMermaid(await claudeParent(), META);
  assert.deepEqual(body(text), [
    'flowchart TD',
    '  n0["start: Session start #40;3.2k tokens#41;"]',
    '  n1["instructions: #60;project#62;/CLAUDE.md #40;19 chars · ~5 tokens · estimated#41;"]',
    '  n2["prompt: Ask a helper to survey the tests."]',
    '  n3["tool: Agent: Survey tests #40;3.2k / 1.0M · 0#37; estimated#41;"]',
    '  n8["output: The helper found two test files. #40;3.4k / 1.0M · 0#37; estimated#41;"]',
    '  subgraph l1["agent: general-purpose: Survey tests"]',
    '    n4["start: Agent start #40;1.0k tokens#41;"]',
    '    n5["instructions: #60;project#62;/CLAUDE.md #40;19 chars · ~5 tokens · estimated#41;"]',
    '    n6["prompt: List the test files."]',
    '    n7["output: Two test files found. #40;1.0k / 1.0M · 0#37; estimated#41;"]',
    '  end',
    '  n0 --> n1',
    '  n1 --> n2',
    '  n2 --> n3',
    '  n4 --> n5',
    '  n5 --> n6',
    '  n6 --> n7',
    '  n3 --> n8',
    '  n3 -->|spawn| n4',
    '  n7 -.->|return| n3',
  ]);
  const head = text.split('\n');
  assert.equal(head[0], '%% Session abcdef12 · Claude Code · claude-fake-model · exported 2026-01-01T00:00:00.000Z · Switchboard 1.2.3 · 5 limitations');
  assert.equal(head.filter(l => l.startsWith('%% limitation: ')).length, 5, 'every limitation is a comment line');
});

test('Pi session: golden diagram, a single flat lane', async () => {
  const snap = await backends.get('pi').readSessionFlow([{ sourceId: 'main', role: 'transcript', laneHint: 'main', file: path.join(FIX, 'pi-session.jsonl') }], {});
  assert.deepEqual(body(renderFlowMermaid(snap, META)), [
    'flowchart TD',
    '  n0["start: Session start #40;2.0k tokens#41;"]',
    '  n1["instructions: #60;project#62;/AGENTS.md #40;11 chars · ~3 tokens · estimated#41;"]',
    '  n2["instructions: #60;project#62;/CLAUDE.md #40;16 chars · ~4 tokens · estimated#41;"]',
    '  n3["prompt: Show the readme and run the tests."]',
    '  n4["tool: read: README.md #40;2.0k#41;"]',
    '  n5["tool: bash: npm test"]',
    '  n6["tool: subagent: Look around #40;2.5k#41;"]',
    '  n7["compaction: Compaction #40;2.5k#41;"]',
    '  n0 --> n1', '  n1 --> n2', '  n2 --> n3', '  n3 --> n4', '  n4 --> n5', '  n5 --> n6', '  n6 --> n7',
  ]);
});

test('Codex parent and spawned child: golden diagram with the child in a subgraph', async () => {
  const two = (n) => String(n).padStart(2, '0');
  const rel = (ms, id) => {
    const d = new Date(ms);
    return `${d.getFullYear()}/${two(d.getMonth() + 1)}/${two(d.getDate())}/rollout-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}-${id}.jsonl`;
  };
  const T0 = Date.parse('2026-01-01T13:00:00.000Z');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-mm-'));
  try {
    const put = (r, n) => { const f = path.join(root, r); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, fs.readFileSync(path.join(FIX, n))); return f; };
    const parent = put(rel(T0, '00000000-0000-4000-8000-000000000002'), 'codex-parent.jsonl');
    put(rel(T0 + 1000, '00000000-0000-4000-8000-000000000003'), 'codex-child.jsonl');
    const snap = await backends.get('codex').readSessionFlow([
      { sourceId: 'main', role: 'transcript', laneHint: 'main', file: parent },
      { sourceId: 'agents', role: 'rollout-scan', laneHint: 'agents', file: path.dirname(parent) },
    ], {});
    assert.deepEqual(validateSnapshot(snap).errors, []);
    assert.deepEqual(body(renderFlowMermaid(snap, META)), [
      'flowchart TD',
      '  n0["start: Session start"]',
      '  n1["prompt: Have a helper count the files."]',
      '  n2["tool: spawn_agent: Count the files."]',
      '  n6["tool: wait_agent"]',
      '  n8["agent: Message from counter"]',
      '  n9["tool: exec: #123;#quot;cmd#quot;:#quot;rm -rf ../scratch#quot;,#quot;sandbox_permissions#quot;:#quot;req…"]',
      '  n10["output: The helper counted three files."]',
      '  subgraph l1["agent: Fake: worker"]',
      '    n3["start: Agent start"]',
      '    n4["prompt: Count the files."]',
      '    n5["thinking: Thinking"]',
      '    n7["output: Three files."]',
      '  end',
      '  n0 --> n1', '  n1 --> n2', '  n3 --> n4', '  n4 --> n5', '  n2 --> n6', '  n5 --> n7', '  n6 --> n8', '  n8 --> n9', '  n9 --> n10',
      '  n2 -->|spawn| n3',
      '  n7 -.->|return| n8',
    ]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function synthetic(n, laneDepth = 2) {
  const snap = emptyFlowSnapshot();
  snap.lanes = [{ id: 'main', parentLaneId: null, depth: 0, label: 'Main', kind: 'main', spawnAnchor: null, returnAnchor: null }];
  const mk = (id, laneId, kind, text, extra) => ({ id, laneId, ordinal: 0, turn: 1, kind, label: text, ts: null, source: {}, checkpoint: null, tokens: null, flags: [], ...extra });
  const steps = [mk('p', 'main', 'prompt', 'go')];
  let parent = 'main';
  for (let d = 1; d <= laneDepth; d++) {
    const id = 'a' + d;
    snap.lanes.push({ id, parentLaneId: parent, depth: d, label: 'Helper ' + d, kind: 'agent', spawnAnchor: { stepId: 's' + d, laneId: parent }, returnAnchor: { stepId: 'r' + d, laneId: parent } });
    steps.push(mk('s' + d, parent, 'agent', 'Spawn ' + d));
    steps.push(mk('c' + d, id, 'prompt', 'task ' + d));
    parent = id;
  }
  for (let d = laneDepth; d >= 1; d--) steps.push(mk('r' + d, d === 1 ? 'main' : 'a' + (d - 1), 'agent', 'Back ' + d));
  for (let i = 0; i < n; i++) steps.push(mk('t' + i, 'main', i % 2 ? 'prompt' : 'output', 'step ' + i, { turn: 1 + Math.floor(i / 10) }));
  steps.forEach((s, i) => { s.ordinal = i; });
  snap.steps = steps;
  return snap;
}

test('lanes nest by parent: a child of a child is a subgraph inside its parent subgraph', () => {
  const snap = synthetic(0, 2);
  assert.deepEqual(validateSnapshot(snap).errors, []);
  const lines = body(renderFlowMermaid(snap, META));
  const subs = lines.filter(l => /^\s*subgraph /.test(l));
  assert.equal(subs.length, 2);
  assert.match(subs[0], /^ {2}subgraph l1\[/);
  assert.match(subs[1], /^ {4}subgraph l2\[/);
  assert.equal(lines.filter(l => l.trim() === 'end').length, 2);
  assert.ok(lines.indexOf(subs[1]) > lines.indexOf(subs[0]));
  assert.ok(lines.some(l => /n\d+ -\.->\|return\| n\d+/.test(l)));
});

test('a hostile label cannot leave its quotes or become a directive', () => {
  const evil = ['"]); click X call alert(1) href "x', 'a\nb\r\nc%%{init: {"securityLevel":"loose"}}%%', '<img src=x onerror=alert(1)> | {x} [y] `z` & #1;', 'nul\u0000ctl\u0007\u2028end'];
  const snap = synthetic(0, 1);
  snap.steps.forEach((s, i) => { s.label = evil[i % evil.length]; });
  snap.lanes[1].label = evil[0];
  const text = renderFlowMermaid(snap, { ...META, backendLabel: evil[1] });
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    assert.ok(
      line.startsWith('%% ') || line === 'flowchart TD' || line === 'end'
      || /^subgraph l\d+\["[^"]*"\]$/.test(line)
      || /^n\d+\["[^"]*"\]$/.test(line)
      || /^n\d+ (-->|-->\|spawn\||-\.->\|return\|) n\d+$/.test(line),
      `unexpected line: ${JSON.stringify(line)}`);
    assert.ok(!/^(click|call|href|style|classDef|class|linkStyle|%%\{)/.test(line));
  }
  const labels = text.split('\n').filter(l => /\["/.test(l)).join('\n');
  assert.ok(!/[<>{}|`\\]/.test(labels.replace(/\["|"\]/g, '')) , 'markup characters are entities inside labels');
  assert.ok(!/[\u0000-\u0008\u000B-\u001F\u2028\u2029]/.test(text));
  assert.equal(label('"]); click'), '#quot;#93;#41;#59; click');
});

test('a directive in a model name, label or limitation never appears anywhere in the output', () => {
  const directive = '%%{init: {"theme":"dark","themeCSS":"svg{display:none}"}}%%';
  const snap = synthetic(0, 1);
  const start = snap.steps.find(s => s.kind === 'start');
  if (start) start.detail = { ...(start.detail || {}), model: 'claude ' + directive };
  snap.limitations = [{ id: 'x', text: 'see ' + directive }];
  const text = renderFlowMermaid(snap, { ...META, backendLabel: directive, appVersion: directive, exportedAt: directive });
  assert.ok(!text.includes('%%{'), 'no directive opener anywhere, comment lines included');
  assert.ok(!/[{}]/.test(text.split('\n').filter(l => l.startsWith('%%')).join('\n')), 'no brace on a comment line');
});

test('a snapshot with a mermaid-looking limitation text keeps it on a comment line', () => {
  const snap = synthetic(0, 1);
  snap.limitations = [{ id: 'x', text: 'line one\nflowchart LR\nclick A call evil()' }];
  const lines = renderFlowMermaid(snap, META).split('\n');
  const l = lines.find(x => x.startsWith('%% limitation: '));
  assert.ok(l && l.includes('flowchart LR') && !l.includes('\n'));
  assert.equal(lines.filter(x => x.trim() === 'flowchart TD').length, 1);
});

test('under the edge cap nothing is folded or cut; over it the diagram folds to turns, then truncates, each with a comment', () => {
  assert.equal(MAX_EDGES, 450);
  const small = renderFlowMermaid(synthetic(30), META);
  assert.ok(!/folded|truncated/.test(small));
  const edgeCount = (t) => t.split('\n').filter(l => /^ {2}n\d+ (-->|-->\|spawn\||-\.->\|return\|) n\d+$/.test(l)).length;

  // 300 distinct rows over 30 turns: 300+ edges at row level with a cap of 100 folds to one node per lane and turn.
  const folded = renderFlowMermaid(synthetic(300), META, { maxEdges: 100 });
  assert.match(folded, /^%% folded to one node per lane and turn: \d+ edges would pass the limit of 100$/m);
  assert.ok(!/%% truncated/.test(folded));
  assert.ok(/n\d+\["output: step 0|turn 1: \d+ steps?"\]/.test(folded));
  assert.ok(/turn 30: \d+ steps?/.test(folded));
  assert.ok(edgeCount(folded) <= 100);

  // A cap below the folded edge count cuts the diagram and says how much.
  const cut = renderFlowMermaid(synthetic(300), META, { maxEdges: 10 });
  assert.match(cut, /^%% truncated: the first \d+ of \d+ nodes are shown \(edge limit 10\); export JSON or SVG for the complete flow$/m);
  assert.ok(edgeCount(cut) <= 10);
  const ids = new Set(cut.split('\n').map(l => /^\s*(n\d+)\[/.exec(l)).filter(Boolean).map(m => m[1]));
  for (const l of cut.split('\n')) {
    const m = /^ {2}(n\d+) \S+ (n\d+)$/.exec(l);
    if (m) assert.ok(ids.has(m[1]) && ids.has(m[2]), 'every edge has both ends in the diagram');
  }
});

test('equivalent tool runs are one node', async () => {
  const snap = emptyFlowSnapshot();
  snap.lanes = [{ id: 'main', parentLaneId: null, depth: 0, label: 'Main', kind: 'main', spawnAnchor: null, returnAnchor: null }];
  const mk = (id, kind, text, extra) => ({ id, laneId: 'main', ordinal: 0, turn: 1, kind, label: text, ts: null, source: {}, checkpoint: null, tokens: null, flags: [], ...extra });
  snap.steps = [mk('p', 'prompt', 'go'), ...[0, 1, 2].map(i => mk('t' + i, 'tool', 'Read: f' + i, { detail: { tool: 'Read' } }))];
  snap.steps.forEach((s, i) => { s.ordinal = i; });
  const lines = body(renderFlowMermaid(snap, META));
  assert.deepEqual(lines, ['flowchart TD', '  n0["prompt: go"]', '  n1["tool: 3 × Read"]', '  n0 --> n1']);
});

test('the module is pure and emits no directive keyword of its own', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'flow-mermaid.js'), 'utf8'));
  assert.doesNotMatch(src, /require\(['"](fs|child_process|electron)['"]\)/);
  assert.doesNotMatch(src, /['"`]\s*(click|call|href|%%\{)/);
});
