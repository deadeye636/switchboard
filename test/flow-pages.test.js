'use strict';
// The paginated Flow export (spec 46, #826, plan T19): pure pagination, headers on every page, rails across a cut, spawn
// and return bars only where they fit, and an inert HTML document.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const FlowLayout = require('../src/shared/flow-layout');
const { validateSnapshot, emptyFlowSnapshot } = require('../src/shared/flow-snapshot');
const { expandedState } = require('../src/app/flow-svg');
const pages = require('../src/app/flow-pages');

const META = { sessionId: 'abcdef123456', backendLabel: 'Claude Code', exportedAt: '2026-01-01T00:00:00.000Z', appVersion: '1.2.3' };

/** Main lane with a prompt, a spawn, an agent lane of `kids` tool calls, a return, then `n` more calls of one tool. */
function synthetic(n, kids = 3) {
  const snap = emptyFlowSnapshot();
  snap.lanes = [
    { id: 'main', parentLaneId: null, depth: 0, label: 'Main', kind: 'main', spawnAnchor: null, returnAnchor: null },
    { id: 'a1', parentLaneId: 'main', depth: 1, label: 'Helper', kind: 'agent', spawnAnchor: { stepId: 'spawn', laneId: 'main' }, returnAnchor: { stepId: 'ret', laneId: 'main' } },
  ];
  const mk = (id, laneId, kind, label, extra) => ({ id, laneId, ordinal: 0, turn: 1, kind, label, ts: null, source: {}, checkpoint: null, tokens: null, flags: [], ...extra });
  const steps = [mk('p', 'main', 'prompt', 'go'), mk('spawn', 'main', 'agent', 'Spawn Helper')];
  for (let i = 0; i < kids; i++) steps.push(mk('c' + i, 'a1', 'tool', 'child ' + i, { detail: { tool: 'Read' } }));
  steps.push(mk('ret', 'main', 'agent', 'Helper returned'));
  for (let i = 0; i < n; i++) steps.push(mk('t' + i, 'main', 'tool', 'Read: file ' + i, { detail: { tool: 'Read' } }));
  steps.forEach((s, i) => { s.ordinal = i; });
  snap.steps = steps;
  return snap;
}

const layoutOf = (snap) => FlowLayout.layout(snap, expandedState(snap));

test('paginate: every row on exactly one page, in order, and the page count follows the formula', () => {
  for (const [n, c1, c2] of [[0, 5, 8], [1, 5, 8], [5, 5, 8], [6, 5, 8], [13, 5, 8], [14, 5, 8], [100, 7, 9], [20000, 20, 25]]) {
    const ps = pages.paginate(n, c1, c2);
    assert.equal(ps.length, pages.pageCountFor(n, c1, c2), `count for ${n}`);
    let next = 0;
    ps.forEach((p, i) => {
      assert.equal(p.from, next);
      assert.ok(p.to - p.from + 1 <= (i === 0 ? c1 : c2));
      next = p.to + 1;
    });
    assert.equal(next, n);
  }
  assert.deepEqual(pages.paginate(0, 5, 8), [{ from: 0, to: -1 }]);
  assert.equal(pages.pageCountFor(14, 5, 8), 3);
});

test('buildPages: each card is on one page, whole, inside the page; every row is drawn once', () => {
  const snap = synthetic(300);
  assert.deepEqual(validateSnapshot(snap).errors, []);
  const lay = layoutOf(snap);
  const out = pages.buildPages(snap, META);
  assert.ok(out.pageCount > 1);
  assert.equal(out.pages.length, out.pageCount);
  assert.equal(out.shownRows, lay.rows.length);
  assert.equal(out.truncated, false);
  let cards = 0;
  out.pages.forEach((svg, i) => {
    const doc = new JSDOM(svg, { contentType: 'image/svg+xml' }).window.document;
    assert.equal(doc.getElementsByTagName('parsererror').length, 0);
    const vbH = Number(doc.documentElement.getAttribute('viewBox').split(' ')[3]);
    const ty = Number(/translate\(0 ([\d.]+)\)/.exec(svg)[1]);
    const rects = Array.from(doc.querySelectorAll('rect[rx="5"]'));
    cards += rects.length;
    for (const r of rects) assert.ok(ty + Number(r.getAttribute('y')) + Number(r.getAttribute('height')) <= vbH, 'a card ends inside the page');
    assert.ok(svg.includes(`Page ${i + 1} of ${out.pageCount}`));
    assert.ok(svg.includes('Session abcdef12'));
    // The legend: lane kind and label as text, on every page.
    assert.ok(svg.includes('main: Main') && svg.includes('agent: Helper'));
  });
  assert.equal(cards, lay.rows.length);
  assert.ok(out.pages[0].includes('exported 2026-01-01'));
  assert.ok(!out.pages[1].includes('exported 2026-01-01'), 'later pages carry the short header');
});

test('rails continue across a page boundary; a bar is drawn only when both ends and its gap row are on the page', () => {
  const snap = synthetic(10, 100);
  const lay = layoutOf(snap);
  const rail = lay.rails.find(r => r.laneId === 'a1');
  assert.ok(rail && rail.toRow - rail.fromRow >= 99);
  const mid = rail.fromRow + 40;
  // A window cutting the agent rail on both sides: both rails run top to bottom, no bar.
  const cut = pages.connectorsForPage(lay, mid, mid + 20);
  assert.equal(cut.filter(c => c.type === 'spawn' || c.type === 'return').length, 0);
  const rails = cut.filter(c => c.type === 'rail');
  assert.equal(rails.length, 2);
  for (const r of rails) { assert.equal(r.fromRow, 0); assert.equal(r.toRow, 20); }
  // Everything on one page: the bars are there, counted from the page's first row.
  const all = pages.connectorsForPage(lay, 0, lay.rows.length - 1);
  assert.equal(all.filter(c => c.type === 'spawn').length, 1);
  assert.equal(all.filter(c => c.type === 'return').length, 1);
  // The page ends inside the agent lane: the spawn is whole, the return (below) is not on it.
  const head = pages.connectorsForPage(lay, 0, rail.fromRow + 10);
  assert.equal(head.filter(c => c.type === 'spawn').length, 1);
  assert.equal(head.filter(c => c.type === 'return').length, 0);
  // The page starts inside the lane: the return is whole, the spawn (above) is not.
  const tail = pages.connectorsForPage(lay, rail.fromRow + 10, lay.rows.length - 1);
  assert.equal(tail.filter(c => c.type === 'spawn').length, 0);
  assert.equal(tail.filter(c => c.type === 'return').length, 1);
  assert.deepEqual(pages.connectorsForPage(lay, 5, 4), []);
});

test('the page cap cuts the file, says so on page 1 and keeps the page numbers honest', () => {
  const out = pages.buildPages(synthetic(400), META, { maxPages: 2 });
  assert.equal(out.pageCount, 2);
  assert.equal(out.truncated, true);
  assert.ok(out.shownRows < out.totalRows);
  assert.ok(out.pages[0].includes('PAGE LIMIT'));
  assert.ok(out.pages[1].includes('Page 2 of 2'));
});

test('a tiny flow still makes one page', () => {
  const out = pages.buildPages(synthetic(0, 0), META);
  assert.equal(out.pageCount, 1);
});

test('the HTML holds one block per page with a page break, and nothing that runs or loads', () => {
  const out = pages.buildPages(synthetic(200), { ...META, backendLabel: '<script>alert(1)</script>' });
  const html = pages.renderHtml(out.pages);
  assert.ok(html.includes('page-break-after: always') && html.includes('@page { size: A4'));
  const doc = new JSDOM(html).window.document;
  assert.equal(doc.querySelectorAll('.page').length, out.pageCount);
  assert.equal(doc.querySelectorAll('script, foreignObject, iframe, object, link, img').length, 0);
  assert.ok(!/\son[a-z]+\s*=/i.test(html));
  assert.ok(!/href\s*=/i.test(html));
  assert.ok(!html.includes('<script'));
  assert.ok(html.includes("default-src 'none'"));
});

test('20 000 steps: bounded pages and time', () => {
  const t0 = Date.now();
  const out = pages.buildPages(synthetic(20000), META);
  const ms = Date.now() - t0;
  assert.ok(out.truncated);
  assert.equal(out.pageCount, pages.MAX_PAGES);
  assert.ok(ms < 20000, `took ${ms} ms`);
});

test('paginate: a first page with room for no rows holds none and the rows start on page 2', () => {
  const ps = pages.paginate(10, 0, 4);
  assert.deepEqual(ps[0], { from: 0, to: -1 });
  assert.equal(ps.length, pages.pageCountFor(10, 0, 4));
  assert.equal(ps[ps.length - 1].to, 9);
  assert.equal(ps[1].from, 0);
});

test('a 4 000-word limitation is cut to a few lines; every row is still on exactly one page, inside it', () => {
  const snap = synthetic(120);
  const words = Array.from({ length: 4000 }, (_, i) => 'word' + i).join(' ');
  snap.limitations = [{ id: 'huge', text: words }, { id: 'huge2', text: words }, { id: 'huge3', text: words }];
  const lay = layoutOf(snap);
  const out = pages.buildPages(snap, META);
  let cards = 0;
  out.pages.forEach((svg) => {
    const doc = new JSDOM(svg, { contentType: 'image/svg+xml' }).window.document;
    const vbH = Number(doc.documentElement.getAttribute('viewBox').split(' ')[3]);
    const ty = Number(/translate\(0 ([\d.]+)\)/.exec(svg)[1]);
    assert.ok(ty < vbH);
    const rects = Array.from(doc.querySelectorAll('rect[rx="5"]'));
    cards += rects.length;
    for (const r of rects) assert.ok(ty + Number(r.getAttribute('y')) + Number(r.getAttribute('height')) <= vbH, 'a card ends inside the page');
  });
  assert.equal(cards, lay.rows.length);
  assert.ok(out.pages[0].includes('word0 ') && !out.pages[0].includes('word3999'));
  assert.ok(out.pages[0].includes('…'));
});

test('the later-page header leaves room between its title line and the legend', () => {
  const out = pages.buildPages(synthetic(200), META);
  const m = /y="(\d+)" font-size="12" fill="#111827" font-weight="bold">Session flow/.exec(out.pages[1]);
  const l = /<text x="16" y="(\d+)" font-size="11" fill="#111827" font-weight="bold">Lanes/.exec(out.pages[1]);
  assert.ok(m && l);
  assert.ok(Number(l[1]) - Number(m[1]) >= 18);
});
