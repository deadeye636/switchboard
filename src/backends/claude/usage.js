// backends/claude/usage.js — Claude's usage capability (#191).
//
// Was `claude-auth.js` at the repo root, back when Claude was the only backend that could report a
// quota and "usage" needed no owner. It has one now: this is Claude's OAuth read plus Claude's usage
// endpoint, and it belongs in Claude's folder like every other thing that is true of Claude only.
//
// Credentials: macOS reads the Keychain first and falls back to ~/.claude/.credentials.json;
// Linux/Windows have the file only. We never write them and never log them.
//
// LIVE: the number is fetched from the API on every poll, so it is current as of right now. That is
// what `usage.live = true` on the descriptor promises, and it is what lets the renderer show it
// without an "as of" caveat — unlike Codex, whose figure is only as fresh as its last turn.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Keep in sync with the installed Claude CLI. The usage endpoint gates on a plausible claude-code
// User-Agent; bump this when the CLI version drifts, or wire up detection of the installed CLI
// version later (issue #76).
const CLAUDE_CLI_USER_AGENT = 'claude-code/2.1.74';

function getConfigDir() {
  return (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
}

function getKeychainServiceName() {
  const suffix = '-credentials';
  if (process.env.CLAUDE_CONFIG_DIR) {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(getConfigDir()).digest('hex').substring(0, 8);
    return `Claude Code${suffix}-${hash}`;
  }
  return `Claude Code${suffix}`;
}

function readFromKeychain() {
  if (process.platform !== 'darwin') return null;
  try {
    const service = getKeychainServiceName();
    const user = process.env.USER || os.userInfo().username;
    // execFileSync (no shell) so $USER can't be interpolated into a command string
    const json = execFileSync(
      'security',
      ['find-generic-password', '-a', user, '-w', '-s', service],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    return JSON.parse(json);
  } catch (err) {
    console.error('[claude-usage] Keychain read error:', err.message);
    return null;
  }
}

function readFromFile() {
  try {
    const credPath = path.join(getConfigDir(), '.credentials.json');
    return JSON.parse(fs.readFileSync(credPath, 'utf8'));
  } catch (err) {
    // A missing credentials file is the normal "not logged in" state on Win/Linux — don't spam
    // electron-log; only surface real read/parse errors (issue #76).
    if (err.code !== 'ENOENT') console.error('[claude-usage] Credentials file read error:', err.message);
    return null;
  }
}

function getOAuthToken() {
  const creds = readFromKeychain() || readFromFile();
  return creds?.claudeAiOauth || null;
}

// A reset time as the status bar wants to read it: a 24h clock in the system timezone, with the date
// added once it is further out than a day. Shared with Codex via `usage-format.js` — both backends
// hand us an epoch or an ISO string and want the same string back.
const { formatResetTime } = require('../usage-format');

// `bucketKey` is the name of a window in the API's response — 'five_hour', 'seven_day' and so on.
// It was called `apiKey`, which reads as a credential: a human skims the log line below and sees a
// secret being printed, and CodeQL's clear-text-logging query said so outright. The value never was
// one, but a name that has to be checked against its call sites is a name worth changing.
function mapBucket(apiUsage, bucketKey, bucket, out) {
  try {
    const u = apiUsage[bucketKey];
    if (!u || u.utilization === null || u.utilization === undefined) return;
    out.push({
      ...bucket,
      percent: Math.floor(u.utilization),
      reset: u.resets_at ? formatResetTime(u.resets_at) : null,
    });
  } catch (err) {
    console.error('[claude-usage] Error mapping bucket', bucketKey, err.message);
  }
}

function mapQuota(apiUsage) {
  const extra = apiUsage.extra_usage;
  if (!extra || typeof extra !== 'object') return null;
  if (extra.utilization === undefined || extra.utilization === null) return null;
  return {
    percent: Math.floor(Number(extra.utilization)),
    used: extra.used_credits === undefined || extra.used_credits === null ? null : Number(extra.used_credits),
    limit: extra.monthly_limit === undefined || extra.monthly_limit === null ? null : Number(extra.monthly_limit),
    currency: extra.currency ? String(extra.currency) : 'USD',
    enabled: extra.is_enabled === undefined ? null : !!extra.is_enabled,
    disabledReason: extra.disabled_reason ? String(extra.disabled_reason) : null,
  };
}

// The API's shape → the shape every backend reports (#191): a list of buckets, each with the tier that
// decides which threshold pair colours it, and a `bar` flag for the two that belong in the status bar.
// The other two (Sonnet / Opus) would make the bar four windows wide for no gain; Stats shows them.
function transformUsageResponse(apiUsage) {
  if (!apiUsage) return { backendId: 'claude', live: true, buckets: [], quota: null };
  const buckets = [];
  mapBucket(apiUsage, 'five_hour', { key: 'session', label: '5h', tier: 'short', bar: true, cardLabel: 'Current session' }, buckets);
  mapBucket(apiUsage, 'seven_day', { key: 'weekAll', label: '7d', tier: 'long', bar: true, cardLabel: 'Week (all models)' }, buckets);
  mapBucket(apiUsage, 'seven_day_sonnet', { key: 'weekSonnet', label: 'Sonnet', tier: 'long', bar: false, cardLabel: 'Week (Sonnet)' }, buckets);
  mapBucket(apiUsage, 'seven_day_opus', { key: 'weekOpus', label: 'Opus', tier: 'long', bar: false, cardLabel: 'Week (Opus)' }, buckets);
  return { backendId: 'claude', live: true, buckets, quota: mapQuota(apiUsage) };
}

async function fetchRaw() {
  const oauth = getOAuthToken();
  if (!oauth?.accessToken) return null;

  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      'Authorization': `Bearer ${oauth.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': CLAUDE_CLI_USER_AGENT,
      'anthropic-beta': 'oauth-2025-04-20',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
    return { _rateLimited: true, retryAfterSeconds: retryAfter };
  }

  if (!res.ok) {
    console.error('[claude-usage] Usage API error:', res.status, res.statusText);
    return null;
  }
  return await res.json();
}

// The capability's entry point. Never throws: an error is a state the status bar renders, not a crash.
async function fetchUsage() {
  try {
    const raw = await fetchRaw();
    if (raw === null) {
      return { backendId: 'claude', live: true, _error: true, message: 'Could not fetch usage (no token or API error)' };
    }
    if (raw?._rateLimited) {
      return { backendId: 'claude', live: true, _rateLimited: true, retryAfterSeconds: raw.retryAfterSeconds };
    }
    return transformUsageResponse(raw);
  } catch (err) {
    return { backendId: 'claude', live: true, _error: true, message: err.message };
  }
}

module.exports = { fetchUsage, transformUsageResponse, getOAuthToken, getConfigDir };
