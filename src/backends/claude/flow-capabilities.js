'use strict';
// What Claude's session-flow reader delivers, as DATA (spec 46, #826, plan T4/T5). Two callers read it and must agree:
// the descriptor's `sessionFlow(row)` (main, loaded with the first Flow call) and `flow-reader.js` (a worker). Parity
// is pinned by `test/backend-parity.test.js`, which compares the reader's capabilities with the hook's answer.
//
// This module requires only `../flow-hook` (itself dependency-free), so the descriptor can load it without loading the reader.
const { flowCap } = require('../flow-hook');

// A capability that is not fully there names one of these. The ids are stable (the Flow tab keys on them).
const LIMITATIONS = Object.freeze([
  { id: 'agents-later', text: 'Subagent lanes are not drawn yet: a subagent call appears as an ordinary tool step on the main lane.' },
  { id: 'approvals-not-recorded', text: 'A Claude transcript does not record whether a tool call was asked about or allowed, so no approval step is shown.' },
  { id: 'patterns-later', text: 'Destructive-command highlights are not built yet, so no step is marked as risky.' },
  { id: 'window-inferred', text: 'A checkpoint\'s window comes from the model name; a 1M variant selected outside the transcript is not recorded, so the window is an inference.' },
  { id: 'hidden-input', text: 'The start total is the first request\'s measured input and also counts input the transcript does not list (system prompt, tool definitions, memory), so the instruction files do not add up to it. Their token figures are estimates (about characters / 4).' },
]);

const CAPABILITIES = Object.freeze({
  agents: flowCap('partial', 'agents-later'),
  instructionFiles: flowCap('perFile'),
  contextCheckpoints: flowCap('partial', 'window-inferred'),
  permissionMode: flowCap('yes'),
  approvals: flowCap('no', 'approvals-not-recorded'),
  compaction: flowCap('yes'),
  interrupt: flowCap('yes'),
  destructivePatterns: flowCap('no', 'patterns-later'),
  timestamps: flowCap('yes'),
});

module.exports = { LIMITATIONS, CAPABILITIES };
