// The Claude cold-scan worker: read every folder under the store root and hand main the parsed rows.
//
// It STREAMS (#567). It used to gather every folder and post ONE terminal `{ok:true, results}`, which
// meant main deserialised the whole store and then ran every folder's DB writes in a single
// uninterruptible stretch — 821 to 2172 ms of main-thread block across four runs against a 1011-session
// store. Nothing else on the main thread runs during that: no PTY chunk reaches the renderer, no
// `open-terminal` is served, no timer fires. One message per folder lets main apply each on its own
// event-loop turn, and lets the apply overlap the parse instead of piling up behind it.
//
// It also GATES (#589, #881). `skipFolders` is the list of folders main has CLEARED for the incremental
// reconcile: stamped, holding at least one row, every row at the current parser version. Such a folder is
// not opened at all — whether or not its newest `.jsonl` moved. The first version compared that mtime
// against the stamp, and a live session moves it every few seconds, so one running CLI made every cold
// start re-parse its whole folder (#881). The reconcile (index-worker.js `runClaudeReconcile` ->
// `parseClaudeFolder`) makes that comparison itself, reuses a row whose file mtime and parser version
// match and reads only the changed files, so a changed folder is handed to it rather than re-read here.
// The worker posts NOTHING for a skipped folder, so main does not advance its stamp: the reconcile's gate
// still trips on it, and the stamp moves only when the files were really read. Main decides WHICH folders
// are cleared; an EMPTY list is the unconditional full scan every caller but the cold start asks for.
//
// What the gate costs is real and is not a rounding error: a skipped folder keeps whatever drift it had.
// The reconcile prunes a deleted transcript, but an FTS entry orphaned there stays orphaned, because the
// folder-scoped search wipe rides on the apply this skips, and the folder's `projectPath` is the stored
// one rather than a freshly derived one. Both are repaired by the full pass — the rebuild action, a
// recreated FTS table — which is why that pass stays unconditional.
//
// The second gate (#879) is for the two kinds of folder that hold NO rows, so the rows-and-parser-version
// rule above cannot clear them: a REMOVED project's folder (its rows are purged and never written back) and
// a PATHLESS one (no project path can be derived). Main stamps both (the cold scan's removed branch, the
// reconcile's `parseClaudeFolder` for a pathless folder) and sends them as `skipStamps` (folder -> stamp):
//   (A) such a folder is skipped unless a transcript in it is newer than its stamp, so a session started
//       after the removal still reaches the #575 bring-back, and a folder whose mtime walk was incomplete (a
//       failed stat) counts as changed;
//   (B) a removed folder that IS read is read for its transcript HEADS only (`newestSessionStart`,
//       memoised, a failed read not memoised) and posts the store-project sighting. It parses no row: the
//       project is removed, so main writes none, and parsing 100+ MB of transcripts for a result that is
//       thrown away was the cost. `removedPaths` is main's set of removed project paths.
// A pathless folder that is read still posts nothing (nothing to apply); the reconcile stamps it.
//
// Protocol (store-indexer.js populateCacheViaWorker is the other half):
//   IN  workerData{projectsDir, skipFolders, skipStamps, removedPaths}
//                                                      — the store root; the folders cleared for the reconcile;
//                                                        folder -> stamp for removed/pathless folders; the
//                                                        removed project paths
//   OUT progress{type:'progress', text}                — status-bar line, unchanged
//       folder{type:'folder', result}                  — ONE scanned folder, posted as it finishes. `result` is
//                                                        {folder, projectPath, sessions, indexMtimeMs}, or for a
//                                                        removed project {folder, projectPath, sessions: [],
//                                                        indexMtimeMs, removed: true, storeProject:
//                                                        {newestAt, startedAt}} — heads only, no rows
//       {ok:true, folders, skipped}                    — the stream is complete
//       {ok:false, status}                             — the store root could not be read
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { getFolderIndexState } = require('../index/folder-index-state');
// Direct path import (NOT the backends registry): this is a worker_thread and must stay Electron-free,
// and the registry can transitively reach electron. folder-reader only requires session-reader +
// derive-project-path, both Electron-free (#188); folder-parse is the same kind of leaf (#199).
const { readFolderSessions } = require('../backends/claude/folder-reader');
const { deriveProjectPath } = require('../session/derive-project-path');
const { newestSessionStart } = require('../backends/claude/folder-parse');
const { shouldSkipFolder } = require('./scan-gate');

const PROJECTS_DIR = workerData.projectsDir;
// The folders main has cleared for skipping (handed to the reconcile); everything else is read in full.
// Absent/empty = scan everything (the pre-#589 behaviour).
const SKIP_FOLDERS = new Set((workerData && workerData.skipFolders) || []);
const SKIP_STAMPS = (workerData && workerData.skipStamps) || {};
const REMOVED_PATHS = new Set((workerData && workerData.removedPaths) || []);

// A sentinel rather than a second return channel: `null` already means "no project path, post nothing",
// and the two are counted differently in the terminal message.
const SKIPPED = { skipped: true };

function readFolderFromFilesystem(folder) {
  // The gate (#589, #881): a cleared folder is the reconcile's, changed or not, and costs no stat walk here.
  if (shouldSkipFolder({ cleared: SKIP_FOLDERS.has(folder) })) return SKIPPED;
  const folderPath = path.join(PROJECTS_DIR, folder);
  // Capture the index mtime before reading sessions so a concurrent index
  // write during the read still triggers the next refresh.
  const state = getFolderIndexState(folderPath);
  const indexMtimeMs = state.mtimeMs;
  // The mtime gate (#879) — for a stamped removed or pathless folder only. `<=` and not `<`, matching
  // workers/index-worker.js. An incomplete walk may have under-counted: that is "changed", not "current".
  if (shouldSkipFolder({ stamp: SKIP_STAMPS[folder], state })) return SKIPPED;

  const projectPath = deriveProjectPath(folderPath);
  if (!projectPath) return null;
  if (REMOVED_PATHS.has(projectPath)) {
    // (B): the heads, never the rows. `newestAt` is the folder's index mtime, a RECENCY, exactly as the
    // reconcile's removed branch reports it; `startedAt` is the newest session START (#575) and is null
    // when no head can say — the recency is never substituted for it.
    return {
      folder, projectPath, sessions: [], indexMtimeMs, removed: true,
      storeProject: {
        newestAt: indexMtimeMs ? new Date(indexMtimeMs).toISOString() : null,
        startedAt: newestSessionStart(folderPath),
      },
    };
  }
  const { sessions } = readFolderSessions(PROJECTS_DIR, folder, { projectPath });
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
