// The live tail of an open subagent transcript, as entries (#717) — without Electron, so it can be tested.
//
// The history viewer draws a subagent's transcript through its backend's `normalizeTranscriptEntries` (#705),
// and the lines that arrive while it is open have to be drawn the same way. That normaliser reads context
// across lines — which tool a call was, which call started a subagent, what follows a caveat — so a batch of
// new lines cannot be normalised on its own. The tail keeps every line of the file, normalises the whole, and
// hands out only what the new lines added. A backend without the hook gets its lines raw, as before.
//
// It works on BYTES and stops at the last newline: a line the subagent is still writing is taken when it is
// whole, never consumed half-read, and a byte count cannot drift the way a count over decoded text does when
// the file holds something that is not valid UTF-8.
'use strict';

const NEWLINE = 0x0a;

function parseLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

// The whole lines of a buffer: how many bytes they take, and their text.
function wholeLines(buf) {
  const end = buf && buf.length ? buf.lastIndexOf(NEWLINE) + 1 : 0;
  return { consumed: end, text: end ? buf.toString('utf8', 0, end) : '' };
}

/**
 * @param {((lines: object[]) => object[]) | null} normalizeTranscriptEntries  the backend's hook, if any
 * @returns {{ prime: (buf: Buffer) => number, take: (buf: Buffer) => { consumed: number, entries: object[] },
 *   reset: (buf: Buffer) => { consumed: number, entries: object[] } }}
 *   `prime` with the file as it stood when the view opened (already drawn) — it answers the byte offset the
 *   tail reads on from; `take` with what the file grew by since — it answers how many of those bytes it used;
 *   `reset` with the whole file after it was REWRITTEN rather than appended to (a CLI that compacts its own
 *   transcript in place) — it forgets every line it held and answers ALL entries, for the view to redraw.
 */
function createSubagentTail(normalizeTranscriptEntries) {
  const normalize = typeof normalizeTranscriptEntries === 'function'
    ? (lines) => { try { return normalizeTranscriptEntries(lines) || []; } catch { return null; } }
    : null;
  let raw = [];
  let sent = 0;
  return {
    prime(buf) {
      const { consumed, text } = wholeLines(buf);
      if (normalize) {
        raw = parseLines(text);
        sent = (normalize(raw) || raw).length;
      }
      return consumed;
    },
    take(buf) {
      const { consumed, text } = wholeLines(buf);
      const fresh = parseLines(text);
      if (!normalize || !fresh.length) return { consumed, entries: fresh };
      raw = raw.concat(fresh);
      const all = normalize(raw);
      // A hook that failed this time sends the lines raw, and counts them as sent, so the next pass that
      // succeeds does not hand the same lines out a second time.
      if (!all) { sent = raw.length; return { consumed, entries: fresh }; }
      const out = all.slice(sent);
      sent = all.length;
      return { consumed, entries: out };
    },
    reset(buf) {
      const { consumed, text } = wholeLines(buf);
      const lines = parseLines(text);
      if (!normalize) return { consumed, entries: lines };
      raw = lines;
      const all = normalize(raw) || raw;
      sent = all.length;
      return { consumed, entries: all };
    },
  };
}

// How many bytes before the read offset are kept to recognise the file the offset was taken in.
const FINGERPRINT_BYTES = 32;

/**
 * Follow one subagent transcript on disk: what the file added since the last poll, or all of it again when
 * the file was REWRITTEN rather than appended to. Claude Code can compact a transcript in place
 * (`CLAUDE_CODE_TRANSCRIPT_LOCAL_GC`): the file shrinks, and once it grows again an offset taken before the
 * rewrite points into the middle of a line — the fragment fails to parse and its entries are lost in silence.
 * A shrink is one sign; the bytes just before the offset no longer being the ones read there is the other,
 * for a file that has already grown back past it. Same check as the index's incremental reader
 * (`src/backends/claude/session-reader.js`, `readSessionFileIncremental`).
 *
 * @param {string} filePath
 * @param {((lines: object[]) => object[]) | null} normalizeTranscriptEntries
 * @param {typeof import('fs')} [fsImpl]
 * @returns {{ poll: () => ({ reset: boolean, entries: object[] } | null) }}
 *   `poll` answers `null` when there is nothing to hand out, `reset: true` with every entry when the view
 *   has to redraw, `reset: false` with the new entries otherwise.
 */
function followSubagentFile(filePath, normalizeTranscriptEntries, fsImpl = require('fs')) {
  const tail = createSubagentTail(normalizeTranscriptEntries);
  let offset = 0;
  let fingerprint = Buffer.alloc(0);
  const remember = (buf, end) => { fingerprint = Buffer.from(buf.subarray(Math.max(0, end - FINGERPRINT_BYTES), end)); };

  // Start at the end: what is already there was drawn from read-subagent-jsonl.
  try {
    const buf = fsImpl.readFileSync(filePath);
    offset = tail.prime(buf);
    remember(buf, offset);
  } catch {}

  function resetFromDisk() {
    const buf = fsImpl.readFileSync(filePath);
    const { consumed, entries } = tail.reset(buf);
    offset = consumed;
    remember(buf, consumed);
    return { reset: true, entries };
  }

  function poll() {
    const { size } = fsImpl.statSync(filePath);
    if (size < offset) return resetFromDisk();
    // A rewrite to the very same size: only the fingerprint can tell, and the poll only fires on a change.
    if (size === offset && !fingerprint.length) return null;
    const start = offset - fingerprint.length;
    const buf = Buffer.alloc(size - start);
    const fd = fsImpl.openSync(filePath, 'r');
    let bytesRead;
    try { bytesRead = fsImpl.readSync(fd, buf, 0, buf.length, start); } finally { fsImpl.closeSync(fd); }
    if (bytesRead < fingerprint.length || !buf.subarray(0, fingerprint.length).equals(fingerprint)) return resetFromDisk();
    const { consumed, entries } = tail.take(buf.subarray(fingerprint.length, bytesRead));
    if (consumed) {
      offset += consumed;
      remember(buf, fingerprint.length + consumed);
    }
    return entries.length ? { reset: false, entries } : null;
  }

  return { poll };
}

module.exports = { createSubagentTail, followSubagentFile };
