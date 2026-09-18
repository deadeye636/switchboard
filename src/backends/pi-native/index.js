// backends/pi-native/index.js — Pi driven through its RPC mode instead of through a terminal (#568).
//
// The terminal-driven backend in `../pi/` starts Pi's TUI in a PTY and reads the transcript it leaves on
// disk. This one starts `pi --mode rpc`: one JSON command per line in, responses and events out. There is no
// terminal — the app draws the conversation itself from the events (`src/renderer/session/conversation-view.js`)
// and sends turns through the same pipe. Whoever wants Pi's own TUI keeps the other backend; the two never
// share a surface, so an unfinished view here takes nothing away from anyone.
//
// SAME BINARY, SAME STORE. Everything that is a property of Pi rather than of how it is driven is the other
// backend's answer, forwarded rather than copied: its store, its parser, its trust file, its model list, its
// skills. That is the Axis-A template argument (`profileToDescriptor`), made by hand here because this is not
// a template — it changes HOW the binary is driven, which no template can.
//
// THE ROWS STAY PI'S. Two backends reading one store cannot both own a row, and the scan reconciles per
// backend, so this one declares no discovery and no parser and is never in the scan roster. A session it
// drove is marked in its own transcript (`./runtime-extension.js`), Pi's parser records that as the row's
// `transport`, and `backends.openerFor(row)` hands such a row to this backend when it is opened. Switched
// off, it hands the row back to the terminal backend: the transcript is Pi's either way.
//
// E1 of the plan: this uses the INSTALLED `pi`, not a bundled copy. Bundling is its own decision (129 MB
// unpacked, ESM, a separate process out of the asar) and waits for a reason to patch Pi.
'use strict';

const pi = require('../pi');
const { piExecCommand } = require('../pi/exec-command');
const protocol = require('./rpc-protocol');
const runtimeExtension = require('./runtime-extension');

// The options that mean something without a terminal. Left out, each for a reason a user could ask about:
//   `models`   — the Ctrl+P cycle list is a TUI key binding; nothing here presses it.
//   `useTheme` — Pi's theme colours its TUI; this backend draws with the app's own styles.
const TUI_ONLY = new Set(['models', 'useTheme']);
const configFields = [
  ...pi.configFields.filter(f => !TUI_ONLY.has(f.id)),
  // Step C of #568. Pi asks nothing before a tool runs; this backend's own extension does, because a
  // conversation drawn by the app looks supervised, and one that only LOOKS supervised is the worse
  // failure. Applied through the runtime extension (`./runtime-extension.js` reads the option), so the
  // core names neither the key nor the backend.
  { id: 'approvalGate', label: 'Ask before commands and file changes', type: 'toggle', default: true,
    appliesAt: 'spawn', appliedBy: 'buildRuntimeExtension',
    description: 'Every bash or PowerShell command, file edit, file write and subagent run waits for your answer: allow once, allow for '
      + 'the rest of this session, or refuse. A convenience, not a security boundary — the check runs inside '
      + 'the agent\'s own process, and a Pi started outside Switchboard asks nothing.' },
];

function stripTuiOnly(options) {
  const out = { ...(options || {}) };
  for (const id of TUI_ONLY) delete out[id];
  return out;
}

/**
 * The same launch as the terminal backend's, driven over RPC: `pi --mode rpc` plus every option that
 * backend would send. The command is resolved to something that runs WITHOUT a shell — on Windows Pi is
 * an npm `.cmd` shim, which a pipe-driven child cannot start directly.
 */
function buildLaunch(ctx = {}) {
  const base = pi.buildLaunch({ ...ctx, options: stripTuiOnly(ctx.options) });
  const exec = piExecCommand();
  return {
    ...base,
    command: exec.command,
    args: [...exec.args, '--mode', 'rpc', ...base.args],
    spawnMode: 'argv',
  };
}

// The capability matrix (#439), declared rather than derived. Where the answer is the binary's, it is the
// terminal backend's; where driving it over a pipe changes the answer, it says so.
const capabilities = {
  ...pi.capabilities,
  // It is told which session it is on by `get_state` rather than by a binding extension, and asks again
  // after every settled run — so a move is followed, just not through the live-binding hook.
  liveRebinding: { state: 'no', note: 'follows its session through the RPC state instead of a binding' },
  queuedTurn: { state: 'limited', note: 'the RPC reports the waiting prompts; the turn-hold reads the terminal backend’s record' },
  viewportPaging: { state: 'no', note: 'no terminal — the conversation view scrolls itself' },
};

module.exports = {
  id: 'pi-native',
  label: 'Pi (native)',
  description: 'Pi driven through its runtime protocol — the conversation drawn by Switchboard, no terminal.',
  tier: 1,
  axis: 'B',
  status: 'ready',
  monogram: 'Pn',
  colour: 'pi',
  // HOW this backend runs: a child process on a pipe, not a PTY. `src/app/terminal/spawn.js` branches on it
  // and the renderer mounts a conversation view instead of a terminal. The core names no backend for either.
  transport: runtimeExtension.TRANSPORT,
  // …and whose transcripts it drives. `backends.openerFor(row)` matches a row's owner and its recorded
  // transport against these two and nothing else.
  transcriptsOf: 'pi',
  // The protocol half the core drives. Everything in it speaks Pi on one side and the app's own vocabulary
  // on the other — see `./rpc-protocol.js` for the ops.
  rpc: {
    createDecoder: protocol.createDecoder,
    sendCommand: protocol.sendCommand,
    abortCommand: protocol.abortCommand,
    stateCommand: protocol.stateCommand,
    messagesCommand: protocol.messagesCommand,
    answerCommand: protocol.answerCommand,
    sessionIdFromState: protocol.sessionIdFromState,
    entriesFromMessages: protocol.entriesFromMessages,
  },
  // The per-spawn extension: the transport marker, and the approval gate (`./runtime-extension.js`). A pair,
  // like the binding and the templates: the release is kept by the core for the exit handler.
  providesRuntimeExtension: true,
  buildRuntimeExtension: ({ dir, tag, options, log } = {}) =>
    runtimeExtension.writeRuntimeExtension({ dir, tag, options, log }),
  releaseRuntimeExtension: (file, log) => runtimeExtension.removeRuntimeExtension(file, log),
  cliHomeEnv: pi.cliHomeEnv,
  changelogSource: null,   // the same CLI as `pi`, which already names its changelog — asking twice lists it twice
  supportsFork: true,      // `pi --mode rpc --fork <id>` — the flag is Pi's, not the mode's
  supportsSubagents: false,
  supportsLiveRebinding: false,
  // The document conventions (#569) work unchanged over RPC: Pi expands a prompt template before it sends
  // a `prompt` command, exactly as it does for a line typed into its TUI.
  providesPromptTemplates: pi.providesPromptTemplates,
  buildPromptTemplates: pi.buildPromptTemplates,
  releasePromptTemplates: pi.releasePromptTemplates,
  // The subagent tool (#634) is the same extension over RPC. Its child is a second Pi that does not load
  // this backend's runtime extension, so the approval gate cannot reach the child's own calls — which is
  // why `subagent` is one of GATED_TOOLS (`./runtime-extension.js`): the delegation itself is asked about.
  // Its cost line is part of the tool's result text, so the conversation view shows it as tool output
  // without knowing the tool.
  providesSubagentTool: pi.providesSubagentTool,
  buildSubagentTool: pi.buildSubagentTool,
  releaseSubagentTool: pi.releaseSubagentTool,
  // Everything below answers a question about Pi's STORE and FORMAT, which this backend shares.
  resolveLineage: pi.resolveLineage,
  openedWithCommand: pi.openedWithCommand,
  contextWindow: pi.contextWindow,
  transcriptPathFor: pi.transcriptPathFor,
  plansDir: pi.plansDir,
  memorySources: pi.memorySources,
  transcriptAccess: pi.transcriptAccess,
  normalizeTranscriptEntries: pi.normalizeTranscriptEntries,
  rewriteProjectPath: pi.rewriteProjectPath,
  deleteSessions: pi.deleteSessions,
  projectTrust: pi.projectTrust,
  // #632: the same binary takes over the same resources, and the same trust rule decides the project half.
  sharedResources: pi.sharedResources,
  acceptsSharedResources: pi.acceptsSharedResources,
  trustsProjectResources: pi.trustsProjectResources,
  caveat: pi.caveat,
  capabilities,
  configFields,
  buildLaunch,
  probe: pi.probe,
  findExecutable: pi.findExecutable,
  listModels: pi.listModels,
  skillInvocation: pi.skillInvocation,
  listResources: pi.listResources,
  expandResource: pi.expandResource,
  resourceEditing: pi.resourceEditing,
  resourceScaffolds: pi.resourceScaffolds,
  PARSER_SCHEMA_VERSION: pi.PARSER_SCHEMA_VERSION,
};
