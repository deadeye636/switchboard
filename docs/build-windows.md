# Windows build (NSIS installer)

How to build Switchboard's Windows installer with VS 2026 / Visual Studio Build Tools, x64.
As of 2026-07-31.

## TL;DR

```bash
unset NoDefaultCurrentDirectoryInExePath && npm run build:win
```

Result: `dist/Switchboard Setup <version>.exe` (NSIS) plus the unpacked `dist/win-unpacked/`.

The `unset` is the **only** manual step, once per shell. The other two historical stumbling blocks
(the node-gyp version, node-pty's Spectre mitigation) are pinned in the repo and need no hand-holding
any more.

## Prerequisites

- **Node.js** — the same major as `package.json`/CI (Electron 41 ABI).
- **Visual Studio 2026 Build Tools** with the C++ desktop workload, for the native modules
  `better-sqlite3` and `node-pty`.
- **Python**, which node-gyp needs.
- Target architecture: **x64**. No arm64 toolchain is set up.

## The three stumbling blocks — cause and cure

### 1. node-gyp >= 13 (VS 2026 is MSVC major 18)

An older node-gyp does not recognise VS 2026 (toolset major 18) and aborts the native compilation.

**Durable fix** — in `package.json`:
```json
"overrides": { "node-gyp": "13.0.0" }
```
That forces node-gyp 13 for every transitive dependency. **Do not remove it.**

### 2. node-pty's Spectre mitigation (MSB8040)

node-pty's `binding.gyp` asks for `SpectreMitigation: 'Spectre'`. Without the Spectre-hardened MSVC
runtime libraries installed, the build stops at **MSB8040**. We build without the mitigation: this is
a desktop app with a local PTY, and there is no Spectre attack model here worth the dependency.

**Durable fix** — `patches/node-pty+1.2.0-beta.14.patch` sets `SpectreMitigation: 'false'` in exactly
**one** place:
- `node_modules/node-pty/binding.gyp` (once)

Since node-pty 1.2.x **winpty is gone from the package**, so the two former patch sites in
`deps/winpty/src/winpty.gyp` no longer exist.

**The patch is keyed to the file name and therefore to the exact version.** `package.json` pins
`"node-pty": "^1.2.0-beta.14"` — a caret on a prerelease, which npm also satisfies with a final
`1.2.0`. So a casual `npm update` un-patches the Windows build **silently**, and it comes back as
MSB8040. After any version change: regenerate the patch (below) and delete the old file.

The `postinstall` hook re-applies it:
```json
"scripts": { "postinstall": "patch-package && node scripts/postinstall.js && node scripts/ensure-conpty-dll.js" }
```
(`ensure-conpty-dll.js` copies node-pty's bundled `conpty.dll` into place; it also runs as an
electron-builder `beforePack` hook — see below.) So it survives every `npm install`. **Do not remove
the patch or the postinstall hook.**

To check that `node_modules` is currently patched:
```bash
grep -c "false" node_modules/node-pty/binding.gyp
# expected: 1
```

### 2b. Why node-pty runs on a beta channel

node-pty 1.1.0 touches its global handle table from every PTY's watcher thread **without a lock**
while the JS thread is appending to it. The vector can be reallocated mid-iteration — and the removal,
which asserts its own success, then fails: a native **`Assertion failed!`** dialog with
Abort/Retry/Ignore, on top of the use-after-free it is warning about.

Upstream fixed it in **1.2.0-beta.13** (a mutex around the table, `std::erase_if` instead of the
asserting removal). `latest` is still 1.1.0 and predates that, so the fix exists only on the beta
channel — VS Code ships from there for the same reason (`"node-pty": "^1.2.0-beta.13"`).

**`NDEBUG` is not a way out**: the assert carries the removal as its argument, so the call would go
with it, turning a loud crash into a silent use-after-free plus a handle leak.

Regenerating the patch after a node-pty update (a version change means a new patch file name,
`node-pty+<new-version>.patch`):
```bash
# set SpectreMitigation:'false' by hand in node_modules/node-pty/*.gyp, then:
npx patch-package node-pty
git add patches/ && # commit
```

### 3. `NoDefaultCurrentDirectoryInExePath` (per shell, not patchable)

With this environment variable set, winpty's gyp `.bat` intermediate step used to fail — it could not
find relatively invoked tools in the working directory. It is a runtime environment variable rather
than a file, so it has to be cleared per shell before the build:

> **Unverified since node-pty 1.2.x:** the cause named above — winpty's `.bat` step — **no longer
> exists**. winpty is gone from the package and `binding.gyp` has no such intermediate step. Whether
> the workaround is still needed can only be answered by a build with the variable set. Until then it
> stays: a false positive costs one `unset`, a false negative costs a baffling build failure.

```bash
unset NoDefaultCurrentDirectoryInExePath && npm run build:win
```

(Deliberately **not** folded into the `build:win` script: `unset` is bash syntax, and npm runs scripts
on Windows in cmd or sh depending on configuration, so the wrapper would not be portable. Prefixing it
by hand is the more robust answer.)

## What `build:win` actually does

1. `node scripts/gen-build-info.js` — stamps `build-info.json` (branch, commit, dirty flag, date) for
   the About screen. Gitignored.
2. `npm run bundle:codemirror` — esbuild bundles `src/renderer/jsonl/codemirror-setup.js` into
   `src/renderer/codemirror-bundle.js`. Gitignored.
3. `electron-builder --win` — rebuilds the native modules against the Electron ABI (node-gyp 13 plus
   the patched node-pty gyp), then packs the NSIS installer. The `beforePack` hook
   `scripts/ensure-conpty-dll.js` copies node-pty's bundled `conpty.dll` next to the local node-pty
   build: the rebuild during packing wipes `build/Release`, so the postinstall run alone is not
   enough (#114).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `MSB8040`, Spectre libs | the node-pty patch is not applied | `npx patch-package`, or `npm install` for the postinstall |
| the gyp `.bat` step fails with a path error | `NoDefaultCurrentDirectoryInExePath` is set | `unset …` before the build |
| node-gyp does not find VS, or a toolset error | node-gyp older than 13 | check the `overrides` entry, then `npm install` |
| the patch does not apply (version mismatch) | node-pty's version no longer matches the patch file name | regenerate the patch, above |

## Open / not done

- **Code signing**: the Windows installer is **not signed** — there is no certificate.
- **CI**: no automated Windows build.
