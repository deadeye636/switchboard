'use strict';
// The reader half of the session-flow hook for a backend whose real reader is not built yet (spec 46, #826,
// plan T3). Pure: no file is read, nothing touches Electron or the database, so it loads in a worker.
// Required LAZILY from a descriptor's `readSessionFlow`, never at descriptor load.
//
// It answers a valid, empty snapshot that says why it is empty, with the SAME capabilities the descriptor's
// `sessionFlow` answered (both come from `stubFlowCapabilities`, so the two halves cannot disagree).
// `instructionFiles` is the one thing that differs per backend and is passed by the descriptor.
//
// Each backend's real reader replaces its own use of this (Claude T4/T5; Codex and Pi in later phases). The
// real reader's file name is `<backend folder>/flow-reader.js` (T4 creates `claude/flow-reader.js`); when the
// last user of this stub is gone, delete it.

const { emptyFlowSnapshot } = require('../shared/flow-snapshot');
const { stubFlowCapabilities, NOT_BUILT_LIMITATION } = require('./flow-hook');

function readSessionFlow(_sources, _opts, instructionFiles) {
  return emptyFlowSnapshot({
    capabilities: stubFlowCapabilities(instructionFiles),
    limitations: [NOT_BUILT_LIMITATION],
  });
}

module.exports = { readSessionFlow };
