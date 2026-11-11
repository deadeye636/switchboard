'use strict';
// A bounded matcher for "potentially destructive command" lists (spec 46, #826 requirement 11). Backend-neutral: it
// knows shell GRAMMAR (quotes, separators, a leading `sudo`) and no backend id, tool name or record field (CLAUDE.md
// reflex 5). Each backend folder owns its list and calls `matchPatterns(list, command)`.
//
// A pattern entry is `{ id, test, reason, view? }`:
//   - `test`: a RegExp without the `g` or `y` flag, written to be linear on its own (no nested quantifiers; a
//     `[^\n]*` scan followed by a literal; lookaheads for "somewhere later in this command"). The matcher also bounds
//     its input, so a bad pattern costs a bounded amount, not forever.
//   - `reason`: one English sentence saying why the command is risky.
//   - `view`: `'command'` (default) tests the command with its quote characters removed and its leading words
//     (`sudo`, `env X=1`, `time`, a `(`, a path on the command word, ...) stripped, so the regex anchors with `^` on the
//     command word: `echo "rm -rf /"` starts with `echo` and never matches. `'blanked'` tests the command with every
//     quoted span replaced by spaces and is for a pattern that is not anchored on a command word (a redirect); text
//     inside quotes cannot match it.
//
// Quoting rule: the command is cut into simple commands at `;`, `&&`, `||`, a lone `&` and a newline, only OUTSIDE
// quotes. A pipeline is tested whole and each of its parts on its own, so `curl x | sh` and `cat f | xargs ...` anchor on the
// right word. A leading `(`, `{`, `!` or `\`, and a path on the command word (`/bin/rm`), are dropped before the anchor; the
// options of `sudo`, `nice`, `env` and `doas` that take an argument (`sudo -u root`) are skipped with it. A `sh -c "..."`,
// `eval`, `cmd /c` or `pwsh -Command` wrapper has its quoted payload scanned once more (two levels at most). Not looked into:
// command substitution (`$(...)`, backticks), here-documents, aliases and variables (`rm -rf $DIR`). The list is a heuristic,
// and every match says so.
//
// `dialect` ('posix' by default, or 'powershell'): which character escapes. In POSIX it is the backslash; in PowerShell it is
// the backtick, and a backslash is an ordinary character there (`C:\Users`).

const MAX_COMMAND_CHARS = 8192;
const MAX_SEGMENTS = 64;
const MAX_MATCHES = 8;
const MAX_DEPTH = 2;
const MAX_PAYLOADS = 3;
const FRAGMENT_CHARS = 80;

const PREFIX_WORD = /^(sudo|doas|time|nohup|command|builtin|exec|nice|env|then|do|else)(?=\s)\s*/;
// Options of a prefix word that take an argument of their own (`sudo -u root rm ...`, `nice -n 5 rm ...`, `env -u X rm ...`).
const PREFIX_ARG_OPTIONS = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U']),
  doas: new Set(['-u', '-C']),
  nice: new Set(['-n']),
  env: new Set(['-u', '-C', '-S']),
};
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s*/;
const OPTION = /^(-\S*)\s*/;
const LEADING_JUNK = /^[\s({!\\]+/;
// A path on the command word: `/bin/rm`, `./rm`, `C:\Windows\System32\cmd.exe` give the last segment.
const COMMAND_PATH = /^(?:[A-Za-z]:)?[\\/]?(?:[\w.@+~-]+[\\/])+([\w.+-]+)(?=\s|$)/;
const WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'eval', 'cmd', 'pwsh', 'powershell']);
const WRAPPER_FLAG = /\s(?:\/[ck]|-c|-command)\s+(?=\S)/i;
const FIRST_WORD = /^[A-Za-z][A-Za-z0-9_.-]*/;

/** Removes the words in front of the command proper. Bounded: eight rounds, six options per prefix word. */
function stripPrefix(text) {
  let s = text;
  for (let i = 0; i < 8; i++) {
    s = s.replace(LEADING_JUNK, '');
    const path = COMMAND_PATH.exec(s);
    if (path) s = path[1] + s.slice(path[0].length);
    const word = PREFIX_WORD.exec(s);
    if (word) {
      s = s.slice(word[0].length);
      const takesArg = PREFIX_ARG_OPTIONS[word[1]];
      for (let j = 0; j < 6; j++) {
        const opt = OPTION.exec(s);
        if (!opt) break;
        s = s.slice(opt[0].length);
        if (takesArg && takesArg.has(opt[1])) {
          const arg = /^\S+\s*/.exec(s);
          if (arg) s = s.slice(arg[0].length);
        }
      }
      continue;
    }
    const as = ASSIGNMENT.exec(s);
    if (!as) break;
    s = s.slice(as[0].length);
  }
  return s.replace(LEADING_JUNK, '');
}

/**
 * Cuts a command into simple commands outside quotes. Each segment: `{ raw, bare, blank, parts, quoted }`: the text as
 * written, with the quote characters removed, with every quoted span blanked, the pipe parts of `bare`, and the contents
 * of the quoted spans (first few).
 */
function splitSegments(text, dialect) {
  const esc = dialect === 'powershell' ? '`' : '\\';
  const out = [];
  let raw = '';
  let bare = '';
  let blank = '';
  let part = '';
  let parts = [];
  let quoted = [];
  let q = null;
  let content = '';
  const n = text.length;

  const flush = () => {
    if (raw.trim()) {
      parts.push(part);
      out.push({ raw, bare, blank, parts: parts.length > 1 ? parts : [], quoted });
    }
    raw = ''; bare = ''; blank = ''; part = ''; parts = []; quoted = []; content = '';
  };
  const add = (r, b, k) => { raw += r; bare += b; blank += k; part += b; };

  for (let i = 0; i < n && out.length < MAX_SEGMENTS; i++) {
    const c = text[i];
    if (q) {
      // POSIX: only these four are escapes inside double quotes (`C:\Users` keeps its backslash). PowerShell: the backtick escapes anything.
      if (q === '"' && c === esc && i + 1 < n && (esc === '`' || '"\\$`'.includes(text[i + 1]))) {
        add(c + text[i + 1], text[i + 1], '  ');
        content += text[i + 1];
        i += 1;
      } else if (c === q) {
        raw += c;
        if (quoted.length < MAX_PAYLOADS) quoted.push(content);
        content = '';
        q = null;
      } else {
        add(c, c, ' ');
        content += c;
      }
      continue;
    }
    if (c === esc && i + 1 < n) {
      add(c + text[i + 1], c + text[i + 1], c + text[i + 1]);
      i += 1;
    } else if (c === '"' || c === "'") {
      q = c;
      raw += c;
    } else if (c === '\n' || c === ';') {
      flush();
    } else if (c === '&') {
      if (text[i + 1] === '&') { flush(); i += 1; }
      else if (text[i - 1] === '>' || text[i + 1] === '>') add(c, c, c);
      else flush();
    } else if (c === '|') {
      if (text[i + 1] === '|') { flush(); i += 1; }
      else {
        raw += c; bare += c; blank += c;
        parts.push(part);
        part = '';
      }
    } else {
      add(c, c, c);
    }
  }
  if (q && quoted.length < MAX_PAYLOADS) quoted.push(content); // an unterminated quote runs to the end
  flush();
  return out;
}

function fragmentOf(raw) {
  const t = raw.trim().replace(/\s+/g, ' ');
  return t.length <= FRAGMENT_CHARS ? t : t.slice(0, FRAGMENT_CHARS - 1) + '\u2026';
}

function scan(patterns, text, depth, found, seen, dialect) {
  for (const seg of splitSegments(text, dialect)) {
    if (found.length >= MAX_MATCHES) return;
    const whole = stripPrefix(seg.bare);
    const candidates = [whole];
    for (const p of seg.parts) candidates.push(stripPrefix(p));
    const blank = stripPrefix(seg.blank);
    for (const pat of patterns) {
      if (seen.has(pat.id) || found.length >= MAX_MATCHES) continue;
      const hit = pat.view === 'blanked' ? pat.test.test(blank) : candidates.some((c) => pat.test.test(c));
      if (!hit) continue;
      seen.add(pat.id);
      found.push({ id: pat.id, reason: pat.reason, fragment: fragmentOf(seg.raw) });
    }
    if (depth >= MAX_DEPTH) continue;
    const word = FIRST_WORD.exec(whole);
    // `cmd.exe /c …` and `powershell.exe -c …` are the same wrappers as `cmd` and `powershell`.
    if (!word || !WRAPPERS.has(word[0].toLowerCase().replace(/\.exe$/, ''))) continue;
    const payloads = seg.quoted.slice();
    const flag = WRAPPER_FLAG.exec(seg.bare);
    if (flag) payloads.push(seg.bare.slice(flag.index + flag[0].length));
    if (word[0].toLowerCase() === 'eval') payloads.push(whole.slice(word[0].length));
    for (const p of payloads) scan(patterns, p, depth + 1, found, seen, dialect);
  }
}

/**
 * The patterns that match `command`, each once: `[{ id, reason, fragment }]` (`fragment` is the simple command that
 * matched, as written, cut to 80 characters). `opts.dialect` is 'posix' (default) or 'powershell'. The command is cut to
 * 8 KB first. A non-string or an entry without an id, a RegExp or a reason is ignored. Pure.
 */
function matchPatterns(patterns, command, opts) {
  if (typeof command !== 'string' || !command || !Array.isArray(patterns)) return [];
  const list = patterns.filter((p) => p && typeof p.id === 'string' && p.test instanceof RegExp && !p.test.global && !p.test.sticky && typeof p.reason === 'string');
  const found = [];
  scan(list, command.length > MAX_COMMAND_CHARS ? command.slice(0, MAX_COMMAND_CHARS) : command, 0, found, new Set(), opts && opts.dialect);
  return found;
}

module.exports = { matchPatterns, stripPrefix, splitSegments, MAX_COMMAND_CHARS, MAX_SEGMENTS, MAX_MATCHES, FRAGMENT_CHARS };
