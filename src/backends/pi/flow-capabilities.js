'use strict';
// What Pi's session-flow reader delivers, as DATA (spec 46, #826, plan T16). Two callers read it and must agree: the
// descriptor's `sessionFlow(row)` (main) and `flow-reader.js` (a worker). Parity is pinned by `test/backend-parity.test.js`.
// pi-native reads the same file through this reader (it declares `transcriptsOf: 'pi'`), so the texts below speak of both.
//
// This module requires only `../flow-hook` (itself dependency-free), so the descriptor can load it without the reader.
const { flowCap } = require('../flow-hook');

const LIMITATIONS = Object.freeze([
  { id: 'instructions-version', text: 'Pi records its instruction files only in newer versions (a system message with the project context, seen from Pi 1.1.0). An older session lists none.' },
  { id: 'agents-summary-only', text: 'Pi runs a delegated agent as a process of its own with no session file, so a delegation is one step with the summary line the app\'s subagent tool writes into the result (turns, tokens, cost, model). The child\'s own steps are not shown.' },
  { id: 'window-from-catalog', text: 'The context window comes from Pi\'s own model catalog and the user\'s model file; a model they do not list has an unknown window, and its checkpoints show the input without one.' },
  { id: 'no-permission-mode', text: 'A Pi transcript records no permission mode, so none is shown.' },
  { id: 'approvals-by-transport', text: 'Terminal Pi has no approval step. A session driven over the pipe (pi-native) asks before a gated call, but an answer is not recorded; only a refusal shows, as a failed call marked refused.' },
  { id: 'patterns-later', text: 'Destructive-command highlights are not built yet, so no step is marked as risky.' },
]);

const CAPABILITIES = Object.freeze({
  agents: flowCap('partial', 'agents-summary-only'),
  instructionFiles: flowCap('perFile', 'instructions-version'),
  contextCheckpoints: flowCap('partial', 'window-from-catalog'),
  permissionMode: flowCap('no', 'no-permission-mode'),
  approvals: flowCap('partial', 'approvals-by-transport'),
  compaction: flowCap('yes'),
  interrupt: flowCap('yes'),
  destructivePatterns: flowCap('no', 'patterns-later'),
  timestamps: flowCap('yes'),
});

module.exports = { LIMITATIONS, CAPABILITIES };
