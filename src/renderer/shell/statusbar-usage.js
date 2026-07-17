// --- The status bar's usage segments (#218, #191) ---
//
// The per-backend usage readout at the bottom right: one segment per backend the user chose to see, the
// colour thresholds it is painted with, the localStorage snapshot that lets it draw before the first poll
// answers, and the poll itself. Came out of app.js.
//
// The PURE half is shell/usage-status.js — formatUsageStatus and friends, UMD and tested. This is the DOM
// half, and it is not testable the same way: it writes elements and holds a timer. Same division as
// shell/update-restart.js (pure) and shell/session-restore.js (DOM).
//
// WHAT IS NOT HERE, though the code sat next to it in app.js: `activityTimer` and the `onStatusUpdate`
// listener (the transient "Scanning projects…" text), and `renderDefaultStatus` (the sessions/projects
// counter). Those paint `statusBarInfo`; this file paints `statusBarUsage`. They shared a heading called
// "Status bar" and nothing else — which is exactly why they were adjacent and why they are not one thing.
//
// A PLAIN CLASSIC SCRIPT, no IIFE, no UMD factory. It reads app.js's top-level `statusBarUsage` (a
// parse-time getElementById) and calls `formatUsageStatus` / `clampUsageThreshold` from other classic
// scripts — all resolved at CALL time through the shared global lexical scope, so this is a move rather
// than a rewrite and needs no ctx. Wrapping it in a factory would put `window._setUsageThresholds` and
// the module's own `usageThresholds` in different worlds.
//
// THE TWO `window._set*` FUNCTIONS ARE THE PUBLIC EDGE: app.js calls them at boot and on a settings
// re-apply, and panels/settings-panel.js calls them from the Save path so the bar recolours without a
// reload. They are window properties assigned at parse time, and this file parses before app.js, so both
// callers find them. They re-render from `cachedStatusBarUsage` rather than re-polling — a threshold
// change is a repaint, not a request.
//
// app.js still calls `scheduleUsageStatusRefresh()` at ITS parse time, at the very bottom. That is the
// one entry point; everything else here is driven by the timer it starts.

let usageStatusTimer = null;
const USAGE_CACHE_KEY = 'usageStatusLastValue';
let cachedStatusBarUsage = null;
// Usage colour thresholds (%): < warn = green, warn..crit = orange, >= crit = red.
//
// Keyed by TIER, not by a window name (#191). A tier says how fast the bucket refills — 'short' is the
// one you can hit this afternoon, 'long' is the slow burn (and the credit pool). The settings keys are
// still `usage5hWarn` / `usage7dWarn` because they are what is in everyone's settings blob and renaming
// them would silently reset the tuning; what they MEAN is the tier, which is why Codex's derived windows
// and, later, Antigravity's per-model quotas colour correctly without a line changing here.
// clampUsageThreshold lives in utils.js (shared with the settings panel, #79).
let usageThresholds = {
  short: { warn: 60, crit: 80 },
  long: { warn: 75, crit: 90 },
};
window._setUsageThresholds = (cfg = {}) => {
  usageThresholds = {
    short: clampUsageThreshold(cfg.fiveHWarn, cfg.fiveHCrit, 60, 80),
    long: clampUsageThreshold(cfg.sevenDWarn, cfg.sevenDCrit, 75, 90),
  };
  if (cachedStatusBarUsage) renderUsageStatus(cachedStatusBarUsage);
};

// Which backends the user wants in the bar. An ABSENT key means "not decided" and shows the segment;
// only an explicit false hides it. Switching a backend off must not erase the wish to see it.
let usageBackendSelection = {};
window._setUsageBackendSelection = (map) => {
  usageBackendSelection = (map && typeof map === 'object') ? map : {};
  if (cachedStatusBarUsage) renderUsageStatus(cachedStatusBarUsage);
};

// One segment per backend the user chose to see (#191):
//
//   … │ <icon> 5h ▓░ 12%  7d ▓░ 3% │ <icon> 5h ▓░ 42%  7d ▓░ 8% │ …
//
// A NON-LIVE backend (Codex reads its figure out of its last rollout) is dimmed once the reading is more
// than an hour old, and its tooltip says when it was measured. Two segments styled identically, one of
// them three days stale, is a bar that lies — and it is the failure this feature is most likely to ship.
function renderUsageStatus(payload) {
  if (!statusBarUsage || typeof formatUsageStatus !== 'function') return;
  statusBarUsage.innerHTML = '';
  statusBarUsage.className = '';
  statusBarUsage.title = '';

  const selected = (typeof selectedUsageBackends === 'function')
    ? selectedUsageBackends(payload || {}, usageBackendSelection)
    : ((payload && payload.backends) || []);
  if (selected.length === 0) return;

  const separator = () => {
    const sep = document.createElement('span');
    sep.className = 'status-bar-usage-sep';
    sep.setAttribute('aria-hidden', 'true');
    return sep;
  };

  // A leading rule too, not just the ones between segments: the usage strip has to read as its own group
  // next to the session/project counts, and without it the first backend's badge butts straight against
  // "26 projects" as though it belonged to that sentence.
  statusBarUsage.appendChild(separator());

  selected.forEach((usage, i) => {
    const segment = document.createElement('span');
    segment.className = 'status-bar-usage-backend';
    segment.title = (typeof getUsageTooltip === 'function') ? getUsageTooltip(usage) : '';
    if (usage._stale || (typeof isStaleReading === 'function' && isStaleReading(usage))) {
      segment.classList.add('usage-status-stale');
    }

    // The backend's badge, so two segments are never confused for one another. Reuses the sidebar's
    // renderer, so the icon and its colour are the same object the session rows wear.
    if (typeof window.renderBackendIcon === 'function') {
      const icon = window.renderBackendIcon(usage.icon || usage.backendId, 12, { monogram: usage.monogram });
      icon.classList.add('status-bar-usage-icon');
      segment.appendChild(icon);
    }

    const bars = (typeof getUsageBars === 'function') ? getUsageBars(usage, usageThresholds) : [];
    if (bars.length === 0) {
      // Error, rate limit, or a backend that has never reported one. Say which — a bare "unavailable"
      // next to a healthy segment tells you nothing about whose it is.
      const status = formatUsageStatus(usage);
      if (status.level && status.level !== 'empty') segment.classList.add(`usage-status-${status.level}`);
      if (status.title) segment.title = status.title;
      if (status.text) {
        const label = document.createElement('span');
        label.className = 'status-bar-usage-label';
        label.textContent = status.text;
        segment.appendChild(label);
      }
    } else {
      for (const bar of bars) {
        const group = document.createElement('span');
        group.className = `status-bar-usage-bar usage-level-${bar.level}`;

        const label = document.createElement('span');
        label.className = 'status-bar-usage-name';
        label.textContent = bar.label;
        group.appendChild(label);

        const track = document.createElement('span');
        track.className = 'status-bar-usage-track';
        const fill = document.createElement('span');
        fill.className = 'status-bar-usage-fill';
        fill.style.width = `${Math.max(2, Math.min(100, bar.percent))}%`;
        track.appendChild(fill);
        group.appendChild(track);

        const value = document.createElement('span');
        value.className = 'status-bar-usage-value';
        value.textContent = `${bar.percent}%`;
        group.appendChild(value);

        segment.appendChild(group);
      }
    }

    statusBarUsage.appendChild(segment);
    if (i < selected.length - 1) statusBarUsage.appendChild(separator());
  });
}

// The main process owns the cache and the staleness marking, per backend (usage-cache.js) — a poll that
// fails comes back as the last good reading flagged `_stale`, and the backoff rides on the payload's own
// retry-after. The renderer used to keep a SECOND cache and a second rate-limit gate beside it; with one
// entry per backend that would be two mechanisms disagreeing about which backend is stale. It renders
// what it is given and asks again when the payload says to.
async function refreshStatusBarUsage() {
  if (!statusBarUsage) return;

  let payload = null;
  try {
    payload = await window.api.getUsage();
  } catch (err) {
    payload = { backends: [], _error: true, message: err?.message || 'Could not fetch usage data.' };
  }
  if (!payload || !Array.isArray(payload.backends)) payload = { backends: [] };

  renderUsageStatus(payload);

  // Keep the last payload so the first paint after a restart isn't an empty bar while the first poll
  // is in flight. Only a payload that actually measured something is worth restoring.
  if (payload.backends.some(u => (u.buckets || []).length > 0 || u.quota)) {
    cachedStatusBarUsage = payload;
    try { localStorage.setItem(USAGE_CACHE_KEY, JSON.stringify(payload)); } catch { /* storage full */ }
  }

  if (usageStatusTimer) clearTimeout(usageStatusTimer);
  const delay = (typeof getUsagePollDelayMs === 'function') ? getUsagePollDelayMs(payload) : 60 * 1000;
  usageStatusTimer = setTimeout(refreshStatusBarUsage, delay);
}

function scheduleUsageStatusRefresh() {
  try {
    const cached = JSON.parse(localStorage.getItem(USAGE_CACHE_KEY) || 'null');
    if (cached && Array.isArray(cached.backends)) {
      cachedStatusBarUsage = cached;
      renderUsageStatus(cached);
    }
  } catch { /* unparseable snapshot — the poll below replaces it */ }
  refreshStatusBarUsage();
}
