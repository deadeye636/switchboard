const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getFolderIndexMtimeMs } = require('../src/index/folder-index-state');

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

test('folder index timestamp advances on a SUBAGENT-only append (recurses into subagent dirs, #199)', () => {
  // The change gate used to stat only the folder's top-level .jsonl files, so a burst that appended only
  // to subagent transcripts (`<folder>/<uuid>/subagents/<agent>.jsonl`) never tripped it — the reconcile
  // then missed those changes. getFolderIndexMtimeMs now recurses; this pins that.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-folder-index-sub-'));
  try {
    // A top-level session plus a nested subagent transcript.
    fs.writeFileSync(path.join(tmpDir, 'parent.jsonl'), '{"type":"user","message":"p"}\n', 'utf8');
    const subDir = path.join(tmpDir, 'parent-uuid', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    const subPath = path.join(subDir, 'agent-1.jsonl');
    fs.writeFileSync(subPath, '{"type":"assistant","message":"a"}\n', 'utf8');

    const before = getFolderIndexMtimeMs(tmpDir);

    // Bump ONLY the subagent file's mtime past everything else. If the walk still recurses, the gate moves.
    const future = new Date(Date.now() + 60000);
    fs.utimesSync(subPath, future, future);

    const after = getFolderIndexMtimeMs(tmpDir);
    assert.ok(after > before, `a subagent-only append must trip the gate (${before} -> ${after})`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
