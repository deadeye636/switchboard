'use strict';
// The gates in front of the spawn: everything open-terminal decides BEFORE a PTY exists.
//
// This is the block that could never be tested — 645 lines inside main.js, which needs Electron. #213
// moved it to app/terminal/spawn.js, which takes its ~22 collaborators through ctx. So the refusal paths
// run for real here: none of them reaches pty.spawn, which is exactly what makes them testable.
//
// They matter because each one replaced a dead tab with a sentence. A refusal that silently becomes a
// Claude resume of a foreign transcript (`claude --resume <codex-uuid>`) gives the user a black window
// and no reason (#196).
//
// The spawn ITSELF is not tested here — that needs a real PTY and a real binary, and it is what the
// plan's click-list covers (all five backends + a template + a launcher, driven in the running app).
const test = require('node:test');
const assert = require('node:assert/strict');

const spawn = require('../src/app/terminal/spawn');

function fakeBackend(over = {}) {
  return {
    id: 'codex', label: 'Codex', axis: 'B', status: 'ready',
    buildLaunch: () => ({ command: 'codex', args: [], env: {} }),
    ...over,
  };
}

// The registry, keyed by id. It must NOT answer the same object for every id: several of the rules below
// are about WHICH backend was picked, and a fake that hands out one backend for both 'codex' and 'claude'
// cannot tell a correct pick from a wrong one. (It did, and two mutations walked straight through.)
function setup({ backend = fakeBackend(), registry = null, launchable = true, sessions = [], cached = null, window = {} } = {}) {
  const sent = [];
  const asked = [];
  const activeSessions = new Map(sessions);
  const known = registry || { [backend.id]: backend };
  const ctx = {
    sent,
    asked,          // every id isLaunchable() was asked about — i.e. which backend the spawn picked
    activeSessions,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) }, ...window }),
    getAppQuitting: () => false,
    liveStoreRef: new Map(),
    liveBusy: new Map(),
    cleanPtyEnv: {},
    projectsDir: 'D:/nope',
    backends: {
      get: (id) => known[id] || null,
      isLaunchable: (id) => { asked.push(id); return launchable; },
      backendCoreEnv: () => ({}),
    },
    sessionBackends: { get: () => null, record: () => {} },
    getSetting: () => ({}),
    effectiveSettings: () => ({ shellProfile: 'auto' }),
    attentionHooksEnabled: () => false,
    classifyShellType: () => 'bash',
    resolveArgvExecutable: () => null,
    resolveTerminalShellProfileId: () => 'auto',
    resolveLauncherCwd: (_l, p) => p,
    composeLauncherCommand: () => '',
    resolveSpawnEnv: (e) => e,
    getCachedSession: () => cached,
    cleanupSecretRefsForSession: () => {},
    ensureProjectAdded: () => {},
    startMcpServer: async () => null,
    shutdownMcpServer: () => {},
    log: { info() {}, warn() {}, error() {}, silly() {} },
  };
  spawn.init(ctx);
  return ctx;
}

// The cwd every refusal test uses must EXIST, or the "project directory no longer exists" check fires
// first and the test passes for the wrong reason.
const CWD = process.cwd();

test('no window, no spawn', async () => {
  const ctx = setup();
  ctx.getMainWindow = () => null;
  spawn.init(ctx);
  assert.deepEqual(await spawn.openTerminal('s', CWD, true, {}), { ok: false, error: 'no window' });
});

test('a project directory that is gone is said, not spawned into', async () => {
  setup();
  const r = await spawn.openTerminal('s', 'D:/definitely/not/here', true, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /project directory no longer exists/);
});

// #130: `exited` is set the moment stop-session issues the kill, before onExit lands. Reattaching there
// wires the renderer to a corpse.
test('reattaching to a live session replays its buffer and does not spawn', async () => {
  const session = { exited: false, outputBuffer: ['hello', 'world'], isPlainTerminal: false, altScreen: true, mcpServer: {} };
  const ctx = setup({ sessions: [['s', session]] });

  const r = await spawn.openTerminal('s', CWD, false, {});
  assert.deepEqual(r, { ok: true, reattached: true, mcpActive: true });
  assert.equal(session.rendererAttached, true);
  assert.equal(session.firstResize, true, 'so the TUI gets its repaint nudge');
  assert.deepEqual(ctx.sent.map((a) => a[2]), ['\x1b[?1049h', 'hello', 'world', '\x1b[?25l'],
    'alt-screen escape, then the buffer, then the cursor hide');
});

test('a session whose PTY is already dead is NOT reattached — it falls through to a fresh spawn (#130)', async () => {
  const dead = { exited: true, outputBuffer: [] };
  setup({ sessions: [['s', dead]] });

  const r = await spawn.openTerminal('s', 'D:/definitely/not/here', false, {});
  assert.match(r.error, /project directory no longer exists/,
    'it got past the reattach branch — reattaching would have wired the renderer to a corpse');
});

// §5.8: only a ready AND enabled backend may spawn. The picker never offers otherwise, so reaching this
// is a stale renderer or a crafted IPC call.
test('a disabled backend is refused with a sentence, before any PTY exists', async () => {
  setup({ launchable: false });
  const r = await spawn.openTerminal('s', CWD, true, { backendId: 'codex' });
  assert.equal(r.ok, false);
  assert.match(r.error, /disabled\. Enable it in Settings → Backends/);
});

test('a planned backend says it is not built yet', async () => {
  setup({ backend: fakeBackend({ status: 'planned' }), launchable: false });
  const r = await spawn.openTerminal('s', CWD, true, { backendId: 'codex' });
  assert.match(r.error, /is not built yet/);
});

test('a template whose base is disabled names the BASE, not itself', async () => {
  setup({
    backend: fakeBackend({ id: 'tmpl', label: 'My Template', isProfile: true, baseId: 'codex', baseLabel: 'Codex' }),
    launchable: false,
  });
  const r = await spawn.openTerminal('s', CWD, true, { backendId: 'tmpl' });
  assert.match(r.error, /runs on Codex, which is disabled/);
});

// #162 + the pre-multi-LLM inference: a session with no recorded provenance is Claude's by definition.
test('an old session with no provenance is Claude\'s — and says so when Claude is off', async () => {
  setup({ backend: fakeBackend({ id: 'claude', label: 'Claude Code' }), launchable: false });
  const r = await spawn.openTerminal('s', CWD, false, {});
  assert.match(r.error, /started before Switchboard supported other backends/);
  assert.match(r.error, /stays visible and searchable either way/, 'and that it is not lost');
});

// #196: the one that must NOT default to Claude. A template that was deleted leaves sessions recorded
// under an id nothing resolves; spawning `claude --resume <codex-uuid>` gives a dead tab with no reason.
//
// Claude MUST be resolvable here, or the test proves nothing: the bug is falling back TO Claude, and a
// registry with no Claude in it refuses for the wrong reason.
test('a session whose backend no longer exists is refused, not silently resumed as Claude (#196)', async () => {
  const claude = fakeBackend({ id: 'claude', label: 'Claude Code' });
  const ctx = setup({ registry: { claude } });
  ctx.sessionBackends.get = () => ({ backendId: 'deleted-template' });
  ctx.getCachedSession = () => null;      // the cache cannot heal it either
  spawn.init(ctx);

  const r = await spawn.openTerminal('s', CWD, false, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /no longer installed, so it cannot be resumed/);
  assert.deepEqual(ctx.asked, [], 'and it never got as far as asking whether CLAUDE could launch');
});

// The two "unknown backend" messages are not interchangeable, and which one you get depends on whether
// anything ever CLAIMED this session for that backend. Asking for an id explicitly is a claim.
test('an explicitly requested backend that is not in this build is refused', async () => {
  const ctx = setup();
  ctx.backends.get = () => null;
  spawn.init(ctx);
  const r = await spawn.openTerminal('s', CWD, true, { backendId: 'nope' });
  assert.equal(r.ok, false);
  assert.match(r.error, /\('nope'\) is no longer installed, so it cannot be resumed/);
});

test('only a session with NO provenance at all may fall back to Claude', async () => {
  const ctx = setup();
  ctx.backends.get = () => null;          // even claude does not resolve
  spawn.init(ctx);
  const r = await spawn.openTerminal('s', CWD, false, {});
  assert.match(r.error, /Backend 'claude' is not installed in this build/,
    'no provenance -> really Claude\'s, so this is the honest message');
});

// §5.7: the overlay is only the bridge until the first scan; session_cache.backendId is authoritative.
// Without the heal, resuming a scanner-discovered Codex session spawns `claude --resume <codex-uuid>`.
test('a session the overlay forgot is healed from the cache, not defaulted to Claude (§5.7)', async () => {
  const codex = fakeBackend({ id: 'codex', label: 'Codex' });
  const claude = fakeBackend({ id: 'claude', label: 'Claude Code' });
  const ctx = setup({ registry: { codex, claude }, cached: { backendId: 'codex' }, launchable: false });
  ctx.sessionBackends.get = () => null;                       // the overlay knows nothing about it
  spawn.init(ctx);

  const r = await spawn.openTerminal('s', CWD, false, {});
  assert.deepEqual(ctx.asked, ['codex'],
    'the cache said codex — picking claude here is how a resume spawns the wrong binary');
  assert.match(r.error, /Backend 'Codex' is disabled/, 'and the refusal names Codex, not Claude');
});

// The other half: the overlay POINTS somewhere real. The cache must not be consulted at all.
test('an overlay that still resolves is trusted as-is', async () => {
  const codex = fakeBackend({ id: 'codex', label: 'Codex' });
  const claude = fakeBackend({ id: 'claude', label: 'Claude Code' });
  let cacheReads = 0;
  const ctx = setup({ registry: { codex, claude }, launchable: false });
  ctx.sessionBackends.get = () => ({ backendId: 'codex', profileId: null });
  ctx.getCachedSession = () => { cacheReads++; return null; };
  spawn.init(ctx);

  await spawn.openTerminal('s', CWD, false, {});
  assert.deepEqual(ctx.asked, ['codex']);
  assert.equal(cacheReads, 0, 'the overlay answered — no need to touch the cache');
});

test('a backend that reports its binary missing says what is wrong instead of spawning', async () => {
  setup({ backend: fakeBackend({ probe: () => ({ ok: false, reason: 'hermes is not on PATH — pip install hermes-agent' }) }) });
  const r = await spawn.openTerminal('s', CWD, true, { backendId: 'codex' });
  assert.deepEqual(r, { ok: false, error: 'hermes is not on PATH — pip install hermes-agent' });
});

test('a probe that throws is a refusal, not a crash', async () => {
  setup({ backend: fakeBackend({ probe: () => { throw new Error('probe blew up'); } }) });
  const r = await spawn.openTerminal('s', CWD, true, { backendId: 'codex' });
  assert.equal(r.ok, false);
  // The thrown text is not the answer (#457): a probe blows up with the path it looked in, and this
  // reason goes straight to the renderer. What the user gets is which backend could not be checked.
  assert.equal(r.error, 'Codex could not be checked for.');
  assert.ok(!r.error.includes('probe blew up'));
});

test('a probe that REFUSES still says why, in the descriptor own words', async () => {
  // The distinction the sanitising must not flatten: a backend declining is an authored sentence, and
  // it is the one thing here a user can act on.
  setup({ backend: fakeBackend({ probe: () => ({ ok: false, reason: 'Install the Codex CLI first.' }) }) });
  const r = await spawn.openTerminal('s', CWD, true, { backendId: 'codex' });
  assert.deepEqual(r, { ok: false, error: 'Install the Codex CLI first.' });
});

// Forking an id the backend never issued produces a dead tab ("No session found").
test('forking a session the backend has not named yet is refused with the reason', async () => {
  setup({ backend: fakeBackend({ liveRefFor: () => null }) });
  const r = await spawn.openTerminal('s', CWD, true, { backendId: 'codex', forkFrom: 'never-recorded' });
  assert.equal(r.ok, false);
  assert.match(r.error, /records one only after the agent has answered. Send a message first, then fork/);
});

// #290. Resume is the same defect one door along, and the opposite remedy: `<cli> -r <our-uuid>` against a
// backend that never issued that id starts an empty session pointing at a record that will never exist.
// It must NOT refuse the way fork does — `liveRefFor` answers about the store as it reads TODAY, and a
// store a CLI update moved or rewrote says "unknown" for sessions that were real.
//
// buildLaunch throws on purpose so the assertion happens before any PTY could be spawned; the refusal that
// comes back is that throw, not a guard.
function resumeFlagFor(over) {
  const seen = [];
  setup({ backend: fakeBackend({ ...over,
    buildLaunch: (args) => { seen.push(args); throw new Error('stop short of the PTY'); } }) });
  return { seen, run: () => spawn.openTerminal('s', CWD, false, { backendId: 'codex' }) };
}

test('resuming an id the backend does not know drops the -r instead of refusing (#290)', async () => {
  const { seen, run } = resumeFlagFor({ liveRefFor: () => null });
  const r = await run();
  assert.equal(seen.length, 1, 'it got as far as building the launch — nothing refused it');
  assert.equal(seen[0].resume, false, 'no -r for an id the backend has never issued');
  assert.equal(r.ok, false, 'our own throw, not a guard');
});

test('resuming an id the backend DOES know still resumes (#290)', async () => {
  const { seen, run } = resumeFlagFor({ liveRefFor: () => 'a-real-store-ref' });
  await run();
  assert.equal(seen[0].resume, true);
});

test('a backend that names no sessions of its own resumes unconditionally (#290)', async () => {
  // Claude: our id IS its id, so there is no liveRefFor hook and nothing to ask.
  const { seen, run } = resumeFlagFor({});
  await run();
  assert.equal(seen[0].resume, true);
});

// --- A session a live process already holds (#172) ------------------------------------------------
//
// The CLI refuses to open one twice and says so by dying, so what the user got for clicking Resume was a
// tab that flashed up and exited 1. Every test below is about the guard NOT overreaching: it may only
// refuse what it actually knows, from an answer that is actually fresh.
const BG = { sessionId: 's', kind: 'background', pid: null, name: 'a job', state: 'blocked' };
const TTY = { sessionId: 's', kind: 'interactive', pid: 4242, name: 'a terminal', state: 'busy' };

function heldBy(owners, over = {}) {
  return fakeBackend({ id: 'claude', label: 'Claude Code', liveOwnersCached: () => owners, ...over });
}

test('#172: resuming a session a background agent holds is held back before any PTY exists', async () => {
  setup({ backend: heldBy([BG]) });
  const r = await spawn.openTerminal('s', CWD, false, { backendId: 'claude' });
  assert.equal(r.ok, false);
  assert.match(r.error, /already running as a background agent/);
  assert.match(r.error, /Fork a copy/, 'the way out the CLI itself names');
  assert.equal(r.liveOwner.kind, 'background', 'the renderer needs the entry to offer the fork');
});

// A measurement, not a style note: the first version of this message said the CLI "will not open it
// twice", and then a background agent listed as `blocked` was resumed successfully while it sat in that
// list. The list proves a process is ASSOCIATED with the session, not that the CLI will refuse.
test('#172: the message does not claim the resume is impossible', async () => {
  setup({ backend: heldBy([BG]) });
  const r = await spawn.openTerminal('s', CWD, false, { backendId: 'claude' });
  assert.doesNotMatch(r.error, /will not open it twice|cannot be resumed|impossible/i);
  assert.match(r.error, /can be refused outright/, 'it says what MAY happen, and lets the user decide');
});

test('#172: an interactive owner is a terminal the user can go and find, and says its pid', async () => {
  setup({ backend: heldBy([TTY]) });
  const r = await spawn.openTerminal('s', CWD, false, { backendId: 'claude' });
  assert.match(r.error, /in another terminal \(pid 4242\)/);
});

test('#172: "Resume anyway" is honoured — a wrong list must never lock the user out', async () => {
  const seen = [];
  setup({ backend: heldBy([BG], {
    buildLaunch: (args) => { seen.push(args); throw new Error('stop short of the PTY'); },
  }) });
  await spawn.openTerminal('s', CWD, false, { backendId: 'claude', ignoreLiveOwner: true });
  assert.equal(seen.length, 1, 'it went past the guard and built the launch');
  assert.equal(seen[0].resume, true);
});

test('#172: a cold cache refuses nothing — not knowing is not evidence', async () => {
  const seen = [];
  setup({ backend: heldBy(null, {
    buildLaunch: (args) => { seen.push(args); throw new Error('stop short of the PTY'); },
  }) });
  await spawn.openTerminal('s', CWD, false, { backendId: 'claude' });
  assert.equal(seen.length, 1, 'null means "do not know", and the spawn proceeds as it does today');
});

test('#172: a fork is never refused — forking is the offered way OUT of the conflict', async () => {
  const seen = [];
  setup({ backend: heldBy([BG], {
    liveRefFor: () => 'a-real-store-ref',
    buildLaunch: (args) => { seen.push(args); throw new Error('stop short of the PTY'); },
  }) });
  await spawn.openTerminal('n', CWD, false, { backendId: 'claude', forkFrom: 's' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].forkFrom, 's');
});

test('#172: a session THIS app is running is not reported as held somewhere else', async () => {
  const seen = [];
  // `exited` so the reattach branch above lets it through to the spawn path — the entry is still in
  // activeSessions, which is what the guard checks. Our own live session is not "elsewhere".
  setup({
    backend: heldBy([TTY], { buildLaunch: (args) => { seen.push(args); throw new Error('stop short of the PTY'); } }),
    sessions: [['s', { exited: true, outputBuffer: [] }]],
  });
  await spawn.openTerminal('s', CWD, false, { backendId: 'claude' });
  assert.equal(seen.length, 1, 'refusing here would be the app lying about its own window');
});

test('#172: a backend that cannot answer the question is unaffected', async () => {
  const seen = [];
  setup({ backend: fakeBackend({ buildLaunch: (args) => { seen.push(args); throw new Error('stop short of the PTY'); } }) });
  await spawn.openTerminal('s', CWD, false, { backendId: 'codex' });
  assert.equal(seen.length, 1, 'no hook, no guard, no change in behaviour');
});

// The net under the guard lives in the PTY's exit handler, which needs a real PTY and a real binary to
// reach — the same reason the spawn itself is not tested in this file. So what is pinned here is that it
// is still WIRED: the conditions that keep it narrow (a resume, a non-zero exit, a fast death) and the
// channel it answers on. Without the last one the renderer never hears, and the tab just dies as before.
test('#172: the exit handler still asks about a resume that died immediately', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/app/terminal/spawn.js'), 'utf8');
  assert.match(src, /diedFast/, 'a session that ran for an hour and then failed is not this defect');
  assert.match(src, /exitCode !== 0/, 'a clean exit is not a conflict');
  assert.match(src, /refreshLiveOwners\(\)/, 'the cold-cache case is the whole reason this path exists');
  assert.match(src, /'resume-conflict'/, 'and the renderer has to be told, or nothing offers the fork');
});

// A pre-launch command is a raw shell prefix. A newline in it is a second command line.
test('a newline in the pre-launch command is refused', async () => {
  setup();
  const r = await spawn.openTerminal('s', CWD, true, { backendId: 'codex', preLaunchCmd: 'nvm use 20\nrm -rf /' });
  assert.deepEqual(r, { ok: false, error: 'The pre-launch command must not contain newlines.' });
});

// #243 — what a spawned session must NOT inherit. `cleanPtyEnv` lives in main.js (Electron-bound), so
// this reads the source: the filter is a chain of `k !== '…'` and the four keys below must be in it.
//
// Why these four: a RUNNING Claude Code session exports them into everything it spawns, so a Switchboard
// started FROM such a session (`npm start` in an agent's terminal) passed them on to every session IT
// spawned. With CLAUDE_CODE_CHILD_SESSION inherited the CLI writes NO TRANSCRIPT AT ALL — no row, no
// lineage, no /clear re-key, no error. Measured one variable at a time: deleting only that one made the
// transcript appear within 5 s in an otherwise identical run. The other three carry the PARENT's identity
// and IDE-bridge port into a session that is not it.
//
// The rest of the family is legitimate user configuration (CLAUDE_CODE_MAX_OUTPUT_TOKENS,
// CLAUDE_CODE_USE_BEDROCK, CLAUDE_CONFIG_DIR, …) and must keep passing through — so this test also
// refuses a blanket prefix filter.
test("cleanPtyEnv strips a parent Claude session's markers, and only those (#243)", () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const filter = src.slice(src.indexOf('const cleanPtyEnv'), src.indexOf('const cleanPtyEnv') + 3000);

  for (const key of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE']) {
    assert.ok(
      filter.includes(`k !== '${key}'`),
      `cleanPtyEnv must strip ${key} — inherited from the session that launched Switchboard, it breaks ` +
      `the session we spawn (transcript, identity or IDE bridge)`,
    );
  }
  assert.ok(
    !/startsWith\('CLAUDE/.test(filter),
    'do not strip the whole CLAUDE_* family — CLAUDE_CODE_MAX_OUTPUT_TOKENS, CLAUDE_CONFIG_DIR and ' +
    'friends are the user\'s own configuration and must reach the CLI',
  );
});

// #478 — a GUI app started from a session's shell attaches to that session's console and writes its own
// log into the PTY, on top of the CLI's TUI. Electron only does that when the variable below is unset, so
// every PTY gets it — measured at 23089 bytes of foreign output without it and 263 with it, same app,
// same 40 s. Two halves, and the strip above is why the second one is needed: the ELECTRON_ prefix filter
// would otherwise remove the very variable this sets, including one the user set deliberately.
test('every PTY carries ELECTRON_NO_ATTACH_CONSOLE, and a user value survives the strip (#478)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const block = src.slice(src.indexOf('const cleanPtyEnv'), src.indexOf('const cleanPtyEnv') + 4000);

  assert.ok(
    /!k\.startsWith\('ELECTRON_'\)\s*\|\|\s*k === 'ELECTRON_NO_ATTACH_CONSOLE'/.test(block),
    "the ELECTRON_ strip must except ELECTRON_NO_ATTACH_CONSOLE — without it a value the user set " +
    'deliberately is removed before the default below can defer to it',
  );
  assert.ok(
    /cleanPtyEnv\.ELECTRON_NO_ATTACH_CONSOLE === undefined\) cleanPtyEnv\.ELECTRON_NO_ATTACH_CONSOLE = '1'/
      .test(block),
    'cleanPtyEnv must default ELECTRON_NO_ATTACH_CONSOLE to 1, and only when the user set none — an ' +
    'Electron GUI app started from a session otherwise writes its log into that session\'s terminal',
  );
});
