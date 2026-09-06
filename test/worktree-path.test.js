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

const { parseWorktreePath } = require('../src/shared/worktree-path');
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

test('the worktree layout is spelled in exactly one file', () => {
  const offenders = [];
  for (const abs of walk(SRC)) {
    const relPath = rel(abs);
    if (relPath === 'src/shared/worktree-path.js') continue;      // the one place it belongs
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    if (/worktrees/.test(code)) offenders.push(relPath);
  }
  assert.deepEqual(offenders, [],
    `the worktree layout is spelled outside src/shared/worktree-path.js:\n  ${offenders.join('\n  ')}\n\n` +
    'Four copies drifted apart before #582 — one accepted a layout the others did not, three accepted a\n' +
    'separator the paths they are handed do not use. Call parseWorktreePath instead.');
});

test('the sidebar pairs worktrees through the shared helper', () => {
  const src = fs.readFileSync(path.join(SRC, 'renderer', 'shell', 'sidebar.js'), 'utf8');
  assert.match(stripComments(src), /parseWorktreePath\(/,
    'sidebar.js must ask the shared helper — this is the call site the Windows defect lived in');
});

test('the delete-worktree handler validates through the shared helper', () => {
  const src = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  const code = stripComments(src);
  assert.match(code, /require\('\.\/shared\/worktree-path'\)/,
    "main.js must require the shared helper, not keep its own WORKTREE_PATH_RE");
  assert.match(code, /parseWorktreePath\(normalizedPath\)/,
    'the delete handler validates the path it is about to hand to `git worktree remove` through it');
});
