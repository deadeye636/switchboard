// backends/pi-native/runtime-extension.js — the extension a runtime-driven Pi session is started with (#568).
//
// One file per spawn, written under the app's own data directory and passed as `--extension <file>`, exactly
// the way `../pi/live-binding.js` hands the terminal backend its binding. Never into Pi's own configuration:
// a Pi the user starts themselves must not inherit anything from this app.
//
// What it does:
//
//   * MARKS the transcript. On `session_start` it appends the transport marker (`../pi/transport-marker.js`)
//     unless the session already carries one, so the index can tell a session this backend drove from one
//     the terminal backend drove — they share one store. Measured on Pi 0.84.4: `appendEntry` before the
//     first message is held and written with it, so a session nobody wrote to leaves no transcript and no
//     orphaned marker.
//   * ASKS before `bash`, `powershell`, `edit` and `write` (step C of #568), unless the `approvalGate` option is off. Pi
//     has no approval of its own: its project trust decides what is LOADED, and an enabled tool then runs
//     unasked. The question is Pi's own `ctx.ui.select`, which RPC mode turns into an `extension_ui_request`
//     the app answers — no side channel. Its title is a line for the app, not for a person (see
//     APPROVAL_PREFIX); the app draws the question itself. "Allow for this session" is remembered in this
//     process only, per tool, so it ends with the session; anything lasting is the setting. The question is
//     handed the run's abort signal: Pi's `abort` waits for the run to go idle, and a handler still waiting
//     on an answer would hold that forever — with the signal, Stop resolves the question to "no" and the
//     call is blocked, which is also what every answer that is not an explicit allow does.
//
// **The gate is a convenience, not a security boundary**, and the settings text and the dialog say so. It
// runs inside the agent's own process, a Pi started outside the app does not have it, and it asks about
// the tools in GATED_TOOLS by name — an extension that registers a tool of its own is not covered.
//
// It carries no busy/idle reporting, unlike the terminal backend's binding: over RPC those edges are events
// on the same pipe the app already reads (`agent_start` / `agent_settled`), so a loopback POST would be a
// second, slower copy of a fact the app has first-hand.
//
// **A raw `fs.writeFileSync` is right here**, for the reason `../pi/prompt-templates.js` gives: a file made
// for one spawn, in a directory only this app writes, with no previous content to keep or race against.
'use strict';

const fs = require('fs');
const path = require('path');
const { TRANSPORT_MARKER_TYPE } = require('../pi/transport-marker');

// The value the marker carries, and the one the descriptor's `transport` names. One constant, so the
// writer, the parser's reading of it and the registry's matching cannot drift apart.
const TRANSPORT = 'rpc';

// The option that switches the gate off, read HERE and nowhere else (the #569 shape: the core hands the
// resolved options to the hook and names neither the key nor the backend). ON unless someone said no.
const OPTION_ID = 'approvalGate';

// The tools that change something outside the conversation. `read`, `grep`, `find` and `ls` only look.
// `powershell` is Pi's built-in shell for Windows: off by default, but the `tools` option can enable it, and
// a shell that runs unasked beside one that asks is the gap this gate exists to close.
const GATED_TOOLS = ['bash', 'powershell', 'edit', 'write'];

// What the question starts with, so the protocol decoder can tell OUR question from any other extension's
// dialog and draw it as an approval. After the prefix: JSON `{ tool, id }` — the tool call's own id, which
// is how the app finds the call it is about in the conversation it already holds.
const APPROVAL_PREFIX = 'switchboard-approval:';

// The three answers, in the order they are offered. The app answers with one of these strings.
const CHOICES = { once: 'Allow once', session: 'Allow for this session', refuse: 'Refuse' };

// A tag becomes part of a file NAME and the release deletes that name, so it is held to a plain token —
// the same rule `../pi/prompt-templates.js` applies to its directory, for the same reason.
const SAFE_TAG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const FILE_PREFIX = 'pi-native-';
const OWN_FILE = new RegExp(`^${FILE_PREFIX}[A-Za-z0-9][A-Za-z0-9_-]{0,127}\\.ts$`);

function gateOn(options) {
  // `!== false`: the field defaults ON and the cascade stores only what somebody marked as set.
  return !(options && options[OPTION_ID] === false);
}

function extensionSource({ gate = true } = {}) {
  const type = JSON.stringify(TRANSPORT_MARKER_TYPE);
  const transport = JSON.stringify(TRANSPORT);
  const marker = `  pi.on("session_start", async (_event: any, ctx: any) => {\n`
    + `    try {\n`
    + `      const entries = ctx?.sessionManager?.getEntries?.() || [];\n`
    + `      const marked = entries.some((e: any) => e && e.type === "custom" && e.customType === ${type}\n`
    + `        && e.data && e.data.transport === ${transport});\n`
    + `      if (!marked) pi.appendEntry(${type}, { transport: ${transport} });\n`
    + `    } catch {}\n`
    + `  });\n`;
  const approvals = !gate ? '' : `  const gated = new Set(${JSON.stringify(GATED_TOOLS)});\n`
    + `  const allowed = new Set<string>();\n`
    + `  pi.on("tool_call", async (event: any, ctx: any) => {\n`
    + `    const tool = String(event?.toolName || "");\n`
    + `    if (!gated.has(tool) || allowed.has(tool)) return;\n`
    + `    let choice: any;\n`
    + `    try {\n`
    + `      choice = await ctx.ui.select(${JSON.stringify(APPROVAL_PREFIX)} + JSON.stringify({ tool, id: event?.toolCallId || null }),\n`
    + `        ${JSON.stringify([CHOICES.once, CHOICES.session, CHOICES.refuse])}, { signal: ctx?.signal });\n`
    + `    } catch { choice = undefined; }\n`
    + `    if (choice === ${JSON.stringify(CHOICES.session)}) { allowed.add(tool); return; }\n`
    + `    if (choice === ${JSON.stringify(CHOICES.once)}) return;\n`
    + `    return { block: true, reason: "The user did not allow this " + tool + " call." };\n`
    + `  });\n`;
  return `// Generated by Switchboard for one Pi session. Safe to delete.\n`
    + `export default function (pi: any) {\n`
    + marker
    + approvals
    + `}\n`;
}

/** Write the extension for one spawn. Answers `{ args, cleanup }`, or null when it cannot. */
function writeRuntimeExtension({ dir, tag, options, log } = {}) {
  if (!dir || !tag || !SAFE_TAG.test(String(tag))) return null;
  const file = path.join(dir, `${FILE_PREFIX}${tag}.ts`);
  const gate = gateOn(options);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, extensionSource({ gate }), 'utf8');
  } catch (err) {
    if (log && typeof log.warn === 'function') log.warn(`[pi-native] could not write the runtime extension: ${err.message}`);
    return null;
  }
  if (log && typeof log.debug === 'function') log.debug(`[pi-native] runtime extension written (approval gate ${gate ? 'on' : 'off'})`);
  return { args: ['--extension', file], cleanup: file };
}

/** Remove a file this module wrote, and nothing else. */
function removeRuntimeExtension(file, log) {
  if (!file || !OWN_FILE.test(path.basename(String(file)))) return;
  try { fs.rmSync(file, { force: true }); }
  catch (err) { if (log && typeof log.warn === 'function') log.warn(`[pi-native] cleanup failed: ${err.message}`); }
}

// What an ask's title says, if it is our approval question: `{ tool, id }`, else null.
function parseApprovalTitle(title) {
  const s = String(title == null ? '' : title);
  if (!s.startsWith(APPROVAL_PREFIX)) return null;
  try {
    const v = JSON.parse(s.slice(APPROVAL_PREFIX.length));
    return v && typeof v.tool === 'string' ? { tool: v.tool, id: typeof v.id === 'string' ? v.id : null } : null;
  } catch { return null; }
}

module.exports = {
  TRANSPORT, OPTION_ID, GATED_TOOLS, CHOICES, APPROVAL_PREFIX,
  writeRuntimeExtension, removeRuntimeExtension, extensionSource, parseApprovalTitle,
};
