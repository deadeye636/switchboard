'use strict';
// What Claude's session-flow reader delivers, as DATA (spec 46, #826, plan T4/T5). Two callers read it and must agree:
// the descriptor's `sessionFlow(row)` (main, loaded with the first Flow call) and `flow-reader.js` (a worker). Parity
// is pinned by `test/backend-parity.test.js`, which compares the reader's capabilities with the hook's answer.
//
// This module requires only `../flow-hook` (itself dependency-free), so the descriptor can load it without loading the reader.
const { flowCap } = require('../flow-hook');

// A capability that is not fully there names one of these. The ids are stable (the Flow tab keys on them).
const LIMITATIONS = Object.freeze([
  { id: 'agents-open', text: 'Each subagent has its own lane. A subagent started in the background answers the parent at once and its end is not recorded there, so its lane stays open; a lane may also be missing if its transcript could not be read.' },
  { id: 'approvals-not-recorded', text: 'A Claude transcript does not record whether a tool call was asked about or allowed, so no approval step is shown.' },
  { id: 'patterns-heuristic', text: 'A risky-command mark comes from a built-in list of command patterns on the shell tools and is a heuristic: it is conservative, so a step without a mark is not known to be safe. Marks for a permission mode, a blocked or denied call and a granted tool list come from the transcript itself.' },
  { id: 'window-inferred', text: 'A checkpoint\'s window comes from the model name; a 1M variant selected outside the transcript is not recorded, so the window is an inference.' },
  { id: 'hidden-input', text: 'The start total is the first request\'s measured input and also counts input the transcript does not list (system prompt, tool definitions, memory), so the instruction files do not add up to it. Their token figures are estimates (about characters / 4).' },
]);

const CAPABILITIES = Object.freeze({
  agents: flowCap('partial', 'agents-open'),
  instructionFiles: flowCap('perFile'),
  contextCheckpoints: flowCap('partial', 'window-inferred'),
  permissionMode: flowCap('yes'),
  approvals: flowCap('no', 'approvals-not-recorded'),
  compaction: flowCap('yes'),
  interrupt: flowCap('yes'),
  destructivePatterns: flowCap('yes', 'patterns-heuristic'),
  timestamps: flowCap('yes'),
});

module.exports = { LIMITATIONS, CAPABILITIES };
