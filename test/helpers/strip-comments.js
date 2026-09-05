'use strict';
// The comment stripper the source-scanning guards share.
//
// Several tests answer a question about CODE by reading it as text — is there a hardcoded store path, does
// this file consult its store override, does a probe close its stdin. Every one of them has to drop the
// prose first, because the files around them are full of `~/.claude` and `src/backends/**` in comments.
//
// These are guards whose over-stripping HIDES violations rather than inventing them. One that silently
// reads less than it thinks reports success about code it never saw, which is the worst failure a guard
// has — so what this removes has to be exactly the comments, and nothing that merely looks like one.
//
// **Why this is a scanner and not two regexes.** The obvious implementation is a line-comment pass and a
// block-comment pass, and it is wrong in both orders:
//
//   * block first — a `/**` sitting INSIDE a line comment opens a block, and everything to the next `*/`
//     disappears, code included. That is the bug this file was extracted for (#554): `src/app/hooks.js`
//     lost 1060 bytes, `src/backends/cli-probe.js` 1030, `src/backends/rewrite-cwd.js` 811 and
//     `src/app/skills.js` 680, all to a comment mentioning a glob like `~/.claude/projects/**`.
//   * line first — better, but a `//` inside a string or a regular expression is still read as a comment,
//     and a `/*` inside one still opens a block. Measured over `src/**` when this scanner replaced that
//     shape: 5269 bytes of live code in 27 files were invisible to the guards, a URL's tail and a glob
//     being the usual cause. Feeding the whole tree through the two-pass version produced source that no
//     longer parses in 88 of 542 files — a direct reading of how much real code it was cutting.
//
// No ordering fixes either, because the failure is not the order: it is that a comment can be opened from
// inside something that is not code. So this walks the text once, knowing whether it stands in code, a
// string, a template (including the code inside `${…}`), a regular expression, or a comment. In that
// shape a comment cannot be opened from inside a string, and a string cannot be opened from inside a
// comment, whatever anyone writes in the prose.
//
// The scanner never removes more than the two-pass version did — `test/strip-comments.test.js` asserts
// that over the tree, so a mistake here can only make a guard louder, never blinder.
//
// **What it still does not do:** it is a scanner, not a parser. It does not evaluate the code, so a
// regular expression is told from a division by what precedes it, and a construct nobody writes here
// could fool that. The error is bounded the same way — a misread `/` ends a regex early and leaves MORE
// text standing, so the guard sees prose and fails loudly rather than passing quietly.

// A `/` after one of these begins a regular expression, not a division. Empty string = start of input.
const REGEX_AFTER_PUNCTUATION = new Set(
  ['', '=', '(', ',', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>']
);
const REGEX_AFTER_KEYWORD = new Set(
  ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'do', 'else', 'case',
    'yield', 'await']
);

/** Source with its comments removed — one pass, aware of strings, templates and regular expressions. */
function stripComments(src) {
  const text = String(src == null ? '' : src);
  const n = text.length;
  let out = '';
  let i = 0;
  // What the last piece of CODE was, so a `/` can be read as a regex or a division.
  let prev = '';
  let word = '';
  // Template state. `frames` remembers the brace depth of each template we stepped out of at a `${`.
  let inTemplate = false;
  let depth = 0;
  const frames = [];

  while (i < n) {
    const c = text[i];

    if (inTemplate) {
      if (c === '\\') { out += text.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { out += c; i += 1; inTemplate = false; prev = '`'; word = ''; continue; }
      if (c === '$' && text[i + 1] === '{') {
        // `${…}` is code again, so a comment in there is prose like any other.
        out += '${';
        i += 2;
        frames.push(depth);
        depth = 0;
        inTemplate = false;
        prev = '{';
        word = '';
        continue;
      }
      out += c;
      i += 1;
      continue;
    }

    const next = i + 1 < n ? text[i + 1] : '';

    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i += 1; // the newline itself stays, so line counts survive
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === '`') { out += c; i += 1; inTemplate = true; continue; }
    if (c === '"' || c === "'") {
      out += c;
      i += 1;
      while (i < n) {
        const q = text[i];
        if (q === '\\') { out += text.slice(i, i + 2); i += 2; continue; }
        if (q === '\n') break; // an unterminated quote ends at the line, rather than eating the file
        out += q;
        i += 1;
        if (q === c) break;
      }
      prev = c;
      word = '';
      continue;
    }
    if (c === '/' && (REGEX_AFTER_PUNCTUATION.has(prev) || REGEX_AFTER_KEYWORD.has(word))) {
      out += c;
      i += 1;
      let inClass = false; // a `/` inside `[…]` is a literal slash, not the closer
      while (i < n) {
        const q = text[i];
        if (q === '\\') { out += text.slice(i, i + 2); i += 2; continue; }
        if (q === '\n') break;
        out += q;
        i += 1;
        if (q === '[') inClass = true;
        else if (q === ']') inClass = false;
        else if (q === '/' && !inClass) break;
      }
      prev = '/';
      word = '';
      continue;
    }
    if (c === '}' && depth === 0 && frames.length) {
      out += c;
      i += 1;
      depth = frames.pop();
      inTemplate = true;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}' && depth > 0) depth -= 1;

    out += c;
    if (!/\s/.test(c)) {
      prev = c;
      word = /[A-Za-z_$0-9]/.test(c) ? word + c : '';
    }
    i += 1;
  }
  return out;
}

module.exports = { stripComments };
