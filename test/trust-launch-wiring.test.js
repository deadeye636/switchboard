'use strict';
// #655 — which renderer launch paths put the trust question to the user, and which only say "not started".
//
// A backend that starts only in a trusted project refuses the spawn with an `untrusted` payload
// (`src/app/terminal/spawn.js`, tested in `spawn-guards.test.js`). What the renderer does with it depends on
// who launched: somebody at the keyboard gets the confirm and a retry, a mount nobody clicked for (the restore
// at start, the boot fallback, a detached window's own restore) gets no dialog.
//
// A SOURCE check, and it says so: `launchNewSession` and `openSession` live in app.js with dozens of globals
// around them, and there is no seam that reaches them without the whole renderer. What this pins is the
// regression that will actually happen — a new automatic caller that forgets `askTrust: false`, or a tidy-up
// that drops the `show && askTrust` guard — and the confirm itself is exercised live (the click test on #655).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripComments } = require('./helpers/strip-comments');

const read = (rel) => stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', rel), 'utf8'));
const APP = read('app.js');
const RESTORE = read('shell/session-restore.js');
const DETACH = read('shell/detach-window.js');
const DIALOGS = read('dialogs/dialogs.js');
const ADMIN = read('panels/projects-admin.js');

function body(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} is where this test expects it`);
  let depth = 0;
  // The body's brace, not a destructured parameter's: the first `) {` after the signature.
  for (let i = src.indexOf(') {', start) + 2; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${signature}`);
}

test('a new session asks for trust and starts again once on a yes', () => {
  const fn = body(APP, 'async function launchNewSession(');
  assert.match(fn, /result\.untrusted[\s\S]{0,120}grantTrustForLaunch\(result\.untrusted\)/);
  assert.equal((fn.match(/window\.api\.openTerminal\(/g) || []).length, 2, 'one launch, one retry — never a loop');
});

test('a resume asks only when it was opened to be shown and nobody said not to', () => {
  const fn = body(APP, 'async function openSession(');
  assert.match(fn, /askTrust = true/);
  assert.match(fn, /result\.untrusted && show && askTrust[\s\S]{0,80}grantTrustForLaunch\(result\.untrusted\)/);
  assert.equal((fn.match(/window\.api\.openTerminal\(/g) || []).length, 2);
});

test('the mounts nobody clicked for ask nothing', () => {
  assert.match(APP, /openSession\(session, null, \{ askTrust: false \}\)/, 'the boot fallback');
  assert.match(RESTORE, /openSession\(session, null, \{ show: false \}\)/, 'the launch restore mounts with show:false');
  assert.match(DETACH, /mountOnce\(session, !first, \{ askTrust: false \}\)/, 'a detached window\'s own restore');
  assert.match(DETACH, /openSession\(session, undefined, \{ show, askTrust \}\)/, 'and mountOnce passes it on');
});

test('a headless restore that was refused is said once, not dropped', () => {
  const fn = body(RESTORE, 'async function startSessionProcess(');
  assert.match(fn, /result\.untrusted\) untrustedRestores\.push/);
  assert.match(RESTORE, /refreshSessionStatusViews\(\);\s*reportUntrustedRestores\(\);/);
  assert.match(DETACH, /reportUntrustedRestores\(\)/);
  // …and saying it goes through the renderer's one GLOBAL toast. A bare `toast` is every module's own local,
  // so a guarded call to it is quietly false and says nothing at all — the first version of this did that.
  const report = body(RESTORE, 'function reportUntrustedRestores(');
  assert.match(report, /showControlToast\(\{ message: line/);
  assert.ok(!/\btoast\(/.test(report.replace(/showControlToast\(/g, '')), 'no bare toast()');
});

test('one confirm for granting trust, used by the Projects manager and by a launch alike', () => {
  assert.match(DIALOGS, /function confirmProjectTrustGrant\(/);
  assert.match(body(DIALOGS, 'async function grantTrustForLaunch('), /confirmProjectTrustGrant\(/);
  assert.match(ADMIN, /confirmProjectTrustGrant\(\{/);
  assert.ok(!/title: `Grant trust to this project/.test(ADMIN), 'the manager no longer carries a copy of the text');
});
