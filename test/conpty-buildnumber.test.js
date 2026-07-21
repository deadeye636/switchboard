'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  XTERM_CONPTY_MODERN_BUILD,
  effectiveConptyBuildNumber,
  osBuildNumber,
  conptyBuildHint,
} = require('../src/app/terminal/conpty');

const MODERN = XTERM_CONPTY_MODERN_BUILD; // 21376

test('effectiveConptyBuildNumber: system reports the raw OS build (old and new)', () => {
  assert.equal(effectiveConptyBuildNumber('system', 19045), 19045); // old Win10 build, unfloored
  assert.equal(effectiveConptyBuildNumber('system', 22631), 22631); // newer build, unchanged
});

test('effectiveConptyBuildNumber: bundled floors an old build at the modern threshold', () => {
  // Old OS build + bundled conpty.dll: report modern so xterm drops its legacy heuristics.
  assert.equal(effectiveConptyBuildNumber('bundled', 19045), MODERN);
  // A build already >= threshold is left as-is.
  assert.equal(effectiveConptyBuildNumber('bundled', 22631), 22631);
  assert.equal(effectiveConptyBuildNumber('bundled', MODERN), MODERN);
});

test('osBuildNumber: parses the Windows release, 0 elsewhere or on garbage', () => {
  assert.equal(osBuildNumber('win32', '10.0.22631'), 22631);
  assert.equal(osBuildNumber('win32', '10.0.19045.1234'), 19045);
  assert.equal(osBuildNumber('linux', '6.1.0'), 0);   // not Windows
  assert.equal(osBuildNumber('darwin', '23.5.0'), 0); // not Windows
  assert.equal(osBuildNumber('win32', 'nonsense'), 0); // unparseable
  assert.equal(osBuildNumber('win32', ''), 0);
});

test('conptyBuildHint: 0 off Windows regardless of backend', () => {
  assert.equal(conptyBuildHint({ platform: 'linux', release: '6.1.0', conptyBackend: 'bundled' }), 0);
  assert.equal(conptyBuildHint({ platform: 'darwin', release: '23.5.0', conptyBackend: 'system' }), 0);
});

test('conptyBuildHint: combines OS build with the resolved backend on Windows', () => {
  // system keeps the old build; bundled floors it — the per-project cascade decides which.
  assert.equal(conptyBuildHint({ platform: 'win32', release: '10.0.19045', conptyBackend: 'system' }), 19045);
  assert.equal(conptyBuildHint({ platform: 'win32', release: '10.0.19045', conptyBackend: 'bundled' }), MODERN);
  assert.equal(conptyBuildHint({ platform: 'win32', release: '10.0.22631', conptyBackend: 'bundled' }), 22631);
  // Anything that isn't 'system' is treated as bundled (default).
  assert.equal(conptyBuildHint({ platform: 'win32', release: '10.0.19045', conptyBackend: undefined }), MODERN);
});
