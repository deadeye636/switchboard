'use strict';
// The worktree-status handler asks the shared parser, and main.js hands it over (#582).
//
// `src/app/vcs.js` decides whether a path is a worktree, and which repository it belongs to, before it
// runs `git status` in it. It does not own that answer: `src/shared/worktree-path.js` does, for the
// sidebar's nesting, the delete handler, the session card's label and the unlisted-projects notice.
//
// WHY THIS GUARD EXISTS: when #582 collapsed four copies of the pattern into that module, it deleted the
// `WORKTREE_PATH_RE` constant in `src/main.js` — and a fifth consumer was still reading it, as an
// INJECTED value on `vcsPoll.init({ worktreePathRe })`. The whole suite stayed green, because nothing
// under `test/` loads `src/main.js` (it requires Electron), and the app then died at startup with
// `ReferenceError: WORKTREE_PATH_RE is not defined` before a single window opened. A guard that reads
// both files as text is the only thing here that can see across that seam.
//
// It also pins the half that was silently broken all along: the injected pattern was forward-slash only,
// so on Windows the dirty check refused every path the worktree-delete dialog handed it — the same
// failure the sidebar's nesting had, one layer down and unreported because the refusal reads like a
// legitimate "not a worktree".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { stripComments } = require('./helpers/strip-comments');

const ROOT = path.join(__dirname, '..');
const VCS = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'app', 'vcs.js'), 'utf8'));
const MAIN = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8'));

test('vcs.js asks the shared parser rather than matching a pattern of its own (#582)', () => {
  assert.match(VCS, /ctx\.parseWorktreePath/,
    'the worktree-status handler must ask the injected parser from src/shared/worktree-path.js');

  assert.ok(!/worktreePathRe/.test(VCS),
    'the injected regex is gone: it accepted forward slashes only, so it never matched a Windows path, '
    + 'and a second spelling of the layout is exactly what #582 removed');
});

test('main.js hands the parser over, so the handler has one at run time (#582)', () => {
  assert.match(MAIN, /require\(['"]\.\/shared\/worktree-path['"]\)/,
    'main.js loads the shared module');

  assert.match(MAIN, /vcsPoll\.init\(\{[\s\S]*?\bparseWorktreePath\b[\s\S]*?\}\)/,
    'vcsPoll.init must be given parseWorktreePath — the handler reads it off ctx, and an init that '
    + 'omits it leaves every worktree-status call answering "not a recognized worktree layout"');

  assert.ok(!/\bWORKTREE_PATH_RE\b/.test(MAIN),
    'main.js must not name the deleted constant: it defines nothing of the sort any more, and a '
    + 'reference to it is a startup crash the test suite cannot see');
});

test('the stripper is doing its job, so a comment cannot satisfy these checks', () => {
  // A positive control. Without it, a stripper that returned an empty string would let every "must not
  // contain" assertion above pass while reading nothing at all.
  assert.ok(VCS.includes('worktree-status'), 'the stripped vcs.js must still hold the handler it is asked about');
  assert.ok(MAIN.includes('vcsPoll.init'), 'the stripped main.js must still hold the wiring it is asked about');
  assert.ok(!VCS.includes('the same failure the sidebar'),
    'the prose explaining the decision must be gone, or the check is reading the comment');
});
