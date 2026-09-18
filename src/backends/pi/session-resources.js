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
//   - the `subagent` tool (#634), another section of that same extension, when its option is on.
//
// The options are read HERE, not in the core: which of this backend's options name a source or switch the
// tool on is this backend's declaration (`appliedBy` on each field).
'use strict';

const subagentTool = require('./subagent-tool');
const resourcesExtension = require('./resources-extension');

const SOURCE_OPTION_ID = 'resourcesFrom';

/**
 * `{ args, cleanup, source, skills, commands, dropped }` for this launch, or null when there is nothing
 * to give.
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
  let dropped = [];
  if (sourceId) {
    if (!resolved || resolved.ok === false) {
      if (log) log.warn(`[session-resources] source ${sourceId} gave nothing: ${(resolved && resolved.reason) || 'no answer'}`);
    } else {
      skills = resolved.skills || [];
      commands = resolved.commands || [];
      dropped = [...(resolved.dropped || [])];
    }
  }
  const args = [];
  for (const skill of skills) args.push('--skill', skill.path);
  let cleanup = null;
  if (subagent || commands.length) {
    const written = resourcesExtension.writeResourcesExtension({ dir, tag, subagent, commands, log });
    if (written) {
      args.push('--extension', written.file);
      cleanup = written.file;
    } else if (commands.length) {
      // No file, no commands — said, rather than a session that silently lacks them.
      for (const c of commands) dropped.push({ path: c.path, kind: 'command', scope: c.scope, reason: 'extension-not-written' });
      commands = [];
    }
  }
  if (!args.length) return sourceId ? { args, cleanup: null, source: sourceId, skills, commands, dropped } : null;
  return { args, cleanup, source: sourceId || null, skills, commands, dropped, subagent: !!subagent };
}

function releaseSessionResources(file, log) {
  resourcesExtension.removeResourcesExtension(file, log);
}

module.exports = { SOURCE_OPTION_ID, buildSessionResources, releaseSessionResources };
