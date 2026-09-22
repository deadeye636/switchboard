// app/resource-sources.js — which of ANOTHER backend's resources a session takes over (#632).
//
// "Resources from: Claude" on a Pi session means: the skills and commands the user keeps for Claude are
// offered in that Pi session too, so switching CLIs does not lose them. This module is the one answer to
// "what exactly would be handed over", asked by the spawn path (what goes on the command line) and by the
// settings screen (what the preview shows), so the two cannot disagree — except where an MCP definition is
// expanded: the spawn hands in the session's environment, the preview has none and uses this process's (#633).
//
// NEUTRAL BY CONSTRUCTION. No backend is named here:
//   - a SOURCE declares `sharedResources` — which of its `listResources` rows may leave it, by `source`,
//     plus a `commandDialect` and an `agentDialect` describing its command and agent files (data, because
//     the target reads them inside its own process), and optionally `listSharedMcpServers` — its MCP servers
//     as neutral rows, since those are entries in its config files rather than listing rows (#633) — and
//     `listSharedHooks` with a `hookDialect`, its hooks in the same shape and for the same reason (#635);
//   - a TARGET declares `acceptsSharedResources` (the kinds it can take), `trustsProjectResources`
//     (whether this launch may be handed a source's project-scope directories — owner decision E1) and,
//     optionally, `declinesSharedResource` (a kind it accepts but not with this launch's options, #639).
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
 * Returns `{ ok, source, skills, commands, agents, mcpServers, dropped }`:
 *   - `skills`   — `[{ path, scope }]`, directories in the source's own layout;
 *   - `commands` — `[{ path, scope, dialect }]`, directories of command files and how to read them;
 *   - `agents`   — `[{ path, scope, dialect }]`, directories of agent files and how to read them (#639);
 *   - `mcpServers` — `[{ name, scope, origin, path, command, args, env }]`, stdio MCP servers to start (#633).
 *                  `env` routinely carries tokens: it is for the spawn path, and `preview` strips it;
 *   - `hooks`    — `[{ event, sourceEvent, tools, command, timeoutMs, scope, path, dialect }]`, commands of the
 *                  user's to run when the session reaches a moment (#635). `event` is a word from
 *                  `src/backends/hook-events.js`, `tools` the neutral tool words a tool moment is limited
 *                  to (null for every tool);
 *   - `dropped`  — `[{ path, kind, scope, reason, note? }]`, what the source has but this launch does not
 *                  get, so the preview can say so instead of leaving it out silently. `note` is the
 *                  target's own sentence where the TARGET declined the kind (`declinesSharedResource`).
 * An empty or unknown source is not an error: it answers with nothing to hand over.
 */
// `env` is the environment the launch will run with, which a source expands its MCP definitions against
// (`${VAR}`); the preview has no launch and uses this process's own.
async function resolve({ target: targetOrId, sourceId, projectPath = null, options = {}, env = null } = {}) {
  const empty = { ok: true, source: null, skills: [], commands: [], agents: [], mcpServers: [], hooks: [], dropped: [] };
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

  // Whether the target takes a kind it ACCEPTS depends on this launch's options too (#639): Pi runs a source's
  // agents only through its subagent tool, which is off unless somebody switched it on. `acceptsSharedResources`
  // stays a fixed list — the source list and the capability row read it as one — and this optional hook
  // says per launch "not this time", with a note the settings preview shows as it is, because the preview
  // cannot name the option that decided it. Asked once per kind and scope.
  const declined = new Map();
  const declineFor = (kind, scope) => {
    const key = `${kind}|${scope}`;
    if (declined.has(key)) return declined.get(key);
    let answer = null;
    if (typeof target.declinesSharedResource === 'function') {
      try {
        const a = target.declinesSharedResource({ kind, scope, options });
        if (a && typeof a === 'object' && typeof a.reason === 'string' && a.reason) {
          answer = { reason: a.reason, note: typeof a.note === 'string' ? a.note : null };
        }
      } catch {
        // A GATE FAILS CLOSED. This hook is the whole of some switches — for hooks it is the only thing
        // between a command line of the user's and its running — so a target that threw is read as "not
        // this time" rather than as "no objection". The cost of being wrong the other way is a resource
        // withheld and said so; the cost here would be execution nobody switched on.
        answer = { reason: 'target-declined', note: 'not passed: the target could not say whether it takes this' };
      }
    }
    declined.set(key, answer);
    return answer;
  };

  const out = { ok: true, source: sourceId, skills: [], commands: [], agents: [], mcpServers: [], hooks: [], dropped: [] };
  for (const row of listed.resources) {
    if (!row || !row.path || !sources.has(row.source)) continue;
    if (!kinds.includes(row.kind)) continue;
    const scope = row.scope === 'project' ? 'project' : 'global';
    if (scope === 'project' && !projectTrusted) {
      out.dropped.push({ path: row.path, kind: row.kind, scope, reason: 'untrusted-project' });
      continue;
    }
    const declines = declineFor(row.kind, scope);
    if (declines) {
      out.dropped.push({ path: row.path, kind: row.kind, scope, reason: declines.reason, note: declines.note });
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
    } else if (row.kind === 'agent') {
      // An agent file names its source's tools and models; without the dialect that says what they mean,
      // the target could only guess — and the measured guess is a child with no tools at all (#639).
      if (!shared.agentDialect) {
        out.dropped.push({ path: row.path, kind: row.kind, scope, reason: 'no-agent-dialect' });
        continue;
      }
      out.agents.push({ path: row.path, scope, dialect: shared.agentDialect });
    }
  }
  if (kinds.includes(MCP_KIND) && typeof source.listSharedMcpServers === 'function') {
    takeMcpServers({ source, projectPath, projectTrusted, declineFor, env, out });
  }
  if (kinds.includes(HOOK_KIND) && typeof source.listSharedHooks === 'function') {
    takeHooks({ source, shared, projectPath, projectTrusted, declineFor, out });
  }
  return out;
}

// What a target calls an MCP server when it accepts one — core vocabulary, like 'skill' and 'command'.
const MCP_KIND = 'mcp-server';
// …and a hook: a command of the user's, run when the session reaches a moment (#635).
const HOOK_KIND = 'hook';

/**
 * A source's hooks (#635). Config entries rather than listing rows, so the same shape as the MCP servers
 * above: the source answers through `listSharedHooks` with neutral rows, and the rules applied here are the
 * launch's — the target's own "no" for this launch, and a project's hooks only when the target trusts the
 * project.
 *
 * A hook RUNS A COMMAND OF THE USER'S, so the trust rule is the whole guard and there is no second one to
 * fall back on. The source decides scope; this decides whether a `project` scope may run at all.
 *
 * A row the source already declined (a moment with no counterpart, a matcher it could not map) is carried
 * through to `dropped` with the source's own sentence rather than re-worded: it knows why, and a hook that
 * quietly does not fire is the failure this feature is most likely to have.
 */
function takeHooks({ source, shared, projectPath, projectTrusted, declineFor, out }) {
  const globalDecline = declineFor(HOOK_KIND, 'global');
  const projectDecline = declineFor(HOOK_KIND, 'project');
  if (globalDecline && projectDecline) {
    out.dropped.push({ path: null, kind: HOOK_KIND, scope: 'global', reason: globalDecline.reason, note: globalDecline.note });
    return;
  }
  let listed;
  try { listed = source.listSharedHooks({ projectPath: projectPath || null }); } catch { listed = null; }
  if (!listed || listed.ok === false || !Array.isArray(listed.hooks)) return;
  for (const h of listed.hooks) {
    if (!h || typeof h.command !== 'string' || !h.command) continue;
    const scope = h.scope === 'project' ? 'project' : 'global';
    const drop = (reason, note) => out.dropped.push({
      path: h.file || null, kind: HOOK_KIND, scope, event: h.sourceEvent || null, reason, ...(note ? { note } : {}),
    });
    const declines = scope === 'project' ? projectDecline : globalDecline;
    if (declines) { drop(declines.reason, declines.note); continue; }
    // The source's own refusal, kept as it was written.
    if (h.declined) { drop('source-declined', h.declined); continue; }
    if (!h.event) { drop('source-declined', 'the source named no moment for it'); continue; }
    if (scope === 'project' && !projectTrusted) { drop('untrusted-project'); continue; }
    // Without the dialect the target could only guess what the command expects to read, and a hook handed
    // the wrong shape fails in the user's own script rather than here.
    if (!shared.hookDialect) { drop('no-hook-dialect'); continue; }
    out.hooks.push({
      event: h.event,
      // The source's own name for the moment, for a preview to show: `event` is a word of the shared
      // vocabulary and reads as jargon beside the settings the user actually wrote.
      sourceEvent: h.sourceEvent || null,
      tools: Array.isArray(h.tools) ? h.tools.map(String) : null,
      command: h.command,
      timeoutMs: Number.isFinite(h.timeoutMs) && h.timeoutMs > 0 ? h.timeoutMs : DEFAULT_HOOK_TIMEOUT_MS,
      scope,
      path: h.file || null,
      dialect: shared.hookDialect,
    });
  }
}

// What a hook gets when its source named no timeout of its own. Not a policy of the core's: a source that
// knows its CLI's default says so per row, and this is only what is left when none was stated.
const DEFAULT_HOOK_TIMEOUT_MS = 60000;

/**
 * A source's MCP servers (#633). They are entries in the source's config files rather than listing rows, so
 * the source answers through its own hook (`listSharedMcpServers`), in its own precedence order; the rules
 * applied here are the launch's: stdio only (owner decision, MVP), a project's own servers only when the
 * target trusts the project AND the source's user approved them. The FIRST row of a name decides, usable or
 * not: the source CLI would run that definition and no other, so falling through to a lower one of the same
 * name would start a server the source never runs.
 * What is left out is reported with the reason, as for every other kind.
 */
function takeMcpServers({ source, projectPath, projectTrusted, declineFor, env, out }) {
  // A target that declines every MCP server for this launch (a switch that is off) costs no file read: the
  // source's config can be large, a spawn pays for this on every launch, and the answer is one line anyway.
  const globalDecline = declineFor(MCP_KIND, 'global');
  const projectDecline = declineFor(MCP_KIND, 'project');
  if (globalDecline && projectDecline) {
    out.dropped.push({ path: null, name: null, kind: MCP_KIND, scope: 'global', reason: globalDecline.reason, note: globalDecline.note });
    return;
  }
  let listed;
  try { listed = source.listSharedMcpServers({ projectPath: projectPath || null, env: env || process.env }); } catch { listed = null; }
  if (!listed || listed.ok === false || !Array.isArray(listed.servers)) return;
  const seen = new Set();
  for (const s of listed.servers) {
    if (!s || typeof s.name !== 'string' || !s.name) continue;
    const scope = s.scope === 'project' ? 'project' : 'global';
    const drop = (reason, note) => out.dropped.push({
      path: s.path || null, name: s.name, origin: s.origin || null, kind: MCP_KIND, scope, reason, ...(note ? { note } : {}),
    });
    if (seen.has(s.name)) { drop('shadowed'); continue; }
    seen.add(s.name);
    // The launch's own "no" first: a server that would not start anyway is described by that, not by a
    // detail of its definition nobody needs to fix.
    const declines = scope === 'project' ? projectDecline : globalDecline;
    if (declines) { drop(declines.reason, declines.note); continue; }
    if (s.transport !== 'stdio') { drop('transport-unsupported'); continue; }
    if (scope === 'project' && !projectTrusted) { drop('untrusted-project'); continue; }
    if (s.approved === false) { drop('not-approved'); continue; }
    if (Array.isArray(s.missingEnv) && s.missingEnv.length) { drop('missing-env', `not started: ${s.missingEnv.join(', ')} has no value`); continue; }
    if (typeof s.command !== 'string' || !s.command) { drop('no-command'); continue; }
    out.mcpServers.push({
      name: s.name, scope, origin: s.origin || null, path: s.path || null,
      command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [], env: s.env && typeof s.env === 'object' ? { ...s.env } : {},
    });
  }
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
  // A server's env and arguments can carry tokens, and this answer goes to a window: name and command only.
  const mcpServers = (result.mcpServers || []).map((s) => ({ name: s.name, scope: s.scope, origin: s.origin, path: s.path, command: s.command }));
  // A hook's command is shown as the user wrote it — it is the one thing worth reading before agreeing to
  // run it, and it is theirs. The DIALECT is dropped: it is data for the target, and nothing to look at.
  const hooks = (result.hooks || []).map((h) => ({
    event: h.sourceEvent || h.event, tools: h.tools, command: h.command, timeoutMs: h.timeoutMs, scope: h.scope, path: h.path,
  }));
  return { ...result, mcpServers, hooks, sourceLabel: described ? described.label : null };
}

function registerIpc(ipc) {
  ipc.handle('resource-sources-preview', (_event, request) => preview(request || {}));
}

module.exports = { init, registerIpc, sourcesFor, resolve, projectFields, preview, SOURCE_CHOICES };
