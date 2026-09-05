'use strict';
// Nobody writes their own comment stripper. `test/helpers/strip-comments.js` is the one, and this is what
// says so.
//
// #554 is not really about the two guards that stripped in the wrong order — those are fixed. It is about
// the SHAPE: a line pass and a block pass, reached for in whichever order comes to mind, in a guard whose
// over-stripping hides violations instead of inventing them. The order that loses code reads perfectly
// naturally, the loss is silent, and the guard goes on reporting success about text it never saw. A
// comment in the helper does not stop the next person writing those two regexes, because they will not
// have read it.
//
// **Why a test and not a lint rule.** `eslint` is in devDependencies, but there is no config file, no
// `lint` script, and `.github/workflows/ci.yml` runs `npm test` and nothing else. A lint rule would mean
// introducing all three before it could catch anything, and it would still be a gate nobody runs locally.
// `npm test` is the gate that already exists and already fails the build, so the check goes there. If a
// lint setup ever lands, this can move into it — the detection below is the whole rule.
//
// **What it catches**, and deliberately no more: a `.replace(` handed a regular expression that starts by
// matching a comment opener. That is the shape people actually reach for. Someone determined to hand-roll
// a stripper out of `indexOf` and `slice` gets past this, and someone building the regex through
// `new RegExp` does too — the point is to catch the reflex, not to defeat an intention. It is also why
// this guard needs no exemption list: a list is the thing that grows one plausible entry at a time, and
// the two places that legitimately hold the wrong shape (the control in `test/strip-comments.test.js` and
// the sample below) both assemble it at run time instead of asking to be excused.
//
// **Where it looks**, and #570 is why it is two trees. It began at `test/`, because that is where the
// guards live and the guards were the ones being blinded. But `scripts/` is read as text by those same
// guards and holds tools that read source themselves, and a stripper hand-rolled there is the same defect
// with the same silence. Walking the tree rather than listing files is the point (see
// `.claude/rules/guards-and-scripts.md`): a violation can hide in a file nobody has written yet, and a new
// one under either tree is covered the day it lands.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TREES = [__dirname, path.join(ROOT, 'scripts')];
const HELPER = ['test', 'helpers', 'strip-comments.js'].join('/');

// A `.replace(` whose regex literal opens on `\/\*` or `\/\/` — the two halves of the hand-rolled
// stripper. Written with `.replace(` escaped, so this file does not match its own check.
const HAND_ROLLED = [
  { what: 'a block-comment stripper', re: /\.replace\(\s*\/\\\/\\\*/ },
  { what: 'a line-comment stripper', re: /\.replace\(\s*\/\\\/\\\//m },
];

/** The hand-rolled stripper this source contains, or null. */
function handRolledStripper(text) {
  for (const { what, re } of HAND_ROLLED) {
    const m = re.exec(String(text));
    if (m) return { what, at: m.index, snippet: String(text).slice(m.index, m.index + 60) };
  }
  return null;
}

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
};

// The deliberately wrong sample, assembled so this file stays clean under its own walk. It is the exact
// code #554 was filed about: block comments first, then line comments.
const WRONG_SAMPLE = [
  "const code = String(src)",
  "  ." + "replace(/\\/\\*[\\s\\S]*?\\*\\//g, '')",
  "  .split('\\n').map((l) => l." + "replace(/\\/\\/.*$/, '')).join('\\n');",
].join('\n');

test('the guard fires on the wrong order — the shape #554 was filed about', () => {
  const found = handRolledStripper(WRONG_SAMPLE);
  assert.ok(found, 'a guard that passes on the sample it exists to catch pins nothing');
  assert.equal(found.what, 'a block-comment stripper');
});

test('the guard fires on a hand-rolled stripper even in the RIGHT order', () => {
  // The order is not the rule. Going through the helper is: a second copy in the correct order today is
  // the one that gets edited into the wrong order tomorrow, with nothing to notice.
  const rightOrder = [
    "const code = String(src)",
    "  ." + "replace(/\\/\\/.*$/gm, '')",
    "  ." + "replace(/\\/\\*[\\s\\S]*?\\*\\//g, '');",
  ].join('\n');
  assert.ok(handRolledStripper(rightOrder), 'a hand-rolled stripper is caught whichever way round it is');
});

test('the guard leaves ordinary code alone', () => {
  // The false-positive control. A regex full of escaped slashes is normal — a URL, a path, a glob — and a
  // guard that cannot tell one from a stripper would be turned off within a week.
  const innocent = [
    "const { stripComments } = require('./helpers/strip-comments');",
    "const isHttp = (u) => /^https?:\\/\\//i.test(u);",
    "const posix = (p) => p." + "replace(/\\\\/g, '/');",
    "const code = stripComments(fs.readFileSync(file, 'utf8'));",
  ].join('\n');
  assert.equal(handRolledStripper(innocent), null);
});

test('nothing under test/ or scripts/ hand-rolls a comment stripper — they all go through the helper', () => {
  const offenders = [];
  const files = TREES.flatMap(dir => walk(dir));
  assert.ok(files.length > 100, `only ${files.length} files walked — a tree went missing`);
  for (const file of files) {
    const found = handRolledStripper(fs.readFileSync(file, 'utf8'));
    if (found) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      offenders.push(`${rel}: ${found.what} — ${found.snippet}`);
    }
  }
  assert.deepEqual(offenders, [],
    `these strip comments by hand instead of using ${HELPER}; the shape is silently lossy, see #554`);
});
