# Fork context & porting workflow

Read this before touching remotes, cherry-picking from an upstream fork, or wondering what
"deadeye" means in a code comment.

## Fork context

This repo is **our own version** ("deadeye" is the codename of our variant — it shows up in code
comments to distinguish our fork's behaviour from haydng/jbr). It lives in a single git repo with
our own `origin` plus the upstream forks we port from.

- Branch **`main`** = our main line (was `deadeye` before the GitHub move; the codename stays).
- **`origin`** = the SSH remote for `deadeye636/switchboard` — our repo, `main` is the default
  branch. Pushed via SSH; `core.sshCommand` points at native Windows OpenSSH so the Bitwarden SSH
  agent is used (Git-bundled MSYS ssh can't reach the agent pipe).
- **Reference branches on origin** (read-only snapshots of the porting sources, recognizable by
  name, not generic): `haydng` (= `haydng/main`, the base) and `jbr` (= `jbr/main`, feature source).
- **Upstream remotes** (fetch sources for porting): `haydng` (base), `jbr` (JeanBaptisteRenard —
  feature source), `upstream` (doctly — original). Plus extra read-only forks.
- `../switchboard-jbr` = a read-only **git worktree** on `jbr/main` for reference.
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
