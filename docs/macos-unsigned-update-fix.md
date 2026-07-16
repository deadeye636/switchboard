# macOS unsigned auto-update fix (historical)

> **Status: obsolete.** The auto-update feature (`electron-updater`) was later
> **removed from this fork entirely**, so the fix below no longer exists in the
> code. This document is kept as a historical record of why unsigned macOS
> auto-updates failed and how they were patched while the updater still existed.

## Problem

On macOS the update / restart flow always reports "failed" and the app never
quits or relaunches.

## Root cause

The fork ships **unsigned** macOS builds (CI sets
`CSC_IDENTITY_AUTO_DISCOVERY: false`, no Developer ID / notarization).

`electron-updater` on macOS delegates the actual install to **Squirrel.Mac**,
which **requires** a valid Developer ID code signature on both the running app
and the downloaded update. For an unsigned (or ad-hoc-signed) app Squirrel
refuses to apply the update.

Because `autoUpdater.autoInstallOnAppQuit = true`, `MacUpdater` hands the
download straight to Squirrel as soon as it finishes downloading
(`MacUpdater.updateDownloaded` → `nativeUpdater.checkForUpdates()`), so the
signature check fails and emits an `error` event. The renderer maps that to
"Update check failed" / restart "failed", and nothing relaunches.

The download itself is plain HTTP and needs no signature — only the Squirrel
install step is broken.

## Fix

Keep `electron-updater` for *checking* and *downloading*, but on macOS replace
the Squirrel install step with a manual bundle swap + relaunch.

1. `autoUpdater.autoInstallOnAppQuit = false` on darwin only, so the download
   no longer auto-hands-off to Squirrel (kills the spurious error). Windows /
   Linux keep the existing behaviour.
2. Capture `event.downloadedFile` (the downloaded `.zip` path) from the
   `update-downloaded` event into a module-level variable.
3. On `updater-install`, branch by platform:
   - **darwin**: run a detached shell script that waits for this process to
     exit, extracts the downloaded zip with `ditto`, replaces the existing
     `.app` bundle, strips the `com.apple.quarantine` xattr, re-applies an
     ad-hoc signature, and relaunches with `open`. Then `app.quit()`.
   - **others**: `autoUpdater.quitAndInstall(false, true)` as before.
4. Surface the real failure reason in the renderer restart toast.

## Caveats

- Assumes the app runs from a writable location (normal `/Applications`
  install). App Translocation (running an unsigned app straight from a
  quarantined Downloads folder) would resolve `process.execPath` to a
  read-only randomized path — users must move the app to `/Applications` and
  remove quarantine first (already documented in the README install steps).
- The proper long-term fix is real Developer ID signing + notarization; this
  is the pragmatic fix for the intentionally-unsigned fork.

## Touched files

- `src/main.js` — updater config, capture downloaded file, manual mac install.
- `src/renderer/app.js` — surface install error message.
