'use strict';

// #616 step 2 — a project's .vscode/tasks.json as plain rows for the launch popover.
// The decisions E1–E7 on the issue are what these cases pin.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readVscodeTasks, rowsFromTasksJson, parseTasksText, MAX_BYTES } = require('../src/app/vscode-tasks');

const PROJECT = path.resolve(os.tmpdir(), 'sb-vscode-tasks-project');
const rows = (tasks, extra = {}, env = {}) => rowsFromTasksJson({ version: '2.0.0', tasks, ...extra }, PROJECT, env);

test('a shell task becomes an enabled row with the launcher fields', () => {
  const [row] = rows([{ label: 'build', type: 'shell', command: 'npm run build', args: ['--', '--watch'] }]);
  assert.equal(row.name, 'build');
  assert.equal(row.disabled, false);
  assert.equal(row.command, 'npm run build');
  assert.deepEqual(row.args, ['--', '--watch']);
  assert.equal(row.commandLine, 'npm run build -- --watch');
});

test('E2: a typed task is listed and disabled with its reason, never translated', () => {
  const [row] = rows([{ type: 'npm', script: 'test' }]);
  assert.equal(row.name, 'npm: test');
  assert.equal(row.disabled, true);
  assert.match(row.reason, /“npm” task has no command line/);
  assert.equal(row.command, undefined);
});

test('a task with no command (dependsOn only) is disabled and says why', () => {
  const [row] = rows([{ label: 'all', dependsOn: ['a', 'b'] }]);
  assert.equal(row.disabled, true);
  assert.match(row.reason, /dependsOn/);
});

test('E3: the supported variables are substituted', () => {
  const [row] = rows([{
    label: 'v', type: 'shell', command: 'echo ${workspaceFolderBasename}',
    args: ['${workspaceFolder}${pathSeparator}x', '${env:SB_TEST_VAR}', '${cwd}', '${userHome}'],
    options: { cwd: '${workspaceFolder}/sub' },
  }], {}, { SB_TEST_VAR: 'hello' });
  assert.equal(row.disabled, false);
  assert.equal(row.command, `echo ${path.basename(PROJECT)}`);
  assert.deepEqual(row.args, [PROJECT + path.sep + 'x', 'hello', PROJECT, os.homedir()]);
  assert.equal(row.cwd, path.resolve(PROJECT, 'sub'));
});

test('E3: an unsupported variable disables the row and names itself', () => {
  const [row] = rows([{ label: 'f', type: 'shell', command: 'tsc ${file}', args: ['${input:target}'] }]);
  assert.equal(row.disabled, true);
  assert.match(row.reason, /\$\{file\}/);
  assert.match(row.reason, /\$\{input:target\}/);
});

test('a process task whose program path holds a space is refused, not mis-run', () => {
  const [row] = rows([{ label: 'p', type: 'process', command: 'C:/Program Files/tool.exe' }]);
  assert.equal(row.disabled, true);
});

test('the platform override and the { value } command form are read', () => {
  const key = { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform];
  const [row] = rows([{ label: 'o', type: 'shell', command: 'generic', [key]: { command: { value: 'specific' } } }]);
  assert.equal(row.command, 'specific');
});

test('options.env is carried with substitution; top-level options apply to every task', () => {
  const [row] = rows([{ label: 'e', type: 'shell', command: 'run' }],
    { options: { env: { ROOT: '${workspaceFolder}' } } });
  assert.deepEqual(row.env, { ROOT: PROJECT });
});

test('a task env merges over the top-level env variable by variable', () => {
  const [row] = rows([{ label: 'm', type: 'shell', command: 'run', options: { env: { B: '2' } } }],
    { options: { env: { A: '1', B: '0' } } });
  assert.deepEqual(row.env, { A: '1', B: '2' });
});

test('an env value shaped like $NAME is carried as it stands (the spawn path reads it as a reference)', () => {
  const [row] = rows([{ label: 'r', type: 'shell', command: 'run', options: { env: { A: '$HOME' } } }]);
  assert.deepEqual(row.env, { A: '$HOME' });
});

test('a line break in the command, an arg, the cwd or an env value disables the row', () => {
  // Typed into a shell, a break submits the first half and runs the rest as a second command.
  const cases = [
    { command: 'echo a\ncalc' },
    { command: 'echo', args: ['x\ncalc'] },
    { command: 'echo', args: [{ value: 'x\r\ncalc', quoting: 'strong' }] },
    { command: 'echo', options: { cwd: 'sub\ncalc' } },
    { command: 'echo', options: { env: { A: 'x\ncalc' } } },
  ];
  for (const c of cases) {
    const [row] = rows([{ label: 'b', type: 'shell', ...c }]);
    assert.equal(row.disabled, true, JSON.stringify(c));
    assert.match(row.reason, /line break/);
    assert.equal(row.command, undefined, 'a disabled row carries nothing to run');
    assert.doesNotMatch(row.commandLine, /[\r\n]/, 'the preview stays one line');
  }
});

test('a hidden task and a non-object entry are left out; a missing label gets a name', () => {
  const out = rows([{ label: 'h', type: 'shell', command: 'x', hide: true }, 42, { type: 'shell', command: 'y' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'shell task 3');
});

test('E1: only tasks[] — a document without it has no rows', () => {
  assert.deepEqual(rowsFromTasksJson({ configurations: [{ name: 'debug' }] }, PROJECT), []);
  assert.deepEqual(rowsFromTasksJson(null, PROJECT), []);
});

test('E4: jsonc with comments and trailing commas parses; a malformed file is null', () => {
  const ok = parseTasksText('\uFEFF{ // c\n "tasks": [ { "label": "a", "type": "shell", "command": "x", }, ], }');
  assert.equal(ok.tasks[0].label, 'a');
  assert.equal(parseTasksText('{ "tasks": [ '), null);
});

test('readVscodeTasks reads the real file, and answers [] on every failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-vscode-tasks-'));
  try {
    assert.deepEqual(await readVscodeTasks(dir), [], 'no .vscode folder');
    assert.deepEqual(await readVscodeTasks('relative/path'), []);
    assert.deepEqual(await readVscodeTasks(null), []);

    fs.mkdirSync(path.join(dir, '.vscode'));
    const file = path.join(dir, '.vscode', 'tasks.json');
    fs.writeFileSync(file, '{ "version": "2.0.0", "tasks": [ { "label": "dev", "type": "shell", "command": "npm run dev" }, ] }');
    const out = await readVscodeTasks(dir);
    assert.equal(out.length, 1);
    assert.equal(out[0].command, 'npm run dev');

    fs.writeFileSync(file, '{ "tasks": [');
    assert.deepEqual(await readVscodeTasks(dir), [], 'malformed');

    fs.writeFileSync(file, ' '.repeat(MAX_BYTES + 1));
    assert.deepEqual(await readVscodeTasks(dir), [], 'over the size cap');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a .vscode linked to a folder outside the project is not read (reflex 13)', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-vscode-tasks-in-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-vscode-tasks-out-'));
  try {
    fs.writeFileSync(path.join(outside, 'tasks.json'), '{ "tasks": [ { "label": "x", "type": "shell", "command": "x" } ] }');
    try {
      fs.symlinkSync(outside, path.join(project, '.vscode'), 'junction');
    } catch {
      t.skip('this machine cannot create a directory link');
      return;
    }
    assert.deepEqual(await readVscodeTasks(project), []);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a network path is refused before anything touches it', async () => {
  let asked = null;
  const guard = (p) => { asked = p; return true; };
  assert.deepEqual(await readVscodeTasks('\\\\host\\share\\project', { isForeignNetworkFile: guard }), []);
  assert.match(asked, /tasks\.json$/, 'the guard is asked about the file');
  // Without main's guard every share counts as foreign — still nothing read.
  assert.deepEqual(await readVscodeTasks('\\\\host\\share\\project'), []);
});
