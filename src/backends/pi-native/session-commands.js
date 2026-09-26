// backends/pi-native/session-commands.js — Pi's own session commands, for a Pi with no TUI (#642, #643).
//
// Pi's `/login`, `/logout`, `/model`, `/thinking` and `/compact` are commands of its TERMINAL interface. Over
// RPC a line starting with `/` is only looked up among extension commands, prompt templates and skills; a
// built-in name is sent to the model as plain text (measured on Pi 0.84.4: `/login` and `/model` each cost a
// whole turn in which the model read files and guessed). So `pi-native` registers them itself, as commands of
// its runtime extension (`./runtime-extension.js`), and asks its questions through `ctx.ui` — which RPC mode
// turns into the same `extension_ui_request` the approval gate uses, drawn as a card in the conversation.
//
// This is a section of THAT extension, not of the resources extension (`../pi/resources-extension.js`): the
// resources extension carries what a Pi session is GIVEN on either backend, and the terminal backend has
// these commands natively.
//
// Registered at LOAD, not at `session_start`, on purpose: a built-in of Pi's terminal interface wins over an
// extension command or a prompt template of the same name, and the command bridge (`../pi/command-bridge.js`)
// registers another CLI's commands at `session_start` and skips a name Pi already has. Registering ours
// first makes that the same precedence here. (Two extensions registering one name would rename BOTH to
// `name:1` / `name:2`, and `/name` would then reach nobody — Pi's `resolveRegisteredCommands`.)
//
// THE LOGIN HANGS ON AN UNDOCUMENTED FIELD. `ctx.modelRegistry` is the documented, read-only facade; the
// `ModelRuntime` behind it (`login`, `logout`, `listCredentials`) is its `runtime` field, private in Pi's
// types and public at run time. Owner decision (E2): take it, check for it, and say so plainly where a Pi
// version does not have it — the terminal backend's `/login` writes the same `auth.json`, so that is the way
// out the message names.
//
// Three markers go from the generated code to `./rpc-protocol.js`, which turns them into the app's ops. They
// are needed because `ctx.ui.notify` carries only text and a question only a title:
//
//   LINK_PREFIX     a notice with a page to open (an OAuth login page, a device-code page) — drawn with a
//                   button, because a login URL runs to several hundred characters of query string.
//   ASK_PREFIX      the title of every question these commands ask, as JSON `{ title, secret, token }`:
//                   `secret` draws a masked field (an API key), `token` names the question for the marker
//                   below. It also tells the app the question belongs to a COMMAND, not to a run: the app
//                   drops a run's open questions when the run settles, and a command's question outlives any
//                   run — Pi keeps waiting on it, with no timeout, until it is answered or dismissed.
//   DISMISS_PREFIX  `{ token }`: Pi stopped waiting on that question. An OAuth login races the pasted redirect
//                   URL against its own loopback callback, and when the browser wins Pi aborts the prompt —
//                   RPC mode then resolves the question locally and tells the client NOTHING (Pi 0.84.4,
//                   `createDialogPromise`), so without this the card would stay open with nobody behind it.
//   STATS_PREFIX    `/session` was typed. It carries NO figures, and that is the whole point of it — see
//                   below.
//   EXPORT_PREFIX   `/export` was typed, with whatever was typed after it. It carries no path and writes
//                   no file: only the app knows where a file it produces belongs.
//   COPY_PREFIX     `/copy` was typed. The clipboard is the app's, not the runtime's.
//   SHELL_PREFIX    a `!` line was typed. Not a command at all — see "A `!` LINE" below.
//   TREE_PREFIX     `/tree` was typed (#646). It carries nothing: the app asks Pi for the tree over RPC.
//   NAVIGATED_PREFIX  `{ token, ok, … }`: what the internal move command did — see "`/tree`" below.
//
// A MARKER WITH A SIDE EFFECT IS A WIDER THING THAN A MARKER THAT DRAWS, and `switchboard-export:` is the
// first of those — so the reasoning is here, for the next one rather than for this one. Everything above it
// asks the app to put something on screen; this one asks the app to WRITE A FILE, at a path the marker
// names. `ctx.ui.notify` is reachable by any extension loaded into that Pi session, so any of them can ask
// for that write.
//
// Taken deliberately, and the reason is the attacker rather than the channel: an extension runs unsandboxed
// in Pi's own process with `node:fs` available, so it can already write anywhere this app can, without
// asking us. The marker hands it nothing it did not have. What CANNOT reach this channel is the part that
// would matter — a skill is instructions to the model, and the model can only call tools, neither of which
// can emit a notify. The approval gate does not cover it either, but the gate has never been a security
// boundary and says so.
//
// The next marker that carries a side effect does not inherit this. Ask the same question about it: who can
// emit it, and does that party already have what the marker grants?
//
// THE NEXT ONE IS `switchboard-shell:`, AND IT RUNS A COMMAND LINE. Same two questions, same answer, and
// the answer is the same because the party is the same: only an extension loaded into that Pi session can
// reach `ctx.ui.notify`, and such an extension already runs unsandboxed in Pi's process — it can spawn
// whatever it likes without asking this app. A skill cannot reach it, and neither can the model, which can
// only call tools. So the marker grants nobody anything new.
//
// What IS new is where the line came from, and that is answered in the CORE rather than here. Pi's
// `input` event fires for every turn that reaches the session, and this app writes turns into one from
// places that are not somebody typing — the trigger watcher, a seed prompt, a custom launcher. This file
// cannot tell those apart: it sees a line, not a way in. So `src/app/agent-rpc.js` honours the marker only
// for a line its own composer sent, and that is where the reasoning for it lives.
//
// `/session` IS REGISTERED HERE AND ANSWERED BY THE APP (#643, owner decision W3). Pi's RPC has a
// documented `get_session_stats`, and the reason for reaching for it rather than answering in the handler
// is NOT that the extension API cannot: `ctx.getContextUsage()` and `ctx.sessionManager.getEntries()` are
// both documented, and Pi's own `getSessionStats()` is computed from the latter. Answering here would mean
// re-implementing Pi's accounting — which kinds of entry count as a message, how a cached token is
// booked — in generated TypeScript, against a version of Pi nobody pinned. Two implementations of one
// arithmetic drift, and the one in this file would be the wrong one. So the command asks Pi for Pi's own
// answer, and the handler only says "this was typed".
//
// WHAT REGISTERING THE NAME COSTS: an extension command is dispatched BEFORE prompt templates
// (`AgentSession.prompt` tries `_tryExecuteExtensionCommand` first and returns if it handled the line), so
// a `session` template of the user's own is shadowed by this. That is the same precedence every name in
// `TUI_ONLY` already takes, and it is the price of the command appearing in the app's `/` list at all.
//
// WHICH SIDE ANSWERS A COMMAND IS DECIDED BY WHERE THE ANSWER LIVES, and the four commands added in the
// second half of #643 fall on both sides of that line:
//
//   `/name` and `/reload` are answered HERE, because Pi's extension API holds the whole answer —
//   `pi.setSessionName(name)` and `ctx.reload()`. Asking the app to relay either would be a round trip
//   that ends in the same call.
//   `/export` and `/copy` are answered by the APP, for the same reason `/session` is: the answer is not
//   the runtime's. Where a file the app produced belongs is the app's question, and the clipboard is the
//   machine's, not the session's. Each says only that it was typed.
//
// Measured before any of it was written (Pi 0.85.1): `pi.setSessionName`, `ctx.reload`, `ctx.fork`,
// `ctx.navigateTree` and `ctx.newSession` all exist. An earlier reading of the RPC surface ALONE
// concluded that `/reload` and `/tree` were unreachable, and both conclusions were wrong — the commands
// registered here run against the extension API, which is the wider of the two.
//
// A `!` LINE IS NOT A COMMAND, AND PI'S OWN `input` EVENT IS WHERE IT IS CAUGHT. In Pi's terminal
// interface `!ls` runs a shell line and puts the output into the conversation. Over RPC that prefix means
// nothing: a `/` line is looked up among commands, and everything else — `!ls` included — goes to the
// model as text. `pi.on("input")` fires for a line that arrived over RPC too (measured: `source: "rpc"`),
// and a handler returning `{ action: "handled" }` stops it before skill and template expansion, so the
// model never sees it. The handler says a marker and the app sends Pi's own `bash`, which is the point:
// Pi's shell runs it and Pi books the output into its context, so the next turn sees it. Running it in
// here with `node:child_process` would be a second shell whose output nothing would read.
//
// The `!` grammar therefore lives entirely in this folder — no core branch, nothing in the composer. A
// runtime that spells its shell escape differently, or has none, changes nothing outside its own backend.
//
// `/tree` IS A SURFACE, AND ITS TWO HALVES LIVE ON DIFFERENT SIDES (#646). Reading the tree is Pi's documented
// RPC `get_tree`, so the command only says it was typed and the app asks. MOVING the leaf is not in the RPC
// surface at all: it is `ctx.navigateTree`, so the app asks for it through an internal command of this
// extension (`NAVIGATE_COMMAND`), the way the argument completion already works, and hears back through a
// marked notice — the command is detached, because a move with a summary is a model call and the `prompt`
// response only comes once a handler returns.
//
// Two things the handler does that `navigateTree` does not, both measured on Pi 0.85.1:
//
//   A PLAIN MOVE WRITES NOTHING. Pi only moves its in-memory leaf, and on load it takes the LAST entry in the
//   file as the leaf — so a session closed before its next turn came back on the branch the user had left.
//   The handler therefore appends a `custom` entry (`BRANCH_ENTRY`) whenever the leaf is not already the
//   file's last entry. Pi's context ignores it, the app's parser skips it, and it makes the move durable.
//   `navigateTree`'s own `label` option does the same and was measured too; it was not taken because it
//   puts a label the user never chose into Pi's own tree (owner decisions T4, T7).
//   A USER MESSAGE IS HANDED BACK. Picking one moves the leaf to its PARENT and, in Pi's terminal interface,
//   puts the message into the editor to be rewritten. RPC mode drops that text, so it is read here, before
//   the move, and carried back to the app, which puts it into the input (T8).
//
// `!!` IS REFUSED RATHER THAN QUIETLY TREATED AS `!`. In Pi's terminal interface it means "run it but keep
// the output out of the context", and the RPC `bash` command has no such option (measured: `command` is
// all it takes). Accepting the line and booking the output anyway would break exactly the promise the
// second `!` makes, which is worse than not offering it.
'use strict';

const LINK_PREFIX = 'switchboard-link:';
const ASK_PREFIX = 'switchboard-ask:';
const DISMISS_PREFIX = 'switchboard-dismiss:';
const STATS_PREFIX = 'switchboard-stats:';
const EXPORT_PREFIX = 'switchboard-export:';
const COPY_PREFIX = 'switchboard-copy:';
const SHELL_PREFIX = 'switchboard-shell:';
const TREE_PREFIX = 'switchboard-tree:';
const NAVIGATED_PREFIX = 'switchboard-navigated:';
// The internal command that moves the leaf, and the custom entry that makes a plain move durable (#646).
const NAVIGATE_COMMAND = 'switchboard-navigate';
const BRANCH_ENTRY = 'switchboard-branch';
// How much of a user message comes back for editing. A prompt longer than this is not one somebody retypes.
const DRAFT_CAP = 100000;

// Pi's own names for the levels, in its order (`ThinkingLevel`). A model that offers fewer is clamped by
// Pi, and the command reads back what it got.
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// Above this many models `/model` asks for the provider first — every option is a button on the card.
const MODEL_LIST_MAX = 12;

// What a login message may carry. Pi's own text about a failed login is the actionable part, so it is
// passed on — but held to a line, and never when it could name a local path (#444): an errno error is named
// by its code, and Pi re-wraps some of those without the code ("Failed to read auth.json: EACCES: …, open
// '<the path>'", Pi 0.84.4), so the text is searched for the code as well, and for anything path-shaped.
const MESSAGE_CAP = 300;

// Plain JavaScript, written into the generated file with `toString()` so the tests call this very function.
function describeFailure(err, cap) {
  const FILE_CODES = ['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'EBUSY', 'EROFS', 'EMFILE', 'ENFILE', 'ENOSPC', 'EEXIST', 'ELOOP'];
  // Found in the TEXT only by name, so an ordinary upper-case word before a colon ("ERROR:") is not one.
  const OTHER_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EADDRINUSE',
    'EADDRNOTAVAIL', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPROTO', 'ECANCELED'];
  const message = err && typeof err.message === 'string' ? err.message : '';
  const raw = (message || (err && typeof err !== 'object' ? String(err) : '') || 'unknown error').replace(/\s+/g, ' ').trim();
  const named = err && typeof err.code === 'string' && /^E[A-Z_]+$/.test(err.code) ? err.code : '';
  let found = '';
  const inText = /(?:^|[^A-Za-z])(E[A-Z_]{2,}):/g;
  for (let m = inText.exec(raw); m && !found; m = inText.exec(raw)) {
    if (FILE_CODES.indexOf(m[1]) >= 0 || OTHER_CODES.indexOf(m[1]) >= 0) found = m[1];
  }
  const code = named || found;
  if (code) {
    return FILE_CODES.indexOf(code) >= 0
      ? 'a file could not be read or written (' + code + ').'
      : 'a system or network error (' + code + ').';
  }
  if (/(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|(?:^|[\s'"(=])(?:~|\/(?:Users|home|root|tmp|var|etc|opt|mnt|private|Volumes|srv|data|media))\//.test(raw)) {
    return 'Pi reported an error that names a local path, so it is not repeated here.';
  }
  return raw.length > cap ? raw.slice(0, cap - 1) + '…' : raw;
}

// The rest of Pi's terminal commands (owner decision E5). Typed here they used to reach the model as a
// prompt; now each says where the thing lives instead. The hint names the app's way where there is one.
// Keep it to what is true today: a command that gets built here leaves this list in the same change.
//
// `fork` and `clone` stay on this list DELIBERATELY, and not because they cannot be built: `ctx.fork`
// reaches both. They are refused because of what they would do to the tab. Pi's fork and clone replace
// the session the runtime is on — measured, the session id and the file both change under the running
// process — so the tab the user is looking at would silently become a different session, with the one
// they forked from left on disk with no tab. The sidebar's own Fork already answers this and answers it
// the other way round, by opening the copy in a tab of its own. Two routes that disagree about which
// session the user is left looking at is the one shape worth refusing outright.
const TUI_ONLY = {
  fork: 'Fork the session from its row in the sidebar — it opens the copy in a tab of its own.',
  clone: 'Fork the session from its row in the sidebar; Pi\'s own clone would move this tab onto the copy.',
  share: 'Pi (native) does not offer it yet.',
  new: 'Start a new session from the sidebar.',
  resume: 'Open the session from the sidebar to resume it.',
  trust: 'Trust the project in Switchboard\'s project manager.',
  settings: 'Pi (native)\'s options are in Switchboard\'s settings.',
  hotkeys: 'There are no Pi key bindings without its terminal interface.',
  'scoped-models': 'Choose the model with /model.',
  import: 'Pi (native) does not offer it yet.',
  changelog: 'Pi (native) does not offer it yet.',
  quit: 'Close the session\'s tab to end it.',
};

// The app's autocomplete for these commands' ARGUMENTS (A2). A command of this extension answers what one of
// the commands in ARGUMENT_COMMANDS takes, as a marked notice; the name is hidden from the app's command list.
const COMPLETE_COMMAND = 'switchboard-complete';
const COMPLETIONS_PREFIX = 'switchboard-completions:';
const ARGUMENT_COMMANDS = ['login', 'logout', 'model', 'thinking'];
const COMPLETIONS_CAP = 300;

const UNREACHABLE = 'This version of Pi does not let Switchboard reach its login. Log in once with /login in a '
  + 'Pi terminal session — Pi (native) uses the same login.';

// What a `!!` line is answered with. It names the difference rather than the refusal: what the second `!`
// buys in Pi's terminal interface is unavailable here, so the honest answer is that the output always
// joins the conversation.
const NO_QUIET_SHELL = 'Pi (native) has no quiet shell line: the output of a command always joins the '
  + 'conversation, so the next turn sees it. Use one ! instead.';

// The generated section. Plain strings joined by newlines, like the command bridge: no template literal, so a
// backtick or a `${` in here cannot end or interpolate anything, and no backslash has to survive two
// languages.
function commandsSource() {
  return [
    describeFailure.toString(),
    '',
    'function registerSessionCommands(pi: any) {',
    `  const LINK = ${JSON.stringify(LINK_PREFIX)};`,
    `  const ASK = ${JSON.stringify(ASK_PREFIX)};`,
    `  const DISMISS = ${JSON.stringify(DISMISS_PREFIX)};`,
    `  const STATS = ${JSON.stringify(STATS_PREFIX)};`,
    `  const EXPORT = ${JSON.stringify(EXPORT_PREFIX)};`,
    `  const COPY = ${JSON.stringify(COPY_PREFIX)};`,
    `  const SHELL = ${JSON.stringify(SHELL_PREFIX)};`,
    `  const TREE = ${JSON.stringify(TREE_PREFIX)};`,
    `  const NAVIGATED = ${JSON.stringify(NAVIGATED_PREFIX)};`,
    `  const BRANCH_ENTRY = ${JSON.stringify(BRANCH_ENTRY)};`,
    `  const DRAFT_CAP = ${DRAFT_CAP};`,
    `  const NO_QUIET_SHELL = ${JSON.stringify(NO_QUIET_SHELL)};`,
    `  const LEVELS: string[] = ${JSON.stringify(THINKING_LEVELS)};`,
    `  const MODEL_LIST_MAX = ${MODEL_LIST_MAX};`,
    `  const CAP = ${MESSAGE_CAP};`,
    `  const UNREACHABLE = ${JSON.stringify(UNREACHABLE)};`,
    `  const TUI_ONLY: any = ${JSON.stringify(TUI_ONLY)};`,
    '  let tokens = 0;',
    '  const say = (ctx: any, text: string, level: string) => { try { ctx.ui.notify(text, level || "info"); } catch {} };',
    '  const sayLink = (ctx: any, text: string, url: string, label: string) =>',
    '    say(ctx, LINK + JSON.stringify({ text: String(text || ""), url: String(url || ""), label: String(label || "") }), "info");',
    '  const failure = (err: any) => describeFailure(err, CAP);',
    '  const runtimeOf = (ctx: any) => {',
    '    const r: any = ctx && ctx.modelRegistry && ctx.modelRegistry.runtime;',
    '    return r && typeof r.login === "function" && typeof r.logout === "function" && typeof r.getProviders === "function" ? r : null;',
    '  };',
    '  const cancelled = () => new Error("Login cancelled");',
    // Pi answers the `prompt` RPC command only once a command's handler has returned (measured), and the app
    // gives up on an answer after a few seconds. A command that waits on a question — a login waits minutes —
    // therefore runs on its own, and the handler returns at once.
    '  const detached = (run: (args: string, ctx: any) => Promise<void>) => async (args: string, ctx: any) => {',
    '    run(args, ctx).catch((err: any) => say(ctx, "The command failed: " + failure(err), "error"));',
    '  };',
    '  const isCancel = (err: any) => !!err && (String(err.message) === "Login cancelled" || err.name === "AbortError");',
    // Every question goes out marked (ASK_PREFIX). When Pi takes one back through its signal, RPC mode says
    // nothing to the client, so the command says it (DISMISS_PREFIX) and the card is closed.
    '  const question = async (ctx: any, method: string, title: string, arg: any, secret: boolean, signal?: any): Promise<any> => {',
    '    const token = "t" + (++tokens);',
    '    const onAbort = () => say(ctx, DISMISS + JSON.stringify({ token }), "info");',
    '    if (signal) signal.addEventListener("abort", onAbort, { once: true });',
    '    const marked = ASK + JSON.stringify({ title: String(title || ""), secret: !!secret, token });',
    '    let value: any;',
    '    try {',
    '      value = method === "select"',
    '        ? await ctx.ui.select(marked, arg, signal ? { signal } : undefined)',
    '        : await ctx.ui.input(marked, String(arg || ""), signal ? { signal } : undefined);',
    '    } catch { value = undefined; }',
    '    finally { if (signal) signal.removeEventListener("abort", onAbort); }',
    '    return signal && signal.aborted ? undefined : value;',
    '  };',
    // A choice by label, answered as an index; anything that is not one of the labels is "no choice".
    '  const pick = async (ctx: any, title: string, labels: string[], signal?: any): Promise<number> => {',
    '    const choice = await question(ctx, "select", title, labels, false, signal);',
    '    return typeof choice === "string" ? labels.indexOf(choice) : -1;',
    '  };',
    // Pi's login asks through `prompt`: a select answers the option's id, anything else a string. A rejection
    // is how the flow is told the user backed out.
    '  const ask = async (ctx: any, p: any): Promise<string> => {',
    '    if (!p || (p.signal && p.signal.aborted)) throw cancelled();',
    '    if (p.type === "select") {',
    '      const opts: any[] = Array.isArray(p.options) ? p.options : [];',
    '      const labels = opts.map((o: any) => String(o.label || o.id) + (o.description ? " — " + o.description : ""));',
    '      const i = await pick(ctx, String(p.message || "Choose one"), labels, p.signal);',
    '      if (i < 0) throw cancelled();',
    '      return String(opts[i].id);',
    '    }',
    '    const value = await question(ctx, "input", String(p.message || ""), p.placeholder, p.type === "secret", p.signal);',
    '    if ((p.signal && p.signal.aborted) || typeof value !== "string" || !value.trim()) throw cancelled();',
    '    return value.trim();',
    '  };',
    // Pi's login reports through `notify`: a page to open, a device code, a line of progress.
    '  const tell = (ctx: any, e: any) => {',
    '    if (!e) return;',
    '    if (e.type === "auth_url") sayLink(ctx, e.instructions || "Log in in your browser.", e.url, "Open the login page");',
    '    else if (e.type === "device_code") sayLink(ctx, "Enter the code " + String(e.userCode || "") + " on the verification page.", e.verificationUri, "Open the verification page");',
    '    else if (e.type === "info" && Array.isArray(e.links) && e.links.length) {',
    '      e.links.forEach((l: any, i: number) => sayLink(ctx, i === 0 ? e.message : "", l && l.url, (l && l.label) || "Open the page"));',
    '    } else if (e.message) say(ctx, String(e.message), "info");',
    '  };',
    '',
    '  pi.registerCommand("login", {',
    '    description: "Log in to a model provider, with a subscription or an API key",',
    '    handler: detached(async (args: string, ctx: any) => {',
    '      const rt = runtimeOf(ctx);',
    '      if (!rt) { say(ctx, UNREACHABLE, "error"); return; }',
    '      let providers: any[] = [];',
    '      try { providers = (rt.getProviders() || []).filter((p: any) => p && p.auth && (p.auth.oauth || p.auth.apiKey)); } catch {}',
    '      const ref = String(args || "").trim().toLowerCase();',
    '      if (ref) {',
    '        providers = providers.filter((p: any) => String(p.id).toLowerCase() === ref || String(p.name || "").toLowerCase() === ref);',
    '        if (!providers.length) { say(ctx, "Pi knows no provider called " + ref + ". Type /login to choose one.", "warning"); return; }',
    '      }',
    '      if (!providers.length) { say(ctx, "Pi offers no provider to log in to.", "warning"); return; }',
    '      const both = (p: any) => !!(p.auth.oauth && p.auth.apiKey);',
    '      let method = "";',
    '      if (providers.length > 1 || both(providers[0])) {',
    '        const m = await pick(ctx, "Log in how?", ["With a subscription (in the browser)", "With an API key"]);',
    '        if (m < 0) return;',
    '        method = m === 0 ? "oauth" : "api_key";',
    '        providers = providers.filter((p: any) => (method === "oauth" ? p.auth.oauth : p.auth.apiKey));',
    '        if (!providers.length) { say(ctx, "That provider offers no " + (method === "oauth" ? "subscription login." : "API key login."), "warning"); return; }',
    '      } else method = providers[0].auth.oauth ? "oauth" : "api_key";',
    '      let provider = providers[0];',
    '      if (providers.length > 1) {',
    '        const status = (p: any) => { try { return rt.hasConfiguredAuth(p.id) ? " — logged in" : ""; } catch { return ""; } };',
    '        const i = await pick(ctx, "Log in to which provider?", providers.map((p: any) => String(p.name || p.id) + status(p)));',
    '        if (i < 0) return;',
    '        provider = providers[i];',
    '      }',
    '      const name = String(provider.name || provider.id);',
    '      try {',
    '        await rt.login(provider.id, method, { prompt: (p: any) => ask(ctx, p), notify: (e: any) => tell(ctx, e) });',
    '      } catch (err: any) {',
    '        if (isCancel(err)) say(ctx, "Login to " + name + " cancelled.", "info");',
    '        else say(ctx, "Login to " + name + " failed: " + failure(err), "error");',
    '        return;',
    '      }',
    '      say(ctx, (method === "oauth" ? "Logged in to " : "Saved the API key for ") + name + ". Type /model to switch to one of its models.", "info");',
    '    }),',
    '  });',
    '',
    '  pi.registerCommand("logout", {',
    '    description: "Remove a login or an API key that /login saved",',
    '    handler: detached(async (args: string, ctx: any) => {',
    '      const rt = runtimeOf(ctx);',
    '      if (!rt || typeof rt.listCredentials !== "function") { say(ctx, UNREACHABLE, "error"); return; }',
    '      let creds: any[] = [];',
    '      try { creds = [...(await rt.listCredentials({ signal: AbortSignal.timeout(15000) }))]; }',
    '      catch (err: any) { say(ctx, "Could not read the saved logins: " + failure(err), "error"); return; }',
    '      const nameOf = (c: any) => { let p: any = null; try { p = rt.getProvider(c.providerId); } catch {} return String((p && p.name) || c.providerId); };',
    '      const ref = String(args || "").trim().toLowerCase();',
    '      if (ref) creds = creds.filter((c: any) => String(c.providerId).toLowerCase() === ref || nameOf(c).toLowerCase() === ref);',
    '      if (!creds.length) {',
    '        say(ctx, ref ? "No saved login for " + ref + "." : "Nothing to log out of: /logout removes only what /login saved. Environment variables and models.json are unchanged.", "info");',
    '        return;',
    '      }',
    '      let cred = creds[0];',
    '      if (creds.length > 1) {',
    '        const i = await pick(ctx, "Log out of which provider?", creds.map((c: any) => nameOf(c) + (c.type === "oauth" ? " (subscription)" : " (API key)")));',
    '        if (i < 0) return;',
    '        cred = creds[i];',
    '      }',
    '      const name = nameOf(cred);',
    '      try { await rt.logout(cred.providerId, { signal: AbortSignal.timeout(15000) }); }',
    '      catch (err: any) { say(ctx, "Logout from " + name + " failed: " + failure(err), "error"); return; }',
    '      say(ctx, cred.type === "oauth" ? "Logged out of " + name + "." : "Removed the saved API key for " + name + ". Environment variables and models.json are unchanged.", "info");',
    '    }),',
    '  });',
    '',
    // Session-only, as in Pi's own `/model`: the switch is written into the transcript, never into Pi's
    // settings, so the model the app launches with stays the app's setting.
    '  pi.registerCommand("model", {',
    '    description: "Switch the model this session uses",',
    '    handler: detached(async (args: string, ctx: any) => {',
    '      let models: any[] = [];',
    '      try { models = (ctx.modelRegistry.getAvailable() || []).slice(); } catch {}',
    '      if (!models.length) { say(ctx, "No model is available. Log in to a provider first with /login.", "warning"); return; }',
    '      const key = (m: any) => String(m.provider) + "/" + String(m.id);',
    '      const current = ctx.model ? key(ctx.model) : "";',
    '      const ref = String(args || "").trim().toLowerCase();',
    '      let chosen: any = null;',
    '      if (ref) {',
    '        let hits = models.filter((m: any) => key(m).toLowerCase() === ref);',
    '        if (!hits.length) hits = models.filter((m: any) => String(m.id).toLowerCase() === ref);',
    '        if (!hits.length) hits = models.filter((m: any) => key(m).toLowerCase().includes(ref) || String(m.name || "").toLowerCase().includes(ref));',
    '        if (!hits.length) { say(ctx, "No available model matches " + ref + ". Type /model to choose one.", "warning"); return; }',
    '        if (hits.length === 1) chosen = hits[0]; else models = hits;',
    '      }',
    '      if (!chosen) {',
    '        let list = models;',
    '        if (list.length > MODEL_LIST_MAX) {',
    '          const providers = [...new Set(list.map((m: any) => String(m.provider)))];',
    '          if (providers.length > 1) {',
    '            const mine = ctx.model ? String(ctx.model.provider) : "";',
    '            const i = await pick(ctx, "Models of which provider?", providers.map((p: string) => p + (p === mine ? " (current)" : "")));',
    '            if (i < 0) return;',
    '            list = list.filter((m: any) => String(m.provider) === providers[i]);',
    '          }',
    '        }',
    '        const i = await pick(ctx, "Switch to which model?", list.map((m: any) => key(m) + (key(m) === current ? " (current)" : "")));',
    '        if (i < 0) return;',
    '        chosen = list[i];',
    '      }',
    '      if (key(chosen) === current) { say(ctx, "The session already uses " + current + ".", "info"); return; }',
    '      let ok = false;',
    '      try { ok = await pi.setModel(chosen); } catch (err: any) { say(ctx, "Switching the model failed: " + failure(err), "error"); return; }',
    '      if (!ok) { say(ctx, "Pi has no login for " + String(chosen.provider) + ". Log in with /login first.", "warning"); return; }',
    '      let level = ""; try { level = String(pi.getThinkingLevel() || ""); } catch {}',
    '      say(ctx, "Model: " + key(chosen) + (level ? " · thinking: " + level : "") + ".", "info");',
    '    }),',
    '  });',
    '',
    '  pi.registerCommand("thinking", {',
    '    description: "Set how much the model thinks: " + LEVELS.join(", "),',
    '    handler: detached(async (args: string, ctx: any) => {',
    '      let now = ""; try { now = String(pi.getThinkingLevel() || ""); } catch {}',
    '      let level = String(args || "").trim().toLowerCase();',
    '      if (level && !LEVELS.includes(level)) { say(ctx, "Unknown thinking level " + level + ". Choose one of: " + LEVELS.join(", ") + ".", "warning"); return; }',
    '      if (!level) {',
    '        const i = await pick(ctx, "How much should the model think?", LEVELS.map((l: string) => l + (l === now ? " (current)" : "")));',
    '        if (i < 0) return;',
    '        level = LEVELS[i];',
    '      }',
    '      try { pi.setThinkingLevel(level); } catch (err: any) { say(ctx, "Setting the thinking level failed: " + failure(err), "error"); return; }',
    '      let got = level; try { got = String(pi.getThinkingLevel() || level); } catch {}',
    '      say(ctx, got === level ? "Thinking: " + got + "." : "Thinking: " + got + " — the model does not offer " + level + ".", "info");',
    '    }),',
    '  });',
    '',
    // What compaction says about itself arrives as Pi's own `compaction_start` / `compaction_end` events,
    // which `./rpc-protocol.js` already draws — so this adds no notice of its own on the way through.
    '  pi.registerCommand("compact", {',
    '    description: "Summarise the conversation so far to free up context; anything after the command guides the summary",',
    '    handler: detached(async (args: string, ctx: any) => {',
    '      if (!ctx || typeof ctx.compact !== "function") { say(ctx, "This version of Pi cannot compact from Pi (native).", "error"); return; }',
    '      if (typeof ctx.isIdle === "function" && !ctx.isIdle()) { say(ctx, "Wait for the current turn to finish before compacting.", "warning"); return; }',
    '      const instructions = String(args || "").trim();',
    '      try { ctx.compact(instructions ? { customInstructions: instructions } : {}); }',
    '      catch (err: any) { say(ctx, "Compaction failed: " + failure(err), "error"); }',
    '    }),',
    '  });',
    '',
    // W3: registered here so the name is Pi's to resolve and the app's `/` list picks it up like any
    // other, answered by the app, which asks Pi for Pi's own figures. The handler says only that it was
    // typed; it never sees a number. Like every name registered here, it shadows a template of that name.
    '  pi.registerCommand("session", {',
    '    description: "Show this session\'s messages, tokens and cost, as Pi counts them",',
    '    handler: async (_args: string, ctx: any) => say(ctx, STATS, "info"),',
    '  });',
    '',
    // Same shape as `/session`, for the same reason: the runtime can write the file, but only the app
    // knows where a file it produced belongs, so the marker carries what was typed and nothing else.
    '  pi.registerCommand("export", {',
    '    description: "Write this session to an HTML file; anything after the command is the file to write",',
    '    handler: async (args: string, ctx: any) =>',
    '      say(ctx, EXPORT + JSON.stringify({ args: String(args || "").trim() }), "info"),',
    '  });',
    '',
    // The clipboard belongs to the machine, not to the session, so the app does the copying. What is
    // copied is still the runtime's answer — the app asks for it over the protocol.
    '  pi.registerCommand("copy", {',
    '    description: "Copy the agent\'s last reply to the clipboard",',
    '    handler: async (_args: string, ctx: any) => say(ctx, COPY, "info"),',
    '  });',
    '',
    // Answered here: `pi.setSessionName` IS the whole answer. Pi writes the name into the session file,
    // and Pi's own parser reads it back as the row's title (`../pi/parser.js`), so the sidebar follows
    // without the app writing a second name of its own — there is one name, not two.
    '  pi.registerCommand("name", {',
    '    description: "Give this session a name; anything after the command is the name",',
    '    handler: detached(async (args: string, ctx: any) => {',
    '      if (typeof pi.setSessionName !== "function") { say(ctx, "This version of Pi cannot name a session from Pi (native).", "error"); return; }',
    '      let name = String(args || "").trim();',
    '      if (!name) {',
    '        const typed = await question(ctx, "input", "What should this session be called?", "", false);',
    '        name = typeof typed === "string" ? typed.trim() : "";',
    '      }',
    '      if (!name) return;',
    '      try { pi.setSessionName(name); }',
    '      catch (err: any) { say(ctx, "Naming the session failed: " + failure(err), "error"); return; }',
    '      say(ctx, "Session name: " + name + ". Switchboard\'s sidebar follows it once Pi has written it out.", "info");',
    '    }),',
    '  });',
    '',
    // Answered here too, and it is terminal for its own handler: Pi tears this extension instance down
    // and builds a new one, so anything said AFTER the await runs from the version being replaced. The
    // notice therefore goes out first and nothing follows the call.
    //
    // Two consequences that are not bugs and should not be "fixed": every "Allow for this session"
    // granted to the approval gate is forgotten, because that set lives in the instance Pi has just
    // replaced — the resources were reloaded, so asking again is the honest answer. And the app's `/`
    // list is briefly stale; it is re-read within the composer's own reuse window, so nothing here has
    // to tell it.
    '  pi.registerCommand("reload", {',
    '    description: "Reload Pi\'s extensions, skills, prompt templates and context files",',
    '    handler: detached(async (_args: string, ctx: any) => {',
    '      if (!ctx || typeof ctx.reload !== "function") { say(ctx, "This version of Pi cannot reload its resources from Pi (native).", "error"); return; }',
    '      say(ctx, "Reloading Pi\'s extensions, skills, prompt templates and context files…", "info");',
    '      await ctx.reload();',
    '    }),',
    '  });',
    '',
    // A `!` line, caught in Pi's own input event — the header says why it is here and not a command.
    // The handler answers at once: the app sends the shell line itself, so there is nothing to await.
    '  pi.on("input", async (event: any, ctx: any) => {',
    '    const text = String((event && event.text) || "");',
    '    if (text.charAt(0) !== "!") return { action: "continue" };',
    '    if (text.charAt(1) === "!") { say(ctx, NO_QUIET_SHELL, "warning"); return { action: "handled" }; }',
    '    const command = text.slice(1).trim();',
    // A lone `!` is somebody starting to type, not an empty command: it stays what it was.
    '    if (!command) return { action: "continue" };',
    '    say(ctx, SHELL + JSON.stringify({ command }), "info");',
    '    return { action: "handled" };',
    '  });',
    '',
    // #646. Opening the tree is refused while a turn runs, like /compact: the conversation is moving under
    // it, and the move it exists for is refused then anyway.
    '  pi.registerCommand("tree", {',
    '    description: "Walk this session\'s branches and switch it to another point",',
    '    handler: async (_args: string, ctx: any) => {',
    '      if (ctx && typeof ctx.isIdle === "function" && !ctx.isIdle()) { say(ctx, "Wait for the current turn to finish before opening the branch tree.", "warning"); return; }',
    '      say(ctx, TREE, "info");',
    '    },',
    '  });',
    '',
    // The move. Internal (hidden from the app's list), asked for by the app with the point the user
    // picked; the header says why it is detached and what it adds to Pi's own move.
    `  pi.registerCommand(${JSON.stringify(NAVIGATE_COMMAND)}, {`,
    '    description: "Switchboard\'s branch switch (internal)",',
    '    handler: detached(async (args: string, ctx: any) => {',
    '      let req: any = null;',
    '      try { req = JSON.parse(String(args || "")); } catch { return; }',
    '      if (!req || typeof req.token !== "string" || typeof req.target !== "string" || !req.target) return;',
    '      const done = (o: any) => say(ctx, NAVIGATED + JSON.stringify(Object.assign({ token: req.token }, o)), "info");',
    '      if (!ctx || typeof ctx.navigateTree !== "function") { done({ ok: false, error: "This version of Pi cannot switch branches from Pi (native)." }); return; }',
    '      if (typeof ctx.isIdle === "function" && !ctx.isIdle()) { done({ ok: false, error: "Wait for the current turn to finish before switching branches." }); return; }',
    '      const sm: any = ctx.sessionManager;',
    '      let entry: any = null;',
    '      try { entry = sm.getEntry(req.target); } catch {}',
    '      if (!entry) { done({ ok: false, error: "That point is no longer in the session." }); return; }',
    '      const textOf = (c: any) => typeof c === "string" ? c : (Array.isArray(c) ? c.map((b: any) => (b && b.type === "text" && typeof b.text === "string" ? b.text : "")).join("") : "");',
    '      let draft = "";',
    '      if (entry.type === "message" && entry.message && entry.message.role === "user") draft = textOf(entry.message.content);',
    '      else if (entry.type === "custom_message") draft = textOf(entry.content);',
    '      let r: any = null;',
    '      try { r = await ctx.navigateTree(req.target, { summarize: req.summarize === true }); }',
    '      catch (err: any) { done({ ok: false, error: "Switching failed: " + failure(err) }); return; }',
    '      if (r && r.cancelled) { done({ ok: false, cancelled: true }); return; }',
    '      let summarized = false;',
    '      try {',
    '        const all: any[] = sm.getEntries() || [];',
    '        const last: any = all.length ? all[all.length - 1] : null;',
    '        const leaf = sm.getLeafId();',
    '        summarized = !!(last && last.id === leaf && last.type === "branch_summary");',
    '        if (!last || last.id !== leaf) pi.appendEntry(BRANCH_ENTRY, { target: req.target });',
    '      } catch {}',
    '      done({ ok: true, summarized, draft: draft.slice(0, DRAFT_CAP) });',
    '    }),',
    '  });',
    '',
    '  for (const name of Object.keys(TUI_ONLY)) {',
    '    pi.registerCommand(name, {',
    '      description: "A command of Pi\'s terminal interface",',
    '      handler: async (_args: string, ctx: any) => say(ctx, "/" + name + " is a command of Pi\'s terminal interface. " + TUI_ONLY[name], "info"),',
    '    });',
    '  }',
    '',
    // What the commands above take as an argument, for the app's autocomplete. Pi's own
    // `getArgumentCompletions` is read only by its terminal interface; RPC has no command for it, so the app
    // asks through a command of this extension and the answer comes back as a marked notice, before the
    // `prompt` response (the handler says it, then returns).
    '  const argumentsOf: any = {',
    '    login: async (ctx: any) => {',
    '      const rt = runtimeOf(ctx);',
    '      if (!rt) return [];',
    '      const on = (id: string) => { try { return rt.hasConfiguredAuth(id); } catch { return false; } };',
    '      return (rt.getProviders() || []).filter((p: any) => p && p.auth && (p.auth.oauth || p.auth.apiKey))',
    '        .map((p: any) => ({ value: String(p.id), description: String(p.name || p.id) + (on(p.id) ? " — logged in" : "") }));',
    '    },',
    '    logout: async (ctx: any) => {',
    '      const rt = runtimeOf(ctx);',
    '      if (!rt || typeof rt.listCredentials !== "function") return [];',
    '      const creds: any[] = [...(await rt.listCredentials({ signal: AbortSignal.timeout(5000) }))];',
    '      return creds.map((c: any) => ({ value: String(c.providerId), description: c.type === "oauth" ? "subscription" : "API key" }));',
    '    },',
    '    model: async (ctx: any) => {',
    '      const current = ctx.model ? String(ctx.model.provider) + "/" + String(ctx.model.id) : "";',
    '      return (ctx.modelRegistry.getAvailable() || []).map((m: any) => {',
    '        const value = String(m.provider) + "/" + String(m.id);',
    '        return { value, description: String(m.name || m.id) + (value === current ? " (current)" : "") };',
    '      });',
    '    },',
    '    thinking: async () => {',
    '      let now = ""; try { now = String(pi.getThinkingLevel() || ""); } catch {}',
    '      return LEVELS.map((l: string) => ({ value: l, description: l === now ? "current" : "" }));',
    '    },',
    '  };',
    `  pi.registerCommand(${JSON.stringify(COMPLETE_COMMAND)}, {`,
    '    description: "Switchboard\'s autocomplete for these commands\' arguments (internal)",',
    '    handler: async (args: string, ctx: any) => {',
    '      let req: any = null;',
    '      try { req = JSON.parse(String(args || "")); } catch { return; }',
    '      if (!req || typeof req.token !== "string") return;',
    '      let items: any[] = [];',
    '      const of = argumentsOf[String(req.command || "")];',
    '      if (typeof of === "function") { try { items = (await of(ctx)) || []; } catch { items = []; } }',
    `      say(ctx, ${JSON.stringify(COMPLETIONS_PREFIX)} + JSON.stringify({ token: req.token, items: items.slice(0, ${COMPLETIONS_CAP}) }), "info");`,
    '    },',
    '  });',
    '}',
  ].join('\n');
}

// A notice carrying the answer to one completion request: `{ token, items }`, else null. Items are
// `{ value, description }`, both plain text.
function parseCompletions(message) {
  const s = String(message == null ? '' : message);
  if (!s.startsWith(COMPLETIONS_PREFIX)) return null;
  try {
    const v = JSON.parse(s.slice(COMPLETIONS_PREFIX.length));
    if (!v || typeof v.token !== 'string' || !Array.isArray(v.items)) return null;
    const items = v.items
      .filter(i => i && typeof i.value === 'string' && i.value)
      .slice(0, COMPLETIONS_CAP)
      .map(i => ({ value: i.value, description: typeof i.description === 'string' ? i.description : '' }));
    return { token: v.token, items };
  } catch { return null; }
}

// What a notice's text says, if it is one of ours with a page to open: `{ text, url, label }`, else null.
// Only an http(s) page gets a URL — the button hands it to the OS browser; any other address is left out and
// the text stands alone, rather than the marker being shown as it was written.
function parseLink(message) {
  const s = String(message == null ? '' : message);
  if (!s.startsWith(LINK_PREFIX)) return null;
  let v = null;
  try { v = JSON.parse(s.slice(LINK_PREFIX.length)); } catch { v = null; }
  if (!v || typeof v !== 'object') return { text: '', url: null, label: '' };
  return {
    text: typeof v.text === 'string' ? v.text : '',
    url: typeof v.url === 'string' && /^https?:\/\//i.test(v.url) ? v.url : null,
    label: typeof v.label === 'string' && v.label.trim() ? v.label.trim().slice(0, 80) : 'Open the page',
  };
}

// A question's title, if one of these commands asked it: `{ title, secret, token }`, else null.
function parseAskTitle(title) {
  const s = String(title == null ? '' : title);
  if (!s.startsWith(ASK_PREFIX)) return null;
  try {
    const v = JSON.parse(s.slice(ASK_PREFIX.length));
    if (!v || typeof v.token !== 'string' || !v.token) return null;
    return { title: typeof v.title === 'string' ? v.title : '', secret: v.secret === true, token: v.token };
  } catch { return null; }
}

// Was this notice `/session` being typed? The marker carries nothing: the app asks Pi for the figures
// itself, over the RPC command that has them (`statsCommand` in `./rpc-protocol.js`).
function parseStats(message) {
  return String(message == null ? '' : message).startsWith(STATS_PREFIX);
}

// `/export` being typed, and what was typed after it: `{ args }`, else null. `args` is a file the user
// named and may be anything they typed — the app decides what to do with it, and an empty one means they
// named none. Capped, because it becomes part of a path: a name of unbounded length is not one.
const EXPORT_ARGS_CAP = 1024;
function parseExport(message) {
  const s = String(message == null ? '' : message);
  if (!s.startsWith(EXPORT_PREFIX)) return null;
  try {
    const v = JSON.parse(s.slice(EXPORT_PREFIX.length));
    if (!v || typeof v !== 'object') return { args: '' };
    return { args: typeof v.args === 'string' ? v.args.trim().slice(0, EXPORT_ARGS_CAP) : '' };
  } catch { return { args: '' }; }
}

// `/copy` being typed. It carries nothing: what to copy is asked for over the protocol, and the copying
// is the app's.
function parseCopy(message) {
  return String(message == null ? '' : message).startsWith(COPY_PREFIX);
}

// A `!` line: `{ command }`, else null. The command is whatever stood after the `!`, capped because it
// goes onto a command line — a line of unbounded length is not one somebody typed on purpose.
const SHELL_COMMAND_CAP = 8192;
function parseShell(message) {
  const s = String(message == null ? '' : message);
  if (!s.startsWith(SHELL_PREFIX)) return null;
  try {
    const v = JSON.parse(s.slice(SHELL_PREFIX.length));
    const command = v && typeof v.command === 'string' ? v.command.trim() : '';
    return command ? { command: command.slice(0, SHELL_COMMAND_CAP) } : null;
  } catch { return null; }
}

// Was this notice `/tree` being typed? It carries nothing: the app asks for the tree over RPC.
function parseTree(message) {
  return String(message == null ? '' : message).startsWith(TREE_PREFIX);
}

// What the move command did: `{ token, ok, cancelled, error, summarized, draft }`, else null. `draft` is a
// user message handed back for editing; `error` is the handler's own sentence.
function parseNavigated(message) {
  const s = String(message == null ? '' : message);
  if (!s.startsWith(NAVIGATED_PREFIX)) return null;
  try {
    const v = JSON.parse(s.slice(NAVIGATED_PREFIX.length));
    if (!v || typeof v.token !== 'string' || !v.token) return null;
    return {
      token: v.token,
      ok: v.ok === true,
      cancelled: v.cancelled === true,
      error: typeof v.error === 'string' ? v.error.slice(0, MESSAGE_CAP) : '',
      summarized: v.summarized === true,
      draft: typeof v.draft === 'string' ? v.draft.slice(0, DRAFT_CAP) : '',
    };
  } catch { return null; }
}

// A notice saying Pi stopped waiting on one of these questions: its token, else null.
function parseDismiss(message) {
  const s = String(message == null ? '' : message);
  if (!s.startsWith(DISMISS_PREFIX)) return null;
  try {
    const v = JSON.parse(s.slice(DISMISS_PREFIX.length));
    return v && typeof v.token === 'string' && v.token ? v.token : null;
  } catch { return null; }
}

module.exports = {
  LINK_PREFIX, ASK_PREFIX, DISMISS_PREFIX, STATS_PREFIX, EXPORT_PREFIX, COPY_PREFIX, SHELL_PREFIX,
  THINKING_LEVELS, TUI_ONLY, MESSAGE_CAP, NO_QUIET_SHELL,
  COMPLETE_COMMAND, COMPLETIONS_PREFIX, ARGUMENT_COMMANDS,
  commandsSource, describeFailure, parseLink, parseAskTitle, parseDismiss, parseCompletions, parseStats,
  parseExport, parseCopy, parseShell, parseTree, parseNavigated,
  TREE_PREFIX, NAVIGATED_PREFIX, NAVIGATE_COMMAND, BRANCH_ENTRY, DRAFT_CAP,
};
