'use strict';
// Codex's half of the session-changes read (#870, spec 47): it finds the edits, commits and pushes in a rollout's lines and
// feeds the neutral accumulator (`../change-events.js`). Everything Codex-specific lives here. Codex is `limited`, and the
// limits are the shape of what a rollout records (`docs/backend-formats.md`, "File edits, commits and pushes", Codex):
//   - an EDIT is read from the apply-patch text only: the `*** Add File:`, `*** Update File:`, `*** Delete File:` and
//     `*** Move to:` lines of a patch inside an `exec` script (`custom_tool_call`) or an older shell / `apply_patch` function
//     call. A shell write (`sed -i`, a redirect) names no file in a way we can attribute, so it is not counted.
//   - an edit counts only on a POSITIVE signal: `Script completed` for an exec script, `Exit code: 0` for a function call. A failed
//     patch answers `Script failed` (measured); a refusal or an output with no signal counts nothing. A script that catches a
//     failed patch itself still reports `Script completed`, an over-count the capability row names.
//   - the patch text is read only where it is an argument: the string given to `tools.apply_patch(...)` in an exec script, or the
//     argument of a call whose command word (or tool name) is `apply_patch`. A marker counts only at the start of a patch line.
//   - a COMMIT or a PUSH is read from the output only when the script holds exactly ONE shell command: with two commands the
//     printed parts carry no command id, and pairing them by order would attribute a commit to the wrong command.
//
// How a delete and a rename count: a delete is an edit of that path (one count). A move is two: the `Update File:` line is an
// edit of the source (counted once) and the `Move to:` line an edit of the destination (counted once), so a renamed file shows
// on both paths. The model decides later what a pair means; this reader does not pair them.
//
// `position` is the byte offset of the OUTPUT line (the line that proves the call ran), given by the caller's cursor and asked
// for only when an output settles a call this extractor is waiting for. A shell call's command string is passed to
// `gitCommandsIn` as the script's own `cmd`, and for a `bash -lc <payload>` argv as `argv[2]`, never as the joined argv.

const { createAccumulator, MAX_PENDING } = require('../change-events');
const { gitCommandsIn, commitFrom, pushFrom } = require('../git-command-events');
const { shellCallsOf, looksPowerShell, SHELL_NAMES, SCRIPT_TOOL } = require('./shell-calls');   // not `./flow-flags`: that pulls the flow reader's primitives into descriptor load

const MAX_TEXT_CHARS = 200000;      // a script, an argument blob or an output read for a call
const MAX_PATCH_PATHS = 64;         // paths one call may name
// A marker counts only at the start of a patch line: the start of the text or after a real newline (a string literal is
// unescaped first, `literalAt`). One that follows `+`, `-`, a space or a quote is the content of a patched file (or a mention), never grammar.
const PATCH_LINE = /(?:^|\n)\*\*\* (Add File|Update File|Delete File|Move to): ([^\r\n"'`\\]+)/g;
// `apply_patch` as the command word, optionally after a lone `cd <dir> &&`. The paths in the patch stay as written: they are
// relative to that directory and are not rebased.
const PATCH_COMMAND_WORD = /^\s*(?:cd\s+(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|"']+)\s*&&\s*)?(?:apply_patch|applypatch)(?![\w.-])/;
const MAX_PATCH_ARGS = 8;
const MAX_LITERAL_CHARS = 262144;
const SHELL_CALL_IN_SCRIPT = /\btools\.(?:exec_command|shell|shell_command|local_shell)\s*\(/g;
const SHELL_WRAPPER = /^(?:ba|z|da|k)?sh$|^(?:pwsh|powershell)(?:\.exe)?$/i;
const POWERSHELL_WRAPPER = /^(?:pwsh|powershell)(?:\.exe)?$/i;

/**
 * The files an apply-patch text names, in order. The text is the patch itself (a string literal already unescaped), so a line
 * ends at a REAL newline and a marker counts only at the start of the text or of a line. A path with a backslash, a quote or a
 * backtick is cut there, which only under-reports.
 */
function patchPathsIn(text) {
  const out = [];
  PATCH_LINE.lastIndex = 0;
  let m;
  while (out.length < MAX_PATCH_PATHS && (m = PATCH_LINE.exec(text))) {
    const p = m[2].trim();
    if (p) out.push(p);
  }
  return out;
}

const SIMPLE_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'", '`': '`' };

/**
 * The VALUE of the string literal opening at `s[i]`, or null. A quote ends it unless a backslash escapes it. The escapes are
 * unescaped (an escaped `n` becomes a real newline), so a patch that carries escaped patch text as file content stays one line
 * of content. A template literal with `${`, or an escape this does not know (a line continuation, an octal), gives up: nothing
 * is read.
 */
function literalAt(s, i) {
  const q = s[i];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  const limit = Math.min(s.length, i + 1 + MAX_LITERAL_CHARS);
  let out = '';
  for (let j = i + 1; j < limit; j++) {
    const c = s[j];
    if (c === q) return out;
    if (q === '`' && c === '$' && s[j + 1] === '{') return null;
    if (c !== '\\') { out += c; continue; }
    const e = s[++j];
    if (e === 'u') {
      const h = /^(?:\{([0-9a-fA-F]{1,6})\}|([0-9a-fA-F]{4}))/.exec(s.slice(j + 1, j + 9));
      if (!h) return null;
      const cp = parseInt(h[1] || h[2], 16);
      if (cp > 0x10FFFF) return null;
      out += String.fromCodePoint(cp);
      j += h[0].length;
    } else if (e === 'x') {
      const h = /^[0-9a-fA-F]{2}/.exec(s.slice(j + 1, j + 3));
      if (!h) return null;
      out += String.fromCharCode(parseInt(h[0], 16));
      j += 2;
    } else if (e !== undefined && Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, e)) {
      out += SIMPLE_ESCAPES[e];
    } else return null;
  }
  return null;
}

/**
 * The patch texts an `exec` script hands to `tools.apply_patch(...)`: a string literal argument, or an identifier whose
 * `const|let|var` initialiser is a string literal. Anything else (built in code, concatenated) is unknown and not read; text
 * elsewhere in the script (a comment, a printed marker, a heredoc) is never read.
 */
function patchArgsOfScript(script) {
  const out = [];
  const re = /\btools\.apply_patch\s*\(\s*/g;
  const declared = new Map(); // identifier -> its literal value or null, so each declaration is searched once
  let m;
  // Bounded by ATTEMPTS, not by results: a call whose argument cannot be read still counts against the cap, or a script of
  // many such calls would rescan itself once per call.
  for (let attempts = 0; attempts < MAX_PATCH_ARGS && (m = re.exec(script)); attempts++) {
    const at = m.index + m[0].length;
    let lit = literalAt(script, at);
    if (lit === null) {
      const id = /^[A-Za-z_$][\w$]*/.exec(script.slice(at, at + 128));
      if (id) {
        if (!declared.has(id[0])) {
          const decl = new RegExp('\\b(?:const|let|var)\\s+' + id[0].replace(/\$/g, '\\$') + '\\s*=\\s*').exec(script);
          declared.set(id[0], decl ? literalAt(script, decl.index + decl[0].length) : null);
        }
        lit = declared.get(id[0]);
      }
    }
    if (lit !== null) out.push(lit);
  }
  return out;
}

const quoteWord =(w) => (/[\s'"]/.test(w) ? `'${w.replace(/'/g, "'\\''")}'` : w);

/**
 * The patch text of an `apply_patch` function call: the arguments are JSON, and the patch is the string in them (`input`,
 * `patch` or `command`) once unescaped. Arguments that are not JSON are the patch text itself. Anything else reads nothing.
 */
function applyPatchArgument(raw) {
  let a;
  try { a = JSON.parse(raw); } catch { return raw; }
  if (typeof a === 'string') return a;
  if (!a || typeof a !== 'object') return null;
  for (const k of ['input', 'patch', 'command']) if (typeof a[k] === 'string') return a[k];
  return null;
}

/** The command of a shell function call: `{ command, dialect, patchText }`, or null. */
function functionCallCommand(name, raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_TEXT_CHARS) return null;
  if (name === 'apply_patch') return { command: null, dialect: 'posix', patchText: applyPatchArgument(raw) };
  if (!SHELL_NAMES.has(name)) return null;
  let a;
  try { a = JSON.parse(raw); } catch { return null; }
  if (!a || typeof a !== 'object') return null;
  const str = typeof a.cmd === 'string' ? a.cmd : typeof a.command === 'string' ? a.command : null;
  // A patch is read only where `apply_patch` is the command word: a heredoc, a grep or an echo that names the markers is not one.
  if (str !== null) return { command: str, dialect: looksPowerShell(str) ? 'powershell' : 'posix', patchText: PATCH_COMMAND_WORD.test(str) ? str : null };
  if (!Array.isArray(a.command)) return null;
  const argv = a.command.filter((x) => typeof x === 'string');
  if (!argv.length) return null;
  // `bash -lc <payload>`: the payload is the command, not the joined argv.
  if (argv.length >= 3 && SHELL_WRAPPER.test(argv[0].replace(/^.*[\\/]/, '')) && /^-\w*c$/.test(argv[1])) {
    return { command: argv[2], dialect: POWERSHELL_WRAPPER.test(argv[0].replace(/^.*[\\/]/, '')) ? 'powershell' : 'posix', patchText: PATCH_COMMAND_WORD.test(argv[2]) ? argv[2] : null };
  }
  // No wrapper: the command word is argv[0], and the patch is what follows it.
  const word = argv[0].replace(/^.*[\\/]/, '');
  return { command: argv.map(quoteWord).join(' '), dialect: 'posix', patchText: /^(?:apply_patch|applypatch)$/.test(word) ? argv.slice(1).join('\n') : null };
}

/** A function call's output that says the patch was refused or never applied, in words with no failure header: its FIRST output line only. */
const NOT_APPLIED = /^\s*(?:patch rejected|aborted)/i;

/**
 * What a call's output says: `{ ok, body }`. `ok` is a POSITIVE signal only (`Script completed` for an exec script, `Exit code: 0`
 * or a zero `exit_code` for a function call): an edit counts on it, and an output with no signal, a failure or a refusal text
 * does not. `body` is what the script printed (the header part is dropped).
 */
function outputOf(p) {
  const out = p.output;
  if (p.type === 'custom_tool_call_output') {
    const parts = [];
    if (typeof out === 'string') parts.push(out);
    else if (Array.isArray(out)) for (const part of out) if (part && typeof part.text === 'string') parts.push(part.text);
    const body = (typeof out === 'string' ? out : parts.slice(1).join('\n')).slice(0, MAX_TEXT_CHARS);
    // A script that completed ran: whatever it printed after the header (even the word `aborted`) is its own output.
    return { ok: /^Script completed/.test(parts[0] || ''), body };
  }
  let text = typeof out === 'string' ? out : '';
  let exit = null;
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text);
      if (j && typeof j.output === 'string') {
        text = j.output;
        if (j.metadata && typeof j.metadata.exit_code === 'number') exit = j.metadata.exit_code;
      }
    } catch { /* plain text */ }
  }
  const m = /^Exit code: (-?\d+)/.exec(text);
  if (m) exit = Number(m[1]);
  const header = /^Output:\r?\n/m.exec(text);
  const firstLine = header ? text.slice(header.index + header[0].length) : text;
  return { ok: exit === 0 && !NOT_APPLIED.test(text) && !NOT_APPLIED.test(firstLine), body: text.slice(0, MAX_TEXT_CHARS) };
}

function createCodexChangeExtractor() {
  const acc = createAccumulator();
  const calls = new Map(); // call id -> { edits, commit, push, amend, force }  (insertion order = age)

  const remember = (id, call) => {
    calls.delete(id);
    calls.set(id, call);
    while (calls.size > MAX_PENDING) calls.delete(calls.keys().next().value);
  };

  const noteEdits = (id, call, text) => {
    for (const path of patchPathsIn(text)) {
      if (acc.noteEdit(path, { callId: `${id}#${call.edits}` })) call.edits++;
    }
  };

  const noteGit = (call, command, dialect) => {
    for (const f of gitCommandsIn(command, { dialect })) {
      if (f.kind === 'commit') { call.commit = true; if (f.amend) call.amend = true; }
      else if (f.kind === 'push') { call.push = true; if (f.force) call.force = true; }
    }
  };

  function noteScript(id, input) {
    const text = input.length > MAX_TEXT_CHARS ? input.slice(0, MAX_TEXT_CHARS) : input;
    const call = { edits: 0, commit: false, push: false, amend: false, force: false };
    for (const patch of patchArgsOfScript(text)) noteEdits(id, call, patch);
    // Output pairs with a command only when the script holds exactly one (the printed parts carry no command id).
    const shell = shellCallsOf('custom_tool_call', SCRIPT_TOOL, text);
    if (shell.length === 1 && shell[0].command && (text.match(SHELL_CALL_IN_SCRIPT) || []).length === 1) {
      noteGit(call, shell[0].command, looksPowerShell(shell[0].command) ? 'powershell' : 'posix');
    }
    if (call.edits || call.commit || call.push) remember(id, call);
  }

  function noteFunction(id, name, raw) {
    const c = functionCallCommand(name, raw);
    if (!c) return;
    const call = { edits: 0, commit: false, push: false, amend: false, force: false };
    if (c.patchText) noteEdits(id, call, c.patchText);
    if (c.command) noteGit(call, c.command, c.dialect);
    if (call.edits || call.commit || call.push) remember(id, call);
  }

  function settle(id, p, entry, cursor) {
    const call = calls.get(id);
    if (!call) return;
    calls.delete(id);
    const position = cursor.offset();
    const at = Date.parse(entry.timestamp);
    const when = Number.isFinite(at) ? at : null;
    const out = outputOf(p);
    for (let i = 0; i < call.edits; i++) acc.resolve(`${id}#${i}`, { error: !out.ok, position, at: when });
    if (call.commit) {
      const c = commitFrom(out.body, { amend: call.amend });
      if (c) acc.noteCommit({ ...c, position, at: when });
    }
    if (call.push) {
      const r = pushFrom(out.body);
      if (r) acc.notePush({ ...r, force: call.force, position, at: when });
    }
  }

  /**
   * Fold one parsed rollout line. `cursor.offset()` is the byte offset of this line; it is called only for a line that settles
   * a call, so a rollout without edits costs no offset work.
   */
  function feed(entry, cursor) {
    if (entry.type !== 'response_item') return;
    const p = entry.payload;
    if (!p || typeof p !== 'object' || typeof p.call_id !== 'string') return;
    switch (p.type) {
      case 'custom_tool_call':
        if (p.name === SCRIPT_TOOL && typeof p.input === 'string') noteScript(p.call_id, p.input);
        break;
      case 'function_call':
        noteFunction(p.call_id, p.name, p.arguments);
        break;
      case 'custom_tool_call_output':
      case 'function_call_output':
        settle(p.call_id, p, entry, cursor);
        break;
      default:
        break;
    }
  }

  return {
    feed,
    toRow: acc.toRow,
    get revision() { return acc.revision; },
  };
}

module.exports = { createCodexChangeExtractor, patchPathsIn };
