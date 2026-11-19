// --- Stats view ---
// The Stats page (#877, spec 48): one sticky filter bar, a row of key figures with the change against the previous
// period, the main chart (T4c), the Rhythm block and the rate limits. Every figure comes from `window.api.getStats`
// (src/app/stats.js): main sanitises the filter, remembers it and answers with the filter it actually ran, so the bar
// shows the echo, never what was sent. Names no backend: labels come from the payload.
//
// Depends on globals: mountStatsChart + unmountStatsChart (views/stats-chart.js, loaded before this file), statsViewerBody (app.js),
//   getUsageLimitCards + observedAgo (shell/usage-status.js), renderBackendIcon (backend-icons.js, rate limits) and
//   backendIconKnownColour (backend-icons.js, the chart's colour tokens), openSession (app.js) and sessionMap (app.js), which
//   a Sessions row opens through (the sidebar's own path), and showControlToast (dialogs/control-dialogs.js, the export's outcome;
//   feature-detected), all read at call time.

let cachedUsage = null;
let usageGen = 0;

// A reply to an older request must never overwrite a newer one: every request takes a number, and only the latest keeps it.
let statsGen = 0;
// What the page last showed: the echoed filter and view, the payload, the dropdown choices (null until read).
let statsState = { filter: null, view: null, payload: null, facets: null };
// What the last request SENT (not what main echoed): a second change made before the first reply builds on this, so it does
// not undo the first. The page itself is always drawn from the echo in statsState.
let statsPending = { filter: null, view: null };
// The Rhythm fold the user set since the last answer landed (null = not touched): it wins over the echo of a request that
// left before the click.
let statsRhythmFold = null;

/** The filter and view the next change builds on: what was last sent, else what was last shown. */
function statsBase() {
  return { filter: statsPending.filter || statsState.filter, view: statsPending.view || statsState.view };
}

const STATS_RANGES = [
  { kind: '7d', label: '7 days' },
  { kind: '30d', label: '30 days' },
  { kind: '90d', label: '90 days' },
  { kind: 'year', label: 'Year' },
  { kind: 'all', label: 'All' },
];

// Local YYYY-MM-DD. NOT toISOString().slice(0,10): that formats a local-midnight
// Date as UTC, so in TZ+n the day axis lands one calendar day off from where the
// bulk of that day's activity is bucketed (issue #75).
function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatUsd(usd) {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return '$' + usd.toFixed(2);
}

function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtCount(n) {
  return Number(n || 0).toLocaleString('en-US');
}

// --- pure helpers (tested in test/stats-view-logic.test.js) ---------------------------------------------------------------

/**
 * The change against the previous period as text. `value` is a ratio ((cur - prev) / prev) or, for `points`, a
 * difference of two rates. null (no previous period, a zero base, a missing figure) is "—", never "0%".
 */
function statsChangeText(value, unit) {
  if (value == null || !Number.isFinite(value)) return '—';
  const n = Math.round(value * 100);
  if (n === 0) return unit === 'points' ? '0 pt' : '0%';
  const sign = n > 0 ? '+' : '−';
  return sign + Math.abs(n) + (unit === 'points' ? ' pt' : '%');
}

/** "2026-11-01 – 2026-11-18" (a single day is one key). */
function statsRangeText(range) {
  if (!range || !range.from) return '';
  return range.from === range.to ? range.from : `${range.from} – ${range.to}`;
}

/** What the change line is measured against: the previous period, or why there is none. */
function statsCompareText(range) {
  if (!range) return '';
  if (range.prevFrom == null) return 'No previous period for this range';
  return `Change against ${statsRangeText({ from: range.prevFrom, to: range.prevTo })}` + (range.includesToday ? ' (this period includes today)' : '');
}

/** True when the answer holds nothing to draw: the bar stays, an empty state replaces the blocks. */
function statsIsEmpty(payload) {
  const cur = payload && payload.keyFigures && payload.keyFigures.cur;
  if (!cur) return true;
  return !cur.sessions && !cur.messages && !cur.tokens;
}

/** A filter with one field changed. A range is given as a kind; the others as a value or null. */
function statsFilterWith(filter, patch) {
  const next = { ...(filter || {}) };
  if (patch.range) next.range = { kind: patch.range };
  // A concrete span (a clicked bucket): `{ kind: 'day' | 'custom', from, to }`, which main's sanitiser accepts as it is.
  if (patch.rangeSpec) next.range = { ...patch.rangeSpec };
  for (const k of ['backend', 'project', 'model']) {
    if (k in patch) next[k] = patch[k] || null;
  }
  return next;
}

/** True when no bucket of the series holds a value: the chart says so instead of drawing an empty axis. */
function statsSeriesEmpty(series) {
  const buckets = (series && series.buckets) || [];
  return !buckets.some(b => Object.values(b.values || {}).some(v => v > 0));
}

/**
 * The range a click on a bucket sets (O5): the bucket's own days, cut to the range on screen so a week or month at the edge
 * does not widen it. One day is `day`, more is `custom`; null when the bucket lies outside the range.
 */
function statsBucketSpan(bucket, range) {
  if (!bucket || !range || !range.from) return null;
  const from = bucket.start < range.from ? range.from : bucket.start;
  const to = bucket.end > range.to ? range.to : bucket.end;
  if (from > to) return null;
  return from === to ? { kind: 'day', from, to } : { kind: 'custom', from, to };
}

/** The range a click on a heatmap day sets (O1 = A): that day alone, or null for anything that is not a day key. */
function statsDaySpan(dateKey) {
  if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
  return { kind: 'day', from: dateKey, to: dateKey };
}

/**
 * Where a key moves the heatmap's focus, as an index into the in-window days (oldest first; clamped, never into an outside
 * cell). Spatial, like the drawn layout (columns are weeks, rows are weekdays): Up/Down = previous/next day in the column;
 * Left/Right = 7 days back/on (the neighbouring column, same weekday); PageUp/PageDown = 4 weeks; Home/End = the first/last
 * day. A step past either end clamps to the first/last in-window day. Null for a key the heatmap does not own.
 */
function statsHeatmapKeyTarget(key, index, count) {
  if (!(count > 0) || !(index >= 0)) return null;
  const step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7, PageUp: -28, PageDown: 28 }[key];
  if (step !== undefined) return Math.max(0, Math.min(count - 1, index + step));
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

// The day just applied from the heatmap and the request it belongs to: `{ date, gen }`. Only the answer to exactly that request
// may move focus; any other request or an error clears it (`requestStats`, `renderStatsPage`). An empty page answering the
// heatmap's own request still gets it, because the heatmap is drawn there too.
let statsHeatmapRefocus = null;

/** A click or Enter/Space on a heatmap day: the range becomes that day, unless it already is. */
function statsHeatmapApplyDay(dateKey) {
  const span = statsDaySpan(dateKey);
  const range = statsState.payload && statsState.payload.range;
  if (!span || (range && span.from === range.from && span.to === range.to)) return;
  applyFilter({ rangeSpec: span }); // starts the request (and clears any older refocus) before it returns
  statsHeatmapRefocus = { date: dateKey, gen: statsGen };
}

/**
 * At the start of a draw, before anything is replaced: the date to give focus back to, or null. Consumes the refocus. It
 * applies only to the answer of the request the heatmap started, and only if focus was then on the heatmap or nowhere.
 */
function statsHeatmapTakeRefocus() {
  const want = statsHeatmapRefocus;
  statsHeatmapRefocus = null;
  if (!want || want.gen !== statsGen) return null;
  const active = document.activeElement;
  const free = !active || active === document.body || !!(active.closest && active.closest('.heatmap-grid'));
  return free ? want.date : null;
}

/** After the redraw: focus the cell of that day if it is drawn. */
function statsHeatmapRestoreFocus(date) {
  if (!date) return;
  const cell = statsViewerBody.querySelector(`.heatmap-cell[data-date="${date}"]`);
  if (!cell) return;
  for (const c of statsViewerBody.querySelectorAll('.heatmap-cell[tabindex="0"]')) c.tabIndex = -1;
  cell.tabIndex = 0;
  cell.focus();
}

/** True when the filter says the Rhythm block is folded (remembered with the filter, spec 48 V6). */
function statsRhythmCollapsed(filter) {
  return !!(filter && filter.rhythmCollapsed === true);
}

/** The label of a filter value before the dropdown choices have arrived, taken from what the payload already names. */
function statsKnownLabel(field, value, payload) {
  if (!value) return '';
  if (field === 'backend') {
    const hit = payload && (payload.backends || []).find(b => b.id === value);
    return hit ? hit.label : value;
  }
  if (field === 'project') {
    // main's own owner paths on both sides, looked up by the value it echoed: no spelling is compared here.
    const names = new Map(((payload && payload.projects) || []).map(p => [p.projectPath, p.name]));
    return names.get(value) || value;
  }
  return value;
}

/**
 * Rows sorted by one column. `get` reads the value of a row: a number sorts numerically, a string by locale (case
 * ignored), and a missing value (null, undefined, NaN, "") is LAST in both directions, so a dash never leads a table.
 * Returns a new array; ties keep their incoming order.
 */
function statsSortRows(rows, get, dir) {
  const sign = dir === 'asc' ? 1 : -1;
  const missing = (v) => v == null || v === '' || (typeof v === 'number' && !Number.isFinite(v));
  return (rows || []).map((row, i) => ({ row, i, v: get(row) })).sort((a, b) => {
    const ma = missing(a.v), mb = missing(b.v);
    if (ma || mb) return ma && mb ? a.i - b.i : (ma ? 1 : -1);
    let c;
    if (typeof a.v === 'number' && typeof b.v === 'number') c = a.v - b.v;
    else c = String(a.v).localeCompare(String(b.v), undefined, { sensitivity: 'base', numeric: true });
    return c ? c * sign : a.i - b.i;
  }).map(x => x.row);
}

/** A cost object ({ usd, estimated } or null) as the cell text: "~" in front of an estimate, a dash when none is reported. */
function statsCostText(cost) {
  return cost ? (cost.estimated ? '~' : '') + formatUsd(cost.usd) : '—';
}

// --- the breakdown tables (V4) ---------------------------------------------------------------------------------------------

// Per-viewer convenience only (renderer rule): the tab and each tab's sort. Never part of `statsFilter`, never sent to main.
const STATS_TABLE_KEY = 'statsTable';
let statsTable = { tab: 'projects', sort: {} };
try {
  const raw = JSON.parse(localStorage.getItem(STATS_TABLE_KEY) || 'null');
  if (raw && typeof raw === 'object') statsTable = { tab: typeof raw.tab === 'string' ? raw.tab : 'projects', sort: raw.sort && typeof raw.sort === 'object' ? raw.sort : {} };
} catch { /* no storage or a bad value: the defaults stay */ }
function saveStatsTable() {
  try { localStorage.setItem(STATS_TABLE_KEY, JSON.stringify(statsTable)); } catch { /* not remembered */ }
}

const STATS_TABS = [
  { id: 'projects', label: 'Projects' },
  { id: 'models', label: 'Models' },
  { id: 'backends', label: 'Backends' },
  { id: 'sessions', label: 'Sessions' },
];

const statsNumCol = (key, label, get, format) => ({ key, label, num: true, get, text: (r) => { const v = get(r); return v == null ? '—' : format(v); } });
const statsTokenCol = (key, label) => statsNumCol(key, label, (r) => r[key], fmtTokens);
const statsCostCol = { key: 'cost', label: 'Cost', num: true, get: (r) => (r.cost ? r.cost.usd : null), cost: true, text: (r) => statsCostText(r.cost) };

/** The columns, the filter field a row sets and the rows of one tab. Names no backend: labels and ids come from the payload. */
function statsTabSpec(id, payload) {
  if (id === 'projects') {
    return {
      field: 'project', rows: payload.projects || [], value: (r) => (r.other ? null : r.projectPath),
      columns: [
        { key: 'name', label: 'Project', get: (r) => r.name, text: (r) => r.name, title: (r) => r.name },
        statsNumCol('sessions', 'Sessions', (r) => r.sessions, fmtCount), statsNumCol('messages', 'Messages', (r) => r.messages, fmtCount),
        statsTokenCol('tokens', 'Tokens'), statsCostCol,
      ],
    };
  }
  if (id === 'models') {
    return {
      field: 'model', rows: payload.models || [], value: (r) => r.model,
      columns: [
        { key: 'model', label: 'Model', get: (r) => r.model, text: (r) => r.model || '—' },
        statsNumCol('sessions', 'Sessions', (r) => r.sessions, fmtCount), statsTokenCol('input', 'Input'), statsTokenCol('output', 'Output'),
        statsTokenCol('cacheRead', 'Cache read'), statsTokenCol('cacheWrite', 'Cache written'), statsTokenCol('tokens', 'Tokens'), statsCostCol,
      ],
    };
  }
  if (id === 'backends') {
    return {
      field: 'backend', rows: payload.backends || [], value: (r) => r.id,
      columns: [
        { key: 'label', label: 'Backend', get: (r) => r.label, text: (r) => r.label, icon: true },
        statsNumCol('sessions', 'Sessions', (r) => r.sessions, fmtCount), statsNumCol('messages', 'Messages', (r) => r.messages, fmtCount),
        statsTokenCol('input', 'Input'), statsTokenCol('output', 'Output'), statsTokenCol('tokens', 'Tokens'),
        statsNumCol('cacheRate', 'Cache hit', (r) => r.cacheRate, (v) => Math.round(v * 100) + '%'), statsCostCol,
      ],
    };
  }
  return {
    field: null, rows: payload.sessions || [], value: null,
    columns: [
      { key: 'title', label: 'Title', get: (r) => r.title, text: (r) => r.title || '(untitled)', title: (r) => r.title || r.sessionId },
      { key: 'project', label: 'Project', get: (r) => r.projectName, text: (r) => r.projectName },
      { key: 'backend', label: 'Backend', get: (r) => r.backend && r.backend.label, text: (r) => (r.backend && r.backend.label) || '—' },
      // `started` is a local day key decided in main (like `lastDate`): the renderer only shows it.
      // A date or a model id never breaks at its hyphen: eleven columns leave little room, and "2026-10-" over "29" reads as
      // two values. The title and project columns wrap instead.
      { key: 'started', label: 'Started', nowrap: true, get: (r) => r.started, text: (r) => r.started || '—' },
      { key: 'lastDate', label: 'Last active', nowrap: true, get: (r) => r.lastDate, text: (r) => r.lastDate || '—' },
      { key: 'lastModel', label: 'Last model', nowrap: true, get: (r) => r.lastModel, text: (r) => r.lastModel || '—' },
      statsNumCol('messages', 'Messages', (r) => r.messages, fmtCount), statsTokenCol('tokens', 'Tokens'), statsCostCol,
      // The #809 roll-up: the session plus every session it started. Shown here only, never added to a total.
      statsNumCol('inclTokens', 'Tokens incl. started', (r) => r.inclTokens, fmtTokens),
      { key: 'inclCost', label: 'Cost incl. started', num: true, get: (r) => (r.inclCost ? r.inclCost.usd : null), cost: true, costField: 'inclCost', text: (r) => statsCostText(r.inclCost) },
    ],
  };
}

/** The sort in force for a tab: the remembered one if its column exists, else tokens descending (Sessions: the measure main ranked by). */
function statsSortFor(id, columns, view) {
  const saved = statsTable.sort[id];
  // Until a remembered Sessions measure has been re-asked of main, the header names the measure that really ranked the rows.
  const staleMeasure = id === 'sessions' && saved && ['tokens', 'cost', 'messages'].includes(saved.key) && view && view.sessionsBy && saved.key !== view.sessionsBy;
  if (saved && !staleMeasure && columns.some(c => c.key === saved.key)) return { key: saved.key, dir: saved.dir === 'asc' ? 'asc' : 'desc' };
  const by = id === 'sessions' && view && view.sessionsBy;
  return { key: by || 'tokens', dir: 'desc' };
}

/** A click on a header: the Sessions measures (tokens, cost, messages) ask main for a different top 50, any other sort is local. */
function statsSortBy(tabId, column, current, view) {
  const dir = current.key === column.key ? (current.dir === 'desc' ? 'asc' : 'desc') : (column.num ? 'desc' : 'asc');
  const measure = tabId === 'sessions' && ['tokens', 'cost', 'messages'].includes(column.key) && column.key !== (view && view.sessionsBy);
  statsTable.sort[tabId] = { key: column.key, dir: measure ? 'desc' : dir };
  saveStatsTable();
  if (measure) {
    const base = statsBase();
    return requestStats(base.filter, { ...(base.view || {}), sessionsBy: column.key });
  }
  renderStatsBreakdownBody();
}

/** The session row's open: the sidebar's own path (`openSession`), with the row the app already holds when it has one. */
async function openStatsSession(row) {
  if (typeof openSession !== 'function') return;
  const known = typeof sessionMap !== 'undefined' && sessionMap.get ? sessionMap.get(row.sessionId) : null;
  // Single and grid view: Stats is an admin tab, so leave it first, as the Tasks and Bookmarks lists do (`hideAllViewers`,
  // bookmarks-view.js and tasks-view.js) and as its own close button does (`closeAdminView`); otherwise the session opens
  // behind the viewer and the sidebar stays on the Stats tab. Panes mode (#310) leaves both alone: Stats is a pane tab with
  // `close: 'admin'`, so either call would close that tab and collapse a pane that held only Stats; `openSession` adopts the
  // session into a pane. `openPath` is the session's own path (a worktree session resumes there).
  const inPanes = !!(window.panesView && window.panesView.active());
  if (!inPanes) {
    if (typeof closeAdminView === 'function') closeAdminView();
    if (typeof hideAllViewers === 'function') hideAllViewers();
  }
  try { await openSession(known || { sessionId: row.sessionId, projectPath: row.openPath }); }
  catch (err) { if (typeof toast === 'function') toast('Could not open session: ' + err.message); }
}

/**
 * A remembered Sessions sort on a measure (tokens, cost, messages) must name the top 50 main ranked: `view.sessionsBy` lives in
 * memory only, so after a restart the header could say "Cost" over a top 50 chosen by tokens. Ask main once for the saved one.
 */
let statsAlignedMeasure = null;
function statsAlignSessionsMeasure() {
  if (statsTable.tab !== 'sessions') return;
  const saved = statsTable.sort.sessions;
  const key = saved && saved.key;
  if (!['tokens', 'cost', 'messages'].includes(key)) return;
  const base = statsBase();
  const current = (base.view && base.view.sessionsBy) || 'tokens';
  if (key === current || statsAlignedMeasure === key) return;
  statsAlignedMeasure = key;
  requestStats(base.filter, { ...(base.view || {}), sessionsBy: key });
}

/** A row sets its filter field; a second click on the active one clears it. Both go through the page's own `applyFilter`. */
function statsDrillInto(field, value) {
  const { filter } = statsBase();
  const active = filter && filter[field] === value;
  return applyFilter({ [field]: active ? null : value });
}

// --- the left sidebar's project list (V7) ------------------------------------------------------------------------------------

/** True when the sidebar host is on screen. "No work nobody can see": every other tab hides it, and then nothing is built. */
function statsSidebarShown(host) {
  return !!host && host.style.display !== 'none';
}

/** The `points` attribute of a sparkline polyline: values spread over `width` x `height`, the largest on the top edge. */
function statsSparkPoints(values, width, height) {
  const list = (values || []).map(v => (Number.isFinite(v) && v > 0 ? v : 0));
  if (!list.length) return '';
  const max = Math.max(...list);
  const step = list.length > 1 ? width / (list.length - 1) : 0;
  const pad = 1;
  return list.map((v, i) => {
    const x = list.length > 1 ? i * step : width / 2;
    const y = max > 0 ? pad + (height - 2 * pad) * (1 - v / max) : height - pad;
    return `${+x.toFixed(1)},${+y.toFixed(1)}`;
  }).join(' ');
}

function buildStatsSpark(values) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'stats-spark');
  svg.setAttribute('width', '60');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 60 16');
  svg.setAttribute('aria-hidden', 'true');
  const points = statsSparkPoints(values, 60, 16);
  if (points && !points.includes(' ')) {
    // One point: a polyline of one point draws nothing, so it is a dot.
    // The point sits on the top or bottom edge (it is the maximum or zero), so the centre is kept inside by the radius.
    const [cx, cy] = points.split(',');
    const r = 1.5;
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', String(Math.min(16 - r, Math.max(r, Number(cy)))));
    dot.setAttribute('r', String(r));
    dot.setAttribute('fill', 'currentColor');
    svg.appendChild(dot);
    return svg;
  }
  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('points', points);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '1.5');
  line.setAttribute('stroke-linejoin', 'round');
  line.setAttribute('stroke-linecap', 'round');
  svg.appendChild(line);
  return svg;
}

/**
 * The project list in the left sidebar, from `payload.sidebar` (the page's own answer, not narrowed by the project filter).
 * Replaced as a whole on each answer, not morphed: it holds at most 50 small rows, lives in `#stats-content` which the
 * session list's morphdom and `preserveSidebarState` never touch, and a refresh follows a filter change anyway. The focused
 * row is found again by its path so the keyboard stays where it was.
 */
function renderStatsSidebar() {
  const host = document.getElementById('stats-content');
  if (!statsSidebarShown(host) || !statsState.payload) return;
  const focusedPath = document.activeElement && host.contains(document.activeElement) ? document.activeElement.dataset.path : null;
  const rows = statsState.payload.sidebar || [];
  const active = (statsState.filter || {}).project ?? null;
  const list = document.createElement('div');
  list.className = 'stats-side-list';
  if (!rows.length) {
    const none = document.createElement('div');
    none.className = 'plans-empty';
    none.textContent = 'No project activity in this selection.';
    list.appendChild(none);
  }
  for (const r of rows) {
    const clickable = r.selectable === true;
    const el = document.createElement(clickable ? 'button' : 'div');
    el.className = 'stats-side-row' + (clickable && active === r.projectPath ? ' is-active' : '') + (clickable ? '' : ' is-static');
    if (clickable) {
      el.type = 'button';
      el.dataset.path = r.projectPath;
      el.setAttribute('aria-pressed', active === r.projectPath ? 'true' : 'false');
      el.onclick = () => statsDrillInto('project', r.projectPath);
    }
    el.title = `${r.name}: ${fmtTokens(r.total)} tokens` + (clickable ? (active === r.projectPath ? ' (click to clear this filter)' : ' (click to filter the page to this project)') : '');
    const name = document.createElement('span');
    name.className = 'stats-side-name';
    name.textContent = r.name;
    const total = document.createElement('span');
    total.className = 'stats-side-total';
    total.textContent = fmtTokens(r.total);
    el.append(name, buildStatsSpark(r.points), total);
    list.appendChild(el);
  }
  host.replaceChildren(list);
  if (focusedPath) {
    const again = [...host.querySelectorAll('.stats-side-row[data-path]')].find(b => b.dataset.path === focusedPath);
    if (again) again.focus();
  }
}

function buildStatsBreakdown(payload) {
  const section = document.createElement('div');
  section.className = 'stats-breakdown';
  const head = document.createElement('div');
  head.className = 'stats-chart-head';
  const tabs = viewPills('Breakdown', STATS_TABS, STATS_TABS.some(t => t.id === statsTable.tab) ? statsTable.tab : 'projects', (id) => {
    statsTable.tab = id;
    saveStatsTable();
    renderStatsBreakdown();
    statsAlignSessionsMeasure();
  });
  // Not the chart's switches: those are looked up by their class.
  tabs.classList.replace('stats-chart-switch', 'stats-breakdown-tabs');
  head.appendChild(tabs);
  closeExportMenu(false);
  head.appendChild(buildExportControl());
  const body = document.createElement('div');
  body.className = 'stats-breakdown-body';
  section.append(head, body);
  return section;
}

// --- export (V10) ----------------------------------------------------------------------------------------------------------
// `[Export v]` beside the breakdown tabs: the CSV of the table the tab shows, or the JSON of everything. Main re-runs the query
// from the filter and view this page shows (it takes no rows from here), asks for the file and answers `{ ok, canceled, error,
// name }`. The menu's document listeners exist only while it is open.

// The open menu: its element, the button that opened it and the function that takes the listeners off.
let statsExportMenu = null;
let statsExporting = false;

function closeExportMenu(refocus) {
  if (!statsExportMenu) return;
  const { el, button, off } = statsExportMenu;
  statsExportMenu = null;
  off();
  el.remove();
  button.setAttribute('aria-expanded', 'false');
  if (refocus) button.focus();
}

function sayStatsExport(message) {
  if (typeof showControlToast === 'function') showControlToast({ message, timeoutMs: 4000 });
}

async function runStatsExport(format, tabId) {
  const a = window.api;
  if (statsExporting || !a || typeof a.exportStats !== 'function') return;
  statsExporting = true;
  const button = statsViewerBody && statsViewerBody.querySelector('.stats-export-btn');
  if (button) button.disabled = true;
  let res = null;
  try { res = await a.exportStats(format, tabId, statsState.filter, statsState.view); } catch { res = null; }
  statsExporting = false;
  const again = statsViewerBody && statsViewerBody.querySelector('.stats-export-btn');
  if (again) again.disabled = false;
  if (!res) sayStatsExport('The export failed.');
  else if (res.ok) sayStatsExport('Exported' + (res.name ? ' to ' + res.name : '') + '.');
  else if (!res.canceled) sayStatsExport(res.error || 'The export failed.');
}

function openExportMenu(wrap, button) {
  closeExportMenu(false);
  const tabId = STATS_TABS.some(t => t.id === statsTable.tab) ? statsTable.tab : 'projects';
  const tab = STATS_TABS.find(t => t.id === tabId);
  const el = document.createElement('div');
  el.className = 'new-session-popover stats-export-pop';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', 'Export');
  const items = [
    { label: `CSV: ${tab.label} table`, format: 'csv' },
    { label: 'JSON: everything', format: 'json' },
  ];
  for (const it of items) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'popover-option';
    item.setAttribute('role', 'menuitem');
    item.textContent = it.label;
    item.onclick = () => { closeExportMenu(true); runStatsExport(it.format, tabId); };
    el.appendChild(item);
  }
  wrap.appendChild(el);
  button.setAttribute('aria-expanded', 'true');
  const options = [...el.querySelectorAll('button')];
  const onKey = (e) => {
    if (!el.isConnected || el.offsetParent === null) { closeExportMenu(false); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeExportMenu(true); return; }
    // The arrows belong to the menu only while focus is inside it: after a Tab out, they are the page's again.
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && el.contains(document.activeElement)) {
      e.preventDefault();
      const i = options.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % options.length : (i <= 0 ? options.length - 1 : i - 1);
      options[next].focus();
    }
  };
  const onDown = (e) => { if (!el.contains(e.target) && !button.contains(e.target)) closeExportMenu(false); };
  // Focus that moves outside the menu and its button (Tab) closes it, without taking the focus back.
  const onFocusOut = (e) => { if (e.relatedTarget && !el.contains(e.relatedTarget) && !button.contains(e.relatedTarget)) closeExportMenu(false); };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  el.addEventListener('focusout', onFocusOut);
  statsExportMenu = {
    el, button,
    off: () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('mousedown', onDown, true); el.removeEventListener('focusout', onFocusOut); },
  };
  options[0].focus();
}

function buildExportControl() {
  const wrap = document.createElement('div');
  wrap.className = 'stats-export';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'settings-action-btn stats-export-btn';
  button.textContent = 'Export ▾';
  button.title = 'Save the table as CSV, or the whole page as JSON';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.disabled = statsExporting;
  button.onclick = () => (statsExportMenu ? closeExportMenu(true) : openExportMenu(wrap, button));
  wrap.appendChild(button);
  return wrap;
}

/** Redraw the tab strip and the table in place (a tab change asks main for nothing). */
function renderStatsBreakdown() {
  const old = statsViewerBody.querySelector('.stats-breakdown');
  if (!old || !statsState.payload) return;
  const fresh = buildStatsBreakdown(statsState.payload);
  old.replaceWith(fresh);
  renderStatsBreakdownBody();
}

function renderStatsBreakdownBody() {
  const body = statsViewerBody.querySelector('.stats-breakdown-body');
  const payload = statsState.payload;
  if (!body || !payload) return;
  const tabId = STATS_TABS.some(t => t.id === statsTable.tab) ? statsTable.tab : 'projects';
  const spec = statsTabSpec(tabId, payload);
  const view = statsState.view || {};
  const sort = statsSortFor(tabId, spec.columns, view);
  const column = spec.columns.find(c => c.key === sort.key) || spec.columns[0];
  const rows = statsSortRows(spec.rows, column.get, sort.dir);
  // The highlight follows what main echoed, not what was last sent.
  const activeValue = spec.field ? ((statsState.filter || {})[spec.field] ?? null) : null;

  body.replaceChildren();
  if (!rows.length) {
    const none = document.createElement('div');
    none.className = 'plans-empty';
    none.textContent = 'Nothing to list for this selection.';
    body.appendChild(none);
    return;
  }
  if (tabId === 'sessions') {
    const note = document.createElement('div');
    note.className = 'chart-subtitle stats-caption';
    note.textContent = `The ${rows.length} sessions with the most ${view.sessionsBy || 'tokens'} in this selection. A subagent counts under its parent.`;
    body.appendChild(note);
  }

  const wrap = document.createElement('div');
  wrap.className = 'pa-table-wrap stats-table-wrap';
  const table = document.createElement('table');
  table.className = 'pa-table stats-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const c of spec.columns) {
    const th = document.createElement('th');
    th.className = 'stats-th' + (c.num ? ' is-num' : '');
    th.textContent = c.label + (c.key === sort.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');
    th.tabIndex = 0;
    th.dataset.sort = c.key;
    th.setAttribute('aria-sort', c.key === sort.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    th.onclick = () => statsSortBy(tabId, c, sort, view);
    th.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); statsSortBy(tabId, c, sort, view); } };
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    const value = spec.value ? spec.value(r) : null;
    // Main says which rows can set a filter (`selectable`); the page does not guess.
    const clickable = spec.field ? r.selectable === true : r.openable === true;
    if (clickable) {
      tr.className = 'stats-row' + (spec.field && activeValue === value ? ' is-active' : '');
      tr.tabIndex = 0;
      const go = () => (spec.field ? statsDrillInto(spec.field, value) : openStatsSession(r));
      tr.onclick = go;
      tr.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
      tr.title = spec.field ? (activeValue === value ? 'Click to clear this filter' : 'Click to filter the page to this row') : 'Open this session';
    } else if (!spec.field) {
      tr.title = 'This session has no project folder to open it in';
    }
    for (const c of spec.columns) {
      const td = document.createElement('td');
      td.className = c.num ? 'is-num' : (c.nowrap ? 'is-nowrap' : '');
      if (c.icon && r.icon && typeof renderBackendIcon === 'function') td.appendChild(renderBackendIcon(r.icon, 14, {}));
      const text = document.createElement('span');
      text.textContent = c.text(r);
      const costValue = c.cost ? r[c.costField || 'cost'] : null;
      if (costValue) text.className = 'backend-cost' + (costValue.estimated ? ' is-estimated' : '');
      if (c.title) text.title = c.title(r) || '';
      td.appendChild(text);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  wrap.appendChild(table);
  body.appendChild(wrap);
}

// --- requesting ---------------------------------------------------------------------------------------------------------

async function loadStats() {
  closeLimitsPop(false);
  closeExportMenu(false);
  statsRhythmFold = null;
  const body = statsViewerBody;
  unmountStatsCharts();
  body.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'stats-page';
  const barHost = document.createElement('div');
  barHost.className = 'stats-bar-host';
  const results = document.createElement('div');
  results.className = 'stats-results';
  page.append(barHost, results);
  body.appendChild(page);

  // Rate limits are their own read and never hold the page up (they can be a network fetch): not awaited, and the strip
  // is drawn into the bar whenever both are there, in either order.
  loadUsage();

  const spinner = document.createElement('div');
  spinner.className = 'stats-spinner';
  spinner.innerHTML = '<div class="stats-spinner-icon"></div><span>Reading stats…</span>';
  results.appendChild(spinner);

  // null = the remembered filter; main sanitises it and says what it ran.
  await requestStats(null);
}

/** Ask main for the page under `filter` (null = the remembered one). A late answer to an older ask is dropped. */
async function requestStats(filter, view) {
  const gen = ++statsGen;
  statsHeatmapRefocus = null; // a request the heatmap did not start (it re-arms it after its own call)
  const sentView = view || statsBase().view;
  statsPending = { filter, view: sentView };
  const before = statsViewerBody.querySelector('.stats-results');
  if (before) before.classList.add('is-loading');
  let res = null;
  try {
    res = await window.api.getStats(filter, sentView);
  } catch { res = null; }
  if (gen !== statsGen) return;
  const host = statsViewerBody.querySelector('.stats-results');
  if (!host) return;
  host.classList.remove('is-loading');
  if (!res || !res.ok) {
    statsHeatmapRefocus = null;
    statsPending = { filter: statsState.filter, view: statsState.view };
    // A failed re-ask of the Sessions measure may be tried again by the next successful draw.
    statsAlignedMeasure = null;
    renderStatsError(res && res.error);
    renderStatsSidebarError();
    return;
  }
  if (statsRhythmFold !== null && res.filter) {
    if (statsRhythmFold) res.filter.rhythmCollapsed = true; else delete res.filter.rhythmCollapsed;
    // The store may have taken the old fold from that request after the click's own write: say it again.
    try { Promise.resolve(window.api.setStatsRhythm(statsRhythmFold)).catch(() => {}); } catch { /* shown as asked either way */ }
    statsRhythmFold = null;
  }
  statsState = { filter: res.filter, view: res.view, payload: res.payload, facets: null };
  statsPending = { filter: res.filter, view: res.view };
  renderStatsPage();
  renderStatsSidebar();
  loadFacets(gen);
}

/** The choices behind the dropdowns. Read after the page is drawn, never before; a stale answer is dropped. */
async function loadFacets(gen) {
  let res = null;
  try { res = await window.api.getStatsFacets(statsState.filter); } catch { res = null; }
  if (gen !== statsGen || !res || !res.ok) return;
  statsState.facets = res;
  fillBarSelects();
}

function applyFilter(patch) {
  const { filter } = statsBase();
  if (!filter) return requestStats(null);
  return requestStats(statsFilterWith(filter, patch));
}

function resetFilter() {
  // An empty object is not null: main sanitises it to the defaults (O3), so the renderer names none of them. The Rhythm fold
  // is how the block is shown, not a filter: it stays. After a failed first load no filter was ever echoed, so the fold is
  // unknown here and a reset from that state drops a stored fold (accepted: a rare path, and the block only opens).
  const { filter } = statsBase();
  return requestStats(statsRhythmCollapsed(filter) ? { rhythmCollapsed: true } : {});
}

// --- drawing ------------------------------------------------------------------------------------------------------------

function renderStatsError(message) {
  const results = statsViewerBody.querySelector('.stats-results');
  if (!results) return;
  drawFilterBar();
  unmountStatsCharts();
  results.replaceChildren();
  const box = document.createElement('div');
  box.className = 'plans-empty';
  box.textContent = message || 'The statistics could not be read.';
  const retry = document.createElement('button');
  retry.className = 'settings-action-btn stats-retry-btn';
  retry.textContent = 'Try again';
  retry.onclick = () => requestStats(statsState.filter);
  results.append(box, retry);
  // No answer has ever been echoed, so no filter bar was drawn and "Reset filter" is nowhere else: offer it here. It sends
  // an explicit default filter (resetFilter), never null, which would ask for the remembered one again.
  if (!statsState.filter) {
    const reset = document.createElement('button');
    reset.className = 'settings-action-btn stats-retry-btn';
    reset.textContent = 'Reset filter';
    reset.onclick = () => resetFilter();
    results.append(reset);
  }
}

/**
 * A failed answer says so in the sidebar too, inside `#stats-content` so that the next good `renderStatsSidebar` replaces it.
 * A list on screen stays as it is, under a line saying it may be old; with no list yet the placeholder gives way to the message.
 */
function renderStatsSidebarError() {
  const host = document.getElementById('stats-content');
  if (!statsSidebarShown(host)) return;
  const notice = document.createElement('div');
  notice.className = 'stats-side-notice';
  notice.setAttribute('role', 'status');
  const list = host.querySelector('.stats-side-list');
  if (list) {
    const old = host.querySelector('.stats-side-notice');
    if (old) old.remove();
    notice.textContent = 'Could not refresh. Showing the last list.';
    host.insertBefore(notice, list);
  } else {
    notice.textContent = 'The projects could not be read.';
    host.replaceChildren(notice);
  }
}

function renderStatsPage() {
  const results = statsViewerBody.querySelector('.stats-results');
  if (!results) return;
  const { payload } = statsState;
  const refocusDate = statsHeatmapTakeRefocus();
  drawFilterBar();
  unmountStatsCharts();
  results.replaceChildren();

  if (statsIsEmpty(payload)) {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = 'No sessions match this filter in this period. Widen the range or reset the filter.';
    results.appendChild(empty);
    // The heatmap is the navigator back: an empty day or range keeps it (and the fold), the hour grid simply draws nothing.
    if (payload && payload.heatmap) {
      results.appendChild(buildRhythm(payload));
      statsHeatmapRestoreFocus(refocusDate);
    }
    return;
  }

  const caption = document.createElement('div');
  caption.className = 'chart-subtitle stats-caption';
  const days = payload.range.days;
  caption.textContent = `${statsRangeText(payload.range)} · ${days} day${days === 1 ? '' : 's'}. ${statsCompareText(payload.range)}.`;
  results.appendChild(caption);

  results.appendChild(buildKeyFigures(payload));

  // Mounted once the section is in the document: the chart measures its host, which is 0 wide while it is detached.
  const chart = buildChartSection(payload);
  results.appendChild(chart.section);
  chart.mount();

  results.appendChild(buildStatsBreakdown(payload));
  renderStatsBreakdownBody();
  statsAlignSessionsMeasure();

  results.appendChild(buildRhythm(payload));
  statsHeatmapRestoreFocus(refocusDate);
}

/** End every chart's resize observer before its host is rebuilt. (A hidden host needs no call: its callback returns at width 0.) */
function unmountStatsCharts() {
  if (typeof statsViewerBody === 'undefined' || !statsViewerBody) return;
  for (const host of statsViewerBody.querySelectorAll('.stats-chart-host')) unmountStatsChart(host);
}

function drawFilterBar() {
  const host = statsViewerBody.querySelector('.stats-bar-host');
  if (!host) return;
  closeLimitsPop(false);
  host.replaceChildren();
  const filter = statsState.filter;
  if (!filter) return;

  const bar = document.createElement('div');
  bar.className = 'stats-filter-bar stats-filter-sticky';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Filter the statistics');

  const range = document.createElement('div');
  range.className = 'backend-filter-bar stats-range';
  range.setAttribute('role', 'group');
  range.setAttribute('aria-label', 'Time range');
  const kind = filter.range && filter.range.kind;
  for (const r of STATS_RANGES) {
    const pill = document.createElement('button');
    pill.className = 'backend-filter-pill' + (r.kind === kind ? ' active' : '');
    pill.dataset.range = r.kind;
    pill.setAttribute('aria-pressed', r.kind === kind ? 'true' : 'false');
    pill.textContent = r.label;
    pill.onclick = () => { if (r.kind !== kind) applyFilter({ range: r.kind }); };
    range.appendChild(pill);
  }
  // A single day or a custom span is not one of the five: show it as the active choice instead of leaving none lit.
  if (kind === 'day' || kind === 'custom') {
    // Not a button: this is what the range IS, there is nothing to press (a preset pill changes it).
    const pill = document.createElement('span');
    pill.className = 'backend-filter-pill active stats-range-current';
    pill.setAttribute('aria-current', 'true');
    pill.textContent = statsRangeText(statsState.payload && statsState.payload.range) || kind;
    range.appendChild(pill);
  }
  bar.appendChild(range);

  for (const [field, allLabel, aria] of [['backend', 'All backends', 'Backend'], ['project', 'All projects', 'Project'], ['model', 'All models', 'Model']]) {
    const select = document.createElement('select');
    select.className = 'settings-select stats-select';
    select.dataset.field = field;
    select.dataset.allLabel = allLabel;
    select.setAttribute('aria-label', aria);
    select.onchange = () => applyFilter({ [field]: select.value });
    bar.appendChild(select);
  }

  const reset = document.createElement('button');
  reset.className = 'settings-action-btn stats-reset-btn';
  reset.textContent = 'Reset';
  reset.title = 'Back to the default filter';
  reset.onclick = () => resetFilter();
  bar.appendChild(reset);

  // The rate limits (V8): at the right of the bar, hidden until a reading with a window has arrived.
  const limits = document.createElement('div');
  limits.className = 'stats-limits';
  limits.hidden = true;
  limits.title = STATS_LIMITS_TITLE;
  limits.setAttribute('role', 'group');
  limits.setAttribute('aria-label', 'Subscription limits');
  bar.appendChild(limits);

  host.appendChild(bar);
  fillBarSelects();
  if (cachedUsage) drawUsageStrip();
}

/** Fill the three selects from the facets when they are in, else with the one value the filter holds. */
function fillBarSelects() {
  const bar = statsViewerBody.querySelector('.stats-filter-bar');
  if (!bar || !statsState.filter) return;
  const { filter, facets, payload } = statsState;
  const choices = {
    backend: facets ? facets.backends.map(b => ({ value: b.id, label: b.label })) : [],
    project: facets ? facets.projects.map(p => ({ value: p.path, label: p.name })) : [],
    model: facets ? facets.models.map(m => ({ value: m, label: m })) : [],
  };
  for (const select of bar.querySelectorAll('select.stats-select')) {
    const field = select.dataset.field;
    const current = filter[field] || '';
    const items = choices[field].slice();
    // The active value stays selectable before (or without) the facets that would list it.
    if (current && !items.some(i => i.value === current)) items.unshift({ value: current, label: statsKnownLabel(field, current, payload) });
    select.replaceChildren();
    const all = document.createElement('option');
    all.value = '';
    all.textContent = select.dataset.allLabel;
    select.appendChild(all);
    for (const item of items) {
      const o = document.createElement('option');
      o.value = item.value;
      o.textContent = item.label;
      select.appendChild(o);
    }
    select.value = current;
  }
}

function statTile(label, value, { sub, change, title, valueClass } = {}) {
  const card = document.createElement('div');
  card.className = 'stat-card stats-tile';
  if (title) card.title = title;
  const l = document.createElement('div');
  l.className = 'stat-card-label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = 'stat-card-value' + (valueClass ? ' ' + valueClass : '');
  v.textContent = value;
  card.append(l, v);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'stats-tile-sub';
    s.textContent = sub;
    card.appendChild(s);
  }
  if (change !== undefined) {
    const c = document.createElement('div');
    c.className = 'stats-tile-change' + (change === '—' ? ' is-none' : '');
    c.textContent = change;
    card.appendChild(c);
  }
  return card;
}

function buildKeyFigures(payload) {
  const kf = payload.keyFigures;
  const cur = kf.cur;
  const ch = kf.change || {};
  const grid = document.createElement('div');
  grid.className = 'stats-figures';

  grid.appendChild(statTile('Sessions', fmtCount(cur.sessions), { change: statsChangeText(ch.sessions) }));
  grid.appendChild(statTile('Messages', fmtCount(cur.messages), {
    sub: `${fmtCount(cur.toolCalls)} tool calls`, change: statsChangeText(ch.messages),
  }));
  grid.appendChild(statTile('Tokens', fmtTokens(cur.tokens), {
    sub: `in ${fmtTokens(cur.input)} · out ${fmtTokens(cur.output)} · cache ${fmtTokens(cur.cacheRead)} read / ${fmtTokens(cur.cacheWrite)} written`,
    change: statsChangeText(ch.tokens),
    title: 'Input plus output as the backends store them. The split shows input without the cached part.',
  }));

  // An estimate is never shown as a bill: "~" and the amber class whenever any part of the sum is estimated; "—" when no
  // backend in the selection reports a cost at all (not "$0.00").
  const cost = cur.cost;
  grid.appendChild(statTile('Cost', cost ? (cost.estimated ? '~' : '') + formatUsd(cost.usd) : '—', {
    sub: cost ? `${fmtCount(cur.costSessions)} of ${fmtCount(cur.sessions)} sessions report a cost` : 'No backend here reports a cost',
    change: statsChangeText(ch.cost),
    title: cost && cost.estimated ? 'Estimated by the backend, the amount actually billed may differ' : (cost ? 'Reported by the backend as the settled amount' : 'Token-only: no cost is reported for this selection'),
    valueClass: cost ? 'backend-cost' + (cost.estimated ? ' is-estimated' : '') : 'backend-cost-none',
  }));

  const excluded = kf.cacheExcluded || [];
  grid.appendChild(statTile('Cache hit rate', cur.cacheRate == null ? '—' : Math.round(cur.cacheRate * 100) + '%', {
    change: statsChangeText(ch.cacheRate, 'points'),
    title: excluded.length ? `Not reported for: ${excluded.join(', ')}` : (cur.cacheRate == null ? 'No cache figures in this selection' : 'Share of input served from the cache'),
    sub: excluded.length ? `Not counted: ${excluded.join(', ')}` : undefined,
  }));

  grid.appendChild(statTile('Active days', fmtCount(cur.activeDays), {
    sub: `of ${fmtCount(payload.range.days)} day${payload.range.days === 1 ? '' : 's'}`, change: statsChangeText(ch.activeDays),
  }));
  return grid;
}

// --- the main chart ------------------------------------------------------------------------------------------------------

const STATS_MEASURES = [
  { id: 'tokens', label: 'Tokens', unit: 'tokens' },
  { id: 'cost', label: 'Cost', unit: 'USD' },
  { id: 'messages', label: 'Messages', unit: 'messages' },
  { id: 'sessions', label: 'Sessions', unit: 'sessions' },
];
const STATS_SPLITS = [
  { id: 'none', label: 'None' },
  { id: 'backend', label: 'Backend' },
  { id: 'model', label: 'Model' },
  { id: 'project', label: 'Project' },
];

/** The number formatter of a measure: the same three the tiles use. */
function statsMeasureFormat(measure) {
  if (measure === 'cost') return formatUsd;
  if (measure === 'tokens') return fmtTokens;
  return fmtCount;
}

/** A group of pills (the filter bar's own classes) that picks one value of the view. */
function viewPills(label, options, current, onPick) {
  const group = document.createElement('div');
  group.className = 'backend-filter-bar stats-chart-switch';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label);
  for (const o of options) {
    const pill = document.createElement('button');
    pill.className = 'backend-filter-pill' + (o.id === current ? ' active' : '');
    pill.dataset.value = o.id;
    pill.setAttribute('aria-pressed', o.id === current ? 'true' : 'false');
    pill.textContent = o.label;
    pill.onclick = () => { if (o.id !== current) onPick(o.id); };
    group.appendChild(pill);
  }
  return group;
}

/**
 * The main chart: the measure and split switches above, the stacked bars below (stats-chart.js draws them). Returns
 * { section, mount }: the caller attaches the section, THEN calls mount, so the first draw measures the real width.
 */
function buildChartSection(payload) {
  const series = payload.series || {};
  const view = statsState.view || {};
  const measure = view.measure || series.measure || 'tokens';
  const split = view.split || series.split || 'backend';
  const section = document.createElement('div');
  section.className = 'stats-chart-section';

  const head = document.createElement('div');
  head.className = 'stats-chart-head';
  const title = document.createElement('div');
  title.className = 'daily-chart-title stats-chart-title';
  title.textContent = 'Over time';
  head.appendChild(title);
  const setView = (patch) => { const base = statsBase(); return requestStats(base.filter, { ...(base.view || {}), ...patch }); };
  head.appendChild(viewPills('Measure', STATS_MEASURES, measure, (id) => setView({ measure: id })));
  head.appendChild(viewPills('Split by', STATS_SPLITS, split, (id) => setView({ split: id })));
  section.appendChild(head);

  const host = document.createElement('div');
  host.className = 'stats-chart-host';
  host.dataset.statsChartHost = '1';
  section.appendChild(host);

  if (statsSeriesEmpty(series)) {
    const none = document.createElement('div');
    none.className = 'plans-empty stats-chart-none';
    none.textContent = measure === 'cost' ? 'No backend in this selection reports a cost.' : 'Nothing to chart for this measure.';
    host.appendChild(none);
    return { section, mount() {} };
  }

  const def = STATS_MEASURES.find(m => m.id === measure) || STATS_MEASURES[0];
  const estimated = measure === 'cost' && series.estimated;
  const format = statsMeasureFormat(measure);
  const range = payload.range;
  const bucketWord = series.bucket === 'month' ? 'month' : series.bucket === 'week' ? 'week' : 'day';
  const chartOpts = {
    format,
    // The payload names a backend's colour TOKEN; the backend icons own the token-to-colour table.
    // Null for a token the badges do not know, so the chart takes its palette instead of the badges' neutral default.
    colourOf: (token) => (typeof window.backendIconKnownColour === 'function' ? window.backendIconKnownColour(token) : null),
    // An estimate is never drawn as a bill: "~" in front of every figure the tooltip names, as on the Cost tile.
    formatValue: estimated ? (v) => '~' + format(v) : format,
    unit: estimated ? `${def.unit} (estimated)` : def.unit,
    title: `${def.label} per ${bucketWord}` + (split === 'none' ? '' : `, split by ${((STATS_SPLITS.find(s => s.id === split) || {}).label || split).toLowerCase()}`),
    rangeText: (b) => statsRangeText({ from: b.start, to: b.end }),
    onBarClick: (b) => {
      const span = statsBucketSpan(b, range);
      if (!span || (span.from === range.from && span.to === range.to)) return;
      applyFilter({ rangeSpec: span });
    },
  };
  return { section, mount() { mountStatsChart(host, series, chartOpts); } };
}

/**
 * The Rhythm block (V6): the year heatmap (O1 = A: the 365 days ending at the range end, not narrowed by the range; a day
 * click sets the range to that day) and the weekday-by-hour grid (follows the range). One fold, remembered with the filter.
 * Folded, neither grid is built: no work nobody can see; opening it builds from the payload already held.
 */
function buildRhythm(payload) {
  const section = document.createElement('div');
  section.className = 'stats-rhythm';
  const collapsed = statsRhythmCollapsed(statsState.filter);
  const title = document.createElement('div');
  title.className = 'daily-chart-title';
  const toggle = document.createElement('button');
  toggle.className = 'settings-action-btn stats-rhythm-toggle';
  toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  toggle.textContent = (collapsed ? '▸ ' : '▾ ') + 'Rhythm';
  toggle.title = collapsed ? 'Show when you work' : 'Hide the activity grids';
  toggle.onclick = toggleRhythm;
  title.appendChild(toggle);
  section.appendChild(title);
  if (!collapsed) section.appendChild(buildRhythmBlocks(payload));
  return section;
}

function buildRhythmBlocks(payload) {
  const blocks = document.createElement('div');
  blocks.className = 'stats-blocks';
  const counts = {};
  for (const d of (payload.heatmap && payload.heatmap.days) || []) counts[d.date] = d.messages || 0;
  if (Object.keys(counts).length) {
    const wide = document.createElement('div');
    wide.className = 'stats-block stats-block-wide';
    wide.appendChild(buildHeatmap(counts, payload.heatmap && payload.heatmap.to, payload.heatmap && payload.heatmap.from));
    blocks.appendChild(wide);
  } else {
    // No message in the whole year for this backend, project and model: say so, rather than an open block with nothing in it.
    const none = document.createElement('div');
    none.className = 'plans-empty';
    none.textContent = 'No activity in the 365 days up to the end of the range.';
    blocks.appendChild(none);
  }
  const hours = buildHourGrid(payload.grid || []);
  if (hours) {
    const cell = document.createElement('div');
    cell.className = 'stats-block';
    cell.appendChild(hours);
    blocks.appendChild(cell);
  }
  return blocks;
}

/** Fold or open the block in place from the held payload (no new query) and remember it with the filter. */
function toggleRhythm() {
  const filter = statsState.filter;
  const payload = statsState.payload;
  if (!filter || !payload) return;
  const collapsed = !statsRhythmCollapsed(filter);
  // A request already in flight was cloned over IPC with the OLD fold, and main will echo it back. What the page holds is the
  // authority: the fold is applied onto that echo when it lands (`requestStats`), then forgotten.
  statsRhythmFold = collapsed;
  for (const f of new Set([filter, statsPending.filter])) {
    if (!f) continue;
    if (collapsed) f.rhythmCollapsed = true; else delete f.rhythmCollapsed;
  }
  try { Promise.resolve(window.api.setStatsRhythm(collapsed)).catch(() => {}); } catch { /* the block is shown as asked either way */ }
  const old = statsViewerBody.querySelector('.stats-rhythm');
  if (!old) return;
  const next = buildRhythm(payload);
  old.replaceWith(next);
  const btn = next.querySelector('.stats-rhythm-toggle');
  if (btn) btn.focus();
}

// --- rate limits (get-usage, never filtered) -----------------------------------------------------------------------------
// A strip at the right of the filter bar (V8): one chip per backend that reports a limit, showing its tightest window; a chip
// opens that backend's full per-window detail in a popover. The read is its own async path: nothing in the stats render waits
// for it, and a slow or failed read leaves the stats as they are.

const STATS_LIMITS_TITLE = 'Subscription limits, not affected by the filter';

/**
 * The window that is closest to its limit among the cards of one backend (the first of equals), or null when it has none.
 */
function statsTightestLimit(cards) {
  let best = null;
  for (const c of cards || []) {
    if (c && Number.isFinite(c.percent) && (!best || c.percent > best.percent)) best = c;
  }
  return best;
}

/**
 * What a backend says instead of windows: the usage API was throttled or the limit was reached (`_rateLimited`), the read
 * failed (`_error`), or no limit is exposed (`_noData`). null for a plain reading.
 */
function statsUsageNotice(usage) {
  if (!usage) return null;
  if (usage._rateLimited) {
    const mins = Math.ceil((usage.retryAfterSeconds || 0) / 60);
    return usage.message
      || (mins > 0
        ? `Usage API rate limited. Try again in ~${mins} min${mins !== 1 ? 's' : ''}.`
        : 'Usage API rate limited. Try again later.');
  }
  if (usage._error) return usage.message || 'Could not fetch usage data.';
  if (usage._noData) return usage._limitsUnavailable && usage.message ? usage.message : 'No usage limit reported yet.';
  return null;
}

/**
 * The chips of the strip: `[{ usage, tight }]`. One per backend with at least one window (`tight` is its fullest). A backend
 * that is rate limited or failed gets a chip with `tight: null`, so its message stays reachable; one that reports no limit
 * (`_noData`) or has no window has none (not a zero). `cardsOf(usage)` is `getUsageLimitCards`.
 */
function statsLimitChips(list, cardsOf) {
  const chips = [];
  for (const usage of Array.isArray(list) ? list : []) {
    if (!usage) continue;
    if (usage._rateLimited || usage._error) { chips.push({ usage, tight: null }); continue; }
    if (usage._noData) continue;
    const tight = statsTightestLimit(cardsOf(usage));
    if (tight) chips.push({ usage, tight });
  }
  return chips;
}

async function loadUsage() {
  const gen = ++usageGen;
  if (cachedUsage) drawUsageStrip();
  try {
    const fresh = await window.api.getUsage();
    if (gen !== usageGen) return;
    if (fresh && Array.isArray(fresh.backends)) {
      cachedUsage = fresh;
      drawUsageStrip();
    }
  } catch { /* the cached reading, if any, stays */ }
}

// The open popover: its element, the chip that opened it and the one function that closes it (so a redraw of the bar, which
// removes both, can still take the document listeners off).
let statsLimitsPop = null;

function closeLimitsPop(refocus) {
  if (!statsLimitsPop) return;
  const { el, chip, off } = statsLimitsPop;
  statsLimitsPop = null;
  off();
  el.remove();
  if (chip) {
    chip.setAttribute('aria-expanded', 'false');
    if (refocus) chip.focus();
  }
}

function limitsCards(usage) {
  return typeof getUsageLimitCards === 'function' ? getUsageLimitCards(usage) : [];
}

/** (Re)draw the strip into the bar. Called when the answer arrives and every time the bar is drawn; a no-op without a bar. */
function drawUsageStrip() {
  const strip = statsViewerBody && statsViewerBody.querySelector('.stats-limits');
  if (!strip) return;
  const reopen = statsLimitsPop && statsLimitsPop.backendId;
  closeLimitsPop(false);
  strip.replaceChildren();
  const chips = statsLimitChips(cachedUsage && cachedUsage.backends, limitsCards);
  strip.hidden = chips.length === 0;
  for (const { usage, tight } of chips) {
    const chip = document.createElement('button');
    const level = tight ? tight.level : 'critical';
    chip.className = 'backend-filter-pill stats-limit-chip' + (level && level !== 'normal' ? ` is-${level}` : '');
    chip.dataset.backend = usage.backendId || '';
    chip.setAttribute('aria-haspopup', 'dialog');
    chip.setAttribute('aria-expanded', 'false');
    const name = usage.label || usage.backendId;
    chip.title = tight ? `${name}: ${tight.label} ${tight.percent}%. ${STATS_LIMITS_TITLE}` : `${name}: ${usage.message || statsUsageNotice(usage)}`;
    if (typeof renderBackendIcon === 'function') {
      chip.appendChild(renderBackendIcon(usage.icon || usage.backendId, 12, { monogram: usage.monogram }));
    }
    const text = document.createElement('span');
    text.className = 'stats-limit-chip-text';
    text.textContent = tight ? `${tight.label} ${tight.percent}%` : name;
    chip.appendChild(text);
    chip.onclick = () => (statsLimitsPop && statsLimitsPop.chip === chip ? closeLimitsPop(true) : openLimitsPop(strip, chip, usage));
    strip.appendChild(chip);
    if (reopen && reopen === usage.backendId) openLimitsPop(strip, chip, usage);
  }
}

function openLimitsPop(strip, chip, usage) {
  closeLimitsPop(false);
  const el = document.createElement('div');
  el.className = 'new-session-popover stats-limits-pop';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', `${usage.label || usage.backendId}: usage limits`);
  el.tabIndex = -1;
  el.appendChild(buildUsageDetail(usage));
  strip.appendChild(el);
  chip.setAttribute('aria-expanded', 'true');

  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    // The popover's host went away or is hidden without a close (the view was hidden, moved or rebuilt): clean up, do not
    // swallow the key. A hidden Stats view keeps the popover connected, so `offsetParent` is what tells it is not on screen.
    if (!el.isConnected || el.offsetParent === null) { closeLimitsPop(false); return; }
    e.preventDefault(); e.stopPropagation(); closeLimitsPop(true);
  };
  const onDown = (e) => {
    if (!el.contains(e.target) && !chip.contains(e.target)) closeLimitsPop(false);
  };
  // Listening only while open: closed, nothing here can shadow a key of the page.
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  statsLimitsPop = {
    el, chip, backendId: usage.backendId,
    off: () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('mousedown', onDown, true); },
  };
  el.focus();
}

/** The popover's body: the backend's windows (what the page body used to draw) and the refresh that re-reads them. */
function buildUsageDetail(usage) {
  const container = document.createElement('div');
  container.className = 'usage-container';

  const titleRow = document.createElement('div');
  titleRow.className = 'usage-title-row';
  const title = document.createElement('div');
  title.className = 'daily-chart-title';
  title.textContent = 'Rate Limits';
  titleRow.appendChild(title);

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'usage-refresh-btn';
  refreshBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>';
  refreshBtn.title = 'Refresh usage';
  refreshBtn.setAttribute('aria-label', 'Refresh usage');
  refreshBtn.onclick = async () => {
    refreshBtn.classList.add('usage-refresh-spinning');
    refreshBtn.disabled = true;
    // A refresh is the newest ask: an older `loadUsage` answer arriving later must not overwrite it.
    const gen = ++usageGen;
    try {
      const fresh = await window.api.getUsage();
      if (gen !== usageGen) return;
      if (fresh && Array.isArray(fresh.backends)) {
        cachedUsage = fresh;
        drawUsageStrip();
        return;
      }
    } catch { /* the existing render stays */ }
    refreshBtn.classList.remove('usage-refresh-spinning');
    refreshBtn.disabled = false;
  };
  titleRow.appendChild(refreshBtn);
  container.append(titleRow, buildUsageGroup(usage));
  return container;
}

// One backend's windows (#191). Each group is labelled, because two identical grids of percentages with no owner would be
// worse than one.
function buildUsageGroup(usage) {
  const group = document.createElement('div');
  group.className = 'usage-backend-group';

  const head = document.createElement('div');
  head.className = 'usage-backend-head';
  if (typeof renderBackendIcon === 'function') {
    head.appendChild(renderBackendIcon(usage.icon || usage.backendId, 14, { monogram: usage.monogram }));
  }
  const name = document.createElement('span');
  name.className = 'usage-backend-name';
  name.textContent = usage.label || usage.backendId;
  head.appendChild(name);

  // A non-live backend states when its figure was true. Codex's comes out of its last rollout, so
  // "42%" with no date is a number pretending to be current.
  //
  // A LIVE backend served from the cache is the same number pretending the same thing, and this surface
  // said nothing about it (#604): the tooltip in the status bar dates a cached reading, and a figure
  // read here had no marker at all. `_cachedAt` is when the cache took it; asked only when nothing has
  // dated the reading already, so one number never carries two ages.
  const asOf = (!usage.live && usage.observedAt) ? usage.observedAt : (usage._stale ? usage._cachedAt : null);
  if (asOf && typeof observedAgo === 'function') {
    const ago = observedAgo(asOf);
    if (ago) {
      const when = document.createElement('span');
      when.className = 'usage-backend-asof';
      when.textContent = `measured ${ago}`;
      head.appendChild(when);
    }
  }
  group.appendChild(head);

  // A backend that says why it has no windows says it here (rate limited, failed, nothing exposed), as the status bar does.
  const notice = statsUsageNotice(usage);
  if (notice) {
    const box = document.createElement('div');
    box.className = 'usage-rate-limited';
    box.textContent = notice;
    group.appendChild(box);
    return group;
  }

  // A reading AND a reason: the windows below are current, and the backend has also said it ran into a
  // limit. Both are true, so both are shown rather than one replacing the other (#494).
  if (usage.limitReachedMessage) {
    const reached = document.createElement('div');
    reached.className = 'usage-rate-limited';
    reached.textContent = usage.limitReachedMessage;
    group.appendChild(reached);
  }

  const grid = document.createElement('div');
  grid.className = 'usage-grid';
  for (const card of limitsCards(usage)) {
    const usageCard = document.createElement('div');
    usageCard.className = 'usage-card';

    const header = document.createElement('div');
    header.className = 'usage-card-header';
    const label = document.createElement('span');
    label.className = 'usage-card-label';
    label.textContent = card.label;
    header.appendChild(label);
    const pctEl = document.createElement('span');
    pctEl.className = 'usage-card-pct';
    pctEl.textContent = card.percent + '%';
    header.appendChild(pctEl);
    usageCard.appendChild(header);

    const track = document.createElement('div');
    track.className = 'usage-track';
    const fill = document.createElement('div');
    fill.className = 'usage-fill' + (card.level && card.level !== 'normal' ? ` usage-fill-${card.level}` : '');
    fill.style.width = Math.max(card.percent, 1) + '%';
    track.appendChild(fill);
    usageCard.appendChild(track);

    if (card.detail) {
      const detail = document.createElement('div');
      detail.className = 'usage-card-reset';
      detail.textContent = card.detail;
      usageCard.appendChild(detail);
    }

    if (card.reset) {
      const reset = document.createElement('div');
      reset.className = 'usage-card-reset';
      reset.textContent = 'Resets ' + card.reset;
      usageCard.appendChild(reset);
    }

    grid.appendChild(usageCard);
  }
  group.appendChild(grid);
  return group;
}

// --- Rhythm: the year heatmap (below) and the weekday-by-hour grid ---------------------------------------------------------

function chartSection(titleText, subtitleText) {
  const container = document.createElement('div');
  container.className = 'daily-chart-container';
  const title = document.createElement('div');
  title.className = 'daily-chart-title';
  title.textContent = titleText;
  container.appendChild(title);
  if (subtitleText) {
    const sub = document.createElement('div');
    sub.className = 'chart-subtitle';
    sub.textContent = subtitleText;
    container.appendChild(sub);
  }
  return container;
}

/**
 * When you actually work: a 7 x 24 grid of messages — weekday down, hour of day across.
 *
 * Buckets whose backend could not say WHEN within the day (hour = -1) are not in this data at all; the query
 * excludes them. Dropping them at midnight instead would invent a working habit nobody has. A backend that cannot
 * attribute tokens to a single message books its totals on the hour it was last active, and the subtitle says so.
 */
function buildHourGrid(rows) {
  if (!rows.length) return null;

  const counts = new Map();          // "weekday|hour" -> messages
  let max = 0;
  for (const r of rows) {
    const key = `${r.weekday}|${r.hour}`;
    const n = (counts.get(key) || 0) + Number(r.messages || 0);
    counts.set(key, n);
    if (n > max) max = n;
  }
  if (!max) return null;

  const container = chartSection('When you work', 'Messages by weekday and hour. A backend that cannot place its tokens within a day books them on the hour it was last active.');

  const grid = document.createElement('div');
  grid.className = 'hour-grid';

  // A blank corner, then the hour ruler. Only every third hour is labelled: 24 labels do not fit, and a
  // cramped unreadable axis is worse than a sparse one.
  const corner = document.createElement('div');
  corner.className = 'hour-grid-corner';
  grid.appendChild(corner);
  for (let h = 0; h < 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-grid-hour-label';
    label.textContent = h % 3 === 0 ? String(h) : '';
    grid.appendChild(label);
  }

  // Weeks start Monday (spec 48 O8). The payload's weekday is main's `strftime('%w')` (0 = Sunday), so row r is weekday (r + 1) % 7.
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  for (let r = 0; r < 7; r++) {
    const d = (r + 1) % 7;
    const label = document.createElement('div');
    label.className = 'hour-grid-day-label';
    label.textContent = DAY_NAMES[r];
    grid.appendChild(label);

    for (let h = 0; h < 24; h++) {
      const n = counts.get(`${d}|${h}`) || 0;
      const cell = document.createElement('div');
      // The same five-step scale as the contribution heatmap, so the two grids read as one language.
      const level = n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4));
      cell.className = `hour-grid-cell heatmap-level-${level}`;
      cell.title = `${DAY_NAMES[r]} ${String(h).padStart(2, '0')}:00 — ${n} message${n === 1 ? '' : 's'}`;
      grid.appendChild(cell);
    }
  }
  container.appendChild(grid);
  return container;
}

function buildHeatmap(counts, endKey, fromKey) {
  const container = document.createElement('div');
  container.className = 'heatmap-container';

  // 52 weeks of dates ending at the range end (a local day key from main), else today
  const last = new Date();
  if (typeof endKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(endKey)) last.setFullYear(+endKey.slice(0, 4), +endKey.slice(5, 7) - 1, +endKey.slice(8, 10));
  last.setHours(0, 0, 0, 0);
  const dayOfWeek = (last.getDay() + 6) % 7; // 0=Mon: weeks start Monday (spec 48 O8)
  const endDate = new Date(last);
  const startDate = new Date(last);
  startDate.setDate(startDate.getDate() - (52 * 7 + dayOfWeek));

  // Month labels
  const monthLabels = document.createElement('div');
  monthLabels.className = 'heatmap-month-labels';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let lastMonth = -1;
  const weekStarts = [];
  const d = new Date(startDate);
  while (d <= endDate) {
    if (d.getDay() === 1) {
      weekStarts.push(new Date(d));
    }
    d.setDate(d.getDate() + 1);
  }

  // Calculate month label positions
  const colWidth = 16; // 13px cell + 3px gap
  for (let w = 0; w < weekStarts.length; w++) {
    const m = weekStarts[w].getMonth();
    if (m !== lastMonth) {
      const label = document.createElement('span');
      label.className = 'heatmap-month-label';
      label.textContent = months[m];
      label.style.position = 'absolute';
      label.style.left = (w * colWidth) + 'px';
      monthLabels.appendChild(label);
      lastMonth = m;
    }
  }
  monthLabels.style.position = 'relative';
  monthLabels.style.height = '16px';
  container.appendChild(monthLabels);

  // Grid wrapper (day labels + grid)
  const wrapper = document.createElement('div');
  wrapper.className = 'heatmap-grid-wrapper';

  // Day labels
  const dayLabels = document.createElement('div');
  dayLabels.className = 'heatmap-day-labels';
  const dayNames = ['Mon', '', 'Wed', '', 'Fri', '', ''];
  for (const name of dayNames) {
    const label = document.createElement('div');
    label.className = 'heatmap-day-label';
    label.textContent = name;
    dayLabels.appendChild(label);
  }
  wrapper.appendChild(dayLabels);

  // Quartile thresholds
  const nonZero = Object.values(counts).filter(c => c > 0).sort((a, b) => a - b);
  const q1 = nonZero[Math.floor(nonZero.length * 0.25)] || 1;
  const q2 = nonZero[Math.floor(nonZero.length * 0.5)] || 2;
  const q3 = nonZero[Math.floor(nonZero.length * 0.75)] || 3;

  // Grid
  const grid = document.createElement('div');
  grid.className = 'heatmap-grid';

  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', 'Messages per day. Arrow keys move between days, Enter or Space shows the day.');
  const dayCells = []; // the cells inside the window, oldest first: the roving tabindex moves along this list
  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    const dateStr = localDateKey(cursor);
    const count = counts[dateStr] || 0;
    let level = 0;
    if (count > 0) {
      if (count <= q1) level = 1;
      else if (count <= q2) level = 2;
      else if (count <= q3) level = 3;
      else level = 4;
    }

    const cell = document.createElement('div');
    // The week alignment starts a few days before main's 365-day window: those cells are outside it, neither "no activity" nor clickable.
    if (typeof fromKey === 'string' && dateStr < fromKey) {
      cell.className = 'heatmap-cell heatmap-level-0 is-outside';
      grid.appendChild(cell);
      cursor.setDate(cursor.getDate() + 1);
      continue;
    }
    cell.className = `heatmap-cell heatmap-level-${level}`;
    cell.dataset.date = dateStr;
    const displayDate = cursor.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    cell.title = count > 0 ? `${displayDate}: ${count} messages` : `${displayDate}: No activity`;
    cell.setAttribute('role', 'button');
    cell.setAttribute('aria-label', cell.title);
    cell.tabIndex = -1;
    dayCells.push(cell);
    grid.appendChild(cell);

    cursor.setDate(cursor.getDate() + 1);
  }
  // One tab stop: the range end, which is the day a single-day range shows too.
  if (dayCells.length) dayCells[dayCells.length - 1].tabIndex = 0;

  // A day click sets the range to that day (O1 = A), the way a chart bar sets its bucket; one listener for every cell.
  grid.addEventListener('click', (e) => {
    const cell = e.target && e.target.closest ? e.target.closest('.heatmap-cell') : null;
    if (cell) statsHeatmapApplyDay(cell.dataset.date);
  });
  // The same day by keyboard. Keys sit on the grid, never on `document`; the handler takes Enter and Space itself.
  grid.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const cell = e.target && e.target.closest ? e.target.closest('.heatmap-cell') : null;
    if (!cell || !cell.dataset.date) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      statsHeatmapApplyDay(cell.dataset.date);
      return;
    }
    const to = statsHeatmapKeyTarget(e.key, dayCells.indexOf(cell), dayCells.length);
    if (to === null) return;
    e.preventDefault();
    for (const c of dayCells) c.tabIndex = c === dayCells[to] ? 0 : -1;
    dayCells[to].focus();
  });

  wrapper.appendChild(grid);
  container.appendChild(wrapper);

  // Legend
  const legend = document.createElement('div');
  legend.className = 'heatmap-legend';
  const lessLabel = document.createElement('span');
  lessLabel.className = 'heatmap-legend-label';
  lessLabel.textContent = 'Less';
  legend.appendChild(lessLabel);
  for (let i = 0; i <= 4; i++) {
    const cell = document.createElement('div');
    cell.className = `heatmap-legend-cell heatmap-level-${i}`;
    legend.appendChild(cell);
  }
  const moreLabel = document.createElement('span');
  moreLabel.className = 'heatmap-legend-label';
  moreLabel.textContent = 'More';
  legend.appendChild(moreLabel);
  container.appendChild(legend);

  return container;
}
