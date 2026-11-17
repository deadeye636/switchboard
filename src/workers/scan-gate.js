// The cold-scan worker's per-folder skip decision as a PURE function (#879), outside scan-projects.js
// because that file runs on load (it reads workerData and scans) and so cannot be required by a test.
//
//   cleared  — main has cleared the folder for the incremental reconcile (#881): stamped, rows, current parser.
//   stamp    — main's stamp for a REMOVED or PATHLESS folder, which holds no rows; 0/undefined for any other.
//   state    — `getFolderIndexState(folderPath)` ({ mtimeMs, complete }); not needed when `cleared`.
//
// A stamped folder is skipped only when nothing in it is newer than the stamp (`<=`, as in
// workers/index-worker.js) AND the mtime walk was complete: a failed stat on a nested transcript lowers the
// number, so an incomplete walk reads as "changed", never as "current".
function shouldSkipFolder({ cleared, stamp, state }) {
  if (cleared) return true;
  if (!stamp || !state) return false;
  return state.complete === true && state.mtimeMs <= stamp;
}

module.exports = { shouldSkipFolder };
