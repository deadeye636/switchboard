// backends/pi-native/approvals.js — what the app may answer for the approval gate by itself (#731).
//
// The gate (`./runtime-extension.js`) asks before every gated call, and until #731 only the person at the card
// could answer. Three things now answer for them, all decided here and applied by the core (`src/app/agent-rpc.js`
// asks `approvalAutoAnswer` before it draws a card, and `approvalRecord` after the user answered one):
//
//   * the session's MODE, switched from the session line: `ask` is the gate as it always was, `acceptEdits` lets
//     `edit` and `write` through, `allowAll` lets everything through. The mode is the session's and writes nothing.
//   * what the user allowed FOR THIS SESSION, by the gate's own key. The core keeps the keys per session id, so
//     they outlive the extension instance Pi rebuilds on `/reload` and a respawn of the same conversation, and a
//     `/new` or a `/fork` starts empty because it is another id (spec 30).
//   * what the user allowed IN THIS PROJECT: rules in the pi-native option `approvalRules`, one per line, read from
//     the project's settings (a worktree's are its project's).
//
// THE RULE GRAMMAR. A rule is the gate's key (`edit`, `write`, `mcp__server__tool`, `subagent:<origin:agent>`,
// `command:<name>`), or for a shell tool `bash(<command line>)` / `powershell(<command line>)`. The command line
// is matched exactly; one ending in `*` matches every command line that starts with what comes before the `*`, and
// `bash(*)` covers every bash call. The card only ever writes an exact rule, so a wildcard is always one the user
// typed into the settings, where every rule can be seen and removed. A shell rule never covers a taken-over
// command's shell line: that asks under `command:<name>` (spec 31, N1), so a `bash(git status)` rule cannot unlock
// a line of the user's own command and the reverse.
//
// The gate stays what spec 30 says it is: a convenience inside the agent's process, not a security boundary.
'use strict';

// The option holding a project's rules, one per line. Named on the descriptor (`rpc.approvalRulesOption`) so the
// core reads and writes it without naming it.
const RULES_OPTION = 'approvalRules';

// The value "Always allow in this project" sends back. It is the app's, not one of the gate's choices: the core
// records the rule and the gate hears "Allow once" (`answerValueForGate`).
const PROJECT_CHOICE = 'Always allow in this project';

const SHELL_TOOLS = new Set(['bash', 'powershell']);
const EDIT_TOOLS = new Set(['edit', 'write']);

// The gate's modes, in the order Shift+Tab walks them, and the words the session line draws them with.
const MODE_CYCLE = ['ask', 'acceptEdits', 'allowAll'];
const MODES = {
  ask: { label: 'ask before changes', symbol: '⏸', tone: '' },
  acceptEdits: { label: 'accept edits', symbol: '⏵⏵', tone: 'accept' },
  allowAll: { label: 'allow everything', symbol: '⏵⏵', tone: 'danger' },
};
function modeInfo(mode) {
  const m = MODES[mode];
  return m ? { id: mode, ...m } : null;
}

// The rule "Always allow in this project" writes for this question, or '' when it offers none. A shell call is
// allowed by its exact command line; a question with no command line to name (a shell call whose input the gate
// could not read) gets no project button, since the tool alone would allow every command.
//
// Two refusals keep a written rule meaning what the card showed. A rule is one LINE of the option, so a key or a
// command with a line break in it would store as several rules — and an agent's or a command's name comes from a
// file, which may be a project's. And a command line ending in `*` would read back as a prefix wildcard, so the
// card would allow more than it showed; such a call is allowed once or for the session, not in the project.
function ruleFor(ask) {
  const tool = ask && typeof ask.tool === 'string' ? ask.tool : '';
  const key = ask && typeof ask.approvalKey === 'string' ? ask.approvalKey : '';
  if (!key || /[\r\n]/.test(key)) return '';
  if (SHELL_TOOLS.has(tool) && key === tool) {
    const command = typeof ask.command === 'string' ? ask.command.trim() : '';
    return command && !/[\r\n]/.test(command) && !command.endsWith('*') ? `${tool}(${command})` : '';
  }
  return key;
}

// The rules one option value holds: one per line, blank lines and surrounding space dropped.
function parseRules(value) {
  const lines = Array.isArray(value) ? value : String(value == null ? '' : value).split(/\r?\n/);
  return lines.map(l => String(l).trim()).filter(Boolean);
}

const SHELL_RULE = /^(bash|powershell)\((.*)\)$/s;
// What a prefix rule refuses in the rest of the command line: anything that chains, substitutes or redirects, so
// `bash(git status*)` does not allow `git status; curl … | sh`. `bash(*)` is the one rule that allows those.
const SHELL_OPERATOR = /[;&|`<>\r\n]|\$\(/;

function ruleMatches(rule, ask) {
  const r = String(rule || '').trim();
  if (!r || !ask) return false;
  const key = typeof ask.approvalKey === 'string' ? ask.approvalKey : '';
  const shell = SHELL_RULE.exec(r);
  // A bare `bash` is not a second spelling of `bash(*)`: the whole tool is allowed only the documented way.
  if (!shell) return !!key && r === key && !SHELL_TOOLS.has(r);
  // A shell rule answers only the agent's own shell call, whose key is the tool itself.
  if (ask.tool !== shell[1] || key !== shell[1]) return false;
  const command = typeof ask.command === 'string' ? ask.command.trim() : '';
  const pattern = shell[2].trim();
  if (!command) return false;
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return command.startsWith(prefix) && !SHELL_OPERATOR.test(command.slice(prefix.length));
  }
  return command === pattern;
}

// Whether the app answers this question itself, and with what. `memory` is the core's: `{ mode, sessionKeys,
// projectRules }`. Only an approval of the gate is ever answered; anything else goes to the person.
function approvalAutoAnswer(ask, memory = {}) {
  if (!ask || ask.kind !== 'approval' || !ask.approvalKey) return null;
  const allow = () => ({ value: ask.answers && ask.answers.once ? ask.answers.once : 'Allow once' });
  const mode = memory.mode || 'ask';
  if (mode === 'allowAll') return allow();
  if (mode === 'acceptEdits' && EDIT_TOOLS.has(ask.tool) && !ask.requestedBy) return allow();
  const keys = memory.sessionKeys;
  if (keys && typeof keys.has === 'function' && keys.has(ask.approvalKey)) return allow();
  if (Array.isArray(memory.projectRules) && memory.projectRules.some(r => ruleMatches(r, ask))) return allow();
  return null;
}

// What an answer the user gave is worth remembering: a session allow by the gate's key, a project allow by the
// rule the card offered. Null for everything else.
function approvalRecord(ask, answer) {
  if (!ask || ask.kind !== 'approval' || !answer || answer.cancelled) return null;
  const value = answer.value;
  const answers = ask.answers || {};
  if (answers.session && value === answers.session && ask.approvalKey) return { session: ask.approvalKey };
  if (answers.project && value === answers.project) {
    const rule = ruleFor(ask);
    return rule ? { project: rule } : null;
  }
  return null;
}

// What the gate hears for an answer: the project allow is the app's, so the gate is told "Allow once" and the
// rule answers every later call.
function answerValueForGate(value, onceChoice) {
  return value === PROJECT_CHOICE ? onceChoice : value;
}

// The card's words for the project button and its tooltip.
function projectLabel(rule) {
  const shell = SHELL_RULE.exec(rule);
  const what = shell ? shell[2] : rule;
  return `Always allow “${what.length > 60 ? what.slice(0, 57) + '…' : what}” in this project`;
}
function projectNote(rule) {
  return `Rule: ${rule}. Switchboard keeps it in this project's settings for Pi (native), under "Allowed in this project", `
    + 'where it can be edited or removed. A rule ending in * covers every command that starts the same way.';
}

module.exports = {
  RULES_OPTION, PROJECT_CHOICE, MODE_CYCLE, modeInfo,
  ruleFor, parseRules, ruleMatches, approvalAutoAnswer, approvalRecord, answerValueForGate, projectLabel, projectNote,
};
