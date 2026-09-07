'use strict';
// #582 — a worktree is paired with its project by ONE pattern, and that pattern answers about a path
// spelled either way.
//
// Two halves, and both had shipped broken:
//
//   THE ANSWER — the sidebar's copy accepted forward slashes only, and the `projectPath` it is matched
//   against is the resolved `cwd` out of a transcript, which on Windows is backslash-spelled. Nothing
//   normalises the separator between the two, so the nesting never ran on Windows at all. The same copy
//   accepted one layout where the delete handler accepted three: a worktree under `.worktrees/<name>`
//   could be deleted as a worktree and was never displayed as one, on every platform.
//
//   THE COUNT — there were four copies (the sidebar, the delete handler, the session card, the project
//   path deriver) and they had drifted in both directions. The last test here is what keeps a fifth from
//   appearing: the layout may be spelled in exactly one file.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseWorktreePath, worktreeRootOf, worktreeLabelOf, settingsOwnerPath } = require('../src/shared/worktree-path');
const { stripComments } = require('./helpers/strip-comments');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// The three layouts the delete handler has always accepted. Written as segment lists so each case can be
// joined with either separator rather than spelled twice.
const LAYOUTS = [
  ['.claude', 'worktrees'],
  ['.claude-worktrees'],
  ['.worktrees'],
];

test('every layout is recognised, spelled with either separator', () => {
  for (const layout of LAYOUTS) {
    for (const sep of ['/', '\\']) {
      const parent = ['', 'example', 'parent-repo'].join(sep);
      const wt = [parent, ...layout, 'agent-one'].join(sep);
      assert.deepEqual(parseWorktreePath(wt), { parentPath: parent, name: 'agent-one' },
        `${wt} must pair with its parent`);
      assert.deepEqual(parseWorktreePath(wt + sep), { parentPath: parent, name: 'agent-one' },
        `${wt}${sep} — a trailing separator must not change the answer`);
    }
  }
});

test('a Windows path pairs the same as the POSIX one — the defect that made the nesting never run', () => {
  // The exact shape a transcript's `cwd` carries on Windows: a drive letter and backslashes throughout.
  const parsed = parseWorktreePath('X:\\example\\parent-repo\\.claude\\worktrees\\agent-one');
  assert.deepEqual(parsed, { parentPath: 'X:\\example\\parent-repo', name: 'agent-one' });
});

test('the parent is the DEEPEST project above the worktrees directory, not the first path segment', () => {
  assert.deepEqual(
    parseWorktreePath('/example/outer/inner-repo/.claude/worktrees/agent-one'),
    { parentPath: '/example/outer/inner-repo', name: 'agent-one' },
  );
});

test('a path that is not a worktree layout answers null', () => {
  const notWorktrees = [
    '',
    null,
    undefined,
    '/example/parent-repo',
    '/example/parent-repo/src',
    // One level too deep: a directory INSIDE a worktree is not the worktree.
    '/example/parent-repo/.claude/worktrees/agent-one/src',
    // The worktrees directory itself holds worktrees; it is not one.
    '/example/parent-repo/.claude/worktrees',
    // Not a dot-directory, so not one of the three layouts.
    '/example/parent-repo/worktrees/agent-one',
    // No parent above it at all.
    '.claude-worktrees/agent-one',
  ];
  for (const p of notWorktrees) {
    assert.equal(parseWorktreePath(p), null, `${JSON.stringify(p)} is not a worktree path`);
  }
});

test('a worktree name keeps the characters a branch-derived name carries', () => {
  const parsed = parseWorktreePath('/example/parent-repo/.worktrees/fix.582-a_b');
  assert.deepEqual(parsed, { parentPath: '/example/parent-repo', name: 'fix.582-a_b' });
});

// --- the count -------------------------------------------------------------------------------------
//
// Reading the tree, not a fixed file list: a new copy hides in whichever file grows it next, and the
// four that existed were spread over the renderer, the main process and the session layer. Comments are
// stripped through the shared stripper (CLAUDE.md rule 14) so prose may keep naming the layout.

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const rel = (abs) => path.relative(ROOT, abs).replace(/\\/g, '/');

// The scan is the bare word, and it stays that way. Narrowing it to "a dot within twenty characters of
// the word" was tried and had a hole a copy would actually fall into: the window cannot cross a quote,
// so `path.join(dir, '.claude', 'worktrees')` — the idiomatic, separator-safe way to build this exact
// path in this codebase — matched nothing at all. A guard for a duplicated pattern must err towards
// catching: a false positive costs one reviewed line below, a false negative is silent.
const SCAN_RE = /worktrees/;

// Where the plural WORD is legitimately in the code, and why. The word is also an ordinary English
// plural, and the sidebar says it to a user once.
//
// Each entry names the exact text it excuses, and a STALE entry FAILS (below) — an exemption list that
// only ever grows is the failure mode `.claude/rules/guards-and-scripts.md` names. Comments are already
// stripped before the scan, so prose about worktrees needs no entry here.
const PLURAL_ALLOWED = [
  {
    file: 'src/renderer/shell/sidebar.js',
    text: "'worktree' : 'worktrees'",
    why: "the worktrees fold's label (#598) — an English plural shown to the user, not a path layout",
  },
];

test('the guard catches a copy of the layout however it is spelled', () => {
  // The shapes a fifth copy would plausibly take, asserted rather than assumed — the guard carries its
  // own pattern, so the pattern is a second copy of the thing it audits and gets checked both ways.
  for (const shape of [
    "path.join(dir, '.claude', 'worktrees')",
    "['.claude', 'worktrees'].join('/')",
    '`${parent}/.claude/worktrees/${name}`',
    '.claude-worktrees',
    String.raw`\.(?:claude[\\/]worktrees|claude-worktrees|worktrees)`,
  ]) assert.match(shape, SCAN_RE, `a copy spelled ${shape} must be caught`);
});

test('every plural exemption is still in the file it names', () => {
  for (const entry of PLURAL_ALLOWED) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, entry.file), 'utf8'));
    assert.ok(code.includes(entry.text),
      `${entry.file} no longer contains ${entry.text} — remove the exemption rather than leaving a hole.\n` +
      `It was there because: ${entry.why}`);
  }
});

test('the worktree layout is spelled in exactly one file', () => {
  const offenders = [];
  for (const abs of walk(SRC)) {
    const relPath = rel(abs);
    if (relPath === 'src/shared/worktree-path.js') continue;      // the one place it belongs
    let code = stripComments(fs.readFileSync(abs, 'utf8'));
    for (const entry of PLURAL_ALLOWED) {
      if (entry.file === relPath) code = code.split(entry.text).join('');
    }
    if (SCAN_RE.test(code)) offenders.push(relPath);
  }
  assert.deepEqual(offenders, [],
    `the worktree layout is spelled outside src/shared/worktree-path.js:\n  ${offenders.join('\n  ')}\n\n` +
    'Four copies drifted apart before #582 — one accepted a layout the others did not, three accepted a\n' +
    'separator the paths they are handed do not use. Call parseWorktreePath instead.');
});

test('the sidebar pairs worktrees through the shared helper', () => {
  const src = fs.readFileSync(path.join(SRC, 'renderer', 'shell', 'sidebar.js'), 'utf8');
  // `worktreeLabelOf` since #586 — it is still the shared helper, and it is still the call site the
  // Windows defect lived in. Either name satisfies this: what the guard is about is that the sidebar
  // does not go back to spelling the layout itself.
  assert.match(stripComments(src), /\b(?:parseWorktreePath|worktreeLabelOf)\(/,
    'sidebar.js must ask the shared helper — this is the call site the Windows defect lived in');
});

// --- naming a worktree ----------------------------------------------------------------------------
//
// `worktreeLabelOf` is the one answer to "what is this worktree called", and since #586 the answer is not
// derivable from the last path segment: a nested checkout is drawn BESIDE its own parent, so its name is
// the only thing left saying where it sits (`agent-a / hotfix-1`). Two surfaces spelling that differently
// name one directory two things, and two checkouts called `hotfix-1` under different agents read alike.
//
// Two halves, because neither is enough on its own — `.claude/rules/guards-and-scripts.md`:
//
//   * the LIST below is what the five surfaces are, and a stale entry fails. It cannot see a sixth;
//   * the SCAN after it walks `src/` and catches the sixth, because a new surface hides in whichever
//     file grows it next.

const NAMES_A_WORKTREE = [
  { file: 'src/renderer/shell/sidebar.js', why: "the worktree row's own label" },
  { file: 'src/renderer/shell/sidebar-events.js', why: 'the hide and the delete dialog' },
  { file: 'src/renderer/session/session-card-details.js', why: "the session card's `Worktree <name>` line" },
  { file: 'src/renderer/panels/projects-admin.js', why: "the project manager's row" },
  { file: 'src/app/windows.js', why: "the settings window's title note" },
];

test('every surface that names a worktree asks the shared helper (#586)', () => {
  for (const entry of NAMES_A_WORKTREE) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, entry.file), 'utf8'));
    assert.match(code, /worktreeLabelOf\(/,
      `${entry.file} names a worktree (${entry.why}) without asking \`worktreeLabelOf\`.\n` +
      'The last path segment is not the answer since #586: a nested worktree hangs from the top-most ' +
      'project, so the name is what says where the checkout is. If this surface stopped naming one, ' +
      'remove its entry rather than leaving a hole.');
  }
});

// A line that NAMES a worktree and takes a path apart in the same breath. That is the shape of the
// mistake — not `.split()` itself, which is how every project short-name in the renderer is built and
// which must stay legal.
//
// **The `wt` half is not a nicety.** The first version of this pattern was `/worktree/i` alone, and the
// shapes below caught it out immediately: this codebase writes `wtName`, `wtProject`, `wtGroup` — the
// realistic sixth surface would have been spelled with the abbreviation and walked straight past a guard
// named after the full word. `\bwt[A-Z]` is the camel-case form and matches nothing else; a bare `wt`
// would match half the tree.
const HAND_SPELLED_NAME = /worktree|\bwt[A-Z]/i;
const TAKES_A_PATH_APART = /\.split\(|\.pop\(\)/;

test('the naming scan catches a sixth surface however it is spelled', () => {
  // The guard carries its own pattern, so the pattern is a second copy of the thing it audits and gets
  // checked in both directions rather than only against a tree that happens to be clean today.
  for (const shape of [
    "const wtName = wt.projectPath.split('/').pop();",
    'const name = worktreePath.split(/[\\\\/]/).filter(Boolean).pop();',
    'label = `Worktree ${p.split(sep).pop()}`;',
  ]) {
    assert.ok(HAND_SPELLED_NAME.test(shape) && TAKES_A_PATH_APART.test(shape),
      `a sixth surface spelled ${shape} must be caught`);
  }
  // And the shape that must NOT be caught, or the guard would outlaw every project short name.
  const projectShortName = "const shortName = p.projectPath.split('/').filter(Boolean).slice(-2).join('/');";
  assert.ok(!HAND_SPELLED_NAME.test(projectShortName),
    'a project short name is not a worktree name and stays legal');
});

// A generated bundle is not source and must not be scanned: `codemirror-bundle.js` and `pdf-worker.js`
// both contain a minified `wtX` by chance, and both are gitignored — so a scan that read them was red
// here and green on a fresh clone, which is the one thing a guard may never be.
//
// Told apart by a PROPERTY rather than by name, so the next bundle is covered on the day it is built:
// measured, the three generated files under `src/` have longest lines of 689 244, 379 215 and 146 030
// characters, and the longest hand-written line in the tree is 3 835 (an inline icon SVG).
const GENERATED_LINE_LENGTH = 20000;

function isGenerated(text) {
  return text.split(/\r?\n/).some(l => l.length > GENERATED_LINE_LENGTH);
}

test('a file that spells a worktree name by hand asks the helper too', () => {
  const offenders = [];
  for (const abs of walk(SRC)) {
    const relPath = rel(abs);
    if (relPath === 'src/shared/worktree-path.js') continue;      // it IS the answer
    const raw = fs.readFileSync(abs, 'utf8');
    if (isGenerated(raw)) continue;
    const code = stripComments(raw);
    const spells = code.split(/\r?\n/).some(l => HAND_SPELLED_NAME.test(l) && TAKES_A_PATH_APART.test(l));
    if (spells && !/worktreeLabelOf\(/.test(code)) offenders.push(relPath);
  }
  assert.deepEqual(offenders, [],
    `a worktree is named by taking a path apart, without asking the helper:\n  ${offenders.join('\n  ')}\n\n` +
    'Call `worktreeLabelOf(path)`. A fallback split beside it is fine — `sidebar.js` keeps one — but it ' +
    'has to be the fallback, not the answer, or a nested checkout is named after its last segment alone.');
});

test('the delete-worktree handler validates through the shared helper', () => {
  const src = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  const code = stripComments(src);
  assert.match(code, /require\('\.\/shared\/worktree-path'\)/,
    "main.js must require the shared helper, not keep its own WORKTREE_PATH_RE");
  assert.match(code, /parseWorktreePath\(normalizedPath\)/,
    'the delete handler validates the path it is about to hand to `git worktree remove` through it');
  assert.match(code, /worktreeRootOf\(normalizedPath\)/,
    'and it runs `git worktree remove` in the PROJECT (#586), not in the immediate parent — for a ' +
    'worktree of a worktree the immediate parent may already have been removed, and `git -C` on a ' +
    'directory that is gone fails before it reaches the removal');
});

test('worktreeLabelOf names every level between a worktree and its project (#586)', () => {
  const project = 'D:\\repo';
  const wt1 = project + '\\.claude\\worktrees\\agent-a';
  const wt2 = wt1 + '\\.worktrees\\hotfix-1';

  assert.equal(worktreeLabelOf(wt1), 'agent-a',
    'a one-level worktree reads exactly its own name — nothing about today\'s rows changes');
  assert.equal(worktreeLabelOf(wt2), 'agent-a / hotfix-1',
    'a nested one sits BESIDE its parent (#586), so the name is what says where the checkout is');
  assert.equal(worktreeLabelOf(project), null, 'a project is not a worktree of anything');
  assert.equal(worktreeLabelOf(''), null);
  assert.equal(worktreeLabelOf(null), null, 'and never the string "null"');
});

test('worktreeLabelOf answers the same for either separator', () => {
  assert.equal(worktreeLabelOf('repo/.claude/worktrees/a/.worktrees/b'), 'a / b');
  assert.equal(worktreeLabelOf('repo\\.claude\\worktrees\\a\\.worktrees\\b'), 'a / b');
});

test('worktreeRootOf walks past a worktree of a worktree to the project', () => {
  // `parseWorktreePath` answers "who is my parent", which for a nested worktree is another worktree.
  // The register asks the other question — "whose sub-unit am I" — and that has exactly one answer.
  const project = 'D:\\repo';
  const wt1 = project + '\\.claude\\worktrees\\wt1';
  const wt2 = wt1 + '\\.claude\\worktrees\\wt2';

  assert.equal(worktreeRootOf(wt1), project);
  assert.equal(worktreeRootOf(wt2), project, 'two levels down is still that project\'s sub-unit');
  assert.equal(parseWorktreePath(wt2).parentPath, wt1, 'and the one-level answer is unchanged');
  assert.equal(worktreeRootOf(project), null, 'a project is not a worktree of anything');
  assert.equal(worktreeRootOf(''), null);
});

test('worktreeRootOf answers the same for either separator', () => {
  // No drive letters here: this asks about the SEPARATOR, and an invented absolute path in a public
  // repository buys nothing (CLAUDE.md reflex 6).
  assert.equal(worktreeRootOf('repo/nested/.claude/worktrees/a'), 'repo/nested');
  assert.equal(worktreeRootOf('repo\\nested\\.worktrees\\a'), 'repo\\nested');
});

test('settingsOwnerPath is the project for a worktree and the path itself for anything else', () => {
  const project = 'D:\\repo';
  const wt1 = project + '\\.claude\\worktrees\\wt1';
  const wt2 = wt1 + '\\.claude\\worktrees\\wt2';

  assert.equal(settingsOwnerPath(project), project, 'an ordinary project owns its own settings');
  assert.equal(settingsOwnerPath(wt1), project);
  assert.equal(settingsOwnerPath(wt2), project, 'and a worktree of a worktree lands on the same one');
  assert.equal(settingsOwnerPath(''), '', 'no path, no owner — and never the string "null"');
  assert.equal(settingsOwnerPath(null), '');
});

test('the two readers that build the settings key by hand resolve the owner (#593)', () => {
  // A wiring guard, and it says so: these two do not go through `effectiveSettings`, they assemble
  // `project:<path>` themselves. Nothing else can see them — `spawn.js` requires node-pty at module
  // load, and the launcher reader is renderer code — so the regression this pins is the realistic one:
  // somebody tidying the resolution back out of a line that looks redundant. If either grows a seam
  // that can be called, replace this with a behavioural test rather than adding a third entry.
  const HAND_ROLLED = [
    { file: 'src/app/terminal/spawn.js', why: "Claude's AFK timeout, read straight out of backendDefaults" },
    { file: 'src/renderer/dialogs/dialogs.js', why: 'the custom launchers a project defines' },
  ];

  for (const entry of HAND_ROLLED) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, entry.file), 'utf8'));
    assert.match(code, /'project:' \+/,
      `${entry.file} no longer builds the key by hand — drop this entry (${entry.why})`);
    assert.match(code, /settingsOwnerPath\(/,
      `${entry.file} builds \`project:<path>\` without resolving the owner, so a worktree would take ${entry.why} from global while every other setting came from its project`);
  }
});
