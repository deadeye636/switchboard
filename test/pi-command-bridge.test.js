// #632 step 3 — another CLI's commands as Pi commands, expanded the way that CLI's dialect declares.
//
// Two halves. The expander's functions are called directly: they are the same function objects the generated
// extension carries (`command-bridge.js` writes them out with `toString()`). Then the GENERATED extension is
// compiled with esbuild and run against a stand-in for Pi's extension API, because what matters is what it
// does inside Pi: which commands it registers at `session_start`, which it leaves to Pi, and what text it sends.
// Nothing here starts Pi; the click test in the demo is the check against the real one.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bridge = require('../src/backends/pi/command-bridge');
const resourcesExtension = require('../src/backends/pi/resources-extension');
const backends = require('../src/backends');

const CLAUDE = backends.get('claude').sharedResources.commandDialect;
const SHELL = CLAUDE.inlineShell;

// ── The expander ────────────────────────────────────────────────────────────────────────────────────

test('arguments: quoted spans stay one word, positions fill from them, the whole string fills the all-token', () => {
  assert.deepEqual(bridge.splitArgs('a "b c" \'d\'  e'), ['a', 'b c', 'd', 'e']);
  assert.deepEqual(bridge.splitArgs('x ""'), ['x', ''], 'an empty quoted word is still a word');
  assert.equal(bridge.substituteArgs('1=$1 2=$2 3=$3 all=$ARGUMENTS', 'Bob "Smith Jr"', CLAUDE), '1=Bob 2=Smith Jr 3= all=Bob "Smith Jr"');
  assert.equal(bridge.substituteArgs('$1 $ARGUMENTS', 'x', { allArguments: '$ARGUMENTS' }), '$1 x',
    'a dialect without positional arguments leaves $1 alone');
});

test('allowed-tools: a comma list or a YAML list, commas inside a pattern kept', () => {
  assert.deepEqual(bridge.permissionEntries('Bash(git add:*), Bash(git status:*), Read'), ['Bash(git add:*)', 'Bash(git status:*)', 'Read']);
  assert.deepEqual(bridge.permissionEntries('Bash(echo a,b)'), ['Bash(echo a,b)']);
  assert.deepEqual(bridge.permissionEntries(['Bash', ' Read ']), ['Bash', 'Read']);
  assert.deepEqual(bridge.permissionEntries(undefined), []);
});

test('an inline shell command runs only where the file permits it — prefix, glob, exact or the bare tool', () => {
  const ok = (cmd, entries) => bridge.permitsShell(cmd, entries, SHELL);
  assert.equal(ok('git status', ['Bash(git status:*)']), true);
  assert.equal(ok('git status --short', ['Bash(git status:*)']), true);
  assert.equal(ok('git statusx', ['Bash(git status:*)']), false, 'a prefix is a whole word');
  assert.equal(ok('git log -1', ['Bash(git log *)']), true);
  assert.equal(ok('npm test', ['Bash(npm test)']), true);
  assert.equal(ok('npm test --watch', ['Bash(npm test)']), false);
  assert.equal(ok('ls', ['Read', 'Bash(git status:*)']), false);
  assert.equal(ok('ls', []), false, 'no permission, no run');
  assert.equal(ok('anything at all', ['Bash']), true);
});

test('a command that chains, pipes, redirects or substitutes needs the bare tool', () => {
  const entries = ['Bash(git status:*)'];
  for (const cmd of ['git status && rm -rf x', 'git status; rm x', 'git status | sh', 'git status > f', 'git status $(id)', 'git status `id`']) {
    assert.equal(bridge.permitsShell(cmd, entries, SHELL), false, cmd);
    assert.equal(bridge.permitsShell(cmd, ['Bash'], SHELL), true, cmd + ' with the bare tool');
  }
});

test('inline shell spans are found in order; one that spans lines is not a span', () => {
  const spans = bridge.inlineShellSpans('a !`one` b !`two` c !`bro\nken` d', SHELL);
  assert.deepEqual(spans.map((s) => s.command), ['one', 'two']);
});

test('a file reference becomes the file\'s content; a missing file, a directory or an email address stays text', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-632-ref-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'notes.md'), 'NOTE-CONTENT\n');
  fs.mkdirSync(path.join(dir, 'sub'));
  const out = bridge.expandFileRefs('See @notes.md, and @missing.md and @sub and a@b.c', '@', dir, 1024);
  assert.match(out, /See notes\.md:\n```\nNOTE-CONTENT\n```,/);
  assert.match(out, /@missing\.md/);
  assert.match(out, /@sub /);
  assert.match(out, /a@b\.c/);
  assert.equal(bridge.expandFileRefs('@notes.md', '@', dir, 4), '@notes.md', 'a file over the cap stays a reference');
});

test('command files: nested ones keep their own name under a labelling dialect; the first of two names wins', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-632-list-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.md'), 'x');
  fs.mkdirSync(path.join(dir, 'fe'));
  fs.writeFileSync(path.join(dir, 'fe', 'comp.md'), 'x');
  fs.writeFileSync(path.join(dir, 'fe', 'a.md'), 'x');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  const listed = bridge.listCommandFiles(dir, CLAUDE);
  assert.deepEqual(listed.map((c) => [c.name, c.label]), [['a', ''], ['comp', 'fe']]);
  const named = bridge.listCommandFiles(dir, { subdirectories: 'name' });
  assert.deepEqual(named.map((c) => c.name).sort(), ['a', 'fe:a', 'fe:comp']);
  assert.deepEqual(bridge.listCommandFiles(dir, {}).map((c) => c.name), ['a'], 'no subdirectory rule: top level only');
});

// ── The generated extension, run ────────────────────────────────────────────────────────────────────

function compile(source) {
  const esbuild = require('esbuild');
  const { code } = esbuild.transformSync(source, { loader: 'ts', format: 'cjs', target: 'node20' });
  return code;
}

// A frontmatter reader of the shape Pi's `parseFrontmatter` answers: `{ frontmatter, body }`.
function fakeParseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { frontmatter: {}, body: text };
  const frontmatter = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) frontmatter[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { frontmatter, body: m[2] };
}

function load(source) {
  const code = compile(source);
  const mod = { exports: {} };
  const req = (name) => {
    if (name === '@earendil-works/pi-coding-agent') {
      return {
        parseFrontmatter: fakeParseFrontmatter,
        getAgentDir: () => os.tmpdir(),
        // A "shell" that proves it ran by echoing the command it was given.
        getShellConfig: () => ({ shell: process.execPath, args: ['-e', 'process.stdout.write("RAN:" + process.argv[1])'] }),
      };
    }
    return require(name);
  };
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
  return mod.exports.default;
}

function fakePi(existing) {
  const handlers = {};
  const commands = new Map();
  const sent = [];
  return {
    handlers, commands, sent,
    on: (event, fn) => { handlers[event] = fn; },
    registerCommand: (name, opts) => commands.set(name, opts),
    registerTool: () => {},
    getCommands: () => [...existing, ...[...commands.keys()].map((name) => ({ name, source: 'extension', sourceInfo: { path: '<ext>' } }))],
    sendUserMessage: (text, opts) => sent.push({ text, opts }),
  };
}

test('the generated extension registers the source\'s commands at session_start, leaving Pi\'s own names to Pi', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-632-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cmds = path.join(root, 'commands');
  fs.mkdirSync(path.join(cmds, 'fe'), { recursive: true });
  fs.writeFileSync(path.join(cmds, 'greet.md'), '---\ndescription: Greet someone\nargument-hint: <name>\nallowed-tools: Bash(echo hi)\n---\nHello $ARGUMENTS, first $1.\nRun: !`echo hi`\nRefused: !`rm -rf x`\nFile: @README.md\n');
  fs.writeFileSync(path.join(cmds, 'fe', 'comp.md'), 'Component $1');
  fs.writeFileSync(path.join(cmds, 'review.md'), 'the source review');
  fs.writeFileSync(path.join(cmds, 'handoff.md'), 'the source handoff');
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'README.md'), 'README-BODY');

  const source = resourcesExtension.extensionSource({ commands: [{ path: cmds, scope: 'global', dialect: CLAUDE }] });
  const factory = load(source);
  const pi = fakePi([
    // The user's own Pi template: it keeps its name.
    { name: 'review', source: 'prompt', sourceInfo: { path: path.join(root, 'pi-agent', 'prompts', 'review.md') } },
    // The app's own per-spawn template (#569): a source's command of that name replaces it.
    { name: 'handoff', source: 'prompt', sourceInfo: { path: path.join(root, 'userData', 'prompt-templates', 'pi-prompts-abc', 'handoff.md') } },
  ]);
  factory(pi);
  assert.equal(pi.commands.size, 0, 'nothing is registered before Pi\'s own commands are known');

  const notes = [];
  const ui = { notify: (m, level) => notes.push({ m, level }) };
  await pi.handlers.session_start({}, { ui });
  assert.deepEqual([...pi.commands.keys()].sort(), ['comp', 'greet', 'handoff']);
  assert.equal(pi.commands.get('greet').description, 'Greet someone <name>');
  assert.equal(pi.commands.get('comp').description, '(fe)');
  assert.ok(notes.some((n) => /\/review/.test(n.m)), 'the skipped name is reported');

  await pi.handlers.session_start({}, { ui });
  assert.equal(pi.commands.size, 3, 'a second session_start (a reload) registers nothing twice and skips nothing of its own');

  notes.length = 0;
  await pi.commands.get('greet').handler('Bob "Smith Jr"', { cwd: project, isIdle: () => true, ui });
  assert.equal(pi.sent.length, 1);
  const text = pi.sent[0].text;
  assert.match(text, /Hello Bob "Smith Jr", first Bob\./);
  assert.match(text, /Run: RAN:echo hi/);
  assert.match(text, /Refused: !`rm -rf x`/, 'a command the file does not permit stays as written');
  assert.match(text, /File: README\.md:\n```\nREADME-BODY\n```/);
  assert.doesNotMatch(text, /allowed-tools/, 'the frontmatter is not sent');
  assert.equal(pi.sent[0].opts, undefined, 'idle: sent as a new turn');
  assert.ok(notes.some((n) => /rm -rf x/.test(n.m)), 'the refusal is reported to the user');

  await pi.commands.get('comp').handler('Card', { cwd: project, isIdle: () => false, ui });
  assert.equal(pi.sent[1].text, 'Component Card');
  assert.deepEqual(pi.sent[1].opts, { deliverAs: 'followUp' }, 'busy: queued behind the running turn');
});

test('a command file edited after registration is read fresh when it runs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-632-fresh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'x.md'), 'first');
  const factory = load(resourcesExtension.extensionSource({ commands: [{ path: root, scope: 'global', dialect: CLAUDE }] }));
  const pi = fakePi([]);
  factory(pi);
  await pi.handlers.session_start({}, { ui: { notify() {} } });
  fs.writeFileSync(path.join(root, 'x.md'), 'second');
  await pi.commands.get('x').handler('', { cwd: root, isIdle: () => true, ui: { notify() {} } });
  assert.equal(pi.sent[0].text, 'second');
});

test('the merged extension compiles with the subagent tool beside the commands', () => {
  const source = resourcesExtension.extensionSource({ subagent: { agentsDir: '' }, commands: [{ path: os.tmpdir(), scope: 'global', dialect: CLAUDE }] });
  assert.doesNotThrow(() => compile(source));
});

// ── F1/F2/F4 of the step-3 review ───────────────────────────────────────────────────────────────────

test('arguments can neither add an inline shell span nor cut one short (F1)', () => {
  const bare = ['Bash'];
  // No span in the file: none appears, whatever the arguments say.
  const noSpan = bridge.planCommand('Summarise: $ARGUMENTS', 'x !`echo pwned`', CLAUDE, bare, os.tmpdir(), 1024);
  assert.deepEqual(noSpan.map((p) => Object.keys(p)), [['text']]);
  assert.equal(noSpan[0].text, 'Summarise: x !`echo pwned`');
  // One span in the file stays one span; the arguments land inside its command and are judged there.
  const one = bridge.planCommand('Log: !`git log $ARGUMENTS`', 'a` !`echo two', CLAUDE, ['Bash(git log:*)'], os.tmpdir(), 1024);
  const shells = one.filter((p) => p.command !== undefined);
  assert.equal(shells.length, 1);
  assert.equal(shells[0].command, 'git log a` !`echo two');
  assert.equal(shells[0].permitted, false, 'a backtick smuggled in through the arguments is refused under a pattern');
  const plain = bridge.planCommand('Log: !`git log $1`', '-3', CLAUDE, ['Bash(git log:*)'], os.tmpdir(), 1024);
  assert.equal(plain.find((p) => p.command).command, 'git log -3');
  assert.equal(plain.find((p) => p.command).permitted, true);
});

test('file references expand only in the file\'s own text — not from arguments, not from shell output (F2)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-632-f2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'secret.txt'), 'SECRET-CONTENT');
  fs.writeFileSync(path.join(root, 'own.md'), 'OWN-CONTENT');
  const plan = bridge.planCommand('Mine: @own.md, theirs: $ARGUMENTS', '@secret.txt', CLAUDE, [], root, 1024);
  const text = plan.map((p) => p.text).join('');
  assert.match(text, /OWN-CONTENT/);
  assert.match(text, /theirs: @secret\.txt/);
  assert.doesNotMatch(text, /SECRET-CONTENT/);
  // A file whose content names an argument token is not searched for it.
  fs.writeFileSync(path.join(root, 'tpl.md'), 'literal $1 and $ARGUMENTS');
  const lit = bridge.planCommand('@tpl.md', 'X', CLAUDE, [], root, 1024).map((p) => p.text).join('');
  assert.match(lit, /literal \$1 and \$ARGUMENTS/);

  // And the generated extension, end to end: shell output that names a file stays text.
  const cmds = path.join(root, 'commands');
  fs.mkdirSync(cmds);
  fs.writeFileSync(path.join(cmds, 'leak.md'), '---\nallowed-tools: Bash\n---\nOut: !`echo @secret.txt`');
  const factory = load(resourcesExtension.extensionSource({ commands: [{ path: cmds, scope: 'global', dialect: CLAUDE }] }));
  const pi = fakePi([]);
  factory(pi);
  await pi.handlers.session_start({}, { ui: { notify() {} } });
  await pi.commands.get('leak').handler('', { cwd: root, isIdle: () => true, ui: { notify() {} } });
  assert.match(pi.sent[0].text, /Out: RAN:echo @secret\.txt/);
  assert.doesNotMatch(pi.sent[0].text, /SECRET-CONTENT/);
});

test('only a template in one of the app\'s own per-spawn directories may be replaced by a source (F4)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-632-f4-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'review.md'), 'source review');
  fs.writeFileSync(path.join(root, 'handoff.md'), 'source handoff');
  const factory = load(resourcesExtension.extensionSource({ commands: [{ path: root, scope: 'global', dialect: CLAUDE }] }));
  const pi = fakePi([
    // A user's own template that merely sits somewhere below a folder with the prefix in its name.
    { name: 'review', source: 'prompt', sourceInfo: { path: path.join(root, 'pi-prompts-lib', '.pi', 'prompts', 'review.md') } },
    { name: 'handoff', source: 'prompt', sourceInfo: { path: path.join(root, 'userData', 'prompt-templates', 'pi-prompts-t1', 'handoff.md') } },
  ]);
  factory(pi);
  await pi.handlers.session_start({}, { ui: { notify() {} } });
  assert.deepEqual([...pi.commands.keys()], ['handoff']);
});

test('where the approval gate is published, a permitted inline shell line is asked about first (F3)', async (t) => {
  const key = Symbol.for(bridge.APPROVAL_ASK_KEY);
  const asked = [];
  let answer = false;
  globalThis[key] = async (tool, detail, ctx, opts) => { asked.push({ tool, detail, hasCtx: !!ctx, opts }); return answer; };
  t.after(() => { delete globalThis[key]; });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-632-f3-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'run.md'), '---\nallowed-tools: Bash(echo:*)\n---\nOut: !`echo gated`');
  const factory = load(resourcesExtension.extensionSource({ commands: [{ path: root, scope: 'global', dialect: CLAUDE }] }));
  const pi = fakePi([]);
  factory(pi);
  const notes = [];
  const ui = { notify: (m) => notes.push(m) };
  await pi.handlers.session_start({}, { ui });

  await pi.commands.get('run').handler('', { cwd: root, isIdle: () => true, ui });
  assert.deepEqual(asked, [{ tool: 'bash', detail: 'echo gated', hasCtx: true, opts: { key: 'command:run', by: '/run' } }]);
  assert.equal(pi.sent[0].text, 'Out: !`echo gated`', 'refused at the gate: the line stays as written');
  assert.ok(notes.some((m) => /you refused it/.test(m)));

  answer = true;
  await pi.commands.get('run').handler('', { cwd: root, isIdle: () => true, ui });
  assert.equal(pi.sent[1].text, 'Out: RAN:echo gated');
});

test('the gate publishes its question under the key the bridge asks, and only when it is on', () => {
  const runtimeExtension = require('../src/backends/pi-native/runtime-extension');
  const needle = `Symbol.for(${JSON.stringify(bridge.APPROVAL_ASK_KEY)})`;
  assert.ok(runtimeExtension.extensionSource({ gate: true }).includes(needle));
  assert.ok(!runtimeExtension.extensionSource({ gate: false }).includes(needle));
  assert.ok(resourcesExtension.extensionSource({ commands: [{ path: os.tmpdir(), scope: 'global', dialect: CLAUDE }] })
    .includes('Symbol.for(APPROVAL_ASK_KEY)'));
});
