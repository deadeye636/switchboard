# Releasing

Read this before building an installer, pushing a tag, or editing a release.

## Release artifacts live in `dist/`

**Every installer** — the ones `build:win` produces and the ones you download from a release. It is
gitignored, and it is where the previous versions already are, so one look tells you what exists.
Downloading a build into a scratch or temp directory just scatters a 110 MB file somewhere nobody
will remember to delete.

```
gh release download v<version> --pattern "Switchboard.Setup.<version>.exe" --dir dist
```

## Install the build before releasing it

`build.files` in `package.json` is an **allow-list**, and `*.js` in it matches the **top level
only** — so a new directory of modules is silently left out of the package unless it is added there.
0.7.5's first draft shipped without `backends/` and died on its first `require`: the repo ran,
`npm start` ran, the whole suite was green, and only the installer was missing anything.
`test/packaged-files.test.js` now walks the real require graph against that allow-list, but a test
is not a substitute for starting the thing you are about to hand someone.

Starting it is not as easy as it sounds: the **single-instance lock** hands your launch of
`dist/win-unpacked/Switchboard.exe` straight to an already-running installed Switchboard, which then
looks like a successful start and is not one. **Close the installed app first**, or you have
verified nothing.

## Pushing a tag ALREADY builds the release — never `gh release create`

`.github/workflows/build.yml` fires on `push` of a `v*` tag and builds **all three platforms**, then
creates the release as a **draft** and uploads 19 assets: the Windows installer, the macOS
`.dmg`/`.zip` (arm64 + x64), the Linux AppImage/`.deb`/pacman — **and the `latest*.yml` files the
auto-updater needs.**

So after `git push origin refs/tags/v<version>`, the release already exists. Adding your own with
`gh release create` produces a **second** release on the same tag, carrying only whatever you
attached by hand — no `latest*.yml`, so an auto-update from it silently cannot work — and whoever
opens the releases page sees the wrong one. It happened in 0.7.6 and it looked exactly like "why is
there only a Windows build?".

```
gh release list                                  # is there already a draft for this tag?
gh release edit v<version> --notes-file <file>   # yes -> only ever EDIT it
gh release edit v<version> --title "<version>"   # the title is 0.7.6; the TAG is v0.7.6
```

Two traps in that edit:

- `gh api -X PATCH …/releases/<id>` without `tag_name` **resets the tag to an `untagged-…`
  placeholder** — pass it, or use `gh release edit`.
- The release **title carries no `v`** (`0.7.6`), while the tag does (`v0.7.6`) — match the ones
  already there.

## Tags: push one at a time

Never `git push --tags` — it pushes the upstream forks' tags along, and GitHub suppresses the build
event when more than three tags arrive at once. Always `git push origin refs/tags/v<version>`.

## Windows build

`npm run build:win` → NSIS installer at `dist/Switchboard Setup <ver>.exe` (spaces — the *download*
pattern for a published release is dotted, `Switchboard.Setup.<version>.exe`). The win target is
**x64-only** (arm64 toolchain not available on this machine). Full procedure + the VS 2026 gotchas: `docs/build-windows.md`.

One workaround is per-shell and not patchable — winpty's gyp step fails without it:

```
unset NoDefaultCurrentDirectoryInExePath && npm run build:win
```

The other two are durable in-repo: `"overrides": { "node-gyp": "13.0.0" }` in `package.json`, and
`patches/node-pty+1.1.0.patch` (Spectre mitigation off) re-applied by the `postinstall` hook. Don't
remove either.
