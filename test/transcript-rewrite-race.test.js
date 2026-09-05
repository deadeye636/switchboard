'use strict';
// The transcript rewrite is APPEND-AWARE, and its rename retries (#557).
//
// WHY THIS EXISTS:
//   `rewriteTranscript` read a whole `.jsonl`, re-serialised every line and renamed a temp file over the
//   original. The rename was atomic and that was the whole of the guarantee. Two things were missing, and
//   both land on the sessions that matter most — the running ones:
//
//   - **No baseline.** The other party is a CLI appending a line per assistant turn, to a file that can be
//     megabytes, so the window between the read and the write is proportional to the transcript. Whatever
//     it appended in that window was not merged and not overwritten by a conflicting value: it was simply
//     absent from the text handed back, and gone. Rename a project while a session is mid-turn and that
//     turn disappears.
//   - **No retry, and no way to report.** A rename-over-target on Windows fails with EPERM/EBUSY while a
//     handle is open on the file — the ordinary case for a live transcript. The function answered `false`,
//     which also meant "there was nothing of ours in this file", so the remap reported success.
//
//   Neither shows up where the click happened: the project moves, the toast says it moved.
//
// HOW THESE TESTS ARE WRITTEN, AND WHY IT MATTERS:
//   The race is the point. A test that writes the foreign append BEFORE calling proves nothing — it just
//   hands the reader newer text, which the old code passed too. `fs.readFileSync` is patched for exactly
//   one read of one path, so the append lands strictly BETWEEN the read and the write, the way
//   `test/trust-safe-write.test.js` was corrected to do it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { rewriteTranscript, claudeLine } = require('../src/backends/rewrite-cwd');

const OLD = 'D:\\temp\\project';
const NEW = 'D:\\temp\\project-moved';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Make the NEXT read of `file` be followed by somebody else writing to it.
 *
 * `write` gets the file path and does whatever the other party does — appending, in the case this is
 * mostly about. Armed once: the rewrite reads twice, so this puts the other write inside the window
 * between them and nowhere else.
 */
function afterNextRead(file, write) {
  const real = fs.readFileSync;
  let armed = true;
  fs.readFileSync = function (target, ...rest) {
    const out = real.call(fs, target, ...rest);
    if (armed && typeof target === 'string' && path.resolve(target) === path.resolve(file)) {
      armed = false;
      write(file);
    }
    return out;
  };
  return () => { fs.readFileSync = real; };
}

/** Make `fs.renameSync` fail with `code` for the first `times` calls, then behave. Counts the calls. */
function renameFailsFor(times, code) {
  const real = fs.renameSync;
  const state = { calls: 0 };
  fs.renameSync = function (from, to) {
    state.calls++;
    if (state.calls <= times) {
      const err = new Error(code + ': simulated');
      err.code = code;
      throw err;
    }
    return real.call(fs, from, to);
  };
  state.restore = () => { fs.renameSync = real; };
  return state;
}

// --- 1. the append window ---

test('a line the CLI appends between our read and our write is kept, byte for byte', () => {
  const dir = tmpDir('rw-append-');
  const file = path.join(dir, 's.jsonl');
  try {
    fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: OLD, message: 'one' }) + '\n');

    // Deliberately spelled the way `JSON.stringify` would NOT spell it, and carrying the OLD path. If the
    // write re-parsed or re-serialised the appended bytes, the spacing goes; if it rewrote them, so does
    // the path. Neither is ours to touch: we never read that line.
    const foreign = '{"type":"assistant",  "cwd":"D:\\\\temp\\\\project",  "message":"the turn that finished"}\n';
    const restore = afterNextRead(file, (f) => fs.appendFileSync(f, foreign));
    try {
      assert.deepStrictEqual(rewriteTranscript(file, OLD, NEW, claudeLine), { ok: true, changed: true });
    } finally { restore(); }

    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.includes(foreign.trimEnd()), 'the appended turn must still be there, unchanged');
    const rows = after.trim().split('\n').map(JSON.parse);
    assert.strictEqual(rows.length, 2, 'nothing was dropped');
    assert.strictEqual(rows[0].cwd, NEW, 'the line that WAS ours moved');
    assert.strictEqual(rows[1].cwd, OLD, 'and a line we never read is carried over verbatim, not rewritten');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an append that COMPLETES the half-written last line is not duplicated or cut', () => {
  // The read can land mid-line: the CLI is writing that turn right now. The partial bytes are ours to
  // carry, the rest arrives in the window, and the two have to meet exactly once.
  const dir = tmpDir('rw-partial-');
  const file = path.join(dir, 's.jsonl');
  try {
    fs.writeFileSync(file,
      JSON.stringify({ type: 'user', cwd: OLD, message: 'one' }) + '\n'
      + '{"type":"assistant","cwd":"D:\\\\temp\\\\proj');

    const restore = afterNextRead(file, (f) => fs.appendFileSync(f, 'ect","message":"two"}\n'));
    try {
      assert.deepStrictEqual(rewriteTranscript(file, OLD, NEW, claudeLine), { ok: true, changed: true });
    } finally { restore(); }

    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].cwd, NEW);
    assert.strictEqual(rows[1].message, 'two', 'the halves met once, and the line parses');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a transcript replaced under us is refused, not overwritten', () => {
  // Not every change is an append: a compaction rewrites the file. Our text describes bytes that are no
  // longer there, so writing it would undo whatever did that — and the caller has to hear about it.
  const dir = tmpDir('rw-replaced-');
  const file = path.join(dir, 's.jsonl');
  try {
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', cwd: OLD, message: 'one' }),
      JSON.stringify({ type: 'user', cwd: OLD, message: 'two' }),
    ].join('\n') + '\n');

    const compacted = JSON.stringify({ type: 'summary', cwd: OLD }) + '\n';
    const restore = afterNextRead(file, (f) => fs.writeFileSync(f, compacted));
    let res;
    try { res = rewriteTranscript(file, OLD, NEW, claudeLine); } finally { restore(); }

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'rewritten');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), compacted, 'what replaced it is still there');
    assert.ok(!fs.existsSync(file + '.tmp'), 'and no temp file was left behind');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- 2. a busy target ---

test('a rename that fails while a handle is open is retried, and then REPORTED', () => {
  const dir = tmpDir('rw-busy-');
  const file = path.join(dir, 's.jsonl');
  try {
    const before = JSON.stringify({ type: 'user', cwd: OLD, message: 'one' }) + '\n';
    fs.writeFileSync(file, before);

    const r = renameFailsFor(Infinity, 'EBUSY');
    let res;
    try { res = rewriteTranscript(file, OLD, NEW, claudeLine); } finally { r.restore(); }

    assert.strictEqual(res.ok, false, 'a session left behind is a failure, not a quiet false');
    assert.strictEqual(res.reason, 'busy', 'and the caller is told WHY, so it can name the session');
    assert.ok(r.calls > 1, 'it retried rather than giving up on the first EBUSY — it tried ' + r.calls + ' times');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'the transcript is untouched');
    assert.ok(!fs.existsSync(file + '.tmp'), 'and the temp file is cleaned up');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a rename that clears within the retries lands', () => {
  // The other half of the same decision: a handle that goes away in milliseconds — a scanner, the CLI
  // closing a read — must not cost the user a session.
  const dir = tmpDir('rw-busy-ok-');
  const file = path.join(dir, 's.jsonl');
  try {
    fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: OLD, message: 'one' }) + '\n');

    const r = renameFailsFor(2, 'EPERM');
    let res;
    try { res = rewriteTranscript(file, OLD, NEW, claudeLine); } finally { r.restore(); }

    assert.deepStrictEqual(res, { ok: true, changed: true });
    assert.strictEqual(r.calls, 3, 'two refusals, then the one that worked');
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8').trim()).cwd, NEW);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- 3. line endings, per line ---

test('mixed CRLF and LF lines each keep their OWN terminator', () => {
  // `safe-write.js` re-applies the file's majority EOL to the whole document, which is right for a config
  // a human edits. A transcript is an append-only log written by a CLI over months, sometimes by more than
  // one version of it: normalising it rewrites every line nobody touched, in a file another process is
  // reading. So the rule here is per line — including for the lines this rewrite DOES change.
  const dir = tmpDir('rw-eol-');
  const file = path.join(dir, 's.jsonl');
  try {
    const crlfMine = JSON.stringify({ type: 'user', cwd: OLD, message: 'crlf-mine' }) + '\r\n';
    const lfMine = JSON.stringify({ type: 'user', cwd: OLD, message: 'lf-mine' }) + '\n';
    const crlfOther = JSON.stringify({ type: 'user', cwd: 'D:\\temp\\elsewhere', message: 'crlf-other' }) + '\r\n';
    const lfOther = JSON.stringify({ type: 'user', cwd: 'D:\\temp\\elsewhere', message: 'lf-other' }) + '\n';
    fs.writeFileSync(file, crlfMine + lfMine + crlfOther + lfOther);

    assert.deepStrictEqual(rewriteTranscript(file, OLD, NEW, claudeLine), { ok: true, changed: true });

    const after = fs.readFileSync(file, 'utf8');
    const lines = after.split('\n').slice(0, -1);   // the file ends with a terminator
    assert.strictEqual(lines.length, 4, 'four lines out, four lines in');
    assert.deepStrictEqual(lines.map(l => (l.endsWith('\r') ? 'crlf' : 'lf')), ['crlf', 'lf', 'crlf', 'lf'],
      'every line kept the terminator it arrived with — the two we rewrote included');
    assert.ok(after.includes(crlfOther) && after.includes(lfOther),
      'and the lines belonging to another project came back byte-identical');
    const rows = after.trim().split('\n').map(l => JSON.parse(l));
    assert.deepStrictEqual(rows.map(r => r.cwd), [NEW, NEW, 'D:\\temp\\elsewhere', 'D:\\temp\\elsewhere']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- 4. what is NOT a failure ---

test('a transcript that is no longer on disk is nothing to move, not a session left behind', () => {
  // A cached row can name a file that has since been deleted. Reporting that as a failure would bury the
  // ones that really were left behind, which is the whole point of reporting at all.
  const dir = tmpDir('rw-gone-');
  try {
    const res = rewriteTranscript(path.join(dir, 'not-there.jsonl'), OLD, NEW, claudeLine);
    assert.deepStrictEqual(res, { ok: true, changed: false });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
