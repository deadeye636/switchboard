'use strict';
// The bounded reading primitives every session-flow reader shares (spec 46, #826): a line reader that never holds more
// than one chunk of an oversized line, the caps, and the string helpers that keep a snapshot's size following its step
// count. Backend-neutral: no record type or field name of any CLI lives here (CLAUDE.md reflex 5); each backend's
// `<folder>/flow-reader.js` owns its format and calls these. Pure apart from reading the file it is handed: no
// Electron, no database, no sync fs, so it runs in a worker thread.
//
// Extracted from Claude's reader when Codex's was written (T14), so the two cannot drift on a cap or a line rule.

const fs = require('node:fs');

const CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
// O5 (spec 46): the largest local transcripts hold a few thousand assistant steps. 20 000 steps is several times
// that, and the size estimate is the bound that actually protects the worker's heap and the reply.
const MAX_STEPS = 20000;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const LABEL_CHARS = 200;
const DETAIL_CHARS = 2048;
const STEP_OVERHEAD = 400;

function trunc(value, max) {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (s.length <= max) return s;
  let end = max - 1;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xD800 && last <= 0xDBFF) end -= 1; // do not cut a surrogate pair in half
  return s.slice(0, end) + '…';
}

function firstLine(value) {
  const s = typeof value === 'string' ? value : '';
  for (const raw of s.split('\n', 8)) {
    const t = raw.trim();
    if (t) return trunc(t, LABEL_CHARS);
  }
  return '';
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Reads `file` as lines. `onLine(text, lineNo, byteOffset)` returns true to stop; `onOversize(lineNo, byteOffset,
 * bytes)` is called for a line over the cap, which was never held in memory beyond one chunk. Resolves
 * `{ aborted }`. Rejects on a read error.
 */
async function readLines(file, { maxLineBytes, signal }, onLine, onOversize) {
  const stream = fs.createReadStream(file, { highWaterMark: CHUNK_BYTES });
  let pieces = [];
  let pieceBytes = 0;
  let skipping = false;
  let skippedBytes = 0;
  let lineNo = 0;
  let lineStart = 0;
  let chunkPos = 0;
  let stopped = false;

  const finishLine = () => {
    lineNo += 1;
    let stop = false;
    if (skipping) {
      stop = onOversize(lineNo, lineStart, skippedBytes) === true;
    } else if (pieceBytes > 0) {
      const text = pieces.length === 1 ? pieces[0].toString('utf8') : Buffer.concat(pieces, pieceBytes).toString('utf8');
      stop = onLine(text, lineNo, lineStart) === true;
    }
    pieces = [];
    pieceBytes = 0;
    skipping = false;
    skippedBytes = 0;
    return stop;
  };

  try {
    for await (const chunk of stream) {
      if (signal && signal.aborted) return { aborted: true };
      let start = 0;
      while (start < chunk.length) {
        const nl = chunk.indexOf(10, start);
        const end = nl === -1 ? chunk.length : nl;
        const len = end - start;
        if (skipping) {
          skippedBytes += len;
        } else if (pieceBytes + len > maxLineBytes) {
          skipping = true;
          skippedBytes = pieceBytes + len;
          pieces = [];
          pieceBytes = 0;
        } else if (len > 0) {
          pieces.push(chunk.subarray(start, end));
          pieceBytes += len;
        }
        if (nl === -1) break;
        const next = chunkPos + nl + 1;
        const stop = finishLine();
        lineStart = next;
        if (stop) { stopped = true; break; }
        start = nl + 1;
      }
      if (stopped) break;
      chunkPos += chunk.length;
    }
    if (!stopped && (pieceBytes > 0 || skipping)) finishLine();
  } finally {
    stream.destroy();
  }
  return { aborted: false };
}

function detailSize(detail) {
  let n = 0;
  for (const k in detail) n += 24 + (typeof detail[k] === 'string' ? detail[k].length : 8);
  return n;
}

function evidence(value, unit, basis, note) {
  return { value, unit, basis, note: note || '' };
}
module.exports = {
  CHUNK_BYTES, MAX_LINE_BYTES, MAX_STEPS, MAX_SNAPSHOT_BYTES, LABEL_CHARS, DETAIL_CHARS, STEP_OVERHEAD,
  trunc, firstLine, isObject, readLines, detailSize, evidence,
};
