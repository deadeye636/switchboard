// backends/cache-accounting.js — what a backend's stored `inputTokens` means next to its cache counts, and the one
// formula for the cache hit rate that follows from it (spec 48, "Cache hit rate").
//
// The ANSWER is a descriptor field, `cacheAccounting`, declared per backend from a measurement (spec 48, T1):
//   'additive' — input excludes the cache; the cached part is reported apart (read, and a creation count).
//   'included' — input already contains the cached read part (no creation concept in the stored data).
//   'none'     — the backend reports no cache at all.
//   null       — the backend declines (not measured). The core treats it as "no rate", never as 0 %.
//
// This file requires nothing and names no backend. The stats fold in `src/app/stats.js` (plan T4) asks it; a second copy
// of the formula anywhere else would be the drift this seam exists to prevent.
'use strict';

const CACHE_ACCOUNTING = ['additive', 'included', 'none'];

function num(v) { return Number.isFinite(v) && v > 0 ? v : 0; }

/**
 * The cache hit as `{ hit, base }` for one backend's totals, so a caller can sum the pairs across backends and divide
 * once (a true weighted rate). `null` for a backend that declines or has `none`, and for an empty base: such a backend
 * contributes nothing and a rate with no base is "—", never 0 %.
 */
function cacheHit(accounting, { input, cacheRead, cacheCreation } = {}) {
  const i = num(input), r = num(cacheRead), w = num(cacheCreation);
  let base;
  if (accounting === 'additive') base = i + r + w;
  else if (accounting === 'included') base = i;
  else return null;
  if (base <= 0) return null;
  // `included` reads the cached part out of the input, so it cannot exceed it; a row that says otherwise is bad data.
  return { hit: Math.min(r, base), base };
}

/** A rate in [0, 1] from a `{ hit, base }` sum, or `null` with no base. */
function rateOf(sum) {
  return sum && sum.base > 0 ? sum.hit / sum.base : null;
}

module.exports = { CACHE_ACCOUNTING, cacheHit, rateOf };
