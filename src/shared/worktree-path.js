// --- Worktree path pairing (#582) ---
//
// The ONE answer to "is this path a worktree, and of which project" — asked by the sidebar (to nest the
// worktree under its parent), by the delete-worktree handler (to find the repo to run `git worktree
// remove` in), by the session card (to label a card that is working in one) and by the unlisted-projects
// notice (#583, to stop offering one as a project to add).
//
// It existed four times before this file did, and the copies had drifted in both directions:
//
//   * the sidebar accepted ONE layout where the delete handler accepted three, so a worktree under
//     `.worktrees/<name>` could be deleted as a worktree and was never displayed as one;
//   * the sidebar, the delete handler and the session card accepted FORWARD SLASHES only, while the
//     path they are handed is the resolved `cwd` out of a transcript — which on Windows is spelled with
//     backslashes. The nesting therefore never ran on Windows at all.
//
// So: both separators, all three layouts, one place. A path spelled either way answers the same.
//
// Pure string work — no fs, no path, no DOM. Loaded as a classic <script> in the renderer (its top-level
// function lands on `window`) AND require()d by the main process, `src/projects/**`,
// `src/index/projects-view.js` (which pairs each row with the project it nests under, #596), the
// Electron-free index worker leaf `src/session/derive-project-path.js`, and the node tests.
//
// This answers about the SPELLING of a path, and that is all it answers. Whether the directory is a real
// `git worktree add` checkout is a different question with a different answer — `isRealGitWorktree` in
// `src/session/derive-project-path.js` asks the filesystem, and a conventional worktrees directory that
// holds an ordinary folder matches here while failing there.

// <parent>/.claude/worktrees/<name>, <parent>/.claude-worktrees/<name>, <parent>/.worktrees/<name>,
// with `/` or `\` between every segment and an optional trailing separator.
//
// The three layouts as SEGMENTS, and the pattern is built from them (#594). Two readers need them in two
// shapes — this one matches a path that already exists, `worktreeDirsIn` builds the directories to go
// and LOOK in — and spelling them twice in one file is the same drift this module was created to end,
// one scope smaller. The leading dot is added here so a segment list never carries it.
const WORKTREE_DIRS = [['claude', 'worktrees'], ['claude-worktrees'], ['worktrees']];
const WORKTREE_PATH_RE = new RegExp(
  '^(.+?)[\\\\/]\\.(?:' + WORKTREE_DIRS.map(segs => segs.join('[\\\\/]')).join('|') + ')[\\\\/]([^\\\\/]+)[\\\\/]?$',
);

/**
 * Split a worktree path into the project it belongs to and its own name.
 *
 * @param {string} p  a project path, spelled with either separator
 * @returns {{parentPath: string, name: string}|null}  null when the path is not a worktree layout
 */
function parseWorktreePath(p) {
  const match = String(p || '').match(WORKTREE_PATH_RE);
  if (!match) return null;
  return { parentPath: match[1], name: match[2] };
}

/**
 * Walk up until the path is no longer a worktree: the PROJECT a worktree belongs to, however many
 * levels of worktree sit between them.
 *
 * `parseWorktreePath` answers one level, which is the right answer to "who is my parent". This answers
 * "whose sub-unit am I", and that is the question the register asks: a worktree carries no registration
 * of its own, so its visibility, its auto-hide and its settings all come from the project at the top.
 * A worktree inside a worktree is still that project's, not a project of its own.
 *
 * Bounded rather than `while (true)`: the pattern strictly shortens the path each time, so the loop
 * ends on its own — but a regex is a thing someone edits, and a cap costs nothing.
 *
 * @param {string} p
 * @returns {string|null}  the project path, or null when `p` is not a worktree at all
 */
function worktreeRootOf(p) {
  let cur = String(p || '');
  let root = null;
  for (let depth = 0; depth < 16; depth++) {
    const wt = parseWorktreePath(cur);
    if (!wt) break;
    root = wt.parentPath;
    cur = wt.parentPath;
  }
  return root;
}

/**
 * What a worktree is CALLED, once every level between it and its project is spelled out.
 *
 * `<project>/.worktrees/agent-a/.worktrees/hotfix-1` reads `agent-a / hotfix-1`; an ordinary one-level
 * worktree reads exactly its own name, so nothing about today's rows changes.
 *
 * It exists because #586 attaches a nested worktree to the TOP-MOST project rather than nesting a level
 * deeper (the decision, with both options drawn: a third rail costs ~34 px of a 340 px panel, and a
 * fourth level would cost another). The row therefore sits beside its own parent, and the only thing
 * left to say where the checkout is, is the name — so the name has to say it. Every surface that names a
 * worktree asks HERE rather than joining the segments itself: the separator is a display decision, and
 * two of them is how a sidebar row and its delete dialog end up naming the same directory differently.
 *
 * @param {string} p
 * @returns {string|null}  null when the path is not a worktree at all
 */
function worktreeLabelOf(p) {
  const names = [];
  let cur = String(p || '');
  for (let depth = 0; depth < 16; depth++) {
    const wt = parseWorktreePath(cur);
    if (!wt) break;
    names.unshift(wt.name);
    cur = wt.parentPath;
  }
  return names.length ? names.join(' / ') : null;
}

/**
 * Where a project's worktrees WOULD be: the three conventional directories, whether or not they exist.
 *
 * The other functions here answer about a path somebody already has. This one is the question asked
 * before there is a path at all — #594 needs to list what a project holds on disk, because a worktree
 * with no sessions has no row and therefore nowhere to start one. Still pure string work: it composes
 * candidates, it does not go and look.
 *
 * Joined with `/`, which Node accepts on every platform and which `parseWorktreePath` reads back.
 *
 * @param {string} p  a project path
 * @returns {string[]}  three candidate directories, or [] for a blank path
 */
function worktreeDirsIn(p) {
  const base = String(p || '').replace(/[\\/]+$/, '');
  if (!base) return [];
  return WORKTREE_DIRS.map(segs => base + '/.' + segs.join('/'));
}

/**
 * Whose settings apply to this directory.
 *
 * A worktree is a sub-unit of its project and carries no settings of its own — so the cascade resolves
 * the OWNER first and then does its ordinary two levels, rather than growing a third. Nobody configures
 * a worktree: it is created by `git worktree add`, usually by an agent, and it exists for hours. A third
 * level would also need a per-option "inherit / override / empty" state, which is the cost `#149` already
 * paid once for the per-backend launch defaults.
 *
 * NOT for everything filed under `project:<path>`. That blob holds per-project IDENTITY as well as
 * settings, and `displayName` is identity: renaming a worktree must not rename the project it sits in.
 * Use this where a value CASCADES, and the project's own path where it names a row.
 *
 * @param {string} p
 * @returns {string} `p` itself when it is not a worktree
 */
function settingsOwnerPath(p) {
  return worktreeRootOf(p) || String(p || '');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseWorktreePath, worktreeRootOf, worktreeLabelOf, worktreeDirsIn, settingsOwnerPath };
}
