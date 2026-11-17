'use strict';
// How a shell call is written in a Codex rollout, and nothing else (the format half that two readers share): the session
// flow's flags (`./flow-flags.js`) and the session-changes extractor (`./change-events.js`) both need to find the command of a
// call. It lives here, with no `flow-*` dependency, because `change-events.js` is loaded with the parser at descriptor load,
// and the flow readers must stay lazy (spec 46, `test/flow-snapshot.test.js`: requiring the registry loads no flow reader).
//
// Measured on local rollouts (docs/backend-formats.md, #826 Codex): the shell is `custom_tool_call` `exec` whose `input` is a
// SCRIPT calling `tools.exec_command({ ... })` with an object literal, written as JSON in most scripts and as a JavaScript
// literal (unquoted keys, template strings, `${}` interpolation) in some. Only a literal string `cmd` is read; a command built
// in code is unknown (`command: null`).

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const SHELL_NAMES = new Set(['exec_command', 'shell', 'shell_command', 'local_shell']);
const SCRIPT_TOOL = 'exec';
const SCRIPT_CHARS = 64 * 1024;
const OBJECT_CHARS = 16 * 1024;
const MAX_CALLS = 8;
const MAX_ATTEMPTS = 16;   // shell-call literals tried per script, read or not
const ESCALATED = 'require_escalated';

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

// The shell is PowerShell on Windows (a guardian request names `pwsh.exe`); a call does not say which, so a cmdlet-shaped word
// or `$env:` decides the dialect of the escape character. A guess, and it only changes how a backtick or a backslash is read.
const looksPowerShell = (cmd) => /\$env:|\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b|\bpwsh\b/.test(cmd);

module.exports = { shellCallsOf, readObjectLiteral, looksPowerShell, SHELL_NAMES, SCRIPT_TOOL, OBJECT_CHARS };
