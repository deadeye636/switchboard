// backends/usage-format.js — the bits of the usage capability every backend needs (#191).
//
// A backend that can report a quota returns the SAME shape, so the core never learns a backend id:
//
//   {
//     backendId, live,                  // `live`: fetched now (Claude) vs. as of the last run (Codex)
//     observedAt: <ISO> | null,         // when a NON-live figure was actually true. null when live.
//     buckets: [ { key, label, percent, reset, tier, bar, cardLabel } ],
//     quota: { percent, used, limit, currency } | null,   // a credit pool beside the buckets
//     _error | _rateLimited | ...       // a state the bar renders, never a throw
//   }
//
// `tier` picks the threshold pair that colours the bar, and it is about **how fast the bucket refills**,
// not about a fixed window length:
//
//   'short'  — refills within hours; you can hit it today and be blocked this afternoon (Claude's 5h).
//   'long'   — refills over days; the slow burn (Claude's 7d and its credit pool, Codex's weekly).
//
// Deliberately not "5h" and "7d". Those are *Claude's* windows. Codex reports `window_minutes` and the
// provider can change it whenever it likes; Google Antigravity does not report time windows at all — its
// quotas are per MODEL, each with its own percentage and reset. A tier keyed on refill speed carries all
// three; a tier keyed on "5h vs 7d" carries exactly one, which is how the settings page ended up with
// `sv-usage-5h-warn` in the first place.

// A reset time as the status bar wants to read it: 24h clock in the system timezone, with the date added
// once it is further out than a day. Accepts an ISO string, epoch seconds, or epoch millis — Claude sends
// ISO, Codex sends epoch seconds.
function formatResetTime(value) {
  if (!value) return null;
  let resetDate;
  if (typeof value === 'string') {
    resetDate = new Date(value);
  } else if (value > 1e12) {
    resetDate = new Date(value);
  } else {
    resetDate = new Date(value * 1000);
  }
  if (isNaN(resetDate.getTime())) return null;
  const diffMs = resetDate - new Date();

  const hours = resetDate.getHours();
  const minutes = resetDate.getMinutes();
  const timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

  const tz = Intl.DateTimeFormat('en', { timeZoneName: 'short' }).formatToParts(resetDate)
    .find(p => p.type === 'timeZoneName')?.value || '';

  if (diffMs < 24 * 60 * 60 * 1000) return `${timeStr} (${tz})`;

  const month = resetDate.toLocaleString('en', { month: 'short' });
  const day = resetDate.getDate();
  return `${month} ${day} at ${timeStr} (${tz})`;
}

// A window in minutes → the tier that colours it. The cut is at a day: anything that refills within one
// is something you can run into during a working session.
function tierForWindowMinutes(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return 'long';
  return m < 24 * 60 ? 'short' : 'long';
}

// A window in minutes → a label a human reads on a 40px-wide bar. 300 → "5h", 10080 → "7d".
function labelForWindowMinutes(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return '?';
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 24 * 60) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / (24 * 60))}d`;
}

module.exports = { formatResetTime, tierForWindowMinutes, labelForWindowMinutes };
