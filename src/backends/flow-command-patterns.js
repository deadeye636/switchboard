'use strict';
// The built-in list of potentially destructive commands for the session flow (spec 46, #826 requirement 11), shared by every
// backend whose tool runs a shell. Backend-neutral on purpose: `rm`, `git`, `chmod`, `dd` and the PowerShell and cmd deletes are
// the language of the command line, not any CLI's transcript format. What stays in a backend folder is how it FINDS the command
// string (a tool name, a field, a script) and what its flags say beyond the command. The matcher is `./flow-patterns.js`.
//
// The list is a HEURISTIC and every flag from it says so. It is conservative on purpose: a recursive delete is flagged only at a
// broad target (`/`, `~`, `$HOME`, `.`, `..`, `*`, a drive root, a top-level directory such as `/etc`), so `rm -rf node_modules` is NOT
// flagged. A force push is flagged, `--force-with-lease` is not. Quoted text is data: `echo "rm -rf /"` starts with `echo` and never
// matches (see `./flow-patterns.js` for the rule and its limits).

const { matchPatterns } = require('./flow-patterns');

// Shared pieces. Written so no quantifier is nested in another: a `[^\n]*` scan followed by a literal.
const END = '(?=[\\s)}]|$)'; // a token ends at a space, the end, or the `)` / `}` of a group around the command
const ANY = '[^\\n]*';
const shortFlag = (letters) => `-(?=[A-Za-z]*[${letters}])[A-Za-z]+${END}`;
// A broad POSIX delete target: root, home, the current or parent directory, a bare wildcard, or one top-level directory.
const POSIX_TARGET = '(?:[A-Za-z]:[\\\\/]\\*?|\\/\\*?|~\\/?\\*?|\\$\\{?HOME\\}?\\/?\\*?|\\.\\.?\\/?\\*?|\\*|\\/[A-Za-z0-9_.-]+\\/?)';
// The same for Windows: a drive root, a top-level directory of a drive, home, the current or parent directory, a wildcard.
const WIN_TARGET = '(?:[A-Za-z]:[\\\\/]?\\*?|[A-Za-z]:[\\\\/][A-Za-z0-9_.$-]+[\\\\/]?|\\\\\\*?|~[\\\\/]?\\*?|\\$HOME|\\$env:USERPROFILE|%USERPROFILE%|\\.\\.?[\\\\/]?\\*?|\\*)';
const GIT = '^git(?:\\s+(?:-C|-c)\\s+\\S+|\\s+--[a-z-]+)*\\s+';
const BLOCK_DEVICE = '\\/dev\\/(?:sd|hd|vd|xvd|nvme|mmcblk|r?disk)';

const re = (source, flags) => new RegExp(source, flags);

const PATTERNS = Object.freeze([
  { id: 'rm-recursive', test: re(`^rm(?=\\s)(?=${ANY}\\s(?:${shortFlag('rR')}|--recursive${END}))(?=${ANY}\\s${POSIX_TARGET}${END})`),
    reason: 'A recursive delete aimed at a root, home, parent or top-level directory, or at everything in the current one.' },
  { id: 'git-force-push', test: re(`${GIT}push(?=\\s)(?=${ANY}\\s(?:--force${END}|${shortFlag('f')}))`),
    reason: 'A force push can overwrite commits on the remote that other people rely on.' },
  { id: 'git-reset-hard', test: re(`${GIT}reset(?=\\s)(?=${ANY}\\s--hard${END})`),
    reason: 'A hard reset throws away uncommitted changes in the working tree.' },
  { id: 'git-clean-force', test: re(`${GIT}clean(?=\\s)(?=${ANY}\\s(?:--force${END}|${shortFlag('f')}))(?!${ANY}\\s(?:--dry-run${END}|${shortFlag('n')}))`),
    reason: 'A forced clean deletes untracked files, which no commit can bring back.' },
  { id: 'git-discard-changes', test: re(`${GIT}(?:checkout(?=\\s)(?!${ANY}\\s(?:-b|-B|--orphan)${END})(?=${ANY}\\s\\.${END})|restore(?=\\s)(?:(?!${ANY}\\s--staged${END})|(?=${ANY}\\s(?:--worktree|-W)${END}))(?=${ANY}\\s\\.${END}))`),
    reason: 'This overwrites every uncommitted change in the working tree with the committed version.' },
  { id: 'git-branch-force-delete', test: re(`${GIT}branch(?=\\s)(?=${ANY}\\s${shortFlag('D')})`),
    reason: 'Deleting a branch with -D drops commits that no other branch holds.' },
  { id: 'chmod-world-writable', test: re(`^chmod(?=\\s)(?=${ANY}\\s(?:--recursive${END}|${shortFlag('R')}))(?=${ANY}\\s(?:0?777|(?:a|ugo)?\\+rwx)${END})`),
    reason: 'A recursive chmod to 777 makes a whole tree writable by everyone.' },
  { id: 'dd-to-device', test: re(`^dd(?=\\s)(?=${ANY}\\sof=${BLOCK_DEVICE})`),
    reason: 'Writing to a block device with dd overwrites the disk.' },
  { id: 'mkfs', test: re('^mkfs(?:\\.[a-z0-9]+)?(?=\\s|$)', 'i'),
    reason: 'Running mkfs creates a new filesystem and erases what the device held.' },
  { id: 'redirect-to-device', view: 'blanked', test: re(`>>?\\s*${BLOCK_DEVICE}`),
    reason: 'Redirecting output onto a block device overwrites the disk.' },
  { id: 'pipe-to-shell', test: re(`^(?:curl|wget)(?=\\s)[^|\\n]*\\|\\s*(?:sudo\\s+(?:-\\S+\\s+)*)?(?:ba|z|da|k)?sh${END}`),
    reason: 'A download piped straight into a shell runs code nobody has read.' },
  { id: 'pipe-to-iex', test: re(`^(?:iwr|irm|curl|wget|invoke-webrequest|invoke-restmethod)(?=\\s)[^|\\n]*\\|\\s*(?:iex|invoke-expression)${END}`, 'i'),
    reason: 'A download piped straight into Invoke-Expression runs code nobody has read.' },
  { id: 'remove-item-recurse', test: re(`^(?:remove-item|ri|rm|del|erase|rd|rmdir)(?=\\s)(?=${ANY}\\s-r(?:e|ec|ecu|ecur|ecurs|ecurse)?${END})(?=${ANY}\\s${WIN_TARGET}${END})`, 'i'),
    reason: 'A recursive Remove-Item aimed at a drive, home, parent or top-level directory, or at everything in the current one.' },
  { id: 'cmd-recursive-delete', test: re(`^(?:del|erase|rd|rmdir)(?=\\s)(?=${ANY}\\s/s${END})(?=${ANY}\\s${WIN_TARGET}${END})`, 'i'),
    reason: 'A recursive delete aimed at a drive, home, parent or top-level directory, or at everything in the current one.' },
  { id: 'format-drive', test: re('^(?:format(?:\\.com)?\\s+[a-z]:|format-volume(?=\\s|$))', 'i'),
    reason: 'Formatting a drive erases everything on it.' },
  { id: 'sql-drop', test: re(`^(?:psql|mysql|mariadb|sqlite3|sqlcmd|duckdb|clickhouse-client)(?=\\s)(?=${ANY}\\b(?:drop\\s+(?:table|database|schema)|truncate\\s+table)\\b)`, 'i'),
    reason: 'DROP or TRUNCATE removes a table, schema or database together with its rows.' },
]);

/**
 * Risk flags (heuristic) for one command string, `[]` when nothing matches. `dialect` is 'posix' or 'powershell' (which character
 * escapes, and which wording wins when a command fits both `rm-recursive` and `remove-item-recurse`).
 */
function commandRiskFlags(command, dialect) {
  if (typeof command !== 'string' || !command) return [];
  const powershell = dialect === 'powershell';
  const matches = matchPatterns(PATTERNS, command, { dialect: powershell ? 'powershell' : 'posix' });
  // `rm -r` is both the POSIX command and a PowerShell alias of Remove-Item: one mark, not two. The powershell dialect keeps
  // the PowerShell wording, the posix dialect the POSIX one.
  const drop = powershell ? 'rm-recursive' : 'remove-item-recurse';
  const both = matches.some((m) => m.id === 'rm-recursive') && matches.some((m) => m.id === 'remove-item-recurse');
  return matches.filter((m) => !(both && m.id === drop)).map((m) => ({
    axis: 'risk',
    code: `destructive:${m.id}`,
    why: `Looks destructive (a pattern match, not a measurement): ${m.reason} Matched: ${m.fragment}`,
    evidence: 'heuristic',
  }));
}

module.exports = { PATTERNS, commandRiskFlags };
