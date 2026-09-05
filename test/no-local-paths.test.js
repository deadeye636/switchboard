'use strict';
// Rule 6, with a mechanism behind it at last.
//
// CLAUDE.md says no personal or local identifier may reach any artifact of this public repo — no name,
// no machine, and no real path, a bare drive-and-folder included. Until now the only tool it offered was
// a grep written into the rule, and **that grep never worked**: it exits 2 with
// `PCRE does not support \L, \l, \N{name}, \U, or \u`. The pattern doubled its backslashes, they collapse
// to one before PCRE sees them, and its user-directory alternative then opens with an escape PCRE
// rejects. It reported nothing on a tree that contained a real path, which is indistinguishable from a
// clean tree — and that is how sixty fixtures naming the folder this checkout sits in survived until
// somebody read them.
//
// WHAT THIS CHECKS, and what it deliberately does not.
//
// An exhaustive "is this path real" test would need a list of every placeholder the repo may spell, and
// such a list goes stale one plausible entry at a time. So this asks a narrower question with no list at
// all: does any tracked file contain an identifier THIS MACHINE can leak? All three are computed at run
// time, so the test never has to write down the very strings it exists to keep out of the repo:
//
//   - the account name,
//   - the home directory,
//   - the name of the directory the checkout SITS IN — which is exactly what leaked. `<drive>:\<that>\…`
//     was in fixtures, comments and a data file, and it names the machine's layout as surely as a home
//     directory does.
//
// It follows that a clean run here proves less on a fresh CI clone than on a developer's machine — the
// checkout is somewhere generic there, so the third check has nothing to compare against. The same is
// true in an agent's git worktree under `.claude/worktrees/`, whose parent directory is a word this repo
// uses about itself. That is stated rather than hidden: the run that matters is the one before the push,
// on the machine that owns the name.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');

/** Every tracked file, so nothing under node_modules or an ignored scratch directory is scanned. */
function trackedFiles() {
  const out = execFileSync('git', ['-C', REPO, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter(Boolean);
}

/**
 * The identifiers this machine could leak, each with the reason it is one.
 *
 * A term is only used when it is long enough and specific enough to mean something: a two-letter account
 * name or a checkout sitting directly in a directory called `src` would match half the tree and say
 * nothing. Skipping is the honest answer there — a check that cannot discriminate must not pretend to.
 */
function localTerms() {
  const terms = [];
  const user = (os.userInfo().username || '').trim();
  if (user.length >= 4) terms.push({ term: user, why: 'the account name on this machine' });

  const home = os.homedir() || '';
  if (home.length >= 4) terms.push({ term: home, why: 'this machine\'s home directory', whole: true });

  // The directory the checkout sits IN. Not the checkout itself: the repository's own name is public and
  // appears everywhere by design. On CI the parent is usually the repo name again, which is why that case
  // is skipped rather than reported.
  const parent = path.basename(path.dirname(path.resolve(REPO)));
  const repoName = path.basename(path.resolve(REPO));
  // `worktrees` is here for a different reason from the rest, and it is not optional: an agent session
  // runs from `<repo>/.claude/worktrees/<name>`, which makes the parent literally `worktrees` — a word
  // this repo writes about ITSELF (`.claude/worktrees`, `git worktree`, and the CLI's own on-disk
  // worktree layout that two renderer files parse). Left in, the check reported sixteen files naming
  // "the directory this checkout sits in" and every one of them was the repo's own vocabulary. A term
  // that matches the subject matter cannot discriminate, which is what this whole set is for.
  const tooGeneric = new Set(['src', 'repo', 'repos', 'code', 'work', 'projects', 'git', 'home', 'users', 'tmp', 'temp', 'worktrees', '']);
  if (parent.length >= 4 && parent.toLowerCase() !== repoName.toLowerCase() && !tooGeneric.has(parent.toLowerCase())) {
    terms.push({ term: parent, why: 'the directory this checkout sits in' });
  }
  return terms;
}

test('no tracked file names an identifier of the machine it was written on', () => {
  const terms = localTerms();
  if (!terms.length) {
    // Not a pass dressed up as one: say which machine could not be checked and why.
    t_skipNote('nothing about this machine is specific enough to search for');
    return;
  }

  // The home directory is a whole path already, so a plain substring is specific enough; the other two
  // are single segments and are matched as such (see segmentPattern).
  const probes = terms.map(({ term, why, whole }) => ({
    why,
    test: whole ? (line) => line.toLowerCase().includes(term.toLowerCase()) : (() => {
      const re = segmentPattern(term);
      return (line) => re.test(line);
    })(),
  }));

  const hits = [];
  for (const rel of trackedFiles()) {
    const abs = path.join(REPO, rel);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    // A binary read as UTF-8 turns into replacement characters, never into an account name.
    const lines = text.split('\n');
    for (const { why, test: matches } of probes) {
      for (let i = 0; i < lines.length; i++) {
        if (matches(lines[i])) {
          hits.push(`${rel}:${i + 1} — names ${why}`);
          break; // one line per file per term is enough to act on
        }
      }
    }
  }

  assert.deepEqual(hits, [],
    'a public repository must not carry an identifier of the machine it was written on '
    + '(CLAUDE.md rule 6). Replace it with a placeholder — `~`, `<project>`, `<user>`, or an obviously '
    + 'invented path. Rewriting published history is not on the table, so this has to be caught here:\n'
    + hits.join('\n'));
});

/**
 * A term matched as a PATH SEGMENT, not as a word.
 *
 * The first version searched for the bare string and went red on CI, where the account is called
 * `runner` — an ordinary English word this repo writes nineteen times about its own test runner, the
 * Linux CI runner and `src/servers/schedule-runner.js`. That is the same mistake the `worktrees` entry
 * above was made for, in a place a developer's machine cannot show you: **a term that is also the
 * subject matter cannot discriminate**, and a guard that cries wolf on every CI run is one somebody
 * turns off.
 *
 * What leaks is a term standing where a path segment stands — after a separator, and ended by one, by a
 * quote, by punctuation or by the end of the line. `<drive>:\<parent>\demo` matches; "the Linux runner"
 * does not. The one non-path shape worth keeping is an address, so a term followed by `@` counts too.
 *
 * **Sentence punctuation is in the terminator class on purpose.** Prose ends a path with a full stop far
 * more often than with a separator — "the file sits under <path>." — and leaving `.`, `!`, `?`, `<` and
 * `|` out meant exactly the shape docs and comments are written in went undetected. Measured before
 * widening it: no term this test actually uses gains a single match, so the coverage is free here.
 *
 * **What it still does not catch, so nobody reads more into a green run than it offers.** Every one of
 * these needs the term to appear with no path around it at all:
 *
 *   - the identifier alone on a line, or as a bare value (`"owner": "<name>"`, a lone table cell),
 *   - a relative path whose FIRST segment is the term, with only a quote in front of it
 *     (`"<name>/project/file.txt"`) — nothing marks it as a segment there,
 *   - the term glued into a longer token (`schedule-<name>.js`). That one is deliberate: it is the
 *     false positive that turned CI red, and excluding it is the whole point.
 *
 * A bare name with no path context is a real leak this cannot see. It is the price of a guard that does
 * not cry wolf, and the reason rule 6 still says the check happens before you write.
 */
function segmentPattern(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:[\\\\/]${escaped}(?=[\\\\/'"\`\\s,;:)\\]}.!?<>|]|$)|\\b${escaped}@)`, 'i');
}

/** Says out loud that a check did not run, rather than letting an empty pass stand for a clean tree. */
function t_skipNote(reason) {
  // node:test has no first-class "skipped with a reason" that survives a plain runner, and a silent
  // return is exactly the failure this whole file exists to prevent. So it goes to stdout.
  process.stdout.write(`# no-local-paths: not checked — ${reason}\n`);
}
