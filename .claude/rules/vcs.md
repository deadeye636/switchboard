---
paths:
  - "src/vcs/**"
---

# VCS Seam & Git Provider

Rules and invariants for version control integration in Switchboard (#15, #277, #624). Specs: `docs/specs/15-vcs-status.md`.

## Architecture & Seam

- `src/vcs/index.js` is a provider registry mirroring `src/backends/index.js`: `detect(cwd)` identifies the provider owning the working directory, and the core interacts exclusively via descriptor hooks.
- **Core is VCS-blind:** `src/app/vcs.js` names no specific VCS, matching backend neutrality. Any capability that varies per VCS is a descriptor hook.
- `git.js` is the primary provider.
- Porcelain-v2 status parsing lives in `parse-git-status.js` — pure functions without process execution or DOM references.
- Diffs are not parsed: `git.js` only builds the argv (`diffArgs`), and `src/app/vcs.js` hands the raw text to the changes window, which draws it as-is (`src/renderer/changed-files.js`, coloured by line prefix). An untracked file skips `diffArgs` and is read as an all-added diff (`readUntrackedDiff`). The side-by-side diff window gets the two file versions through `showArgs` (`vcsFileVersions`), never diff output. There is no diff parser; do not go looking for one.
- App-owned worktrees (#805): the provider's `worktree` hooks (`git.js`) spell the argv and read the output, and `src/app/task-worktree.js` runs them without naming a VCS. A provider without worktrees sets `worktree: null`. The key is singular on purpose: the bare word `worktrees` in code is the layout guard's pattern (`test/worktree-path.test.js`). The measured cases and what the service does about each are in `docs/specs/41-task-sessions.md` ("Built").

## Key Invariants

1. **Git Status Flags:** `--no-optional-locks` is a GLOBAL flag and must precede `status` (`git --no-optional-locks status ...`), or git rejects it and the background poller contends with CLI agents over `index.lock`.
2. **In-Progress State:** Merge, rebase, and cherry-pick states are not reported in porcelain output; they are read directly from `.git/` filesystem markers without extra process spawning.
3. **Worktree Directory Handling:** The dirty check runs in the worktree alone, with one `-C` (`worktreeStatusArgs`, #624); only `worktree remove` runs in the parent repository, because the worktree may be gone. Never pass redundant or conflicting `-C` flags to `git` calls.
4. **Path Containment:** Never decide "is this path inside that one" with a string comparison; use `src/app/path-containment.js` with real resolved paths.
5. **`provider.bin` is an absolute path on Windows.** Every provider call runs with the repository as `cwd`, and Windows looks a bare name up there before `PATH`, so a repository holding its own `git.exe` would run on the status poll. Measured with `scripts/measure-planted-exe.js`; the note in `src/vcs/git.js` has the rule.
