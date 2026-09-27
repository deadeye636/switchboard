// backends/claude-native/version.js — which Claude Code this backend can drive (#660).
//
// The oldest Claude Code this backend was measured against. The control half of the protocol (approvals over
// stdio, the `priority` of a queued line, `conversation_reset`) is documented mainly by the SDK's source and
// changes without notice, so an older CLI is refused at launch rather than half-working. It is checked on
// `--version`, not on the capability list the stream carries: that list first appears in the `system/init` of
// the first turn (measured), which is after the user's first message has already gone out.
//
// Asked only when a session is about to START (`probe({ launch: true })`), never by the registry's `list()`:
// that runs on the scan path whether or not this backend is switched on, and a child process there cost every
// Claude user a `claude --version` on the main thread after each auto-update. Asynchronous for the same
// reason — the click that starts a session should not freeze the window while the binary answers.
'use strict';

const fs = require('fs');
const { execFile } = require('child_process');
const { closeStdin } = require('../cli-probe');

const MIN_VERSION = [2, 1, 283];

function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function olderThan(v, floor = MIN_VERSION) {
  for (let i = 0; i < floor.length; i++) {
    if (v[i] !== floor[i]) return v[i] < floor[i];
  }
  return false;
}

// `claude --version` as `{ status, stdout }`. A probe only reads, so the child's stdin is closed (#532).
function runVersion(file) {
  return new Promise((resolve) => {
    closeStdin(execFile(file, ['--version'], { timeout: 5000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '' });
    }));
  });
}

// Cached by the BINARY rather than by time: a version only changes when the file does, so the child runs once
// per install, not once per launch. An unanswered probe is remembered for a short while only (#546): one
// unlucky exec must not decide the next hour, and a probe that could not answer asserts nothing.
const UNANSWERED_TTL_MS = 30 * 1000;
let cache = null;   // { file, size, mtimeMs, version, at, answered }

/** The installed version as `[major, minor, patch]`, or null when it could not be read. Resolves, never rejects. */
async function installedVersion(file, { run = runVersion } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const c = cache;
  if (c && c.file === file && c.size === st.size && c.mtimeMs === st.mtimeMs
    && (c.answered || Date.now() - c.at < UNANSWERED_TTL_MS)) return c.version;
  let version = null;
  try {
    const r = await run(file);
    version = r && r.status === 0 ? parseVersion(r.stdout) : null;
  } catch { version = null; }
  cache = { file, size: st.size, mtimeMs: st.mtimeMs, version, at: Date.now(), answered: version !== null };
  return version;
}

/** Test hook: forget the cached answer. */
function resetCache() { cache = null; }

module.exports = { MIN_VERSION, parseVersion, olderThan, installedVersion, resetCache };
