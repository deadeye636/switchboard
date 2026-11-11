'use strict';
// Codex's highlights for the session flow (spec 46, #826 requirements 10 and 11, plan T22). This is where Codex's FORMAT
// lives (CLAUDE.md reflex 5): how a shell call is written in a rollout, the escalation field, the permission values of a
// `turn_context`, and the guardian's request and verdict. The command list itself is shared (`../flow-command-patterns.js`: `rm`
// and `git` are command-line language, not Codex's format), the matcher is `../flow-patterns.js`, the flag shape is
// `src/shared/flow-snapshot.js`.
//
// Flags are separate facts and may coexist on a step. Only a STRUCTURED outcome says whether a call ran:
//   - risk, structured: the call asked to leave the sandbox (`sandbox_permissions: "require_escalated"`; says it was ASKED,
//     not that it ran), a sandbox policy without a sandbox, a guardian `risk_level` above `low`;
//   - risk, heuristic: a destructive command pattern;
//   - outcome, structured: the guardian's `outcome` (allowed, or anything else = not let out of the sandbox);
//   - outcome, heuristic: a failed call whose output names an access error (a sandbox block has no event of its own).
//
// Measured on local rollouts (docs/backend-formats.md, #826 Codex): the shell is `custom_tool_call` `exec` whose `input` is a
// SCRIPT calling `tools.exec_command({ ... })` with an object literal, written as JSON in most scripts and as a JavaScript
// literal (unquoted keys, template strings, `${}` interpolation) in some. Only a literal string `cmd` is read; a command built
// in code is unknown, so it is neither matched nor confirmed against the guardian. The guardian's request is the last JSON
// object of its user message, with `command` an array whose last element is the command string.

const { commandRiskFlags } = require('../flow-command-patterns');
const { trunc, isObject } = require('../flow-lines');

const SHELL_NAMES = new Set(['exec_command', 'shell', 'shell_command', 'local_shell']);
const SCRIPT_TOOL = 'exec';
const SCRIPT_CHARS = 64 * 1024;
const OBJECT_CHARS = 16 * 1024;
const MAX_CALLS = 8;
const MAX_ATTEMPTS = 16;   // shell-call literals tried per script, read or not
const MAX_COMMAND_CHARS = 8192;
const ESCALATED = 'require_escalated';

// --- Reading the call -------------------------------------------------------------------------------------------------

function readString(s, i) {
  const q = s[i];
  const limit = Math.min(s.length, i + OBJECT_CHARS);
  let out = '';
  let interp = false;
  for (let j = i + 1; j < limit; j++) {
    const c = s[j];
    if (c === '\\') {
      const n = s[j + 1];
      if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(j + 2, j + 6))) { out += String.fromCharCode(parseInt(s.slice(j + 2, j + 6), 16)); j += 5; continue; }
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === undefined ? '' : n;
      j += 1;
      continue;
    }
    if (c === q) return { value: interp ? null : out, end: j + 1 };
    if (q === '`' && c === '$' && s[j + 1] === '{') interp = true;
    out += c;
  }
  return null;
}

// Skips one value that is not a plain string: balanced brackets, strings inside, up to the next top-level `,` or `}`.
function skipValue(s, i, limit) {
  let depth = 0;
  for (let j = i; j < limit; j++) {
    const c = s[j];
    if (c === '"' || c === "'" || c === '`') {
      const str = readString(s, j);
      if (!str) return -1;
      j = str.end - 1;
    } else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '}') { if (depth === 0) return j; depth--; }
    else if (c === ',' && depth === 0) return j;
  }
  return -1;
}

/**
 * The properties of an object literal starting at `s[i]` (`{`): `{ props, end }`, a string value as the string, anything
 * else (a number, an array, a template with `${}`, a variable) as `null`. `null` when the literal cannot be read at all.
 * Covers JSON and the JavaScript spelling of the same shape (unquoted keys, single quotes, templates).
 */
function readObjectLiteral(s, i) {
  const limit = Math.min(s.length, i + OBJECT_CHARS);
  const props = {};
  let j = i + 1;
  for (;;) {
    while (j < limit && /[\s,]/.test(s[j])) j++;
    if (j >= limit) return null;
    if (s[j] === '}') return { props, end: j + 1 };
    let key;
    if (s[j] === '"' || s[j] === "'") {
      const k = readString(s, j);
      if (!k || k.value === null) return null;
      key = k.value;
      j = k.end;
    } else {
      const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(j, j + 80));
      if (!m) return null;
      key = m[0];
      j += m[0].length;
    }
    while (j < limit && /\s/.test(s[j])) j++;
    if (s[j] !== ':') return null;   // a shorthand, a spread or a method: not the shape read here
    j++;
    while (j < limit && /\s/.test(s[j])) j++;
    if (s[j] === '"' || s[j] === "'" || s[j] === '`') {
      const v = readString(s, j);
      if (!v) return null;
      const after = (() => { let k = v.end; while (k < limit && /\s/.test(s[k])) k++; return k; })();
      if (s[after] === ',' || s[after] === '}') { props[key] = v.value; j = after; continue; }   // a plain string value
      const end = skipValue(s, j, limit);                                                       // `"a" + b`: not a plain string
      if (end < 0) return null;
      props[key] = null;
      j = end;
      continue;
    }
    const end = skipValue(s, j, limit);
    if (end < 0) return null;
    props[key] = null;
    j = end;
  }
}

function callOf(props) {
  return {
    command: typeof props.cmd === 'string' ? props.cmd : typeof props.command === 'string' ? props.command : null,
    escalated: props.sandbox_permissions === ESCALATED,
    justification: typeof props.justification === 'string' ? props.justification : '',
  };
}

/**
 * The shell calls in a tool call, in order: `[{ command: string | null, escalated: boolean, justification: string }]`.
 * `type` is the item type (`custom_tool_call` or `function_call`), `name` its tool, `raw` its `input` or `arguments`. An `exec`
 * script is searched for `tools.<shell tool>({ ... })`; a shell function call carries the object as JSON. At most 8 calls,
 * from the first 64 KB of a script.
 */
function shellCallsOf(type, name, raw) {
  if (typeof raw !== 'string' || !raw) return [];
  if (type === 'custom_tool_call' && name === SCRIPT_TOOL) {
    const text = raw.length > SCRIPT_CHARS ? raw.slice(0, SCRIPT_CHARS) : raw;
    const calls = [];
    if (text.trimStart().startsWith('{')) {   // the input is the object itself
      const lit = readObjectLiteral(text, text.indexOf('{'));
      if (lit && (typeof lit.props.cmd === 'string' || typeof lit.props.command === 'string')) return [callOf(lit.props)];
    }
    const re = /\btools\.(?:exec_command|shell|shell_command|local_shell)\s*\(\s*(\{)/g;
    let m;
    let attempts = 0;   // each failed literal can cost a 16 KB scan: bounded by attempts, not only by calls found
    while (calls.length < MAX_CALLS && attempts++ < MAX_ATTEMPTS && (m = re.exec(text))) {
      const lit = readObjectLiteral(text, m.index + m[0].length - 1);
      if (lit) { calls.push(callOf(lit.props)); re.lastIndex = lit.end; }
    }
    return calls;
  }
  if (type === 'function_call' && SHELL_NAMES.has(name)) {
    if (raw.length > SCRIPT_CHARS) return [];
    let a;
    try { a = JSON.parse(raw); } catch { return []; }
    if (!isObject(a)) return [];
    const argv = Array.isArray(a.command) ? a.command.filter((x) => typeof x === 'string') : null;
    const command = typeof a.cmd === 'string' ? a.cmd : typeof a.command === 'string' ? a.command : argv && argv.length ? argv[argv.length - 1] : null;
    return [{ command, escalated: a.sandbox_permissions === ESCALATED, justification: typeof a.justification === 'string' ? a.justification : '' }];
  }
  return [];
}

// --- Flags ------------------------------------------------------------------------------------------------------------

// The shell is PowerShell on Windows (a guardian request names `pwsh.exe`); a call does not say which, so a cmdlet-shaped word
// or `$env:` decides the dialect of the escape character. A guess, and it only changes how a backtick or a backslash is read.
const looksPowerShell = (cmd) => /\$env:|\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b|\bpwsh\b/.test(cmd);

/** The flags of one shell call: the escalation request (structured) and the destructive-command marks (heuristic). */
function callFlags(call) {
  const flags = [];
  if (call.escalated) {
    flags.push({
      axis: 'risk', code: 'escalation-requested', evidence: 'structured',
      why: `The call asked to run outside the sandbox (require_escalated)${call.justification ? `: ${trunc(call.justification, 160)}` : ''}. That says it was asked for, not that it ran.`,
    });
  }
  if (call.command) {
    const cmd = call.command.length > MAX_COMMAND_CHARS ? call.command.slice(0, MAX_COMMAND_CHARS) : call.command;
    flags.push(...commandRiskFlags(cmd, looksPowerShell(cmd) ? 'powershell' : 'posix'));
  }
  return flags;
}

/**
 * The risk flag of a turn's permissions, else null. `danger-full-access` is no sandbox at all, and with approval policy `never`
 * nothing asks either. `never` with a sandbox is NOT flagged: measured with `read-only` and `workspace-write`, a blocked action
 * fails inside the command instead of asking, so the policy confines the session. `on-request` and the others ask.
 */
function modeFlag(approval, sandbox) {
  if (sandbox !== 'danger-full-access') return null;
  return {
    axis: 'risk', code: 'mode-danger-full-access', evidence: 'structured',
    why: approval === 'never'
      ? 'The sandbox policy is danger-full-access and the approval policy is never: commands run without a sandbox and nothing asks.'
      : `The sandbox policy is danger-full-access: commands run without a sandbox${approval ? ` (approval policy ${trunc(approval, 40)})` : ''}.`,
  };
}

const ACCESS_ERROR = /Access to the path '[^'\n]{0,300}' is denied|Permission denied|Operation not permitted|Read-only file system|Access is denied/i;

/**
 * The heuristic outcome flag for a failed call whose output names an access error, else null. A sandbox block leaves no event
 * of its own (it is just a command that failed), so this is a guess from the text and the exit code. Not for a call that was
 * let out of the sandbox, and not under a policy with no sandbox.
 */
function accessDeniedFlag(text, exitCode, { escalated, sandbox }) {
  if (escalated || sandbox === 'danger-full-access' || exitCode === null || exitCode === 0) return null;
  if (typeof text !== 'string' || !ACCESS_ERROR.test(text.slice(0, 4096))) return null;
  return {
    axis: 'outcome', code: 'access-denied', evidence: 'heuristic',
    why: 'The call failed and its output reports an access error. Under a sandbox that can be a sandbox block; the rollout records no event for one, so this is a guess from the text.',
  };
}

// --- The guardian ------------------------------------------------------------------------------------------------------

const fold = (s) => String(s).replace(/\s+/g, ' ').trim();

// The balanced `{...}` that starts at `s[start]`, or null. String-aware, bounded.
function balanced(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  const limit = Math.min(s.length, start + OBJECT_CHARS);
  for (let i = start; i < limit; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

// Is the `"` at `s[i]` a string delimiter (an even number of backslashes before it) rather than an escaped quote?
function isDelimiter(s, i) {
  let n = 0;
  for (let k = i - 1; k >= 0 && s[k] === '\\'; k--) n++;
  return n % 2 === 0;
}

// The `{` that opens the JSON object around `s[at]`, where `s[at]` is outside any string: walked backwards, aware of
// strings, so a brace inside a command string is never counted. Bounded by OBJECT_CHARS; -1 when not found.
function enclosingOpen(s, at) {
  let depth = 0;
  let inStr = false;
  const stop = Math.max(0, at - OBJECT_CHARS);
  for (let i = at - 1; i >= stop; i--) {
    const c = s[i];
    if (c === '"' && isDelimiter(s, i)) { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '}') depth++;
    else if (c === '{') { if (depth === 0) return i; depth--; }
  }
  return -1;
}

const KEY = '"sandbox_permissions"';
const MAX_KEY_TRIES = 8;

/**
 * The call a guardian turn reviewed, out of its user message: the LAST JSON object that holds `command` and
 * `sandbox_permissions` (earlier ones are the parent's transcript, quoted). The key is looked for from the end; an
 * occurrence inside a string (an escaped quote) is skipped, and the object around a real one is found by a string-aware walk
 * back, so braces inside the command do not matter. `command` is an array whose last element is the command string, or a
 * string. `{ command: string | null }` or null.
 */
function guardianRequestOf(text) {
  if (typeof text !== 'string') return null;
  let at = text.lastIndexOf(KEY);
  for (let tries = 0; tries < MAX_KEY_TRIES && at >= 0; tries++, at = at > 0 ? text.lastIndexOf(KEY, at - 1) : -1) {
    if (!isDelimiter(text, at)) continue;
    const start = enclosingOpen(text, at);
    if (start < 0) continue;
    const obj = balanced(text, start);
    if (!obj) continue;
    let o;
    try { o = JSON.parse(obj); } catch { continue; }
    if (!isObject(o) || !('command' in o) || !('sandbox_permissions' in o)) continue;
    const argv = Array.isArray(o.command) ? o.command.filter((x) => typeof x === 'string') : null;
    const command = typeof o.command === 'string' ? o.command : argv && argv.length ? argv[argv.length - 1] : null;
    return { command: command === null ? null : command.slice(0, MAX_COMMAND_CHARS) };
  }
  return null;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 20) || 'unknown';

/**
 * The verdict in a guardian's last assistant message, or null: the short `{"outcome":"allow"}` or the full
 * `{"risk_level","user_authorization","outcome","rationale"}`. Every string is cut.
 */
function guardianVerdictOf(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!t.startsWith('{') || t.length > OBJECT_CHARS) return null;
  let o;
  try { o = JSON.parse(t); } catch { return null; }
  if (!isObject(o) || typeof o.outcome !== 'string' || !o.outcome) return null;
  const str = (v, max) => (typeof v === 'string' ? trunc(v, max) : '');
  return { outcome: trunc(o.outcome, 40), riskLevel: str(o.risk_level, 20), userAuthorization: str(o.user_authorization, 20), rationale: str(o.rationale, 300) };
}

/**
 * Pairs the escalated calls of one lane with the guardian's turns, `[verdict | null]` per call. BY ORDER, CONFIRMED BY
 * COMMAND TEXT: the guardian reviews calls in the order they were made, so each turn, in order, goes to the next call (after
 * the last one paired) with the same command text. A call with no review (a rule already approved it) is passed over and keeps
 * no verdict; a review whose command no later call has (the call's command was built in code) pairs with nothing. Neither
 * moves a verdict onto another command. What it cannot tell apart: an unreviewed call followed by a reviewed one with the same
 * text, where the first takes the verdict. A call whose command is unknown is never paired, and neither is a turn whose request
 * could not be read.
 */
function matchVerdicts(escalations, turns) {
  const out = new Array(escalations.length).fill(null);
  const want = escalations.map((e) => (e.command === null || e.command === undefined ? null : fold(e.command)));
  let ptr = 0;
  for (const t of turns) {
    if (t.command === null || t.command === undefined) continue;
    const f = fold(t.command);
    for (let i = ptr; i < want.length; i++) {
      if (want[i] === f) { out[i] = t.verdict; ptr = i + 1; break; }
    }
  }
  return out;
}

/** The flags a guardian verdict gives its call. */
function verdictFlags(v) {
  if (!v) return [];
  const flags = [];
  if (v.riskLevel && v.riskLevel !== 'low') {
    flags.push({
      axis: 'risk', code: `guardian-risk-${slug(v.riskLevel)}`, evidence: 'structured',
      why: `The guardian reviewed this call with risk_level ${v.riskLevel}${v.userAuthorization ? ` and user_authorization ${v.userAuthorization}` : ''}.${v.rationale ? ` ${v.rationale}` : ''}`,
    });
  }
  if (v.outcome === 'allow') {
    flags.push({ axis: 'outcome', code: 'guardian-allowed', evidence: 'structured', why: 'The guardian allowed this call to run outside the sandbox.' });
  } else {
    flags.push({
      axis: 'outcome', code: 'guardian-refused', evidence: 'structured',
      why: `The guardian answered "${v.outcome}", not allow, so the call was not let out of the sandbox.${v.rationale ? ` ${v.rationale}` : ''}`,
    });
  }
  return flags;
}

module.exports = {
  shellCallsOf, callFlags, modeFlag, accessDeniedFlag, guardianRequestOf, guardianVerdictOf, matchVerdicts, verdictFlags,
  readObjectLiteral, SHELL_NAMES, SCRIPT_TOOL,
};
