(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Timeline kinds worth surfacing in a "while you were away" recap. Busy/idle
  // churn is intentionally excluded — it's noise when re-orienting.
  const MEANINGFUL_KINDS = new Set([
    'started',
    'needs-attention',
    'response-ready',
    'exited',
    'stopped',
    'forked',
  ]);
  // Kinds that mean the agent is blocked on / waiting for the human.
  const WAITING_KINDS = new Set(['needs-attention', 'response-ready']);

  function toMs(value) {
    if (value == null) return NaN;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : NaN;
  }

  function formatDuration(ms) {
    let safe = ms;
    if (!Number.isFinite(safe) || safe < 0) safe = 0;
    const seconds = Math.round(safe / 1000);
    if (seconds < 60) return 'less than a minute';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      const remMinutes = minutes % 60;
      return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
    }
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours ? `${days}d ${remHours}h` : `${days}d`;
  }

  function formatClock(at) {
    const time = toMs(at);
    if (!Number.isFinite(time)) return '';
    const date = new Date(time);
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  // buildAwaySummary — pure selector for the "While you were away" recap.
  // Inputs:
  //   events:       timeline events for the session (newest-first, as stored),
  //                 each shaped { kind, label, detail, at }.
  //   filesTouched: [{ path, at, kind }] collected since the last view.
  //   lastViewedAt: Date | ISO string | epoch ms | null (null = never viewed).
  //   now:          Date | ISO string | epoch ms (defaults to Date.now()).
  //   maxEvents:    cap on surfaced events (default 8).
  // Returns { hasChanges, sinceText, events, files, waitingOnYou, extraEventCount }.
  function buildAwaySummary({
    events = [],
    filesTouched = [],
    lastViewedAt = null,
    now = Date.now(),
    maxEvents = 8,
  } = {}) {
    const thresholdMs = toMs(lastViewedAt);
    const hasThreshold = Number.isFinite(thresholdMs);
    const nowMs = toMs(now);
    const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
    const cap = Math.max(0, Number.isFinite(maxEvents) ? maxEvents : 0);

    const isSince = (at) => {
      if (!hasThreshold) return true;
      const time = toMs(at);
      return Number.isFinite(time) && time > thresholdMs;
    };

    const meaningfulEvents = (Array.isArray(events) ? events : []).filter(
      (event) => event && MEANINGFUL_KINDS.has(event.kind) && isSince(event.at),
    );

    const waitingOnYou = meaningfulEvents.some((event) => WAITING_KINDS.has(event.kind));

    const cappedEvents = meaningfulEvents.slice(0, cap).map((event) => ({
      time: formatClock(event.at),
      label: event.label || event.kind,
      detail: event.detail || '',
      kind: event.kind,
      at: event.at,
    }));
    const extraEventCount = Math.max(0, meaningfulEvents.length - cappedEvents.length);

    const recentFiles = (Array.isArray(filesTouched) ? filesTouched : [])
      .filter((file) => file && file.path && isSince(file.at))
      .slice()
      .sort((a, b) => (toMs(b.at) || 0) - (toMs(a.at) || 0));

    const seenPaths = new Set();
    const files = [];
    for (const file of recentFiles) {
      if (seenPaths.has(file.path)) continue;
      seenPaths.add(file.path);
      files.push({ path: file.path, kind: file.kind || 'open' });
    }

    const hasChanges = cappedEvents.length > 0 || files.length > 0;
    const sinceText = hasThreshold ? `You were away ${formatDuration(safeNow - thresholdMs)}` : '';

    return {
      hasChanges,
      sinceText,
      events: cappedEvents,
      files,
      waitingOnYou,
      extraEventCount,
    };
  }

  return {
    buildAwaySummary,
    formatAwayDuration: formatDuration,
  };
});
