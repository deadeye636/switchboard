Perform a release for this project in accordance with `.claude/skills/release-notes/SKILL.md` and `docs/ai/release.md`.

Steps:

1. **Pre-flight Check:** Ensure working tree is clean (`git status --short`). Run `npm test` and ensure all tests pass.
2. **Version Bump:**
   - Find previous tag: `git describe --tags --abbrev=0`
   - Bump version: `npm version patch --no-git-tag-version` (or minor/major if instructed).
   - Commit with Conventional Commit / version message: `git commit -m "v{version}: {short summary}" package.json package-lock.json`
   - Create git tag: `git tag v{version}`
   - Push the commit and only the new tag: `git push origin main` then `git push origin refs/tags/v{version}`
3. **Build & Draft Verification:**
   - Wait for GitHub Actions build: `gh run watch`
   - Confirm CI created the draft release with all platform assets: `gh release list`
4. **Draft Release Notes:**
   - Generate release notes using the `/release-notes` skill (`.claude/skills/release-notes/SKILL.md`).
   - Group entries by user visibility:
     - Lead (2-3 sentences summary)
     - **What's new** (`feat`)
     - **Fixes** (`fix` — symptom first, cause, issue `#nr`)
     - **Behaviour changes** (anything surprising)
     - **On first start** (mandatory for DB migration or schema bumps)
     - **Under the hood** (one collapsed line for refactors/tests/build)
   - Do not dump every commit: focus on user-facing impact and link every entry to its issue number.
   - Update draft notes: `gh release edit v{version} --notes-file <file> --title "{version}"`
5. **Human Approval:**
   - Present the draft release notes to the user for review.
   - The release remains a **draft** until the user explicitly requests publication.
