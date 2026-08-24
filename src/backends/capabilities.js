// backends/capabilities.js — the catalog of "what can this backend actually do", and the normalizer
// that turns a descriptor's declaration into one answer per row (#439).
//
// WHY THE ANSWER IS DECLARED AND NOT DERIVED. The obvious implementation is
// `typeof descriptor.someHook === 'function'`, and it produces a matrix that is wrong. Nearly every
// hook exists on every backend: `plansDir`, `memorySources`, `resolveLineage`, `cliHomeEnv`,
// `transcriptPathFor` and `listResources` are declared by all five, and several of them are declared
// precisely in order to DECLINE — agy's `cliHomeEnv` returns null, Codex' `resolveLineage` returns
// null, Hermes' `plansDir` returns null. Presence says a backend answered the question, not what it
// answered. Two backends enumerate their skill files and two stop at the directory, through the same
// hook name.
//
// So each backend states its own answer here, and the derivation survives only as a CHECK: a row that
// claims `yes` while its hook is absent fails `test/backend-capabilities.test.js`. Declaration can
// drift from reality; that test is what stops it drifting silently.
//
// The catalog is keyed by CAPABILITY, never by backend id — it is the same question asked of every
// backend, so it belongs in the core rather than in the renderer (which may hold no per-backend table
// at all) and not in any one backend's folder.
'use strict';

// The three answers a backend may give. `limited` REQUIRES a note: a half-yes that does not say what
// is missing is worse than a plain no, because the reader cannot tell which half they get.
const STATES = ['yes', 'limited', 'no'];

// Row groups, in display order.
const GROUPS = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'models', label: 'Models & launch' },
  { id: 'live', label: 'Live status' },
  { id: 'resources', label: 'Resources' },
  { id: 'terminal', label: 'Terminal' },
];

// The rows, in display order within their group.
//
// `label` and `description` are written for someone deciding which backend to use, so a row names what
// the app can DO, never the hook behind it. `declaredBy` is the descriptor field the consistency check
// reads; a row with none (resourceDepth) has no single field that could answer for it.
const CATALOG = [
  {
    id: 'fork',
    group: 'sessions',
    label: 'Fork a session',
    description: 'Start a new session that continues an existing one, from the sidebar.',
    declaredBy: 'supportsFork',
  },
  {
    id: 'deleteSessions',
    group: 'sessions',
    label: "Delete a project's sessions",
    description: 'Remove this backend\'s transcripts for a project when the project is removed.',
    declaredBy: 'deleteSessions',
  },
  {
    id: 'moveProject',
    group: 'sessions',
    label: "Move a project's sessions",
    description: 'Follow a project to a new path instead of leaving its sessions behind at the old one.',
    declaredBy: 'rewriteProjectPath',
  },
  {
    id: 'transcriptHandoff',
    group: 'sessions',
    label: 'Hand a transcript to another agent',
    description: 'Give a fresh session a readable copy of an older one.',
    declaredBy: 'transcriptAccess',
  },
  {
    id: 'lineage',
    group: 'sessions',
    label: 'Show where a session came from',
    description: 'Link a session to the one it was forked or continued from.',
    declaredBy: 'resolveLineage',
  },
  {
    id: 'modelList',
    group: 'models',
    label: 'Pick a model from a list',
    description: 'Offer the backend\'s own model names in the configure dialog instead of a free-text box.',
    declaredBy: 'listModels',
  },
  {
    id: 'endpoint',
    group: 'models',
    label: 'Point it at another endpoint',
    description: 'Run the same CLI against a different API host through a template.',
    declaredBy: 'endpointEnv',
  },
  {
    id: 'projectTrust',
    group: 'models',
    label: "Manage the CLI's project trust",
    description: 'Answer the "do you trust this directory" gate from the project manager.',
    declaredBy: 'projectTrust',
  },
  {
    // Not `subagents`: that bare word in quotes is Claude's on-disk store layout, and
    // `test/backend-path-neutrality.test.js` refuses it outside Claude's own folder. The guard cannot
    // tell a layout literal from a capability id, and it is right not to try.
    id: 'subagentSessions',
    group: 'live',
    label: 'Subagents',
    description: 'Show the agents a session spawned as sessions of their own.',
    declaredBy: 'supportsSubagents',
  },
  {
    id: 'liveOwners',
    group: 'live',
    label: 'Warn before resuming a busy session',
    description: 'Ask the CLI whether another process already holds this session.',
    declaredBy: 'liveOwnersCached',
  },
  {
    id: 'liveRebinding',
    group: 'live',
    label: 'Follow a session that renames itself',
    description: 'Keep a running terminal attached when the CLI moves it to a new session id.',
    declaredBy: 'supportsLiveRebinding',
  },
  {
    id: 'quota',
    group: 'live',
    label: 'Quota in the status bar',
    description: 'Report how much of the plan allowance is left.',
    declaredBy: 'usage',
  },
  {
    id: 'resourceDiscovery',
    group: 'resources',
    label: 'Find its settings, skills and rules',
    description: 'List the files and directories this CLI reads its own configuration from.',
    declaredBy: 'listResources',
  },
  {
    id: 'resourceDepth',
    group: 'resources',
    label: 'List what is inside those directories',
    description: 'Name the individual skills, rules and hooks, not only the directory holding them.',
    declaredBy: 'expandResource',
  },
  {
    id: 'resourceWrite',
    group: 'resources',
    label: 'Edit those files in the app',
    description: 'Whether a skill, rule or settings file this backend lists can be saved from Switchboard, or only read.',
    declaredBy: 'resourceEditing',
  },
  {
    id: 'skillInvoke',
    group: 'resources',
    label: 'Run one of its skills from the prompt',
    description: 'Whether the skill picker can hand a skill over as this CLI\'s own command, or has to insert it as a reference the CLI then reads.',
    declaredBy: 'skillInvocation',
  },
  {
    id: 'plans',
    group: 'resources',
    label: 'Plan documents',
    description: 'Show the plans this CLI writes in the Plans tab.',
    declaredBy: 'plansDir',
  },
  {
    id: 'planDirSetting',
    group: 'resources',
    label: 'Plans directory per project',
    description: 'Can be pointed at a project\'s own plans directory, so a plan written in one CLI can be read by another.',
    declaredBy: 'planDirSetup',
  },
  {
    id: 'projectConfig',
    group: 'resources',
    label: 'Per-project config outside the project',
    description: 'Read and edit what the CLI records about a project in its own home.',
    declaredBy: 'projectMeta',
  },
  {
    id: 'viewportPaging',
    group: 'terminal',
    label: "PageUp/PageDown scrolls Switchboard's scrollback",
    description: 'Whether the bare page keys scroll the terminal here or reach the CLI\'s own TUI.',
    declaredBy: 'pageKeyTarget',
  },
];

const CATALOG_IDS = CATALOG.map(c => c.id);

// A declaration is either a bare state (`'yes'`) or a state with a note (`{ state, note }`). Anything
// else is a defect and comes back as `unknown` rather than being guessed at — the test fails on it, and
// the matrix shows it as unanswered instead of quietly reading like a no.
function normalizeAnswer(raw) {
  if (typeof raw === 'string') {
    return STATES.includes(raw) ? { state: raw, note: null } : { state: 'unknown', note: null };
  }
  if (raw && typeof raw === 'object' && STATES.includes(raw.state)) {
    const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : null;
    return { state: raw.state, note };
  }
  return { state: 'unknown', note: null };
}

// One answer per catalog row, for one descriptor. A backend that says nothing about a row gets
// `unknown` — an explicit gap, because a silent `no` would let a forgotten row look like a decision.
function answersFor(descriptor) {
  const declared = (descriptor && descriptor.capabilities) || {};
  const out = {};
  for (const entry of CATALOG) {
    out[entry.id] = normalizeAnswer(declared[entry.id]);
  }
  return out;
}

// What crosses IPC once per `backends-list` payload, so the renderer holds no labels of its own.
function catalogForRenderer() {
  return {
    groups: GROUPS.map(g => ({ ...g })),
    rows: CATALOG.map(c => ({ id: c.id, group: c.group, label: c.label, description: c.description })),
  };
}

module.exports = { STATES, GROUPS, CATALOG, CATALOG_IDS, normalizeAnswer, answersFor, catalogForRenderer };
