const test = require('node:test');
const assert = require('node:assert/strict');

const backends = require('../src/backends');

// A TEMPLATE inherits by hand, and nothing checked the list (#605).
//
// `profileToDescriptor` (`src/backends/index.js`) builds an Axis-A template's descriptor by copying
// capability after capability off the backend whose binary it borrows. Nothing derives that list and
// nothing compared the two shapes, so a capability added to a base descriptor was simply absent from
// every template until somebody hit the missing behaviour — four times, each as its own issue: #193
// (`resolveLineage`), #211 (`transcriptPathFor` / `projectMeta`), the project manager's
// `rewriteProjectPath` / `deleteSessions`, and #603 (the live-binding family). The symptom is silence
// every time: the template launches, runs and writes its transcript exactly as expected.
//
// So this compares the shapes. Everything a base declares must reach its template, or appear below with
// the reason it does not — and an entry that stops being true fails as well, or the list only grows.
//
// WHAT IS COMPARED. `backends.get(id)` hands back the registry's own descriptor, before `list()` stamps
// `enabled` / `available` / `unavailableReason` onto every entry (templates included), which is why
// those three are not in the table below. A key counts as inherited when the template's value is not
// `undefined`: several forwards are conditional spreads, and a key whose spread did not fire is exactly
// the failure this is looking for.
//
// ITS LIMIT, stated because a guard nobody knows the edge of is trusted too far: this compares PRESENCE,
// never the value. A forward written as `thing: base ? base.thing : false` is non-`undefined` whatever
// the base says, so it passes here while answering `false` for a base that answers `true`. That shape is
// how `supportsSubagents` and `supportsLiveRebinding` are spelled, deliberately — a boolean must have an
// answer — and it is why those two carry named guards of their own in `test/backends.test.js`.
//
// And forwarding a capability is not the end of the question: a consumer that asks a LIST rather than one
// session gets a template and its base as two answers to the same question, which is its own defect
// (`oneAskerPerCli`, #605). This test cannot see that; the wiring guard in `test/backends.test.js` can.
const NOT_INHERITED = {
  // Identity. A template is named by the user, and describing the base's CLI would describe something
  // they did not create.
  description: 'the template is named by whoever made it; the base\'s blurb describes a CLI, not this',

  // One CLI, one entry. Each of these is about the BINARY or the account behind it, and a template
  // shares both with its base — a second entry would be a duplicate under another name.
  usage: 'quota belongs to the account the base authenticates; a template would double the bar',
  changelogSource: 'the base\'s CLI publishes the changelog; scripts/check-backend-changelogs.js filters isProfile out for that reason',
  projectMeta: '#211 — the base\'s ~/.claude.json projects table is keyed by PROJECT PATH, so forwarding it made a template a second meta backend and doubled Claude\'s Info column',
  handoffDirs: '#468 — src/app/handoffs.js filters !b.isProfile and reads the base\'s directories, which is where a template\'s packets already are',
  planRef: 'app/plans-memory.js memoryBackends() filters !b.isProfile, so a template never reaches the plan loop; the base lists and attributes those files',
  planDirSetup: 'same consumer, same filter — the offer to point a project at a plans directory is made once, for the base',
  integrations: 'the attention-hooks toggle writes one shared ~/.claude/settings.json; a per-template switch would be a second control over one file',
  endpointEnv: 'names the variable a template EXISTS to set; its own values are templateEnv',

  // Store internals and root setters. Not descriptor hooks the core dispatches on — main.js sets the
  // roots on the base descriptor, and a template writes into that same store.
  _roots: 'Claude\'s store roots, set on the base descriptor by main.js',
  setRoots: 'the setter for the above',
  setRoot: 'the same setter, agy and pi',
  setHome: 'the same setter, codex and hermes',
  sessionsRoot: 'the base\'s own store path helper',
  conversationsRoot: 'the base\'s own store path helper',
  dbPath: 'the base\'s own store path helper',
  findExecutable: 'a backend module\'s own binary lookup, not a hook the core calls',
  _parseModelList: 'private to the backend module',
  _resetToolchainCache: 'private to the backend module (a test seam)',
  _toolchainCacheState: 'private to the backend module (a test seam)',
  _provesNodeIsAbsent: 'private to the backend module',

  // Reading a store the scanner never asks a template about. `axisBRoster` in `src/backends/scan.js`
  // filters profiles out, so a template is never scanned — its sessions carry its id through the launch
  // overlay instead — and Claude's own readers are imported directly by the workers
  // (`src/workers/scan-projects.js`, `src/index/session-cache.js`) rather than looked up per backend.
  readSessionFile: 'the scan skips templates; the workers import Claude\'s reader directly',
  readSessionFileIncremental: 'the scan skips templates; the workers import Claude\'s reader directly',
  enumerateSessionFiles: 'the scan skips templates',
  resolveJsonlPath: 'internal to Claude\'s own readers; the core asks transcriptPathFor, which IS forwarded',
  readFolderSessions: 'imported directly by src/workers/scan-projects.js, never through a descriptor',
  parseSessionIncremental: 'src/backends/parse.js only reaches it for a backend being SCANNED, and a template is not scanned',
  deriveStateFromFileTail: 'codex-internal; no core caller reaches it through a descriptor',
};

function builtIns() {
  return backends.list().filter((b) => !b.isProfile).map((b) => backends.get(b.id)).filter(Boolean);
}

function missingFrom(base) {
  const template = backends.profileToDescriptor({ id: `tpl-${base.id}`, name: 'A template', backendId: base.id });
  return Object.keys(base).filter((key) => base[key] !== undefined && template[key] === undefined);
}

test('every capability a base declares reaches its templates, or says why not', () => {
  const leftovers = [];
  for (const base of builtIns()) {
    for (const key of missingFrom(base)) {
      if (!NOT_INHERITED[key]) leftovers.push(`${base.id}.${key}`);
    }
  }
  assert.deepEqual(leftovers, [],
    `profileToDescriptor (src/backends/index.js) does not forward these, and nothing says why:\n  ${leftovers.join('\n  ')}\n`
    + 'Forward it, or add the key to NOT_INHERITED in this file with the reason a template must not have it.');
});

test('nothing in NOT_INHERITED has quietly started being inherited', () => {
  // A stale exemption is how one of these lists turns into a place to silence a finding. Any key here
  // that IS forwarded now — or that no backend declares any more — has to go.
  const stillMissing = new Set();
  const everDeclared = new Set();
  for (const base of builtIns()) {
    for (const key of Object.keys(base)) if (base[key] !== undefined) everDeclared.add(key);
    for (const key of missingFrom(base)) stillMissing.add(key);
  }

  // The narrower diagnosis first. A key nothing declares is also missing from every template, so it is in
  // `stillMissing` too — checked the other way round, the stale assert fires on it and reports the wrong
  // reason ("it is inherited now") for a key that has simply gone.
  const unknown = Object.keys(NOT_INHERITED).filter((key) => !everDeclared.has(key));
  assert.deepEqual(unknown, [], `these NOT_INHERITED entries name a key no backend declares any more:\n  ${unknown.join('\n  ')}`);

  const stale = Object.keys(NOT_INHERITED).filter((key) => everDeclared.has(key) && !stillMissing.has(key));
  assert.deepEqual(stale, [], `these NOT_INHERITED entries are forwarded now — remove them:\n  ${stale.join('\n  ')}`);
});

test('every NOT_INHERITED entry carries a reason, not a category', () => {
  for (const [key, reason] of Object.entries(NOT_INHERITED)) {
    assert.equal(typeof reason, 'string', `${key} needs a reason`);
    assert.ok(reason.trim().length > 20, `${key}: "${reason}" is a label, not a reason`);
  }
});
