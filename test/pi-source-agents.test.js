// #639 — another CLI's agents run through Pi's subagent tool.
//
// Three layers: the mapping on its own (a plain function, the same one written into the extension), the
// generated section RUN against agent files on disk (which agent a name means, and what the approval question
// is told), and the approval gate's use of that answer.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const subagentTool = require('../src/backends/pi/subagent-tool');
const runtimeExtension = require('../src/backends/pi-native/runtime-extension');
const { permissionEntries } = require('../src/backends/pi/command-bridge');
const { isToolWord } = require('../src/backends/tool-vocabulary');
const backends = require('../src/backends');

const claudeDialect = () => backends.get('claude').sharedResources.agentDialect;
const map = (fm) => subagentTool.mapSourceAgent(fm, claudeDialect(), subagentTool.TOOL_FOR_WORD, subagentTool.DEFAULT_TOOLS, permissionEntries);

test('Pi declares a tool for words of the vocabulary only, and only tools it has', () => {
  const piTools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'powershell'];
  for (const [word, tool] of Object.entries(subagentTool.TOOL_FOR_WORD)) {
    assert.ok(isToolWord(word), `"${word}" is not in the vocabulary`);
    assert.ok(piTools.includes(tool), `"${tool}" is not one of Pi's tools`);
  }
  for (const t of subagentTool.DEFAULT_TOOLS) assert.ok(piTools.includes(t));
});

test('a Claude agent\'s tools become Pi\'s; one with no counterpart is left out, and said', () => {
  const m = map({ tools: 'Read, Glob, Bash, WebFetch' });
  assert.deepEqual(m.tools, ['read', 'find', 'bash']);
  assert.deepEqual(m.dropped.map((d) => d.name), ['WebFetch']);
  assert.equal(m.refused, null);
  assert.deepEqual(map({ tools: ['Grep', 'LS', 'Edit', 'MultiEdit', 'Write'] }).tools, ['grep', 'ls', 'edit', 'write'], 'a YAML list works too');
});

test('a restricted entry is left out, never widened into the whole tool', () => {
  const m = map({ tools: 'Read, Bash(git status:*), Bash(git add, git commit)' });
  assert.deepEqual(m.tools, ['read']);
  assert.deepEqual(m.dropped.map((d) => [d.name, /pattern/.test(d.why)]), [
    ['Bash(git status:*)', true],
    ['Bash(git add, git commit)', true],
  ], 'a comma inside the parentheses does not split the entry');
});

test('an agent left with no tool is refused; one with no tools line gets Pi\'s defaults', () => {
  assert.match(map({ tools: 'WebFetch, WebSearch' }).refused, /none of its tools/);
  assert.match(map({ tools: 'Bash(rm:*)' }).refused, /none of its tools/);
  const none = map({});
  assert.equal(none.tools, undefined);
  assert.equal(none.refused, null);
});

test('disallowedTools takes the whole tool away, from Pi\'s defaults when no tools line names any', () => {
  assert.deepEqual(map({ disallowedTools: 'Bash' }).tools, ['read', 'edit', 'write']);
  assert.deepEqual(map({ tools: 'Read, Bash', disallowedTools: 'Bash(rm:*)' }).tools, ['read'], 'a restricted deny takes the whole tool');
  assert.match(map({ tools: 'Bash', disallowedTools: 'Bash' }).refused, /denied/);
});

test('model: inherit means the caller\'s model; any other name is carried as written', () => {
  assert.deepEqual([map({ model: 'inherit' }).model, map({ model: 'inherit' }).inheritsModel], [undefined, true]);
  assert.deepEqual([map({ model: 'sonnet' }).model, map({ model: 'sonnet' }).inheritsModel], ['sonnet', false]);
  assert.equal(map({}).model, undefined);
});

// ── The section, run ───────────────────────────────────────────────────────────────────────────────────

function writeAgent(dir, file, fm, body = 'Body.') {
  fs.mkdirSync(dir, { recursive: true });
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  fs.writeFileSync(path.join(dir, file), ['---', ...lines, '---', body].join('\n'));
}

// A frontmatter reader good enough for `key: value` lines — the section only needs the parsed fields.
function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  if (!m) return { frontmatter: {}, body: text };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { frontmatter: fm, body: m[2] };
}

// The agent dir defaults to one that does not exist, so a settings.json lying around in the temp directory
// cannot change what a test sees.
function runSection({ piAgents, sources, agentDir = path.join(os.tmpdir(), `sb-639-no-agent-dir-${process.pid}`) }) {
  const { code } = require('esbuild').transformSync(
    subagentTool.extensionSource({ agentsDir: piAgents, sourceAgents: sources }),
    { loader: 'ts', format: 'cjs', target: 'node20' },
  );
  const registered = [];
  const g = {};
  const fakeRequire = (id) => {
    if (id === '@earendil-works/pi-coding-agent') return { getAgentDir: () => agentDir, parseFrontmatter };
    return require(id);
  };
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: fakeRequire, process, Buffer, JSON, setTimeout, clearTimeout, globalThis: g, Symbol });
  mod.exports.default({ registerTool: (t) => registered.push(t) });
  return { tool: registered[0], describe: g[Symbol.for(subagentTool.DESCRIBE_KEY)] };
}

test('the section: Pi\'s own agent wins a name, a source agent is mapped, a refused one is not offered', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-639-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const own = path.join(root, 'pi-agents');
  const srcGlobal = path.join(root, 'claude', 'agents');
  const srcProject = path.join(root, 'project', '.claude', 'agents');
  writeAgent(own, 'shared.md', { name: 'shared', description: 'Pi own', tools: 'read' });
  writeAgent(srcGlobal, 'shared.md', { name: 'shared', description: 'Claude one', tools: 'Bash' });
  writeAgent(srcGlobal, 'reader.md', { name: 'reader', description: 'reads', tools: 'Read, Glob, WebFetch', model: 'inherit' });
  writeAgent(srcGlobal, 'web.md', { name: 'web', description: 'fetches', tools: 'WebFetch' });
  writeAgent(srcProject, 'reader.md', { name: 'reader', description: 'project reader', tools: 'Grep' });
  const dialect = claudeDialect();
  const { tool, describe } = runSection({
    piAgents: own,
    sources: [{ path: srcProject, scope: 'project', dialect }, { path: srcGlobal, scope: 'global', dialect }],
  });

  assert.match(tool.description, /shared \(Pi own\)/, 'Pi\'s own agent keeps its name');
  assert.doesNotMatch(tool.description, /Claude one/);
  assert.match(tool.description, /reader \(project reader\)/, 'the project agent comes before the global one');
  assert.doesNotMatch(tool.description, /web \(/, 'an agent that would be refused is not offered');

  const shared = describe(root, 'shared');
  assert.equal(shared.key, 'pi::shared');
  assert.equal(shared.refused, false);
  const reader = describe(root, 'reader');
  assert.equal(reader.key, 'source:project:reader', 'the key names where the agent came from, scope included');
  assert.match(reader.text, /tools grep; model/);
  const web = describe(root, 'web');
  assert.equal(web.refused, true);
  assert.match(web.text, /will be refused/);
  assert.match(web.text, /WebFetch \(no counterpart here\)/);

  const refused = await tool.execute('x', { agent: 'web', task: 'go' }, undefined, undefined, { cwd: root });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /cannot run here/);
  assert.equal(refused.details.origin, 'source');
});

// ── The approval gate ──────────────────────────────────────────────────────────────────────────────────

function loadGate(globals) {
  const { code } = require('esbuild').transformSync(runtimeExtension.extensionSource({ gate: true }), { loader: 'ts', format: 'cjs', target: 'node20' });
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, JSON, ...globals });
  const handlers = {};
  mod.exports.default({ on: (ev, fn) => { handlers[ev] = fn; }, appendEntry: () => {} });
  return handlers;
}

test('the gate: an allow is keyed by where the agent came from, and a refused delegation is blocked without a question', async () => {
  let answer = { text: 'Agent a', key: 'pi:a', refused: false };
  const handlers = loadGate({ [Symbol.for(subagentTool.DESCRIBE_KEY)]: () => answer });
  let asks = 0;
  const call = (reply) => handlers.tool_call({ toolName: 'subagent', toolCallId: 'd', input: { agent: 'a', task: 't' } },
    { ui: { select: async () => { asks++; return reply; } }, cwd: '<project>' });
  assert.equal(await call(runtimeExtension.CHOICES.session), undefined);
  assert.equal(await call(undefined), undefined, 'the same agent from the same place runs unasked');
  assert.equal(asks, 1);
  answer = { text: 'Agent a', key: 'source:a', refused: false };
  assert.equal((await call(undefined)).block, true, 'another agent under the same name is asked about again');
  assert.equal(asks, 2);
  answer = { text: 'Agent a will be refused', key: 'source:a', refused: true };
  const blocked = await call(undefined);
  assert.equal(blocked.block, true, 'blocked, not waved through: a file written in the same batch could make it runnable');
  assert.match(blocked.reason, /will be refused/);
  assert.equal(asks, 2, 'and nobody is asked');
});

test('a dialect that does not say how agents name their tools refuses, never grants the defaults', () => {
  for (const dialect of [{}, { toolsKey: 'tools' }, { toolWords: { Read: 'read' } }]) {
    const m = subagentTool.mapSourceAgent({ tools: 'WebFetch' }, dialect, subagentTool.TOOL_FOR_WORD, subagentTool.DEFAULT_TOOLS, permissionEntries);
    assert.ok(m.refused, JSON.stringify(dialect));
    assert.deepEqual(m.tools, []);
  }
});

test('a blank tools line is no tools line, whitespace included', () => {
  assert.equal(map({ tools: '' }).tools, undefined);
  assert.equal(map({ tools: '   ' }).tools, undefined);
  assert.equal(map({ tools: '   ' }).refused, null);
});

test('a denial nobody recognises is reported, and takes nothing away', () => {
  const m = map({ disallowedTools: 'bash' });
  assert.equal(m.tools, undefined, 'lower-case bash is not Claude\'s tool name, so the defaults stand');
  assert.deepEqual(m.dropped.map((d) => d.name), ['bash']);
  assert.match(m.dropped[0].why, /not a tool this mapping knows/);
});

test('the defaults a denial is taken from are Pi\'s defaultTools setting when there is one', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-639d-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const src = path.join(root, 'claude', 'agents');
  writeAgent(src, 'nobash.md', { name: 'nobash', description: 'no shell', disallowedTools: 'Bash' });
  fs.mkdirSync(path.join(root, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pi', 'settings.json'), JSON.stringify({ defaultTools: ['read', 'bash'] }));
  const { describe } = runSection({ piAgents: path.join(root, 'none'), sources: [{ path: src, scope: 'global', dialect: claudeDialect() }] });
  assert.match(describe(root, 'nobash').text, /tools read;/, 'the user\'s own default, minus the denied tool — never Pi\'s wider built-in list');
});

test('a project\'s own defaultTools only narrows: an untrusted project cannot widen the user\'s global list', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-639e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultTools: ['read', 'grep'] }));
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(project, '.pi', 'settings.json'), JSON.stringify({ defaultTools: ['read', 'grep', 'bash', 'edit', 'write'] }));
  const src = path.join(root, 'claude', 'agents');
  writeAgent(src, 'nogrep.md', { name: 'nogrep', description: 'x', disallowedTools: 'Grep' });
  const { describe } = runSection({ piAgents: path.join(root, 'none'), sources: [{ path: src, scope: 'global', dialect: claudeDialect() }], agentDir });
  assert.match(describe(project, 'nogrep').text, /tools read;/, 'the global list, minus the denied tool — the project\'s wider list adds nothing');
});
