'use strict';
// The Flow SVG export (spec 46, #826, plan T18): complete (everything expanded), well-formed, inert, escaped, estimated
// values marked in words, and the graph stays in the gutter.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const backends = require('../src/backends');
const FlowLayout = require('../src/shared/flow-layout');
const { validateSnapshot, emptyFlowSnapshot } = require('../src/shared/flow-snapshot');
const { renderFlowSvg, esc, ROW_H, CARD_W } = require('../src/app/flow-svg');

const FIX = path.join(__dirname, 'fixtures', 'flow');
const META = { sessionId: 'abcdef123456', exportedAt: '2026-01-01T00:00:00.000Z', appVersion: '1.2.3' };

async function readFixture(name, backend = 'claude') {
  const b = backends.get(backend);
  return b.readSessionFlow([{ sourceId: 'm', file: path.join(FIX, name), role: 'main', laneHint: 'main' }], {});
}

function parse(svg) {
  const doc = new JSDOM(svg, { contentType: 'image/svg+xml' }).window.document;
  assert.equal(doc.getElementsByTagName('parsererror').length, 0, 'the SVG must be well-formed XML');
  return doc;
}

function expanded(snap) {
  const s = FlowLayout.emptyCollapseState();
  for (const l of snap.lanes) s.lanes[l.id] = true;
  for (const st of snap.steps) s.groups['g:' + st.id] = true;
  return s;
}

/** A snapshot with a main lane, one agent lane that has a spawn and a return, and many tool calls of the same tool. */
function synthetic(n, labelOf) {
  const snap = emptyFlowSnapshot();
  snap.lanes = [
    { id: 'main', parentLaneId: null, depth: 0, label: 'Main', kind: 'main', spawnAnchor: null, returnAnchor: null },
    { id: 'a1', parentLaneId: 'main', depth: 1, label: 'Helper', kind: 'agent', spawnAnchor: { stepId: 'spawn', laneId: 'main' }, returnAnchor: { stepId: 'ret', laneId: 'main' } },
  ];
  const mk = (id, laneId, kind, label, extra) => ({ id, laneId, ordinal: 0, turn: 1, kind, label, ts: null, source: {}, checkpoint: null, tokens: null, flags: [], ...extra });
  const steps = [mk('p', 'main', 'prompt', 'go'), mk('spawn', 'main', 'agent', 'Spawn Helper')];
  for (let i = 0; i < 3; i++) steps.push(mk('c' + i, 'a1', 'tool', 'child ' + i, { detail: { tool: 'Read' } }));
  steps.push(mk('ret', 'main', 'agent', 'Helper returned'));
  for (let i = 0; i < n; i++) steps.push(mk('t' + i, 'main', 'tool', labelOf ? labelOf(i) : 'Read: file ' + i, { detail: { tool: 'Read' } }));
  steps.forEach((s, i) => { s.ordinal = i; });
  snap.steps = steps;
  return snap;
}

test('every row beyond any viewport is drawn: the layout is fully expanded', () => {
  const snap = synthetic(500);
  assert.deepEqual(validateSnapshot(snap).errors, []);
  const svg = renderFlowSvg(snap, META);
  const doc = parse(svg);
  const cards = doc.querySelectorAll('rect[rx="5"]').length;
  const open = FlowLayout.layout(snap, expanded(snap));
  assert.equal(cards, open.rows.length);
  assert.ok(cards > 500);
  assert.ok(svg.includes('child 2'), 'the child lane is open');
  assert.ok(svg.includes('file 499'), 'the last call of a run is drawn');
});

test('a real fixture renders well-formed, with the header and the limitations', async () => {
  const snap = await readFixture('claude-main.jsonl');
  const svg = renderFlowSvg(snap, META);
  const doc = parse(svg);
  assert.equal(doc.documentElement.localName, 'svg');
  assert.ok(svg.includes('Session abcdef12'));
  assert.ok(svg.includes('exported 2026-01-01T00:00:00.000Z'));
  assert.ok(svg.includes('Switchboard 1.2.3'));
  assert.ok(svg.includes('Limitations ('));
  assert.ok(svg.includes('Add a greeting function.'));
});

test('the document is inert: no script, handler, foreignObject or reference', () => {
  const snap = synthetic(5, () => '<script>alert(1)</script> & "q" onload=1');
  const svg = renderFlowSvg(snap, META);
  const doc = parse(svg);
  assert.equal(doc.getElementsByTagName('script').length, 0);
  assert.equal(doc.getElementsByTagName('foreignObject').length, 0);
  for (const el of doc.getElementsByTagName('*')) {
    for (const a of el.attributes) {
      assert.ok(!/^on/i.test(a.name), 'no event handler attribute: ' + a.name);
      assert.ok(!/href/i.test(a.name), 'no href');
    }
  }
  assert.ok(!/xlink|url\(|@import|https?:\/\//i.test(svg.replace('http://www.w3.org/2000/svg', '')));
  assert.ok(doc.documentElement.textContent.includes('<script>alert(1)</script> & "q"'), 'the text survives, escaped');
});

test('esc escapes the five characters and drops what XML cannot carry', () => {
  assert.equal(esc('<&>"\''), '&lt;&amp;&gt;&quot;&apos;');
  assert.equal(esc('a\u0000b\u0008c'), 'abc');
  assert.equal(esc('\ud800'), '�');
});

test('an estimated value says so in words and is drawn dashed; a measured one is not', () => {
  const snap = synthetic(0);
  const cp = (basis) => ({ input: { value: 52400, unit: 'tokens', basis: 'measured' }, window: { value: 200000, unit: 'tokens', basis }, model: 'm' });
  snap.steps[0].checkpoint = cp('estimated');
  snap.steps[1].checkpoint = cp('measured');
  const svg = renderFlowSvg(snap, META);
  const doc = parse(svg);
  assert.ok(svg.includes('52k / 200k') || svg.includes('52.4k / 200k'));
  assert.ok(/estimated/.test(doc.documentElement.textContent));
  assert.equal(doc.querySelectorAll('rect[stroke-dasharray]').length, 1);
});

test('no connector box enters the card area', async () => {
  for (const snap of [synthetic(3), await readFixture('claude-parent.jsonl')]) {
    const lay = FlowLayout.layout(snap, expanded(snap));
    const gutter = FlowLayout.gutterWidth(lay.stats.cols);
    const { connectors } = FlowLayout.connectorsForRows(lay, 0, lay.rows.length - 1, 1e6);
    for (const c of connectors) for (const r of FlowLayout.connectorRects(c, ROW_H)) assert.ok(r.x + r.w <= gutter, 'inside the gutter');
    const doc = parse(renderFlowSvg(snap, META));
    for (const card of doc.querySelectorAll('rect[rx="5"]')) assert.ok(Number(card.getAttribute('x')) >= gutter);
    assert.ok(Number(doc.documentElement.getAttribute('width')) >= gutter + CARD_W);
  }
});

test('a partial snapshot says so in the header', () => {
  const snap = synthetic(1);
  snap.complete = false;
  assert.ok(renderFlowSvg(snap, META).includes('PARTIAL'));
});

test('20 000 steps render in bounded time and the file stays well-formed', () => {
  const snap = synthetic(20000);
  const t0 = process.hrtime.bigint();
  const svg = renderFlowSvg(snap, META);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 5000, 'took ' + ms + ' ms');
  assert.ok(svg.endsWith('</svg>\n'));
  assert.ok(svg.split('rx="5"').length - 1 > 20000);
});

test('a long model name and a long URL in a limitation are broken, not run off the page', () => {
  const snap = synthetic(1);
  const longModel = 'm'.repeat(400);
  snap.steps.unshift({ id: 'st', laneId: 'main', ordinal: -1, turn: null, kind: 'start', label: 'Session start', ts: null, source: {}, checkpoint: null, tokens: null, flags: [], detail: { model: longModel } });
  const url = 'u'.repeat(600);
  snap.limitations = [{ id: 'nothing-read', text: 'See ' + url }];
  const svg = renderFlowSvg(snap, META);
  const doc = parse(svg);
  for (const t of doc.querySelectorAll('text')) assert.ok(t.textContent.length <= 130, 'a line is at most 130 characters');
});

test('card meta is cut so it never overlaps the right-anchored checkpoint text', () => {
  const snap = synthetic(1);
  snap.lanes[1].label = 'L'.repeat(300);
  const doc = parse(renderFlowSvg(snap, META));
  for (const t of doc.querySelectorAll('text[font-size="9"]')) {
    if (t.getAttribute('text-anchor') === 'end' || t.getAttribute('font-weight') === 'bold') continue;
    assert.ok(t.textContent.length * 5 + Number(t.getAttribute('x')) < CARD_W + 400, 'meta stays inside the card');
    assert.ok(t.textContent.length <= 160);
  }
});
