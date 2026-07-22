// Pure parser for `git status --porcelain=v2 --branch` output (#277).
//
// DOM-free and process-free: it takes the raw status text and returns a normalized summary + file list.
// The provider (backends of VCS live in `src/vcs/`) spawns git and calls this; the in-progress `state`
// (merging/rebasing/cherry-picking) is NOT in porcelain output and is filled in by the provider from
// `.git/` markers — this parser only reports `state: 'detached'` when the branch header says so.
//
// Handles BOTH forms of porcelain v2:
//   - NUL-separated (`-z`): records split on NUL; a rename (`2`) record's original path is the NEXT
//     NUL field. No path quoting — the robust form, and the one the git provider uses.
//   - newline-separated: records split on \n; a rename record's paths are TAB-separated on one line,
//     and unusual paths are C-quoted ("...").
//
// The two-char XY status of an ordinary/rename entry: X = the staged (index) side, Y = the unstaged
// (working-tree) side; `.` means unmodified on that side. A file staged AND modified again (`MM`) is
// counted on BOTH sides and appears once per group in the list, so the chip counts always match the
// file list. Untracked (`?`) → untracked; unmerged (`u`) → conflicted.
'use strict';

const KIND_STAGED = 'staged';
const KIND_UNSTAGED = 'unstaged';
const KIND_UNTRACKED = 'untracked';
const KIND_CONFLICTED = 'conflicted';

// C-style unquote for newline-mode paths git wraps in double quotes (e.g. "spa ce\t.txt").
function unquotePath(p) {
  if (p.length < 2 || p[0] !== '"' || p[p.length - 1] !== '"') return p;
  const body = p.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { out += c; continue; }
    const n = body[++i];
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'r') out += '\r';
    else if (n === '\\') out += '\\';
    else if (n === '"') out += '"';
    else if (n >= '0' && n <= '7') { // octal escape \NNN
      const oct = body.substr(i, 3);
      out += String.fromCharCode(parseInt(oct, 8));
      i += 2;
    } else out += n;
  }
  return out;
}

// A `1`/`2`/`u` record's XY drives which group(s) the file lands in. Returns 0, 1 or 2 file rows.
function filesForEntry(x, y, path, origPath) {
  const rows = [];
  if (x !== '.' && x !== undefined) rows.push({ kind: KIND_STAGED, x, y, path, ...(origPath ? { origPath } : {}) });
  if (y !== '.' && y !== undefined) rows.push({ kind: KIND_UNSTAGED, x, y, path, ...(origPath ? { origPath } : {}) });
  return rows;
}

/**
 * @param {string} raw  stdout of `git status --porcelain=v2 --branch` (with or without -z)
 * @param {object} [opts]
 * @param {number} [opts.cap]  stop collecting file rows after this many (chip stays honest as "N+")
 * @returns {{branch, state, ahead, behind, staged, unstaged, untracked, conflicted, files, truncated}}
 */
function parseGitStatus(raw, opts = {}) {
  const cap = Number.isFinite(opts.cap) ? opts.cap : Infinity;
  const text = typeof raw === 'string' ? raw : '';
  const nulMode = text.indexOf('\0') !== -1;

  const summary = {
    branch: null,
    state: null,          // 'detached' here; merging/rebasing filled by the provider
    ahead: null,
    behind: null,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    files: [],
    truncated: false,
  };

  // Tokenize into records. In NUL mode a rename record consumes the following NUL field as its
  // original path, so we index manually.
  const tokens = nulMode
    ? text.split('\0').filter(t => t.length > 0)
    : text.split('\n').map(l => l.replace(/\r$/, '')).filter(t => t.length > 0);

  const pushFiles = (rows) => {
    for (const r of rows) {
      if (summary.files.length >= cap) { summary.truncated = true; return; }
      summary.files.push(r);
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    // Porcelain v2 emits all `# branch.*` headers before any entry, so once the cap is hit the rest is
    // only more file records — stop regex-matching them (bounds CPU, not just the array).
    if (summary.truncated) break;
    const line = tokens[i];
    const type = line[0];

    if (type === '#') {
      // Branch headers.
      const rest = line.slice(2);
      if (rest.startsWith('branch.head ')) {
        const head = rest.slice('branch.head '.length).trim();
        if (head === '(detached)') { summary.branch = null; summary.state = 'detached'; }
        else summary.branch = head;
      } else if (rest.startsWith('branch.ab ')) {
        const m = rest.slice('branch.ab '.length).match(/^\+(\d+)\s+-(\d+)/);
        if (m) { summary.ahead = Number(m[1]); summary.behind = Number(m[2]); }
      }
      continue;
    }

    if (type === '1') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const m = line.match(/^1 (..) \S+ \S+ \S+ \S+ \S+ \S+ ([\s\S]+)$/);
      if (m) pushFiles(filesForEntry(m[1][0], m[1][1], nulMode ? m[2] : unquotePath(m[2])));
      continue;
    }

    if (type === '2') {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path><sep><origPath>
      const m = line.match(/^2 (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ ([\s\S]+)$/);
      if (!m) continue;
      let path, origPath;
      if (nulMode) {
        path = m[2];
        origPath = tokens[++i]; // the next NUL field is the original path
      } else {
        const parts = m[2].split('\t');
        path = unquotePath(parts[0]);
        origPath = parts[1] != null ? unquotePath(parts[1]) : undefined;
      }
      pushFiles(filesForEntry(m[1][0], m[1][1], path, origPath));
      continue;
    }

    if (type === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>  → a conflict
      const m = line.match(/^u (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ ([\s\S]+)$/);
      if (m) {
        const path = nulMode ? m[2] : unquotePath(m[2]);
        if (summary.files.length < cap) summary.files.push({ kind: KIND_CONFLICTED, x: m[1][0], y: m[1][1], path });
        else summary.truncated = true;
      }
      continue;
    }

    if (type === '?') {
      const raw2 = line.slice(2);
      const path = nulMode ? raw2 : unquotePath(raw2);
      if (summary.files.length < cap) summary.files.push({ kind: KIND_UNTRACKED, path });
      else summary.truncated = true;
      continue;
    }

    // '!' ignored entries and anything else are skipped.
  }

  // Counts derive from the file rows so the chip sum can never disagree with the list.
  for (const f of summary.files) {
    if (f.kind === KIND_STAGED) summary.staged++;
    else if (f.kind === KIND_UNSTAGED) summary.unstaged++;
    else if (f.kind === KIND_UNTRACKED) summary.untracked++;
    else if (f.kind === KIND_CONFLICTED) summary.conflicted++;
  }

  // null ≠ 0 (#277 H5): when untracked counting is off (`-uno`), git emits no `?` rows, so a `0` here
  // would be a lie ("measured, none") rather than the truth ("not measured"). The caller passes the
  // mode so the segment reports null and the chip omits it, instead of showing a false "?0".
  if (opts.countUntracked === false) summary.untracked = null;

  return summary;
}

module.exports = { parseGitStatus };
