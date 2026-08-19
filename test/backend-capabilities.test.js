'use strict';
// The capability matrix (#439). What a backend says it can do is DECLARED on its descriptor, and this
// file is the reason that declaration can be trusted: it refuses a gap, refuses a half-answer with no
// explanation, and refuses a `yes` whose hook is not there.
const test = require('node:test');
const assert = require('node:assert/strict');

const capabilities = require('../src/backends/capabilities');
const { CATALOG, CATALOG_IDS, STATES, answersFor, normalizeAnswer, catalogForRenderer } = capabilities;
const BACKENDS = require('../src/backends').list().filter(b => b.status === 'ready' && !b.isProfile);
const matrix = require('../src/renderer/panels/backend-capabilities');

// THE PINNED ANSWERS. One entry per backend and per capability, in the shape of `PAGE_KEY_TARGETS` in
// terminal-page-scroll.test.js and for the same reason: a change to any backend's answer has to fail
// HERE, by name, so whoever makes it says so out loud by editing this table.
//
// A loop asserting the same value across all backends would be the defect this guards against — it
// passes exactly when everything was moved together, which is the one case worth catching.
const PINNED = {
  claude: {
    fork: 'yes', deleteSessions: 'yes', moveProject: 'yes', transcriptHandoff: 'yes', lineage: 'yes',
    modelList: 'no', endpoint: 'yes', projectTrust: 'yes',
    subagentSessions: 'yes', liveOwners: 'yes', liveRebinding: 'yes', quota: 'yes',
    resourceDiscovery: 'yes', resourceDepth: 'yes', plans: 'yes', projectConfig: 'yes',
    viewportPaging: 'no',
  },
  codex: {
    fork: 'limited', deleteSessions: 'yes', moveProject: 'yes', transcriptHandoff: 'yes', lineage: 'no',
    modelList: 'no', endpoint: 'no', projectTrust: 'yes',
    subagentSessions: 'no', liveOwners: 'no', liveRebinding: 'no', quota: 'limited',
    resourceDiscovery: 'yes', resourceDepth: 'yes', plans: 'no', projectConfig: 'no',
    viewportPaging: 'yes',
  },
  hermes: {
    fork: 'no', deleteSessions: 'no', moveProject: 'no', transcriptHandoff: 'yes', lineage: 'yes',
    modelList: 'no', endpoint: 'no', projectTrust: 'no',
    subagentSessions: 'no', liveOwners: 'no', liveRebinding: 'no', quota: 'no',
    resourceDiscovery: 'limited', resourceDepth: 'yes', plans: 'no', projectConfig: 'no',
    viewportPaging: 'yes',
  },
  pi: {
    fork: 'limited', deleteSessions: 'yes', moveProject: 'yes', transcriptHandoff: 'yes', lineage: 'limited',
    modelList: 'yes', endpoint: 'no', projectTrust: 'yes',
    subagentSessions: 'no', liveOwners: 'no', liveRebinding: 'yes', quota: 'no',
    resourceDiscovery: 'yes', resourceDepth: 'yes', plans: 'no', projectConfig: 'no',
    viewportPaging: 'yes',
  },
  agy: {
    fork: 'no', deleteSessions: 'yes', moveProject: 'no', transcriptHandoff: 'yes', lineage: 'no',
    modelList: 'yes', endpoint: 'no', projectTrust: 'no',
    subagentSessions: 'no', liveOwners: 'no', liveRebinding: 'no', quota: 'yes',
    resourceDiscovery: 'yes', resourceDepth: 'yes', plans: 'no', projectConfig: 'no',
    viewportPaging: 'yes',
  },
};

// Is the descriptor field behind a row actually there? `false` and `null` count as absent on purpose —
// `supportsFork: false` and `plansDir: () => null` are how a backend DECLINES, and a row claiming `yes`
// over a decline is exactly the drift this check exists for.
function fieldPresent(descriptor, field) {
  const value = descriptor[field];
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

test('the catalog is well formed', () => {
  const groupIds = new Set(capabilities.GROUPS.map(g => g.id));
  const seen = new Set();
  for (const row of CATALOG) {
    assert.ok(row.id && !seen.has(row.id), `duplicate or missing capability id: ${row.id}`);
    seen.add(row.id);
    assert.ok(row.label && row.description, `${row.id}: a row needs a label and a description`);
    assert.ok(groupIds.has(row.group), `${row.id}: unknown group "${row.group}"`);
  }
});

test('every ready backend answers every capability', () => {
  for (const backend of BACKENDS) {
    const answers = answersFor(backend);
    for (const id of CATALOG_IDS) {
      assert.ok(STATES.includes(answers[id].state),
        `${backend.id} does not answer "${id}" — every backend answers every row, declining included`);
    }
  }
});

test('a limited answer says what is limited', () => {
  for (const backend of BACKENDS) {
    const answers = answersFor(backend);
    for (const id of CATALOG_IDS) {
      if (answers[id].state !== 'limited') continue;
      assert.ok(answers[id].note,
        `${backend.id}.${id} is "limited" with no note — a half-yes that does not say which half is worse than a no`);
    }
  }
});

test('a "yes" is backed by the hook it claims', () => {
  for (const backend of BACKENDS) {
    const answers = answersFor(backend);
    for (const row of CATALOG) {
      if (!row.declaredBy || answers[row.id].state !== 'yes') continue;
      assert.ok(fieldPresent(backend, row.declaredBy),
        `${backend.id}.${row.id} says "yes" but declares no ${row.declaredBy} — the declaration has drifted from the descriptor`);
    }
  }
});

test('the page-key row agrees with the descriptor it describes', () => {
  // The one row whose descriptor field is a value rather than a presence, so the generic check above
  // cannot see a mismatch: 'viewport' means the app pages, 'pty' means the CLI's TUI does.
  for (const backend of BACKENDS) {
    const answer = answersFor(backend).viewportPaging;
    assert.equal(answer.state === 'yes', backend.pageKeyTarget === 'viewport',
      `${backend.id}: viewportPaging says "${answer.state}" but pageKeyTarget is "${backend.pageKeyTarget}"`);
  }
});

test('the answers are the pinned ones', () => {
  assert.deepEqual(BACKENDS.map(b => b.id).sort(), Object.keys(PINNED).sort(),
    'a backend was added or removed — pin its answers in PINNED above');
  for (const backend of BACKENDS) {
    const answers = answersFor(backend);
    for (const id of CATALOG_IDS) {
      assert.equal(answers[id].state, PINNED[backend.id][id],
        `${backend.id}.${id} changed to "${answers[id].state}" — pinned as "${PINNED[backend.id][id]}"`);
    }
  }
});

test('a template inherits its base backend\'s answers', () => {
  // A template runs the base's binary, so it can do what the base can. Without the forward in
  // profileToDescriptor every template would answer "unknown" to every row.
  const { profileToDescriptor } = require('../src/backends');
  if (typeof profileToDescriptor !== 'function') return;   // not exported: nothing to assert here
  const template = profileToDescriptor({ id: 't1', name: 'T', backendId: 'claude' });
  assert.deepEqual(answersFor(template), answersFor(BACKENDS.find(b => b.id === 'claude')));
});

test('a malformed declaration reads as unknown, not as a no', () => {
  assert.deepEqual(normalizeAnswer('maybe'), { state: 'unknown', note: null });
  assert.deepEqual(normalizeAnswer(undefined), { state: 'unknown', note: null });
  assert.deepEqual(normalizeAnswer({ state: 'limited' }), { state: 'limited', note: null });
  assert.deepEqual(normalizeAnswer({ state: 'limited', note: '  x  ' }), { state: 'limited', note: 'x' });
  assert.deepEqual(normalizeAnswer('yes'), { state: 'yes', note: null });
});

// --- what the renderer does with it -------------------------------------------------------------

test('templates get no column, built-ins do — switched off or not', () => {
  const columns = matrix.capabilityColumns([
    { id: 'a', label: 'A', status: 'ready', enabled: true, capabilities: {} },
    { id: 'b', label: 'B', status: 'ready', enabled: false, capabilities: {} },
    { id: 'c', label: 'C', status: 'planned', enabled: true, capabilities: {} },
    { id: 't', label: 'T', status: 'ready', enabled: true, isProfile: true, capabilities: {} },
  ]);
  assert.deepEqual(columns.map(c => c.id), ['a', 'b']);
  assert.equal(columns[1].disabled, true);
});

test('the matrix renders every catalog row and every backend', () => {
  const catalog = catalogForRenderer();
  const columns = matrix.capabilityColumns(BACKENDS.map(b => ({ ...b, capabilities: answersFor(b) })));
  const html = matrix.capabilityMatrixHtml(catalog, columns);
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  for (const row of catalog.rows) assert.ok(html.includes(esc(row.label)), `matrix omits the row "${row.id}"`);
  for (const column of columns) assert.ok(html.includes(column.label), `matrix omits the backend "${column.id}"`);
});

test('a note reaches the cell, escaped', () => {
  const catalog = { groups: [{ id: 'g', label: 'G' }], rows: [{ id: 'r', group: 'g', label: 'R', description: 'D' }] };
  const html = matrix.capabilityMatrixHtml(catalog, [
    { id: 'x', label: 'X', answers: { r: { state: 'limited', note: 'only <after> the first turn' } } },
  ]);
  assert.ok(html.includes('only &lt;after&gt; the first turn'), 'the note is rendered');
  assert.ok(!html.includes('<after>'), 'the note is escaped');
});

test('an unanswered row is drawn as a gap, not as a no', () => {
  const catalog = { groups: [{ id: 'g', label: 'G' }], rows: [{ id: 'r', group: 'g', label: 'R', description: 'D' }] };
  const html = matrix.capabilityMatrixHtml(catalog, [{ id: 'x', label: 'X', answers: {} }]);
  assert.ok(html.includes('cap-unknown'), 'an unanswered row is visibly unanswered');
});
