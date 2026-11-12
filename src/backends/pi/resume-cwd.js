// backends/pi/resume-cwd.js — a Pi session whose working directory is gone (#862).
//
// Since Pi 1.5.2 a resume of such a session asks "Continue, Fork or Cancel" (`--session`, `--resume`,
// `/resume`). Measured on 1.5.2 (docs/specs/30-pi-native.md): with no terminal to answer, `pi --mode rpc
// --session <file>` exits 1 with "Stored session working directory does not exist", and Pi offers NO flag for
// "continue in the current folder" — the choice exists only inside the interactive prompt. `--fork <id|file>`
// is non-interactive and works.
//
// So this backend answers the two halves for the core, which asks BEFORE the launch (the descriptor hook
// `resumeCwd`, consumed by `app/terminal/missing-cwd.js`):
//   - `read(file)`        the directory the header says the session ran in;
//   - `continueIn(...)`   makes the session run in another one, by rewriting that one header field (the same
//                         rewrite a project remap does, #171). The file stays where it is, so the launch
//                         names it by path (`resumeRef`): `--session <id>` looks in the folder Pi derives
//                         from the CURRENT directory and would ask "Fork this session?" on stdin.
// A fork needs nothing here: it is the existing `--fork <id>`.
'use strict';

const fs = require('fs');
const { rewriteTranscript, piLine } = require('../rewrite-cwd');

// The header is the first line and a few hundred bytes; 64 KB is a ceiling, not an expectation.
const HEADER_BYTES = 64 * 1024;

/** The cwd on the header line of a Pi transcript, or null when there is none or the file cannot be read. */
function read(file) {
  if (!file) return null;
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEADER_BYTES);
    const n = fs.readSync(fd, buf, 0, HEADER_BYTES, 0);
    const end = buf.indexOf(0x0a);
    const line = buf.subarray(0, end >= 0 && end < n ? end : n).toString('utf8');
    const header = JSON.parse(line);
    return header && header.type === 'session' && typeof header.cwd === 'string' && header.cwd ? header.cwd : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* nothing to close */ } }
  }
}

/**
 * @returns {{ok: boolean, reason?: string}}
 */
function continueIn({ file, storedCwd, cwd } = {}) {
  if (!file || !storedCwd || !cwd) return { ok: false, reason: 'unreadable' };
  const res = rewriteTranscript(file, storedCwd, cwd, piLine);
  // `changed: false` with ok: the header did not name `storedCwd` any more (another tool moved it first).
  // The launch is still right to go on: the folder it names is no longer the one that was asked about.
  return res && res.ok ? { ok: true } : { ok: false, reason: (res && res.reason) || 'failed' };
}

module.exports = { read, continueIn };
