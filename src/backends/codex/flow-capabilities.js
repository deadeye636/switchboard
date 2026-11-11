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
  { id: 'agents-partial', text: 'Each subagent has its own lane. Its rollout is found among the rollouts that start while the session runs (by file name), so one the search bound cut off can be missing. A call that spawns an agent is matched to its lane by task name, and an agent whose result never reached the parent stays open.' },
  { id: 'approvals-guardian', text: 'A Codex rollout does not record whether a call was asked about or allowed. The only verdict recorded is the guardian verdict on an escalated call, in another rollout; it is paired with the call by order and command text, so a call whose command is built in code, a call the guardian did not review and the answer of a person in the terminal show no verdict, and two identical commands can swap theirs.' },
  { id: 'patterns-heuristic', text: 'A risky-command mark comes from a built-in list of command patterns and is a heuristic. It is conservative, and it reads only a command written as a plain string in the call: a command built in code is not read, so a step without a mark is not known to be safe. Marks for an escalation request, a policy without a sandbox and the guardian verdict come from the rollout itself.' },
  { id: 'hidden-input', text: 'The start total is the first request\'s measured input and also counts input the rollout does not list (system prompt, tool definitions), so the instruction block does not add up to it. Its token figure is an estimate (about characters / 4).' },
  { id: 'failure-from-text', text: 'Codex records no structured status for a tool call. A call is marked failed when its output reports a non-zero exit code, so a failure that prints none is not marked.' },
]);

const CAPABILITIES = Object.freeze({
  agents: flowCap('partial', 'agents-partial'),
  instructionFiles: flowCap('block', 'instructions-block'),
  contextCheckpoints: flowCap('yes'),
  permissionMode: flowCap('yes'),
  approvals: flowCap('partial', 'approvals-guardian'),
  compaction: flowCap('yes'),
  interrupt: flowCap('yes'),
  destructivePatterns: flowCap('yes', 'patterns-heuristic'),
  timestamps: flowCap('yes'),
});

module.exports = { LIMITATIONS, CAPABILITIES };
