// backends/codex/usage.js — Codex's usage capability (#191, reworked in #494).
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
//       "secondary":null, "credits":{...}, "individual_limit":null, "rate_limit_reached_type":null
//     }}}
//
// NOT LIVE — and the renderer is told so (`live: false`). This is the state as of the user's last Codex
// turn. Go three days without running Codex and the number is three days old; a bar that showed it next
// to Claude's live figure, styled the same, would be quietly lying. `observedAt` is what the UI dims and
// timestamps.
//
// THE LAST BLOCK IS NOT THE LAST READING (#494). A session ENDS with a `rate_limits` block that carries
// no windows at all — measured on a real store, at the moment the account ran out:
//
//   {"limit_id":"premium","primary":null,"secondary":null,
//    "credits":{"has_credits":false,"unlimited":false,"balance":null},
//    "rate_limit_reached_type":"workspace_member_credits_depleted"}
//
// Taking the literal last block therefore threw away the forty-odd good readings sitting earlier in the
// SAME file, and the bar went to "no data yet" while Codex had in fact said exactly what was wrong. So
// two things are read out of a rollout, not one: the last block that actually MEASURES something, and
// the last block of any kind — the latter only for `rate_limit_reached_type`, which is the reason the
// user wants to see.
//
// Reading strategy: newest rollout first, and only its TAIL — a rollout runs to tens of megabytes and
// this is polled once a minute in the main process, so reading one end to end on every tick was the
// single most expensive thing the status bar did. A per-file memo keyed on mtime+size means an unchanged
// transcript is not read twice. The full file is still read when the tail holds no reading, so nothing
// is traded away for the speed. If a rollout has none at all (a session that never got a reply), fall
// through the next few by mtime rather than reporting "no data" while a good figure sits one file away.

'use strict';

const fs = require('fs');

const { walkStore } = require('../file-store');
const { formatResetTime, tierForWindowMinutes, labelForWindowMinutes } = require('../usage-format');

// How many recent rollouts to look through before giving up. Raised from five in #494: Codex writes one
// rollout per session and a burst of them can be started in the same second, so five slots were used up
// by a single afternoon's worth of short sessions while the reading sat in the sixth.
const MAX_ROLLOUTS_SCANNED = 10;

// How much of a rollout's end to read before falling back to the whole file. A `token_count` event is a
// few hundred bytes and one is emitted per turn, so the last reading is at most a few kilobytes from the
// end in any session that ever got a reply. Generous by two orders of magnitude, and still nothing next
// to the multi-megabyte transcripts this replaces.
const TAIL_BYTES = 256 * 1024;

// Per-file memo, keyed on the identity of the CONTENT (mtime + size), not on the path alone: an appended
// rollout must be re-read, an untouched one must not. Bounded, because the store grows forever.
const MAX_MEMO_ENTRIES = 64;
const memo = new Map();

// How long a FRUITLESS full read is believed. The tail covers everything a live session appends, so a
// rollout that held no reading in its first megabytes will not have grown one there — but its mtime and
// size change on every append, which invalidates the memo and would otherwise buy that whole-file read
// again on every poll. This is the bound: the old part of a file is re-read at most this often.
const FULL_READ_COOLDOWN_MS = 10 * 60 * 1000;
const fruitlessFullRead = new Map();

function isRollout(name) {
  return name.startsWith('rollout-') && name.endsWith('.jsonl');
}

// The newest rollouts by mtime, newest first. `size` comes along because the tail read and the memo both
// need it, and one stat is cheaper than three.
function recentRollouts(sessionsRoot, limit = MAX_ROLLOUTS_SCANNED) {
  const files = walkStore(sessionsRoot, isRollout);
  const stamped = [];
  for (const file of files) {
    try {
      const st = fs.statSync(file);
      stamped.push({ file, mtimeMs: st.mtimeMs, size: st.size });
    } catch { /* vanished mid-walk */ }
  }
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stamped.slice(0, limit);
}

// The last `size` bytes of a file as text, with the (probably truncated) first line dropped. `partial`
// says whether anything was left out — the caller needs it to know whether an empty result means "no
// reading in this file" or only "none near the end".
function readTail(file, size, bytes = TAIL_BYTES) {
  if (!Number.isFinite(size) || size <= bytes) {
    return { text: fs.readFileSync(file, 'utf8'), partial: false };
  }
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, size - bytes);
    const text = buf.toString('utf8', 0, read);
    const nl = text.indexOf('\n');
    // A cut mid-line — and possibly mid-codepoint — is why the first line is always discarded.
    return { text: nl === -1 ? '' : text.slice(nl + 1), partial: true };
  } finally {
    fs.closeSync(fd);
  }
}

// Every `rate_limits` block in a chunk of rollout text, reduced to the two that matter.
function scanRateLimits(text) {
  let usable = null;
  let latest = null;
  for (const line of text.split('\n')) {
    if (!line || line.indexOf('"rate_limits"') === -1) continue;
    let rl;
    try { rl = JSON.parse(line)?.payload?.rate_limits; }
    catch { continue; }                       // a half-written trailing line — ignore
    if (!rl || typeof rl !== 'object') continue;
    latest = rl;
    if (hasReading(rl)) usable = rl;
  }
  return { usable, latest };
}

// Does this block MEASURE anything? A terminal block names a limit and reports no window and no pool;
// that is a reason, not a reading, and the difference is the whole of #494.
function hasReading(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return false;
  return !!(bucketFrom(rateLimits.primary, 'primary')
    || bucketFrom(rateLimits.secondary, 'secondary')
    || quotaFrom(rateLimits));
}

/**
 * The two blocks one rollout has to offer: `usable` (the last one that measures something) and `latest`
 * (the last one of any kind, read only for `rate_limit_reached_type`).
 *
 * The tail is tried first and the whole file only when the tail produced no reading — so the fast path
 * is the normal one and correctness does not depend on it.
 */
function readRateLimits(file, mtimeMs, size) {
  const cached = memo.get(file);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    memo.delete(file);                     // re-insert so the eviction below is by LAST USE, not by age
    memo.set(file, cached);
    return cached.value;
  }

  let value = { usable: null, latest: null };
  try {
    const tail = readTail(file, size);
    value = scanRateLimits(tail.text);
    if (!value.usable && tail.partial && Date.now() - (fruitlessFullRead.get(file) || 0) >= FULL_READ_COOLDOWN_MS) {
      const full = scanRateLimits(fs.readFileSync(file, 'utf8'));
      if (full.usable) fruitlessFullRead.delete(file);
      else fruitlessFullRead.set(file, Date.now());
      value = full;
    }
  } catch { /* unreadable or vanished — no reading, and the next rollout gets its turn */ }

  if (memo.size >= MAX_MEMO_ENTRIES) memo.delete(memo.keys().next().value);
  memo.set(file, { mtimeMs, size, value });
  if (fruitlessFullRead.size > MAX_MEMO_ENTRIES) fruitlessFullRead.delete(fruitlessFullRead.keys().next().value);
  return value;
}

// Kept for the descriptor's tests and for anything that only wants "the reading in this file": the last
// block that measures something, falling back to the last block of any kind.
function lastRateLimitsIn(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const { usable, latest } = readRateLimits(file, st.mtimeMs, st.size);
  return usable || latest;
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

/**
 * Codex's `credits` pool, when the plan has one. Same slot Claude's extra-usage credits land in.
 *
 * TWO SHAPES, because the field changed under us (#494). The percentage shape is what #191 read and is
 * kept for a store written by an older CLI. Every rollout a current CLI writes carries
 * `{has_credits, unlimited, balance}` instead — and that is the whole of it: no denominator, so there is
 * no percentage to draw, and the honest answer is no quota rather than a bar at nought.
 *
 * A BALANCE IS DELIBERATELY NOT TURNED INTO ONE. A percentage needs a total, and no capture from a real
 * install — not the block in this file's header, not `docs/backend-formats.md`, not the store this was
 * measured against — has ever shown a total beside the balance. Guessing at a field name would be a bar
 * drawn from a number nobody has seen; when Codex starts reporting one, add it here WITH the capture.
 */
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

/**
 * `rate_limit_reached_type` → a sentence (#494).
 *
 * Codex names the reason and Switchboard used to drop it on the floor, so an account that had run out
 * read as "no data yet" — the one state that tells the user nothing. Only the value actually measured is
 * spelled out; anything else is de-snaked rather than guessed at, because inventing wording for a code
 * we have never seen is how a status bar starts lying.
 */
function reachedMessage(type) {
  if (!type) return null;
  if (type === 'workspace_member_credits_depleted') return 'Your workspace credits are used up.';
  const words = String(type).replace(/_/g, ' ').trim();
  return words ? `Codex reported a limit was reached (${words}).` : 'Codex reported a limit was reached.';
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

const noData = () => ({ backendId: 'codex', live: false, buckets: [], quota: null, _noData: true });

// The capability's entry point. `sessionsRoot` is injected by the descriptor (which owns CODEX_HOME), so
// this module never resolves the store itself and a test can point it anywhere.
async function fetchUsage(sessionsRoot) {
  try {
    if (!sessionsRoot || !fs.existsSync(sessionsRoot)) return noData();

    // The newest "a limit was reached" seen while looking, whether or not the same file also measured
    // something. Rollouts are walked newest first, so the first one found is the most recent.
    let reached = null;

    for (const { file, mtimeMs, size } of recentRollouts(sessionsRoot)) {
      const { usable, latest } = readRateLimits(file, mtimeMs, size);
      if (!reached && latest && latest.rate_limit_reached_type) {
        reached = { type: latest.rate_limit_reached_type, at: mtimeMs };
      }
      if (!usable) continue;

      const usage = transformRateLimits(usable, new Date(mtimeMs).toISOString());
      // A reading AND a reason: the bars are real, so they are shown — the reason rides along as a note
      // rather than as `_rateLimited`, which would send this straight to the stale-cache fallback and
      // replace a current reading with an older one.
      if (reached) {
        usage.limitReached = reached.type;
        usage.limitReachedMessage = reachedMessage(reached.type);
      }
      return usage;
    }

    // No reading anywhere — but Codex said why, which is worth far more than "no data yet".
    if (reached) {
      return {
        backendId: 'codex',
        live: false,
        buckets: [],
        quota: null,
        _rateLimited: true,
        limitReached: reached.type,
        message: reachedMessage(reached.type),
      };
    }

    // Codex is installed and enabled but has never reported a limit. Say so; do not invent a 0%.
    return noData();
  } catch (err) {
    return { backendId: 'codex', live: false, _error: true, message: `Usage could not be read (${err && err.code ? err.code : 'unknown error'}).` };
  }
}

module.exports = {
  fetchUsage,
  transformRateLimits,
  lastRateLimitsIn,
  readRateLimits,
  recentRollouts,
  reachedMessage,
};
