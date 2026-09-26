// backends/pi/subagent-tool.js — a `subagent` tool for a Pi session, passed per spawn (#634).
//
// Pi has no nested agents and says so: sub-agents are an intentional omission in its own `docs/usage.md`.
// What it ships is an EXAMPLE extension (`examples/extensions/subagent/`, MIT) that registers a
// `subagent` tool and runs one fresh `pi` process per task. It is not installed and not enabled; its
// README tells you to link it into `~/.pi/agent/extensions/` by hand. This file writes a lean extension
// of our own in that example's shape, for one spawn, under the app's own data directory — the same route
// as `live-binding.js` and `prompt-templates.js`, so a Pi run this app did not start is unaffected.
//
// **A section, not a file of its own** (#632, owner decision O5). What is written per spawn is ONE resources
// extension (`./resources-extension.js`) that also carries another CLI's commands; this module supplies the
// tool's part of it (`subagentSection` + `IMPORTS`). `extensionSource` still builds the tool on its own, for
// the tests and for reading.
//
// **Ours, not a copy.** The example is 1,200 lines of TypeScript with three shapes (single, parallel,
// chain), a custom TUI renderer on `pi-tui`, and a `typebox` schema. The MVP is ONE task at a time, and
// the two other shapes are where getting it wrong costs money. What is kept is the part that was measured
// to work, read out of Pi 0.84.4's example rather than guessed:
//
//   - the child runs `pi --mode json -p --no-session`: JSON events on stdout, one prompt, and NO session
//     file — so the scan never finds a child and the sidebar never shows one. The child is visible only as
//     the tool call in its parent.
//   - an agent's body goes to the child through `--append-system-prompt <temp file>`, its `tools` through
//     `--tools`, and its `model` through `--model` — resolved first, for Pi's own agents as for taken-over
//     ones, because Pi's own fallback matches a name across every provider (#639, #641); an agent that names
//     no model inherits the parent's model and thinking level.
//   - the child is started as `process.execPath` + `process.argv[1]` — the node and the Pi script running
//     the parent — so no shell and no npm shim is involved, which matters on Windows. (The example's last
//     fallback, a bare `pi` without a shell, is kept for a runtime that is neither; it cannot start an npm
//     shim, and nothing this app launches reaches it.)
//   - the parent's `--approve` / `--no-approve` / `--offline` / `--no-context-files` are copied onto the
//     child, so a run the user told not to trust the project does not trust it one process down.
//   - usage is summed from the child's `message_end` events (`usage.cost.total` per assistant message).
//
// What this costs against the example: Pi's TUI draws the call with its generic tool rendering rather
// than the example's own. The cost of the child still shows, because it is written INTO the result text
// (one line: turns, tokens, cost, model) — the issue's first condition was that a session which quietly
// multiplies its spend must not be able to, and a line in the result is visible in Pi's TUI and in the
// app's conversation view alike without either of them knowing this tool.
//
// **The tool parameters are plain JSON Schema, not `typebox`.** Pi 0.84.4's `validateToolArguments`
// (`pi-ai/dist/utils/validation.js`) takes a schema without TypeBox's `Kind` symbol through a JSON-Schema
// branch, so the extension needs no import beyond Node's own and Pi's `getAgentDir` / `parseFrontmatter`.
//
// **What the parent's teardown reaches.** The child is spawned attached, so it sits in the parent's
// process tree, and the app's stop and quit take that tree (`taskkill /T`). The tool also stops the child
// when the run is aborted — on Windows by tree as well, since a child Pi has tool processes of its own.
// A Pi that crashes without running its handlers leaves a `-p` child to finish its one task and exit.
//
// **A name collision with the example.** A user who linked Pi's example into their extensions directory
// has a `subagent` tool already; Pi reports the second registration as a conflict (`resource-loader.js`,
// `detectExtensionConflicts`), keeps both extensions loaded and lets load order decide. That is Pi's own
// rule and it is left alone; the settings reference tells the user to switch one of them off.
'use strict';

const os = require('os');
const path = require('path');

// The splitter for a frontmatter tool list — commas, but not inside parentheses (`Tool(a, b)`).
// The command bridge reads `allowed-tools` with it; an agent's `tools` line has the same shape.
const { permissionEntries } = require('./command-bridge');

// The options this module reads — HERE and nowhere else, so the core names neither key (reflex 5). Both
// are on the `backendDefaults.pi` cascade; `subagentTool` is OFF unless somebody switched it on, because a
// tool that starts model sessions nobody typed is not something to switch on for anyone.
const OPTION_ID = 'subagentTool';
// The registry symbol the generated extension publishes its agent description under, for the runtime-driven
// backend's approval gate (`../pi-native/runtime-extension.js`), which reads the key from here.
const DESCRIBE_KEY = 'switchboard.subagent.describe';
const DIR_OPTION_ID = 'subagentAgentsDir';

// The child's answer, capped the way the example caps a parallel task's: a child that dumps a large file
// back would otherwise fill the parent's context with it.
const OUTPUT_CAP = 50 * 1024;

// A `~` at the front means the user's home, which is how anyone types a path into a settings field. The
// rest is left as typed: an absolute path stays absolute, and a relative one is resolved against the
// session's working directory by the extension itself, where that directory is known.
function agentsDirFrom(options) {
  const raw = String((options && options[DIR_OPTION_ID]) || '').trim();
  if (!raw) return '';
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

// ── Another CLI's agents (#639) ────────────────────────────────────────────────────────────────────────
//
// A source's agent file names the SOURCE's tools. They reach Pi through the neutral words of
// `../tool-vocabulary.js`: the source's dialect maps its names onto words, and this table says which of Pi's
// own tools does each word. A word missing here is a tool Pi cannot give an agent.
const TOOL_FOR_WORD = Object.freeze({
  read: 'read',
  write: 'write',
  edit: 'edit',
  'search-text': 'grep',
  'find-files': 'find',
  'list-dir': 'ls',
  shell: 'bash',
});

// The tools a Pi child gets when it is given no `--tools`: Pi's built-in default (0.84.4). A `defaultTools`
// setting of the user's own changes that default; the generated section reads it (`piDefaultTools`) where it
// matters — an agent with no `tools` line but a `disallowedTools` one, whose list has to be spelled out.
const DEFAULT_TOOLS = Object.freeze(['read', 'bash', 'edit', 'write']);

/**
 * What a source agent may use in Pi, from its frontmatter and the source's `agentDialect`.
 * Answers `{ tools, dropped, refused, model, inheritsModel }`:
 *   - `tools` — Pi tool names, or undefined for "Pi's default tools" (the agent has no tools line and
 *     nothing is taken away);
 *   - `dropped` — `[{ name, why }]`, entries that have no counterpart in Pi or restrict a tool to a pattern:
 *     the child runs without this app's approval gate, so a restriction it cannot enforce is left out rather
 *     than widened into the whole tool;
 *   - `refused` — a sentence when nothing the agent may use is left, else null;
 *   - `model` — the model the file names, or undefined; `inheritsModel` — the file says "use the caller's".
 * A plain function with no closure: it is written into the generated extension with `toString()` and called
 * by the tests directly — one implementation, not two. `entriesOf` splits a tools value into entries.
 */
function mapSourceAgent(frontmatter, dialect, toolForWord, defaults, entriesOf) {
  const fm = frontmatter || {};
  const d = dialect || {};
  // A dialect that does not say where an agent lists its tools, or what they are called, cannot be mapped —
  // and "no tools line" would then read as "every default tool". Refuse instead of guessing.
  if (!d.toolsKey || !d.toolWords || typeof d.toolWords !== 'object') {
    return { tools: [], dropped: [], refused: 'its CLI does not say how an agent names its tools', model: undefined, inheritsModel: false };
  }
  const words = d.toolWords;
  const open = d.argumentOpen || '(';
  const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const lookup = (entry) => {
    const at = entry.indexOf(open);
    const name = (at >= 0 ? entry.slice(0, at) : entry).trim();
    const word = own(words, name) ? words[name] : null;
    return { name, restricted: at >= 0, target: word && own(toolForWord, word) ? toolForWord[word] : null };
  };
  const dropped = [];
  let tools;
  const listed = fm[d.toolsKey];
  const blank = listed === undefined || listed === null || (typeof listed === 'string' && !listed.trim());
  if (!blank) {
    tools = [];
    for (const entry of entriesOf(listed)) {
      const m = lookup(entry);
      if (m.restricted) { dropped.push({ name: entry, why: 'restricted to a pattern the child cannot enforce' }); continue; }
      if (!m.target) { dropped.push({ name: entry, why: 'no counterpart here' }); continue; }
      if (!tools.includes(m.target)) tools.push(m.target);
    }
    if (!tools.length) {
      return { tools, dropped, refused: 'none of its tools can run here', model: undefined, inheritsModel: false };
    }
  }
  // A denied entry takes its WHOLE tool away, restricted or not: a pattern cannot be enforced in the child,
  // and taking away more than was asked is the side that cannot surprise anyone.
  const denied = [];
  for (const entry of (d.disallowedToolsKey ? entriesOf(fm[d.disallowedToolsKey]) : [])) {
    const m = lookup(entry);
    if (!m.target) { dropped.push({ name: entry, why: 'denied, but not a tool this mapping knows — nothing taken away for it' }); continue; }
    if (!denied.includes(m.target)) denied.push(m.target);
  }
  if (denied.length) {
    tools = (tools || defaults.slice()).filter((t) => !denied.includes(t));
    if (!tools.length) {
      return { tools, dropped, refused: 'every tool it may use is also denied to it', model: undefined, inheritsModel: false };
    }
  }
  const named = d.modelKey && typeof fm[d.modelKey] === 'string' ? fm[d.modelKey].trim() : '';
  const inheritsModel = !!named && !!d.inheritModel && named === d.inheritModel;
  return { tools, dropped, refused: null, model: named && !inheritsModel ? named : undefined, inheritsModel };
}

/**
 * Which model a source agent's `model:` name means HERE (#639, E4 as changed by the review). Pi resolves a
 * `--model` itself, and when nothing matches in a provider it falls back to a substring match across EVERY
 * provider (`resolveCliModel`, 0.84.4) — measured: `sonnet` under an OpenAI session picked an amazon-bedrock
 * model and failed on credentials. So the name is looked up only among the models available from the
 * PARENT session's provider, and the child is handed the exact `provider/id`. Exact id first; then every id
 * containing the name, preferring one without a date suffix, highest version first. No match: the
 * session's own model, and a note saying so — never another provider.
 *
 * `parent` is `{ provider, id }` or null, `available` the models Pi can use (`ctx.modelRegistry.getAvailable()`).
 * Answers `{ model, fellBack, note }`: `model` is `provider/id` or undefined when there is no parent to use.
 * A plain function, written into the extension with `toString()` and called by the tests directly.
 */
function pickSourceModel(name, parent, available) {
  const own = parent && parent.provider && parent.id ? parent.provider + '/' + parent.id : undefined;
  const fallBack = (why) => ({ model: own, fellBack: true, note: why + (own ? '; uses the session\'s model ' + own : '') });
  if (!parent || !parent.provider) return fallBack(name + ' could not be looked up without a session model');
  let wanted = String(name || '').trim().toLowerCase();
  const prefix = String(parent.provider).toLowerCase() + '/';
  if (wanted.startsWith(prefix)) wanted = wanted.slice(prefix.length);
  if (!wanted || wanted.includes('/')) return fallBack(name + ' is not a model of ' + parent.provider);
  const candidates = (Array.isArray(available) ? available : [])
    .filter((m) => m && m.provider === parent.provider && typeof m.id === 'string');
  const exact = candidates.find((m) => m.id.toLowerCase() === wanted);
  if (exact) return { model: exact.provider + '/' + exact.id, fellBack: false, note: name + ' is ' + exact.provider + '/' + exact.id };
  const matches = candidates.filter((m) => m.id.toLowerCase().includes(wanted));
  if (!matches.length) return fallBack(name + ' is not available from ' + parent.provider);
  const dated = (id) => /-\d{8}$/.test(id);
  matches.sort((a, b) => (dated(a.id) === dated(b.id) ? 0 : dated(a.id) ? 1 : -1)
    || b.id.localeCompare(a.id, undefined, { numeric: true }));
  const pick = matches[0];
  return { model: pick.provider + '/' + pick.id, fellBack: false, note: name + ' resolved to ' + pick.provider + '/' + pick.id };
}

/**
 * Which model one of PI'S OWN agents' `model:` value means (#641, owner decision: the same rule as a source
 * agent). Pi's fallback is the same for both — a name that finds nothing in a provider is matched across EVERY
 * provider — so an agent written for Pi can land on a provider the user has no credentials for just as a
 * taken-over one could. Two things differ from `pickSourceModel`, both because this file was written FOR Pi:
 *   - a `provider/id` naming a model that is available is kept exactly as written, whatever its provider —
 *     spelling the provider out is how an agent asks for another one on purpose;
 *   - Pi's own `:<thinking>` suffix (`sonnet:high`) is carried over onto the resolved model.
 * Everything else goes through `pickSourceModel`: within the parent's provider, or the session's model with
 * a note — never silently another provider. Same answer shape; a plain function like that one, written into
 * the extension beside it with `toString()`, so the name it calls resolves in both places.
 */
function pickPiModel(name, parent, available) {
  let base = String(name || '').trim();
  let level = '';
  const suffix = /^(.*):(off|minimal|low|medium|high|xhigh)$/i.exec(base);
  if (suffix) { base = suffix[1]; level = ':' + suffix[2].toLowerCase(); }
  const slash = base.indexOf('/');
  if (slash > 0) {
    const provider = base.slice(0, slash).toLowerCase();
    const id = base.slice(slash + 1).toLowerCase();
    const listed = (Array.isArray(available) ? available : [])
      .some((m) => m && String(m.provider).toLowerCase() === provider && String(m.id).toLowerCase() === id);
    if (listed) return { model: base + level, fellBack: false, note: base + level + ' as the agent names it' };
  }
  const r = pickSourceModel(base, parent, available);
  return r.fellBack || !r.model ? r : { model: r.model + level, fellBack: false, note: r.note + (level ? ' (thinking ' + level.slice(1) + ')' : '') };
}

// The extension, as TypeScript Pi loads directly. What varies per spawn — the agents directory and another
// CLI's agent directories with their dialect — is written as JSON literals, so no text a user typed can
// close a string and become code.
//
// The body below avoids template literals on purpose: it is itself inside one here, and a `${` in it
// would be interpolated by THIS file rather than written out.
// The imports the section below needs. Listed separately because the section is also one part of the
// per-spawn resources extension (`./resources-extension.js`, #632), whose other parts need some of the same
// modules — an import written twice in one file is a syntax error, so the composer merges them.
const IMPORTS = [
  'import { spawn } from "node:child_process";',
  'import * as fs from "node:fs";',
  'import * as os from "node:os";',
  'import * as path from "node:path";',
  'import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";',
];

/** The tool as a section: its helpers and `registerSubagent(pi)`, without imports or a default export. */
function subagentSection({ agentsDir, sourceAgents = [] } = {}) {
  // Only what the section needs of each source directory, in the order it is searched (project first).
  const sources = (Array.isArray(sourceAgents) ? sourceAgents : [])
    .filter((a) => a && typeof a.path === 'string' && a.path)
    .map((a) => ({ path: a.path, scope: a.scope === 'project' ? 'project' : 'global', dialect: a.dialect || {} }));
  return `// A lean subagent tool in the shape of Pi's own example extension (examples/extensions/subagent, MIT).
const AGENTS_DIR: string = ${JSON.stringify(agentsDir || '')};
const OUTPUT_CAP = ${OUTPUT_CAP};
// Another CLI's agent directories (#639), searched after Pi's own; each carries the dialect its files are in.
const SOURCE_AGENTS: any[] = ${JSON.stringify(sources)};
const TOOL_FOR_WORD: any = ${JSON.stringify(TOOL_FOR_WORD)};
const DEFAULT_TOOLS: string[] = ${JSON.stringify(DEFAULT_TOOLS)};
const agentToolEntries = (${permissionEntries.toString()});
const mapSourceAgent = (${mapSourceAgent.toString()});
const pickSourceModel = (${pickSourceModel.toString()});
const pickPiModel = (${pickPiModel.toString()});

function agentsDir(cwd: string): string {
  if (!AGENTS_DIR) return path.join(getAgentDir(), "agents");
  return path.resolve(cwd || process.cwd(), AGENTS_DIR);
}

function toolList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tools = raw.filter((t) => typeof t === "string").map((t: string) => t.trim()).filter(Boolean);
  return tools.length ? tools : undefined;
}

function loadAgents(dir: string): any[] {
  const agents: any[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return agents; }
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    let content = "";
    try { content = fs.readFileSync(path.join(dir, entry.name), "utf-8"); } catch { continue; }
    let parsed: any;
    try { parsed = parseFrontmatter(content); } catch { continue; }
    const fm = (parsed && parsed.frontmatter) || {};
    if (typeof fm.name !== "string" || typeof fm.description !== "string") continue;
    agents.push({
      name: fm.name,
      description: fm.description,
      tools: toolList(fm.tools),
      model: typeof fm.model === "string" ? fm.model : undefined,
      systemPrompt: String((parsed && parsed.body) || ""),
      frontmatter: fm,
    });
  }
  return agents;
}

// The tools a child gets without --tools: Pi's defaultTools setting, else Pi's built-in default. Needed only
// where an agent's list has to be spelled out to take a denied tool away — spelling out the built-in default
// there could give MORE than the user's own setting allows. The project's .pi/settings.json counts only as a
// NARROWING: Pi ignores it in a project it does not trust, and this code does not know the trust answer, so
// it takes the tools both lists allow. That is never wider than either, and in a trusted project whose own
// list is wider it gives less than Pi would, which is the side that cannot surprise anyone.
function piDefaultTools(cwd: string): string[] {
  const read = (file: string): string[] | undefined => {
    try {
      const v = JSON.parse(fs.readFileSync(file, "utf-8"));
      return v && Array.isArray(v.defaultTools) ? v.defaultTools.filter((t: any) => typeof t === "string") : undefined;
    } catch { return undefined; }
  };
  const base = read(path.join(getAgentDir(), "settings.json")) || DEFAULT_TOOLS.slice();
  const project = read(path.join(cwd || process.cwd(), ".pi", "settings.json"));
  return project ? base.filter((t) => project.includes(t)) : base;
}

// Every agent this session can run, in the order a name is looked up: Pi's own directory first, then another
// CLI's (#639), project before global. The first agent of a name wins, as for skills and commands, so an agent
// the user keeps for Pi is never replaced by a source's. A source agent's tools and model are mapped from its
// own dialect; Pi's own agents are taken as they are written. ONE loader for the tool description, the call
// and the approval question, so the three cannot disagree about which agent a name means.
function allAgents(cwd: string): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  for (const a of loadAgents(agentsDir(cwd))) {
    if (seen.has(a.name)) continue;
    seen.add(a.name);
    out.push({ ...a, origin: "pi", scope: "" });
  }
  const defaults = piDefaultTools(cwd);
  for (const src of SOURCE_AGENTS) {
    for (const a of loadAgents(src.path)) {
      if (seen.has(a.name)) continue;
      seen.add(a.name);
      const m = mapSourceAgent(a.frontmatter, src.dialect, TOOL_FOR_WORD, defaults, agentToolEntries);
      out.push({ ...a, origin: "source", scope: src.scope, tools: m.tools, model: m.model, inheritsModel: m.inheritsModel, dropped: m.dropped, refused: m.refused });
    }
  }
  return out;
}

// Which model a call runs on, and whether it gets the session's thinking level. Both kinds of agent resolve a
// name within the session's provider and never silently land on another (#639 for a source agent, #641 for
// Pi's own, which also keeps an available provider/id as written); "inherit" or no name means the
// session's model. The note is what the question before the call and the result say about it.
function agentModel(agent: any, ctx: any): { model?: string; thinking: boolean; note: string } {
  const parent = ctx && ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
  const own = parent ? parent.provider + "/" + parent.id : undefined;
  if (!agent.model) {
    if (agent.origin !== "source") return { model: own, thinking: true, note: "" };
    return { model: own, thinking: true, note: agent.inheritsModel ? "inherit: the session's model" : "the session's model" };
  }
  let available: any[] = [];
  try { available = ctx && ctx.modelRegistry ? ctx.modelRegistry.getAvailable() : []; } catch { available = []; }
  const r = agent.origin === "source" ? pickSourceModel(agent.model, parent, available) : pickPiModel(agent.model, parent, available);
  return { model: r.model, thinking: r.fellBack, note: r.note };
}

// The model line for one of Pi's own agents, which has no mapping line to carry it: said only when the name
// needed resolving, so an agent that runs on the session's model reads as it always did.
function ownModelLine(agent: any, modelNote?: string): string {
  if (!agent || agent.origin === "source" || !modelNote) return "";
  return "Model: " + modelNote + ".";
}

// What was done to a source agent's tools, in one line — for the question before the call and for its result.
function mappingLine(agent: any, modelNote?: string): string {
  if (!agent || agent.origin !== "source") return "";
  const left = (agent.dropped || []).map((d: any) => d.name + " (" + d.why + ")").join(", ");
  const tools = agent.tools ? (agent.tools.length ? agent.tools.join(", ") : "none") : "the default tools";
  const model = modelNote || (agent.inheritsModel ? "inherit: the session's model" : (agent.model || "the session's model"));
  return "Taken over from another CLI: tools " + tools + "; model " + model + "." + (left ? " Left out: " + left + "." : "");
}

function piInvocation(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }
  const exe = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\\.exe)?$/.test(exe)) return { command: process.execPath, args };
  return { command: "pi", args };
}

function finalText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) if (part && part.type === "text") return String(part.text || "");
    }
  }
  return "";
}

// Cut at a byte boundary once, stepping back off a UTF-8 continuation byte so no character is split.
function capped(text: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= OUTPUT_CAP) return text;
  let end = OUTPUT_CAP;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8") + "\\n\\n[Output truncated: " + (buf.length - end) + " bytes omitted.]";
}

// The parent's run-level choices the child has to share: a run the user started with --no-approve must
// not load project-local resources in its child either, and --offline / --no-context-files mean the same
// for the whole run. Only these exact flags are copied; everything else about the child is the agent's.
const INHERITED_FLAGS = new Set(["--approve", "--no-approve", "--offline", "--no-context-files"]);
const STDERR_CAP = 64 * 1024;

function usageLine(agent: string, u: any, model?: string): string {
  const cost = "$" + (u.cost || 0).toFixed(4);
  return "[subagent " + agent + ": " + u.turns + " turn" + (u.turns === 1 ? "" : "s")
    + ", " + u.input + " in / " + u.output + " out tokens, " + cost
    + (model ? ", " + model : "") + "]";
}

// Stop the child and what it started. On Windows a plain kill takes only the node process and leaves the
// child's own tool processes behind; taskkill /T takes the tree, as the app's own stop does.
function stop(proc: any) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === "win32" && proc.pid) {
    try { spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {}); return; } catch {}
  }
  try { proc.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { if (proc.exitCode === null) proc.kill("SIGKILL"); } catch {} }, 5000);
}

// What the agent behind a call may do, in one line, for whoever asks before the call runs. Published under a
// registry symbol rather than imported, because the asker is another per-spawn extension in this same Pi
// process (the runtime-driven backend's approval gate) and neither file knows the other's path.
//
// The answer is { text, key, refused }: the key names the agent AND where it came from, so "allow for this
// session" given to one agent cannot carry over to a different agent that later answers to the same name;
// "refused" says the call will be refused anyway, so nobody is asked to allow what cannot run.
function describeAgent(cwd: string, name: string, ctx?: any): any {
  const agent = allAgents(cwd).find((a) => a.name === name);
  if (!agent) return { text: "Unknown agent \\"" + name + "\\" — the call will fail without running anything.", key: "", refused: true };
  if (agent.refused) {
    return { text: "Agent " + agent.name + " will be refused: " + agent.refused + ". " + mappingLine(agent), key: agent.origin + ":" + (agent.scope || "") + ":" + agent.name, refused: true };
  }
  const model = (agent.model && agentModel(agent, ctx).note) || (agent.inheritsModel ? "the session's (the file says inherit)" : "the session's");
  const what = agent.origin === "source"
    ? mappingLine(agent, agentModel(agent, ctx).note)
    : "Agent " + agent.name + " · tools: " + (agent.tools ? agent.tools.join(", ") : "Pi's default tools") + " · model: " + model + ".";
  return {
    text: (agent.origin === "source" ? "Agent " + agent.name + ". " : "") + what + " Nothing the agent runs is asked about separately.",
    key: agent.origin + ":" + (agent.scope || "") + ":" + agent.name,
    refused: false,
  };
}
(globalThis as any)[Symbol.for(${JSON.stringify(DESCRIBE_KEY)})] = describeAgent;

function registerSubagent(pi: any) {
  const listed = allAgents(process.cwd()).filter((a) => !a.refused);
  const names = listed.map((a) => a.name + " (" + a.description + ")").join("; ");
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate one task to a specialised agent that runs as a separate Pi process with its own, fresh context window.",
      "It starts a second model session with its own token cost, so use it for a bounded piece of work that benefits from a clean context.",
      "Give the agent everything it needs in the task text: it does not see this conversation.",
      names ? "Available agents: " + names + "." : "No agents are defined yet.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Name of the agent to run" },
        task: { type: "string", description: "The task, complete and self-contained" },
      },
      required: ["agent", "task"],
      additionalProperties: false,
    },

    async execute(_id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
      const cwd = (ctx && ctx.cwd) || process.cwd();
      const agents = allAgents(cwd);
      const agent = agents.find((a) => a.name === params.agent);
      if (!agent) {
        const available = agents.filter((a) => !a.refused).map((a) => '"' + a.name + '"').join(", ") || "none";
        return {
          content: [{ type: "text", text: 'Unknown agent "' + params.agent + '". Available agents: ' + available + "." }],
          details: { agent: params.agent, available: agents.filter((a) => !a.refused).map((a) => a.name) },
          isError: true,
        };
      }

      if (agent.refused) {
        return {
          content: [{ type: "text", text: "Agent " + agent.name + " cannot run here: " + agent.refused + ". " + mappingLine(agent) }],
          details: { agent: agent.name, origin: agent.origin, dropped: agent.dropped || [], refused: agent.refused },
          isError: true,
        };
      }

      const args: string[] = ["--mode", "json", "-p", "--no-session"];
      const chosen = agentModel(agent, ctx);
      const model = chosen.model;
      if (model) args.push("--model", model);
      if (chosen.thinking && ctx && ctx.thinkingLevel) args.push("--thinking", ctx.thinkingLevel);
      if (agent.tools) args.push("--tools", agent.tools.join(","));
      for (const flag of process.argv.slice(2)) if (INHERITED_FLAGS.has(flag)) args.push(flag);

      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
      const messages: any[] = [];
      let stderr = "";
      let stopReason: string | undefined;
      let errorMessage: string | undefined;
      let usedModel: string | undefined = model;
      let aborted = false;

      const progress = () => {
        if (typeof onUpdate !== "function") return;
        try {
          onUpdate({
            content: [{ type: "text", text: (finalText(messages) || "(running...)") + "\\n" + usageLine(agent.name, usage, usedModel) }],
            details: { agent: agent.name, origin: agent.origin, usage: { ...usage }, model: usedModel, running: true },
          });
        } catch {}
      };

      let promptDir: string | null = null;
      try {
        if (signal && signal.aborted) throw new Error("Subagent was aborted before it started.");
        if (agent.systemPrompt.trim()) {
          promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
          const promptFile = path.join(promptDir, "prompt.md");
          fs.writeFileSync(promptFile, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
          args.push("--append-system-prompt", promptFile);
        }
        args.push("Task: " + params.task);

        const exitCode = await new Promise<number>((resolve) => {
          const inv = piInvocation(args);
          const proc = spawn(inv.command, inv.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
          let buffer = "";
          const line = (text: string) => {
            if (!text.trim()) return;
            let event: any;
            try { event = JSON.parse(text); } catch { return; }
            if (event.type === "message_end" && event.message) {
              const msg = event.message;
              messages.push(msg);
              if (msg.role === "assistant") {
                usage.turns++;
                const u = msg.usage;
                if (u) {
                  usage.input += u.input || 0;
                  usage.output += u.output || 0;
                  usage.cacheRead += u.cacheRead || 0;
                  usage.cacheWrite += u.cacheWrite || 0;
                  usage.cost += (u.cost && u.cost.total) || 0;
                }
                if (msg.model) usedModel = (msg.provider ? msg.provider + "/" : "") + msg.model;
                if (msg.stopReason) stopReason = msg.stopReason;
                if (msg.errorMessage) errorMessage = msg.errorMessage;
              }
              progress();
            }
          };
          proc.stdout.on("data", (data: Buffer) => {
            buffer += data.toString();
            const lines = buffer.split("\\n");
            buffer = lines.pop() || "";
            for (const l of lines) line(l);
          });
          proc.stderr.on("data", (data: Buffer) => { if (stderr.length < STDERR_CAP) stderr += data.toString(); });
          proc.on("close", (code: number | null, sig: string | null) => { if (buffer.trim()) line(buffer); resolve(code ?? (sig ? 1 : 0)); });
          proc.on("error", (err: Error) => { stderr += String(err && err.message || err); resolve(1); });
          if (signal) {
            const onAbort = () => { aborted = true; stop(proc); };
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          }
        });

        // The usage so far travels with the abort: a run cancelled because it got away is the one whose cost
        // most needs saying.
        const said = mappingLine(agent, chosen.note) || ownModelLine(agent, chosen.note);
        if (aborted) throw new Error("Subagent was aborted. " + usageLine(agent.name, usage, usedModel) + (said ? " [" + said + "]" : ""));
        const summary = usageLine(agent.name, usage, usedModel) + (said ? "\\n[" + said + "]" : "");
        const details = { agent: agent.name, origin: agent.origin, tools: agent.tools, modelNote: chosen.note, dropped: agent.dropped || [], usage: { ...usage }, model: usedModel, exitCode, stopReason };
        const failed = exitCode !== 0 || stopReason === "error" || stopReason === "aborted";
        if (failed) {
          const why = errorMessage || stderr.trim() || finalText(messages) || "(no output)";
          return { content: [{ type: "text", text: "Agent " + (stopReason || "failed") + ": " + capped(why) + "\\n\\n" + summary }], details, isError: true };
        }
        return { content: [{ type: "text", text: capped(finalText(messages) || "(no output)") + "\\n\\n" + summary }], details };
      } finally {
        if (promptDir) { try { fs.rmSync(promptDir, { recursive: true, force: true }); } catch {} }
      }
    },
  });
}
`;
}

// The tool on its own, as one extension file — the section with its imports and a default export.
function extensionSource({ agentsDir, sourceAgents } = {}) {
  return '// Generated by Switchboard for one Pi spawn. Safe to delete.\n'
    + IMPORTS.join('\n') + '\n\n'
    + subagentSection({ agentsDir, sourceAgents })
    + '\nexport default function (pi: any) {\n  registerSubagent(pi);\n}\n';
}

module.exports = {
  pickSourceModel,
  pickPiModel,
  TOOL_FOR_WORD,
  DEFAULT_TOOLS,
  mapSourceAgent,
  OPTION_ID,
  DIR_OPTION_ID,
  DESCRIBE_KEY,
  extensionSource,
  IMPORTS,
  subagentSection,
  agentsDirFrom,
};
