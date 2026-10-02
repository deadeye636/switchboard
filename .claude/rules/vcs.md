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
- Pure porcelain-v2 status and diff parsing lives in `parse-git-status.js` and `diff-parser.js` — pure functions without process execution or DOM references.

## Key Invariants

1. **Git Status Flags:** `--no-optional-locks` is a GLOBAL flag and must precede `status` (`git --no-optional-locks status ...`), or git rejects it and the background poller contends with CLI agents over `index.lock`.
2. **In-Progress State:** Merge, rebase, and cherry-pick states are not reported in porcelain output; they are read directly from `.git/` filesystem markers without extra process spawning.
3. **Worktree Directory Handling:** Worktrees resolve to their parent git repository for dirty/status checks. Never pass redundant or conflicting `-C` flags to `git` calls (#624).
4. **Path Containment:** Never decide "is this path inside that one" with a string comparison; use `src/app/path-containment.js` with real resolved paths.
