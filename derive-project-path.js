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

// The LAST cwd in the transcript, i.e. where the session is ACTUALLY working now (#147).
//
// A session can move working directory mid-flight — most commonly parent repo -> git worktree. Its
// JSONL then carries BOTH cwds, and reading only the head attributes the whole session to the tree
// it merely started in. So we read the file's TAIL and take the last cwd we see.
//
// Bounded like the head scan for the same reason (a 338 MB transcript must not be read whole): one
// extra windowed read, never the middle of the file.
function extractCurrentCwdFromJsonl(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= CWD_SCAN_BYTES) {
      // Small file: the head scan already saw everything — just take the last cwd in it.
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      return lastCwdIn(buf.toString('utf8'), false);
    }
    const buf = Buffer.alloc(CWD_SCAN_BYTES);
    fs.readSync(fd, buf, 0, CWD_SCAN_BYTES, size - CWD_SCAN_BYTES);
    // The first line of a tail window is almost certainly truncated — drop it.
    return lastCwdIn(buf.toString('utf8'), true);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

function lastCwdIn(text, dropFirstLine) {
  const lines = text.split('\n');
  if (dropFirstLine) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.cwd) return parsed.cwd;
    } catch { /* truncated/partial line — keep walking backwards */ }
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

// A session's working directory for grouping purposes: where it is working NOW, falling back to
// where it started. A session that moved parent -> worktree must follow its current tree (#147).
function sessionCwd(filePath) {
  return extractCurrentCwdFromJsonl(filePath) || extractCwdFromJsonl(filePath);
}

function deriveProjectPath(folderPath) {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    // Check direct .jsonl files first
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        const cwd = sessionCwd(path.join(folderPath, e.name));
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
            const cwd = sessionCwd(jsonlPath);
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
  extractCwdFromJsonl, extractCurrentCwdFromJsonl, sessionCwd, isRealGitWorktree,
};
