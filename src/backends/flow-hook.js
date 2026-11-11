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

module.exports = { flowCap, singleFileFlowAnswer };
