'use strict';
// Which backends a review (#507 slice 2b, spec 39) or a task (#804, spec 41) may run on, and with which options.
//
// A target is a backend that DECLARES it: a profile hook (`reviewProfile()` for a review, `taskProfile()` for a task)
// that answers `{ options }`, a pipe (`transport`) and an `rpc.assistantTextOf` the runner reads the answer through. A
// template is never a target (`isProfile`): a run starts the built-in driver with its own profile. Of those, only the
// ones the registry can launch right now are offered. No backend is named here; each answers for itself in its own
// folder. Pure: the caller hands the descriptors and the launchable ids (`backends.list()`, `backends.launchableIds()`),
// so the tests need no registry.

/** The profile a descriptor declares through `hook`, or null. A throwing or malformed answer is no profile. */
function profileOf(descriptor, hook = 'reviewProfile') {
  if (!descriptor || typeof descriptor[hook] !== 'function') return null;
  let profile = null;
  try { profile = descriptor[hook](); } catch { return null; }
  if (!profile || typeof profile !== 'object' || !profile.options || typeof profile.options !== 'object') return null;
  return profile;
}

function targetsBy(hook, descriptors, launchable) {
  if (!launchable || typeof launchable.has !== 'function') return [];
  const out = [];
  for (const d of Array.isArray(descriptors) ? descriptors : []) {
    if (!d || typeof d.id !== 'string' || d.isProfile) continue;
    if (!d.transport || !d.rpc || typeof d.rpc.assistantTextOf !== 'function') continue;
    if (!launchable.has(d.id)) continue;
    const profile = profileOf(d, hook);
    if (!profile) continue;
    out.push({ id: d.id, label: String(d.label || d.id), options: { ...profile.options } });
  }
  return out;
}

/**
 * -> [{ id, label, options }] — the backends a review can start on, in the order given. `launchable` is a Set of ids;
 * without one nothing is offered.
 */
function reviewTargets(descriptors, launchable) {
  return targetsBy('reviewProfile', descriptors, launchable);
}

/** -> [{ id, label, options }] — the backends a writing task can start on, the same rule over `taskProfile`. */
function taskTargets(descriptors, launchable) {
  return targetsBy('taskProfile', descriptors, launchable);
}

module.exports = { reviewTargets, taskTargets, profileOf };
