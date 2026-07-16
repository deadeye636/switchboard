// #159 — the charts, and the page's single backend filter.
//
// These render the real builders into jsdom (same strategy as stats-cost.test.js). What they are really
// guarding is not "a div appeared" but the claims the charts make: a backend that reports no money must
// get NO cost chart rather than a row of free days, and a bucket whose hour is unknown must not be drawn
// at midnight.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const SRC_DIR = path.join(__dirname, '..', 'src');
const INDEX_HTML = `<!DOCTYPE html><html><body><div id="stats-viewer-body"></div></body></html>`;

const BACKENDS = {
  claude: { id: 'claude', label: 'Claude Code', monogram: 'C' },
  codex: { id: 'codex', label: 'Codex', monogram: 'X' },
  hermes: { id: 'hermes', label: 'Hermes', monogram: 'H' },
};

function setup() {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  const stubs = {
    statsViewerBody: window.document.getElementById('stats-viewer-body'),
    cachedAllProjects: [],
    sessionBackendId: (s) => s.backendId || 'claude',
    getBackend: (id) => BACKENDS[id] || null,
    launchableBackends: () => Object.values(BACKENDS),
    renderBackendIcon: () => window.document.createElement('span'),
  };
  for (const [k, v] of Object.entries(stubs)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }
  vm.runInContext(fs.readFileSync(path.join(SRC_DIR, 'renderer', 'lib', 'utils.js'), 'utf8'), dom.getInternalVMContext());
  vm.runInContext(fs.readFileSync(path.join(SRC_DIR, 'renderer', 'views', 'stats-view.js'), 'utf8'), dom.getInternalVMContext());
  return window;
}

/** A local YYYY-MM-DD `n` days ago — the charts only draw the last 30 days. */
function daysAgo(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// --- the page filter -----------------------------------------------------------------------------

test('the filter bar offers All plus every launchable backend, Claude first', () => {
  const window = setup();
  window.buildBackendFilterBar();
  const pills = Array.from(window.document.querySelectorAll('.backend-filter-pill'))
    .map(b => b.dataset.backend);
  assert.deepEqual(pills, ['all', 'claude', 'codex', 'hermes']);
  assert.equal(window.document.querySelector('.backend-filter-pill.active').dataset.backend, 'all');
});

test('the filter is the FIRST thing on the page — it scopes everything below it', () => {
  const window = setup();
  window.buildBackendFilterBar();
  assert.ok(window.statsViewerBody.firstElementChild.classList.contains('stats-filter-bar'));
});

test('setStatsBackendFilter reports whether anything actually changed', () => {
  const window = setup();
  assert.equal(window.setStatsBackendFilter('hermes'), true);
  assert.equal(window.setStatsBackendFilter('hermes'), false, 'the same pill twice must not re-read the DB');
  assert.equal(window.setStatsBackendFilter('all'), true);
});

// --- tokens by backend ---------------------------------------------------------------------------

test('the stacked chart draws one segment per backend that worked that day', () => {
  const window = setup();
  window.buildBackendTokensChart({
    dailyBackendTokens: [
      { date: daysAgo(1), tokensByBackend: { claude: 300, codex: 100 } },
      { date: daysAgo(2), tokensByBackend: { claude: 50 } },
    ],
  });
  const cols = window.document.querySelectorAll('.stacked-chart .daily-chart-col');
  assert.equal(cols.length, 30, 'always a full 30-day axis, gaps included');

  const segs = window.document.querySelectorAll('.stacked-seg');
  assert.equal(segs.length, 3, 'two backends yesterday + one the day before');
  // Legend names the backends, so a colour is never the only carrier of meaning.
  const legend = Array.from(window.document.querySelectorAll('.chart-legend-item')).map(e => e.textContent);
  assert.deepEqual(legend, ['Claude Code', 'Codex']);
});

test('the stacked chart is skipped when nothing falls inside the window', () => {
  const window = setup();
  window.buildBackendTokensChart({
    dailyBackendTokens: [{ date: '2020-01-01', tokensByBackend: { claude: 300 } }],
  });
  assert.equal(window.document.querySelector('.stacked-chart'), null, 'an empty chart is worse than none');
});

// --- cost ----------------------------------------------------------------------------------------

// The single most important claim on the page. Claude and Codex report no money at all; summing their
// absent figures into 0 and drawing a flat line would tell the user their work was free.
test('a backend that reports no cost gets NO cost chart — not a row of free days', () => {
  const window = setup();
  window.buildCostChart({ dailyCost: [] });
  assert.equal(window.document.querySelector('.cost-chart'), null);

  // Even a series that exists but prices nothing draws nothing.
  window.buildCostChart({ dailyCost: [{ date: daysAgo(1), estimatedCostUsd: 0, actualCostUsd: null }] });
  assert.equal(window.document.querySelector('.cost-chart'), null);
});

test('an estimate is coloured and labelled as an estimate, never as a bill', () => {
  const window = setup();
  window.buildCostChart({
    dailyCost: [{ date: daysAgo(1), estimatedCostUsd: 0.5, actualCostUsd: null }],
  });
  const bar = window.document.querySelector('.cost-bar.is-estimated');
  assert.ok(bar, 'the estimated bar carries its own class');
  assert.match(bar.parentElement.title, /~\$0\.50/, 'and its tooltip says ~');
  assert.match(window.document.querySelector('.chart-subtitle').textContent, /estimate, not a bill/i);
});

test('a settled amount is shown as settled', () => {
  const window = setup();
  const day = daysAgo(1);
  window.buildCostChart({
    dailyCost: [{ date: day, estimatedCostUsd: 0.5, actualCostUsd: 0.42 }],
  });
  // The axis is always 30 days, so pick the column that actually holds the money — not the first one.
  const col = Array.from(window.document.querySelectorAll('.cost-chart .daily-chart-col'))
    .find(c => c.title.startsWith(day));
  assert.ok(col, 'the day is on the axis');
  assert.match(col.title, /\$0\.42/, 'the settled figure wins over the estimate');
  assert.doesNotMatch(col.title, /~/, 'and it is NOT marked as an estimate');
  assert.equal(col.querySelector('.cost-bar').classList.contains('is-estimated'), false);

  // Every other day reported nothing — and says so, rather than claiming it was free.
  const quiet = Array.from(window.document.querySelectorAll('.cost-chart .daily-chart-col'))
    .filter(c => !c.title.startsWith(day));
  assert.equal(quiet.length, 29);
  assert.ok(quiet.every(c => /no cost reported/.test(c.title)));
});

// --- the hour grid -------------------------------------------------------------------------------

test('the hour grid is 7 days x 24 hours, with the day and hour rulers', () => {
  const window = setup();
  window.buildHourGrid({ hourlyActivity: [{ weekday: 1, hour: 9, messageCount: 5 }] });
  assert.equal(window.document.querySelectorAll('.hour-grid-cell').length, 7 * 24);
  assert.equal(window.document.querySelectorAll('.hour-grid-day-label').length, 7);
  assert.equal(window.document.querySelectorAll('.hour-grid-hour-label').length, 24);

  const cells = Array.from(window.document.querySelectorAll('.hour-grid-cell'));
  const lit = cells.filter(c => !c.classList.contains('heatmap-level-0'));
  assert.equal(lit.length, 1, 'exactly the one hour that had activity');
  assert.match(lit[0].title, /Mon 09:00 — 5 messages/);
});

test('the hour grid is skipped entirely when no backend could place its work in time', () => {
  const window = setup();
  window.buildHourGrid({ hourlyActivity: [] });
  assert.equal(window.document.querySelector('.hour-grid'), null);
});

// --- tokens by model -----------------------------------------------------------------------------

test('models are ranked by tokens and carry their share', () => {
  const window = setup();
  window.buildModelTokensChart({
    modelUsage: {
      'opus': { inputTokens: 600, outputTokens: 150 },
      'sonnet': { inputTokens: 200, outputTokens: 50 },
      'unused': { inputTokens: 0, outputTokens: 0 },
    },
  });
  const names = Array.from(window.document.querySelectorAll('.model-bar-name')).map(e => e.textContent);
  assert.deepEqual(names, ['opus', 'sonnet'], 'biggest first; a model with no tokens is not a row');

  const values = Array.from(window.document.querySelectorAll('.model-bar-value')).map(e => e.textContent);
  assert.match(values[0], /75%/);   // 750 of 1000
  assert.match(values[1], /25%/);
  // The widest bar is the biggest model — the bar is relative to the leader, not to the total.
  assert.equal(window.document.querySelectorAll('.model-bar-fill')[0].style.width, '100%');
});
