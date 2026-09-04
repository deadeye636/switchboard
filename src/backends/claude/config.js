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

// The one writer for a file a CLI also owns (CLAUDE.md rule 11). It is the only module under `src/app`
// that a backend pulls in, and it is safe to: it takes no ctx, requires nothing but `fs`/`path`, and its
// own test drives it under `node --test`. Rebuilding the baseline compare and the atomic rename here
// instead would be the second copy of exactly the code that rule exists to keep singular.
//
// Spelling that directory with a glob would be a bug, not a typo: the source guards strip block comments
// first, so a `/**` inside a line comment opens one and swallows the code beneath it until the next `*/`.
// It cost a green `test/store-isolation.test.js` on a file whose home resolution it had stopped reading.
const { writeTextFile } = require('../../app/safe-write');

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

// How many times a write may be re-derived on a document that moved under it. Three, because the losing
// side of this race is a human clicking once while a CLI writes on its own schedule — a second collision
// on the retry is unlucky, a third is a file being rewritten continuously and worth reporting rather than
// spinning on.
const WRITE_ATTEMPTS = 3;

/**
 * A short pause before re-deriving, so three attempts are three tries and not three collisions with one
 * write burst.
 *
 * One whole read-modify-write of this file costs ~19 ms measured, so a retry that starts immediately lands
 * inside the same burst that refused the first one. A few milliseconds of jitter is enough to fall out of
 * step with it. Synchronous, because everything around it is: an async pause here would let a second edit
 * start inside the gap this exists to survive — the same argument `safe-write.js` makes for its own wait.
 */
function pauseBeforeRetry(random = Math.random) {
  const until = Date.now() + 5 + Math.floor(random() * 15);
  while (Date.now() < until) { /* wait */ }
}

// Shared read→parse→mutate→(.bak)→atomic-write core of the three write helpers below (#79).
//
// **Why writing the whole document is not enough** (#533). Every helper here changes ONE field of one
// project, but the unit that reaches the disk is the entire ~160 KB file, rebuilt from what we parsed. So
// anything the CLI stored between our read and our write — a trust answer, an MCP server, the running
// session's cost — is not merged and not overwritten by a conflicting value: it is simply absent from the
// document we hand back, and disappears. Claude Code 2.1.259 fixed exactly that between two of its own
// sessions; we are the other party in the same race, and no amount of atomicity in the write helps,
// because the bytes were already wrong before the rename.
//
// What fixes it is the baseline: `writeTextFile` refuses when the file no longer holds the text we parsed,
// and a refusal is not a failure here — the mutation is re-derived against the document that IS on disk
// and written again.
//
// **It narrows the window; it does not close it.** What is left is safe-write's own read-to-rename gap:
// measured at 5–11 ms on a 175 KB config, against the far wider one this replaces (read, parse, mutate,
// stringify and the `.bak` copy, all before the old rename). And it can be much wider in the one case this
// paragraph is about — `renameWithRetry` busy-waits up to ~210 ms on EPERM/EBUSY, which is the error
// Windows raises precisely when another process is holding the file. A writer that lands in that gap still
// wins, and nothing here pretends otherwise; closing it would take a lock the CLI has no reason to honour.
//
// `mutate(cfg)` edits the parsed config in place and returns { result }; returning { skipWrite: true,
// result } short-circuits without touching the file (no-op cases keep today's behavior of not writing a
// backup either). It runs once per attempt, so it must read what it needs off `cfg` rather than close over
// anything it read the first time round.
function mutateClaudeConfig(configPath, mutate) {
  let backedUp = false;
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
    if (attempt > 1) pauseBeforeRetry();
    let raw;
    try {
      raw = fs.readFileSync(configPath, 'utf8');
    } catch (err) {
      // The errno spells out the absolute path; the file's well-known name says more to a reader (#457).
      return { error: `Cannot read ~/.claude.json (${err && err.code ? err.code : 'unknown error'}).` };
    }
    let cfg;
    try {
      cfg = JSON.parse(raw);
    } catch (err) {
      return { error: 'Cannot parse ~/.claude.json: it is not valid JSON.' };
    }

    const outcome = mutate(cfg);
    if (outcome.skipWrite) return outcome.result;

    if (!backedUp) {
      try {
        // Backup of the last good state before overwriting — once per call, not once per attempt. A
        // retry's copy would only overwrite it with the interloper's newer version, and a `.bak` that
        // tracks the file it is meant to be a fallback FOR is not a fallback.
        fs.copyFileSync(configPath, configPath + '.bak');
        backedUp = true;
      } catch (err) {
        return { error: `Cannot write ~/.claude.json (${err && err.code ? err.code : 'unknown error'}).` };
      }
    }

    const res = writeTextFile(configPath, JSON.stringify(cfg, null, 2), { expectPrevious: raw, mustExist: true });
    if (res.ok) return outcome.result;
    if (res.code === 'stale') continue;                  // the CLI wrote first: re-derive against what it left
    if (res.code === 'missing') return { error: 'Cannot write ~/.claude.json (it is no longer there).' };
    return { error: `Cannot write ~/.claude.json (${res.cause && res.cause.code ? res.cause.code : 'unknown error'}).` };
  }
  return { error: 'Cannot write ~/.claude.json: another program kept changing it. Try again.' };
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
  // Test-only: the retry against a concurrent writer is the whole point of #533, and the only way to stage
  // one is to write the file from inside a mutation.
  _mutateClaudeConfig: mutateClaudeConfig,
  _WRITE_ATTEMPTS: WRITE_ATTEMPTS,
};
