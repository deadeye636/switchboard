const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeLauncher,
  normalizeLauncherList,
  mergeCustomLaunchers,
  launcherOrigin,
  launcherId,
} = require('../src/shared/custom-launchers');

test('normalizeLauncher: fills defaults and keeps the canonical shape', () => {
  const e = normalizeLauncher({ id: 'dev', command: 'npm run dev' });
  assert.deepStrictEqual(e, { id: 'dev', name: 'npm run dev', command: 'npm run dev', runMode: 'in-app' });
});

test('normalizeLauncher: keeps args, cwd, env, icon and an explicit external runMode', () => {
  const e = normalizeLauncher({
    id: 'log',
    name: 'Git log',
    icon: 'terminal',
    command: 'git',
    args: ['log', '--oneline', ''],
    cwd: 'D:\\repo',
    env: { GIT_PAGER: '$PAGER', '': 'dropped' },
    runMode: 'external',
  });
  assert.deepStrictEqual(e, {
    id: 'log',
    name: 'Git log',
    icon: 'terminal',
    command: 'git',
    args: ['log', '--oneline'],
    cwd: 'D:\\repo',
    env: { GIT_PAGER: '$PAGER' },
    runMode: 'external',
  });
});

test('normalizeLauncher: an unknown runMode falls back to in-app (never silently external)', () => {
  assert.strictEqual(normalizeLauncher({ id: 'a', command: 'x', runMode: 'detached' }).runMode, 'in-app');
});

test('normalizeLauncher: rejects an entry with no id or no command', () => {
  assert.strictEqual(normalizeLauncher({ command: 'npm run dev' }), null);
  assert.strictEqual(normalizeLauncher({ id: 'dev' }), null);
  assert.strictEqual(normalizeLauncher({ id: 'dev', command: '   ' }), null);
  assert.strictEqual(normalizeLauncher(null), null);
});

test('normalizeLauncher: a newline cannot smuggle a second command line in', () => {
  const e = normalizeLauncher({ id: 'a', command: 'npm run dev\r\nrm -rf /' });
  assert.strictEqual(e.command, 'npm run dev rm -rf /');
  assert.ok(!/[\r\n]/.test(e.command));
});

test('normalizeLauncherList: drops unusable entries and duplicate ids (first wins)', () => {
  const list = normalizeLauncherList([
    { id: 'a', command: 'one' },
    { id: 'a', command: 'two' },
    { id: '', command: 'nope' },
    'garbage',
    { id: 'b', command: 'three' },
  ]);
  assert.deepStrictEqual(list.map(e => [e.id, e.command]), [['a', 'one'], ['b', 'three']]);
});

test('mergeCustomLaunchers: global list is the template for a project with none of its own', () => {
  const globals = [{ id: 'dev', command: 'npm run dev' }, { id: 'log', command: 'git log' }];
  const merged = mergeCustomLaunchers(globals, []);
  assert.deepStrictEqual(merged.map(e => e.id), ['dev', 'log']);
});

test('mergeCustomLaunchers: a project entry overrides the same-id global one, in place', () => {
  const globals = [{ id: 'dev', command: 'npm run dev' }, { id: 'log', command: 'git log' }];
  const project = [{ id: 'dev', name: 'Dev (this repo)', command: 'npm run dev:fast', runMode: 'external' }];
  const merged = mergeCustomLaunchers(globals, project);

  assert.deepStrictEqual(merged.map(e => e.id), ['dev', 'log']); // order preserved
  assert.strictEqual(merged[0].command, 'npm run dev:fast');     // project wins
  assert.strictEqual(merged[0].runMode, 'external');
  assert.strictEqual(merged[1].command, 'git log');              // untouched global inherited
});

test('mergeCustomLaunchers: a project-only entry is appended', () => {
  const merged = mergeCustomLaunchers(
    [{ id: 'dev', command: 'npm run dev' }],
    [{ id: 'seed', command: './scripts/seed.ps1' }]
  );
  assert.deepStrictEqual(merged.map(e => e.id), ['dev', 'seed']);
});

test('mergeCustomLaunchers: tolerates missing/garbage lists', () => {
  assert.deepStrictEqual(mergeCustomLaunchers(undefined, undefined), []);
  assert.deepStrictEqual(mergeCustomLaunchers(null, 'nope'), []);
  assert.deepStrictEqual(mergeCustomLaunchers([{ id: 'a', command: 'x' }], null).map(e => e.id), ['a']);
});

test('launcherOrigin: global / override / project', () => {
  const globals = [{ id: 'dev', command: 'npm run dev' }];
  const project = [{ id: 'dev', command: 'npm run dev:fast' }, { id: 'seed', command: 'seed' }];
  assert.strictEqual(launcherOrigin('dev', globals, project), 'override');
  assert.strictEqual(launcherOrigin('seed', globals, project), 'project');
  assert.strictEqual(launcherOrigin('dev', globals, []), 'global');
});

test('launcherId: slugifies and de-duplicates', () => {
  assert.strictEqual(launcherId('Dev server', new Set()), 'dev-server');
  assert.strictEqual(launcherId('Dev server', new Set(['dev-server'])), 'dev-server-2');
  assert.strictEqual(launcherId('', new Set()), 'launcher');
});
