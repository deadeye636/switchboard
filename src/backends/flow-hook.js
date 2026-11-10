'use strict';
// The cheap half of the session-flow hook family (spec 46, #826), shared by the descriptors that answer it.
//
// `sessionFlow(row)` runs in main and is called on demand, when someone opens a session's Flow tab, never
// from the scan, the watcher or a list projection (`test/flow-snapshot.test.js`). It therefore does no
// filesystem work of its own: it asks the descriptor's `transcriptPathFor`, which only joins strings, and
// returns what a worker needs to read the file. A backend whose answer would need a stat or a readdir
// makes the hook async instead.
//
// This module requires nothing, on purpose: the descriptors load it with the registry, and the reader half
// (`readSessionFlow`, pure, worker side) is required lazily inside each descriptor's hook
// (`test/flow-snapshot.test.js` pins that requiring the registry loads no reader).

/** One capability entry: `limitationId` names an entry of the answer's `limitations`. */
function flowCap(state, limitationId = null) {
  return { state, limitationId };
}

/**
 * The answer of `sessionFlow(row)` for a backend with one transcript file per session.
 * `null` only when there is no row at all. A row that names no file yet (a session just started, nothing written)
 * answers the capabilities with `sources: []`: the backend supports a flow, there is just nothing to read, and the
 * caller says so instead of reporting a backend that declines (`null`). The file path leaves this answer only inside
 * main (the renderer is never handed `sources`).
 */
function singleFileFlowAnswer(row, file, { capabilities, limitations }) {
  if (!row) return null;
  return {
    capabilities,
    limitations,
    sources: file && typeof file === 'string' ? [{ sourceId: 'main', role: 'transcript', laneHint: 'main', file }] : [],
  };
}

// The answer of a backend whose reader is not built yet (plan T3): every capability `partial` with the one
// limitation that says so, and the way its instruction files will be shown once they are read. Drop a
// backend's use of this when its real reader lands and it can state what it measures.
const NOT_BUILT_LIMITATION = Object.freeze({ id: 'reader-not-built', text: 'The flow reader for this backend is not built yet, so no steps are shown.' });

function stubFlowCapabilities(instructionFiles) {
  const caps = {};
  for (const id of ['agents', 'contextCheckpoints', 'permissionMode', 'approvals', 'compaction', 'interrupt', 'destructivePatterns', 'timestamps']) {
    caps[id] = flowCap('partial', NOT_BUILT_LIMITATION.id);
  }
  caps.instructionFiles = flowCap(instructionFiles, NOT_BUILT_LIMITATION.id);
  return caps;
}

module.exports = { flowCap, singleFileFlowAnswer, stubFlowCapabilities, NOT_BUILT_LIMITATION };
