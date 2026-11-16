'use strict';
// git's own command line and output language, which no CLI owns (#870, spec 47 section 1). Backend-neutral, like
// `flow-command-patterns.js`: it finds `git commit` / `git push` in a command string and reads a commit or a push out of the
// command's output. A backend's extractor decides how it FINDS the command and its output; this module only reads them.
//
// Quoting: the command is cut into simple commands by `splitSegments` (`;`, `&&`, `||`, a lone `&`, a newline, outside quotes),
// so `echo "git commit"` is an `echo`, and quoted text is data. A pipeline is cut into its stages here, so `git commit | tail`
// and `echo x | git commit -F -` both find the commit. `git -C <dir> commit` and the other global options are skipped.
//
// A commit is decided by its OUTPUT (`[branch sha] subject`), never by an error flag: a chained commit whose push was refused
// is an error result that still holds the commit line. A command whose output hides that line (`| tail -1`) yields no commit.
//
// What it does not read, on purpose (an under-report, never a wrong claim): `git push --porcelain` (a different output
// format), `git commit -q` (no bracket line), and any push result of a localized git (the push lines, `Everything
// up-to-date` and the failure texts are matched in git's English wording; the commit line is not, see `commitFrom`).
// A heredoc body or a `-m` message that spells `git commit` can still match as a command, so the caller requires the
// OUTPUT line (`commitFrom` / `pushFrom` returning non-null) before it records anything.
//
// Bounded and linear: the command and the output are cut to fixed lengths, every scan is one pass, and the regexes have no
// nested quantifiers. An output over the character cap is read as its head half and its tail half: a hook prints before the
// commit line, and a push prints its ref lines last.

const { splitSegments } = require('./flow-patterns');

const MAX_COMMAND_CHARS = 8192;
const MAX_OUTPUT_CHARS = 65536;
const MAX_INSIDE_CHARS = 300;     // the text between the brackets of a commit line
const MAX_SEGMENT_CHARS = 2048;
const MAX_TOKENS = 64;
const MAX_FOUND = 8;
const MAX_SUBJECT_CHARS = 200;
const MAX_SUMMARY_CHARS = 120;

const PREFIX_WORDS = new Set(['sudo', 'doas', 'env', 'time', 'nohup', 'command', 'exec', 'builtin', 'nice', 'xargs', 'then', 'do', 'else', '(', '{', '!']);
const WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'cmd', 'pwsh', 'powershell']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// git global options that take their value as the NEXT word (`--git-dir=x` carries its own).
const GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);

/** Cuts one simple command into pipeline stages of unquoted words. Bounded; the quote characters are removed. */
function stagesOf(raw, dialect) {
  const esc = dialect === 'powershell' ? '`' : '\\';
  const text = raw.length > MAX_SEGMENT_CHARS ? raw.slice(0, MAX_SEGMENT_CHARS) : raw;
  const stages = [];
  let tokens = [];
  let word = '';
  let has = false;
  let q = null;
  let count = 0;
  const endWord = () => {
    if (has && count < MAX_TOKENS) { tokens.push(word); count++; }
    word = ''; has = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === q) q = null;
      // The same rule as `splitSegments`: in POSIX only these four are escapes inside double quotes (`"C:\Program Files"` keeps its backslash).
      else if (q === '"' && c === esc && i + 1 < text.length && (esc === '`' || '"\\$`'.includes(text[i + 1]))) { word += text[++i]; }
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; has = true; }
    else if (c === esc && i + 1 < text.length) { word += text[++i]; has = true; }
    else if (c === ' ' || c === '\t' || c === '\r') endWord();
    else if (c === '|') { endWord(); if (tokens.length) stages.push(tokens); tokens = []; count = 0; }
    else { word += c; has = true; }
  }
  endWord();
  if (tokens.length) stages.push(tokens);
  return stages;
}

function baseName(token) {
  const parts = token.split(/[\\/]/);
  return parts[parts.length - 1].toLowerCase().replace(/\.exe$/, '');
}

/** `{ kind, amend, force }` when this stage is `git commit` / `git push`, else null. */
function gitStage(tokens) {
  let i = 0;
  while (i < tokens.length && i < 8 && (ASSIGNMENT.test(tokens[i]) || PREFIX_WORDS.has(tokens[i]))) i++;
  if (i >= tokens.length) return null;
  const head = tokens[i].replace(/^[({!]+/, ''); // `(git commit)`, `{ git push; }`, `!git ...`
  if (baseName(head) !== 'git') return null;
  i++;
  for (let steps = 0; i < tokens.length && steps < 16; steps++) {
    const t = tokens[i];
    if (!t.startsWith('-')) break;
    i += GLOBAL_WITH_VALUE.has(t) ? 2 : 1;
  }
  const sub = typeof tokens[i] === 'string' ? tokens[i].replace(/[)}]+$/, '') : undefined;
  if (sub !== 'commit' && sub !== 'push') return null;
  let amend = false;
  let force = false;
  let dry = false;
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j];
    if (t === '--dry-run' || (sub === 'push' && t === '-n')) dry = true;
    else if (sub === 'commit' && t === '--amend') amend = true;
    else if (sub === 'push' && (t === '-f' || t === '--force' || t.startsWith('--force-with-lease') || t === '--force-if-includes' || t[0] === '+')) force = true;
  }
  if (dry) return null; // a dry run changes nothing and prints no commit line
  return sub === 'commit' ? { kind: 'commit', amend } : { kind: 'push', force };
}

function scan(text, dialect, depth, found) {
  for (const seg of splitSegments(text, dialect)) {
    if (found.length >= MAX_FOUND) return;
    const stages = stagesOf(seg.raw, dialect);
    for (const tokens of stages) {
      const hit = gitStage(tokens);
      if (hit) found.push(hit);
      if (found.length >= MAX_FOUND) return;
    }
    // `bash -c "git commit ..."`, `pwsh -Command '...'`: the quoted payload is a command (one level).
    if (depth < 1 && stages.length) {
      const first = stages[0][0];
      if (first && WRAPPERS.has(baseName(first))) {
        for (const payload of seg.quoted) scan(payload.slice(0, MAX_COMMAND_CHARS), dialect, depth + 1, found);
      }
    }
  }
}

/**
 * The `git commit` / `git push` invocations in a command line, in order: `[{ kind: 'commit', amend }, { kind: 'push', force }]`.
 * `opts.dialect` is 'posix' (default) or 'powershell'. A dry run is not an invocation. Pure; at most 8 results.
 */
function gitCommandsIn(command, opts) {
  if (typeof command !== 'string' || !command) return [];
  const found = [];
  scan(command.length > MAX_COMMAND_CHARS ? command.slice(0, MAX_COMMAND_CHARS) : command, opts && opts.dialect, 0, found);
  return found;
}


/**
 * The lines to scan. An output within the character cap is read whole. A longer one is read as its head half and its tail
 * half (the middle is dropped, and the first line of the tail is dropped because the cut may have split it).
 */
function linesOf(output) {
  if (typeof output !== 'string' || !output) return [];
  let text = output;
  if (text.length > MAX_OUTPUT_CHARS) {
    const half = MAX_OUTPUT_CHARS >> 1;
    let tail = text.slice(text.length - half);
    const nl = tail.indexOf('\n');
    tail = nl === -1 ? '' : tail.slice(nl + 1);
    text = text.slice(0, half) + '\n' + tail;
  }
  return text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

const SHA_TOKEN = /^[0-9a-f]{7,40}$/;

/**
 * `[main 9f3c2ab] subject`, `[main (root-commit) 1a2b3c4] subject`, `[detached HEAD 5d6e7f8] subject`, and a localized git's
 * `[main (commit racine) 1a2b3c4] subject`: the last word inside the brackets is the SHA, a trailing parenthesised word group
 * is a label and dropped, the rest is the branch (or git's own detached label). Hand-parsed, so it stays linear.
 */
function commitLine(line) {
  if (line.charCodeAt(0) !== 91) return null;
  const close = line.indexOf(']');
  if (close < 2 || close > MAX_INSIDE_CHARS || line[close + 1] !== ' ') return null;
  const inside = line.slice(1, close);
  const sp = inside.lastIndexOf(' ');
  if (sp < 1) return null;
  const sha = inside.slice(sp + 1);
  if (!SHA_TOKEN.test(sha)) return null;
  let label = inside.slice(0, sp);
  if (label.endsWith(')')) {
    const open = label.lastIndexOf(' (');
    if (open > 0 && label.indexOf(')', open) === label.length - 1) label = label.slice(0, open);
  }
  const subject = line.slice(close + 2).trim();
  if (!label || !subject) return null;
  return { sha, branch: label, subject: subject.slice(0, MAX_SUBJECT_CHARS) };
}

/**
 * The new commit a `git commit` printed: `{ sha, subject, branch, amend? } | null`. The first bracket line wins. Never decided by an
 * error flag (the caller does not pass one). `opts.amend` is the command's `--amend`, since the output cannot tell an amend from a
 * commit with its own `--date`.
 */
function commitFrom(output, opts) {
  for (const line of linesOf(output)) {
    const commit = commitLine(line);
    if (!commit) continue;
    if (opts && opts.amend === true) commit.amend = true;
    return commit;
  }
  return null;
}

// ` <flag> <summary> <from> -> <to> (reason)`: flag ' ' fast-forward, '+' forced, '*' new, '-' deleted, '=' current, '!' refused.
const REF_LINE = /^ ([ +*=!-]) (\[[^\]]+\]|\S+)\s+(\S+) -> (\S+)(?: \((.*)\))?\s*$/;
// ` - [deleted]         feat/x` (`git push --delete`) has no arrow.
const DELETED_LINE = /^ - \[deleted\]\s+(\S+)\s*$/;
const PUSH_FAILED = /^(?:error: failed to push some refs|error: src refspec|fatal: .*(?:upstream branch|remote repository|unable to access|Authentication failed|does not appear to be a git repository))/;
const VERB = { '*': 'new branch', '+': 'forced update', '-': 'deleted', '=': 'up-to-date', '!': 'rejected', ' ': 'updated' };

/**
 * What a `git push` printed: `{ ok, summary, upToDate?, moved? } | null` (`null` when the output holds no push result, for example
 * after `| tail`, or a localized git). `ok` is false when any ref was refused or git said it failed to push; `moved: true` says
 * that at least one ref still moved in such a push (a partial push), so it cuts a Split block. The summary names the refused
 * ref first and never carries the remote URL (it can hold a token or a path).
 */
function pushFrom(output) {
  let refs = 0;
  let refused = 0;
  let moved = 0;
  let failed = false;
  let upToDate = false;
  let first = null;
  let firstRefused = null;
  for (const line of linesOf(output)) {
    if (line === 'Everything up-to-date') { upToDate = true; continue; }
    if (PUSH_FAILED.test(line)) { failed = true; continue; }
    let ref = null;
    const m = REF_LINE.exec(line);
    if (m) ref = { flag: m[1], dst: m[4], reason: m[5] };
    else {
      const d = DELETED_LINE.exec(line);
      if (d) ref = { flag: '-', dst: d[1], reason: undefined };
    }
    if (!ref) continue;
    refs++;
    if (ref.flag === '!') { refused++; if (!firstRefused) firstRefused = ref; }
    else if (ref.flag !== '=') moved++;
    if (!first) first = ref;
  }
  if (!refs && !upToDate && !failed) return null;
  const ok = !failed && !refused;
  const lead = firstRefused || first;
  let summary;
  if (!lead) summary = upToDate ? 'up-to-date' : 'push failed';
  else {
    summary = `${VERB[lead.flag]} ${lead.dst}`;
    if (lead.flag === '!' && lead.reason) summary += ` (${lead.reason})`;
    if (refs > 1) summary += ` +${refs - 1} more`;
  }
  const result = { ok, summary: summary.slice(0, MAX_SUMMARY_CHARS) };
  if (!ok && moved > 0) result.moved = true;
  if (ok && !moved && (upToDate || refs)) result.upToDate = true;
  return result;
}

module.exports = {
  gitCommandsIn, commitFrom, pushFrom,
  MAX_COMMAND_CHARS, MAX_OUTPUT_CHARS, MAX_SEGMENT_CHARS, MAX_FOUND,
};
