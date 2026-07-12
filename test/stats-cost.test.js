// T-5.5 — the cost + lineage dimension of the Stats per-backend breakdown.
//
// The point of these tests is that cost stays a BACKEND-AGNOSTIC metric: it is read off the cached
// rows, shown where a backend reports one, and omitted (not zeroed) where none does. And that an
// estimate is never presented as a settled bill.
//
// Strategy mirrors dom-work-files-view.test.js: load utils.js + stats-view.js into a jsdom window
// with the handful of globals app.js/backend-registry.js normally provide.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const INDEX_HTML = `<!DOCTYPE html><html><body><div id="stats-viewer-body"></div></body></html>`;

function evalInWindow(dom, file) {
  const src = fs.readFileSync(file, 'utf8');
  vm.runInContext(src, dom.getInternalVMContext(), { filename: file });
}

const BACKENDS = {
  claude: { id: 'claude', label: 'Claude Code', monogram: 'C' },
  hermes: { id: 'hermes', label: 'Hermes', monogram: 'H' },
};

function setup(projects) {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;

  const stubs = {
    statsViewerBody: window.document.getElementById('stats-viewer-body'),
    cachedAllProjects: projects,
    sessionBackendId: (s) => s.backendId || 'claude',
    getBackend: (id) => BACKENDS[id] || null,
    launchableBackends: () => Object.values(BACKENDS),
    renderBackendIcon: () => window.document.createElement('span'),
  };
  for (const [k, v] of Object.entries(stubs)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }

  evalInWindow(dom, path.join(PUBLIC_DIR, 'utils.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'stats-view.js'));

  window.buildBackendBreakdown();
  return window;
}

/** A Hermes project: one estimated-cost session, one settled one, the second chained to the first. */
function hermesProjects() {
  return [{
    projectPath: '/p',
    sessions: [
      {
        sessionId: 'h1', backendId: 'hermes', messageCount: 10, inputTokens: 100, outputTokens: 50,
        estimatedCostUsd: 0.02, actualCostUsd: null, costStatus: 'estimated', lineageParentId: null,
      },
      {
        sessionId: 'h2', backendId: 'hermes', messageCount: 4, inputTokens: 20, outputTokens: 10,
        estimatedCostUsd: 0.04, actualCostUsd: 0.03, costStatus: 'actual', lineageParentId: 'h1',
      },
      {
        sessionId: 'c1', backendId: 'claude', messageCount: 7, inputTokens: 90, outputTokens: 30,
        estimatedCostUsd: null, actualCostUsd: null, costStatus: null, lineageParentId: null,
      },
    ],
  }];
}

function selectBackend(window, id) {
  window.document.querySelector(`.backend-filter-pill[data-backend="${id}"]`).click();
}

test('a backend that reports no cost shows an em dash, not $0.00', () => {
  const window = setup(hermesProjects());
  const cards = Array.from(window.document.querySelectorAll('.backend-stat-card'));
  const claudeCard = cards.find(c => c.textContent.includes('Claude Code'));
  const cell = claudeCard.querySelector('.backend-cost-none');
  assert.ok(cell, 'Claude card must carry the token-only marker');
  assert.equal(cell.textContent, '—');
  assert.equal(claudeCard.querySelector('.backend-cost'), null, 'no cost figure for a token-only backend');
  assert.ok(!claudeCard.textContent.includes('$0.00'), 'a token-only backend must never read as "free"');
});

test('a mixed estimated/actual sum is marked as an estimate', () => {
  const window = setup(hermesProjects());
  const cards = Array.from(window.document.querySelectorAll('.backend-stat-card'));
  const hermesCard = cards.find(c => c.textContent.includes('Hermes'));
  const cell = hermesCard.querySelector('.backend-cost');
  // 0.02 (estimated) + 0.03 (actual, preferred over its own 0.04 estimate) = 0.05, and because one
  // component was an estimate the whole figure is one.
  assert.equal(cell.textContent, '~$0.05');
  assert.match(cell.title, /Estimated/);
});

test('a fully settled backend is not labelled as an estimate', () => {
  const window = setup([{
    projectPath: '/p',
    sessions: [{
      sessionId: 'h1', backendId: 'hermes', messageCount: 1,
      estimatedCostUsd: 0.9, actualCostUsd: 1.25, costStatus: 'actual', lineageParentId: null,
    }],
  }]);
  const cell = window.document.querySelector('.backend-stat-card .backend-cost');
  assert.equal(cell.textContent, '$1.25');
  assert.match(cell.title, /settled/);
  assert.ok(!cell.classList.contains('is-estimated'), 'a settled amount is not coloured as an estimate');
});

test('an actual figure the backend has NOT settled stays an estimate', () => {
  // The failure mode T-5.5 exists to prevent: Hermes can carry an actual_cost_usd while cost_status
  // still says 'pending'/'estimated'. The status decides, not the mere presence of the number.
  const window = setup([{
    projectPath: '/p',
    sessions: [{
      sessionId: 'h1', backendId: 'hermes', messageCount: 1,
      estimatedCostUsd: 1.1, actualCostUsd: 1.2, costStatus: 'pending', lineageParentId: null,
    }],
  }]);
  const cell = window.document.querySelector('.backend-stat-card .backend-cost');
  assert.equal(cell.textContent, '~$1.20', 'the better number, still labelled an estimate');
  assert.match(cell.title, /Estimated/);
});

test('a cost with no status at all reads as an estimate, not as a bill', () => {
  // Asymmetric on purpose: only an explicit settled status makes a figure a bill. An unknown or
  // missing status must degrade to "estimate" — being wrong that way costs a `~`, being wrong the
  // other way presents a guess as an invoice.
  const window = setup([{
    projectPath: '/p',
    sessions: [{
      sessionId: 'h1', backendId: 'hermes', messageCount: 1,
      estimatedCostUsd: null, actualCostUsd: 2.5, costStatus: null, lineageParentId: null,
    }],
  }]);
  const cell = window.document.querySelector('.backend-stat-card .backend-cost');
  assert.equal(cell.textContent, '~$2.50');
  assert.ok(cell.classList.contains('is-estimated'), 'and it is coloured as an estimate');
});

test('an unrecognised cost status also degrades to an estimate', () => {
  const window = setup([{
    projectPath: '/p',
    sessions: [{
      sessionId: 'h1', backendId: 'hermes', messageCount: 1,
      estimatedCostUsd: 1, actualCostUsd: 3, costStatus: 'reconciling-with-provider', lineageParentId: null,
    }],
  }]);
  assert.equal(window.document.querySelector('.backend-stat-card .backend-cost').textContent, '~$3.00');
});

test('the selected-backend view breaks out cost, per-session cost and lineage', () => {
  const window = setup(hermesProjects());
  selectBackend(window, 'hermes');
  const labels = Array.from(window.document.querySelectorAll('.stat-card-label')).map(e => e.textContent);
  const values = Array.from(window.document.querySelectorAll('.stat-card-value')).map(e => e.textContent);
  assert.ok(labels.includes('Est. cost (USD)'), 'cost card present');
  assert.ok(labels.includes('Per session'), 'per-session cost present');
  assert.ok(labels.includes('Chained sessions'), 'lineage present');
  assert.equal(values[labels.indexOf('Est. cost (USD)')], '~$0.05');
  assert.equal(values[labels.indexOf('Per session')], '~$0.03'); // 0.05 over 2 costed sessions
  assert.equal(values[labels.indexOf('Chained sessions')], '1');

  // The drill-down carries the same colour language as the comparison cards.
  const valueEls = Array.from(window.document.querySelectorAll('.stat-card-value'));
  assert.ok(valueEls[labels.indexOf('Est. cost (USD)')].classList.contains('is-estimated'));
  assert.ok(valueEls[labels.indexOf('Per session')].classList.contains('is-estimated'));
});

test('the selected-backend view omits cost and lineage for a token-only backend', () => {
  const window = setup(hermesProjects());
  selectBackend(window, 'claude');
  const labels = Array.from(window.document.querySelectorAll('.stat-card-label')).map(e => e.textContent);
  assert.ok(labels.includes('Sessions'), 'the normal cards still render');
  assert.ok(!labels.some(l => /cost/i.test(l)), 'no cost card for a backend that reports none');
  assert.ok(!labels.includes('Chained sessions'), 'no lineage card without lineage');
});

test('the cost legend appears only once some backend reports a cost', () => {
  const withCost = setup(hermesProjects());
  assert.ok(withCost.document.querySelector('.backend-cost-legend'), 'legend shown when a cost exists');

  const claudeOnly = setup([{
    projectPath: '/p',
    sessions: [{ sessionId: 'c1', backendId: 'claude', messageCount: 3 }],
  }]);
  assert.equal(claudeOnly.document.querySelector('.backend-cost-legend'), null,
    'a Claude-only user never sees a cost legend');
});

test('a ZERO estimate is not reported as a cost at all', () => {
  // The live Hermes run produced exactly this: estimated_cost_usd = 0 on a session with real token
  // usage. That means "no pricing for this model", not "free" — printing "~$0.00" would invent a fact.
  const window = setup([{
    projectPath: '/p',
    sessions: [{
      sessionId: 'h1', backendId: 'hermes', messageCount: 6, inputTokens: 900, outputTokens: 300,
      estimatedCostUsd: 0, actualCostUsd: null, costStatus: 'estimated', lineageParentId: null,
    }],
  }]);
  const card = Array.from(window.document.querySelectorAll('.backend-stat-card'))
    .find(c => c.textContent.includes('Hermes'));
  assert.ok(card.querySelector('.backend-cost-none'), 'reads as "no cost reported"');
  assert.equal(card.querySelector('.backend-cost'), null);
  assert.ok(!card.textContent.includes('$0.00'));
  assert.equal(window.document.querySelector('.backend-cost-legend'), null,
    'and a zero estimate does not conjure the cost legend');
});

test('a SETTLED zero is kept — a backend saying "this cost nothing" is a real statement', () => {
  const window = setup([{
    projectPath: '/p',
    sessions: [{
      sessionId: 'h1', backendId: 'hermes', messageCount: 2,
      estimatedCostUsd: null, actualCostUsd: 0, costStatus: 'actual', lineageParentId: null,
    }],
  }]);
  assert.equal(window.document.querySelector('.backend-stat-card .backend-cost').textContent, '$0.00');
});

test('sub-cent cost does not collapse to $0.00', () => {
  const window = setup([{
    projectPath: '/p',
    sessions: [{
      sessionId: 'h1', backendId: 'hermes', messageCount: 1,
      estimatedCostUsd: 0.004, actualCostUsd: null, costStatus: 'estimated', lineageParentId: null,
    }],
  }]);
  assert.equal(window.document.querySelector('.backend-stat-card .backend-cost').textContent, '~<$0.01');
});
