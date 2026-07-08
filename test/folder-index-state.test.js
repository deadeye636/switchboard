const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getFolderIndexMtimeMs } = require('../folder-index-state');

test('folder index timestamp advances when an existing session file is appended', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-folder-index-'));

  try {
    const sessionPath = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(sessionPath, '{"type":"user","message":"first"}\n', 'utf8');

    const before = getFolderIndexMtimeMs(tmpDir);

    fs.appendFileSync(sessionPath, '{"type":"assistant","message":"second"}\n', 'utf8');
    // Bump the file mtime well past the folder's own mtime instead of sleeping
    // ~1.1 s for the wall clock to advance — instant and deterministic. The index
    // takes MAX(dir mtime, jsonl file mtimes), so the new mtime must exceed the
    // folder mtime (which equals the creation time here) (#82).
    const future = new Date(Date.now() + 60000);
    fs.utimesSync(sessionPath, future, future);

    const after = getFolderIndexMtimeMs(tmpDir);

    assert.ok(after > before, `expected index mtime to increase (${before} -> ${after})`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
