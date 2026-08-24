// app/safe-write.js — the one way this app overwrites a file somebody else also owns (#441).
//
// Every writer here edits a file a CLI reads and may rewrite while the editor is open: an instruction
// file, a skill, a settings blob. Three things have to be true of such a write, and each of them was
// missing somewhere before this module existed:
//
// **It must not silently win a race.** The caller says what it believed the file to hold; if the file no
// longer holds that, the write is refused and the caller gets the current text to resolve against. This
// is CONTENT, not an mtime, and that is deliberate — the same argument `viewer-panel.js` makes for its
// own pre-save check: an mtime has a resolution and a clock behind it, and against an agent saving every
// few seconds the difference between a certainty and a coincidence. The check happens here, immediately
// before the write, which is as narrow as check-then-write gets without a lock. It is not a lock: a
// writer that lands between this read and the rename still wins, and nothing in this file pretends
// otherwise.
//
// **It must not be half-written.** A CLI that reads its config while a save is in flight would get a
// truncated file and refuse to start. So the bytes go to a temp file in the same directory and are moved
// into place with a rename, which is atomic on both filesystems this app runs on.
//
// **It must not rewrite what the user did not touch.** CodeMirror hands back LF-only text with no BOM, so
// saving a CRLF file would rewrite every line of it and a BOM'd `settings.json` would lose its BOM — a
// diff of the whole file, in something a CLI re-reads. The line endings and the BOM of what was on disk
// are re-applied to what is written.
//
// Electron-free, so `test/safe-write.test.js` drives it directly.
'use strict';

const fs = require('fs');
const path = require('path');

const BOM = '﻿';

function stripBom(text) {
  return typeof text === 'string' && text.startsWith(BOM) ? text.slice(1) : text;
}

/** How the file on disk spells a line break, and whether it starts with a BOM. */
function encodingOf(text) {
  const hasBom = typeof text === 'string' && text.startsWith(BOM);
  const body = hasBom ? text.slice(1) : (text || '');
  // A file with mixed endings is answered by what it uses MOST — rewriting the majority is the visible
  // churn, and there is no third answer that leaves such a file alone.
  const crlf = (body.match(/\r\n/g) || []).length;
  const lf = (body.match(/(?<!\r)\n/g) || []).length;
  return { bom: hasBom, eol: crlf > lf ? '\r\n' : '\n' };
}

/** Text as the file on disk spells it: its line endings, its BOM. */
function applyEncoding(text, { bom = false, eol = '\n' } = {}) {
  const body = String(text == null ? '' : text).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const out = eol === '\r\n' ? body.replace(/\n/g, '\r\n') : body;
  return bom ? BOM + out : out;
}

/**
 * What is at this path: its text, or why there is no text.
 *
 * "Not there" and "there but unreadable" are different answers and the caller says different things
 * about them — a directory sitting where a file belongs is not a missing file, and reporting it as one
 * sends the user looking for something that never left.
 */
function readCurrent(file) {
  let st = null;
  try { st = fs.statSync(file); } catch { return { missing: true }; }
  if (st.isDirectory()) {
    const err = new Error('EISDIR: illegal operation on a directory');
    err.code = 'EISDIR';
    return { blocked: err };
  }
  try { return { text: fs.readFileSync(file, 'utf8') }; } catch (err) { return { blocked: err }; }
}

/**
 * Move `tmp` onto `target`, retrying briefly.
 *
 * Windows fails a rename-over-target with EPERM/EBUSY while anything holds a handle on it — a virus
 * scanner that opened the file the moment we wrote it, or the CLI reading its own config. It clears in
 * milliseconds, so a few short retries turn a spurious failure into a save; a real one still fails, and
 * the temp file is cleaned up either way.
 */
const RETRY_DELAYS = [30, 60, 120];

function renameWithRetry(tmp, target, rename = fs.renameSync) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      rename(tmp, target);
      return null;
    } catch (err) {
      lastErr = err;
      if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') break;
      if (attempt === RETRY_DELAYS.length) break;
      // A synchronous pause: this runs in main, and the alternative (an async write path) would let a
      // second save start inside the gap this exists to survive. ~210 ms in total, then it fails for
      // real — a save that hangs on a locked file is worse than one that says so.
      const until = Date.now() + RETRY_DELAYS[attempt];
      while (Date.now() < until) { /* wait */ }
    }
  }
  try { fs.unlinkSync(tmp); } catch { /* the temp file is ours; a failure to remove it is not the caller's */ }
  return lastErr;
}

/**
 * A filesystem failure, handed back for the CALLER to word.
 *
 * The thrown text names the path it failed on — always somewhere under the user's home — and says nothing
 * anyone can act on, so it never leaves this module as a message. The error rides along under `cause` so
 * the caller can put it through `readable-error.js` and log the raw text there (#444).
 */
function failed(err) {
  return { ok: false, code: 'failed', cause: err };
}

/**
 * Write `content` to `file`, atomically, without overwriting a change the caller has not seen.
 *
 * Options:
 *   expectPrevious — what the caller believed the file to hold. When given and the file holds something
 *                    else, the write is refused with `{ code: 'stale', current }`. Pass `null` to skip
 *                    the check (a caller that has no baseline, e.g. a fresh create).
 *   mustExist      — refuse when the file is not there (an edit, as opposed to a create).
 *   validate       — `(text) => ({ ok, error })`; runs on the caller's text before anything is written.
 *
 * Returns `{ ok: true, content, mtimeMs }` with the text as it was actually WRITTEN — which is not what
 * was handed in, once the file's own line endings and BOM are back on it, and is therefore what a caller
 * should move its baseline to. On refusal: `{ ok: false, code }` where `code` is `missing`, `stale`
 * (with `conflict` and `diskContent`), `invalid` (with `error`) or `failed` (with `cause`, unworded).
 */
function writeTextFile(file, content, { expectPrevious = null, mustExist = true, validate = null, rename = fs.renameSync } = {}) {
  const target = path.resolve(file);
  const current = readCurrent(target);
  if (current.blocked) return failed(current.blocked);
  const onDisk = current.missing ? null : current.text;

  if (mustExist && onDisk === null) {
    return { ok: false, code: 'missing', error: 'That file is no longer there.' };
  }
  // The BOM is stripped from BOTH sides of the compare: a reader that decodes it into the document and
  // one that does not would otherwise disagree about a file neither of them changed.
  if (expectPrevious !== null && onDisk !== null && stripBom(onDisk) !== stripBom(expectPrevious)) {
    return {
      ok: false,
      code: 'stale',
      conflict: true,
      error: 'The file changed since it was opened.',
      // The disk text rides along so the caller can raise its conflict view without reading again — and
      // without the second read being a different answer than the one that refused the write.
      diskContent: onDisk,
    };
  }
  if (typeof validate === 'function') {
    let verdict = null;
    // A validator that throws is a validator that could not answer, and an unanswered check is a no: the
    // whole point of this step is that a file a CLI reads is not left in a state nobody verified. Its own
    // words are not passed on — a thrown parser message can carry the path it was reading.
    try { verdict = validate(String(content == null ? '' : content)); } catch {
      verdict = { ok: false, error: 'That could not be checked, so it was not written.' };
    }
    if (verdict && verdict.ok === false) {
      return { ok: false, code: 'invalid', error: verdict.error || 'That is not valid for this format.' };
    }
  }

  // The encoding to keep is the FILE's, not the editor's — and for a new file, plain LF with no BOM.
  const text = applyEncoding(content, onDisk === null ? { bom: false, eol: '\n' } : encodingOf(onDisk));

  const dir = path.dirname(target);
  const tmp = path.join(dir, '.' + path.basename(target) + '.sb-' + process.pid + '-' + Date.now() + '.tmp');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, text, 'utf8');
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return failed(err);
  }
  const renameErr = renameWithRetry(tmp, target, rename);
  if (renameErr) return failed(renameErr);
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(target).mtimeMs; } catch { /* it was written; an unreadable stat is not a failure */ }
  return { ok: true, content: text, mtimeMs };
}

module.exports = { writeTextFile, encodingOf, applyEncoding, stripBom, _renameWithRetry: renameWithRetry };
