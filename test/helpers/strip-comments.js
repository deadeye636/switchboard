'use strict';
// The comment stripper the source-scanning guards share.
//
// Several tests answer a question about CODE by reading it as text — is there a hardcoded store path, does
// this file consult its store override, does a probe close its stdin. Every one of them has to drop the
// prose first, because the files around them are full of `~/.claude` and `src/backends/**` in comments.
//
// **The order is the whole thing, and getting it wrong blinds the guard silently.** Removing block
// comments first means a `/**` sitting INSIDE a line comment opens one, and everything up to the next
// `*/` disappears — code included. Measured before this helper existed: `src/app/hooks.js` lost 1060
// bytes, `src/backends/cli-probe.js` 1030, `src/backends/rewrite-cwd.js` 811 and `src/app/skills.js` 680,
// all to a comment mentioning a glob like `~/.claude/projects/**`. Both guards that used this shape are
// ones whose over-stripping HIDES violations, so they were reporting success about code they never read.
//
// Line comments therefore go first: once they are gone, nothing inside one can open a block.
//
// **What this still cannot do**, so nobody reads more into it than it offers: a `//` inside a string or a
// regular expression is treated as a comment, so a line holding a URL loses its tail. That is the older
// and much smaller error — it removes code that was already there rather than code that follows — and the
// honest fix is a tokenizer, which none of these guards is worth. A guard that cannot tolerate it says so
// and scans the raw source instead, as `test/cli-probe.test.js` does.

/** Source with its comments removed, line comments first. */
function stripComments(src) {
  return String(src == null ? '' : src)
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

module.exports = { stripComments };
