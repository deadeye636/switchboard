// backends/agy/usage.js — agy's usage capability (#191, #201).
//
// Unlike Codex (whose figure falls out of a file it already writes) agy exposes NO local quota file.
// Current releases own their OAuth token in the OS keyring and expose quota through their loopback HTTPS
// service. local-usage.js reads that service first, so AGY remains the credential owner. This older remote
// request survives only as a best-effort fallback for installs on which it is still entitled:
//
//   POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota   body {}   (OAuth2 bearer)
//   -> { "buckets": [ { "modelId":"gemini-2.5-pro", "tokenType":"REQUESTS",
//                       "remainingFraction": 1, "resetTime":"<ISO8601>" }, … ] }
//
// This is Gemini CLI's private Code Assist API (`cloudcode-pa`, `v1internal`). It was confirmed live
// against the imported credentials when #201 shipped, but current AGY OAuth uses a different client and
// the legacy request may return 403. That response means this SOURCE cannot expose limits — not that a
// personal account is unmetered, and not that AGY itself is unavailable (#509).
//
// Legacy fallback credentials: older agy installs imported gemini-cli's config, so OAuth may exist in
// ~/.gemini/oauth_creds.json (an installed-app refresh token). We READ it and never write it — agy owns
// that file. When the stored
// access token has expired we mint a fresh one via gemini-cli's PUBLIC installed-app OAuth client, in
// memory only, and never touch agy's file or log the token.
//
// LIVE: the number is fetched on every poll, so `usage.live = true` on the descriptor and the bar shows
// it without an "as of" caveat.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { formatResetTime } = require('../usage-format');
const localUsage = require('./local-usage');

// gemini-cli's PUBLIC installed-app OAuth client (open source: google-gemini/gemini-cli, packages/core
// src/code_assist/oauth2.ts). agy signs in through the same client and writes the same oauth_creds.json,
// so this refreshes agy's token too. An installed-app "secret" is not a real secret — it ships in every
// gemini-cli copy — and it carries no personal data.
const OAUTH_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = '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';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';

// Where older agy installs may keep imported gemini-cli OAuth. SWITCHBOARD_AGY_CREDS can point tests or
// an isolated instance at another file; unset, the read-only usage exception uses the real account.
function credsPath() {
  return process.env.SWITCHBOARD_AGY_CREDS || path.join(os.homedir(), '.gemini', 'oauth_creds.json');
}

function readCreds() {
  try {
    return JSON.parse(fs.readFileSync(credsPath(), 'utf8'));
  } catch (err) {
    // A missing file is the normal "agy not signed in" state — stay quiet; only surface real read errors.
    if (err.code !== 'ENOENT') console.error('[agy-usage] credentials read error:', err.message);
    return null;
  }
}

// A fresh access token minted in memory, cached across polls so a stale stored token does not trigger a
// refresh on every single poll. Never persisted — agy owns oauth_creds.json.
let _cachedToken = null; // { accessToken, expiresAt }

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    console.error('[agy-usage] token refresh failed:', res.status);
    return null;
  }
  const json = await res.json();
  if (!json.access_token) return null;
  const ttlMs = (Number(json.expires_in) || 3600) * 1000;
  return { accessToken: json.access_token, expiresAt: Date.now() + ttlMs };
}

// A usable bearer: the in-memory cache, else the still-valid stored token, else a refresh. `expiry_date`
// in oauth_creds.json is epoch millis (gemini-cli's convention). Returns null when nothing can be minted
// (not signed in, no refresh token).
async function getAccessToken(creds, { forceRefresh = false } = {}) {
  const SKEW = 60 * 1000;
  if (!forceRefresh && _cachedToken && _cachedToken.expiresAt > Date.now() + SKEW) {
    return _cachedToken.accessToken;
  }
  if (!forceRefresh && creds.access_token && Number(creds.expiry_date) > Date.now() + SKEW) {
    return creds.access_token;
  }
  if (!creds.refresh_token) return null;
  const refreshed = await refreshAccessToken(creds.refresh_token);
  if (!refreshed) return null;
  _cachedToken = refreshed;
  return refreshed.accessToken;
}

async function requestQuota(token) {
  return fetch(QUOTA_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(10000),
  });
}

async function fetchRemoteRaw() {
  const creds = readCreds();
  if (!creds) return { kind: 'notConfigured' };

  let token = await getAccessToken(creds);
  if (!token) return { kind: 'authRequired' };

  let res = await requestQuota(token);

  // A cached token can go stale between polls; a 401/403 is the cue to mint a fresh one and retry ONCE,
  // rather than reporting the account as out of quota when it is only the token that lapsed.
  if (res.status === 401 || res.status === 403) {
    _cachedToken = null;
    token = await getAccessToken(creds, { forceRefresh: true });
    if (!token) return { kind: 'authRequired' };
    res = await requestQuota(token);
  }

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
    return { kind: 'rateLimited', retryAfterSeconds: retryAfter };
  }
  if (res.status === 401) return { kind: 'authRequired' };
  if (res.status === 403) return { kind: 'permissionDenied' };
  if (!res.ok) {
    console.error('[agy-usage] quota API error:', res.status);
    return { kind: 'error', status: res.status };
  }
  return { kind: 'quota', raw: await res.json() };
}

// 'gemini-2.5-pro' → '2.5 Pro' (bar) / 'Gemini 2.5 Pro' (card). A non-REQUESTS pool (a token quota) is
// tagged so it can't be mistaken for a request count.
function humaniseModel(modelId) {
  const raw = String(modelId || '').trim();
  if (!raw) return { short: '?', card: 'Model' };
  const stripped = raw.replace(/^gemini-/i, '');
  const words = stripped.split(/[-_]/).map(w => (/^[a-z]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w));
  const short = words.join(' ');
  const card = /^gemini/i.test(raw) ? `Gemini ${short}` : short;
  return { short, card };
}

function tokenTypeSuffix(tokenType) {
  const t = String(tokenType || '').toUpperCase();
  return (t && t !== 'REQUESTS') ? ` (${t.toLowerCase()})` : '';
}

// agy reports no time window, only a reset instant — so tier is decided by how soon the pool refills: a
// bucket that resets within a day is the 'short' one you can run into today, anything longer is 'long'.
function tierForReset(resetTime) {
  const t = new Date(resetTime).getTime();
  if (!Number.isFinite(t)) return 'long';
  return (t - Date.now()) < 24 * 60 * 60 * 1000 ? 'short' : 'long';
}

function mapModelBucket(b, i) {
  // Drop a bucket with no fraction rather than let it read as 0 remaining (100% used, red). `Number(null)`
  // and `Number('')` are both 0, so guard those explicitly before coercing — an unmetered/unlimited pool
  // this undocumented API might report as null must not paint the model as fully exhausted.
  const raw = b && b.remainingFraction;
  if (raw == null || raw === '') return null;
  const frac = Number(raw);
  if (!Number.isFinite(frac)) return null;
  const percent = Math.max(0, Math.min(100, Math.floor((1 - frac) * 100)));
  const model = String((b && b.modelId) || '');
  const named = String((b && (b.displayName || b.label)) || '').trim();
  const { short, card } = named ? { short: named, card: named } : humaniseModel(model);
  const suffix = tokenTypeSuffix(b && b.tokenType);
  return {
    key: model || `bucket-${i}`,
    label: short + suffix,
    percent,
    reset: b && b.resetTime ? formatResetTime(b.resetTime) : null,
    tier: tierForReset(b && b.resetTime),
    bar: false,                         // set on exactly one bucket below
    cardLabel: card + suffix,
  };
}

// How near a model is to its limit, for choosing the ONE bucket the status bar shows. Higher `percent`
// wins (that is the pool you will hit first); on a tie the more capable model is the more useful headline.
function modelRank(key) {
  const k = String(key).toLowerCase();
  if (k.includes('pro')) return 3;
  if (k.includes('lite')) return 1;
  if (k.includes('flash')) return 2;
  return 0;
}

// agy's quota is PER MODEL, so there is no single aggregate window to headline — showing every model as a
// bar would make agy's segment several times wider than Claude's. The status bar shows the one model
// closest to its limit (the binding constraint); every model still appears in the tooltip and the Stats
// cards, which read all buckets regardless of the `bar` flag.
function markStatusBarBucket(buckets) {
  let pick = null;
  for (const bucket of buckets) {
    if (!pick
      || bucket.percent > pick.percent
      || (bucket.percent === pick.percent && modelRank(bucket.key) > modelRank(pick.key))) {
      pick = bucket;
    }
  }
  if (pick) pick.bar = true;
  return buckets;
}

// The API shape → the shape every backend reports (#191). Pure: no network, no clock beyond `tierForReset`
// / `formatResetTime`, so it is unit-tested directly.
function transformQuotaResponse(raw) {
  const base = { backendId: 'agy', live: true };
  const list = raw && Array.isArray(raw.buckets) ? raw.buckets : [];
  const buckets = markStatusBarBucket(list.map(mapModelBucket).filter(Boolean));
  return { ...base, buckets, quota: null };
}

function remainingFraction(bucket) {
  const direct = bucket && bucket.remainingFraction;
  if (direct != null && direct !== '') return direct;
  const nested = bucket && bucket.remaining;
  if (!nested || typeof nested !== 'object') return null;
  if (nested.remainingFraction != null && nested.remainingFraction !== '') return nested.remainingFraction;
  if (nested.case === 'remainingFraction') return nested.value;
  return null;
}

function quotaGroupLabel(value) {
  const label = String(value || '').trim();
  const lower = label.toLowerCase();
  if (lower.includes('gemini')) return 'Gemini';
  if (lower.includes('claude') || lower.includes('gpt')) return 'Claude/GPT';
  return label || 'Quota';
}

function quotaCadence(bucket) {
  const raw = `${bucket?.bucketId || ''} ${bucket?.displayName || ''}`.toLowerCase().replace(/_/g, '-');
  if (/\b(session|5h|5-hour|five[- ]hour)\b/.test(raw)) return { label: '5h', tier: 'short' };
  if (/\bweekly\b/.test(raw)) return { label: '7d', tier: 'long' };
  return { label: String(bucket?.displayName || bucket?.bucketId || 'Limit'), tier: null };
}

function transformQuotaSummaryResponse(raw) {
  const payload = localUsage.quotaSummaryPayload(raw);
  const buckets = [];
  for (const [groupIndex, group] of (payload?.groups || []).entries()) {
    const groupLabel = quotaGroupLabel(group?.displayName);
      // A group whose `buckets` is not an array is a payload this reverse-engineered service could hand
    // over any day. `.entries()` on a string would throw and cost the whole poll, fallback included.
    const groupBuckets = Array.isArray(group?.buckets) ? group.buckets : [];
    for (const [bucketIndex, bucket] of groupBuckets.entries()) {
      const remaining = remainingFraction(bucket);
      if (bucket?.disabled || remaining == null || remaining === '') continue;
      const fraction = Number(remaining);
      if (!Number.isFinite(fraction)) continue;
      const cadence = quotaCadence(bucket);
      const keyPart = String(bucket?.bucketId || bucketIndex);
      buckets.push({
        key: `summary:${groupIndex}:${keyPart}`,
        label: `${groupLabel} ${cadence.label}`,
        percent: Math.max(0, Math.min(100, Math.floor((1 - fraction) * 100))),
        reset: bucket?.resetTime ? formatResetTime(bucket.resetTime) : (bucket?.description || null),
        tier: cadence.tier || tierForReset(bucket?.resetTime),
        bar: false,
        cardLabel: `${groupLabel} ${cadence.label}`,
      });
    }
  }
  return { backendId: 'agy', live: true, buckets: markStatusBarBucket(buckets), quota: null };
}

function transformLocalModelsResponse(raw) {
  const configs = localUsage.modelConfigsPayload(raw) || [];
  return transformQuotaResponse({
    buckets: configs.map(config => ({
      modelId: config?.modelOrAlias?.model,
      displayName: config?.label,
      tokenType: 'REQUESTS',
      remainingFraction: config?.quotaInfo?.remainingFraction,
      resetTime: config?.quotaInfo?.resetTime,
    })),
  });
}

// The capability's entry point. Never throws: an error is a state the status bar renders, not a crash.
async function fetchUsage(context = {}) {
  try {
    // An isolated store moves only Switchboard's scanner; agy has no matching CLI-home override. Starting
    // a probe there would escape the demo/sandbox and boot the user's real CLI. The legacy HTTP fallback
    // is skipped too: a demo verification must not become a live-account verification by accident.
    const isolatedStore = !!context.processEnv?.SWITCHBOARD_STORE_AGY;
    if (isolatedStore) {
      return {
        backendId: 'agy', live: true, buckets: [], quota: null, _noData: true, _limitsUnavailable: true,
        message: 'AGY limits are unavailable in isolated mode.',
      };
    }
    const local = await localUsage.fetchLocalRaw({
      livePids: context.livePids || [],
      allowLaunch: !context.hasCachedUsage,
      findExecutable: context.findExecutable,
      deps: { ...(context.localDeps || {}), env: context.processEnv || context.localDeps?.env },
    });
    if (local.kind === 'summary' || local.kind === 'models') {
      const usage = local.kind === 'summary'
        ? transformQuotaSummaryResponse(local.raw)
        : transformLocalModelsResponse(local.raw);
      if (usage.buckets.length > 0) return usage;
    }
    if (local.kind === 'rateLimited') {
      return { backendId: 'agy', live: true, _rateLimited: true, retryAfterSeconds: local.retryAfterSeconds };
    }
    if (local.kind === 'authRequired') {
      return { backendId: 'agy', live: true, _error: true, message: 'Antigravity CLI is not signed in.' };
    }

    const remote = await (context.remoteFetch || fetchRemoteRaw)();
    if (remote.kind === 'rateLimited') {
      return { backendId: 'agy', live: true, _rateLimited: true, retryAfterSeconds: remote.retryAfterSeconds };
    }
    if (remote.kind === 'permissionDenied') {
      return {
        backendId: 'agy', live: true, buckets: [], quota: null, _noData: true, _limitsUnavailable: true,
        message: 'AGY is ready, but this Google OAuth source does not expose its limits.',
      };
    }
    if (remote.kind === 'authRequired') {
      return { backendId: 'agy', live: true, _error: true, message: 'Antigravity CLI usage authentication failed.' };
    }
    if (remote.kind !== 'quota') {
      return { backendId: 'agy', live: true, _error: true, message: 'Antigravity CLI usage could not be read.' };
    }
    const usage = transformQuotaResponse(remote.raw);
    if (usage.buckets.length === 0) return { backendId: 'agy', live: true, buckets: [], quota: null, _noData: true };
    return usage;
  } catch (err) {
    return { backendId: 'agy', live: true, _error: true, message: `Usage could not be read (${err && err.code ? err.code : 'unknown error'}).` };
  }
}

module.exports = {
  fetchUsage,
  transformQuotaResponse,
  transformQuotaSummaryResponse,
  transformLocalModelsResponse,
  credsPath,
};
