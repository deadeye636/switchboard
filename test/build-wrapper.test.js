'use strict';
// #484 — a build has to say whether the installer in `dist/` came from THIS run.
//
// The failure this guards: a build that fails leaves the previous installer sitting there under the same
// name, and the only sign is one line among a few hundred lines of progress. Every piece below is
// something that was measured and got the shape of the wrapper wrong the obvious way.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stripComments } = require('./helpers/strip-comments');

const root = (...p) => path.join(__dirname, '..', ...p);
const read = (...p) => stripComments(fs.readFileSync(root(...p), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(root('package.json'), 'utf8'));

const BUILD_SCRIPTS = ['build', 'build:win', 'build:mac', 'build:mac:arm64', 'build:linux', 'release'];

test('every build script goes through the wrapper', () => {
  for (const name of BUILD_SCRIPTS) {
    const script = pkg.scripts[name];
    assert.ok(script, `there must be a ${name} script`);
    assert.match(script, /scripts\/build-and-verify\.js/, `${name} does not go through the wrapper`);
  }
});

test('no build script discards the exit code any more', () => {
  // `build:mac` and `build:mac:arm64` ended in `; true` and exited 0 on a failed build — the same defect
  // #484 reports, one platform over. A `|| true` on the codesign step alone is fine: a missing local
  // signing identity is not a failed build.
  for (const name of BUILD_SCRIPTS) {
    const script = pkg.scripts[name];
    assert.ok(
      !/;\s*true\s*$/.test(script),
      `${name} ends in "; true", which turns every failure into a success`,
    );
  }
});

test('the wrapper spawns electron-builder in the one shape that runs on Windows', () => {
  const src = read('scripts', 'build-and-verify.js');
  // A `.cmd` shim cannot be spawned without a shell (Node refuses it since CVE-2024-27980), and the
  // extensionless entry does not exist. `process.execPath` on the resolved cli.js works everywhere.
  assert.match(src, /require\.resolve\('electron-builder\/cli\.js'\)/);
  assert.match(src, /process\.execPath/);
  // execFile buffers output and hands it over at exit; a build must stream.
  assert.match(src, /stdio:\s*'inherit'/);
});

test('the wrapper runs the pre-steps itself, so a bundling failure is reported too', () => {
  // The npm script used to be `gen-build-info && bundle && bundle && electron-builder`, so anything
  // appended ran only when the builder itself failed — and never when a step in front of it did.
  const src = read('scripts', 'build-and-verify.js');
  assert.match(src, /gen-build-info\.js/);
  assert.match(src, /bundle\.js/);
});

test('the wrapper identifies the artifact by time, not by re-deriving its name', () => {
  const src = read('scripts', 'build-and-verify.js');
  // There is no `artifactName` for win or mac, so a name check would be a second copy of
  // electron-builder's own naming rule — and a different one per platform.
  assert.match(src, /mtimeMs/);
  assert.ok(
    !/Switchboard Setup/.test(src),
    'the wrapper must not spell the installer name; that is electron-builder\'s to decide',
  );
});

test('the wrapper ends with a line about this run, either way', () => {
  const src = read('scripts', 'build-and-verify.js');
  assert.match(src, /FAILED/, 'a failed build must name the failure after the builder\'s own output');
  assert.match(src, /built from/, 'a successful build must name the artifact and the commit');
  assert.match(src, /process\.exit\(1\)/, 'and it must not exit 0 on a failure');
});

// --- The sweep, run for real. It is the only real logic in the script, and a source regex cannot tell
// "moves the older file" from "deletes the newer one". `sweepOlderThan`/`newestArtifact` take their
// directories as arguments so this can point them at a temporary one.
const wrapper = require('../scripts/build-and-verify.js');

function tempDist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-build-'));
  const dist = path.join(dir, 'dist');
  fs.mkdirSync(dist);
  return { dir, dist, previous: path.join(dist, 'previous') };
}

function write(dist, name, ageMs) {
  const file = path.join(dist, name);
  fs.writeFileSync(file, 'x');
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
  return file;
}

test('the sweep MOVES what an earlier run left, and keeps what this one wrote', () => {
  const { dir, dist, previous } = tempDist();
  try {
    write(dist, 'Switchboard Setup 0.7.14.exe', 60_000);
    write(dist, 'Switchboard Setup 0.7.14.exe.blockmap', 60_000);
    write(dist, 'latest.yml', 60_000);
    const startedAt = Date.now() - 1000;
    write(dist, 'Switchboard Setup 0.7.15.exe', 0);
    fs.mkdirSync(path.join(dist, 'win-unpacked'));

    const moved = wrapper.sweepOlderThan(startedAt, dist, previous);

    assert.deepEqual(moved.sort(), [
      'Switchboard Setup 0.7.14.exe',
      'Switchboard Setup 0.7.14.exe.blockmap',
      'latest.yml',
    ]);
    // Moved, never deleted: docs/ai/release.md says dist/ is where the other platforms' artifacts are
    // downloaded to, so unlinking would eat a release's own files mid-release.
    for (const name of moved) assert.ok(fs.existsSync(path.join(previous, name)), `${name} must survive in previous/`);
    assert.ok(fs.existsSync(path.join(dist, 'Switchboard Setup 0.7.15.exe')), 'the artifact this run wrote stays');
    assert.ok(fs.existsSync(path.join(dist, 'win-unpacked')), 'directories are left alone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the success line names the artifact this run wrote, not an older one', () => {
  const { dir, dist } = tempDist();
  try {
    write(dist, 'Switchboard Setup 0.7.14.exe', 60_000);
    const startedAt = Date.now() - 1000;
    write(dist, 'Switchboard Setup 0.7.15.exe', 0);
    write(dist, 'latest.yml', 0);

    const artifact = wrapper.newestArtifact(startedAt, dist);
    assert.equal(artifact.name, 'Switchboard Setup 0.7.15.exe', 'a manifest is not the installer');
    assert.equal(wrapper.newestArtifact(Date.now() + 60_000, dist), null, 'nothing from this run means nothing to name');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the artifact list covers every platform the builder can target', () => {
  for (const name of ['a.exe', 'a.msi', 'a.dmg', 'a.zip', 'a.AppImage', 'a.deb', 'a.rpm', 'a.pacman', 'a.snap', 'a.tar.gz']) {
    assert.ok(wrapper.ARTIFACT_EXT.test(name), `${name} must count as an installer`);
  }
  for (const name of ['latest.yml', 'builder-debug.yml', 'a.blockmap']) {
    assert.ok(!wrapper.ARTIFACT_EXT.test(name), `${name} is a manifest, not an installer`);
  }
});

test('a failure before the builder starts sweeps nothing', () => {
  // The previous installer is then still the newest thing anybody built, and moving it aside because a
  // bundle failed would be this script causing the confusion it exists to prevent.
  const src = read('scripts', 'build-and-verify.js');
  assert.match(src, /builderRan \? sweepOlderThan/);
});

test('a failure after an artifact was written does not claim there is none', () => {
  // The builder can write the installer and a later step (signing, publishing) fail. Saying "no installer
  // was produced" there is the script asserting the very thing it exists to keep honest.
  const src = read('scripts', 'build-and-verify.js');
  assert.match(src, /was written before the failure/);
});

test('a throw in the wrapper still ends with the failure line', () => {
  const src = read('scripts', 'build-and-verify.js');
  assert.match(src, /catch \(err\)[\s\S]{0,200}fail\(/, 'without this a throw ends in a stack trace and no line');
});

test('the bundler is one definition with several callers', () => {
  // Four callers need the same esbuild flags. A copy in any of them is the defect
  // .claude/rules/guards-and-scripts.md names — scripts/demo-start.js carried one until #484.
  for (const [name, script] of [['start', pkg.scripts.start], ['start:debug', pkg.scripts['start:debug']]]) {
    assert.match(script, /scripts\/bundle\.js/, `${name} must run the shared bundler`);
  }
  for (const caller of ['build-and-verify.js', 'demo-start.js']) {
    assert.match(read('scripts', caller), /bundle\.js/, `${caller} must run the shared bundler`);
    assert.ok(
      !/esbuild/.test(read('scripts', caller)),
      `${caller} must not carry its own copy of the esbuild flags`,
    );
  }
});

test('CI runs the same wrapper as a local build', () => {
  const ci = fs.readFileSync(root('.github', 'workflows', 'build.yml'), 'utf8');
  assert.match(ci, /scripts\/build-and-verify\.js/);
  // It used to call `npx electron-builder` directly after bundling CodeMirror alone — so its installers
  // shipped without the PDF bundles, and a failed step ended without the line.
  assert.ok(!/npx electron-builder/.test(ci), 'CI must not bypass the wrapper');
});
