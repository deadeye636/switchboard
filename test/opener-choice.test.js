'use strict';
// #670 — a per-session choice of which backend of an owner/driver pair OPENS a session: the owner
// ("Terminal") or a driver of it ("GUI"). S1: storage, routing, payload and the spawn.
//
// Four seams, each against the real module:
//   - the registry's one routing function, `openerFor(row, storedChoice, launchable)`, and the spawn's
//     validation `isOpenerFor`;
//   - the sidebar payload (`projects-view.js`) carries the effective opener, the owner, and whether a choice
//     is stored;
//   - the spawn path (`app/terminal/spawn.js`): an explicit choice is validated in main, stored only after a
//     successful spawn, refused against a live session in the other view; a stored choice wins over the
//     launch record;
//   - a re-key copies the choice to the new id (`session-transitions.js`, `watch/adopt.js`).
//
// The meta-store's SQL is not loaded here (no test loads db.js — `.claude/rules/db.md`); the migration is
// pinned by `test/db-migrations.test.js` and checked with `scripts/db-migrate-probe.js`.
const test = require('node:test');
const assert = require('node:assert/strict');

const backends = require('../src/backends');
const profiles = require('../src/backends/profiles');

// A driver of an owner that is registered for this file only (node runs each test file in its own process).
// The owner is a registered stand-in too, so the answers do not depend on which real CLIs this machine has.
const OWNER = 'test-670-owner';
const DRIVER = 'test-670-driver';
const OTHER = 'test-670-other';
backends.register({ id: OWNER, label: 'Owner', status: 'ready', buildLaunch: () => ({ command: 'x', args: [] }) });
backends.register({ id: DRIVER, label: 'Owner (GUI)', status: 'ready', transport: 'rpc', transcriptsOf: OWNER });
backends.register({ id: OTHER, label: 'Other', status: 'ready' });

function withSettings(backendEnabled, templates, fn) {
  const store = { list: () => templates || [], get: (id) => (templates || []).find(p => p.id === id) || null };
  backends.init({ getGlobalSettings: () => ({ backendEnabled }), profiles: store });
  try { return fn(); } finally { backends.init({ getGlobalSettings: () => ({}), profiles }); }
}

const ALL = new Set([OWNER, DRIVER, OTHER]);

// --- openerFor ---------------------------------------------------------------------------------------

test('openerFor: no choice and no transport is the owner, without asking anything', () => {
  const throwing = { has() { throw new Error('asked'); } };
  assert.equal(backends.openerFor({ backendId: OWNER }, null, throwing), OWNER);
});

test('openerFor: a stored GUI choice opens in the driver, without the transport match', () => {
  assert.equal(backends.openerFor({ backendId: OWNER }, DRIVER, ALL), DRIVER);
  assert.equal(backends.openerFor({ backendId: OWNER, transport: 'other-pipe' }, DRIVER, ALL), DRIVER);
});

test('openerFor: a stored Terminal choice beats the marker', () => {
  assert.equal(backends.openerFor({ backendId: OWNER, transport: 'rpc' }, null, ALL), DRIVER, 'the marker alone');
  assert.equal(backends.openerFor({ backendId: OWNER, transport: 'rpc' }, OWNER, ALL), OWNER, 'the choice wins');
});

test('openerFor: a driver that cannot launch falls back to today\'s route — switched off or not installed alike', () => {
  const driverOut = new Set([OWNER, OTHER]);
  assert.equal(backends.openerFor({ backendId: OWNER }, DRIVER, driverOut), OWNER);
  assert.equal(backends.openerFor({ backendId: OWNER, transport: 'rpc' }, DRIVER, driverOut), OWNER);
});

test('openerFor: the owner off with a stored Terminal choice falls through to the marker routing', () => {
  const ownerOut = new Set([DRIVER, OTHER]);
  assert.equal(backends.openerFor({ backendId: OWNER }, OWNER, ownerOut), OWNER,
    'unmarked: the owner, which the spawn then refuses as disabled — as today');
  assert.equal(backends.openerFor({ backendId: OWNER, transport: 'rpc' }, OWNER, ownerOut), DRIVER,
    'marked: the marker decides, as it would for a row nobody chose for');
});

test('openerFor: a stored id that is neither the owner nor its driver is ignored', () => {
  assert.equal(backends.openerFor({ backendId: OWNER }, OTHER, ALL), OWNER);
  assert.equal(backends.openerFor({ backendId: OWNER }, 'no-such-backend', ALL), OWNER);
  assert.equal(backends.openerFor({ backendId: OTHER }, DRIVER, ALL), OTHER, 'a driver of someone else');
});

test('openerFor: a template row is never owner or driver — it opens as itself whatever is stored', () => {
  withSettings({ [OWNER]: true }, [{ id: 'tpl-670', backendId: OWNER, label: 'Template' }], () => {
    assert.equal(backends.openerFor({ backendId: 'tpl-670' }, DRIVER, ALL), 'tpl-670');
    assert.equal(backends.openerFor({ backendId: 'tpl-670' }, 'tpl-670', ALL), 'tpl-670');
    assert.equal(backends.get('tpl-670').transcriptsOf, undefined, 'a template does not inherit transcriptsOf');
  });
});

test('openerFor: without a launchable set it asks the enable switches, as it did before #670', () => {
  withSettings({ [OWNER]: true, [DRIVER]: true }, [], () => {
    assert.equal(backends.openerFor({ backendId: OWNER }, DRIVER), DRIVER);
  });
  withSettings({ [OWNER]: true, [DRIVER]: false }, [], () => {
    assert.equal(backends.openerFor({ backendId: OWNER }, DRIVER), OWNER);
  });
});

test('launchableIds: ready, enabled and not known to be missing', () => {
  const MISSING = 'test-670-missing';
  backends.register({ id: MISSING, label: 'Missing', status: 'ready', probe: () => ({ ok: false, reason: 'not here' }) });
  withSettings({ [OWNER]: true, [DRIVER]: false, [MISSING]: true }, [], () => {
    const ids = backends.launchableIds();
    assert.equal(ids.has(OWNER), true);
    assert.equal(ids.has(DRIVER), false, 'switched off');
    assert.equal(ids.has(MISSING), false, 'enabled, but its binary is not there');
  });
});

test('isOpenerFor: the owner, or a launchable driver of it — nothing else', () => {
  assert.equal(backends.isOpenerFor(OWNER, OWNER, new Set()), true, 'the owner is the spawn gate\'s to refuse');
  assert.equal(backends.isOpenerFor(OWNER, DRIVER, ALL), true);
  assert.equal(backends.isOpenerFor(OWNER, DRIVER, new Set([OWNER])), false, 'a driver that cannot launch');
  assert.equal(backends.isOpenerFor(OWNER, OTHER, ALL), false);
  assert.equal(backends.isOpenerFor(OTHER, DRIVER, ALL), false);
  assert.equal(backends.isOpenerFor(null, DRIVER, ALL), false);
});

// --- the sidebar payload -----------------------------------------------------------------------------

test('the payload carries the effective opener, the owner and whether a choice is stored', () => {
  const view = require('../src/index/projects-view');
  const ALPHA = '/invented/demo-670';
  const row = (sessionId, over = {}) => ({
    sessionId, projectPath: ALPHA, modified: '2026-06-01T00:00:00Z', summary: 'work', messageCount: 1,
    backendId: OWNER, ...over,
  });
  const meta = new Map([
    ['chose-gui', { sessionId: 'chose-gui', opener: DRIVER }],
    ['chose-terminal', { sessionId: 'chose-terminal', opener: OWNER }],
  ]);
  view.init({
    PROJECTS_DIR: '/invented/nowhere',
    activeSessions: new Map(),
    db: {
      getAllMeta: () => meta,
      getAllCached: () => [row('chose-gui'), row('chose-terminal', { transport: 'rpc' }), row('plain'), row('marked', { transport: 'rpc' })],
      getAllFolderMeta: () => new Map(),
      setFolderMeta: () => {},
      getFavoritedProjects: () => new Set(),
      getProjectDisplayNames: () => new Map(),
      getProjectStates: () => new Map([[ALPHA, { registered: true, registeredAt: '2026-01-01T00:00:00Z' }]]),
    },
  });
  const sessions = new Map();
  withSettings({ [OWNER]: true, [DRIVER]: true }, [], () => {
    for (const p of view.buildProjectsFromCache(false)) for (const s of p.sessions) sessions.set(s.sessionId, s);
  });
  assert.deepEqual(
    ['chose-gui', 'chose-terminal', 'plain', 'marked'].map(id => {
      const s = sessions.get(id);
      return [id, s.backendId, s.ownerBackendId, s.openerStored];
    }),
    [
      ['chose-gui', DRIVER, OWNER, true],
      ['chose-terminal', OWNER, OWNER, true],
      ['plain', OWNER, OWNER, false],
      ['marked', DRIVER, OWNER, false],
    ],
  );
});

// --- the spawn -----------------------------------------------------------------------------------------

const spawn = require('../src/app/terminal/spawn');

function fakeProcess() {
  return { pid: 4242, onData() {}, onExit() {}, write() {}, kill() {}, resize() {} };
}

function spawnSetup({ cached = null, recorded = null, stored = null, sessions = [], launchable = ALL } = {}) {
  const asked = [];
  const storedWrites = [];
  const started = [];
  const registry = {
    [OWNER]: { id: OWNER, label: 'Owner', status: 'ready', buildLaunch: () => ({ command: 'owner', args: [], env: {} }) },
    [DRIVER]: {
      id: DRIVER, label: 'Owner (GUI)', status: 'ready', transport: 'rpc', transcriptsOf: OWNER, rpc: {},
      buildLaunch: () => ({ command: 'owner', args: ['--pipe'], env: {}, spawnMode: 'argv' }),
    },
    [OTHER]: { id: OTHER, label: 'Other', status: 'ready', buildLaunch: () => ({ command: 'other', args: [], env: {} }) },
  };
  const ctx = {
    activeSessions: new Map(sessions),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    windowForSession: () => null,
    getAppQuitting: () => false,
    liveStoreRef: new Map(),
    liveBusy: new Map(),
    cleanPtyEnv: {},
    projectsDir: '/invented/nowhere',
    backends: {
      get: (id) => registry[id] || null,
      isLaunchable: (id) => { asked.push(id); return launchable.has(id); },
      backendCoreEnv: () => ({}),
      rowOwnerOf: (id) => (registry[id] && registry[id].transcriptsOf) || id,
      isOpenerFor: (owner, candidate) => backends.isOpenerFor(owner, candidate, launchable),
      openerFor: (row, choice) => backends.openerFor(row, choice, launchable),
      launchableIds: () => launchable,
    },
    sessionBackends: { get: () => recorded, record: () => {} },
    getSetting: () => ({}),
    effectiveSettings: () => ({ shellProfile: 'auto' }),
    attentionHooksEnabled: () => false,
    classifyShellType: () => 'bash',
    resolveArgvExecutable: () => '/invented/bin/owner',
    resolveTerminalShellProfileId: () => 'auto',
    resolveLauncherCwd: (_l, p) => p,
    composeLauncherCommand: () => '',
    resolveSpawnEnv: (e) => e,
    getCachedSession: () => cached,
    getOpener: () => stored,
    setOpener: (id, backendId) => storedWrites.push([id, backendId]),
    cleanupSecretRefsForSession: () => {},
    ensureProjectAdded: () => {},
    startMcpServer: async () => null,
    shutdownMcpServer: () => {},
    startAgentProcess: (opts) => { started.push(opts); return fakeProcess(); },
    bindingDir: '/invented/bindings',
    log: { info() {}, warn() {}, error() {}, debug() {}, silly() {} },
  };
  spawn.init(ctx);
  return { ctx, asked, storedWrites, started };
}

const CWD = process.cwd();

// A terminal backend picked by the routing would go on to a REAL node-pty spawn, and a live PTY left behind
// keeps this file from exiting (it was cancelled at the cap under the suite's load). The routing decision is
// made before `buildLaunch`, so stopping there keeps the assertion and spawns nothing.
function noPtySpawn(s, id) {
  const b = s.ctx.backends.get(id);
  b.buildLaunch = () => { throw new Error('test: no terminal spawn'); };
}

test('spawn: an explicit GUI choice is launched and stored — after the spawn, not before', async () => {
  const s = spawnSetup({ cached: { sessionId: 's1', backendId: OWNER } });
  const result = await spawn.openTerminal('s1', CWD, false, { openerChoice: DRIVER });
  assert.equal(result.ok, true, result.error);
  assert.equal(s.started.length, 1, 'the driver spawned on its pipe');
  assert.deepEqual(s.storedWrites, [['s1', DRIVER]]);
});

test('spawn: a choice that is not the owner or its driver is refused with a sentence, and nothing is stored', async () => {
  const s = spawnSetup({ cached: { sessionId: 's1', backendId: OWNER } });
  const result = await spawn.openTerminal('s1', CWD, false, { openerChoice: OTHER });
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot open this session/);
  assert.deepEqual(s.storedWrites, []);
  assert.deepEqual(s.asked, [], 'refused before any backend was picked');
});

test('spawn: a GUI choice whose driver cannot launch is refused, not silently opened in the terminal', async () => {
  const s = spawnSetup({ cached: { sessionId: 's1', backendId: OWNER }, launchable: new Set([OWNER]) });
  const result = await spawn.openTerminal('s1', CWD, false, { openerChoice: DRIVER });
  assert.equal(result.ok, false);
  assert.deepEqual(s.storedWrites, []);
});

test('spawn: with no cached row the owner comes from the launch record, and without either it refuses', async () => {
  const known = spawnSetup({ recorded: { backendId: DRIVER, profileId: null } });
  const ok = await spawn.openTerminal('s1', CWD, false, { openerChoice: DRIVER });
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(known.storedWrites, [['s1', DRIVER]]);

  const unknown = spawnSetup();
  const refused = await spawn.openTerminal('s1', CWD, false, { openerChoice: DRIVER });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /does not know which backend/);
  assert.deepEqual(unknown.storedWrites, []);
});

test('spawn: a failed spawn stores nothing', async () => {
  const s = spawnSetup({ cached: { sessionId: 's1', backendId: OWNER } });
  s.ctx.startAgentProcess = () => { throw new Error('no pipe'); };
  const result = await spawn.openTerminal('s1', CWD, false, { openerChoice: DRIVER });
  assert.equal(result.ok, false);
  assert.deepEqual(s.storedWrites, []);
});

test('spawn: a STORED choice wins over the launch record, while its backend can launch', async () => {
  const s = spawnSetup({
    cached: { sessionId: 's1', backendId: OWNER },
    recorded: { backendId: OWNER, profileId: null },
    stored: DRIVER,
  });
  const result = await spawn.openTerminal('s1', CWD, false, {});
  assert.equal(result.ok, true, result.error);
  assert.equal(s.asked[0], DRIVER, 'the stored view was the backend picked');
  assert.equal(s.started.length, 1);
  assert.deepEqual(s.storedWrites, [], 'nothing new to store: no explicit choice was made');
});

test('spawn: a stored choice that cannot launch leaves the launch record in charge', async () => {
  const s = spawnSetup({
    cached: { sessionId: 's1', backendId: OWNER },
    recorded: { backendId: OTHER, profileId: null },
    stored: DRIVER,
    launchable: new Set([OWNER, OTHER]),
  });
  noPtySpawn(s, OTHER);
  await spawn.openTerminal('s1', CWD, false, {}).catch(() => {});
  assert.equal(s.asked[0], OTHER, 'today\'s route: the launch record');
});

test('spawn: a live session in another view refuses an explicit choice instead of showing the old one', async () => {
  const live = { exited: false, isPlainTerminal: false, launchBackendId: OWNER, outputBuffer: [] };
  const s = spawnSetup({ sessions: [['s1', live]], cached: { sessionId: 's1', backendId: OWNER } });
  const refused = await spawn.openTerminal('s1', CWD, false, { openerChoice: DRIVER });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /already running in the other view/);
  const same = await spawn.openTerminal('s1', CWD, false, { openerChoice: OWNER });
  assert.equal(same.reattached, true, 'the view it is already in simply reattaches');
  assert.deepEqual(s.storedWrites, []);
});

test('spawn: a session running under a template of the owner is not "the other view" of the owner', async () => {
  const live = { exited: false, isPlainTerminal: false, launchBackendId: 'owner-template', outputBuffer: [] };
  const s = spawnSetup({ sessions: [['s1', live]], cached: { sessionId: 's1', backendId: OWNER } });
  const base = s.ctx.backends.get;
  s.ctx.backends.get = (id) => (id === 'owner-template' ? { id, isProfile: true, baseId: OWNER } : base(id));
  const result = await spawn.openTerminal('s1', CWD, false, { openerChoice: OWNER });
  assert.equal(result.reattached, true, result.error);
});

test('spawn: a pre-#161 row with no backendId is the legacy Claude row, for an explicit and a stored choice alike', async () => {
  // The payload reads such a row as LEGACY_SESSION_BACKEND; the spawn must agree, or the dialog offers a
  // view the spawn then refuses and a stored view the badge shows is ignored at the click.
  const legacyOwner = 'claude';
  const explicit = spawnSetup({ cached: { sessionId: 's1', backendId: null } });
  let validatedOwner = null;
  explicit.ctx.backends.isOpenerFor = (owner, candidate) => { validatedOwner = owner; return candidate === DRIVER; };
  const ok = await spawn.openTerminal('s1', CWD, false, { openerChoice: DRIVER });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(validatedOwner, legacyOwner, 'the legacy row has an owner, and it is the legacy default');

  const stored = spawnSetup({ cached: { sessionId: 's1', backendId: null }, stored: DRIVER });
  let routedWith = null;
  stored.ctx.backends.openerFor = (row, choice) => { routedWith = row.backendId; return choice; };
  await spawn.openTerminal('s1', CWD, false, {});
  assert.equal(routedWith, legacyOwner, 'the stored view was routed against the legacy owner');
});

test('spawn: a stored choice applies to a session the index has not read yet — the owner comes from its record', async () => {
  const s = spawnSetup({ recorded: { backendId: OWNER, profileId: null }, stored: DRIVER });
  await spawn.openTerminal('s1', CWD, false, {});
  assert.equal(s.asked[0], DRIVER, 'the stored view was the backend picked');
});

test('spawn: a launch record naming a driver that is enabled but not installed heals onto the owner, like the payload', async () => {
  const s = spawnSetup({
    cached: { sessionId: 's1', backendId: OWNER, transport: 'rpc' },
    recorded: { backendId: DRIVER, profileId: null },
    launchable: new Set([OWNER]),
  });
  s.ctx.backends.isLaunchable = (id) => { s.asked.push(id); return id === OWNER || id === DRIVER; };
  noPtySpawn(s, OWNER);
  await spawn.openTerminal('s1', CWD, false, {}).catch(() => {});
  assert.equal(s.asked[0], OWNER, 'one meaning of launchable: the missing driver is off here too');
});

// --- the re-key ---------------------------------------------------------------------------------------

test('a re-key copies the stored choice to the new id — the CLI naming its own session', () => {
  const transitions = require('../src/session/session-transitions');
  const copied = [];
  const activeSessions = new Map([['temp', {
    exited: false, isPlainTerminal: false, projectFolder: 'proj', _terminalTag: 'tag-670',
    knownJsonlFiles: new Set(), knownSubagents: new Map(),
  }]]);
  transitions.init({
    PROJECTS_DIR: require('node:os').tmpdir(),
    activeSessions,
    getMainWindow: () => null,
    log: { info() {}, warn() {}, debug() {}, error() {} },
    rekeyMcpServer: () => {},
    rekeySessionBackend: () => {},
    copyOpener: (from, to) => copied.push([from, to]),
    getClearClaim: () => null,
    releaseClearClaim: () => {},
  });
  transitions.adoptSessionId('tag-670', 'real');
  assert.deepEqual(copied, [['temp', 'real']]);
});

test('a re-key copies the stored choice to the new id — adoption of a backend\'s own id', () => {
  const adopt = require('../src/watch/adopt');
  const copied = [];
  adopt.liveStoreRef.clear();
  adopt.liveBusy.clear();
  adopt.init({
    activeSessions: new Map([['temp-670', { _openedAt: Date.now(), _resumed: false, projectPath: '/p' }]]),
    getMainWindow: () => null,
    backends: { get: () => ({
      id: 'selfnamer', label: 'Self-namer', axis: 'B',
      matchLiveSession: () => ({ sessionId: 'real-670', ref: '/store/rec' }),
      liveState: () => null, liveRefFor: () => null,
    }) },
    sessionBackends: { get: () => ({ backendId: 'selfnamer' }), rekeySession: () => {} },
    copyOpener: (from, to) => copied.push([from, to]),
    log: { info() {}, debug() {}, warn() {}, error() {} },
  });
  adopt.updateBackendLiveStates();
  assert.deepEqual(copied, [['temp-670', 'real-670']]);
});
