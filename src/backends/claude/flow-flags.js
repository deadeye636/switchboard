'use strict';
// Claude's highlights for the session flow (spec 46, #826 requirements 10 and 11): the built-in list of potentially
// destructive commands, and the flags a step carries for them, for the permission mode, and for how a call ended.
// This is where Claude's FORMAT lives (CLAUDE.md reflex 5): the tool names that run a shell, the hook-block and
// permission-denied result texts, the `hook_cancelled` and `command_permissions` attachments, the mode names. The
// neutral matcher is `../flow-patterns.js`; the flag shape is `src/shared/flow-snapshot.js`.
//
// Flags are separate facts on separate axes and may coexist on one step: a blocked `rm -rf /` carries a `risk` flag
// (heuristic: a pattern matched) AND an `outcome` flag (structured: a hook blocked it, so it did not run). Only a
// structured outcome says whether a call ran.
//
// The command list is a HEURISTIC and every flag from it says so. It is conservative on purpose: a recursive delete is
// flagged only at a broad target (`/`, `~`, `$HOME`, `.`, `..`, `*`, a top-level directory such as `/etc` or `C:\Users`),
// so `rm -rf node_modules` is NOT flagged. A force push is flagged, `--force-with-lease` is not. Quoted text is data:
// `echo "rm -rf /"` starts with `echo` and never matches (see `../flow-patterns.js` for the rule and its limits).

const { matchPatterns } = require('../flow-patterns');
const { trunc } = require('../flow-lines');

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const MAX_TOOL_NAMES = 6;

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

function risk(code, why) {
  return { axis: 'risk', code, why, evidence: 'heuristic' };
}

/** Risk flags (heuristic) for a tool call: a shell tool whose `command` matches the list. Empty for any other call. */
function commandFlags(toolName, input) {
  if (!SHELL_TOOLS.has(toolName) || !input || typeof input.command !== 'string') return [];
  const matches = matchPatterns(PATTERNS, input.command, { dialect: toolName === 'PowerShell' ? 'powershell' : 'posix' });
  // `rm -r` is both the POSIX command and a PowerShell alias of Remove-Item: one mark, not two.
  // Both fit: the PowerShell tool keeps the PowerShell wording, every other tool the POSIX one.
  const drop = toolName === 'PowerShell' ? 'rm-recursive' : 'remove-item-recurse';
  const both = matches.some((m) => m.id === 'rm-recursive') && matches.some((m) => m.id === 'remove-item-recurse');
  return matches.filter((m) => !(both && m.id === drop)).map((m) =>
    risk(`destructive:${m.id}`, `Looks destructive (a pattern match, not a measurement): ${m.reason} Matched: ${m.fragment}`));
}

/** The risk flag (structured: the transcript names the mode) for a permission mode that skips prompts, else null. */
function modeFlag(mode) {
  if (mode === 'bypassPermissions') {
    return { axis: 'risk', code: 'mode-bypass-permissions', why: 'The permission mode is bypassPermissions: tool calls run without asking.', evidence: 'structured' };
  }
  // Milder: only file edits skip the prompt, shell commands still ask.
  if (mode === 'acceptEdits') {
    return { axis: 'risk', code: 'mode-accept-edits', why: 'The permission mode is acceptEdits: file edits are applied without asking.', evidence: 'structured' };
  }
  return null;
}

// Anchored at the start of the result, like DENIED. Measured (docs/backend-formats.md): every `is_error` result that starts this way is a
// call that did not run, with or without the word BLOCKED (one guard hook's own wording) and with or without a `[cmd]:` segment.
const HOOK_BLOCK = /^\s*PreToolUse:([\w.:-]{1,60}) hook error:?\s*(?:\[[^\]\n]{0,200}\]:\s*)?(?:BLOCKED\b:?\s*)?([^\n]{0,120})/;
const DENIED = /^\s*Permission for this action was denied/;

/**
 * The outcome flag of a finished call (structured: the result says so), `[]` for a call that did not fail. A hook block and
 * a permission denial mean the call did NOT run; any other error means it ran and failed.
 */
function resultFlags(isError, text) {
  if (isError !== true) return [];
  const t = typeof text === 'string' ? text : '';
  const hook = HOOK_BLOCK.exec(t);
  if (hook) {
    const tail = hook[2].trim();
    return [{ axis: 'outcome', code: 'hook-blocked', why: trunc(`A PreToolUse hook stopped this ${hook[1]} call; it is taken as not run (the transcript holds no other result for it).${tail ? ` Hook said: ${tail}` : ''}`, 240), evidence: 'structured' }];
  }
  if (DENIED.test(t)) {
    return [{ axis: 'outcome', code: 'permission-denied', why: 'The permission was denied, so the call did not run.', evidence: 'structured' }];
  }
  return [{ axis: 'outcome', code: 'tool-error', why: 'the tool reported an error', evidence: 'structured' }];
}

const str = (v, max) => (typeof v === 'string' ? trunc(v, max) : '');

/**
 * A step for an `attachment` that is a fact of its own, or `null`: `hook_cancelled` (outcome, structured) and
 * `command_permissions` (a skill granted tools: lifecycle, structured, NOT a risk). `{ label, detail, flags }`.
 */
function attachmentEvent(att) {
  if (!att || typeof att !== 'object') return null;
  if (att.type === 'hook_cancelled') {
    const name = str(att.hookName, 100) || str(att.hookEvent, 100);
    return {
      label: name ? `Hook cancelled: ${name}` : 'Hook cancelled',
      detail: name ? { hook: name } : {},
      flags: [{ axis: 'outcome', code: 'hook-cancelled', why: `A hook was cancelled${name ? ` (${name})` : ''} before it finished.`, evidence: 'structured' }],
    };
  }
  if (att.type === 'command_permissions' && Array.isArray(att.allowedTools)) {
    const names = att.allowedTools.filter((x) => typeof x === 'string' && x).map((x) => trunc(x, 60));
    const shown = names.slice(0, MAX_TOOL_NAMES).join(', ');
    const list = names.length > MAX_TOOL_NAMES ? `${shown} +${names.length - MAX_TOOL_NAMES}` : shown;
    return {
      label: `Skill granted tools: ${list || 'none named'}`,
      detail: { tools: trunc(names.join(', '), 500) },
      flags: [{ axis: 'lifecycle', code: 'skill-granted-tools', why: 'A skill\'s allowed-tools took effect, so these tools run without a prompt.', evidence: 'structured' }],
    };
  }
  return null;
}

module.exports = { PATTERNS, commandFlags, modeFlag, resultFlags, attachmentEvent, SHELL_TOOLS };
