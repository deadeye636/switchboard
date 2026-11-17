const fs = require('fs');
const path = require('path');

// Walk one level of `dir`, folding the mtime of every `.jsonl` at this level and,
// recursively, in any subdirectory into `acc.max`. Subagent transcripts live one or two
// levels below the project folder (<folder>/<uuid>/subagents/*.jsonl, or directly under
// <folder>/<uuid>/ in the legacy layout), and appending to one of them updates the nested
// file's mtime but NOT the project folder's own mtime — so a subagent-only burst would be
// invisible to a top-level-only scan and the reconcile change-gate would never trip for it
// (#199 step 2). The tree is shallow and controlled by the CLI's layout, so a full recurse
// over the .jsonl files is bounded and stat-only.
//
// A directory or file that could not be read does not stop the walk, but it is REMEMBERED in `acc.complete`
// (#879): the maximum then may be lower than the truth, and a caller that treats the number as "current"
// must be able to tell.
function maxJsonlMtime(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    acc.complete = false;
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      if (!entry.name.endsWith('.jsonl')) continue;
      try {
        const fileMtimeMs = fs.statSync(full).mtimeMs;
        if (fileMtimeMs > acc.max) acc.max = fileMtimeMs;
      } catch { acc.complete = false; }
    } else if (entry.isDirectory()) {
      maxJsonlMtime(full, acc);
    }
  }
}

// { mtimeMs, complete }: the folder's index mtime and whether every directory and transcript under it could
// be read. `complete: false` means the number may be too low (a failed stat on a nested `.jsonl`, an
// unreadable subdirectory, or the folder itself gone): do not call the folder "current" on it.
function getFolderIndexState(folderPath) {
  const acc = { max: 0, complete: true };
  try {
    acc.max = fs.statSync(folderPath).mtimeMs;
  } catch {
    return { mtimeMs: 0, complete: false };
  }

  // Session files are appended in place, which updates the file mtime but often leaves the
  // containing directory mtime unchanged. Take MAX(dir mtime, every .jsonl mtime), including
  // the subagent transcripts nested below the folder (#199 step 2).
  maxJsonlMtime(folderPath, acc);

  return { mtimeMs: acc.max, complete: acc.complete };
}

// The stamp's one consumer pair: the reconcile gate (index-worker.js) compares it, and whoever READS a
// folder writes it. The cold scan no longer compares it for a folder with rows (#881): it hands such a folder
// to the reconcile and writes no stamp for a folder it skipped, so a stamp always means "the files were read
// as of this". It still compares it for a stamped REMOVED or PATHLESS folder (#879), which hold no rows.
function getFolderIndexMtimeMs(folderPath) {
  return getFolderIndexState(folderPath).mtimeMs;
}

module.exports = { getFolderIndexMtimeMs, getFolderIndexState };
