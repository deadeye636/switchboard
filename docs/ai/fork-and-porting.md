# Fork context & porting workflow

Read this before touching remotes, cherry-picking from an upstream fork, or wondering what
"deadeye" means in a code comment.

## Fork context

This repo is **our own version** ("deadeye" is the codename of our variant — it shows up in code
comments to distinguish our fork's behaviour from haydng/jbr). It lives in a single git repo with
our own `origin` plus the upstream forks we port from.

- Branch **`main`** = our main line (was `deadeye` before the GitHub move; the codename stays).
- **`origin`** = `https://github.com/deadeye636/switchboard.git` — our repo, **HTTPS for both fetch and
  push**, and `main` is its only branch. `git push origin main` goes straight out; no SSH agent is
  involved. (It was an SSH remote pushed through a Bitwarden agent once. `git remote -v` is the answer,
  not this line.)
- **The porting sources are separate remotes, not branches on origin** (fetch-only in practice):
  `haydng` (HaydnG — the base), `jbr` (JeanBaptisteRenard — feature source), `upstream` (doctly — the
  original), plus extra read-only forks. Their branches are visible as `haydng/main`, `jbr/main` and so
  on; `git branch -r` lists them. A `git push` to any of them is refused by
  `.claude/hooks/guard-commands.js`.
- A read-only **git worktree** on `jbr/main` beside the checkout used to be kept for reference. There is
  none today (`git worktree list`), so read that source with `git show jbr/main:<path>` — which is what
  you want anyway, since a checkout of a fetch-only branch is one more tree to keep in sync.
- All forks diverged from merge-base `b98c2f8`. Version numbers between forks are not comparable.

Feature-adoption catalogue: closed issue
[#1](https://github.com/deadeye636/switchboard/issues/1) (JBR candidates + refs live in its
"Umsetzung" comment).

## Porting workflow

Adopt JBR features one at a time, **never bulk-merge**:

1. `git checkout -b port/<feature> main`
2. `git cherry-pick <commits>` — resolve conflicts.
3. `npm test` must be green — no new failures vs. the pre-port run.
4. `git checkout main && git merge --ff-only port/<feature>`.

`main` must always stay runnable and green.

### Where conflicts land now

The classic hot-paths were `src/main.js`, `src/renderer/shell/sidebar.js`, `src/db/db.js` and
`src/index/session-cache.js`, because both forks rewrote them. Three of those are **façades** now
(#213/#217/#199), so a port collides with the **module** that owns the code, not with the façade —
usually a smaller, clearer conflict.

The renderer's four monoliths are composition points now too (#218 + #228: 9309 → 4577 across
`app.js`, `settings-panel.js`, `sidebar.js` and `grid-view.js`, twenty modules beside them — app.js
alone went 3199 → 1893 in #228), so the same applies there.

## Detecting upstream changes

`npm run upstream:check` fetches `haydng` + `jbr` and reports new/updated/removed branches and new
commits since the last review (marker in `.git/upstream-seen.json`, not versioned). After
reviewing/porting, `npm run upstream:seen` marks the current state as seen so the next check only
shows fresh activity. It watches **all** upstream branches, not just `main`.
