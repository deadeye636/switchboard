// backends/pi/mcp-section.js — another CLI's MCP servers inside a Pi session (#633), as one section of the
// per-spawn resources extension (`./resources-extension.js`).
//
// Pi has no MCP client (0.84.4 and 0.85.1: no dependency, no flag, and its README says to build an extension),
// so this section is one: it starts each stdio server as a child process, speaks JSON-RPC to it over its
// standard streams (`initialize`, `tools/list`, `tools/call`) and registers every tool it offers as a Pi tool.
// Measured in step 0 of #633 (docs/plans, local): an MCP tool's `inputSchema` passes through as Pi's
// `parameters` unchanged, and a tool registered in `session_start` reaches a prompt sent after it.
//
// WHAT the servers are reaches the section in ONE environment variable, never in the generated file: a
// server's `env` routinely holds tokens, and this file sits on disk for the life of the session. The section
// reads the variable when Pi loads it and deletes it from `process.env` right away, so nothing Pi starts
// afterwards — its `bash` tool above all — inherits it (measured: the agent's shell saw nothing).
//
// Owner decisions (#633 direction comment): stdio only; a server that fails is said, never silently absent
// (M8); the section ends its servers on `session_shutdown` (M7 — on Windows they also die with Pi, because
// Node puts its children in a kill-on-close job object: measured); `session_start` waits for the servers up
// to a cap and no longer (O4), because the app often launches with a prompt that would otherwise go out
// before any MCP tool exists — measured too: a tool registered after a prompt was sent is not seen by it.
//
// Tool names are `mcp__<server>__<tool>` (O2), cleaned to what every provider accepts and cut at 64.
'use strict';

// The one variable the spawn path hands the server list over in. Core-neutral on purpose: the spawn path
// merges whatever env the backend returns and never reads this name.
const ENV_KEY = 'SWITCHBOARD_PI_MCP_SERVERS';
// How long `session_start` waits for the servers, all of them together (O4).
const START_CAP_MS = 5000;
// How long one server may take to answer `initialize` or `tools/list` before it counts as failed.
const HANDSHAKE_TIMEOUT_MS = 30000;
// What one tool result may put in front of the model, in characters of text.
const OUTPUT_CAP = 50 * 1024;
const STDERR_CAP = 8 * 1024;
// What every tool this section registers is called by, and the one thing pi-native's approval gate matches
// on (#633, M5): an MCP tool can do anything its server does, and whether it only reads is the server's claim.
const TOOL_PREFIX = 'mcp__';
// Where the section publishes a line about one of its tools, for the gate's question — the tool NAME is
// cleaned and cut, so it cannot be taken apart into server and tool again. The same registry-symbol shape
// as the subagent describer (`./subagent-tool.js`): two per-spawn extensions in one process.
const DESCRIBE_KEY = 'switchboard.mcp.describe';

// Pi's tool name for one MCP tool. A plain function, written into the section with `toString()`, so the tests
// call the same implementation.
function mcpToolName(server, tool) {
  const clean = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '_');
  const name = 'mcp__' + clean(server) + '__' + clean(tool);
  return name.length > 64 ? name.slice(0, 64) : name;
}

// A `tools/call` result as Pi tool content: text and images carried, a resource's text inlined, anything
// else named rather than dropped, and the text capped so one tool cannot flood the context.
function mcpContent(result, cap) {
  const out = [];
  let used = 0;
  let cut = false;
  const addText = (text) => {
    const s = String(text);
    if (used >= cap) { cut = true; return; }
    const room = cap - used;
    if (s.length > room) { out.push({ type: 'text', text: s.slice(0, room) }); used = cap; cut = true; return; }
    out.push({ type: 'text', text: s });
    used += s.length;
  };
  const items = result && Array.isArray(result.content) ? result.content : [];
  for (const c of items) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text') addText(c.text || '');
    else if (c.type === 'image' && typeof c.data === 'string') out.push({ type: 'image', data: c.data, mimeType: c.mimeType || 'image/png' });
    else if (c.type === 'resource' && c.resource) addText(typeof c.resource.text === 'string' ? c.resource.text : '[resource ' + (c.resource.uri || '') + ']');
    else if (c.type === 'resource_link') addText('[resource ' + (c.uri || c.name || '') + ']');
    else addText('[' + String(c.type) + ' content not shown]');
  }
  if (!items.length && result && result.structuredContent !== undefined) addText(JSON.stringify(result.structuredContent));
  if (!out.length) out.push({ type: 'text', text: '(no output)' });
  if (cut) out.push({ type: 'text', text: '[Output truncated at ' + cap + ' characters.]' });
  return out;
}

/** The env the spawn path adds for these servers: `{ [ENV_KEY]: json }`, or null when there are none. */
function envFor(servers) {
  const list = (Array.isArray(servers) ? servers : [])
    .filter((s) => s && typeof s.name === 'string' && s.name && typeof s.command === 'string' && s.command)
    .map((s) => ({ name: s.name, command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [], env: s.env && typeof s.env === 'object' ? s.env : {} }));
  return list.length ? { [ENV_KEY]: JSON.stringify(list) } : null;
}

const IMPORTS = [
  'import { spawn } from "node:child_process";',
];

// The section. No template literal and no `${` in the TypeScript below: it sits inside one here.
function mcpSection() {
  return `// Another CLI's MCP servers (#633): a minimal stdio MCP client, one Pi tool per server tool.
const MCP_ENV_KEY: string = ${JSON.stringify(ENV_KEY)};
const MCP_START_CAP_MS = ${START_CAP_MS};
const MCP_HANDSHAKE_TIMEOUT_MS = ${HANDSHAKE_TIMEOUT_MS};
const MCP_OUTPUT_CAP = ${OUTPUT_CAP};
const MCP_STDERR_CAP = ${STDERR_CAP};
const mcpToolName = (${mcpToolName.toString()});
const mcpContent = (${mcpContent.toString()});

// Process-level state, kept on a registry symbol rather than in this module: Pi evaluates this file again on
// /reload (and when a /resume changes the working directory), and it calls the default export once per
// RUNTIME — every /new, /resume and /fork builds a new extension instance with an empty tool list. So the
// server list, the running clients and the current generation outlive a module evaluation, while the tools
// are registered again with every instance (see registerMcpServers).
const MCP_STATE: any = (() => {
  const key = Symbol.for("switchboard.pi.mcp");
  const g: any = globalThis as any;
  if (!g[key]) g[key] = { servers: null, clients: new Map(), generation: 0, exitHooked: false, described: new Map() };
  const state = g[key];
  // Read once, and gone from the environment before Pi starts anything. A later evaluation finds the
  // variable deleted and keeps the list it already has.
  const raw = process.env[MCP_ENV_KEY];
  delete process.env[MCP_ENV_KEY];
  if (raw !== undefined) {
    try { const v = JSON.parse(raw); state.servers = Array.isArray(v) ? v : []; } catch { state.servers = []; }
  }
  if (!Array.isArray(state.servers)) state.servers = [];
  if (!state.described) state.described = new Map();
  return state;
})();

// One line about a tool of this section, for whoever asks before it runs (pi-native's gate); '' for a name
// this section never registered.
(globalThis as any)[Symbol.for(${JSON.stringify(DESCRIBE_KEY)})] = (name: string): string => {
  const d = MCP_STATE.described.get(String(name));
  if (!d) return "";
  return "Tool " + d.tool + " of the MCP server " + d.server + ", taken over from another CLI" + (d.description ? ": " + d.description : ".");
};

class McpClient {
  name: string;
  proc: any;
  next = 1;
  pending = new Map<number, any>();
  buf = "";
  stderr = "";
  closed = false;
  closeReason = "";

  constructor(def: any, cwd: string) {
    this.name = def.name;
    try {
      this.proc = spawn(def.command, Array.isArray(def.args) ? def.args : [], {
        cwd, env: { ...process.env, ...(def.env || {}) }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false,
      });
    } catch (e: any) {
      // Node refuses some commands before it starts anything (a .cmd without a shell throws EINVAL here).
      this.proc = null;
      this.fail(mcpSpawnError(def.command, e));
      return;
    }
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (c: string) => this.onData(c));
    this.proc.stderr.on("data", (c: any) => { if (this.stderr.length < MCP_STDERR_CAP) this.stderr += String(c); });
    this.proc.stdin.on("error", () => {});
    this.proc.on("error", (e: any) => this.fail(mcpSpawnError(def.command, e)));
    this.proc.on("close", (code: any) => this.fail(code === null || code === undefined ? "the server ended" : "the server exited with code " + code));
  }

  onData(chunk: string) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && msg.method && msg.id !== undefined) {
        // A request FROM the server. Only ping is answered; nothing else was offered in initialize.
        this.write(msg.method === "ping" ? { jsonrpc: "2.0", id: msg.id, result: {} } : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
        continue;
      }
      if (!msg || msg.id === undefined || !this.pending.has(msg.id)) continue;
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      p.done();
      if (msg.error) p.reject(new Error(String(msg.error.message || "error " + msg.error.code)));
      else p.resolve(msg.result);
    }
  }

  write(msg: any) {
    try { this.proc.stdin.write(JSON.stringify(msg) + "\\n"); } catch {}
  }

  tail(): string {
    const t = this.stderr.trim().split(/\\r?\\n/).slice(-3).join(" | ");
    return t ? " (" + t.slice(0, 300) + ")" : "";
  }

  fail(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason + this.tail();
    for (const p of this.pending.values()) { p.done(); p.reject(new Error(this.closeReason)); }
    this.pending.clear();
  }

  // No timeout on a call unless one is given: a tool may legitimately run long, and the user's abort ends it.
  request(method: string, params: any, signal?: AbortSignal, timeoutMs?: number): Promise<any> {
    if (this.closed) return Promise.reject(new Error(this.closeReason || "the server is not running"));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      let timer: any = null;
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        done();
        this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "aborted" } });
        reject(new Error("aborted"));
      };
      const done = () => {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      this.pending.set(id, { resolve, reject, done });
      if (timeoutMs) {
        timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          done();
          reject(new Error(method + " got no answer within " + Math.round(timeoutMs / 1000) + " s" + this.tail()));
        }, timeoutMs);
        if (timer && timer.unref) timer.unref();
      }
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: any) {
    this.write({ jsonrpc: "2.0", method, params: params || {} });
  }

  // On Windows a plain kill takes only the direct child; a server started through a shim (cmd /c npx) has
  // its own children, and taskkill /T takes the tree, as the app's own stop does.
  stop() {
    this.fail("the session ended");
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return;
    try { proc.stdin.end(); } catch {}
    if (process.platform === "win32" && proc.pid) {
      try { spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {}); return; } catch {}
    }
    try { proc.kill("SIGTERM"); } catch {}
  }
}

// A command that is not an executable. On Windows that is also what a bare npm shim is (npx, a .cmd file):
// it is started without a shell, as Claude does, and Claude's own Windows setup writes such a server as
// "cmd /c npx ..." for the same reason.
function mcpSpawnError(command: string, e: any): string {
  const win = process.platform === "win32";
  // The shim hint only for a bare name: a mistyped path to a real program is simply not found.
  if (e && e.code === "ENOENT") return "command not found: " + command + (win && !/[\\\\/]/.test(command) ? " (a .cmd shim such as npx has to be started as cmd /c " + command + ")" : "");
  if (e && e.code === "EINVAL" && win) return "cannot be started without a shell: " + command + " (a .cmd or .bat file has to be started as cmd /c " + command + ")";
  return String((e && e.message) || e);
}

function mcpNotify(ctx: any, text: string, level: string) {
  try { if (ctx && ctx.ui && typeof ctx.ui.notify === "function") ctx.ui.notify(text, level); } catch {}
}

function mcpStopAll() {
  for (const c of MCP_STATE.clients.values()) c.stop();
  MCP_STATE.clients.clear();
}

// Register one server's tools with THIS extension instance. "registered" belongs to the instance: a new
// runtime starts with no tools at all, so a name is skipped only when this instance already offers it.
function mcpRegisterTools(pi: any, registered: Map<string, string>, server: string, tools: any[], ctx: any): number {
  let count = 0;
  for (const t of tools) {
    if (!t || typeof t.name !== "string" || !t.name) continue;
    const name = mcpToolName(server, t.name);
    const key = server + " / " + t.name;
    if (registered.has(name)) {
      if (registered.get(name) !== key) mcpNotify(ctx, "MCP tool " + key + " is not offered: its name " + name + " is taken by " + registered.get(name) + ".", "warning");
      else count++;
      continue;
    }
    registered.set(name, key);
    MCP_STATE.described.set(name, { server, tool: t.name, description: String(t.description || "").replace(/\\s+/g, " ").trim().slice(0, 200) });
    const toolName = t.name;
    const schema = t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} };
    pi.registerTool({
      name,
      label: server + ": " + toolName,
      description: String(t.description || toolName) + " (MCP server " + server + ")",
      parameters: schema,
      async execute(_id: string, params: any, signal: AbortSignal | undefined) {
        // Looked up per call: after a restart the tool reaches the server that runs NOW.
        const client = MCP_STATE.clients.get(server);
        if (!client || client.closed) {
          return {
            content: [{ type: "text", text: "MCP server " + server + " is not running" + (client && client.closeReason ? ": " + client.closeReason : "") + "." }],
            details: { server, tool: toolName },
            isError: true,
          };
        }
        try {
          const r = await client.request("tools/call", { name: toolName, arguments: params || {} }, signal);
          return { content: mcpContent(r, MCP_OUTPUT_CAP), details: { server, tool: toolName }, isError: !!(r && r.isError) };
        } catch (e: any) {
          if (signal && signal.aborted) throw new Error("MCP tool " + name + " was aborted.");
          return { content: [{ type: "text", text: "MCP tool " + key + " failed: " + String((e && e.message) || e) }], details: { server, tool: toolName }, isError: true };
        }
      },
    });
    count++;
  }
  return count;
}

// Start one server and hand back its tools. The client is this call's own: a failure stops THIS client, never
// whatever runs under the same name by then (a later session's).
async function mcpStart(def: any, cwd: string, generation: number): Promise<any[]> {
  const client = new McpClient(def, cwd);
  if (generation === MCP_STATE.generation) MCP_STATE.clients.set(def.name, client);
  else client.stop();
  try {
    await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "switchboard-pi", version: "1" },
    }, undefined, MCP_HANDSHAKE_TIMEOUT_MS);
    client.notify("notifications/initialized");
    const tools: any[] = [];
    let cursor: any = undefined;
    do {
      const page = await client.request("tools/list", cursor ? { cursor } : {}, undefined, MCP_HANDSHAKE_TIMEOUT_MS);
      if (page && Array.isArray(page.tools)) tools.push(...page.tools);
      cursor = page && page.nextCursor;
    } while (cursor && tools.length < 1000);
    return tools;
  } catch (err) {
    client.stop();
    if (MCP_STATE.clients.get(def.name) === client) MCP_STATE.clients.delete(def.name);
    throw err;
  }
}

function registerMcpServers(pi: any) {
  const servers: any[] = MCP_STATE.servers;
  if (!servers.length) return;
  if (!MCP_STATE.exitHooked) { MCP_STATE.exitHooked = true; process.once("exit", mcpStopAll); }
  const registered = new Map<string, string>();
  // The lines about the tools go with the servers: the next session registers and describes its own.
  pi.on("session_shutdown", () => { MCP_STATE.generation++; mcpStopAll(); MCP_STATE.described.clear(); });
  pi.on("session_start", async (_event: any, ctx: any) => {
    // A new generation: anything still starting for an earlier session registers nothing, stops nothing but
    // its own client, and says nothing into this one.
    const generation = ++MCP_STATE.generation;
    mcpStopAll();
    const cwd = (ctx && ctx.cwd) || process.cwd();
    const current = () => generation === MCP_STATE.generation;
    const failed = (def: any, err: any) => mcpNotify(ctx, "MCP server " + def.name + " did not start: " + String((err && err.message) || err), "warning");
    // Past the cap, every outcome is said as it arrives. Before it, a failure is held until the cap decides
    // how the start is reported — either with the others once all have settled, or on its own when a slower
    // sibling is still starting. Never neither.
    let late = false;
    const failedEarly: any[] = [];
    const all = Promise.all(servers.map((def: any) => mcpStart(def, cwd, generation).then(
      (tools: any[]) => {
        if (!current()) return { def, err: null };
        mcpRegisterTools(pi, registered, def.name, tools, ctx);
        if (late) mcpNotify(ctx, "MCP server " + def.name + " is ready; its tools are offered from the next prompt on.", "info");
        return { def, err: null };
      },
      (err: any) => {
        if (current()) {
          if (late) failed(def, err);
          else failedEarly.push({ def, err });
        }
        return { def, err };
      },
    )));
    let timer: any = null;
    const capped = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), MCP_START_CAP_MS); if (timer && timer.unref) timer.unref(); });
    const first = await Promise.race([all, capped]);
    if (timer) clearTimeout(timer);
    if (!current()) return;
    if (first) {
      for (const r of first) if (r.err) failed(r.def, r.err);
      return;
    }
    late = true;
    for (const f of failedEarly.splice(0)) failed(f.def, f.err);
    mcpNotify(ctx, "MCP servers are still starting; their tools are offered once they answer.", "info");
  });
}
`;
}

module.exports = { ENV_KEY, TOOL_PREFIX, DESCRIBE_KEY, START_CAP_MS, OUTPUT_CAP, IMPORTS, mcpSection, mcpToolName, mcpContent, envFor };
