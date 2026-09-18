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
//     `--tools`, and its `model` through `--model`; an agent that names no model inherits the parent's
//     model and thinking level.
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

// The extension, as TypeScript Pi loads directly. The one value that varies per spawn is the agents
// directory, written as a JSON literal so no text a user typed can close a string and become code.
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
function subagentSection({ agentsDir } = {}) {
  return `// A lean subagent tool in the shape of Pi's own example extension (examples/extensions/subagent, MIT).
const AGENTS_DIR: string = ${JSON.stringify(agentsDir || '')};
const OUTPUT_CAP = ${OUTPUT_CAP};

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
    });
  }
  return agents;
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
function describeAgent(cwd: string, name: string): string {
  const agent = loadAgents(agentsDir(cwd)).find((a) => a.name === name);
  if (!agent) return "Unknown agent \\"" + name + "\\" — the call will fail without running anything.";
  return "Agent " + agent.name + " · tools: " + (agent.tools ? agent.tools.join(", ") : "Pi's default tools")
    + " · model: " + (agent.model || "the session's") + ". Nothing the agent runs is asked about separately.";
}
(globalThis as any)[Symbol.for(${JSON.stringify(DESCRIBE_KEY)})] = describeAgent;

function registerSubagent(pi: any) {
  const listed = loadAgents(agentsDir(process.cwd()));
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
      const agents = loadAgents(agentsDir(cwd));
      const agent = agents.find((a) => a.name === params.agent);
      if (!agent) {
        const available = agents.map((a) => '"' + a.name + '"').join(", ") || "none";
        return {
          content: [{ type: "text", text: 'Unknown agent "' + params.agent + '". Available agents: ' + available + "." }],
          details: { agent: params.agent, available: agents.map((a) => a.name) },
          isError: true,
        };
      }

      const args: string[] = ["--mode", "json", "-p", "--no-session"];
      const parentModel = ctx && ctx.model ? ctx.model.provider + "/" + ctx.model.id : undefined;
      const model = agent.model || parentModel;
      if (model) args.push("--model", model);
      if (!agent.model && ctx && ctx.thinkingLevel) args.push("--thinking", ctx.thinkingLevel);
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
            details: { agent: agent.name, usage: { ...usage }, model: usedModel, running: true },
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
        if (aborted) throw new Error("Subagent was aborted. " + usageLine(agent.name, usage, usedModel));
        const summary = usageLine(agent.name, usage, usedModel);
        const details = { agent: agent.name, usage: { ...usage }, model: usedModel, exitCode, stopReason };
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
function extensionSource({ agentsDir } = {}) {
  return '// Generated by Switchboard for one Pi spawn. Safe to delete.\n'
    + IMPORTS.join('\n') + '\n\n'
    + subagentSection({ agentsDir })
    + '\nexport default function (pi: any) {\n  registerSubagent(pi);\n}\n';
}

module.exports = {
  OPTION_ID,
  DIR_OPTION_ID,
  DESCRIBE_KEY,
  extensionSource,
  IMPORTS,
  subagentSection,
  agentsDirFrom,
};
