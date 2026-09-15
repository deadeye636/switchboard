// Safe read/modify/write access to Claude Code's main config `~/.claude.json`.
//
// This file is large (~160 KB) and holds SECRETS (oauthAccount, userID, machineID,
// token/feature caches). We NEVER dump or log it. We only ever touch the `projects` table —
// one project's `hasTrustDialogAccepted` (the trust gate), or one project's whole block on a
// rename or remove — preserving every other key/value 1:1 and writing atomically (temp file +
// rename) with a `.bak` safety copy.
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
// That folds every spelling of a directory into one — right for the info columns and for
// rename/remove, which describe or clean up all of them. The CLI does NOT look trust up this
// way; trust goes through `cliProjectKey` below (#627).
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

/**
 * The `projects` key the CLI itself reads and writes TRUST under for a session started in `projectPath`
 * (#627). Not `normalizeClaudePath`: that one folds every spelling of a directory together, which is right
 * for the info columns and for cleaning up, and wrong for trust, because the CLI looks one key up exactly.
 *
 * Measured on Claude Code 2.1.272 on Windows, interactive sessions against an isolated home:
 *   - inside a git repository the key is the repository's ROOT, not the directory — a subdirectory's
 *     session wrote the root, a worktree's session found the MAIN repository's root already trusted, and a
 *     worktree of a bare repository wrote the bare repository's directory. A submodule keys itself;
 *   - outside one it is the directory itself;
 *   - either way the path is real — a junction resolved, every folder name in its on-disk case — with the
 *     drive letter as it was spelled and forward slashes. A lower-case drive letter wrote a lower-case key,
 *     and a later session spelled with an upper-case one got the trust dialog again;
 *   - a `subst` or mapped drive is NOT resolved to what it stands for: the key keeps that drive letter. A
 *     UNC path stays a UNC path, and a junction to another drive is keyed on that other drive.
 * `fs.realpathSync.native` resolves drives the CLI keeps, so its answer is re-expressed under the spelled
 * drive where that drive is a substitute. How the key is LOOKED UP is `describeProjectTrust` below.
 *
 * Only Windows was measured, so elsewhere the key stays the path as spelled, which is what this module did
 * before. A directory that does not exist is keyed as spelled too: there is nothing to resolve.
 */
function cliProjectKey(projectPath) {
  return resolveTrustGate(projectPath).key;
}

// `{ key, dirKey, inRepo }` for one path: the trust key, the directory's own key, and whether a repository
// decided the key. Fresh from the filesystem on every call.
function resolveTrustGate(projectPath) {
  const spelled = String(projectPath || '');
  const asSpelled = () => { const k = spelled ? keyFromRealPath(spelled, spelled) : ''; return { key: k, dirKey: k, inRepo: false }; };
  if (!spelled || process.platform !== 'win32') return asSpelled();
  let real;
  try { real = fs.realpathSync.native(spelled); } catch { return asSpelled(); }
  const driveRoot = substituteDriveRoot(spelled);
  const dirKey = keyFromRealPath(real, spelled, driveRoot);
  const root = gitTrustRoot(real, driveRoot);
  if (!root) return { key: dirKey, dirKey, inRepo: false };
  let rootReal = root;
  if (root !== real) { try { rootReal = fs.realpathSync.native(root); } catch { /* as found */ } }
  return { key: keyFromRealPath(rootReal, spelled, driveRoot), dirKey, inRepo: true };
}

// The same answer, held for a few seconds (#627). The Projects manager asks it for every row it builds, and
// each answer is a realpath, a stat per ancestor on the way to a `.git`, and a realpath of the drive root:
// measured over 200 project directories, a third of them repositories, 158–166 ms cold and 0.3 ms held.
// Only what the manager SHOWS uses it: every write resolves its key fresh, and a remap's decision whether to
// move trust at all asks fresh too (`describeProjectTrust(..., { fresh: true })`). So a `git init` or a moved
// folder can make the manager show an old answer for one TTL, and never write or decide on one.
const TRUST_GATE_TTL_MS = 5000;
const _trustGateCache = new Map();   // spelled path -> { at, gate }
function resolveTrustGateCached(projectPath, now = Date.now()) {
  const hit = _trustGateCache.get(projectPath);
  if (hit && now - hit.at < TRUST_GATE_TTL_MS) return hit.gate;
  const gate = resolveTrustGate(projectPath);
  if (_trustGateCache.size >= 2000) {
    for (const [p, e] of _trustGateCache) if (now - e.at >= TRUST_GATE_TTL_MS) _trustGateCache.delete(p);
  }
  _trustGateCache.set(projectPath, { at: now, gate });
  return gate;
}

/**
 * The key of the directory ITSELF, spelled the way the CLI spells keys — the same real path and drive rules as
 * `cliProjectKey`, without climbing to a repository root. What a project's own block in `.claude.json` is
 * filed under when it is moved (#627): a block moved onto a repository's root would merge over that
 * repository's MCP servers and allowed tools, and the project's own info columns would no longer find it.
 */
function cliDirKey(projectPath) {
  const spelled = String(projectPath || '');
  if (!spelled) return '';
  if (process.platform !== 'win32') return keyFromRealPath(spelled, spelled);
  let real;
  try { real = fs.realpathSync.native(spelled); } catch { return keyFromRealPath(spelled, spelled); }
  return keyFromRealPath(real, spelled, substituteDriveRoot(spelled));
}

// What a spelled drive letter stands for, when it is a substitute: the real path of that drive's root for a
// `subst` or a mapped drive, and null for a drive whose root resolves to itself.
function substituteDriveRoot(spelled) {
  const drive = /^([a-zA-Z]):/.exec(spelled);
  if (!drive) return null;
  try {
    const rootReal = fs.realpathSync.native(drive[1] + ':\\');
    return rootReal.replace(/[\\/]+$/, '').toLowerCase() === (drive[1] + ':').toLowerCase() ? null : rootReal;
  } catch { return null; }
}

// The repository a directory belongs to, as the CLI keys trust by it: walk up to the first `.git`. A directory
// there is the root. A FILE there is a worktree (or a submodule) naming its git dir; a worktree's git dir names
// the common one in `commondir`. When that is a `.git` directory the main repository is its parent; otherwise
// it is a bare repository, and the bare repository's directory is the key (measured). A `.git` file without
// `commondir` — a submodule — keys its own directory (measured). The walk does not climb above the root of a
// substitute drive (`stopAt`): measured, a `subst` drive over a repository's subfolder keyed that drive's root.
// Null outside any repository. Reads files, runs no git.
function gitTrustRoot(dir, stopAt = null) {
  const stop = stopAt ? String(stopAt).replace(/[\\/]+$/, '').toLowerCase() : null;
  let cur = dir;
  for (;;) {
    const dotGit = path.join(cur, '.git');
    let stat = null;
    try { stat = fs.statSync(dotGit); } catch { /* keep walking */ }
    if (stat) {
      if (stat.isDirectory()) return cur;
      try {
        const named = /^gitdir:[ \t]*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
        if (named) {
          const gitDir = path.resolve(cur, named[1].trim());
          const commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
          return path.basename(commonDir).toLowerCase() === '.git' ? path.dirname(commonDir) : commonDir;
        }
      } catch { /* not a worktree */ }
      return cur;
    }
    if (stop && cur.replace(/[\\/]+$/, '').toLowerCase() === stop) return null;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// The pure half of `cliProjectKey`, apart so it can be tested on any platform.
//   `real`         the resolved path (a repository root, or the directory itself)
//   `spelled`      the path as the session's cwd spells it
//   `driveRoot`    what the spelled drive stands for when it is a `subst` or mapped drive, else null
// A path under a substitute drive's root is re-expressed under that drive letter, as the CLI keeps it. The
// drive letter goes back as spelled otherwise only when the resolved path is on the SAME drive: a junction to
// another drive is keyed on that drive, and pasting the spelled letter onto it would name nothing.
function keyFromRealPath(real, spelled, driveRoot = null) {
  let key = String(real).replace(/\\/g, '/');
  const spelledDrive = /^([a-zA-Z]):/.exec(String(spelled));
  if (spelledDrive && driveRoot) {
    const base = String(driveRoot).replace(/\\/g, '/').replace(/\/+$/, '');
    if (key.toLowerCase() === base.toLowerCase() || key.toLowerCase().startsWith(base.toLowerCase() + '/')) {
      key = spelledDrive[1] + ':' + (key.slice(base.length) || '/');
    }
  }
  const realDrive = /^([a-zA-Z]):/.exec(key);
  if (spelledDrive && realDrive && spelledDrive[1].toLowerCase() === realDrive[1].toLowerCase()) {
    key = spelledDrive[1] + key.slice(1);
  }
  if (key.length > 1) key = key.replace(/\/+$/, '');
  return /^[a-zA-Z]:$/.test(key) ? key + '/' : key;   // a drive root keeps its slash: `C:` alone means "the current folder on C:"
}

// The keys a directory's trust is inherited from, nearest first, up to and including the drive root (with its
// slash) or `/`. A UNC share root (`//host/share`) is the top; `//host` alone is not a directory.
function ancestorKeys(key) {
  const out = [];
  let cur = String(key);
  for (;;) {
    if (/^[a-zA-Z]:\/$/.test(cur) || /^\/\/[^/]+\/[^/]+$/.test(cur) || cur === '/') return out;
    const cut = cur.lastIndexOf('/');
    if (cut < 0) return out;
    let parent = cur.slice(0, cut);
    if (/^[a-zA-Z]:$/.test(parent)) parent += '/';
    else if (parent === '') parent = '/';
    if (/^\/\/[^/]*$/.test(parent)) return out;
    out.push(parent);
    cur = parent;
  }
}

/**
 * Where each path's trust stands as the CLI will read it (#627):
 *   `{ trusted, scope, gate }` — `trusted` true, false (an entry without the flag) or null (no entry);
 *   `scope` 'own' (the path's own key), 'shared' (a repository root the path only sits in: a subdirectory or
 *   a worktree, so every other checkout keyed there shares it) or 'inherited' (a trusted ancestor);
 *   `gate` the key that decides, as a path; and for an inherited answer `trustedAbove`, whether a folder
 *   further up is trusted as well — removing the nearest one then leaves the path trusted through that.
 *
 * Measured on 2.1.272 on Windows: outside a repository a trusted ANCESTOR trusts a directory, and an entry
 * of its own with `false` under it does not stop that; inside one only the root's own entry counts — a
 * repository inside a trusted folder, and a subfolder of that repository, both got the trust dialog. An
 * entry under another spelling of the same directory never counts. Elsewhere than Windows nothing is
 * inherited, as before. `preloadedCfg` (optional) saves re-reading the ~160 KB file.
 */
function describeProjectTrust(projectPaths, configPath = claudeConfigPath(), preloadedCfg = undefined, { fresh = false } = {}) {
  const out = new Map();
  const cfg = preloadedCfg !== undefined ? preloadedCfg : readClaudeConfig(configPath);
  const projects = cfg && cfg.projects && typeof cfg.projects === 'object' ? cfg.projects : {};
  const entryOf = (key) => (Object.prototype.hasOwnProperty.call(projects, key) ? projects[key] : null);
  const trustedKey = (key) => { const e = entryOf(key); return !!(e && e.hasTrustDialogAccepted); };
  const now = Date.now();
  for (const p of projectPaths) {
    const gate = fresh ? resolveTrustGate(p) : resolveTrustGateCached(p, now);
    const scope = gate.key === gate.dirKey ? 'own' : 'shared';
    const own = entryOf(gate.key);
    if (own && own.hasTrustDialogAccepted) { out.set(p, { trusted: true, scope, gate: gate.key }); continue; }
    const trustedAncestors = !gate.inRepo && process.platform === 'win32' ? ancestorKeys(gate.key).filter(trustedKey) : [];
    out.set(p, trustedAncestors.length
      ? { trusted: true, scope: 'inherited', gate: trustedAncestors[0], trustedAbove: trustedAncestors.length > 1 }
      : { trusted: own ? false : null, scope, gate: gate.key });
  }
  return out;
}

// Map projectPath -> true / false / null, as `describeProjectTrust` answers it.
function getProjectTrust(projectPaths, configPath = claudeConfigPath(), preloadedCfg = undefined) {
  const out = new Map();
  for (const [p, d] of describeProjectTrust(projectPaths, configPath, preloadedCfg)) out.set(p, d.trusted);
  return out;
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
    // The key the CLI reads (#627). An entry under another spelling is left alone: the CLI never reads it,
    // and it may still carry that spelling's MCP servers or cost.
    const key = cliProjectKey(projectPath);
    if (!cfg.projects[key] || typeof cfg.projects[key] !== 'object') cfg.projects[key] = {};
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
    // The target's OWN key as the CLI spells keys (#627) — never a repository root the target sits in: moving
    // the block onto the root would merge over the root's own MCP servers, allowed tools and trust. Outside a
    // repository this is also the key the CLI reads trust under. Then an entry under another spelling of the
    // target, as before.
    // The SOURCE is still the first spelling that folds to the old path, because after a remap the old
    // directory is usually gone and its CLI key cannot be resolved. With several spellings of the old path,
    // the one moved may not be the one that carried trust, and the project then asks for trust again —
    // the safe direction, never trust the user did not give.
    const cliKey = cliDirKey(newPath);
    const existingDstKey = Object.prototype.hasOwnProperty.call(cfg.projects, cliKey)
      ? cliKey
      : Object.keys(cfg.projects).find(k => normalizeClaudePath(k) === dstNorm);
    const dstKey = existingDstKey || cliKey;
    cfg.projects[dstKey] = existingDstKey ? { ...cfg.projects[existingDstKey], ...srcVal } : srcVal;
    if (dstKey !== srcKey) delete cfg.projects[srcKey];
    return { result: { ok: true, moved: true } };
  });
}

module.exports = {
  claudeConfigPath,
  normalizeClaudePath,
  cliProjectKey,
  cliDirKey,
  readClaudeConfig,
  getProjectTrust,
  describeProjectTrust,
  getProjectClaudeMeta,
  setProjectTrust,
  removeProjectEntry,
  renameProjectEntry,
  // Test-only: the retry against a concurrent writer is the whole point of #533, and the only way to stage
  // one is to write the file from inside a mutation.
  _mutateClaudeConfig: mutateClaudeConfig,
  // Test-only: the drive-letter rule of `cliProjectKey` without a filesystem behind it (#627).
  _keyFromRealPath: keyFromRealPath,
  _gitTrustRoot: gitTrustRoot,
  _ancestorKeys: ancestorKeys,
  _resetTrustGateCache: () => _trustGateCache.clear(),
  _WRITE_ATTEMPTS: WRITE_ATTEMPTS,
};
