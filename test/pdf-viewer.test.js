'use strict';
// #465 — the wiring the PDF viewer needs, guarded where a missing piece is silent.
//
// The failure this file exists for: every piece here is loaded at RUNTIME (a bundle fetched when a PDF
// is opened, a worker fetched by that bundle), so nothing fails at start-up, nothing fails in the
// suite, and the first sign of a missing bundle is an empty panel in front of a user.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = (...p) => path.join(__dirname, '..', ...p);
const read = (...p) => fs.readFileSync(root(...p), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('pdf.js is a dependency, not a hopeful import', () => {
  assert.ok(pkg.dependencies['pdfjs-dist'], 'pdfjs-dist must be a runtime dependency');
});

test('the bundler builds BOTH the viewer and the worker', () => {
  // Since #484 the flags live in scripts/bundle.js rather than in an npm script, because a second
  // caller appeared (scripts/build-and-verify.js) and a second copy of the flag set is the defect
  // .claude/rules/guards-and-scripts.md names.
  const bundler = read('scripts', 'bundle.js');
  assert.match(bundler, /pdf-setup\.js/, 'the viewer entry');
  assert.match(bundler, /pdf\.worker\.mjs/, 'the worker entry — pdf.js refuses to parse without one');
  assert.match(bundler, /pdf-bundle\.js/);
  assert.match(bundler, /pdf-worker\.js/);
});

test('every pipeline that starts or builds the app runs the bundler', () => {
  // A start or build script that forgets it produces an app whose PDF panel is empty, with the reason
  // only visible in the console.
  const RUNS_THE_APP = ['start', 'start:debug', 'build', 'build:win', 'build:linux', 'build:mac', 'build:mac:arm64', 'release'];
  for (const name of RUNS_THE_APP) {
    const script = pkg.scripts[name];
    assert.ok(script, `there must be a ${name} script`);
    assert.ok(
      /scripts\/bundle\.js/.test(script) || /scripts\/build-and-verify\.js/.test(script),
      `${name} neither bundles nor goes through the wrapper that does`,
    );
  }
  // The build wrapper is what the build scripts delegate to, so it has to run the bundler itself.
  assert.match(read('scripts', 'build-and-verify.js'), /bundle\.js/);
  // The demo launcher runs the same bundler rather than a copy of its flags.
  assert.match(read('scripts', 'demo-start.js'), /bundle\.js/, 'the demo launcher must run the shared bundler');
});

test('the worker path the bundle asks for is the file the build writes', () => {
  const setup = read('src', 'renderer', 'views', 'pdf-setup.js');
  const m = /workerSrc = '([^']+)'/.exec(setup);
  assert.ok(m, 'pdf-setup.js must set GlobalWorkerOptions.workerSrc');
  assert.equal(m[1], 'pdf-worker.js', 'the worker is loaded relative to the page, beside the bundle');
  assert.ok(read('scripts', 'bundle.js').includes(m[1]),
    'the build writes a different file than the bundle asks for');
});

test('both bundles are ignored by git, like the CodeMirror one', () => {
  const ignore = read('.gitignore');
  for (const f of ['src/renderer/pdf-bundle.js', 'src/renderer/pdf-worker.js']) {
    assert.ok(ignore.split(/\r?\n/).includes(f), `${f} is a build artifact and must not be committed`);
  }
});

test('the viewer reaches the bundle through window, never as a bare global', () => {
  // The bundle is excluded from every lint environment, so a bare `renderPdfInto` would be an
  // undefined reference nothing checks — the same rule the CodeMirror bundle is held to.
  const viewer = read('src', 'renderer', 'views', 'viewer-panel.js');
  assert.match(viewer, /window\.renderPdfInto\(/);
  assert.ok(!/[^.]\brenderPdfInto\(/.test(viewer.replace(/window\.renderPdfInto\(/g, '')),
    'renderPdfInto must only be reached through window');
});

test('the CSP was left alone', () => {
  // Chromium's own PDF viewer would have needed `object-src`/`frame-src` for a blob, and it does not
  // work in the renderer anyway (measured, spec 22). pdf.js draws into canvases this app owns, so the
  // policy stays as narrow as it was — this test is what notices if someone widens it again.
  const csp = read('src', 'app', 'lifecycle.js');
  const line = csp.split('\n').find(l => l.includes('Content-Security-Policy'));
  assert.ok(line, 'the CSP header must be set');
  assert.ok(!/object-src/.test(line), 'the PDF viewer needs no object-src');
  assert.ok(!/frame-src/.test(line), 'the PDF viewer needs no frame-src');
});

test('no window turns the plugin surface back on for it', () => {
  for (const file of ['src/app/windows.js', 'src/app/detach.js']) {
    assert.ok(!/plugins:\s*true/.test(read(...file.split('/'))), `${file} enables plugins, which the PDF viewer does not need`);
  }
});
