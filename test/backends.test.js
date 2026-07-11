'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backends = require('../backends');
const claude = require('../backends/claude');

// --- T-1.1: Claude buildLaunch must return byte-identical argv vs the inline main.js:3052-3086 logic.

test('buildLaunch: new session -> --session-id', () => {
  const { command, args, spawnMode } = claude.buildLaunch({ resume: false, sessionId: 'S1' });
  assert.strictEqual(command, 'claude');
  assert.strictEqual(spawnMode, 'shell');
  assert.deepStrictEqual(args, ['--session-id', 'S1']);
});

test('buildLaunch: resume -> --resume', () => {
  const { args } = claude.buildLaunch({ resume: true, sessionId: 'S1' });
  assert.deepStrictEqual(args, ['--resume', 'S1']);
});

test('buildLaunch: fork -> --resume <from> --fork-session (takes precedence over isNew)', () => {
  const { args } = claude.buildLaunch({ resume: false, sessionId: 'S1', forkFrom: 'F1' });
  assert.deepStrictEqual(args, ['--resume', 'F1', '--fork-session']);
});

test('buildLaunch: forkFrom via options is honoured too', () => {
  const { args } = claude.buildLaunch({ resume: false, sessionId: 'S1', options: { forkFrom: 'F9' } });
  assert.deepStrictEqual(args, ['--resume', 'F9', '--fork-session']);
});

test('buildLaunch: dangerouslySkipPermissions wins over permissionMode', () => {
  const { args } = claude.buildLaunch({
    resume: false, sessionId: 'S1',
    options: { dangerouslySkipPermissions: true, permissionMode: 'plan' },
  });
  assert.deepStrictEqual(args, ['--session-id', 'S1', '--dangerously-skip-permissions']);
});

test('buildLaunch: full option set in the exact inline order', () => {
  const { args } = claude.buildLaunch({
    resume: false, sessionId: 'S1',
    options: {
      permissionMode: 'acceptEdits',
      worktree: true, worktreeName: 'feature-x',
      chrome: true,
      addDirs: ' a , b ,, c ',
      appendSystemPrompt: 'be terse',
    },
  });
  assert.deepStrictEqual(args, [
    '--session-id', 'S1',
    '--permission-mode', 'acceptEdits',
    '--worktree', 'feature-x',
    '--chrome',
    '--add-dir', 'a', '--add-dir', 'b', '--add-dir', 'c',
    '--append-system-prompt', 'be terse',
  ]);
});

test('buildLaunch: worktree without a name omits the name arg', () => {
  const { args } = claude.buildLaunch({ resume: true, sessionId: 'S1', options: { worktree: true } });
  assert.deepStrictEqual(args, ['--resume', 'S1', '--worktree']);
});

// --- dual-mode discovery contract (file mode) yields the same session set as today's scan.

test('discoverSessions yields {kind:file} handles for the projects tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-proj-'));
  const folder = path.join(root, '-home-user-proj');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'sess-aaa.jsonl'), '{"type":"user"}\n');
  fs.writeFileSync(path.join(folder, 'sess-bbb.jsonl'), '{"type":"user"}\n');
  // a subagent transcript under a UUID/subagents dir
  const sub = path.join(folder, 'sess-aaa', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), '{"type":"user"}\n');
  // A stray .git dir at the projects root must be ignored (matches every other scan site).
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'config.jsonl'), '{"type":"user"}\n');

  claude.setRoots([root]);
  const handles = claude.discoverSessions();
  const ids = handles.map(h => h.sessionId).sort();
  assert.deepStrictEqual(ids, ['agent-1', 'sess-aaa', 'sess-bbb']);
  for (const h of handles) {
    assert.strictEqual(h.kind, 'file');
    assert.ok(h.path.endsWith('.jsonl'));
    assert.strictEqual(h.folder, '-home-user-proj');
  }
  const agent = handles.find(h => h.sessionId === 'agent-1');
  assert.strictEqual(agent.parentSessionId, 'sess-aaa');
  claude.setRoots([path.join(os.homedir(), '.claude', 'projects')]); // restore default
});

test('watchTargets returns dir-kind store targets', () => {
  claude.setRoots(['/tmp/x']);
  assert.deepStrictEqual(claude.watchTargets(), [{ kind: 'dir', path: '/tmp/x' }]);
  claude.setRoots([path.join(os.homedir(), '.claude', 'projects')]);
});

test('descriptor shape: ready, configFields present, contract hooks exposed', () => {
  assert.strictEqual(claude.id, 'claude');
  assert.strictEqual(claude.status, 'ready');
  assert.ok(Array.isArray(claude.configFields) && claude.configFields.length > 0);
  for (const hook of ['buildLaunch', 'discoverSessions', 'parseSession', 'watchTargets']) {
    assert.strictEqual(typeof claude[hook], 'function', `hook ${hook} must be a function`);
  }
});

// --- registry.

test('registry: claude + codex are ready; the unbuilt Axis-B binaries are planned dummies', () => {
  assert.strictEqual(backends.get('claude').status, 'ready');
  assert.strictEqual(backends.get('codex').status, 'ready'); // Phase 4
  for (const id of ['hermes', 'pi', 'gemini']) {
    const d = backends.get(id);
    assert.ok(d, `${id} registered`);
    assert.strictEqual(d.status, 'planned', `${id} is a planned dummy until its phase builds it`);
  }
});

test('registry: a planned dummy refuses to launch', () => {
  assert.throws(() => backends.get('gemini').buildLaunch({}), /planned/);
});

test('registry: list() includes claude + the planned dummies', () => {
  const ids = backends.list().map(d => d.id).sort();
  assert.deepStrictEqual(ids, ['claude', 'codex', 'gemini', 'hermes', 'pi']);
});

// --- T-2.1: unified list (built-ins ∪ user profiles), enabled flags, default launch target.

function withRegistry(settings, profileList, fn) {
  const fakeProfiles = {
    list: () => profileList,
    get: (id) => profileList.find(p => p.id === id) || null,
  };
  backends.init({ getGlobalSettings: () => settings, profiles: fakeProfiles });
  try { fn(); } finally {
    backends.init({ getGlobalSettings: () => ({}), profiles: { list: () => [], get: () => null } });
  }
}

test('list(): only claude is enabled by default; planned are never enabled', () => {
  withRegistry({}, [], () => {
    const byId = Object.fromEntries(backends.list().map(b => [b.id, b]));
    assert.strictEqual(byId.claude.enabled, true);
    assert.strictEqual(byId.codex.enabled, false);
    assert.strictEqual(byId.gemini.enabled, false);
  });
});

test('list(): backendEnabled.<id> flags are merged; planned can NEVER be enabled', () => {
  withRegistry({ backendEnabled: { codex: true, gemini: true, claude: false } }, [], () => {
    const byId = Object.fromEntries(backends.list().map(b => [b.id, b]));
    assert.strictEqual(byId.claude.enabled, false, 'claude can be disabled by the user');
    assert.strictEqual(byId.codex.enabled, true, 'a ready backend the user enabled');
    // gemini is a planned dummy -> the flag must not be able to activate it (§5.8)
    assert.strictEqual(byId.gemini.enabled, false, 'planned stays off even when flagged');
  });
});

test('list(): user profiles are unioned in and enabled by default', () => {
  const prof = { id: 'my-ds', name: 'My DeepSeek', icon: 'deepseek', env: { ANTHROPIC_BASE_URL: 'https://x' } };
  withRegistry({}, [prof], () => {
    const byId = Object.fromEntries(backends.list().map(b => [b.id, b]));
    assert.ok(byId['my-ds'], 'profile appears in the unified list');
    assert.strictEqual(byId['my-ds'].isProfile, true);
    assert.strictEqual(byId['my-ds'].axis, 'A');
    assert.strictEqual(byId['my-ds'].status, 'ready');
    assert.strictEqual(byId['my-ds'].enabled, true, 'profiles are enabled on creation');
  });
});

test('get(): resolves a user profile id to a descriptor', () => {
  const prof = { id: 'my-glm', name: 'My GLM', env: { ANTHROPIC_MODEL: 'glm-4.6' } };
  withRegistry({}, [prof], () => {
    const d = backends.get('my-glm');
    assert.ok(d);
    assert.strictEqual(d.label, 'My GLM');
    assert.strictEqual(backends.has('my-glm'), true);
  });
});

test('Axis-A buildLaunch delegates to Claude and merges the profile env bundle', () => {
  const prof = { id: 'ds', name: 'DS', env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: '$DEEPSEEK_API_KEY' } };
  withRegistry({}, [prof], () => {
    const launch = backends.get('ds').buildLaunch({ resume: false, sessionId: 'S1', options: { permissionMode: 'plan' } });
    // same binary + same argv as Claude (Axis-A has no own launch)
    assert.strictEqual(launch.command, 'claude');
    assert.deepStrictEqual(launch.args, ['--session-id', 'S1', '--permission-mode', 'plan']);
    // ...plus the profile's env bundle (still unresolved $VAR — resolved at spawn, never on disk)
    assert.strictEqual(launch.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
    assert.strictEqual(launch.env.ANTHROPIC_AUTH_TOKEN, '$DEEPSEEK_API_KEY');
  });
});

test('isLaunchable: the §5.8 gate — ready AND enabled only', () => {
  withRegistry({}, [], () => {
    assert.strictEqual(backends.isLaunchable('claude'), true, 'default backend is on');
    assert.strictEqual(backends.isLaunchable('codex'), false, 'ready but not enabled yet');
    assert.strictEqual(backends.isLaunchable('gemini'), false, 'planned is never launchable');
    assert.strictEqual(backends.isLaunchable('ghost'), false, 'unknown id');
  });
  withRegistry({ backendEnabled: { codex: true, gemini: true } }, [], () => {
    assert.strictEqual(backends.isLaunchable('codex'), true, 'enabling a ready backend makes it launchable');
    assert.strictEqual(backends.isLaunchable('gemini'), false, 'a planned backend can never be enabled');
  });
  withRegistry({ backendEnabled: { claude: false } }, [], () => {
    assert.strictEqual(backends.isLaunchable('claude'), false, 'a disabled backend cannot spawn');
  });
});

test('launchable(): only ready && enabled backends', () => {
  withRegistry({ backendEnabled: { codex: true } }, [{ id: 'p1', name: 'P1', env: {} }], () => {
    const ids = backends.launchable().map(b => b.id).sort();
    assert.deepStrictEqual(ids, ['claude', 'codex', 'p1'], 'profiles are enabled on creation');
  });
});

test('getDefaultLaunchTarget: defaults to claude, honours a valid target, rejects an unlaunchable one', () => {
  withRegistry({}, [], () => {
    assert.strictEqual(backends.getDefaultLaunchTarget(), 'claude');
  });
  const prof = { id: 'ds', name: 'DS', env: {} };
  withRegistry({ defaultLaunchTarget: 'ds' }, [prof], () => {
    assert.strictEqual(backends.getDefaultLaunchTarget(), 'ds');
  });
  // a planned/disabled target falls back to claude
  withRegistry({ defaultLaunchTarget: 'gemini' }, [], () => {
    assert.strictEqual(backends.getDefaultLaunchTarget(), 'claude');
  });
  withRegistry({ defaultLaunchTarget: 'ghost' }, [], () => {
    assert.strictEqual(backends.getDefaultLaunchTarget(), 'claude');
  });
});

test('backendCoreEnv: terminal identity + optional MCP port', () => {
  const base = backends.backendCoreEnv();
  assert.strictEqual(base.TERM_PROGRAM, 'iTerm.app');
  assert.strictEqual(base.FORCE_COLOR, '3');
  assert.ok(!('CLAUDE_CODE_SSE_PORT' in base));
  const withPort = backends.backendCoreEnv({ mcpPort: 4321 });
  assert.strictEqual(withPort.CLAUDE_CODE_SSE_PORT, '4321');
});
