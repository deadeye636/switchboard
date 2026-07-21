'use strict';

// ConPTY build-number hint for xterm's windowsPty option.
//
// xterm enables its LEGACY ConPTY wrapping heuristics only when
// `backend === 'conpty' && buildNumber < XTERM_CONPTY_MODERN_BUILD`. With the
// bundled conpty.dll (#114 — Windows Terminal codebase, proper wrapped-line
// handling) an old Win10 OS build would wrongly keep those heuristics on, so we
// floor the REPORTED build at xterm's threshold. 'system' (the in-box conhost
// ConPTY) keeps the raw OS build so the heuristics engage when they should.
//
// Pure logic, kept out of main.js so it is testable (#268). The build hint honours
// the project → global `conptyBackend` cascade, resolved by the caller.

const XTERM_CONPTY_MODERN_BUILD = 21376;

// system → the raw OS build; bundled → floored at the modern threshold.
function effectiveConptyBuildNumber(conptyBackend, osBuild) {
  return conptyBackend === 'system' ? osBuild : Math.max(osBuild, XTERM_CONPTY_MODERN_BUILD);
}

// Parse the OS build from os.release() ("10.0.22631" → 22631). 0 off Windows or on
// a release string we can't parse.
function osBuildNumber(platform, release) {
  if (platform !== 'win32') return 0;
  const n = parseInt(String(release).split('.')[2], 10);
  return Number.isFinite(n) ? n : 0;
}

// The build hint for a terminal, given the platform, os.release() and the already
// cascade-resolved conptyBackend for that terminal's project. 0 off Windows (xterm
// ignores windowsPty there anyway). Any non-'system' value is treated as bundled.
function conptyBuildHint({ platform, release, conptyBackend }) {
  if (platform !== 'win32') return 0;
  const backend = conptyBackend === 'system' ? 'system' : 'bundled';
  return effectiveConptyBuildNumber(backend, osBuildNumber(platform, release));
}

module.exports = { XTERM_CONPTY_MODERN_BUILD, effectiveConptyBuildNumber, osBuildNumber, conptyBuildHint };
