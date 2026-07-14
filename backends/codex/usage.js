// backends/codex/usage.js — Codex's usage capability (#191).
//
// Codex hands us its rate limits for free: every `token_count` event in a rollout carries them, so the
// figure is a FILE READ. No network call, no credential access, no auth.json (which we never touch —
// see the descriptor). Taken from a real install, like everything else in docs/backend-formats.md:
//
//   {"type":"event_msg","payload":{"type":"token_count",
//     "info":{ "total_token_usage": {...}, "model_context_window": 258400 },
//     "rate_limits":{
//       "limit_id":"codex", "limit_name":null, "plan_type":"<plan>",
//       "primary":  {"used_percent":0.0,"window_minutes":10080,"resets_at":<epoch seconds>},
//       "secondary":null, "credits":null, "individual_limit":null, "rate_limit_reached_type":null
//     }}}
//
// NOT LIVE — and the renderer is told so (`live: false`). This is the state as of the user's last Codex
// turn. Go three days without running Codex and the number is three days old; a bar that showed it next
// to Claude's live figure, styled the same, would be quietly lying. `observedAt` is what the UI dims and
// timestamps.
//
// Reading strategy: newest rollout first, last `rate_limits` in it — a rollout emits `token_count` many
// times and only the last one is current. If the newest rollout has none (a session that never got a
// reply), fall back through the next few by mtime rather than reporting "no data" while a perfectly good
// figure sits one file away.

'use strict';

const fs = require('fs');
const path = require('path');

const { walkStore } = require('../file-store');
const { formatResetTime, tierForWindowMinutes, labelForWindowMinutes } = require('../usage-format');

// How many recent rollouts to look through before giving up. A handful: the newest file almost always
// has it, and walking the whole store to find a stale number would be work for a worse answer.
const MAX_ROLLOUTS_SCANNED = 5;

function isRollout(name) {
  return name.startsWith('rollout-') && name.endsWith('.jsonl');
}

// The newest rollouts by mtime, newest first.
function recentRollouts(sessionsRoot, limit = MAX_ROLLOUTS_SCANNED) {
  const files = walkStore(sessionsRoot, isRollout);
  const stamped = [];
  for (const file of files) {
    try { stamped.push({ file, mtimeMs: fs.statSync(file).mtimeMs }); } catch { /* vanished mid-walk */ }
  }
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stamped.slice(0, limit);
}

// The LAST rate_limits block in one rollout, with the mtime it was observed at. Scanning line by line
// from the end would be nicer, but a rollout is small and read-in-full keeps this honest and simple.
function lastRateLimitsIn(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let found = null;
  for (const line of text.split('\n')) {
    if (!line || line.indexOf('"rate_limits"') === -1) continue;
    try {
      const entry = JSON.parse(line);
      const rl = entry?.payload?.rate_limits;
      if (rl && typeof rl === 'object') found = rl;
    } catch { /* a half-written trailing line — ignore */ }
  }
  return found;
}

// One of Codex's two windows → a bucket in the shape every backend reports. `used_percent` is a float
// (0.0), the window is minutes, `resets_at` is epoch SECONDS.
function bucketFrom(window, key) {
  if (!window || typeof window !== 'object') return null;
  const percent = Number(window.used_percent);
  if (!Number.isFinite(percent)) return null;
  const minutes = Number(window.window_minutes);
  const label = labelForWindowMinutes(minutes);
  return {
    key,
    label,
    percent: Math.floor(percent),
    reset: window.resets_at ? formatResetTime(window.resets_at) : null,
    tier: tierForWindowMinutes(minutes),
    bar: true,
    cardLabel: Number.isFinite(minutes) && minutes > 0 ? `Window (${label})` : `Window (${key})`,
    windowMinutes: Number.isFinite(minutes) ? minutes : null,
  };
}

// Codex's `credits` pool, when the plan has one. Same slot Claude's extra-usage credits land in.
function quotaFrom(rateLimits) {
  const credits = rateLimits.credits;
  if (!credits || typeof credits !== 'object') return null;
  const percent = Number(credits.used_percent);
  if (!Number.isFinite(percent)) return null;
  return {
    percent: Math.floor(percent),
    used: Number.isFinite(Number(credits.used)) ? Number(credits.used) : null,
    limit: Number.isFinite(Number(credits.limit)) ? Number(credits.limit) : null,
    currency: 'USD',
  };
}

function transformRateLimits(rateLimits, observedAt = null) {
  const base = { backendId: 'codex', live: false, observedAt };
  if (!rateLimits || typeof rateLimits !== 'object') {
    return { ...base, buckets: [], quota: null };
  }
  const buckets = [
    bucketFrom(rateLimits.primary, 'primary'),
    bucketFrom(rateLimits.secondary, 'secondary'),
  ].filter(Boolean);
  return { ...base, buckets, quota: quotaFrom(rateLimits), planType: rateLimits.plan_type || null };
}

// The capability's entry point. `sessionsRoot` is injected by the descriptor (which owns CODEX_HOME), so
// this module never resolves the store itself and a test can point it anywhere.
async function fetchUsage(sessionsRoot) {
  try {
    if (!sessionsRoot || !fs.existsSync(sessionsRoot)) {
      return { backendId: 'codex', live: false, buckets: [], quota: null, _noData: true };
    }
    for (const { file, mtimeMs } of recentRollouts(sessionsRoot)) {
      const rateLimits = lastRateLimitsIn(file);
      if (!rateLimits) continue;
      const usage = transformRateLimits(rateLimits, new Date(mtimeMs).toISOString());
      // A rollout can carry a rate_limits block with both windows null (an early turn). That is not a
      // reading — keep looking rather than reporting a backend with no buckets as if it had answered.
      if (usage.buckets.length > 0 || usage.quota) return usage;
    }
    // Codex is installed and enabled but has never reported a limit. Say so; do not invent a 0%.
    return { backendId: 'codex', live: false, buckets: [], quota: null, _noData: true };
  } catch (err) {
    return { backendId: 'codex', live: false, _error: true, message: err.message };
  }
}

module.exports = { fetchUsage, transformRateLimits, lastRateLimitsIn, recentRollouts };
