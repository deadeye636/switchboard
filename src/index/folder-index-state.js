const fs = require('fs');
const path = require('path');

// Walk one level of `dir`, folding the mtime of every `.jsonl` at this level and,
// recursively, in any subdirectory into `max`. Subagent transcripts live one or two
// levels below the project folder (<folder>/<uuid>/subagents/*.jsonl, or directly under
// <folder>/<uuid>/ in the legacy layout), and appending to one of them updates the nested
// file's mtime but NOT the project folder's own mtime — so a subagent-only burst would be
// invisible to a top-level-only scan and the reconcile change-gate would never trip for it
// (#199 step 2). The tree is shallow and controlled by the CLI's layout, so a full recurse
// over the .jsonl files is bounded and stat-only.
function maxJsonlMtime(dir, max) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return max;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      if (!entry.name.endsWith('.jsonl')) continue;
      try {
        const fileMtimeMs = fs.statSync(full).mtimeMs;
        if (fileMtimeMs > max) max = fileMtimeMs;
      } catch {}
    } else if (entry.isDirectory()) {
      max = maxJsonlMtime(full, max);
    }
  }
  return max;
}

function getFolderIndexMtimeMs(folderPath) {
  let indexMtimeMs = 0;

  try {
    indexMtimeMs = fs.statSync(folderPath).mtimeMs;
  } catch {
    return 0;
  }

  // Session files are appended in place, which updates the file mtime but often leaves the
  // containing directory mtime unchanged. Take MAX(dir mtime, every .jsonl mtime), including
  // the subagent transcripts nested below the folder (#199 step 2).
  indexMtimeMs = maxJsonlMtime(folderPath, indexMtimeMs);

  return indexMtimeMs;
}

module.exports = { getFolderIndexMtimeMs };
