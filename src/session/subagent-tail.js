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
 * @returns {{ prime: (buf: Buffer) => number, take: (buf: Buffer) => { consumed: number, entries: object[] } }}
 *   `prime` with the file as it stood when the view opened (already drawn) — it answers the byte offset the
 *   tail reads on from; `take` with what the file grew by since — it answers how many of those bytes it used.
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
  };
}

module.exports = { createSubagentTail };
