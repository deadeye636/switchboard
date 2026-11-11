'use strict';
// The bounded reading primitives every session-flow reader shares (spec 46, #826): a line reader that never holds more
// than one chunk of an oversized line, the caps, and the string helpers that keep a snapshot's size following its step
// count. Backend-neutral: no record type or field name of any CLI lives here (CLAUDE.md reflex 5); each backend's
// `<folder>/flow-reader.js` owns its format and calls these. Pure apart from reading the file it is handed: no
// Electron, no database, no sync fs, so it runs in a worker thread.
//
// Extracted from Claude's reader when Codex's was written (T14), so the two cannot drift on a cap or a line rule.

const fs = require('node:fs');
const pathMod = require('node:path');

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

const HEAD_BYTES = 512;

// The first HEAD_BYTES bytes of a line that is being skipped: what `pieces` already hold, then the part of this chunk.
function headOf(pieces, rest) {
  const parts = [];
  let have = 0;
  for (const piece of pieces.concat([rest])) {
    if (have >= HEAD_BYTES) break;
    const take = piece.subarray(0, HEAD_BYTES - have);
    parts.push(take);
    have += take.length;
  }
  return Buffer.concat(parts, have).toString('utf8');
}

/**
 * Reads `file` as lines. `onLine(text, lineNo, byteOffset)` returns true to stop; `onOversize(lineNo, byteOffset,
 * bytes, head)` is called for a line over the cap, which was never held in memory beyond one chunk; `head` is its first
 * 512 bytes as text (bytes already in hand, so no extra read), for a reader that needs a field the format writes first. Resolves
 * `{ aborted }`. Rejects on a read error.
 */
async function readLines(file, { maxLineBytes, signal }, onLine, onOversize) {
  const stream = fs.createReadStream(file, { highWaterMark: CHUNK_BYTES });
  let pieces = [];
  let pieceBytes = 0;
  let skipping = false;
  let skippedBytes = 0;
  let skipHead = '';
  let lineNo = 0;
  let lineStart = 0;
  let chunkPos = 0;
  let stopped = false;

  const finishLine = () => {
    lineNo += 1;
    let stop = false;
    if (skipping) {
      stop = onOversize(lineNo, lineStart, skippedBytes, skipHead) === true;
    } else if (pieceBytes > 0) {
      const text = pieces.length === 1 ? pieces[0].toString('utf8') : Buffer.concat(pieces, pieceBytes).toString('utf8');
      stop = onLine(text, lineNo, lineStart) === true;
    }
    pieces = [];
    pieceBytes = 0;
    skipping = false;
    skippedBytes = 0;
    skipHead = '';
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
          skipHead = headOf(pieces, chunk.subarray(start, end));
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
// Shared since the Pi reader (T16): Claude and Pi both name instruction files by path.
// An instruction file's label (spec 46): relative to the session's working directory when the file lies inside it
// (`CLAUDE.md`, `.claude/rules/x.md`), else relative to the home directory as `~/...`, else the last two segments
// behind an ellipsis. Never a drive letter or a leading root, and the full path is not kept anywhere in the snapshot.
const WIN_ABS = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const SLASHES = /\\/g;

function instructionLabel(file, cwd, home) {
  if (typeof file !== 'string' || !file) return 'Instruction file';
  const winShaped = WIN_ABS.test(file);
  const pm = winShaped ? pathMod.win32 : pathMod.posix;
  if (!pm.isAbsolute(file)) return file.replace(SLASHES, '/');
  const inside = (base) => {
    if (typeof base !== 'string' || !base || WIN_ABS.test(base) !== winShaped || !pm.isAbsolute(base)) return null;
    const rel = pm.relative(base, file);
    return rel && !rel.startsWith('..') && !pm.isAbsolute(rel) ? rel.replace(SLASHES, '/') : null;
  };
  const inCwd = inside(cwd);
  if (inCwd) return inCwd;
  const inHome = inside(home);
  if (inHome) return '~/' + inHome;
  const parts = file.split(/[\\/]+/).filter((x) => x && !/^[A-Za-z]:$/.test(x));
  return '\u2026/' + parts.slice(-2).join('/');
}

module.exports = {
  CHUNK_BYTES, MAX_LINE_BYTES, MAX_STEPS, MAX_SNAPSHOT_BYTES, LABEL_CHARS, DETAIL_CHARS, STEP_OVERHEAD,
  trunc, firstLine, isObject, readLines, detailSize, evidence, instructionLabel,
};
