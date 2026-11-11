'use strict';
// What Codex's session-flow reader delivers, as DATA (spec 46, #826, plan T14). Two callers read it and must agree: the
// descriptor's `sessionFlow(row)` (main, loaded with the first Flow call) and `flow-reader.js` (a worker). Parity is
// pinned by `test/backend-parity.test.js`, which compares the reader's capabilities with the hook's answer.
//
// This module requires only `../flow-hook` (itself dependency-free), so the descriptor can load it without the reader.
const { flowCap } = require('../flow-hook');

// A capability that is not fully there names one of these. The ids are stable (the Flow tab keys on them).
const LIMITATIONS = Object.freeze([
  { id: 'instructions-block', text: 'Codex records AGENTS.md as one message and names no files, so the instructions are one block of characters, counted inside the first request\'s input.' },
  { id: 'agents-later', text: 'Subagent rollouts are not read yet, so a subagent has no lane; the calls that spawn and wait for one are shown as ordinary tool steps.' },
  { id: 'approvals-not-recorded', text: 'A Codex rollout does not record whether a call was asked about or allowed (a guardian verdict is written to another rollout that is not read), so no approval step is shown.' },
  { id: 'patterns-later', text: 'Destructive-command highlights are not built yet, so no step is marked as risky.' },
  { id: 'hidden-input', text: 'The start total is the first request\'s measured input and also counts input the rollout does not list (system prompt, tool definitions), so the instruction block does not add up to it. Its token figure is an estimate (about characters / 4).' },
  { id: 'failure-from-text', text: 'Codex records no structured status for a tool call. A call is marked failed when its output reports a non-zero exit code, so a failure that prints none is not marked.' },
]);

const CAPABILITIES = Object.freeze({
  agents: flowCap('no', 'agents-later'),
  instructionFiles: flowCap('block', 'instructions-block'),
  contextCheckpoints: flowCap('yes'),
  permissionMode: flowCap('yes'),
  approvals: flowCap('no', 'approvals-not-recorded'),
  compaction: flowCap('yes'),
  interrupt: flowCap('yes'),
  destructivePatterns: flowCap('no', 'patterns-later'),
  timestamps: flowCap('yes'),
});

module.exports = { LIMITATIONS, CAPABILITIES };
