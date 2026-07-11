// --- Stats view ---
// Depends on globals: escapeHtml (utils.js), statsViewerBody + cachedAllProjects (app.js),
//   backend-registry.js (refreshBackendCaches / launchableBackends / getBackend / sessionBackendId),
//   backend-icons.js (renderBackendIcon)

let cachedUsage = null;
let loadStatsGen = 0;

// T-3.9 — the backend filter of the Stats view. 'all' or a backendId. Stats ONLY: Plans and
// Memory are Claude-only artifacts (~/.claude/plans, CLAUDE.md), so a pill per backend would
// render empty there and read as a bug.
let statsBackendFilter = 'all';

// Local YYYY-MM-DD. NOT toISOString().slice(0,10): that formats a local-midnight
// Date as UTC, so in TZ+n the day axis lands one calendar day off from where the
// bulk of that day's activity is bucketed (issue #75).
function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function loadStats() {
  const myGen = ++loadStatsGen;
  statsViewerBody.innerHTML = '';

  // The breakdown below resolves each session's backend from the registry caches.
  if (typeof window.refreshBackendCaches === 'function') {
    try { await window.refreshBackendCaches(); } catch {}
  }

  // Show spinner while fetching usage via PTY
  const spinner = document.createElement('div');
  spinner.className = 'stats-spinner';
  spinner.innerHTML = `<div class="stats-spinner-icon"></div><span>Updating stats\u2026</span>`;
  statsViewerBody.appendChild(spinner);

  // Fetch stats from DB (instant) and usage from API (PTY) in parallel via
  // refresh-stats, which now skips the slow /stats PTY call entirely.
  let stats, usage;
  try {
    const result = await window.api.refreshStats();
    stats = result?.stats;
    usage = result?.usage || {};
    cachedUsage = usage;
  } catch {
    // Fallback: read DB directly for heatmap, use last cached usage
    stats = await window.api.getStatsFromDb();
    usage = cachedUsage || {};
  }

  // A newer loadStats() started while we awaited — drop this stale result so the
  // slower, older response can't overwrite the fresher render.
  if (myGen !== loadStatsGen) return;
  statsViewerBody.innerHTML = '';

  if (!stats && !Object.keys(usage).length) {
    statsViewerBody.innerHTML = '<div class="plans-empty">No stats data found. Run some Claude sessions first.</div>';
    return;
  }

  if (stats) {
    // dailyActivity is an array of {date, messageCount, sessionCount}
    const rawDaily = stats.dailyActivity || [];
    const dailyMap = {};
    if (Array.isArray(rawDaily)) {
      for (const entry of rawDaily) {
        dailyMap[entry.date] = entry.messageCount || 0;
      }
    } else {
      for (const [date, data] of Object.entries(rawDaily)) {
        dailyMap[date] = typeof data === 'number' ? data : (data?.messageCount || data?.messages || data?.count || 0);
      }
    }
    buildHeatmap(dailyMap);
    buildDailyBarChart(stats);
    buildStatsSummary(stats, dailyMap);
  }

  // Per-backend breakdown + its filter bar (T-3.9).
  buildBackendBreakdown();

  // Build usage section below charts (from /usage output)
  if (Object.keys(usage).length) {
    buildUsageSection(usage);
  }

  if (stats) {
    const notice = document.createElement('div');
    notice.className = 'stats-notice';
    const lastDate = stats.lastComputedDate || 'unknown';
    notice.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="vertical-align:-2px;margin-right:6px;flex-shrink:0"><circle cx="8" cy="8" r="7"/><line x1="8" y1="5" x2="8" y2="9"/><circle cx="8" cy="11.5" r="0.5" fill="currentColor" stroke="none"/></svg>Data sourced from Switchboard session cache (last updated ${escapeHtml(lastDate)}).`;
    statsViewerBody.appendChild(notice);
  }
}

function buildUsageSection(usage) {
  // Remove existing usage container if present (for refresh)
  const existing = statsViewerBody.querySelector('.usage-container');
  if (existing) existing.remove();

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
  refreshBtn.onclick = async () => {
    refreshBtn.classList.add('usage-refresh-spinning');
    refreshBtn.disabled = true;
    try {
      const freshUsage = await window.api.getUsage();
      if (freshUsage && Object.keys(freshUsage).length) {
        cachedUsage = freshUsage;
        buildUsageSection(freshUsage);
      }
    } catch {}
    refreshBtn.classList.remove('usage-refresh-spinning');
    refreshBtn.disabled = false;
  };
  titleRow.appendChild(refreshBtn);
  container.appendChild(titleRow);

  // Show rate limit or error notice
  if (usage._rateLimited || usage._error) {
    const notice = document.createElement('div');
    notice.className = 'usage-rate-limited';
    if (usage._rateLimited) {
      const secs = usage.retryAfterSeconds || 0;
      const mins = Math.ceil(secs / 60);
      notice.textContent = secs > 0
        ? `Usage API rate limited. Try again in ~${mins} min${mins !== 1 ? 's' : ''}.`
        : 'Usage API rate limited. Try again later.';
    } else {
      notice.textContent = usage.message || 'Could not fetch usage data.';
    }
    container.appendChild(notice);
    const statsNotice = statsViewerBody.querySelector('.stats-notice');
    if (statsNotice) statsViewerBody.insertBefore(container, statsNotice);
    else statsViewerBody.appendChild(container);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'usage-grid';

  const cards = typeof getUsageLimitCards === 'function' ? getUsageLimitCards(usage) : [];

  for (const card of cards) {
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

  container.appendChild(grid);
  // Insert before the stats notice footer if it exists, otherwise append
  const statsNotice = statsViewerBody.querySelector('.stats-notice');
  if (statsNotice) statsViewerBody.insertBefore(container, statsNotice);
  else statsViewerBody.appendChild(container);
}

// --- Per-backend breakdown + filter bar (T-3.9) ---------------------------------------------
//
// Sourced from the cached session rows the sidebar already holds: each carries the AUTHORITATIVE
// `backendId` written by the scanner (§5.7), plus its message/token counters. The DB stats
// aggregates above (heatmap, daily bars, per-model tokens) have no backend dimension — they are
// whole-corpus figures — so the filter scopes THIS breakdown, which is the part that has one.

/** {backendId: {sessions, messages, inputTokens, outputTokens, cacheTokens}} over all cached rows. */
function collectBackendUsage() {
  const projects = (typeof cachedAllProjects !== 'undefined' && cachedAllProjects.length)
    ? cachedAllProjects
    : (typeof cachedProjects !== 'undefined' ? cachedProjects : []);

  const byBackend = new Map();
  for (const project of projects || []) {
    for (const session of project.sessions || []) {
      // A Tier-3 terminal tab is not a backend session at all: it has no transcript and no
      // provenance, so it must not be counted (or invented as "Claude") here.
      if (session.type === 'terminal') continue;
      const id = typeof sessionBackendId === 'function' ? sessionBackendId(session) : 'claude';
      let acc = byBackend.get(id);
      if (!acc) {
        acc = { sessions: 0, messages: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0 };
        byBackend.set(id, acc);
      }
      // Subagents ride with their parent — they'd inflate the session count (same rule as the
      // DB's getTotalCounts) but their messages and tokens are real work, so those do count.
      if (!session.parentSessionId) acc.sessions++;
      acc.messages += session.messageCount || 0;
      acc.inputTokens += session.inputTokens || 0;
      acc.outputTokens += session.outputTokens || 0;
      acc.cacheTokens += (session.cacheCreationTokens || 0) + (session.cacheReadTokens || 0);
    }
  }
  return byBackend;
}

function backendLabelOf(id) {
  const b = typeof getBackend === 'function' ? getBackend(id) : null;
  return (b && b.label) || id;
}

function buildBackendBreakdown() {
  const existing = statsViewerBody.querySelector('.backend-breakdown');
  if (existing) existing.remove();

  const usage = collectBackendUsage();
  if (!usage.size) return; // nothing indexed yet — an empty filter bar would just be noise

  // Pills: All + every `ready && enabled` backend (§5.8). A backend that was disabled AFTER it
  // produced sessions keeps its card under "All" (disable ≠ erase history) but gets no pill.
  const launchable = typeof launchableBackends === 'function' ? launchableBackends() : [];
  const pills = [{ id: 'all', label: 'All' }].concat(
    launchable
      .slice()
      .sort((a, b) => (a.id === 'claude' ? -1 : b.id === 'claude' ? 1 : String(a.label).localeCompare(String(b.label))))
      .map(b => ({ id: b.id, label: b.label, icon: b.icon || b.colour || b.id, monogram: b.monogram }))
  );
  if (!pills.some(p => p.id === statsBackendFilter)) statsBackendFilter = 'all';

  const container = document.createElement('div');
  container.className = 'backend-breakdown';

  const titleRow = document.createElement('div');
  titleRow.className = 'usage-title-row backend-breakdown-head';
  const title = document.createElement('div');
  title.className = 'daily-chart-title';
  title.textContent = 'By backend';
  titleRow.appendChild(title);

  const bar = document.createElement('div');
  bar.className = 'backend-filter-bar';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Filter stats by backend');
  for (const pill of pills) {
    const btn = document.createElement('button');
    btn.className = 'backend-filter-pill' + (pill.id === statsBackendFilter ? ' active' : '');
    btn.dataset.backend = pill.id;
    btn.setAttribute('aria-pressed', pill.id === statsBackendFilter ? 'true' : 'false');
    if (pill.icon && typeof renderBackendIcon === 'function') {
      const icon = renderBackendIcon(pill.icon, 14, { monogram: pill.monogram });
      icon.classList.add('backend-filter-icon');
      btn.appendChild(icon);
    }
    btn.append(pill.label);
    btn.onclick = () => {
      statsBackendFilter = pill.id;
      buildBackendBreakdown(); // re-render in place; the charts above are whole-corpus and stay put
    };
    bar.appendChild(btn);
  }
  titleRow.appendChild(bar);
  container.appendChild(titleRow);

  const fmtNum = (n) => {
    n = n || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toLocaleString();
  };

  const grid = document.createElement('div');
  grid.className = 'stats-summary backend-breakdown-grid';

  const entries = Array.from(usage.entries())
    .filter(([id]) => statsBackendFilter === 'all' || id === statsBackendFilter)
    .sort((a, b) => b[1].messages - a[1].messages);

  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'backend-breakdown-empty';
    empty.textContent = `No sessions on ${backendLabelOf(statsBackendFilter)} yet.`;
    container.appendChild(empty);
  } else if (statsBackendFilter === 'all') {
    // One card per backend: the comparison view.
    for (const [id, acc] of entries) {
      const card = document.createElement('div');
      card.className = 'stat-card backend-stat-card';
      const head = document.createElement('div');
      head.className = 'backend-stat-head';
      const b = typeof getBackend === 'function' ? getBackend(id) : null;
      if (typeof renderBackendIcon === 'function') {
        head.appendChild(renderBackendIcon((b && (b.icon || b.colour)) || id, 16, { monogram: b && b.monogram }));
      }
      const name = document.createElement('span');
      name.textContent = backendLabelOf(id);
      head.appendChild(name);
      card.appendChild(head);

      const value = document.createElement('span');
      value.className = 'stat-card-value';
      value.textContent = acc.sessions.toLocaleString();
      card.appendChild(value);

      const label = document.createElement('span');
      label.className = 'stat-card-label';
      label.textContent = `sessions · ${fmtNum(acc.messages)} msgs · ${fmtNum(acc.inputTokens + acc.outputTokens)} tokens`;
      card.appendChild(label);
      grid.appendChild(card);
    }
    container.appendChild(grid);
  } else {
    // One backend selected: its own numbers, broken out.
    const acc = entries[0][1];
    const cards = [
      { value: acc.sessions.toLocaleString(), label: 'Sessions' },
      { value: acc.messages.toLocaleString(), label: 'Messages' },
      { value: fmtNum(acc.inputTokens), label: 'Input Tokens' },
      { value: fmtNum(acc.outputTokens), label: 'Output Tokens' },
      { value: fmtNum(acc.cacheTokens), label: 'Cache Tokens' },
    ];
    for (const card of cards) {
      const el = document.createElement('div');
      el.className = 'stat-card';
      el.innerHTML = `<span class="stat-card-value">${escapeHtml(card.value)}</span><span class="stat-card-label">${escapeHtml(card.label)}</span>`;
      grid.appendChild(el);
    }
    container.appendChild(grid);
  }

  // Sits above the rate-limit panel and the footer notice, below the charts.
  const usageContainer = statsViewerBody.querySelector('.usage-container');
  const notice = statsViewerBody.querySelector('.stats-notice');
  const anchor = usageContainer || notice;
  if (anchor) statsViewerBody.insertBefore(container, anchor);
  else statsViewerBody.appendChild(container);
}

function buildDailyBarChart(stats) {
  const rawTokens = stats.dailyModelTokens || [];
  const rawActivity = stats.dailyActivity || [];

  // Build maps for last 30 days
  const tokenMap = {};
  if (Array.isArray(rawTokens)) {
    for (const entry of rawTokens) {
      let total = 0;
      for (const count of Object.values(entry.tokensByModel || {})) total += count;
      tokenMap[entry.date] = total;
    }
  }
  const activityMap = {};
  if (Array.isArray(rawActivity)) {
    for (const entry of rawActivity) activityMap[entry.date] = entry;
  }

  // Generate last 30 days
  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(localDateKey(d));
  }

  const tokenValues = days.map(d => tokenMap[d] || 0);
  const msgValues = days.map(d => activityMap[d]?.messageCount || 0);
  const toolValues = days.map(d => activityMap[d]?.toolCallCount || 0);
  const maxTokens = Math.max(...tokenValues, 1);
  const maxMsgs = Math.max(...msgValues, 1);

  const container = document.createElement('div');
  container.className = 'daily-chart-container';

  const title = document.createElement('div');
  title.className = 'daily-chart-title';
  title.textContent = 'Last 30 days';
  container.appendChild(title);

  const chart = document.createElement('div');
  chart.className = 'daily-chart';

  for (let i = 0; i < days.length; i++) {
    const col = document.createElement('div');
    col.className = 'daily-chart-col';

    const bar = document.createElement('div');
    bar.className = 'daily-chart-bar';
    const pct = (tokenValues[i] / maxTokens) * 100;
    bar.style.height = Math.max(pct, tokenValues[i] > 0 ? 3 : 0) + '%';

    const msgPct = (msgValues[i] / maxMsgs) * 100;
    const msgBar = document.createElement('div');
    msgBar.className = 'daily-chart-bar-msgs';
    msgBar.style.height = Math.max(msgPct, msgValues[i] > 0 ? 3 : 0) + '%';

    const d = new Date(days[i]);
    const dayLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    let tokStr;
    if (tokenValues[i] >= 1e6) tokStr = (tokenValues[i] / 1e6).toFixed(1) + 'M';
    else if (tokenValues[i] >= 1e3) tokStr = (tokenValues[i] / 1e3).toFixed(1) + 'K';
    else tokStr = tokenValues[i].toString();
    col.title = `${dayLabel}\n${tokStr} tokens\n${msgValues[i]} messages\n${toolValues[i]} tool calls`;

    const label = document.createElement('div');
    label.className = 'daily-chart-label';
    label.textContent = d.getDate().toString();

    col.appendChild(bar);
    col.appendChild(msgBar);
    col.appendChild(label);
    chart.appendChild(col);
  }

  container.appendChild(chart);

  // Legend
  const legend = document.createElement('div');
  legend.className = 'daily-chart-legend';
  legend.innerHTML = '<span class="daily-chart-legend-dot tokens"></span> Tokens <span class="daily-chart-legend-dot msgs"></span> Messages';
  container.appendChild(legend);

  statsViewerBody.appendChild(container);
}

function buildHeatmap(counts) {
  const container = document.createElement('div');
  container.className = 'heatmap-container';

  // Generate 52 weeks of dates ending today
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayOfWeek = today.getDay(); // 0=Sun
  const endDate = new Date(today);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - (52 * 7 + dayOfWeek));

  // Month labels
  const monthLabels = document.createElement('div');
  monthLabels.className = 'heatmap-month-labels';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let lastMonth = -1;
  const weekStarts = [];
  const d = new Date(startDate);
  while (d <= endDate) {
    if (d.getDay() === 0) {
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
  const dayNames = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
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
    cell.className = `heatmap-cell heatmap-level-${level}`;
    const displayDate = cursor.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    cell.title = count > 0 ? `${displayDate}: ${count} messages` : `${displayDate}: No activity`;
    grid.appendChild(cell);

    cursor.setDate(cursor.getDate() + 1);
  }

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

  statsViewerBody.appendChild(container);
}

function calculateStreak(counts) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let current = 0;
  let longest = 0;
  let streak = 0;

  const d = new Date(today);
  let started = false;
  for (let i = 0; i < 365; i++) {
    const dateStr = localDateKey(d);
    const count = counts[dateStr] || 0;
    if (count > 0) {
      streak++;
      started = true;
    } else {
      if (started) {
        if (!current) current = streak;
        if (streak > longest) longest = streak;
        streak = 0;
        if (current) started = false;
      }
    }
    d.setDate(d.getDate() - 1);
  }
  if (streak > longest) longest = streak;
  if (!current && streak > 0) current = streak;

  return { current, longest };
}

function buildStatsSummary(stats, dailyMap) {
  const summaryEl = document.createElement('div');
  summaryEl.className = 'stats-summary';

  const { current: currentStreak, longest: longestStreak } = calculateStreak(dailyMap);

  // Total messages from map
  let totalMessages = 0;
  for (const count of Object.values(dailyMap)) {
    totalMessages += count;
  }
  // Prefer stats.totalMessages if available and larger
  if (stats.totalMessages && stats.totalMessages > totalMessages) {
    totalMessages = stats.totalMessages;
  }

  const totalSessions = stats.totalSessions || Object.keys(dailyMap).length;

  // Compact number formatting (K/M/B) shared by the total-tokens, tool-calls,
  // and per-model token cards.
  const fmtNum = (n) => {
    n = n || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toLocaleString();
  };

  // Model usage — values are objects with token counts, show as cards
  const models = stats.modelUsage || {};

  const cards = [
    { value: totalSessions.toLocaleString(), label: 'Total Sessions' },
    { value: totalMessages.toLocaleString(), label: 'Total Messages' },
    { value: fmtNum(stats.totalTokens), label: 'Total Tokens' },
    { value: fmtNum(stats.totalToolCalls), label: 'Tool Calls' },
    { value: currentStreak + 'd', label: 'Current Streak' },
    { value: longestStreak + 'd', label: 'Longest Streak' },
  ];

  for (const [model, usage] of Object.entries(models)) {
    const shortName = model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
    const tokens = (usage?.inputTokens || 0) + (usage?.outputTokens || 0);
    cards.push({ value: fmtNum(tokens), label: shortName + ' tokens' });
  }

  for (const card of cards) {
    const el = document.createElement('div');
    el.className = 'stat-card';
    el.innerHTML = `<span class="stat-card-value">${escapeHtml(card.value)}</span><span class="stat-card-label">${escapeHtml(card.label)}</span>`;
    summaryEl.appendChild(el);
  }

  statsViewerBody.appendChild(summaryEl);
}
