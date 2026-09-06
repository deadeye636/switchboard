// The Claude cold-scan worker: read every folder under the store root and hand main the parsed rows.
//
// It STREAMS (#567). It used to gather every folder and post ONE terminal `{ok:true, results}`, which
// meant main deserialised the whole store and then ran every folder's DB writes in a single
// uninterruptible stretch — 821 to 2172 ms of main-thread block across four runs against a 1011-session
// store. Nothing else on the main thread runs during that: no PTY chunk reaches the renderer, no
// `open-terminal` is served, no timer fires. One message per folder lets main apply each on its own
// event-loop turn, and lets the apply overlap the parse instead of piling up behind it.
//
// It also GATES (#589). `skipStamps` is main's per-folder "indexed as of" stamp, and a folder whose newest
// `.jsonl` has not moved past it is not opened at all — the same comparison the reconcile's gate makes in
// index-worker.js, against the same `getFolderIndexMtimeMs`. Main decides WHICH folders may carry a stamp
// (it folds in the parser version and refuses a folder with no rows); the worker only compares. An EMPTY
// `skipStamps` is the unconditional full scan every caller but the cold start still asks for.
//
// What the gate costs is real and is not a rounding error: a skipped folder keeps whatever drift it had.
// A transcript deleted inside a folder whose newest `.jsonl` did not move (so: anything but the newest
// file, or a nested subagent transcript) keeps its row; an FTS entry orphaned there stays orphaned,
// because the folder-scoped search wipe rides on the apply this skips; and the folder's `projectPath` is
// the stored one rather than a freshly derived one. All three are repaired by the full pass — the rebuild
// action, a parser bump, a recreated FTS table — which is why that pass stays unconditional.
//
// Protocol (store-indexer.js populateCacheViaWorker is the other half):
//   IN  workerData{projectsDir, skipStamps}            — the store root + folder -> indexed-as-of mtime
//   OUT progress{type:'progress', text}                — status-bar line, unchanged
//       folder{type:'folder', result}                  — ONE scanned folder, posted as it finishes
//       {ok:true, folders, skipped}                    — the stream is complete
//       {ok:false, status}                             — the store root could not be read
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { getFolderIndexMtimeMs } = require('../index/folder-index-state');
// Direct path import (NOT the backends registry): this is a worker_thread and must stay Electron-free,
// and the registry can transitively reach electron. folder-reader only requires session-reader +
// derive-project-path, both Electron-free (#188).
const { readFolderSessions } = require('../backends/claude/folder-reader');

const PROJECTS_DIR = workerData.projectsDir;
// folder -> the mtime main last indexed this folder as of. Only folders main has cleared for skipping are
// in here; everything else is read in full. Absent/empty = scan everything (the pre-#589 behaviour).
const SKIP_STAMPS = (workerData && workerData.skipStamps) || {};

// A sentinel rather than a second return channel: `null` already means "no project path, post nothing",
// and the two are counted differently in the terminal message.
const SKIPPED = { skipped: true };

function readFolderFromFilesystem(folder) {
  // Capture the index mtime before reading sessions so a concurrent index
  // write during the read still triggers the next refresh.
  const indexMtimeMs = getFolderIndexMtimeMs(path.join(PROJECTS_DIR, folder));
  // The gate (#589). `<=` and not `<`, matching workers/index-worker.js: a stamp equal to the folder's
  // newest `.jsonl` mtime means the folder was indexed as of that write.
  const stamp = SKIP_STAMPS[folder];
  if (stamp && indexMtimeMs <= stamp) return SKIPPED;
  const { projectPath, sessions } = readFolderSessions(PROJECTS_DIR, folder);
  if (!projectPath) return null;
  return { folder, projectPath, sessions, indexMtimeMs };
}

// Scan all folders
try {
  const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== '.git')
    .map(d => d.name);

  let posted = 0;
  let skipped = 0;
  for (let i = 0; i < folders.length; i++) {
    if (i % 5 === 0 || i === folders.length - 1) {
      parentPort.postMessage({ type: 'progress', text: `Scanning projects (${i + 1}/${folders.length})…` });
    }
    const result = readFolderFromFilesystem(folders[i]);
    if (result === SKIPPED) { skipped++; continue; }
    // Post it NOW rather than collecting it: main applies this folder while we read the next one, and
    // its DB writes are one folder long instead of the whole store (#567).
    if (result) { parentPort.postMessage({ type: 'folder', result }); posted++; }
  }
  parentPort.postMessage({ ok: true, folders: posted, skipped });
} catch (err) {
  // This string is NOT internal. The client turns it into a status-bar line in the main window
  // (`store-indexer.js` -> `sendStatus`), and a scandir failure here names the store root — a path under
  // the user's home (#457). The worker has no `log`, so the code rides along and stderr keeps the rest.
  console.error('[scan-projects] scan failed:', err && err.message);
  parentPort.postMessage({ ok: false, status: `the project store could not be read (${err && err.code ? err.code : 'unknown error'})` });
}
