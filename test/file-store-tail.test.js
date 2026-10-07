'use strict';
// readFileTailAsync (#754): the bounded, asynchronous tail reader a descriptor hook reads through.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readFileTail, readFileTailAsync, MAX_TAIL_BYTES } = require('../src/backends/file-store');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };

test('a file within the window is read whole and not partial', async () => {
  const f = write('small.jsonl', 'a\nb\nc\n');
  assert.deepEqual(await readFileTailAsync(f, 100), { text: 'a\nb\nc\n', partial: false });
  assert.deepEqual(await readFileTailAsync(f, 6), { text: 'a\nb\nc\n', partial: false });
});

test('a longer file yields its end, without the cut first line, and says partial', async () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`);
  const f = write('big.jsonl', lines.join('\n') + '\n');
  const r = await readFileTailAsync(f, 64);
  assert.equal(r.partial, true);
  assert.ok(r.text.endsWith('line-199\n'));
  assert.ok(r.text.length < 64);
  for (const l of r.text.split('\n').filter(Boolean)) assert.match(l, /^line-\d+$/, 'only whole lines');
});

test('it matches the synchronous reader on the same file', async () => {
  const f = write('same.jsonl', Array.from({ length: 50 }, (_, i) => `entry ${i}`).join('\n') + '\n');
  const size = fs.statSync(f).size;
  for (const bytes of [10, 80, size, size + 5]) {
    assert.deepEqual(await readFileTailAsync(f, bytes), readFileTail(f, size, bytes));
  }
});

test('it never reads more than the window, however large the file', async () => {
  const f = write('large.bin', 'x'.repeat(1 << 20) + '\nend\n');
  const reads = [];
  const real = fs.promises.open;
  fs.promises.open = async (...a) => {
    const fh = await real(...a);
    const read = fh.read.bind(fh);
    fh.read = (buf, off, len, pos) => { reads.push(len); return read(buf, off, len, pos); };
    return fh;
  };
  try {
    await readFileTailAsync(f, 4096);
    // A caller asking for more than the cap, or for everything, still gets at most the cap.
    await readFileTailAsync(f, Infinity);
  } finally { fs.promises.open = real; }
  assert.deepEqual(reads, [4096, MAX_TAIL_BYTES]);
});

test('a window with no newline yields empty text, and an empty or zero window is safe', async () => {
  const f = write('oneline.txt', 'y'.repeat(500));
  assert.deepEqual(await readFileTailAsync(f, 100), { text: '', partial: true });
  const e = write('empty.txt', '');
  assert.deepEqual(await readFileTailAsync(e, 100), { text: '', partial: false });
  assert.equal((await readFileTailAsync(f, 0)).text, '');
});

test('a missing file rejects, and the handle is closed on a normal read', async () => {
  await assert.rejects(readFileTailAsync(path.join(dir, 'nope.jsonl'), 10), { code: 'ENOENT' });
  const f = write('close.txt', 'a\nb\n');
  await readFileTailAsync(f, 2);
  fs.unlinkSync(f);   // would fail on Windows were the handle left open
});
