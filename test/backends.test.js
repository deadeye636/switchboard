'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backends = require('../src/backends');
const claude = require('../src/backends/claude');

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
      restricted: true,
      autocompact: '200k',
    },
  });
  assert.deepStrictEqual(args, [
    '--session-id', 'S1',
    '--permission-mode', 'acceptEdits',
    '--worktree', 'feature-x',
    '--chrome',
    '--add-dir', 'a', '--add-dir', 'b', '--add-dir', 'c',
    '--restricted',
    '--autocompact', '200k',
  ]);
});

test('buildLaunch: an option no configFields entry declares reaches no argv (#562)', () => {
  // `appendSystemPrompt` was read here with nothing declaring it — the schedule creator set it by hand and
  // #246 took that caller away. A stored value from before this fix must not resurrect the flag either:
  // the cascade copies whatever keys a scope holds, so "nobody writes it any more" is not the guard.
  assert.equal(claude.configFields.some(f => f.id === 'appendSystemPrompt'), false, 'not declared');
  const { args } = claude.buildLaunch({
    resume: false, sessionId: 'S1', options: { appendSystemPrompt: 'be terse' },
  });
  assert.deepStrictEqual(args, ['--session-id', 'S1']);
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

test('registry: every built-in binary backend is ready (agy became real in #192)', () => {
  assert.strictEqual(backends.get('claude').status, 'ready');
  assert.strictEqual(backends.get('codex').status, 'ready');  // Phase 4 (file store)
  assert.strictEqual(backends.get('agy').status, 'ready');    // #192 (file store, SQLite content)
  assert.strictEqual(backends.get('hermes').status, 'ready'); // Phase 5 (SQLite store)
  assert.strictEqual(backends.get('pi').status, 'ready');     // Phase 6 (file store again)
});

test('registry: a planned dummy refuses to launch', () => {
  // No built-in is planned any more, but the guard the app relies on for an unbuilt backend must stay
  // true — exercise it against a fresh dummy from the exported factory.
  const dummy = backends.plannedDummy({ id: 'nope', label: 'Nope', monogram: 'Np', colour: 'default' });
  assert.strictEqual(dummy.status, 'planned');
  assert.throws(() => dummy.buildLaunch({}), /planned/);
});

test('registry: list() includes claude + the other built-in binaries', () => {
  const ids = backends.list().map(d => d.id).sort();
  assert.deepStrictEqual(ids, ['agy', 'claude', 'codex', 'hermes', 'pi']);
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

test('list(): only claude is enabled by default; other ready backends are off until enabled', () => {
  withRegistry({}, [], () => {
    const byId = Object.fromEntries(backends.list().map(b => [b.id, b]));
    assert.strictEqual(byId.claude.enabled, true);
    assert.strictEqual(byId.codex.enabled, false);
    assert.strictEqual(byId.agy.enabled, false, 'ready, but not enabled out of the box');
  });
});

test('list(): backendEnabled.<id> flags are merged; a ready backend can be enabled, a planned one cannot', () => {
  withRegistry({ backendEnabled: { codex: true, agy: true, claude: false } }, [], () => {
    const byId = Object.fromEntries(backends.list().map(b => [b.id, b]));
    assert.strictEqual(byId.claude.enabled, false, 'claude can be disabled by the user');
    assert.strictEqual(byId.codex.enabled, true, 'a ready backend the user enabled');
    assert.strictEqual(byId.agy.enabled, true, 'agy is ready now, so its flag activates it');
  });
  // The planned guard still holds for an unbuilt backend: even flagged on, it stays off (§5.8).
  const planned = backends.plannedDummy({ id: 'planq', label: 'PlanQ', monogram: 'Pq', colour: 'default' });
  assert.strictEqual(backends.isEnabled(planned, { planq: true }), false, 'planned stays off even when flagged');
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

// #193: a template's sessions are written by its base binary in the base's format, so lineage must read
// like the base's. profileToDescriptor MUST forward resolveLineage — the neutral sink dispatches on the
// row's backendId (the profile id), so without this a forked template session silently loses its lineage.
test('a profile descriptor forwards resolveLineage from its base backend', () => {
  const prof = { id: 'my-glm', name: 'My GLM', env: {} }; // base defaults to claude
  withRegistry({}, [prof], () => {
    const d = backends.get('my-glm');
    assert.strictEqual(typeof d.resolveLineage, 'function', 'the sink dispatches on backendId — the profile must answer');
    assert.deepStrictEqual(d.resolveLineage({ forkedFrom: 'origin-1' }), { lineageParentId: 'origin-1', lineageKind: 'fork' });
    assert.strictEqual(d.resolveLineage({}), null);
  });
});

// #211: a template's rows are the base's rows in the base's store, so the Projects admin must be able to
// find its transcripts and its config through the profile descriptor — profileToDescriptor forwards both
// transcriptPathFor and projectMeta from the base, exactly like resolveLineage.
test('a profile descriptor forwards transcriptPathFor and projectMeta from its base backend', () => {
  const prof = { id: 'my-glm', name: 'My GLM', env: {} }; // base defaults to claude
  withRegistry({}, [prof], () => {
    const d = backends.get('my-glm');
    assert.strictEqual(typeof d.transcriptPathFor, 'function', 'remap/delete of a template needs its transcript path');
    assert.strictEqual(d.transcriptPathFor({ filePath: '/x/y.jsonl' }), '/x/y.jsonl');
    assert.strictEqual(d.transcriptPathFor(null), null);
    // But NOT projectMeta: it is the base's ~/.claude.json projects table (keyed by path, not backend), so a
    // template must not become a second "meta backend" — that doubled Claude's Info column in the admin.
    assert.ok(!d.projectMeta, 'a template must NOT carry its own projectMeta — it would duplicate the base config');
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
    assert.strictEqual(backends.isLaunchable('agy'), false, 'ready but not enabled yet');
    assert.strictEqual(backends.isLaunchable('ghost'), false, 'unknown id');
  });
  withRegistry({ backendEnabled: { codex: true, agy: true } }, [], () => {
    assert.strictEqual(backends.isLaunchable('codex'), true, 'enabling a ready backend makes it launchable');
    assert.strictEqual(backends.isLaunchable('agy'), true, 'agy is ready — enabling it makes it launchable too');
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
  withRegistry({ defaultLaunchTarget: 'agy' }, [], () => {
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

// #603: a template announces its turns the way its base does, or it announces nothing and says so.
//
// The live binding writes a per-spawn settings file and appends its argument to a launch the base
// composed anyway, so it works for a template for the same reason the launch options do — same binary.
// Before this, `profileToDescriptor` forwarded a dozen sibling capabilities and not these, so the spawn
// gate (`supportsLiveRebinding && buildLiveBinding`) never fired for a template: measured in the demo, a
// template session logged no `[clear-bind]` line and reported `liveBound: false`.
//
// And it was invisible, because #305's notice asks the SAME question: `liveBindingMissing` is true only
// where the capability is declared, so a template was neither bound nor flagged.
test('a profile descriptor forwards the live-binding family from its base backend', () => {
  const prof = { id: 'my-glm', name: 'My GLM', env: {} }; // base defaults to claude
  withRegistry({}, [prof], () => {
    const d = backends.get('my-glm');
    assert.strictEqual(d.supportsLiveRebinding, true, 'the base can report, so its template can');
    assert.strictEqual(typeof d.buildLiveBinding, 'function', 'the spawn gate needs BOTH — the flag alone binds nothing');
    assert.strictEqual(typeof d.releaseLiveBinding, 'function', 'and the release, or a settings file is left behind per spawn');
    // The turn-hold hook comes with them and not after them: it only matters once a backend reports turns
    // at all, and forwarding the binding without it would announce turns for a template with the defect
    // #495 removed from its base.
    assert.strictEqual(typeof d.readTurnQueue, 'function', 'a template holds a premature Stop like its base does');
  });
});

test('a template on a base that cannot report does not claim it can', () => {
  // The honest answer for Codex/agy/Hermes, and the one the #305 notice depends on: a capability nobody
  // declared must not appear on a template, or every session of one would be marked as missing a binding
  // it was never going to get.
  const prof = { id: 'cx-tpl', name: 'Cx Template', backendId: 'codex', env: {} };
  withRegistry({}, [prof], () => {
    const d = backends.get('cx-tpl');
    assert.notStrictEqual(d.supportsLiveRebinding, true, 'the base declares nothing, so neither does the template');
    assert.strictEqual(d.buildLiveBinding, undefined, 'and no builder is invented for it');
  });
});

// #605: a DECLARATION reaches a template without the reader it promises.
//
// `transcriptAccess: 'export'` means "this store is not a text file, ask readMessages instead", and the
// transcript path checks for both before it takes that branch. The declaration was forwarded and the
// reader was not, so a template on agy fell through to the file branch and had its `.db` read as JSONL —
// garbage in the viewer, and a binary blob handed over by the handoff pre-fill.
test('a template that says its transcript is exported can actually export it', () => {
  for (const baseId of ['agy', 'hermes']) {
    const prof = { id: `${baseId}-tpl`, name: 'A template', backendId: baseId, env: {} };
    withRegistry({}, [prof], () => {
      const d = backends.get(`${baseId}-tpl`);
      const base = backends.get(baseId);
      if (!base || (base.transcriptAccess || 'file') === 'file') return;   // a file backend has nothing to export
      assert.strictEqual(d.transcriptAccess, base.transcriptAccess, `${baseId}: the store is the base's`);
      assert.strictEqual(typeof d.readMessages, 'function', `${baseId}: so is the reader that declaration promises`);
    });
  }
});

test('a template on a FILE backend is not given an exporter', () => {
  // The other half, and the reason this is a spread rather than an assignment: inventing a reader for a
  // base that has none would take the file branch away from a template that needs it.
  const prof = { id: 'cx-export-tpl', name: 'Cx Template', backendId: 'codex', env: {} };
  withRegistry({}, [prof], () => {
    assert.strictEqual(backends.get('cx-export-tpl').readMessages, undefined);
  });
});

// #605: a template that says it has subagents can list them.
//
// `supportsSubagents` was forwarded and the three hooks behind it were not, and the core resolves the
// descriptor from the ROW's backendId — which for a template session is the template. So the descriptor
// claimed a capability it could not deliver: the same pairing #603 fixed one field along.
test('a template forwards the subagent hooks its flag promises', () => {
  const prof = { id: 'sub-tpl', name: 'A template', env: {} };   // base defaults to claude
  withRegistry({}, [prof], () => {
    const d = backends.get('sub-tpl');
    assert.strictEqual(d.supportsSubagents, true);
    assert.strictEqual(typeof d.listSubagents, 'function', 'the sidebar asks this for the row');
    assert.strictEqual(typeof d.subagentMeta, 'function', 'and this for what each one is');
    assert.strictEqual(typeof d.subagentSessionId, 'function');
  });
});

test('a template on a base without subagents claims none', () => {
  const prof = { id: 'cx-sub-tpl', name: 'Cx Template', backendId: 'codex', env: {} };
  withRegistry({}, [prof], () => {
    const d = backends.get('cx-sub-tpl');
    assert.notStrictEqual(d.supportsSubagents, true);
    assert.strictEqual(d.listSubagents, undefined);
  });
});

// #605: a template's CLI reads the base's customization directories, because it is the base's binary
// reading the base's home. Without these, `app/skills.js` — which resolves the descriptor from the
// SESSION's backendId — offered a template session none of its CLI's skills, only Switchboard's own.
test('a template forwards the resource hooks, so its sessions see the CLI\'s skills', () => {
  for (const baseId of ['claude', 'codex', 'pi']) {
    const prof = { id: `${baseId}-res-tpl`, name: 'A template', backendId: baseId, env: {} };
    withRegistry({}, [prof], () => {
      const d = backends.get(`${baseId}-res-tpl`);
      const base = backends.get(baseId);
      if (!base || typeof base.listResources !== 'function') return;
      assert.strictEqual(typeof d.listResources, 'function', `${baseId}: the listing`);
      assert.strictEqual(typeof d.expandResource, 'function', `${baseId}: and the expander — skills need both`);
      assert.deepEqual(d.resourceEditing, base.resourceEditing, `${baseId}: what may be written back`);
      assert.deepEqual(d.resourceScaffolds, base.resourceScaffolds, `${baseId}: and what may be created`);
    });
  }
});

// #605: `modelDiscovery` in the backends-list payload is `typeof b.listModels === 'function'`, so an
// unforwarded hook did not merely fail — it told the Configure dialog this backend has no model list.
test('a template offers the model suggestions its base has', () => {
  for (const baseId of ['agy', 'pi']) {
    const prof = { id: `${baseId}-model-tpl`, name: 'A template', backendId: baseId, env: {} };
    withRegistry({}, [prof], () => {
      const base = backends.get(baseId);
      if (!base || typeof base.listModels !== 'function') return;
      assert.strictEqual(typeof backends.get(`${baseId}-model-tpl`).listModels, 'function', baseId);
    });
  }
});

// #605: the trust entry lives in the BASE's config file, keyed by project path, so a template asks and
// writes the same one. `projects.js` filters `launchable()`, which contains templates — so a remap
// carried the trust for every built-in and silently not for a template.
test('a template carries its base\'s project trust', () => {
  for (const baseId of ['claude', 'codex', 'pi']) {
    const prof = { id: `${baseId}-trust-tpl`, name: 'A template', backendId: baseId, env: {} };
    withRegistry({}, [prof], () => {
      const base = backends.get(baseId);
      if (!base || !base.projectTrust) return;
      assert.strictEqual(backends.get(`${baseId}-trust-tpl`).projectTrust, base.projectTrust, baseId);
    });
  }
});
