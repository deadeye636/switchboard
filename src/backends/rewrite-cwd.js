// backends/rewrite-cwd.js — move a session's transcript from one project path to another (#171).
//
// A remap used to rewrite `~/.claude/projects/**` and nothing else. So a project with Claude AND Codex
// sessions split in two: Claude's history followed the rename, Codex' stayed behind as a phantom project
// at the old path. A project with ONLY Codex sessions could not be remapped at all — the handler bailed
// with "No session data found", because it looked in Claude's store for them.
//
// Each backend knows where its own cwd lives, so each declares how to rewrite it. This is the shared
// machinery: read the JSONL, hand every line to the backend's rule, write it back.
//
// A backend whose store is not files (Hermes: a read-only SQLite we may never write, #2914) declares
// nothing — and the caller reports honestly that those sessions keep the old path.
//
// ## Why this is NOT `src/app/safe-write.js` (#557)
//
// CLAUDE.md rule 11 sends every write of a file a CLI reads through `safe-write.js`, and this one does
// not go there. The reason is what the other party is doing: the files `safe-write.js` guards are small
// settings blobs a human edits in a dialog, and its answer to a race is to refuse the write and hand the
// conflict back. The file here is the transcript of a session that may be MID-TURN, appended to by the
// CLI a line at a time, and neither half of that shape fits.
//
//   - **A refusal is not an answer here.** A transcript can go stale again on every attempt, so a
//     refuse-and-retry loop would report a failure for exactly the sessions that matter most — the
//     running ones. So the write is APPEND-AWARE instead: only the bytes that were there when we read
//     are ours to rewrite, and everything the CLI appended after that offset is carried over VERBATIM —
//     not re-parsed, not re-serialised, not rewritten. That is also what makes rewriting a LIVE session
//     safe, which is why this file does not skip one.
//   - **Line endings are per LINE, not per document.** `safe-write.js` re-applies the file's majority
//     EOL to everything it writes, which is right for a config a human edits and wrong for an
//     append-only log several versions of a CLI have written over months: normalising it rewrites every
//     line nobody touched. Each line here keeps the terminator it came with.
//
// What IS shared is the rename: Windows fails a rename-over-target with EPERM/EBUSY while a handle is
// open on the file, which for a live transcript is the ordinary case rather than the exotic one. That
// retry has one right implementation in this app, and this file imports it rather than growing a second.
'use strict';

const fs = require('fs');
// "Is this the same directory" has one answer, and it is about the REAL path of both sides (#563).
const { pathKey } = require('../app/path-containment');
// The Windows rename-over-target retry, not a second copy of it (#441/#557).
const { renameWithRetry } = require('../app/safe-write');

/**
 * Same directory? Windows spells it both ways in the same store (`d:\x` and `D:\X`).
 *
 * This was a string compare of its own, and it got the Windows half it was written for wrong as well
 * (#563). It trimmed a trailing separator and lowercased on `win32` — but it never folded `\` against
 * `/`, which its sibling key in `session/derive-project-path.js` did, so `d:/x` and `d:\x` were two
 * directories to the remap and one to everything else. Being lexical at all is the larger half: a project
 * reached through a junction, a symlink or a `subst` drive is spelled two ways, the compare said
 * "different", and the remap skipped exactly the lines it was called to rewrite — leaving a phantom
 * project at the old path, which is the bug #171 built this file to fix.
 *
 * (The issue that sent us here called the lowercase unconditional. It was not — it was already behind a
 * `process.platform === 'win32'` check, so the Linux direction, where two directories differing only in
 * case would have been merged and one transcript rewritten with the other's path, was never live here.)
 *
 * `pathKey` is the memoised form, and here that is not an optimisation but the difference between a
 * usable remap and an unusable one: `claudeLine` asks this on EVERY line of a transcript that can reach
 * hundreds of megabytes, and a filesystem round trip per line would be minutes. The paths asked about are
 * two — the old path and whatever the line names — so the memo answers all but the first few.
 */
function samePath(a, b) {
  if (!a || !b) return false;
  return pathKey(a) === pathKey(b);
}

/**
 * Split JSONL text into lines that each remember their OWN terminator (decision 4 of #557).
 *
 * The reason this is not `text.split('\n')` joined back with `'\n'`: a transcript is written by a CLI
 * over months, sometimes by more than one version of it, so mixed CRLF and LF inside one file is a real
 * state rather than a hypothetical. Re-terminating the document — either way round — rewrites every line
 * of somebody else's append-only log in order to move one field, and a whole-file diff is exactly what
 * this write must not produce. A line we leave alone comes back byte-identical; a line we rewrite keeps
 * the terminator it arrived with.
 *
 * The input is only the COMPLETE part of the file, so every entry but a trailing scrap carries a
 * terminator.
 */
function splitKeepingEol(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue;   // '\n'
    const cr = i > start && text.charCodeAt(i - 1) === 13;   // '\r'
    out.push({ body: text.slice(start, cr ? i - 1 : i), eol: cr ? '\r\n' : '\n' });
    start = i + 1;
  }
  if (start < text.length) out.push({ body: text.slice(start), eol: '' });
  return out;
}

/** A rename that failed because something holds a handle, as opposed to one that failed for real. */
function isBusy(err) {
  return !!err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES');
}

/**
 * Rewrite one transcript in place, append-aware.
 *
 * A LIVE session is rewritten like any other (decision 3 of #557). Skipping one would leave behind the
 * phantom project #171 built this file to prevent, and it would do it for the sessions a user is most
 * likely to be looking at; the append-aware write below is what makes not skipping it safe.
 *
 * @param {string} filePath  the transcript
 * @param {function} rewriteLine  (parsedLine, oldPath, newPath) -> true when it changed the line
 * @returns {{ok: true, changed: boolean}|{ok: false, reason: string, cause?: Error}}
 *          `changed` says whether anything was written. `ok: false` is a session left behind and the
 *          caller reports it by name — `reason` is `busy` (a handle on the file outlived the retries),
 *          `rewritten` (the file was replaced under us, so our text describes bytes that are gone),
 *          `unreadable` or `failed`. This used to answer a bare `false` for every one of those AND for
 *          "nothing to do", so a remap that could not write a single transcript reported success.
 *          The thrown error rides along under `cause`, never as `error` — the same shape `safe-write.js`
 *          uses, and for the same reason: its text names the path it failed on, so it is for the log and
 *          for `readable-error.js`, not for a dialog. `reason` is a fixed word and safe to show.
 */
function rewriteTranscript(filePath, oldPath, newPath, rewriteLine) {
  let baseline;
  try {
    baseline = fs.readFileSync(filePath);
  } catch (err) {
    // Nothing there is nothing to move: a cached row can name a transcript that has since been deleted,
    // and reporting that as a session left behind would bury the ones that really were.
    if (err && err.code === 'ENOENT') return { ok: true, changed: false };
    return { ok: false, reason: 'unreadable', cause: err };
  }

  // Where the last COMPLETE line ends. What follows it is a line the CLI is writing RIGHT NOW: it is kept
  // as raw bytes and never decoded, because a read that lands mid-character would otherwise come back
  // through `toString` as a replacement character and be written back that way — corrupting a line we
  // were never asked to touch.
  const completeEnd = baseline.lastIndexOf(0x0a) + 1;   // 0 when the file holds no newline at all
  const partial = baseline.subarray(completeEnd);

  let touched = false;
  const head = splitKeepingEol(baseline.subarray(0, completeEnd).toString('utf8')).map(({ body, eol }) => {
    if (!body) return body + eol;
    let parsed;
    try { parsed = JSON.parse(body); } catch { return body + eol; }   // a truncated line — leave it alone
    if (!rewriteLine(parsed, oldPath, newPath)) return body + eol;
    touched = true;
    return JSON.stringify(parsed) + eol;
  }).join('');
  if (!touched) return { ok: true, changed: false };

  // Read again, as late as possible: whatever the CLI appended between the read above and this one is the
  // window this write exists to survive. It is carried over as BYTES — re-parsing it would mean deciding
  // about a line we never read, and re-serialising it would rewrite a line nobody asked us to change.
  let current;
  try {
    current = fs.readFileSync(filePath);
  } catch (err) {
    return { ok: false, reason: 'unreadable', cause: err };
  }
  if (current.length < baseline.length || !current.subarray(0, baseline.length).equals(baseline)) {
    // Not an append. The file was truncated or replaced under us — a compaction, a restore, another tool
    // — so the text we derived describes bytes that are no longer there, and writing it would undo
    // whatever did that. The session stays at the old path and the caller says so.
    return { ok: false, reason: 'rewritten' };
  }
  const appended = current.subarray(baseline.length);

  // Atomic: this is a live session's file, and half of it is worse than none of it.
  const tmp = filePath + '.tmp';
  try {
    fs.writeFileSync(tmp, Buffer.concat([Buffer.from(head, 'utf8'), partial, appended]));
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return { ok: false, reason: 'failed', cause: err };
  }
  // Bounded (decision 2 of #557), and it removes the temp file itself when it gives up.
  const renameErr = renameWithRetry(tmp, filePath);
  if (renameErr) return { ok: false, reason: isBusy(renameErr) ? 'busy' : 'failed', cause: renameErr };
  return { ok: true, changed: true };
}

// --- the per-backend rules ---

/** Claude writes `cwd` on EVERY line. */
function claudeLine(entry, oldPath, newPath) {
  if (!samePath(entry.cwd, oldPath)) return false;
  entry.cwd = newPath;
  return true;
}

/** Codex writes it once, in the `session_meta` header, under `payload`. */
function codexLine(entry, oldPath, newPath) {
  if (entry.type !== 'session_meta' || !entry.payload) return false;
  if (!samePath(entry.payload.cwd, oldPath)) return false;
  entry.payload.cwd = newPath;
  return true;
}

/** Pi writes it once, on the header line (`type: 'session'`). */
function piLine(entry, oldPath, newPath) {
  if (entry.type !== 'session') return false;
  if (!samePath(entry.cwd, oldPath)) return false;
  entry.cwd = newPath;
  return true;
}

module.exports = {
  rewriteTranscript, samePath,
  claudeLine, codexLine, piLine,
  _splitKeepingEol: splitKeepingEol,
};
