// backends/pi/hooks-section.js — the source's hooks, run on this Pi session's own lifecycle (#635).
//
// A section of the per-spawn resources extension (`./resources-extension.js`), like the subagent tool, the
// command bridge and the MCP client. A user has attached commands to their other CLI's lifecycle; with
// "Resources from" and this section's toggle on, the same commands run when the Pi session reaches the
// matching moment.
//
// WHAT THE CORE HANDS OVER, and what is decided here:
//   - the core resolves WHICH hooks this launch gets (`src/app/resource-sources.js`): the trust rule, the
//     toggle, and the source's own refusals. It speaks neutral words — `session-start`, `tool-finished`,
//     `agent-idle` (`../hook-events.js`) — and carries the source's `hookDialect` as data.
//   - this file declares which of PI'S events is each word (`EVENT_FOR_WORD`), and writes the payload in
//     the shape the dialect describes. That split is what keeps one CLI's event names out of the other's
//     folder, exactly as `../tool-vocabulary.js` does for an agent's tools.
//
// THE PAYLOAD IS THE SOURCE'S OWN SHAPE, and that is the point rather than a compromise (owner decision
// H8). A hook the user already wrote reads `hook_event_name`, `tool_name` and the rest by name; handing it
// a neutral shape would be a takeover that breaks everything it takes over. Nothing of those key names is
// written here — they come out of the dialect.
//
// NOTHING WAITS FOR A HOOK (H5). Pi awaits its event handlers, so a hook that takes ten seconds would make
// the agent look stuck with nothing on screen saying why. The handler starts the child and returns; the
// child is stopped at its own timeout, with its whole tree, because `shell: true` means the thing this
// file holds is a SHELL and killing a shell does not kill what it launched. A hook cannot answer back
// either: a moment that could be blocked is not in the vocabulary at all, so there is no return value to
// honour and no way for one to hold the session.
//
// FAILURES ARE SAID, SUCCESS IS NOT (H10). A hook that never fires is invisible, which is the failure this
// feature is most likely to have — so a non-zero exit, a spawn that fails and a timeout each put one line
// in the conversation. A hook that worked says nothing: a line per tool call is noise, and the user asked
// for the command to run rather than for a report that it did.
//
// The hooks are written INTO the extension file, which sits in a directory only this app writes, is made
// fresh per spawn and is removed at exit — the recorded exempt class for a generated per-spawn file. That
// is about the FILE; what reaches the CONVERSATION is held down separately, because a hook command line
// routinely carries a token and the conversation can be exported.
'use strict';

const { isHookEventWord } = require('../hook-events');

// Which of Pi's own events is each neutral moment. MEASURED against Pi 0.85.1 rather than read off the
// event list, because two of the three have a plausible neighbour that is the wrong one:
//   - `tool_result` and not `tool_execution_end`: the end-of-execution event carries the tool's RESULT and
//     not its INPUT, and a hook of this kind is handed both. Measured payloads:
//     `tool_result` `{type, toolName, toolCallId, input, content, details, isError, usage}`,
//     `tool_execution_end` `{type, toolCallId, toolName, result, isError}`.
//   - `agent_settled` and not `agent_end`: Pi's own documentation says an `agent_end` may still be followed
//     by a retry, a compaction or a queued continuation, so it is not the moment a person means by "it has
//     stopped". The live binding reached the same conclusion for busy/idle (#573).
const EVENT_FOR_WORD = Object.freeze({
  'session-start': 'session_start',
  'tool-finished': 'tool_result',
  'agent-idle': 'agent_settled',
});

// What a tool moment's own tool is called, in the neutral words, so a hook limited to some tools can be
// compared without this file learning the other CLI's names. Pi's tool names onto `../tool-vocabulary.js`.
const WORD_FOR_TOOL = Object.freeze({
  read: 'read',
  write: 'write',
  edit: 'edit',
  grep: 'search-text',
  glob: 'find-files',
  find: 'find-files',
  ls: 'list-dir',
  list: 'list-dir',
  bash: 'shell',
  powershell: 'shell',
});

// How much of a hook's own output is repeated when it fails. Only the FIRST meaningful line of its stderr,
// capped: a script that fails often prints a stack trace, and the line that says what went wrong is the
// first one — the frames after it are noise in a conversation. The same reading `../cli-probe.js` takes of
// a CLI's complaint. Colour codes are stripped, because a tool writing to a pipe still colours its output
// and the escapes would be shown as text.
const OUTPUT_CAP = 200;

// How much of the command itself a failure line repeats. Enough to recognise which entry it was, and not
// the whole line: a hook command routinely carries a token, and this text goes into the conversation,
// which the app can export to a file.
const COMMAND_CAP = 40;

// Every key the payload needs a name for. A dialect missing one is INCOMPLETE, and the row is refused
// rather than filled in from here: a default would be some other CLI's spelling written into this folder,
// which is the violation this file's header spends a paragraph avoiding (CLAUDE.md reflex 5). A source
// that cannot say what its hooks read cannot have them run.
const PAYLOAD_KEYS = Object.freeze(['eventKey', 'sessionKey', 'cwdKey', 'toolNameKey', 'toolInputKey', 'toolResponseKey']);

const dialectComplete = (d, word) => !!d && typeof d === 'object'
  && PAYLOAD_KEYS.every((k) => typeof d[k] === 'string' && d[k])
  && !!(d.eventNames && typeof d.eventNames === 'object' && typeof d.eventNames[word] === 'string' && d.eventNames[word]);

/** Which hooks this launch can actually run, and which cannot be placed. */
function usable(hooks) {
  const runnable = [];
  const dropped = [];
  for (const h of hooks || []) {
    if (!h || typeof h.command !== 'string' || !h.command) continue;
    if (!isHookEventWord(h.event) || !EVENT_FOR_WORD[h.event]) {
      dropped.push({ path: h.path || null, kind: 'hook', scope: h.scope || 'global', reason: 'no-event-here' });
      continue;
    }
    if (!dialectComplete(h.dialect, h.event)) {
      dropped.push({ path: h.path || null, kind: 'hook', scope: h.scope || 'global', reason: 'no-hook-dialect' });
      continue;
    }
    runnable.push(h);
  }
  return { runnable, dropped };
}

// The rows as the generated code needs them: Pi's event name, the tools it is limited to, the command, the
// timeout, and the key names the payload uses. Nothing else of the row travels — the scope and the file it
// came from are for the log and the preview, and the generated code has no use for either.
function rowsFor(hooks) {
  return hooks.map((h) => ({
    event: EVENT_FOR_WORD[h.event],
    word: h.event,
    tools: Array.isArray(h.tools) && h.tools.length ? h.tools : null,
    command: h.command,
    timeoutMs: Number.isFinite(h.timeoutMs) && h.timeoutMs > 0 ? h.timeoutMs : 60000,
    // No fallbacks: `usable` has already refused a row whose dialect does not name every one of these,
    // because a default here would be another CLI's spelling written into this folder.
    keys: {
      event: String(h.dialect.eventKey),
      name: String(h.dialect.eventNames[h.event]),
      session: String(h.dialect.sessionKey),
      cwd: String(h.dialect.cwdKey),
      toolName: String(h.dialect.toolNameKey),
      toolInput: String(h.dialect.toolInputKey),
      toolResponse: String(h.dialect.toolResponseKey),
    },
    // The file the hook was configured in, for the line that says one failed. See `swFailed`.
    from: h.path ? String(h.path) : '',
  }));
}

// A STATIC IMPORT, and it has to be: the generated file is an ES module (it ends in `export default`), and
// `require` is not defined in one. A `try { require(…) } catch {}` there does not fail loudly — it takes
// the catch and the section then registers handlers that silently spawn nothing, which is precisely the
// "a hook that never fires" failure this feature is most likely to have. It cost one live run to find,
// because the test had handed the generated code a `require` of its own and so proved the wrong thing.
const IMPORTS = [
  'import { spawn as swSpawn } from "node:child_process";',
];

/**
 * The section's source text, or '' when there is nothing to run — the same shape the other sections hand
 * the composer.
 *
 * Plain strings joined by newlines, like the command bridge and the session commands: no template literal,
 * so a backtick or a `${` in a user's command cannot end or interpolate anything. Every value that comes
 * from outside is written with `JSON.stringify`, which is also what keeps a command line that contains
 * quotes intact.
 */
function hooksSection(hooks) {
  const rows = rowsFor(hooks);
  if (!rows.length) return '';
  const lines = [
    'const swHooks: any[] = ' + JSON.stringify(rows) + ';',
    'const swToolWord: any = ' + JSON.stringify(WORD_FOR_TOOL) + ';',
    'const swCap = ' + OUTPUT_CAP + ';',
    'const swNameCap = ' + COMMAND_CAP + ';',
    'const swSay = (ctx: any, text: string, level: string) => { try { ctx.ui.notify(text, level); } catch {} };',
    // One line about a hook that failed. It names the MOMENT, the file it was configured in and the start
    // of the command — not the whole command line, which routinely carries a token (`curl -H
    // "Authorization: Bearer …"`) and would then sit in the transcript, which this app can export to a
    // file. The same care `src/app/resource-sources.js` takes with an MCP server's `env`. What is shown is
    // enough to find the entry and go and run it.
    'const swWhich = (row: any) => (row.from ? row.from + ", " : "") + row.keys.name + " (" + String(row.command).slice(0, swNameCap) + (String(row.command).length > swNameCap ? "…" : "") + ")";',
    'const swFailed = (ctx: any, row: any, what: string) => swSay(ctx, "A hook from the source failed — " + swWhich(row) + ": " + what, "warning");',
    'const swRun = (row: any, payload: any, ctx: any) => {',
    // `shell: true` because a hook IS a shell command line — the user wrote it for a shell, and splitting
    // it into a program and arguments here would break every one that uses a pipe or a redirect.
    '  let child: any;',
    '  try {',
    '    child = swSpawn(row.command, { shell: true, cwd: ctx && ctx.cwd ? ctx.cwd : undefined, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });',
    '  } catch (err: any) { swFailed(ctx, row, String((err && err.message) || "it could not be started")); return; }',
    '  let err = "";',
    '  let done = false;',
    // `shell: true` means the child is the SHELL, and killing a shell does not kill what it launched —
    // on Windows the tree under `cmd /c` survives, and a pipeline leaves children behind elsewhere. The
    // app's own teardown reaches for `taskkill /T` for exactly this (`src/app/session-shutdown.js`), so
    // this does the same rather than reporting a stop that did not happen.
    // TWO separate attempts, not one: the tree kill is best-effort and platform-dependent, and wrapping
    // both in one `try` would let a failure of the first stop the second from ever running — the one that
    // is always right.
    '  const swStop = () => {',
    '    try { if (process.platform === "win32" && child.pid) swSpawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true, stdio: "ignore" }); } catch {}',
    '    try { child.kill(); } catch {}',
    '  };',
    '  const timer = setTimeout(() => { if (!done) { done = true; swStop(); swFailed(ctx, row, "it ran past its timeout and was stopped"); } }, row.timeoutMs);',
    '  if (typeof timer.unref === "function") timer.unref();',
    // Appended first and cut afterwards: testing the length BEFORE appending lets one large chunk through
    // whole, so what is kept is a chunk rather than the cap.
    '  try { child.stderr.on("data", (d: any) => { if (err.length < swCap) err = (err + String(d)).slice(0, swCap); }); } catch {}',
    '  child.on("error", (e: any) => { if (done) return; done = true; clearTimeout(timer); swFailed(ctx, row, String((e && e.message) || "it could not be started")); });',
    '  child.on("close", (code: any) => {',
    '    if (done) return;',
    '    done = true;',
    '    clearTimeout(timer);',
    '    if (code === 0) return;',
    // The first line that says something, without its colour codes. A regex written through a JS string
    // into generated code loses or doubles its backslashes, so both of these are checked in the tests
    // against the compiled text rather than assumed.
    '    const clean = err.replace(/\\u001b\\[[0-9;]*m/g, "");',
    '    const first = clean.split(/\\r?\\n/).map((l: string) => l.trim()).filter(Boolean)[0] || "";',
    '    const tail = first.slice(0, swCap);',
    '    swFailed(ctx, row, "it exited with " + String(code) + (tail ? ": " + tail : ""));',
    '  });',
    // The payload goes in and the pipe is closed at once: a hook that reads standard input gets its EOF,
    // and one that does not is unaffected.
    //
    // THE `error` LISTENER IS NOT OPTIONAL. A hook that does NOT read its input — `git status`, a
    // notification — exits while a payload larger than the pipe buffer is still being written, and the
    // EPIPE that follows is emitted ASYNCHRONOUSLY on the stdin stream. The `try` below cannot catch that,
    // and `child.on("error")` is a different emitter; with no listener Node raises an uncaught exception
    // inside PI's process and the user's session dies. A `tool_response` from a read of a large file is
    // enough to reach it.
    '  try { child.stdin.on("error", () => {}); } catch {}',
    '  try { child.stdin.end(JSON.stringify(payload)); } catch {}',
    '};',
    'const swPayload = (row: any, ctx: any, tool: any) => {',
    '  const out: any = {};',
    '  out[row.keys.event] = row.keys.name;',
    '  try { out[row.keys.cwd] = ctx && ctx.cwd ? ctx.cwd : ""; } catch {}',
    '  try { out[row.keys.session] = ctx && ctx.sessionManager && typeof ctx.sessionManager.getSessionFile === "function" ? String(ctx.sessionManager.getSessionFile() || "") : ""; } catch {}',
    '  if (tool) {',
    '    out[row.keys.toolName] = String(tool.name || "");',
    '    out[row.keys.toolInput] = tool.input === undefined ? {} : tool.input;',
    '    out[row.keys.toolResponse] = tool.response === undefined ? null : tool.response;',
    '  }',
    '  return out;',
    '};',
    'function registerSourceHooks(pi: any) {',
    '  const byEvent: any = {};',
    '  for (const row of swHooks) { (byEvent[row.event] = byEvent[row.event] || []).push(row); }',
    '  for (const event of Object.keys(byEvent)) {',
    '    pi.on(event, async (ev: any, ctx: any) => {',
    '      const name = String((ev && ev.toolName) || "");',
    '      const word = name ? swToolWord[name] : "";',
    '      const tool = name ? { name, input: ev && ev.input, response: ev && ev.content } : null;',
    '      for (const row of byEvent[event]) {',
    // A hook limited to some tools runs only for those, and a tool whose word is unknown matches none of
    // them: it is a tool the source could not have named, so no matcher of theirs meant it.
    '        if (row.tools && (!word || row.tools.indexOf(word) < 0)) continue;',
    '        swRun(row, swPayload(row, ctx, tool), ctx);',
    '      }',
    '    });',
    '  }',
    '}',
  ];
  return lines.join('\n');
}

module.exports = { IMPORTS, hooksSection, usable, EVENT_FOR_WORD, WORD_FOR_TOOL, OUTPUT_CAP, COMMAND_CAP, PAYLOAD_KEYS, _rowsFor: rowsFor };
