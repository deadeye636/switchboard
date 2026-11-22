'use strict';
// Pi's MCP quartet (#808): `src/backends/pi/mcp-inject.js` writes a per-spawn extension that registers http servers
// with Pi's own MCP client. The generated TypeScript is compiled with esbuild and run in a vm against a fake `pi`
// (.claude/rules/guards-and-scripts.md, "Code this app GENERATES is tested by running it").
//
// What is pinned:
//   - an http row becomes one `registerMcpServer` call with its url, `exposure: 'direct'`, and its header values
//     read from the environment, which the extension then deletes; the file names the variables, never a value;
//   - a second runtime (/new, /resume, /fork) and a re-evaluation (/reload) register again WITH the headers,
//     although the variables are gone by then;
//   - two servers never share a variable; names Pi counts as one server are given once;
//   - a stdio row, a bad name and a header value Pi would expand or run are left out;
//   - a server Pi refuses does not stop the others and is said; a Pi without `registerMcpServer` registers
//     nothing, still clears the variables, and says so at session_start;
//   - a tag that cannot name a file writes nothing; release removes the file it wrote and nothing else.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const mcpInject = require('../src/backends/pi/mcp-inject');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pi-mcp-inject-'));
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const OWN = { name: 'switchboard', transport: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer tok-own' } };

const compile = (file) => require('esbuild').transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node20' }).code;

/** A Pi process: one vm context (one `globalThis`) and one environment, across evaluations and runtimes. */
function piProcess(env) {
  const fakeEnv = { ...env };
  const context = vm.createContext({ process: { env: fakeEnv }, JSON, Object, String, Symbol });
  return {
    env: fakeEnv,
    /** Evaluates the file (Pi's load or /reload) and answers its default export. */
    load(file) {
      const mod = { exports: {} };
      vm.runInContext('(function (module, exports) {\n' + compile(file) + '\n})', context)(mod, mod.exports);
      return mod.exports.default || mod.exports;
    },
  };
}

/** One runtime: calls the factory with a fake `pi`; answers what it registered and the handlers it set. */
function runtime(factory, { withClient = true, refuse = [] } = {}) {
  const registered = [];
  const handlers = {};
  const pi = { on: (ev, fn) => { handlers[ev] = fn; } };
  if (withClient) {
    pi.registerMcpServer = (name, config) => {
      if (refuse.includes(name)) throw new Error('rejected');
      registered.push({ name, config });
    };
  }
  factory(pi);
  return { registered: JSON.parse(JSON.stringify(registered)), handlers };
}

async function notesOf(handlers) {
  const notes = [];
  if (handlers.session_start) await handlers.session_start({}, { ui: { notify: (text, level) => notes.push({ text, level }) } });
  return notes;
}

test('an http row is registered with Pi\'s client, its header read from the env and then deleted', () => {
  const built = mcpInject.buildMcpInjection({ dir, tag: 't1', servers: [OWN] });
  assert.ok(built);
  assert.equal(built.args[0], '-e');
  const file = built.args[1];
  assert.equal(path.basename(file), 'pi-mcp-t1.ts');
  assert.equal(fs.readFileSync(file, 'utf8').includes('tok-own'), false, 'the file names the variable, never the value');
  const varName = mcpInject.headerEnvVar(0, 0);
  assert.deepEqual(built.env, { [varName]: 'Bearer tok-own' });

  const proc = piProcess({ ...built.env, OTHER: 'kept' });
  const r = runtime(proc.load(file));
  assert.deepEqual(r.registered, [{ name: 'switchboard', config: { url: OWN.url, headers: { Authorization: 'Bearer tok-own' }, exposure: 'direct' } }]);
  assert.equal(proc.env[varName], undefined, 'the token is gone from the environment the agent\'s shell inherits');
  assert.equal(proc.env.OTHER, 'kept');
  mcpInject.releaseMcpInjection(built.cleanup);
  assert.equal(fs.existsSync(file), false);
});

test('a second runtime and a /reload register again with the headers, from the registry', () => {
  const built = mcpInject.buildMcpInjection({ dir, tag: 't-reload', servers: [OWN] });
  const proc = piProcess(built.env);
  const factory = proc.load(built.args[1]);
  const first = runtime(factory);
  const second = runtime(factory);                       // /new, /resume, /fork: the same module, a new runtime
  const reloaded = runtime(proc.load(built.args[1]));    // /reload: the file evaluated again, the variable gone
  for (const r of [first, second, reloaded]) {
    assert.deepEqual(r.registered[0].config.headers, { Authorization: 'Bearer tok-own' });
  }
  assert.equal(Object.keys(proc.env).length, 0);
  mcpInject.releaseMcpInjection(built.cleanup);
});

test('two servers never share a variable, and names Pi counts as one server are given once', () => {
  const servers = [
    { name: 'a', transport: 'http', url: 'http://a/mcp', headers: { 'B-X': 'secret-a' } },
    { name: 'a-b', transport: 'http', url: 'http://ab/mcp', headers: { X: 'secret-ab' } },
    { name: 'a_b', transport: 'http', url: 'http://dup/mcp', headers: { X: 'secret-dup' } },
  ];
  const built = mcpInject.buildMcpInjection({ dir, tag: 't-collide', servers });
  assert.equal(Object.keys(built.env).length, 2);
  const r = runtime(piProcess(built.env).load(built.args[1]));
  assert.deepEqual(r.registered.map((x) => [x.name, x.config.headers]), [['a', { 'B-X': 'secret-a' }], ['a-b', { X: 'secret-ab' }]]);
  mcpInject.releaseMcpInjection(built.cleanup);
});

test('stdio rows, bad names and header values Pi would expand or run are left out', () => {
  const servers = [
    { name: 'local', transport: 'stdio', command: 'node', args: [] },
    { name: 'bad name', transport: 'http', url: 'http://x/mcp' },
    { name: 'expands', transport: 'http', url: 'http://x/mcp', headers: { 'X-Key': 'a${HOME}' } },
    { name: 'runs', transport: 'http', url: 'http://x/mcp', headers: { 'X-Key': '!echo hi' } },
    { name: 'remote', transport: 'http', url: 'https://example.invalid/mcp', headers: {} },
  ];
  const built = mcpInject.buildMcpInjection({ dir, tag: 't2', servers });
  const r = runtime(piProcess(built.env || {}).load(built.args[1]));
  assert.deepEqual(r.registered.map((x) => x.name), ['remote']);
  assert.equal(built.env, null, 'no header, no variable');
  mcpInject.releaseMcpInjection(built.cleanup);
  assert.equal(mcpInject.buildMcpInjection({ dir, tag: 't3', servers: servers.slice(0, 4) }), null, 'nothing usable is null');
});

test('a server Pi refuses does not stop the others, and is said', async () => {
  const servers = [{ name: 'first', transport: 'http', url: 'http://1/mcp' }, OWN];
  const built = mcpInject.buildMcpInjection({ dir, tag: 't-refuse', servers });
  const r = runtime(piProcess(built.env).load(built.args[1]), { refuse: ['first'] });
  assert.deepEqual(r.registered.map((x) => x.name), ['switchboard']);
  const notes = await notesOf(r.handlers);
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /first/);
  mcpInject.releaseMcpInjection(built.cleanup);
});

test('a Pi without registerMcpServer registers nothing, clears the variables and says so once', async () => {
  const built = mcpInject.buildMcpInjection({ dir, tag: 't4', servers: [OWN] });
  const proc = piProcess(built.env);
  const r = runtime(proc.load(built.args[1]), { withClient: false });
  assert.deepEqual(r.registered, []);
  assert.equal(Object.keys(proc.env).length, 0);
  const notes = await notesOf(r.handlers);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].level, 'warning');
  assert.match(notes[0].text, /switchboard/);
  mcpInject.releaseMcpInjection(built.cleanup);
});

test('a tag that cannot name a file writes nothing; release removes only a file this module named', () => {
  assert.equal(mcpInject.buildMcpInjection({ dir, tag: '../x', servers: [OWN] }), null);
  assert.equal(mcpInject.buildMcpInjection({ dir, tag: '', servers: [OWN] }), null);
  const other = path.join(dir, 'pi-resources-x.ts');
  const lookalike = path.join(dir, 'pi-mcp-x.ts.bak');
  fs.writeFileSync(other, '//');
  fs.writeFileSync(lookalike, '//');
  mcpInject.releaseMcpInjection({ file: other });
  mcpInject.releaseMcpInjection({ file: lookalike });
  assert.equal(fs.existsSync(other), true);
  assert.equal(fs.existsSync(lookalike), true);
  mcpInject.releaseMcpInjection(null);
  mcpInject.releaseMcpInjection({});
});
