#!/usr/bin/env node
'use strict';
// The build, with an answer at the end of it (#484).
//
// THE PROBLEM. A failed build left the PREVIOUS installer sitting in `dist/` under the same name.
// Nothing about the directory afterwards said whether the file came from this run or the one before,
// and the only signal in the output was a single line among a few hundred lines of progress. The file
// is there, its name carries the current version, and it is the file you would hand to somebody.
//
// WHY A WRAPPER AND NOT A LINE APPENDED TO THE NPM SCRIPT. `build:win` was an `&&` chain, so nothing
// appended to it runs after a failure — which is the only case that needed the line. And the chain
// starts with the build-info stamp and two bundles, so wrapping electron-builder alone would still let
// an esbuild failure end without a word. This runs every step itself and keeps the exit code.
//
// WHY IT MOVES AND DOES NOT DELETE. `docs/ai/release.md` says `dist/` "is where the previous versions
// already are, so one look tells you what exists", and tells you to `gh release download … --dir dist`;
// `scripts/build-mac.bat` downloads the CI mac artifacts into the same directory. So a sweep that
// unlinks would eat a release's other-platform artifacts mid-release. Everything older than this run
// goes to `dist/previous/` instead — out of the way of the question "what did this run produce", still
// there for the question "what else have I got". #484 asked for exactly that ("or move the stale file
// out of the way").
//
// FIVE THINGS THAT LOOK OBVIOUS AND ARE WRONG, all measured before this was written:
//
//   * `execFile('electron-builder', …)` does not run on Windows. The bin is a `.cmd` shim, and Node
//     refuses to spawn one without a shell (CVE-2024-27980) — `spawn EINVAL`; the extensionless entry
//     gives ENOENT. `process.execPath` on the resolved `cli.js` needs no shim on any platform.
//   * `execFile` buffers stdout and hands it over at exit, so a build would show nothing for minutes and
//     a verbose one would die at the 1 MiB cap and look like a failed build. `stdio: 'inherit'`.
//   * `build-info.json` carries the commit and NO version; the installer's name carries the version and
//     no commit. They cannot be compared. And the stamp is written BEFORE the builder runs, so a failed
//     run still leaves a fresh one. The exit code is the authority; the stamp only supplies the commit
//     for the success line.
//   * Re-deriving the artifact's name means copying electron-builder's own naming rule (there is no
//     `artifactName` for win or mac). Modification time answers the same question on every platform:
//     anything in `dist/` older than this run started did not come from it.
//   * A failure BEFORE the builder starts must sweep nothing. The previous installer is then still the
//     newest thing anybody built, and moving it aside because a bundle failed would be this script
//     causing the confusion it exists to prevent.
//
// KNOWN GAP, stated rather than solved: this sweeps FILES in `dist/` (the installer, its blockmap, the
// update manifests). `dist/win-unpacked/` and the mac app directories are handed out as "the result"
// too (docs/ai/release.md) and are left alone — a half-written unpacked tree is not something to move
// behind the user's back, and it does not carry a version in its name the way the installer does.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PREVIOUS = path.join(DIST, 'previous');

// Everything on our own command line goes to electron-builder untouched, so the npm scripts keep saying
// `--win` / `--mac --arm64` / `--publish always` in the place a reader expects them.
const builderArgs = process.argv.slice(2);

// What counts as "an installer" when the run is asked what it produced. Deliberately generous: a target
// this list does not know makes the success line say "no installer found" about a directory that has one.
const ARTIFACT_EXT = /\.(exe|msi|appx|dmg|pkg|zip|7z|gz|AppImage|deb|rpm|pacman|snap|flatpak)$/i;

function fail(message, extra) {
  // After the builder's own output, on its own line, naming what went wrong. This is the line whose
  // absence is the whole issue.
  console.error('');
  console.error(`[build] FAILED — ${message}`);
  if (extra) console.error(`[build] ${extra}`);
}

function runNode(scriptPath, args, label) {
  const res = spawnSync(process.execPath, [scriptPath, ...args], { stdio: 'inherit', cwd: ROOT });
  if (res.error) return `${label} could not start: ${res.error.message}`;
  if (res.status !== 0) return `${label} exited with code ${res.status}`;
  return null;
}

// A freshly written file can be held for a moment by a virus scanner, so a single attempt is not enough.
function withRetry(action) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      action();
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return true;
      if (err.code !== 'EBUSY' && err.code !== 'EPERM') return false;
      const until = Date.now() + 200;      // a build script; nobody is waiting on this
      while (Date.now() < until) { /* spin */ }
    }
  }
  return false;
}

/**
 * Move every FILE in `dist/` older than this run into `dist/previous/`.
 *
 * On a failure that is the stale installer #484 is about. On a success it is the installer of an earlier
 * version — `Switchboard Setup 0.7.14.exe` beside a 0.7.15 build is the same trap with a different name,
 * and acceptance 3 asks for both. Exported for the test: this is the only real logic in the script.
 */
function sweepOlderThan(startedAt, dist = DIST, previous = PREVIOUS) {
  if (!fs.existsSync(dist)) return [];
  const moved = [];
  for (const name of fs.readdirSync(dist)) {
    const file = path.join(dist, name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile()) continue;               // win-unpacked/, the mac app trees, previous/ itself
    if (stat.mtimeMs >= startedAt) continue;    // written by this run
    if (!fs.existsSync(previous)) fs.mkdirSync(previous, { recursive: true });
    const target = path.join(previous, name);
    if (withRetry(() => fs.renameSync(file, target))) moved.push(name);
    else console.error(`[build] could not move the older ${name} aside — it is in use`);
  }
  return moved;
}

function newestArtifact(startedAt, dist = DIST) {
  if (!fs.existsSync(dist)) return null;
  let best = null;
  for (const name of fs.readdirSync(dist)) {
    const file = path.join(dist, name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile() || stat.mtimeMs < startedAt) continue;
    if (!ARTIFACT_EXT.test(name)) continue;     // the manifests beside it, not the installer
    if (!best || stat.mtimeMs > best.mtimeMs) best = { name, mtimeMs: stat.mtimeMs };
  }
  return best;
}

function buildInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'build-info.json'), 'utf8'));
  } catch {
    return null;
  }
}

function main() {
  const startedAt = Date.now();

  let problem = runNode(path.join(__dirname, 'gen-build-info.js'), [], 'the build-info stamp');
  if (!problem) problem = runNode(path.join(__dirname, 'bundle.js'), [], 'the renderer bundles');

  // Nothing in `dist/` has been replaced until the builder has run, so a failure before that point
  // sweeps nothing: the previous installer is still the newest thing anybody built.
  let builderRan = false;
  if (!problem) {
    let cli;
    try {
      cli = require.resolve('electron-builder/cli.js');
    } catch (err) {
      problem = `electron-builder is not installed: ${err.message}`;
    }
    if (cli) {
      builderRan = true;
      const res = spawnSync(process.execPath, [cli, ...builderArgs], { stdio: 'inherit', cwd: ROOT });
      if (res.error) problem = `electron-builder could not start: ${res.error.message}`;
      else if (res.status !== 0) problem = `electron-builder exited with code ${res.status}`;
    }
  }

  const moved = builderRan ? sweepOlderThan(startedAt) : [];
  const fresh = newestArtifact(startedAt);

  if (problem) {
    if (moved.length) console.error(`[build] moved ${moved.length} older file(s) to dist/previous/: ${moved.join(', ')}`);
    // An artifact CAN exist after a failure — the builder wrote the installer and a later step (signing,
    // publishing) then failed. Saying "no installer was produced" there would be this script asserting
    // the very thing it exists to keep honest.
    fail(problem, fresh
      ? `dist/${fresh.name} was written before the failure — it is NOT a finished build.`
      : 'No installer was produced by this run.');
    process.exit(1);
  }

  const info = buildInfo();
  const commit = info ? `${info.branch} @ ${info.commit}${info.dirty ? ' (dirty)' : ''}` : 'unknown commit';
  console.log('');
  if (moved.length) console.log(`[build] moved ${moved.length} older file(s) to dist/previous/: ${moved.join(', ')}`);
  if (fresh) console.log(`[build] OK — dist/${fresh.name}  ·  built from ${commit}`);
  else console.log(`[build] OK — built from ${commit}, but no installer file was found in dist/. Check the builder's targets.`);
}

module.exports = { sweepOlderThan, newestArtifact, ARTIFACT_EXT };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    // Without this a throw anywhere above ends in a stack trace and no `[build] FAILED` line — which is
    // acceptance 1's exact failure shape, produced by the script written to satisfy it.
    fail(`the build wrapper itself threw: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  }
}
