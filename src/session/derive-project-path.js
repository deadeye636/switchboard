const fs = require('fs');
const path = require('path');

// Only the head of the file is scanned: every session/subagent transcript
// carries `cwd` on its first JSONL line. Reading the whole file here froze
// the main process — refreshFolder() derives the project path on every
// watcher flush, so a 338 MB host-session JSONL meant a multi-second
// readFileSync per flush, back to back (witnessed 2026-06-11: main thread
// pegged ~65% CPU re-reading the same file in a loop, UI freezes).
const CWD_SCAN_BYTES = 256 * 1024;

function extractCwdFromJsonl(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(CWD_SCAN_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, CWD_SCAN_BYTES, 0);
    const lines = buf.toString('utf8', 0, bytesRead).split('\n');
    // The last line is truncated mid-entry when the file is bigger than the
    // scan window — drop it instead of feeding garbage to JSON.parse.
    if (bytesRead === CWD_SCAN_BYTES) lines.pop();
    for (const line of lines) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.cwd) return parsed.cwd;
      } catch {}
    }
  } catch {} finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
  return null;
}

// Is this path a REAL git worktree (created by `git worktree add`)? Such a worktree has its own
// top-level but SHARES the parent's git dir, and its `.git` is a FILE ("gitdir: …/.git/worktrees/x"),
// not a directory. It is a project in its own right — its files and its sessions are not the parent's
// — so it must NOT be collapsed into the parent repo (#147).
function isRealGitWorktree(dir) {
  try {
    const dotGit = path.join(dir, '.git');
    const st = fs.statSync(dotGit);
    if (!st.isFile()) return false;
    return /^gitdir:\s*\S/.test(fs.readFileSync(dotGit, 'utf8'));
  } catch {
    return false;
  }
}

function resolveWorktreePath(cwd) {
  if (!cwd) return cwd;
  // A real `git worktree add` worktree is its OWN project — never fold it into the parent, even when
  // it happens to sit under a conventional worktrees directory (#147).
  if (isRealGitWorktree(cwd)) return cwd;

  // Detect worktree paths: <project>/.claude-worktrees/<name>, <project>/.worktrees/<name>, or <project>/.claude/worktrees/<name>
  // Accept both separators so Windows backslash paths collapse too.
  const worktreeMatch = cwd.match(/^(.+?)[\\/]\.(?:claude[\\/]worktrees|claude-worktrees|worktrees)[\\/][^\\/]+[\\/]?$/);
  if (worktreeMatch) {
    const parent = worktreeMatch[1];
    if (fs.existsSync(parent)) return parent;
  }
  return cwd;
}

// --- Per-session attribution (#157) ---
//
// A session's CURRENT working directory is not read from the file here. #147 added a pair of helpers to
// do that (a windowed tail read, to find the last cwd), and they were never wired to anything — the
// parser already walks every line, so it now simply remembers the last cwd it saw (read-session-file.js,
// `st.lastCwd`). No second read of a file we are already reading.
//
// The FOLDER's identity (deriveProjectPath, below) deliberately still reads the HEAD cwd: a folder is
// keyed on the directory it was created from, and deriving that from one session's current cwd would let
// a moved session drag every sibling in the folder with it, depending on readdir order.

// Windows says D:\x and d:\X are the same directory. A real store carries both spellings of the same
// path, and compared naively they become two projects.
function normPath(p) {
  // `p || ''`, not `String(p)`: this answer is used as a MAP KEY for project buckets, and `String(null)`
  // is the four-character string "null" — a bucket named after a bug. The register's own copy of this
  // function guarded it; when the two were merged into one (#245) the guard had to come along, or a row
  // with no projectPath would have started grouping under "null" instead of being ignored.
  const trimmed = String(p || '').replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

function samePath(a, b) {
  if (!a || !b) return false;
  return normPath(a) === normPath(b);
}

// The 2-deep tail of a project path ("…/dev/MyApp" -> "dev/MyApp"), the label the sidebar and the
// Plans/Memory tabs show. One definition so a backend's per-file displayPath and the tab's project-group
// header derive the same short name (#227).
function projectShortName(projectPath) {
  return String(projectPath || '').split(/[\\/]/).filter(Boolean).slice(-2).join('/');
}

/** Is `child` a directory INSIDE `parent`? (Not the same directory — strictly below it.) */
function isDescendant(child, parent) {
  if (!child || !parent) return false;
  const c = normPath(child);
  const p = normPath(parent);
  return c !== p && c.startsWith(p + '/');
}

// dir -> its project root (or null). A scan asks this for every session, and the answer for a given
// directory cannot change while the app runs — so it is worth remembering.
const _rootCache = new Map();

/**
 * The PROJECT ROOT of a directory: the nearest ancestor (the directory itself included) that holds a
 * `.git` — a directory (an ordinary repo) or a file (a worktree). Returns null when there is none.
 *
 * This is what makes per-session attribution safe, and it is not optional. A Claude transcript's `cwd`
 * is the SHELL's working directory, not the session's project: measured on a real store, 38 of 180
 * sessions change it, and nearly all of them merely `cd` into a subdirectory — `…/build/logs`,
 * `…/.claude/scratchpad`, `…/node_modules/node-pty/deps/winpty/src`. One session visited 19 distinct
 * cwds. Attributing a session to its raw current cwd (which is what the issue originally asked for)
 * would scatter those into phantom projects. Their ROOT, on the other hand, never moved.
 */
function projectRootOf(dir) {
  if (!dir) return null;
  const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
  if (_rootCache.has(key)) return _rootCache.get(key);

  let current;
  try { current = path.resolve(dir); } catch { _rootCache.set(key, null); return null; }
  let root = null;
  // Bounded by the filesystem: path.dirname() of a drive/mount root returns itself.
  for (let guard = 0; guard < 64; guard++) {
    try { if (fs.existsSync(path.join(current, '.git'))) { root = current; break; } } catch { /* keep walking */ }
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  _rootCache.set(key, root);
  return root;
}

/**
 * Where a SESSION belongs, given the cwd it is working in now and the project its folder stands for.
 *
 * The folder's value wins whenever the session has not genuinely left it — including the case where the
 * cwd has no project root at all (a directory outside any repo). Never guess: an unrecognised move keeps
 * the session where it was, which is at worst the old behaviour.
 */
function sessionProjectPath(currentCwd, folderProjectPath) {
  if (!currentCwd) return folderProjectPath || null;

  const root = projectRootOf(currentCwd);
  if (!root) return folderProjectPath || resolveWorktreePath(currentCwd);

  const resolved = resolveWorktreePath(root);
  // The same project, spelled differently (case, a trailing separator): keep the folder's exact string,
  // because that string IS the grouping key — a second spelling would render a second project.
  if (folderProjectPath && samePath(resolved, folderProjectPath)) return folderProjectPath;

  // A session that merely went DEEPER into its own project stays with it (#182). A subdirectory that
  // happens to carry a `.git` is still a subdirectory: a parent that coordinates several repositories
  // is an ordinary way to work, and without this every one of them steals any session that visits it —
  // into a project nobody added, which in manual mode is never registered and therefore never painted.
  // The session was LAUNCHED in the folder's project; Claude names its own transcript folder after that
  // same directory, and this keeps us in step with it.
  //
  // The worktree is the exception this rule exists alongside: it sits below the project too, and it is
  // deliberately a project of its own (#147/#157). Re-attribution is for a session that genuinely LEAVES
  // the tree — into a worktree, or into an unrelated repository elsewhere on disk.
  if (folderProjectPath && isDescendant(resolved, folderProjectPath) && !isRealGitWorktree(resolved)) {
    return folderProjectPath;
  }
  return resolved;
}

function deriveProjectPath(folderPath) {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    // Check direct .jsonl files first
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        const cwd = extractCwdFromJsonl(path.join(folderPath, e.name));
        if (cwd) return resolveWorktreePath(cwd);
      }
    }
    // Check session subdirectories (UUID folders with subagent .jsonl files)
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const subDir = path.join(folderPath, e.name);
      try {
        const subFiles = fs.readdirSync(subDir, { withFileTypes: true });
        for (const sf of subFiles) {
          let jsonlPath;
          if (sf.isFile() && sf.name.endsWith('.jsonl')) {
            jsonlPath = path.join(subDir, sf.name);
          } else if (sf.isDirectory() && sf.name === 'subagents') {
            const agentFiles = fs.readdirSync(path.join(subDir, 'subagents')).filter(f => f.endsWith('.jsonl'));
            if (agentFiles.length > 0) jsonlPath = path.join(subDir, 'subagents', agentFiles[0]);
          }
          if (jsonlPath) {
            const cwd = extractCwdFromJsonl(jsonlPath);
            if (cwd) return resolveWorktreePath(cwd);
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

module.exports = {
  deriveProjectPath, resolveWorktreePath,
  extractCwdFromJsonl, isRealGitWorktree,
  projectRootOf, sessionProjectPath, samePath, normPath, projectShortName,
  _resetRootCache: () => _rootCache.clear(),
};
