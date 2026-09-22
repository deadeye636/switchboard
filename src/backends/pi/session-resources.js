// backends/pi/session-resources.js — what a Pi session is given at spawn beyond its own setup (#632, #634).
//
// One hook pair for all of it (owner decision O5), so a session gets one `--extension` and one release:
//
//   - "Resources from": the core resolves what the chosen source offers for THIS launch
//     (`src/app/resource-sources.js` — which directories, and which were dropped because the project is not
//     trusted), and this file decides how Pi is given them:
//       · a skill directory goes on the command line as `--skill <dir>`. Pi reads the SKILL.md shape the
//         other CLIs write (measured, spec 30), appends such paths AFTER its own resources, and keeps the
//         first of two equal names — so a skill of the user's own Pi setup wins over the source's;
//       · commands become a section of the per-spawn extension (`./command-bridge.js`), because
//         `--prompt-template` would leave their `` !`…` `` and `@file` as text (measured);
//   - the `subagent` tool (#634), another section of that same extension, when its option is on — and with
//     it the source's agents (#639), whose tools and model the section maps through the source's dialect;
//   - the source's MCP servers (#633), a third section of that extension (`./mcp-section.js`), while their
//     toggle is on. The section is the client; WHICH servers it starts reaches it through the environment
//     (`env` in the answer), because their definitions carry tokens and the extension file sits on disk.
//
// The options are read HERE, not in the core: which of this backend's options name a source or switch the
// tool on is this backend's declaration (`appliedBy` on each field).
'use strict';

const subagentTool = require('./subagent-tool');
const resourcesExtension = require('./resources-extension');
const mcpSection = require('./mcp-section');
const hooksSection = require('./hooks-section');

const SOURCE_OPTION_ID = 'resourcesFrom';
const MCP_OPTION_ID = 'mcpServers';
const HOOKS_OPTION_ID = 'sourceHooks';

/**
 * `{ args, env, cleanup, source, skills, commands, agents, mcpServers, dropped }` for this launch, or null when
 * there is nothing to give. `env` is what the spawn adds to the session's environment: the MCP server list
 * (#633), which carries tokens and is therefore never written into the extension file.
 *
 * `resolveSource(sourceId)` is the core's resolver, bound to this target, project and options. The answer
 * has the resolver's shape: a promise when it returns one (the spawn path), the value itself when it does
 * not — which lets `scripts/managed-flags.js` derive the flags synchronously, as it does every other flag.
 */
function buildSessionResources({ dir, tag, options, resolveSource, log } = {}) {
  const opts = options || {};
  const sourceId = typeof opts[SOURCE_OPTION_ID] === 'string' ? opts[SOURCE_OPTION_ID].trim() : '';
  // Strictly `true`: the tool defaults OFF, and "nobody said anything" has to mean no.
  const subagent = opts[subagentTool.OPTION_ID] === true ? { agentsDir: subagentTool.agentsDirFrom(opts) } : null;
  const resolved = sourceId && typeof resolveSource === 'function' ? resolveSource(sourceId) : null;
  const finish = (value) => assemble({ dir, tag, sourceId, resolved: value, subagent, log });
  if (resolved && typeof resolved.then === 'function') return resolved.then(finish);
  return finish(resolved);
}

function assemble({ dir, tag, sourceId, resolved, subagent, log }) {
  let skills = [];
  let commands = [];
  let agents = [];
  let mcpServers = [];
  let hooks = [];
  let dropped = [];
  if (sourceId) {
    if (!resolved || resolved.ok === false) {
      if (log) log.warn(`[session-resources] source ${sourceId} gave nothing: ${(resolved && resolved.reason) || 'no answer'}`);
    } else {
      skills = resolved.skills || [];
      commands = resolved.commands || [];
      agents = resolved.agents || [];
      mcpServers = resolved.mcpServers || [];
      hooks = resolved.hooks || [];
      dropped = [...(resolved.dropped || [])];
    }
  }
  // A source's agents run through the subagent tool (#639), and the core only hands them over while that tool
  // is on (`declinesSharedResource`). Should an answer carry agents anyway, they are reported, not run.
  if (agents.length && !subagent) {
    for (const a of agents) dropped.push({ path: a.path, kind: 'agent', scope: a.scope, reason: 'target-declined' });
    agents = [];
  }
  // Project agents before global ones, as the source CLI itself ranks them; the section keeps the first name.
  agents = [...agents].sort((a, b) => (a.scope === 'project' ? 0 : 1) - (b.scope === 'project' ? 0 : 1));
  const section = subagent ? { ...subagent, sourceAgents: agents } : null;
  const args = [];
  for (const skill of skills) args.push('--skill', skill.path);
  let cleanup = null;
  let env = null;
  const mcpEnv = mcpSection.envFor(mcpServers);
  // A hook the TARGET cannot place is reported here rather than silently left out: the core decided it may
  // be handed over, so the reason it still does not run is this folder's to give.
  const placed = hooksSection.usable(hooks);
  hooks = placed.runnable;
  dropped.push(...placed.dropped);
  if (section || commands.length || mcpEnv || hooks.length) {
    const written = resourcesExtension.writeResourcesExtension({ dir, tag, subagent: section, commands, mcp: !!mcpEnv, hooks, log });
    if (written) {
      args.push('--extension', written.file);
      cleanup = written.file;
      env = mcpEnv;
    } else if (commands.length || agents.length || mcpServers.length || hooks.length) {
      // No file, no commands and no agents — said, rather than a session that silently lacks them.
      for (const c of commands) dropped.push({ path: c.path, kind: 'command', scope: c.scope, reason: 'extension-not-written' });
      for (const a of agents) dropped.push({ path: a.path, kind: 'agent', scope: a.scope, reason: 'extension-not-written' });
      for (const m of mcpServers) dropped.push({ path: m.path, name: m.name, kind: 'mcp-server', scope: m.scope, reason: 'extension-not-written' });
      for (const h of hooks) dropped.push({ path: h.path, kind: 'hook', scope: h.scope, reason: 'extension-not-written' });
      commands = [];
      agents = [];
      mcpServers = [];
      hooks = [];
    }
  }
  // The rows leave without their env: this answer is logged, and only `env` above goes to the process.
  const servers = mcpServers.map((m) => ({ name: m.name, scope: m.scope }));
  // A hook leaves without its command line: this answer is logged, and a user's own command is not a thing
  // to write into a log file on every launch.
  const hookRows = hooks.map((h) => ({ event: h.event, scope: h.scope }));
  if (!args.length) return sourceId ? { args, env: null, cleanup: null, source: sourceId, skills, commands, agents, mcpServers: servers, hooks: hookRows, dropped } : null;
  return { args, env, cleanup, source: sourceId || null, skills, commands, agents, mcpServers: servers, hooks: hookRows, dropped, subagent: !!subagent };
}

function releaseSessionResources(file, log) {
  resourcesExtension.removeResourcesExtension(file, log);
}

/**
 * Which kind Pi accepts in general but not with THIS launch's options (#639) — asked by the core's
 * resolver for the spawn and for the settings preview alike. A source's agents run only through the
 * `subagent` tool, and that tool is off unless somebody switched it on: switching a source on does not
 * switch on a tool that starts model sessions nobody typed. Null means "taken".
 */
function declinesSharedResource({ kind, options } = {}) {
  if (kind === 'agent' && !(options && options[subagentTool.OPTION_ID] === true)) {
    return { reason: 'target-declined', note: 'not passed: the subagent tool is off' };
  }
  // The same for a source's MCP servers (#633): choosing a source does not start processes by itself. Their
  // own toggle does, and it is off unless somebody switched it on.
  if (kind === 'mcp-server' && !(options && options[MCP_OPTION_ID] === true)) {
    return { reason: 'target-declined', note: 'not started: MCP servers from the source are off' };
  }
  // And the same again for hooks (#635), where it matters most: a hook is a command line of the user's,
  // and choosing a source must not start running commands nobody switched on.
  if (kind === 'hook' && !(options && options[HOOKS_OPTION_ID] === true)) {
    return { reason: 'target-declined', note: 'not run: hooks from the source are off' };
  }
  return null;
}

module.exports = { SOURCE_OPTION_ID, MCP_OPTION_ID, HOOKS_OPTION_ID, buildSessionResources, releaseSessionResources, declinesSharedResource };
