// Safe read/modify/write access to Claude Code's main config `~/.claude.json`.
//
// This file is large (~160 KB) and holds SECRETS (oauthAccount, userID, machineID,
// token/feature caches). We NEVER dump or log it. We only ever touch the single
// per-project field `hasTrustDialogAccepted` (the trust gate), preserving every other
// key/value 1:1 and writing atomically (temp file + rename) with a `.bak` safety copy.
//
// Consumed by the Projects-admin IPC (#32).

const fs = require('fs');
const os = require('os');
const path = require('path');

// WHERE that file is depends on which home the CLI is using (#241). Normally `~/.claude.json`, a sibling
// of `~/.claude`. Under an isolated (demo/sandbox) run, SWITCHBOARD_STORE_CLAUDE names the projects dir
// and the CLI's home is its parent — and a CLI started with CLAUDE_CONFIG_DIR keeps its config INSIDE
// that home, as `<home>/.claude.json`. Measured on a real demo launch, not assumed.
//
// Getting this wrong is not cosmetic: the Projects admin read the user's REAL project list inside a demo
// instance (52 of their projects, in a window that promises it touches nothing real), and Remove-entry
// would have WRITTEN to their real config from there.
//
// Resolved per call, not at load: the env var is set before boot, but a test may point it anywhere.
function claudeConfigPath() {
  const store = process.env.SWITCHBOARD_STORE_CLAUDE;
  return store
    ? path.join(path.dirname(store), '.claude.json')
    : path.join(os.homedir(), '.claude.json');
}

// Normalize a filesystem path to a stable key for matching between Switchboard's
// `projectPath` (may use backslashes on Windows) and `~/.claude.json` `projects`
// keys (forward-slashes). Strips trailing slashes; lowercases the drive letter, and
// on Windows the whole path (case-insensitive FS) so casing differences still match.
function normalizeClaudePath(p) {
  if (!p) return '';
  let s = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[a-zA-Z]:/.test(s)) s = s[0].toLowerCase() + s.slice(1);
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
}

// Parse `~/.claude.json`. Returns the parsed object, or null if missing/unreadable.
// Callers must treat the result as containing secrets. `configPath` is overridable
// for tests only; production callers use the default.
function readClaudeConfig(configPath = claudeConfigPath()) {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Map normalizedPath -> boolean (hasTrustDialogAccepted) for every project entry.
// `preloadedCfg` (optional) lets callers that need several derived views pass an
// already-parsed config instead of re-reading the ~160 KB file per helper.
function getProjectTrustMap(configPath = claudeConfigPath(), preloadedCfg = undefined) {
  const map = new Map();
  const cfg = preloadedCfg !== undefined ? preloadedCfg : readClaudeConfig(configPath);
  if (!cfg || !cfg.projects || typeof cfg.projects !== 'object') return map;
  for (const [key, val] of Object.entries(cfg.projects)) {
    map.set(normalizeClaudePath(key), !!(val && val.hasTrustDialogAccepted));
  }
  return map;
}

// Extra read-only per-project meta (MCP count, allowedTools count, last cost, tokens),
// keyed by normalizedPath. Never includes secrets — only the aggregated counts/values.
function getProjectClaudeMeta(configPath = claudeConfigPath(), preloadedCfg = undefined) {
  const map = new Map();
  const cfg = preloadedCfg !== undefined ? preloadedCfg : readClaudeConfig(configPath);
  if (!cfg || !cfg.projects || typeof cfg.projects !== 'object') return map;
  for (const [key, val] of Object.entries(cfg.projects)) {
    if (!val || typeof val !== 'object') continue;
    map.set(normalizeClaudePath(key), {
      mcpServersCount: val.mcpServers && typeof val.mcpServers === 'object' ? Object.keys(val.mcpServers).length : 0,
      allowedToolsCount: Array.isArray(val.allowedTools) ? val.allowedTools.length : 0,
      lastCost: typeof val.lastCost === 'number' ? val.lastCost : null,
      inputTokens: typeof val.lastTotalInputTokens === 'number' ? val.lastTotalInputTokens : null,
      outputTokens: typeof val.lastTotalOutputTokens === 'number' ? val.lastTotalOutputTokens : null,
    });
  }
  return map;
}

// Shared read→parse→mutate→(.bak)→tmp→rename core of the three write helpers
// below (#79). Reads the config fresh immediately before writing (last-writer-
// wins vs. a concurrently running Claude is accepted). `mutate(cfg)` edits the
// parsed config in place and returns { result }; returning { skipWrite: true,
// result } short-circuits without touching the file (no-op cases keep today's
// behavior of not writing a backup either).
function mutateClaudeConfig(configPath, mutate) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    return { error: 'Cannot read ~/.claude.json: ' + err.message };
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    return { error: 'Cannot parse ~/.claude.json: ' + err.message };
  }

  const outcome = mutate(cfg);
  if (outcome.skipWrite) return outcome.result;

  try {
    // One-time-ish backup of the last good state before overwriting.
    fs.copyFileSync(configPath, configPath + '.bak');
    const tmp = configPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, configPath);
    return outcome.result;
  } catch (err) {
    return { error: 'Cannot write ~/.claude.json: ' + err.message };
  }
}

// Atomically set `hasTrustDialogAccepted` for one project. Changes ONLY the one
// field, writes temp + rename, keeps a `.bak` copy. Returns { ok } or { error }.
function setProjectTrust(projectPath, trusted, configPath = claudeConfigPath()) {
  if (!projectPath) return { error: 'No project path' };
  return mutateClaudeConfig(configPath, (cfg) => {
    if (!cfg.projects || typeof cfg.projects !== 'object') cfg.projects = {};
    // Find the existing key that normalizes to our target (preserve its exact form).
    const target = normalizeClaudePath(projectPath);
    let key = Object.keys(cfg.projects).find(k => normalizeClaudePath(k) === target);
    if (!key) {
      // No entry yet: create a minimal one under the forward-slash form Claude uses.
      key = String(projectPath).replace(/\\/g, '/');
      cfg.projects[key] = {};
    }
    cfg.projects[key].hasTrustDialogAccepted = !!trusted;
    return { result: { ok: true, trusted: !!trusted } };
  });
}

// Atomically delete a project's entry from `~/.claude.json` `projects` (trust, MCP,
// allowedTools, cost — the whole per-project block). Removes every key that normalizes
// to the target (guards against duplicate slash/case variants). Writes temp + rename
// with a `.bak` copy; leaves all other keys/secrets untouched. Returns { ok, removed }.
function removeProjectEntry(projectPath, configPath = claudeConfigPath()) {
  if (!projectPath) return { error: 'No project path' };
  return mutateClaudeConfig(configPath, (cfg) => {
    if (!cfg.projects || typeof cfg.projects !== 'object') return { skipWrite: true, result: { ok: true, removed: 0 } };
    const target = normalizeClaudePath(projectPath);
    const keys = Object.keys(cfg.projects).filter(k => normalizeClaudePath(k) === target);
    if (!keys.length) return { skipWrite: true, result: { ok: true, removed: 0 } };
    for (const k of keys) delete cfg.projects[k];
    return { result: { ok: true, removed: keys.length } };
  });
}

// Atomically move a project's `~/.claude.json` entry from oldPath to newPath, so its
// trust/MCP/allowedTools/cost survive a remap. If the source key is absent, no-op
// (moved:false). If the target key already exists, the source block is merged over it
// (source values win for overlapping fields, target's other fields are kept). Writes
// temp + rename with a `.bak`. Returns { ok, moved }.
function renameProjectEntry(oldPath, newPath, configPath = claudeConfigPath()) {
  if (!oldPath || !newPath) return { error: 'Missing path' };
  return mutateClaudeConfig(configPath, (cfg) => {
    if (!cfg.projects || typeof cfg.projects !== 'object') return { skipWrite: true, result: { ok: true, moved: false } };

    const srcNorm = normalizeClaudePath(oldPath);
    const srcKey = Object.keys(cfg.projects).find(k => normalizeClaudePath(k) === srcNorm);
    if (!srcKey) return { skipWrite: true, result: { ok: true, moved: false } };

    const srcVal = cfg.projects[srcKey];
    const dstNorm = normalizeClaudePath(newPath);
    const existingDstKey = Object.keys(cfg.projects).find(k => normalizeClaudePath(k) === dstNorm);
    const dstKey = existingDstKey || String(newPath).replace(/\\/g, '/');
    cfg.projects[dstKey] = existingDstKey ? { ...cfg.projects[existingDstKey], ...srcVal } : srcVal;
    if (dstKey !== srcKey) delete cfg.projects[srcKey];
    return { result: { ok: true, moved: true } };
  });
}

module.exports = {
  claudeConfigPath,
  normalizeClaudePath,
  readClaudeConfig,
  getProjectTrustMap,
  getProjectClaudeMeta,
  setProjectTrust,
  removeProjectEntry,
  renameProjectEntry,
};
