// backends/pi/shared-resources.js — "Resources from": another backend's skills in a Pi session (#632).
//
// The core resolves WHAT the chosen source offers for this launch (`src/app/resource-sources.js`: which
// directories, and which were dropped because the project is not trusted). This file decides how Pi is
// given them, because that is Pi's business:
//
//   - a skill directory goes on the command line as `--skill <dir>`. Pi reads the same SKILL.md shape the
//     other CLIs write (measured: a Claude skill ran unchanged, spec 30). Pi appends such paths AFTER its
//     own resources and keeps the first of two equal names, so a skill of the user's own Pi setup wins
//     over the source's — the rule "None means Pi's own; a source only adds";
//   - commands are not handed over yet. `--prompt-template` would leave a Claude command's `` !`…` `` and
//     `@file` as text (measured), so they wait for the per-spawn extension that expands them (step 3).
//
// Nothing is written: a flag naming an existing directory needs no file and no release.
'use strict';

// The option the user sets. Read here, not in the core: which of its options names a source is this
// backend's declaration (`appliedBy` on the field), the same way #569 and #634 read theirs.
const OPTION_ID = 'resourcesFrom';

/**
 * `{ args, source, skills, dropped }` for this launch, or null when no source is chosen.
 *
 * `resolveSource(sourceId)` is the core's resolver, bound to this target, project and options. The answer
 * has the resolver's shape: a promise when it returns one (the spawn path), the value itself when it does
 * not — which is what lets `scripts/managed-flags.js` derive the flag synchronously, the way it derives
 * every other flag this backend can send.
 */
function buildSharedResources({ options, resolveSource, log } = {}) {
  const sourceId = options && typeof options[OPTION_ID] === 'string' ? options[OPTION_ID].trim() : '';
  if (!sourceId || typeof resolveSource !== 'function') return null;
  const resolved = resolveSource(sourceId);
  if (resolved && typeof resolved.then === 'function') {
    return resolved.then((value) => finish(sourceId, value, log));
  }
  return finish(sourceId, resolved, log);
}

function finish(sourceId, resolved, log) {
  if (!resolved || resolved.ok === false) {
    if (log) log.warn(`[shared-resources] source ${sourceId} gave nothing: ${(resolved && resolved.reason) || 'no answer'}`);
    return null;
  }
  const args = [];
  for (const skill of resolved.skills || []) args.push('--skill', skill.path);
  const dropped = [...(resolved.dropped || [])];
  // Commands are resolved but not passed yet (see the header) — reported, so the gap is visible in the log.
  for (const command of resolved.commands || []) {
    dropped.push({ path: command.path, kind: 'command', scope: command.scope, reason: 'not-yet-supported' });
  }
  return { args, source: sourceId, skills: resolved.skills || [], dropped };
}

module.exports = { OPTION_ID, buildSharedResources };
