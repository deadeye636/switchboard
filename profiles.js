// profiles.js — user-defined Axis-A backends ("profiles"): CRUD over <userData>/profiles.json.
//
// A profile is DATA: name + icon + an env bundle (00 §3, 10-phase-1 key decision). It runs the same
// `claude` binary against an alternative endpoint — no per-provider code. Built-ins ∪ profiles form
// the unified backends.list() (T-2.1 wires that in backends/index.js). Persistence is a JSON file
// (kept OUT of the FTS5 DB deliberately); atomic write, re-validate on load, cap 32.
//
// Secret hygiene (invariant §5.2, stricter than ivandobsky): auth is a `$VAR` ref resolved at spawn.
// On save we BLOCK a value that looks like a pasted raw high-entropy key (T-2.4) unless the caller
// explicitly acknowledges — a public repo must never persist a literal secret to disk.
'use strict';

const fs = require('fs');
const path = require('path');
const { resolveEnv } = require('./env-refs');

const MAX_PROFILES = 32;
const MAX_ENV_KEYS = 64;
const MAX_VALUE_LEN = 4096;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

let _filePath = null;
let state = null; // { profiles: [...], defaultProfileId }
let loaded = false;

function resolveFilePath() {
  if (_filePath) return _filePath;
  const { app } = require('electron');
  _filePath = path.join(app.getPath('userData'), 'profiles.json');
  return _filePath;
}

// Built-in backend ids a user profile must never shadow. A profile with id 'claude' would appear
// twice in backends.list() (built-in + profile) and corrupt every list keyed on id. The renderer's
// slug generator avoids this, but the IPC handler is the real trust boundary — enforce it here.
const RESERVED_IDS = new Set(['claude', 'codex', 'gemini', 'hermes', 'pi']);

// An env var whose NAME says "credential". Such a var must be a `$VAR` reference (or the empty
// string, used to blank an inherited one) — any literal is a secret written to disk (§5.2). Being
// name-driven catches the shapes a generic entropy heuristic misses: JWTs (dots), AWS keys
// (slashes), and short keys.
const AUTHY_KEY_RE = /(^|_)(API_KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|AUTH)(_|$)/i;

/**
 * Does this env value look like a pasted raw secret? Used to BLOCK secrets on save (T-2.4).
 *
 * Two tiers, because one entropy heuristic cannot serve both cases without false positives:
 *  - An AUTH-NAMED var (`*_API_KEY`, `*_TOKEN`, …): any literal at all is a secret. Only `$VAR` and
 *    `""` are legitimate. This is the tier that matters — it is where credentials actually go.
 *  - Any other var: a conservative shape check, so a legitimate model id ("anthropic/claude-sonnet-4.6")
 *    or a base URL is never rejected, while an obvious token pasted into the wrong row still is.
 */
function looksLikeRawSecret(value, key) {
  if (typeof value !== 'string' || value === '') return false;  // "" = the deliberate blank
  if (value.startsWith('$')) return false;                      // a $VAR / ${VAR} reference

  // Tier 1: the variable NAME says credential -> a literal is a secret, whatever it looks like.
  if (key && AUTHY_KEY_RE.test(key)) return true;

  // Tier 2: a value in a non-auth var that still looks like a credential.
  if (/\s/.test(value)) return false;                           // prose
  if (/^https?:\/\//i.test(value)) return false;                // endpoint URLs
  if (/^\d+$/.test(value)) return false;                        // plain numbers (timeouts)
  if (/^[{[]/.test(value)) {                                    // JSON blobs (CLAUDE_CODE_EXTRA_BODY)
    try { JSON.parse(value); return false; } catch { /* not JSON -> keep checking */ }
  }
  // Well-known credential prefixes — a key is a key regardless of length or punctuation.
  if (/^(sk-|sk_|pk_|rk_|ghp_|gho_|ghu_|ghs_|github_pat_|xox[baprs]-|AKIA|ASIA|AIza|glpat-|hf_)/i.test(value)) return true;
  // JWT: three base64url segments.
  if (/^[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}$/.test(value)) return true;
  // A long opaque mixed-alphanumeric run. `/` and `.` are NOT run characters, so a model id like
  // "meta-llama/llama-3.1-405b-instruct" splits into short runs and is never flagged.
  for (const run of value.split(/[^A-Za-z0-9_+-]/)) {
    if (run.length >= 20 && /[A-Za-z]/.test(run) && /\d/.test(run)) return true;
  }
  return false;
}

/**
 * Axis-A host-key-leak lint (01-providers "Axis-A known failure modes"). The structured Model field
 * gets this right, but the raw "Advanced" env editor lets a user hand-build a profile that points at
 * a third-party endpoint while STILL inheriting the host ANTHROPIC_API_KEY and/or leaving the
 * haiku/background model pointed at Anthropic. Both send the user's real Anthropic key to a third
 * party. That is a security bug, not a preference — so it is a hard block, not a confirmable warning.
 * Returns an error string, or null when the bundle is safe.
 */
function checkEndpointLeak(env) {
  if (!env.ANTHROPIC_BASE_URL) return null;  // no endpoint redirect -> plain Claude, nothing to leak
  if (env.ANTHROPIC_API_KEY !== '') {
    return 'this profile points at an alternative endpoint but does not blank ANTHROPIC_API_KEY — '
      + 'set ANTHROPIC_API_KEY to an empty value, or your host Anthropic key is sent to that endpoint';
  }
  if (env.ANTHROPIC_MODEL && !env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    return 'this profile redirects the main model but not the fast/haiku model — background calls '
      + 'would still go to Anthropic (and fail). Set ANTHROPIC_DEFAULT_HAIKU_MODEL too';
  }
  return null;
}

// Validate a profile. Returns { ok:true, profile } or { ok:false, error }.
// `opts.allowSecrets` skips the raw-key block (an explicit user "I know" confirm).
function validateProfile(input, opts = {}) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'profile must be an object' };
  const id = input.id;
  const name = input.name;
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: 'invalid id (need /^[A-Za-z0-9_-]{1,64}$/)' };
  // A profile must not shadow a built-in backend id (enforced here, at the IPC trust boundary — the
  // renderer's slug generator is a convenience, not a guarantee).
  if (RESERVED_IDS.has(id)) return { ok: false, error: `'${id}' is a built-in backend id — pick another` };
  if (typeof name !== 'string' || name.length < 1 || name.length > 100) return { ok: false, error: 'name must be 1..100 chars' };
  const env = input.env;
  if (env == null || typeof env !== 'object') return { ok: false, error: 'env must be an object' };
  const keys = Object.keys(env);
  if (keys.length > MAX_ENV_KEYS) return { ok: false, error: `too many env keys (max ${MAX_ENV_KEYS})` };
  const cleanEnv = {};
  const secretKeys = [];
  for (const k of keys) {
    if (!ENV_KEY_RE.test(k)) return { ok: false, error: `invalid env key: ${k}` };
    const v = env[k];
    if (typeof v !== 'string') return { ok: false, error: `env value for ${k} must be a string` };
    if (v.length > MAX_VALUE_LEN) return { ok: false, error: `env value for ${k} too long` };
    if (!opts.allowSecrets && looksLikeRawSecret(v, k)) secretKeys.push(k);
    cleanEnv[k] = v;
  }
  if (secretKeys.length) {
    return { ok: false, error: `looks like a raw secret in: ${secretKeys.join(', ')} — use a $VAR reference instead`, secretKeys };
  }
  // Host-key-leak lint. Deliberately NOT bypassable by `allowSecrets`: acknowledging "yes, that's my
  // key" is a different decision from "yes, send my Anthropic key to a third party". Skipped only on
  // LOAD (skipLeakCheck) — a pre-existing profile must not silently vanish from the list.
  if (!opts.skipLeakCheck) {
    const leak = checkEndpointLeak(cleanEnv);
    if (leak) return { ok: false, error: leak, leak: true };
  }

  const profile = { id, name, env: cleanEnv };
  if (typeof input.icon === 'string' && input.icon) profile.icon = input.icon.slice(0, 64);
  return { ok: true, profile };
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  state = { profiles: [], defaultProfileId: null };
  let raw;
  try { raw = fs.readFileSync(resolveFilePath(), 'utf8'); } catch { return; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return; }
  if (!parsed || !Array.isArray(parsed.profiles)) return;
  const seen = new Set();
  for (const p of parsed.profiles) {
    // Don't drop an EXISTING profile over the heuristics — validate structure only.
    const v = validateProfile(p, { allowSecrets: true, skipLeakCheck: true });
    if (v.ok && !seen.has(v.profile.id)) { state.profiles.push(v.profile); seen.add(v.profile.id); }
    if (state.profiles.length >= MAX_PROFILES) break;
  }
  if (typeof parsed.defaultProfileId === 'string' && seen.has(parsed.defaultProfileId)) {
    state.defaultProfileId = parsed.defaultProfileId;
  }
}

function flush() {
  const file = resolveFilePath();
  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ profiles: state.profiles, defaultProfileId: state.defaultProfileId }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function list() {
  ensureLoaded();
  return state.profiles.map(p => ({ ...p, env: { ...p.env } }));
}

function get(id) {
  ensureLoaded();
  const p = state.profiles.find(x => x.id === id);
  return p ? { ...p, env: { ...p.env } } : null;
}

// Create or update a profile. Returns { ok, profile } | { ok:false, error }.
function save(input, opts = {}) {
  ensureLoaded();
  const v = validateProfile(input, opts);
  if (!v.ok) return v;
  const i = state.profiles.findIndex(p => p.id === v.profile.id);
  if (i >= 0) {
    state.profiles[i] = v.profile;
  } else {
    if (state.profiles.length >= MAX_PROFILES) return { ok: false, error: `profile cap reached (max ${MAX_PROFILES})` };
    state.profiles.push(v.profile);
  }
  flush();
  return { ok: true, profile: { ...v.profile, env: { ...v.profile.env } } };
}

function remove(id) {
  ensureLoaded();
  const i = state.profiles.findIndex(p => p.id === id);
  if (i < 0) return { ok: false, error: 'not found' };
  state.profiles.splice(i, 1);
  if (state.defaultProfileId === id) state.defaultProfileId = null;
  flush();
  return { ok: true };
}

function getDefault() {
  ensureLoaded();
  return state.defaultProfileId;
}

function setDefault(id) {
  ensureLoaded();
  if (id != null && !state.profiles.some(p => p.id === id)) return { ok: false, error: 'unknown profile' };
  state.defaultProfileId = id == null ? null : id;
  flush();
  return { ok: true };
}

// Resolve which profile applies to a session launch (ivandobsky 3-state):
//   'none'      -> null (explicit pass-through)
//   a real id   -> that profile
//   undefined   -> the global default profile (or null if none)
function pickProfileForSession(profileId) {
  ensureLoaded();
  if (profileId === 'none') return null;
  if (typeof profileId === 'string' && profileId) return get(profileId);
  return state.defaultProfileId ? get(state.defaultProfileId) : null;
}

// The spawn-time resolved env bundle for a profile ($VAR resolved, unresolved dropped).
function resolveEnvForProfile(profileId) {
  const p = pickProfileForSession(profileId);
  return p ? resolveEnv(p.env) : {};
}

function _configureForTests({ filePath } = {}) {
  _filePath = filePath || null;
  state = null; loaded = false;
}

module.exports = {
  list, get, save, remove, getDefault, setDefault,
  pickProfileForSession, resolveEnvForProfile,
  validateProfile, looksLikeRawSecret, checkEndpointLeak,
  MAX_PROFILES, RESERVED_IDS,
  _configureForTests,
};
