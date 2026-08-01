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

  // `isUserInput` and the table of terminal reports it matched were here (#384). They existed for ONE
  // caller: the banner dismissed itself on `onData`, which is everything bound for the PTY — the
  // terminal's own focus and cursor replies included — so it tore itself down in the beat it was
  // rendered. The recap is not dismissed by a keystroke any more (#402); it is closed deliberately, so
  // there is nothing left to tell a human's bytes from a terminal's. `docs/specs/03-what-changed.md` §1
  // keeps the lesson, which was about believing onData is the user — not about the regex.

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

  // buildAwayOverview — pure selector for the ONE recap of a whole absence (#402).
  //
  // Where buildAwaySummary answers "what did THIS session do", this answers "which sessions did
  // anything", from a single cross-session read of the record. It is not a loop over per-session reads
  // by accident: the overview's whole job is to say which sessions changed, so asking per session would
  // mean knowing the answer before asking.
  //
  // Inputs:
  //   events:    every recorded event since the absence began, across all sessions, newest-first —
  //              `{ sessionId, kind, label, detail, at }` as stored.
  //   truncated: the reader hit its row limit and there was more. Passed through, never inferred here.
  //   awaySince: when the absence started. NOT optional: without it "since" has no meaning and the
  //              answer would be the whole record, which is the one wrong answer that looks right.
  //   now, maxEventsPerSession: as buildAwaySummary's `now` / `maxEvents`.
  //
  // Returns { sessions, sessionCount, waitingCount, truncated, sinceText, hasChanges }, sessions
  // newest-first — each entry is a buildAwaySummary result plus the id it belongs to.
  function buildAwayOverview({
    events = [],
    truncated = false,
    awaySince = null,
    now = Date.now(),
    maxEventsPerSession = 8,
  } = {}) {
    const sinceMs = toMs(awaySince);
    const nowMs = toMs(now);
    const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
    const empty = {
      sessions: [], sessionCount: 0, waitingCount: 0, truncated: !!truncated, sinceText: '', hasChanges: false,
    };
    if (!Number.isFinite(sinceMs)) return empty;

    // Grouped by session, insertion order preserved — the read is newest-first, so the first event seen
    // for a session is its newest, and that is the order the list is sorted by below.
    const bySession = new Map();
    for (const event of Array.isArray(events) ? events : []) {
      if (!event || !event.sessionId) continue;
      let group = bySession.get(event.sessionId);
      if (!group) {
        group = { events: [], files: [] };
        bySession.set(event.sessionId, group);
      }
      // `file-touched` carries the path in `detail` and the kind in `label` — the same shape the
      // per-session recap rebuilt from the record, so the builder below takes it unchanged.
      if (event.kind === 'file-touched') {
        if (event.detail) group.files.push({ path: event.detail, at: event.at, kind: event.label || 'open' });
      } else {
        group.events.push(event);
      }
    }

    const sessions = [];
    for (const [sessionId, group] of bySession) {
      const summary = buildAwaySummary({
        events: group.events,
        filesTouched: group.files,
        lastViewedAt: sinceMs,
        now: safeNow,
        maxEvents: maxEventsPerSession,
      });
      if (!summary.hasChanges) continue;
      const newest = group.events[0] || group.files[0] || null;
      sessions.push({ sessionId, ...summary, at: newest ? newest.at : null });
    }
    sessions.sort((a, b) => (toMs(b.at) || 0) - (toMs(a.at) || 0));

    return {
      sessions,
      sessionCount: sessions.length,
      waitingCount: sessions.filter((session) => session.waitingOnYou).length,
      truncated: !!truncated,
      sinceText: `You were away ${formatDuration(safeNow - sinceMs)}`,
      hasChanges: sessions.length > 0,
    };
  }

  return {
    buildAwaySummary,
    buildAwayOverview,
    formatAwayDuration: formatDuration,
  };
});
