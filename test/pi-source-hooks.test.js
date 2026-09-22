'use strict';
// #635 — the source's hooks, run on a Pi session's own lifecycle. Three halves, tested where each lives:
// the SOURCE reading its settings files into neutral rows, the CORE applying this launch's rules, and the
// TARGET's generated section, which is compiled with esbuild and RUN against a fake `pi` — reading that
// text would prove nothing about what it does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { createListSharedHooks, _matcherTools } = require('../src/backends/claude/hooks-config');
const hooksSection = require('../src/backends/pi/hooks-section');
const resourceSources = require('../src/app/resource-sources');

const TOOL_WORDS = { Read: 'read', Write: 'write', Edit: 'edit', Bash: 'shell' };

function settingsDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-hooks-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the OS will */ } });
  return dir;
}

const writeSettings = (dir, name, blob) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(blob), 'utf8');
};

const command = (cmd, extra = {}) => ({ type: 'command', command: cmd, ...extra });

test('a matcher is read as tools of the shared vocabulary, or refused with the name that has no counterpart', () => {
  assert.deepEqual(_matcherTools('', TOOL_WORDS), { tools: null }, 'no matcher means every tool');
  assert.deepEqual(_matcherTools('*', TOOL_WORDS), { tools: null });
  assert.deepEqual(_matcherTools('.*', TOOL_WORDS), { tools: null });
  assert.deepEqual(_matcherTools('Write|Edit', TOOL_WORDS), { tools: ['write', 'edit'] });
  assert.deepEqual(_matcherTools(' Bash ', TOOL_WORDS), { tools: ['shell'] }, 'spacing is the user\'s, not a name');
  // Two names for one thing collapse, because the target has one tool for them.
  assert.deepEqual(_matcherTools('Write|Write', TOOL_WORDS), { tools: ['write'] });
  // A pattern cannot be narrowed into a tool list without guessing which tools it would have matched.
  assert.match(_matcherTools('Notebook.*', TOOL_WORDS).reason, /no counterpart/);
  assert.match(_matcherTools('Write|mcp__x__y', TOOL_WORDS).reason, /mcp__x__y/, 'and the refusal names the one that failed');
});

test('only a command hook travels, which is also what keeps our own attention hook out', (t) => {
  const home = settingsDir(t);
  writeSettings(home, 'settings.json', {
    hooks: {
      // What `src/app/hooks.js` writes. It is not a command, so it cannot be mistaken for one.
      Stop: [{ matcher: '', hooks: [{ type: 'http', url: 'http://127.0.0.1:1/x', timeout: 5 }, command('say-stop')] }],
      PostToolUse: [{ matcher: 'Write', hooks: [command('say-write', { timeout: 5 })] }],
      SessionStart: [{ matcher: '', hooks: [command('say-start')] }],
    },
  });
  const list = createListSharedHooks({ claudeHome: () => home, toolWords: () => TOOL_WORDS });
  const rows = list({}).hooks;
  assert.deepEqual(rows.map(r => r.command).sort(), ['say-start', 'say-stop', 'say-write']);
  assert.ok(!rows.some(r => r.command === undefined), 'the http entry produced no row at all');

  const stop = rows.find(r => r.command === 'say-stop');
  assert.equal(stop.event, 'agent-idle');
  assert.equal(stop.tools, null, 'no matcher: every tool');
  assert.equal(stop.scope, 'global');
  // `sourceEvent`, not `origin`: `origin` means where a thing is CONFIGURED everywhere else in this
  // family, and the preview prints it in the scope pill.
  assert.equal(stop.sourceEvent, 'Stop', 'the source\'s own word, for the preview');
  assert.equal(stop.origin, undefined);
  assert.equal(stop.timeoutMs, 60000, 'the source CLI\'s own default when none was named');
  assert.equal(rows.find(r => r.command === 'say-write').timeoutMs, 5000, 'seconds, as that CLI writes them');
  assert.deepEqual(rows.find(r => r.command === 'say-write').tools, ['write']);
  assert.equal(rows.find(r => r.command === 'say-start').event, 'session-start');
});

test('a moment with no counterpart and a matcher that cannot be mapped are reported, not dropped in silence', (t) => {
  const home = settingsDir(t);
  writeSettings(home, 'settings.json', {
    hooks: {
      // Each of these can answer back, which is the approval gate's job (H3) — so none has a word.
      PreToolUse: [{ matcher: '', hooks: [command('blocker')] }],
      UserPromptSubmit: [{ matcher: '', hooks: [command('rewriter')] }],
      PostToolUse: [{ matcher: 'Notebook.*', hooks: [command('unmappable')] }],
    },
  });
  const rows = createListSharedHooks({ claudeHome: () => home, toolWords: () => TOOL_WORDS })({}).hooks;
  const byCommand = Object.fromEntries(rows.map(r => [r.command, r]));
  assert.match(byCommand.blocker.declined, /PreToolUse/);
  assert.equal(byCommand.blocker.event, undefined, 'and it is given no moment to be attached to');
  assert.match(byCommand.rewriter.declined, /UserPromptSubmit/);
  assert.match(byCommand.unmappable.declined, /no counterpart/);
  assert.equal(byCommand.unmappable.event, 'tool-finished', 'the moment was fine; the matcher was not');
});

test('a project\'s own settings are project scope, local file included', (t) => {
  const home = settingsDir(t);
  const project = settingsDir(t);
  writeSettings(home, 'settings.json', { hooks: { Stop: [{ hooks: [command('mine')] }] } });
  writeSettings(path.join(project, '.claude'), 'settings.json', { hooks: { Stop: [{ hooks: [command('theirs')] }] } });
  // Conventionally this machine only and conventionally gitignored — but nothing enforces either, so it
  // is still the stricter scope.
  writeSettings(path.join(project, '.claude'), 'settings.local.json', { hooks: { Stop: [{ hooks: [command('local')] }] } });
  const rows = createListSharedHooks({ claudeHome: () => home, toolWords: () => TOOL_WORDS })({ projectPath: project }).hooks;
  const scopeOf = Object.fromEntries(rows.map(r => [r.command, r.scope]));
  assert.deepEqual(scopeOf, { mine: 'global', theirs: 'project', local: 'project' });
});

test('a settings file that is missing or unreadable is no hooks, not a failure', (t) => {
  const home = settingsDir(t);
  fs.writeFileSync(path.join(home, 'settings.json'), '{ not json', 'utf8');
  const answer = createListSharedHooks({ claudeHome: () => home, toolWords: () => TOOL_WORDS })({});
  assert.deepEqual(answer, { ok: true, hooks: [] });
});

// --- the core's rules for this launch ---

function stubs({ hooks, accepts = ['hook'], trusted = false, declines = null }) {
  const source = {
    id: 'src',
    label: 'Source',
    sharedResources: { sources: ['x'], hookDialect: { eventKey: 'hook_event_name', eventNames: { 'agent-idle': 'Stop' } } },
    listResources: async () => ({ ok: true, resources: [] }),
    listSharedHooks: () => ({ ok: true, hooks }),
  };
  const target = {
    id: 'tgt',
    acceptsSharedResources: accepts,
    trustsProjectResources: () => trusted,
    ...(declines ? { declinesSharedResource: declines } : {}),
  };
  resourceSources.init({ backends: { get: (id) => (id === 'src' ? source : target), list: () => [{ id: 'src' }, { id: 'tgt' }] } });
  return { source, target };
}

test('a project hook needs the target\'s trust; a global one does not', async () => {
  const hooks = [
    { event: 'agent-idle', command: 'global-one', scope: 'global', file: 'g.json', timeoutMs: 1000 },
    { event: 'agent-idle', command: 'project-one', scope: 'project', file: 'p.json', timeoutMs: 1000 },
  ];
  stubs({ hooks, trusted: false });
  const strict = await resourceSources.resolve({ target: 'tgt', sourceId: 'src', projectPath: '/p' });
  assert.deepEqual(strict.hooks.map(h => h.command), ['global-one']);
  assert.ok(strict.dropped.some(d => d.kind === 'hook' && d.reason === 'untrusted-project'));

  stubs({ hooks, trusted: true });
  const trusting = await resourceSources.resolve({ target: 'tgt', sourceId: 'src', projectPath: '/p' });
  assert.deepEqual(trusting.hooks.map(h => h.command), ['global-one', 'project-one']);
});

test('a target that declines hooks for this launch gets none, and the settings file is not even read', async () => {
  let asked = 0;
  const hooks = [{ event: 'agent-idle', command: 'x', scope: 'global', file: 'g.json' }];
  const { source } = stubs({ hooks, declines: ({ kind }) => (kind === 'hook' ? { reason: 'target-declined', note: 'not run: hooks from the source are off' } : null) });
  source.listSharedHooks = () => { asked += 1; return { ok: true, hooks }; };
  const answer = await resourceSources.resolve({ target: 'tgt', sourceId: 'src', projectPath: '/p' });
  assert.deepEqual(answer.hooks, []);
  assert.equal(asked, 0, 'a switch that is off costs no file read');
  assert.match(answer.dropped.find(d => d.kind === 'hook').note, /hooks from the source are off/);
});

test('the source\'s own refusal is carried through in its own words, and the dialect travels with a hook', async () => {
  stubs({
    hooks: [
      { event: 'agent-idle', command: 'runs', scope: 'global', file: 'g.json', tools: ['write'] },
      { command: 'refused', scope: 'global', file: 'g.json', declined: 'Pi has no moment matching PreToolUse' },
    ],
  });
  const answer = await resourceSources.resolve({ target: 'tgt', sourceId: 'src' });
  assert.deepEqual(answer.hooks.map(h => h.command), ['runs']);
  assert.deepEqual(answer.hooks[0].tools, ['write']);
  assert.equal(answer.hooks[0].dialect.eventKey, 'hook_event_name', 'the target is told what shape to write');
  assert.equal(answer.hooks[0].timeoutMs, 60000, 'a source that named none gets the core\'s last resort');
  const refused = answer.dropped.find(d => d.kind === 'hook');
  assert.equal(refused.reason, 'source-declined');
  assert.match(refused.note, /PreToolUse/);
});

test('a target that does not accept hooks at all is handed none', async () => {
  stubs({ hooks: [{ event: 'agent-idle', command: 'x', scope: 'global', file: 'g.json' }], accepts: ['skill'] });
  const answer = await resourceSources.resolve({ target: 'tgt', sourceId: 'src' });
  assert.deepEqual(answer.hooks, []);
});

// --- the generated section, compiled and run ---

const DIALECT = {
  eventKey: 'hook_event_name',
  eventNames: { 'session-start': 'SessionStart', 'tool-finished': 'PostToolUse', 'agent-idle': 'Stop' },
  sessionKey: 'session_id',
  cwdKey: 'cwd',
  toolNameKey: 'tool_name',
  toolInputKey: 'tool_input',
  toolResponseKey: 'tool_response',
};

// The generated file is an ES MODULE, so the section is compiled with its own imports in front of it and
// `require` is deliberately NOT put into the context: a section that reached for one would take its catch
// and register handlers that spawn nothing — a hook that never fires, said by nobody. That is what shipped
// past a first live run, because an earlier version of this harness supplied a `require`.
function runSection(hooks) {
  const text = hooksSection.hooksSection(hooks);
  if (!text) return null;
  const module_ = hooksSection.IMPORTS.join('\n') + '\n' + text + '\nexport { registerSourceHooks };';
  const code = require('esbuild').transformSync(module_, { loader: 'ts', format: 'cjs', target: 'node20' }).code;
  const mod = { exports: {} };
  const spawned = [];
  const child = () => {
    const handlers = {};
    return {
      on: (name, fn) => { handlers[name] = fn; },
      stderr: { on: (_n, fn) => { handlers.stderr = fn; } },
      stdin: { end: (data) => { handlers._stdin = data; } },
      kill: () => { handlers._killed = true; },
      _handlers: handlers,
    };
  };
  // esbuild turns the import into a `require` of its own, which is what a bundler does and what Pi's own
  // loader resolves — so the ONE name allowed here is the module the section imports, and anything else
  // throws rather than being quietly answered.
  const moduleRequire = (name) => {
    if (name !== 'node:child_process') throw new Error(`the section imported ${name}, which it should not`);
    return { spawn: (cmd, opts) => { const c = child(); spawned.push({ cmd, opts, child: c }); return c; } };
  };
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, JSON, Object, Array, String, Error, Set,
    require: moduleRequire, setTimeout, clearTimeout,
  });
  const events = {};
  mod.exports.registerSourceHooks({ on: (name, fn) => { events[name] = fn; } });
  return { events, spawned };
}

const plain = (v) => JSON.parse(JSON.stringify(v));

test('a hook runs on the target\'s own event, with the SOURCE\'s payload shape', async () => {
  const run = runSection([{ event: 'agent-idle', command: 'notify-me', timeoutMs: 1000, dialect: DIALECT }]);
  assert.deepEqual(Object.keys(run.events), ['agent_settled'], 'the target\'s event name, not the source\'s');

  const said = [];
  await run.events.agent_settled({}, { cwd: '/proj', ui: { notify: (t, l) => said.push([t, l]) }, sessionManager: { getSessionFile: () => '/s.jsonl' } });
  assert.equal(run.spawned.length, 1);
  assert.equal(run.spawned[0].cmd, 'notify-me');
  assert.equal(run.spawned[0].opts.shell, true, 'a hook IS a shell command line');
  assert.equal(run.spawned[0].opts.cwd, '/proj');
  // The keys are the SOURCE's, because that is what the user's own script reads.
  assert.deepEqual(plain(JSON.parse(run.spawned[0].child._handlers._stdin)), {
    hook_event_name: 'Stop', cwd: '/proj', session_id: '/s.jsonl',
  });
  assert.deepEqual(said, [], 'a hook that was started says nothing');
});

test('a tool moment carries the tool, its input and its answer — and a hook limited to tools runs only for those', async () => {
  const run = runSection([
    { event: 'tool-finished', command: 'any-tool', timeoutMs: 1000, dialect: DIALECT },
    { event: 'tool-finished', command: 'writes-only', tools: ['write'], timeoutMs: 1000, dialect: DIALECT },
  ]);
  const ctx = { cwd: '/p', ui: { notify: () => {} }, sessionManager: { getSessionFile: () => '/s' } };

  await run.events.tool_result({ toolName: 'read', input: { path: 'a.txt' }, content: 'hello' }, ctx);
  assert.deepEqual(run.spawned.map(s => s.cmd), ['any-tool'], 'the limited one did not run for a read');
  assert.deepEqual(plain(JSON.parse(run.spawned[0].child._handlers._stdin)), {
    hook_event_name: 'PostToolUse', cwd: '/p', session_id: '/s',
    tool_name: 'read', tool_input: { path: 'a.txt' }, tool_response: 'hello',
  });

  await run.events.tool_result({ toolName: 'write', input: { path: 'b.txt' }, content: 'ok' }, ctx);
  assert.deepEqual(run.spawned.map(s => s.cmd), ['any-tool', 'any-tool', 'writes-only']);

  // A tool the shared vocabulary has no word for is one the source could not have named in a matcher.
  await run.events.tool_result({ toolName: 'something_new', input: {}, content: '' }, ctx);
  assert.deepEqual(run.spawned.map(s => s.cmd).slice(-1), ['any-tool'], 'only the unlimited one');
});

test('a hook that fails says so; one that works does not', async () => {
  const run = runSection([{ event: 'agent-idle', command: 'flaky', timeoutMs: 1000, dialect: DIALECT }]);
  const said = [];
  const ctx = { cwd: '/p', ui: { notify: (t, l) => said.push([t, l]) }, sessionManager: { getSessionFile: () => '/s' } };

  await run.events.agent_settled({}, ctx);
  const h = run.spawned[0].child._handlers;
  // What a failing script really writes: colour codes, a first line that says the thing, and a stack.
  h.stderr(Buffer.from('[31mit went wrong[0m\n    at one (a.js:1:1)\n    at two (b.js:2:2)\n'));
  h.close(3);
  assert.equal(said.length, 1);
  assert.equal(said[0][1], 'warning');
  assert.match(said[0][0], /flaky/, 'the command is named, because that is what the user would go and look at');
  assert.match(said[0][0], /exited with 3/);
  assert.match(said[0][0], /it went wrong/);
  assert.equal(said[0][0].includes(''), false, 'without the colour codes a tool writes even to a pipe');
  assert.equal(said[0][0].includes('at one'), false, 'and without the frames after the line that says it');

  await run.events.agent_settled({}, ctx);
  run.spawned[1].child._handlers.close(0);
  assert.equal(said.length, 1, 'a hook that worked stays quiet');
});

test('a hook that cannot be started, and one that runs past its timeout, are both said once', async () => {
  const run = runSection([{ event: 'agent-idle', command: 'slow', timeoutMs: 20, dialect: DIALECT }]);
  const said = [];
  const ctx = { cwd: '/p', ui: { notify: (t, l) => said.push([t, l]) }, sessionManager: { getSessionFile: () => '/s' } };

  await run.events.agent_settled({}, ctx);
  const first = run.spawned[0].child._handlers;
  first.error(new Error('no such file'));
  assert.match(said[0][0], /no such file/);
  first.close(1);
  assert.equal(said.length, 1, 'the close that follows an error is not a second line');

  await run.events.agent_settled({}, ctx);
  const second = run.spawned[1].child._handlers;
  await new Promise(r => setTimeout(r, 60));
  assert.equal(said.length, 2);
  assert.match(said[1][0], /past its timeout/);
  assert.equal(second._killed, true, 'and it was actually stopped');
  second.close(null);
  assert.equal(said.length, 2, 'the close that follows the kill is not a third line');
});

// The guard that would have caught it: the generated file is an ES module, `require` is not defined in
// one, and a section reaching for it takes its catch and then registers handlers that spawn nothing. It
// costs a live run to notice, because nothing fails — the hooks simply never fire.
test('the section reaches for nothing that an ES module does not have', () => {
  const text = hooksSection.hooksSection([{ event: 'agent-idle', command: 'x', timeoutMs: 1000, dialect: DIALECT }]);
  assert.equal(/\brequire\s*\(/.test(text), false, 'no require: the generated file is a module, not a script');
  assert.ok(hooksSection.IMPORTS.some(i => /child_process/.test(i)), 'what it spawns with is imported at the top');
  assert.ok(hooksSection.IMPORTS.every(i => /^import /.test(i)), 'and as an import, the way the file is loaded');
});

test('a hook the target cannot place is reported rather than left out', () => {
  const placed = hooksSection.usable([
    { event: 'agent-idle', command: 'ok', dialect: DIALECT, path: 'a', scope: 'global' },
    { event: 'something-else', command: 'nope', dialect: DIALECT, path: 'b', scope: 'global' },
    { event: 'agent-idle', command: 'shapeless', path: 'c', scope: 'project' },
  ]);
  assert.deepEqual(placed.runnable.map(h => h.command), ['ok']);
  assert.deepEqual(placed.dropped.map(d => [d.path, d.reason]), [['b', 'no-event-here'], ['c', 'no-hook-dialect']]);
});

test('the generated section survives a command full of quotes, backticks and interpolation', () => {
  const nasty = 'echo `date` "${HOME}" \'x\' && printf "%s\\n" $(whoami)';
  const text = hooksSection.hooksSection([{ event: 'agent-idle', command: nasty, timeoutMs: 1000, dialect: DIALECT }]);
  assert.ok(text.includes(JSON.stringify(nasty).slice(1, -1)) || text.includes(JSON.stringify(nasty)),
    'the command is written as data, never as code');
  const run = runSection([{ event: 'agent-idle', command: nasty, timeoutMs: 1000, dialect: DIALECT }]);
  assert.ok(run, 'and it still compiles');
});
