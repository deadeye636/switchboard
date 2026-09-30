// backends/claude-native/index.js — Claude Code driven over its stream-json pipe instead of a terminal (#653, #660).
//
// The terminal backend in `../claude/` starts Claude's TUI in a PTY and reads the transcript it leaves on
// disk. This one starts the INSTALLED `claude` in print mode with stream-json on both sides: one JSON line per
// turn or control request in, messages and events out. There is no terminal — the app draws the conversation
// itself (`src/renderer/session/conversation-view.js`) and sends turns through the same pipe. Whoever wants
// Claude's own TUI keeps the other backend; the two never share a surface (#653 E3).
//
// SAME BINARY, SAME STORE. Everything that is a property of Claude rather than of how it is driven is the
// other backend's answer, forwarded rather than copied: its store, its parser version, its trust answer, its
// skills and resources. The same argument `../pi-native/` makes for Pi.
//
// THE ROWS STAY CLAUDE'S. This backend declares no discovery and no parser. A session it drove carries the
// marker Claude Code writes itself from the environment (`../claude/transport-marker.js`), Claude's reader
// records it as the row's `transport`, and `backends.openerFor(row)` hands such a row to this backend. Switched
// off, the row goes back to the terminal backend: the transcript is Claude's either way.
//
// NO LOGIN, NO TOKEN (#653 E4). This backend runs the CLI the user installed and signed in to, as that user,
// and handles no credential of any kind. A CLI that is not signed in says so in its own words, on screen.
'use strict';

const fs = require('fs');
const path = require('path');
const claude = require('../claude');
const { findOnPath } = require('../file-store');
const { encodeProjectPath } = require('../../session/encode-project-path');
const { TRANSPORT, TRANSPORT_ENTRYPOINT_ENV, TRANSPORT_ENTRYPOINT } = require('../claude/transport-marker');
const protocol = require('./rpc-protocol');
const { MIN_VERSION, olderThan, installedVersion } = require('./version');

// The permission modes a piped session can start in (#653 E6). Claude's own list without the skip flag, which
// the terminal backend offers as a choice of this field and this one does not: a session whose every tool is
// allowed without a word is the one case where an approval card could never appear, and `bypassPermissions`
// already says the same thing in the CLI's own vocabulary. 'default' sends no flag at all, so Claude's own
// `defaultMode` from its settings applies — which is what an unset value means on every backend.
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
const claudePermission = claude.configFields.find(f => f.id === 'permissionMode') || {};
const configFields = [
  { id: 'permissionMode', label: 'Permission mode', type: 'select',
    choices: PERMISSION_MODES,
    choiceLabels: Object.fromEntries(PERMISSION_MODES.map(c => [c, (claudePermission.choiceLabels || {})[c] || c])),
    default: 'default',
    description: 'Which tool calls Claude asks about before running them. Default sends nothing, so the mode in your Claude settings applies.' },
  { id: 'model', label: 'Model', type: 'text', default: '' },
  // The terminal backend's argv options, measured on the pipe (#685, Claude Code 2.1.283, `-p` with
  // stream-json both ways): each one starts and is honoured. `--worktree` moves the session into the worktree
  // (system/init reports its cwd), `--chrome` adds the claude-in-chrome MCP server, `--restricted` removes
  // Bash and WebFetch, and `--add-dir` / `--autocompact` start without complaint. Taken as Claude's own
  // declarations, so a label or a caveat changed there reaches this dialog too — except where driving it over
  // a pipe changes what the caveat says.
  ...['worktree', 'worktreeName', 'chrome', 'addDirs'].map(id => claude.configFields.find(f => f.id === id)).filter(Boolean),
  // Claude's description warns that restricted mode turns off the attention hook. A piped session does not
  // use that hook — its busy state comes from the stream — so that half is left out; the refusal of Bypass is
  // the same CLI check and stays (measured: "bypassPermissions not supported in restricted mode", exit 1).
  { id: 'restricted', label: 'Restricted mode', type: 'toggle', default: false,
    description: 'Removes the tools that run commands or code, and WebFetch. Also ignores your settings files, and refuses the Bypass permission mode: that combination fails to start.' },
  ...['autocompact'].map(id => claude.configFields.find(f => f.id === id)).filter(Boolean),
  // Claude's suggested next prompt, greyed out in the input and taken with Tab (#693). `--prompt-suggestions` is
  // part of this backend's launch, like `--verbose` (the CLI keeps them off in print mode without it — measured,
  // spec 32), and this option is the way OUT: an opt-out whose default, off, sends nothing — the configFields
  // rule (a default describes, it is never sent). Each suggestion is a model call of its own; hence the switch.
  { id: 'promptSuggestionsOff', label: 'Turn off prompt suggestions', type: 'toggle', default: false,
    description: 'After a turn, Claude suggests a next prompt; Tab takes it into the input. Each suggestion is a small model call of its own — switch this on to stop them.' },
  // NOT offered, and why (#685):
  // - `mcpEmulation` starts the IDE bridge and adds `--ide` at the terminal spawn site. A piped session asks
  //   its approvals over the pipe (`--permission-prompt-tool stdio`) and draws them on a card, so a diff review
  //   through the bridge would be a second place to answer the same edit.
  // - `afkTimeoutSec` sets the timer of the TUI's question dialog. A piped session shows no such dialog: the
  //   question comes over the pipe and waits on a card. Not measured, because no dialog exists to time out.
];

/**
 * The executable this backend starts: `claude` on PATH, and on Windows only a real `.exe`. A child on a pipe
 * is started without a shell, and an npm install's `claude.cmd` cannot be started that way.
 */
function findExecutable() {
  return findOnPath('claude');
}

/**
 * Is there a `claude` this backend can start? The PATH walk is all the registry's `list()` pays for. The
 * version floor needs a child process, so it is checked only when a session is about to start
 * (`{ launch: true }`, from the spawn path) and answers a Promise there — see `./version.js`.
 */
function probe({ launch = false } = {}) {
  const file = findExecutable();
  if (!file) return { ok: false, reason: 'Claude Code was not found on PATH.' };
  if (process.platform === 'win32' && !/\.(exe|com)$/i.test(file)) {
    return { ok: false, reason: 'Claude Code was found only as a script shim. Driving it without a terminal needs the native build (claude.exe) on PATH.' };
  }
  if (!launch) return { ok: true };
  return installedVersion(file).then((version) => {
    // A version that could not be read says nothing about the install; the launch goes ahead.
    if (version && olderThan(version, MIN_VERSION)) {
      return { ok: false, reason: `Claude (native) needs Claude Code ${MIN_VERSION.join('.')} or newer; ${version.join('.')} is installed.` };
    }
    return { ok: true };
  });
}

/**
 * The launch: print mode with stream-json on both sides. Each flag is here for a measured reason:
 *   `--verbose`                   stream-json output refuses to run without it
 *   `--include-partial-messages`  the reply is drawn as it is written (~40 small events a second, cheap)
 *   `--replay-user-messages`      the user's own line comes back with the uuid the transcript gives it
 *   `--permission-prompt-tool stdio`  approvals come over the pipe; without it a tool that needs one is refused
 * Session values are passed as `--flag=value`, so an id can never be read as a flag of its own.
 *
 * A fork names its new id too (`--session-id` beside `--fork-session`, measured on 2.1.283): the tab is then
 * keyed on the fork from the first frame, and nothing has to re-key it once the stream names the id.
 */
function buildLaunch({ cwd, resume, sessionId, forkFrom, options } = {}) {
  const opts = options || {};
  const fork = forkFrom != null ? forkFrom : opts.forkFrom;
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio'];
  if (fork) {
    args.push(`--resume=${fork}`, '--fork-session');
    if (sessionId) args.push(`--session-id=${sessionId}`);
  } else if (resume) args.push(`--resume=${sessionId}`);
  else args.push(`--session-id=${sessionId}`);
  if (opts.permissionMode && opts.permissionMode !== 'default' && PERMISSION_MODES.includes(opts.permissionMode)) {
    args.push('--permission-mode', String(opts.permissionMode));
  }
  if (opts.model) args.push('--model', String(opts.model));
  // The flags the terminal backend sends for these options (#685), with a value joined to its flag as above
  // rather than a separate argv entry — both spellings were measured to start.
  if (opts.worktree) args.push(opts.worktreeName ? `--worktree=${opts.worktreeName}` : '--worktree');
  if (opts.chrome) args.push('--chrome');
  if (opts.addDirs) {
    for (const dir of String(opts.addDirs).split(',').map(d => d.trim()).filter(Boolean)) args.push(`--add-dir=${dir}`);
  }
  if (opts.restricted) args.push('--restricted');
  if (opts.autocompact) args.push(`--autocompact=${opts.autocompact}`);
  // Part of the launch unless the user turned it off (#693, the field's comment says why it is an opt-out).
  if (!opts.promptSuggestionsOff) args.push('--prompt-suggestions');
  return {
    command: 'claude',
    args,
    // The transport marker (#658): Claude Code writes this variable's value into every transcript line it
    // writes, and Claude's reader turns that into the row's `transport`.
    env: { [TRANSPORT_ENTRYPOINT_ENV]: TRANSPORT_ENTRYPOINT },
    cwd,
    spawnMode: 'argv',
  };
}

// A session's transcript file, or null. The folder is Claude's own encoding of the working directory; a
// directory whose name the CLI shortened differently is found by the id instead.
async function findTranscript(root, sessionId, cwd) {
  const file = cwd ? path.join(root, encodeProjectPath(String(cwd)), `${sessionId}.jsonl`) : null;
  if (file && fs.existsSync(file)) return file;
  let dirs = [];
  try { dirs = await fs.promises.readdir(root, { withFileTypes: true }); } catch { dirs = []; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const candidate = path.join(root, d.name, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Where an attach gets the conversation so far. The CLI cannot be asked for it, so it is read from the
// transcript Claude writes (`agent-rpc.js`, `attachFromTranscript`).
//
// A FORK has no file of its own until its first turn: measured on 2.1.283, `--fork-session` writes the copied
// history together with that turn, not at start. Until then its conversation IS its parent's, line for line
// and under the same uuids (measured), so the parent's file answers — and once the fork's own file exists it
// answers instead, with the keys the view already holds.
async function entriesFromTranscript({ sessionId, cwd, forkFrom } = {}) {
  if (!sessionId) return [];
  const root = claude._roots()[0];
  let file = await findTranscript(root, sessionId, cwd);
  if (!file && forkFrom) file = await findTranscript(root, forkFrom, cwd);
  // A session that has not written its file yet has an empty conversation, which is the truth about it.
  if (!file) return [];
  let text = '';
  try { text = await fs.promises.readFile(file, 'utf8'); } catch (err) { if (err && err.code === 'ENOENT') return []; throw err; }
  const lines = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try { lines.push(JSON.parse(raw)); } catch { /* a line being written */ }
  }
  return protocol.conversationEntries(lines);
}

// The capability matrix (#439). Where the answer is the binary's or the store's, it is Claude's; where
// driving it over a pipe changes the answer, or where the row's owner already answers, it says so.
const capabilities = {
  ...claude.capabilities,
  endpoint: { state: 'no', note: 'a template carries an endpoint on the terminal Claude backend' },
  subagentSessions: { state: 'no', note: 'the rows are Claude\'s, and their subagents are listed there' },
  liveOwners: { state: 'no', note: 'asked through the terminal Claude backend, which keeps that list' },
  stopLiveOwner: 'no',
  liveRebinding: { state: 'no', note: 'follows its session through the ids the stream names instead of a binding' },
  queuedTurn: { state: 'no', note: 'the stream says when a queued line starts, not how many are waiting' },
  quota: { state: 'no', note: 'shown for the terminal Claude backend, whose account this is' },
  resourcesFrom: 'no',
  planDirSetting: { state: 'no', note: 'set up through the terminal Claude backend, which reads the same settings' },
  projectConfig: { state: 'no', note: 'shown once, for the terminal Claude backend, which reads the same file' },
  viewportPaging: { state: 'no', note: 'no terminal — the conversation view scrolls itself' },
};

module.exports = {
  id: 'claude-native',
  label: 'Claude (native)',
  description: 'Claude Code driven over its stream-json protocol — the conversation drawn by Switchboard, no terminal.',
  tier: 1,
  axis: 'B',
  status: 'ready',
  monogram: 'Cn',
  // Claude's colour with a monogram of its own and no artwork, so the two Claude backends are told apart in
  // every list that draws a badge — the logo would make them identical.
  colour: 'claude',
  // HOW this backend runs: a child on a pipe (`src/app/agent-rpc.js`), and whose transcripts it drives.
  transport: TRANSPORT,
  transcriptsOf: 'claude',
  // Print mode skips Claude's workspace trust dialog (measured: a project's hooks ran and its CLAUDE.md was
  // read in a folder nobody trusted). So the spawn path asks Claude's saved answer first and refuses without
  // one (#655, #653 E5).
  trustBeforeStart: true,
  rpc: {
    createDecoder: protocol.createDecoder,
    responseOf: protocol.responseOf,
    // A turn line is never answered (point 1 in `./rpc-protocol.js`): the write is the send.
    sendAcknowledged: false,
    sendCommand: protocol.sendCommand,
    // A turn may carry images, as content blocks beside its text (#662).
    imageInput: protocol.IMAGE_INPUT,
    abortCommand: protocol.abortCommand,
    // One background task, not the turn (#691).
    stopTaskCommand: protocol.stopTaskCommand,
    // The context fill and the model for the line under the input (#691).
    contextCommand: protocol.contextCommand,
    contextFromResponse: protocol.contextFromResponse,
    // …asked during a turn as well (#697): measured on 2.1.283, `get_context_usage` sent mid-turn was answered
    // within 250 ms every time, with the fill as it stood after the last API call.
    contextDuringTurn: true,
    // The permission mode of the running session, switched from the view (#696): the order a switch walks,
    // the request, and the words a mode is drawn with.
    modeCycle: protocol.MODE_CYCLE,
    setModeCommand: protocol.setModeCommand,
    modeInfo: protocol.modeInfo,
    commandsCommand: protocol.commandsCommand,
    commandsFromResponse: protocol.commandsFromResponse,
    // A bare `/mcp` is answered by the app, from `mcp_status`, and never written as a turn (#719); the view
    // manages the servers from there — reconnect, enable/disable, sign in and out (#728).
    appCommandOp: protocol.appCommandOp,
    serversCommand: protocol.serversCommand,
    serverList: protocol.serverList,
    serverActionCommand: protocol.serverActionCommand,
    serverActionResult: protocol.serverActionResult,
    answerCommand: protocol.answerCommand,
    // No `stateCommand`: the CLI names its session on every line and the decoder announces a move as an
    // `identity` op. No `messagesCommand`: the conversation is read from the transcript.
    entriesFromTranscript,
    entryKey: protocol.entryKey,
    // No `gracefulStopMs` (#653 E14): measured, a child killed the moment its `result` arrived had already
    // written that turn's last line, so a wait would save nothing.
  },
  cliHomeEnv: claude.cliHomeEnv,
  changelogSource: null,   // the same CLI as `claude`, which already names its changelog — asking twice lists it twice
  supportsFork: true,      // `--resume=<id> --fork-session --session-id=<new>` works in print mode (measured)
  supportsSubagents: false,
  supportsLiveRebinding: false,
  // Everything below answers a question about Claude's STORE and FORMAT, which this backend shares.
  resolveLineage: claude.resolveLineage,
  openedWithCommand: claude.openedWithCommand,
  normalizeTranscriptEntries: claude.normalizeTranscriptEntries,
  contextWindow: claude.contextWindow,
  transcriptPathFor: claude.transcriptPathFor,
  plansDir: claude.plansDir,
  memorySources: claude.memorySources,
  transcriptAccess: claude.transcriptAccess,
  rewriteProjectPath: claude.rewriteProjectPath,
  deleteSessions: claude.deleteSessions,
  projectTrust: claude.projectTrust,
  skillInvocation: claude.skillInvocation,
  listResources: claude.listResources,
  expandResource: claude.expandResource,
  resourceEditing: claude.resourceEditing,
  resourceScaffolds: claude.resourceScaffolds,
  // What another CLI may take over from Claude is offered once, by the terminal backend: the files are the
  // same, and a second source with the same skills would list every one of them twice in "Resources from".
  sharedResources: null,
  capabilities,
  configFields,
  buildLaunch,
  probe,
  findExecutable,
  PARSER_SCHEMA_VERSION: claude.PARSER_SCHEMA_VERSION,
};
