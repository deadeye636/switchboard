// claude-auth.js — Read Claude Code OAuth credentials and fetch usage data
// macOS: Keychain (primary) → ~/.claude/.credentials.json (fallback)
// Linux/Windows: ~/.claude/.credentials.json only

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const log = require('electron-log');

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
    log.info('[claude-auth] Keychain lookup: service=' + service + ', user=' + user);
    const json = execSync(
      `security find-generic-password -a "${user}" -w -s "${service}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    const parsed = JSON.parse(json);
    log.info('[claude-auth] Keychain: found keys:', Object.keys(parsed || {}));
    return parsed;
  } catch (err) {
    log.info('[claude-auth] Keychain: not found or error');
    return null;
  }
}

function readFromFile() {
  const credPath = path.join(getConfigDir(), '.credentials.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    log.info('[claude-auth] File: found keys:', Object.keys(parsed || {}));
    return parsed;
  } catch {
    log.info('[claude-auth] File: not found at', credPath);
    return null;
  }
}

function getOAuthToken() {
  const creds = readFromKeychain() || readFromFile();
  const oauth = creds?.claudeAiOauth || null;
  if (oauth) {
    const tokenPrefix = oauth.accessToken?.substring(0, 20) + '...';
    log.info('[claude-auth] Token prefix:', tokenPrefix, '| scopes:', oauth.scopes);
  }
  return oauth;
}

function formatResetTime(value) {
  if (!value) return null;
  // Handle seconds, milliseconds, or ISO string
  let resetDate;
  if (typeof value === 'string') {
    resetDate = new Date(value);
  } else if (value > 1e12) {
    resetDate = new Date(value); // already milliseconds
  } else {
    resetDate = new Date(value * 1000); // seconds → ms
  }
  if (isNaN(resetDate.getTime())) return null;
  const now = new Date();
  const diffMs = resetDate - now;

  // Format time part
  const hours = resetDate.getHours();
  const minutes = resetDate.getMinutes();
  const ampm = hours >= 12 ? 'pm' : 'am';
  const h = hours % 12 || 12;
  const timeStr = minutes === 0 ? `${h}${ampm}` : `${h}:${String(minutes).padStart(2, '0')}${ampm}`;

  // Get timezone abbreviation
  const tz = Intl.DateTimeFormat('en', { timeZoneName: 'short' }).formatToParts(resetDate)
    .find(p => p.type === 'timeZoneName')?.value || '';

  if (diffMs < 0) return `${timeStr} (${tz})`;
  if (diffMs < 24 * 60 * 60 * 1000) return `${timeStr} (${tz})`;

  // Include date for further out
  const month = resetDate.toLocaleString('en', { month: 'short' });
  const day = resetDate.getDate();
  return `${month} ${day} at ${timeStr} (${tz})`;
}

function mapBucket(apiUsage, apiKey, usageKey, usage) {
  try {
    const u = apiUsage[apiKey];
    if (!u || u.utilization === null || u.utilization === undefined) return;
    usage[usageKey] = Math.floor(u.utilization);
    if (u.resets_at) usage[usageKey + 'Reset'] = formatResetTime(u.resets_at);
  } catch (err) {
    log.warn('[claude-auth] Error mapping bucket', apiKey, err.message);
  }
}

function transformUsageResponse(apiUsage) {
  if (!apiUsage) return {};
  const usage = {};
  mapBucket(apiUsage, 'five_hour', 'session', usage);
  mapBucket(apiUsage, 'seven_day', 'weekAll', usage);
  mapBucket(apiUsage, 'seven_day_sonnet', 'weekSonnet', usage);
  mapBucket(apiUsage, 'seven_day_opus', 'weekOpus', usage);
  return usage;
}

// Test token validity using the lightweight /api/oauth/profile endpoint
async function testAuth() {
  const oauth = getOAuthToken();
  if (!oauth?.accessToken) {
    log.warn('[claude-auth] No OAuth token found');
    return { valid: false, error: 'no_token' };
  }
  log.info('[claude-auth] Token found, expires:', oauth.expiresAt);
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
      headers: {
        'Authorization': `Bearer ${oauth.accessToken}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    log.info('[claude-auth] Profile API status:', res.status);
    if (res.ok) {
      const data = await res.json();
      log.info('[claude-auth] Profile API success:', JSON.stringify(data).substring(0, 200));
      return { valid: true, profile: data };
    }
    const body = await res.text().catch(() => '');
    log.warn('[claude-auth] Profile API error:', res.status, body.substring(0, 200));
    return { valid: false, error: `${res.status} ${res.statusText}`, body };
  } catch (err) {
    log.error('[claude-auth] Profile API exception:', err.message);
    return { valid: false, error: err.message };
  }
}

async function fetchUsage() {
  const oauth = getOAuthToken();
  if (!oauth?.accessToken) {
    log.warn('[claude-auth] No OAuth token found');
    return null;
  }
  log.info('[claude-auth] Token found, expires:', oauth.expiresAt);

  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      'Authorization': `Bearer ${oauth.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'claude-code/2.1.74',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
    return { _rateLimited: true, retryAfterSeconds: retryAfter };
  }

  if (!res.ok) {
    log.warn('[claude-auth] Usage API error:', res.status, res.statusText);
    return null;
  }
  const json = await res.json();
  log.info('[claude-auth] Usage API success, keys:', Object.keys(json));
  log.info('[claude-auth] Usage API raw:', JSON.stringify(json, null, 2));
  return json;
}

async function fetchAndTransformUsage() {
  try {
    const raw = await fetchUsage();
    if (raw === null) {
      return { _error: true, message: 'Could not fetch usage (no token or API error)' };
    }
    if (raw?._rateLimited) {
      return { _rateLimited: true, retryAfterSeconds: raw.retryAfterSeconds };
    }
    const transformed = transformUsageResponse(raw);
    log.info('[claude-auth] Transformed usage:', JSON.stringify(transformed));
    return transformed;
  } catch (err) {
    log.error('[claude-auth] fetchAndTransformUsage error:', err.message);
    return { _error: true, message: err.message };
  }
}

module.exports = { getOAuthToken, fetchUsage, fetchAndTransformUsage, testAuth, getConfigDir };
