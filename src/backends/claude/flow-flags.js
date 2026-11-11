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
// The command list is shared: `../flow-command-patterns.js` (rm, git and the rest are command-line language, not Claude's format).
// Here lives only the part that is Claude's: which tools run a shell and where their command sits.

const { PATTERNS, commandRiskFlags } = require('../flow-command-patterns');
const { trunc } = require('../flow-lines');

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const MAX_TOOL_NAMES = 6;

/** Risk flags (heuristic) for a tool call: a shell tool whose `command` matches the list. Empty for any other call. */
function commandFlags(toolName, input) {
  if (!SHELL_TOOLS.has(toolName) || !input || typeof input.command !== 'string') return [];
  return commandRiskFlags(input.command, toolName === 'PowerShell' ? 'powershell' : 'posix');
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
