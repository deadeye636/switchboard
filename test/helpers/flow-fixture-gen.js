'use strict';
// Writes a temp JSONL file holding one oversized line, for the bounded line reader's test (#826).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * A JSONL file of `head` lines, one line of about `bytes` bytes, then `tail` lines. Defaults give one
 * valid line before and after, so a reader that skips the big line must still deliver the others.
 * Returns the path and a `cleanup()` that removes the file's own temp directory.
 */
function writeOversizedLine(bytes, { head = 1, tail = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-fixture-'));
  const file = path.join(dir, 'oversized.jsonl');
  const small = (i) => JSON.stringify({ type: 'user', n: i, message: { role: 'user', content: 'small line' } });
  const prefix = '{"type":"assistant","message":{"role":"assistant","content":"';
  const suffix = '"}}';
  const fill = Math.max(0, bytes - prefix.length - suffix.length);
  const fd = fs.openSync(file, 'w');
  try {
    for (let i = 0; i < head; i++) fs.writeSync(fd, small(i) + '\n');
    fs.writeSync(fd, prefix);
    const chunk = 'x'.repeat(Math.min(fill, 1 << 20));
    for (let left = fill; left > 0; left -= chunk.length) {
      fs.writeSync(fd, left >= chunk.length ? chunk : chunk.slice(0, left));
    }
    fs.writeSync(fd, suffix + '\n');
    for (let i = 0; i < tail; i++) fs.writeSync(fd, small(head + i) + '\n');
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  } finally {
    fs.closeSync(fd);
  }
  return { path: file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { writeOversizedLine };
