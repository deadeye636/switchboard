// app/resource-sources.js — which of ANOTHER backend's resources a session takes over (#632).
//
// "Resources from: Claude" on a Pi session means: the skills and commands the user keeps for Claude are
// offered in that Pi session too, so switching CLIs does not lose them. This module is the one answer to
// "what exactly would be handed over", asked by the spawn path (what goes on the command line) and by the
// settings screen (what the preview shows), so the two cannot disagree.
//
// NEUTRAL BY CONSTRUCTION. No backend is named here:
//   - a SOURCE declares `sharedResources` — which of its `listResources` rows may leave it, by `source`,
//     plus a `commandDialect` describing its command files (data, because the target expands them inside
//     its own process);
//   - a TARGET declares `acceptsSharedResources` (the kinds it can take) and `trustsProjectResources`
//     (whether this launch may be handed a source's project-scope directories — owner decision E1).
// A backend that declares `sharedResources: null` and no accepted kinds is neither, and the settings screen
// shows it no choice. Every built-in declares the first explicitly (test/backend-parity.test.js).
//
// ONE source at a time (owner decision E9). Two sources would collide by name, the first found would win,
// and nobody could tell which `/review` was running. The cascade (default → global → project) is what
// lets a project pick a different source than the global setting.
'use strict';

let registry = null;

function backendsRegistry() {
  // Lazy, so a test can hand in a stub registry through `init` without the real one ever loading.
  if (!registry) registry = require('../backends');
  return registry;
}

function init({ backends } = {}) {
  registry = backends || null;
}

function asDescriptor(backendOrId) {
  if (!backendOrId) return null;
  if (typeof backendOrId === 'object') return backendOrId;
  return backendsRegistry().get(backendOrId) || null;
}

function acceptedKinds(target) {
  return target && Array.isArray(target.acceptsSharedResources) ? target.acceptsSharedResources : [];
}

function offers(descriptor) {
  const shared = descriptor && descriptor.sharedResources;
  return !!(shared && Array.isArray(shared.sources) && shared.sources.length);
}

/**
 * The backends a target could take resources from: `[{ id, label }]`, empty for a target that takes none.
 *
 * Built-in backends only. A template reads its base's store, so offering it too would list the same
 * directories a second time under another name (`sharedResources` is in NOT_INHERITED for that reason).
 * Whether the source is ENABLED does not matter: its directories are read as files, and a user who
 * switched Claude off in favour of Pi is exactly the one who wants Claude's skills to follow.
 */
function sourcesFor(targetOrId) {
  const target = asDescriptor(targetOrId);
  if (!acceptedKinds(target).length) return [];
  const out = [];
  for (const b of backendsRegistry().list()) {
    if (!b || b.isProfile || b.status === 'planned') continue;
    if (b.id === target.id || (target.baseId && b.id === target.baseId)) continue;
    const descriptor = asDescriptor(b.id);
    if (!offers(descriptor)) continue;
    out.push({ id: descriptor.id, label: descriptor.label || descriptor.id });
  }
  return out;
}

/**
 * What a launch of `target` in `projectPath` would take over from `sourceId`.
 *
 * Returns `{ ok, source, skills, commands, dropped }`:
 *   - `skills`   — `[{ path, scope }]`, directories in the source's own layout;
 *   - `commands` — `[{ path, scope, dialect }]`, directories of command files and how to read them;
 *   - `dropped`  — `[{ path, kind, scope, reason }]`, what the source has but this launch does not get,
 *                  so the preview can say so instead of leaving it out silently.
 * An empty or unknown source is not an error: it answers with nothing to hand over.
 */
async function resolve({ target: targetOrId, sourceId, projectPath = null, options = {} } = {}) {
  const empty = { ok: true, source: null, skills: [], commands: [], dropped: [] };
  const target = asDescriptor(targetOrId);
  const kinds = acceptedKinds(target);
  if (!sourceId || !kinds.length) return empty;
  if (!sourcesFor(target).some((s) => s.id === sourceId)) {
    return { ...empty, ok: false, reason: 'That backend offers no resources to this one.' };
  }
  const source = asDescriptor(sourceId);
  const shared = source.sharedResources;
  const sources = new Set(shared.sources);

  let listed;
  try {
    listed = await source.listResources({ projectPath: projectPath || null });
  } catch {
    return { ...empty, ok: false, source: sourceId, reason: 'The source backend\'s resources could not be listed.' };
  }
  if (!listed || listed.ok === false || !Array.isArray(listed.resources)) {
    return { ...empty, ok: false, source: sourceId, reason: (listed && listed.reason) || 'The source backend listed no resources.' };
  }

  // Asked once, not per row: the answer is about the launch, not about a directory.
  let projectTrusted = false;
  if (projectPath && typeof target.trustsProjectResources === 'function') {
    try { projectTrusted = target.trustsProjectResources({ projectPath, options }) === true; } catch { projectTrusted = false; }
  }

  const out = { ok: true, source: sourceId, skills: [], commands: [], dropped: [] };
  for (const row of listed.resources) {
    if (!row || !row.path || !sources.has(row.source)) continue;
    if (!kinds.includes(row.kind)) continue;
    const scope = row.scope === 'project' ? 'project' : 'global';
    if (scope === 'project' && !projectTrusted) {
      out.dropped.push({ path: row.path, kind: row.kind, scope, reason: 'untrusted-project' });
      continue;
    }
    if (row.kind === 'skill') {
      out.skills.push({ path: row.path, scope });
    } else if (row.kind === 'command') {
      if (!shared.commandDialect) {
        out.dropped.push({ path: row.path, kind: row.kind, scope, reason: 'no-command-dialect' });
        continue;
      }
      out.commands.push({ path: row.path, scope, dialect: shared.commandDialect });
    }
  }
  return out;
}

// The token a `select` field declares INSTEAD of listing its choices (#632 step 4). Its choices are the
// backends this one may take resources from, and the backend's own folder cannot spell those without naming
// other backends — so the field says where its choices come from, and the core fills them in where every
// form reads the fields from (`backends-list`). Not dynamic at run time: which backends offer something is
// fixed for the life of the process, and enabling one does not matter (owner decision S1).
const SOURCE_CHOICES = 'sharedResourceSources';

/**
 * A descriptor's `configFields` as the forms should see them: a field declaring
 * `choicesFrom: 'sharedResourceSources'` gets one choice per source `sourcesFor` lists, labelled with the
 * source's own label, after the choices it declared itself (its "None"). It is also marked `sourcePreview`,
 * which is what tells the settings screen to offer the preview below it without knowing the field's id.
 * Every other field is returned as it is, and so is the array when no field asks.
 */
function projectFields(targetOrId) {
  const target = asDescriptor(targetOrId);
  const fields = target && Array.isArray(target.configFields) ? target.configFields : [];
  if (!fields.some((f) => f && f.choicesFrom === SOURCE_CHOICES)) return fields;
  const sources = sourcesFor(target);
  return fields.map((f) => {
    if (!f || f.choicesFrom !== SOURCE_CHOICES) return f;
    const choices = Array.isArray(f.choices) ? [...f.choices] : [];
    const choiceLabels = { ...(f.choiceLabels || {}) };
    for (const s of sources) {
      if (!choices.includes(s.id)) choices.push(s.id);
      if (!Object.prototype.hasOwnProperty.call(choiceLabels, s.id)) choiceLabels[s.id] = s.label;
    }
    // A preview of "nothing can be taken over" is no preview; the marker follows whether there is a source.
    return { ...f, choices, choiceLabels, sourcePreview: sources.length > 0 };
  });
}

/**
 * What the settings screen shows under the select: `resolve` for the backend on that page, the source the
 * select names now (saved or not) and the options the page shows for that backend, so the trust answer is
 * the one a launch from that scope would get. `projectPath` is null on the global page, where only the
 * source's global directories exist to list.
 *
 * Its input comes from a window, so it is taken apart rather than passed on: strings are strings, and the
 * options are a flat object of primitives. The paths it answers with are the ones `listResources` names —
 * the same rows the Resources disclosure on that page already shows.
 */
async function preview({ backendId, sourceId, projectPath, options } = {}) {
  const target = typeof backendId === 'string' && backendId ? asDescriptor(backendId) : null;
  if (!target) return { ok: false, reason: 'That backend is not known.' };
  const flat = {};
  if (options && typeof options === 'object' && !Array.isArray(options)) {
    for (const [k, v] of Object.entries(options)) {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) flat[k] = v;
    }
  }
  const source = typeof sourceId === 'string' ? sourceId : '';
  const result = await resolve({
    target,
    sourceId: source,
    projectPath: typeof projectPath === 'string' && projectPath ? projectPath : null,
    options: flat,
  });
  const described = source ? sourcesFor(target).find((s) => s.id === source) : null;
  return { ...result, sourceLabel: described ? described.label : null };
}

function registerIpc(ipc) {
  ipc.handle('resource-sources-preview', (_event, request) => preview(request || {}));
}

module.exports = { init, registerIpc, sourcesFor, resolve, projectFields, preview, SOURCE_CHOICES };
