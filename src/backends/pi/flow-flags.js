'use strict';
// Pi's highlights for the session flow (spec 46, #826, plan T23). This is where Pi's FORMAT lives (CLAUDE.md reflex 5): which
// tool runs a shell and where its command sits, and the exact text the pi-native gate returns for a refused call. The command
// list itself is shared (`../flow-command-patterns.js`), the flag shape is `src/shared/flow-snapshot.js`.
//
// Flags are separate facts and may coexist on a step:
//   - risk, heuristic: a `bash` or `powershell` call (Pi's built-in Windows shell, off unless the `tools` option enables it)
//     whose `command` matches the shared list, read in that tool's dialect (the argument name is the one the pi-native gate
//     reads, `../pi-native/runtime-extension.js`);
//   - outcome, structured: the pi-native gate refused the call. Only for a session the transport marker says was driven over
//     the pipe: terminal Pi has no gate, so the same text there would be a coincidence, and nothing is flagged.
// A refusal replaces the plain `tool-error` flag rather than adding to it, as Claude's denial does. The marker says the
// session was driven over the pipe at least once, not that the gate was on for this call: a gate switched off, or a pipe
// session resumed in a terminal, could in principle return the same text from a tool. Both are judged too unlikely to guard.
//
// A Pi transcript records no permission mode, so there is no mode flag. The user's own `!` shell line is an event the user
// ran on purpose and is not matched.

const { commandRiskFlags } = require('../flow-command-patterns');

// A shell tool and the dialect its command is read in.
const SHELL_TOOLS = Object.freeze({ bash: 'posix', powershell: 'powershell' });

/** Risk flags (heuristic) for a tool call: `bash` or `powershell` whose `command` matches the list. Empty for any other call. */
function commandFlags(toolName, args) {
  const dialect = Object.prototype.hasOwnProperty.call(SHELL_TOOLS, toolName) ? SHELL_TOOLS[toolName] : null;
  if (!dialect || !args || typeof args.command !== 'string') return [];
  return commandRiskFlags(args.command, dialect);
}

/**
 * Is this failed result the pi-native gate's refusal? The gate's reason, matched exactly
 * (`../pi-native/runtime-extension.js`: "The user did not allow this <tool> call."), and only with a transport.
 */
function isGateRefusal(text, toolName, transport) {
  if (transport === null || transport === undefined || typeof text !== 'string') return false;
  return text.trim() === `The user did not allow this ${toolName} call.`;
}

/** The outcome flag of a failed result: the gate's refusal (structured), else the plain error. */
function resultFlag(refused) {
  return refused
    ? { axis: 'outcome', code: 'permission-denied', evidence: 'structured', why: 'The app\'s approval gate asked and the call was refused, so it did not run.' }
    : { axis: 'outcome', code: 'tool-error', evidence: 'structured', why: 'the tool result is marked as an error' };
}

module.exports = { commandFlags, isGateRefusal, resultFlag, SHELL_TOOLS };
