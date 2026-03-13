Perform a release for this project. Steps:

1. Find the most recent version tag with `git describe --tags --abbrev=0` and collect all commits between it and HEAD using `git log {prev_tag}..HEAD --format="%B---"`
2. Bump the version with `npm version patch --no-git-tag-version`
3. Commit the version bump with message: `v{version}: {short summary of changes}`
4. Create a git tag `v{version}`
5. Push commits and tag: `git push && git push --tags`
6. Wait for the GitHub Actions build to complete by polling `gh run list --limit 1`
7. Once the build finishes and creates a draft release, publish it with release notes using `gh release edit v{version} --draft=false --notes "..."`
8. Release notes format:
   ```
   ## What's Changed

   ### {Category}
   - {change description}

   ### {Category}
   - {change description}
   ```
   Group changes by category (e.g. "Sidebar", "Keyboard", "Build", etc.) based on the commit messages. The release notes must cover ALL commits between the previous tag and the new tag — don't skip any.
