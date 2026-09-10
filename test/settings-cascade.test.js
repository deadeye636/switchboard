// The chain a launch default has to survive: settings blob -> effectiveSettings() -> get-effective-settings
// IPC -> renderer -> sessionOptions -> buildLaunch.
//
// This exists because that chain silently broke (D18): every layer worked, but `backendDefaults` was not
// in SETTING_DEFAULTS, so the cascade dropped it and EVERY saved launch default was ignored at spawn. The
// UI showed the value, the DB stored it, and nothing used it. No test followed the whole chain, so no test
// caught it.
//
// The main-process half USED to be a static guard — main.js needs Electron, so the cascade could only be
// read as source text or scraped out through `new Function`. #213 moved it to app/settings.js, which takes
// the DB through ctx, so both halves now run for real: this one against a fake settings store, the
// renderer half in jsdom.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { stripComments } = require('./helpers/strip-comments');
const profiles = require('../src/backends/profiles');

const ROOT = path.join(__dirname, '..');
const claude = require('../src/backends/claude');
const codex = require('../src/backends/codex');

// --- main-process half: the cascade must carry backendDefaults ------------------------------------

const settings = require('../src/app/settings');

/** The cascade against a settings store that is just an object. */
function withSettings(store) {
  settings.init({
    db: { getSetting: (key) => store[key] },
    log: { info() {}, warn() {}, error() {} },
  });
  return settings.effectiveSettings;
}

// D18: `backendDefaults` was not in SETTING_DEFAULTS, so the cascade dropped it and every saved launch
// default was ignored at spawn. This asserted that the FUNCTION'S SOURCE mentions `effective.backendDefaults`
// — which cannot tell you the value survives, only that a line exists. It runs the cascade now.
test('effectiveSettings cascades backendDefaults (not just the SETTING_DEFAULTS keys)', () => {
  const effectiveSettings = withSettings({
    global: { backendDefaults: { codex: { model: 'gpt-5.5' } }, sidebarWidth: 500 },
    'project:/x': { backendDefaults: { codex: { sandbox: 'read-only' } } },
  });

  const eff = effectiveSettings('/x');
  assert.deepEqual(eff.backendDefaults.codex, { model: 'gpt-5.5', sandbox: 'read-only' },
    'the per-backend launch defaults must reach the launch — without this, every saved default is ' +
    'silently dropped on the way there (D18), and the project scope must be able to override them');
  assert.equal(eff.sidebarWidth, 500, 'the ordinary keys still cascade');
  assert.equal(eff.terminalTheme, 'switchboard', 'and an unset one falls back to its default');
});

// A worktree is a sub-unit of its project and carries no settings of its own, so the cascade resolves
// the owner and stays TWO levels. It used to look under the worktree's own path, find nothing and fall
// back to global — an agent working two directories below the project ran under different rules, and
// nothing said so.
test('a worktree reads its project\'s settings, not global', () => {
  const effectiveSettings = withSettings({
    global: { planDir: '.plans', handoffDir: '.handoffs' },
    'project:/x': { planDir: 'docs/plans' },
  });

  const eff = effectiveSettings('/x/.claude/worktrees/wt1');
  assert.equal(eff.planDir, 'docs/plans', "the project's override reaches an agent working in its worktree");
  assert.equal(eff.handoffDir, '.handoffs', 'and what the project does not set still comes from global');
});

test('a worktree of a worktree resolves to the same project', () => {
  const effectiveSettings = withSettings({
    global: { planDir: '.plans' },
    'project:/x': { planDir: 'docs/plans' },
  });

  assert.equal(effectiveSettings('/x/.claude/worktrees/a/.claude/worktrees/b').planDir, 'docs/plans',
    'the walk goes to the project, not one level up to the worktree above it');
});

test('a blob written against a worktree path is not read', () => {
  // There is no third level, and this is the assertion that says so: a key under the worktree's own
  // path is ignored rather than winning. Nothing writes one today — the settings window opens on the
  // project — and if something ever does, it must not quietly become a scope of its own.
  const effectiveSettings = withSettings({
    global: { planDir: '.plans' },
    'project:/x': { planDir: 'docs/plans' },
    'project:/x/.claude/worktrees/wt1': { planDir: 'ignored/plans' },
  });

  assert.equal(effectiveSettings('/x/.claude/worktrees/wt1').planDir, 'docs/plans');
});
test('a project value of null means inherit, not "set it to null"', () => {
  const effectiveSettings = withSettings({
    global: { sidebarWidth: 500 },
    'project:/x': { sidebarWidth: null },
  });
  assert.equal(effectiveSettings('/x').sidebarWidth, 500);
});

test('with no project, the cascade is default -> global', () => {
  const effectiveSettings = withSettings({ global: { sidebarWidth: 500 } });
  const eff = effectiveSettings(null);
  assert.equal(eff.sidebarWidth, 500);
  assert.equal(eff.shellProfile, 'auto');
  assert.deepEqual(eff.backendDefaults, {});
});

// #149 — the cascade is PER OPTION, not per blob.
//
// It used to take the project's whole `backendDefaults` object whenever it was non-empty. So a project
// that overrode one Codex option silently froze a copy of every backend's defaults as they were that
// day: later changes to the global defaults could never reach that project again. The merge used to be
// cut out of main.js's source and rebuilt with `new Function`; it is a real export now (#213).
const loadMergeBackendDefaults = () => settings.mergeBackendDefaults;

test('a project override of ONE option leaves every other option inheriting', () => {
  const merge = loadMergeBackendDefaults();
  const global = {
    codex: { model: 'gpt-5.5', sandbox: 'workspace-write', approvalMode: 'on-request' },
    claude: { permissionMode: 'plan' },
  };
  const project = { codex: { sandbox: 'read-only' } };   // the project overrides exactly one option

  const eff = merge(global, project);
  assert.equal(eff.codex.sandbox, 'read-only', "the project's own value wins");
  assert.equal(eff.codex.model, 'gpt-5.5', 'the other Codex options still come from global');
  assert.equal(eff.codex.approvalMode, 'on-request');
  assert.equal(eff.claude.permissionMode, 'plan', 'and another backend is untouched entirely');
});

test('a later change to a global default reaches a project that overrides a different option', () => {
  const merge = loadMergeBackendDefaults();
  const project = { codex: { sandbox: 'read-only' } };

  const before = merge({ codex: { model: 'gpt-5.5', sandbox: 'workspace-write' } }, project);
  const after = merge({ codex: { model: 'gpt-6', sandbox: 'workspace-write' } }, project);

  assert.equal(before.codex.model, 'gpt-5.5');
  assert.equal(after.codex.model, 'gpt-6', 'the project is not frozen at the values of the day it saved');
  assert.equal(after.codex.sandbox, 'read-only', 'while its own override still stands');
});

test('an option the project stores nothing for follows the global default, including a false', () => {
  const merge = loadMergeBackendDefaults();
  const eff = merge({ claude: { mcpEmulation: false, permissionMode: 'plan' } }, { claude: { permissionMode: 'acceptEdits' } });
  assert.equal(eff.claude.mcpEmulation, false, 'an inherited OFF stays off (a false is a value)');
  assert.equal(eff.claude.permissionMode, 'acceptEdits');
});

// The other half of "a project stores only what it overrides": a null/undefined IS the absence. Without
// this branch a project that once touched an option and let it go would pin it to null forever, and the
// global default could never reach it again — #149 with extra steps.
test('a null or undefined in the project means inherit, not "set it to nothing"', () => {
  const merge = loadMergeBackendDefaults();
  const global = { codex: { model: 'gpt-5.5', sandbox: 'workspace-write' } };

  assert.deepEqual(merge(global, { codex: { model: null } }), global, 'a null inherits');
  assert.deepEqual(merge(global, { codex: { model: undefined } }), global, 'so does an undefined');
  assert.equal(merge(global, { codex: { model: '' } }).codex.model, '',
    'but an empty string is a value the user chose — it overrides');
});

test('a project with no overrides at all sees exactly the global defaults', () => {
  const merge = loadMergeBackendDefaults();
  const global = { codex: { model: 'gpt-5.5' } };
  assert.deepEqual(merge(global, {}), global);
  assert.deepEqual(merge(global, undefined), global);
  assert.deepEqual(merge(undefined, undefined), {});
});

// Was a regex over main.js's source between `const SETTING_DEFAULTS = {` and the closing brace. It is a
// real export now, so ask the object.
test("Claude's launch options are no longer top-level settings keys (one home: backendDefaults.claude)", () => {
  for (const key of ['permissionMode', 'dangerouslySkipPermissions', 'worktree', 'chrome', 'addDirs', 'preLaunchCmd']) {
    assert.ok(!(key in settings.SETTING_DEFAULTS),
      `${key} is a Claude launch option and belongs in backendDefaults.claude, not in the settings root`);
  }
});

// The migration that moved them there. It ran once per scope and has to be idempotent — it is called on
// every start.
test('the Claude launch migration moves the legacy keys once, then leaves the blob alone', () => {
  const store = {
    global: { permissionMode: 'plan', dangerouslySkipPermissions: true, sidebarWidth: 500 },
  };
  const writes = [];
  settings.init({
    db: {
      getSetting: (key) => store[key],
      setSetting: (key, value) => { store[key] = value; writes.push(key); },
      listSettings: () => [],
    },
    log: { info() {}, warn() {}, error() {} },
  });

  settings.migrateClaudeLaunchDefaults();
  assert.deepEqual(store.global.backendDefaults.claude, { permissionMode: 'dangerously-skip' },
    'the skip flag and the mode are ONE decision — the skip wins, as the CLI itself does');
  assert.equal('permissionMode' in store.global, false, 'the old key is gone: one home, not two');
  assert.equal('dangerouslySkipPermissions' in store.global, false);
  assert.equal(store.global.sidebarWidth, 500, 'and nothing else was touched');

  settings.migrateClaudeLaunchDefaults();
  assert.equal(writes.length, 1, 'it runs on every start — a second pass must write nothing');
});

// --- #617: a launch option value the CLI has retired ----------------------------------------------
//
// Codex dropped `untrusted` and `on-failure` from `--ask-for-approval`, and a session launched on either
// died at spawn. The stored blob is rewritten ONCE, in whichever scope holds it, rather than substituted
// at every launch — so the settings screen shows what will actually be sent.
//
// What the core spells is nothing: the replacement comes off the descriptor's `retiredChoices`, which is
// why these drive the real Codex descriptor rather than a stub. A stub would pass with the mapping
// deleted from the backend.

/** A settings store over `store`, wired the way the migration and the write door both need it. */
function withStore(store) {
  const writes = [];
  settings.init({
    db: {
      getSetting: (key) => store[key],
      setSetting: (key, value) => { store[key] = value; writes.push(key); },
      listSettings: (prefix) => Object.keys(store)
        .filter(k => k.startsWith(prefix))
        .map(k => ({ key: k, value: store[k] })),
    },
    log: { info() {}, warn() {}, error() {} },
    startBackendWatchers() {},
    indexWorker: { postReconcile() {} },
    notifyRendererProjectsChanged() {},
  });
  return writes;
}

test('a retired launch value is rewritten in the GLOBAL blob (#617)', () => {
  const store = { global: { sidebarWidth: 500, backendDefaults: { codex: { approvalMode: 'untrusted', model: 'gpt-5.5' } } } };
  withStore(store);

  settings.migrateRetiredChoices();

  assert.equal(store.global.backendDefaults.codex.approvalMode, 'on-request',
    'the strictest surviving policy — a loosening, taken because the alternative is a session that cannot start');
  assert.equal(store.global.backendDefaults.codex.model, 'gpt-5.5', 'the other options are untouched');
  assert.equal(store.global.sidebarWidth, 500, 'and so is everything outside backendDefaults');
});

test('…and in a PROJECT blob, which is where the cascade puts an option the project overrode (#617)', () => {
  // Both scopes, because a project stores only the options it overrides — so a dead value can sit in one,
  // the other, or both, and a migration that only walked `global` would leave the project launching broken.
  const store = {
    global: { backendDefaults: { codex: { approvalMode: 'on-request' } } },
    'project:/a': { backendDefaults: { codex: { approvalMode: 'on-failure' } } },
    'project:/b': { backendDefaults: { codex: { approvalMode: 'untrusted' } } },
  };
  const writes = withStore(store);

  settings.migrateRetiredChoices();

  assert.equal(store['project:/a'].backendDefaults.codex.approvalMode, 'on-request');
  assert.equal(store['project:/b'].backendDefaults.codex.approvalMode, 'on-request');
  assert.deepEqual(writes, ['project:/a', 'project:/b'],
    'the global blob already held a live value, so it was not rewritten');
});

test('a blob with nothing retired in it is left exactly as it was (#617)', () => {
  const store = {
    global: { backendDefaults: { codex: { approvalMode: 'never', sandbox: 'read-only' }, claude: { permissionMode: 'plan' } } },
    'project:/a': { displayName: 'A' },
    'project:/b': { backendDefaults: {} },
  };
  const before = JSON.parse(JSON.stringify(store));
  const writes = withStore(store);

  settings.migrateRetiredChoices();
  settings.migrateRetiredChoices();

  assert.deepEqual(store, before, 'no value moved');
  assert.deepEqual(writes, [], 'and nothing was written — it runs on every start');
});

test('the rewrite is idempotent, so a second start writes nothing (#617)', () => {
  const store = { global: { backendDefaults: { codex: { approvalMode: 'untrusted' } } } };
  const writes = withStore(store);

  settings.migrateRetiredChoices();
  settings.migrateRetiredChoices();

  assert.deepEqual(writes, ['global'], 'once, not once per start');
});

test('the write door rewrites it too, so an Apply cannot put the dead value back (#617)', () => {
  // The startup migration cannot answer for a form that was already open, nor for an IMPORT of a file
  // exported before the CLI dropped the value. Both go through the scrub, so the dead value never reaches
  // the disk at all — rather than being corrected on the next start, with a broken launch in between.
  const store = {};
  withStore(store);

  settings.persistSettingsBlob('global', { backendDefaults: { codex: { approvalMode: 'untrusted' } } });
  assert.equal(store.global.backendDefaults.codex.approvalMode, 'on-request');

  settings.persistSettingsBlob('project:/a', { backendDefaults: { codex: { approvalMode: 'on-failure' } } });
  assert.equal(store['project:/a'].backendDefaults.codex.approvalMode, 'on-request');
});

test('a TEMPLATE carries the dead value too, and its own store is rewritten (#617)', () => {
  // A template's options are not in a settings blob: they live in profiles.json, and they sit at the TOP of
  // the cascade — so a template saved with a retired value beats every scope the migration above corrects
  // and the session still dies. This store was nearly skipped on the grounds that it needs Electron, and it
  // does not: `app/settings.js` has imported it since long before this, and profiles' Electron use is a
  // lazy require inside the path resolver, which `_configureForTests` replaces outright.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-retired-'));
  const file = path.join(dir, 'profiles.json');
  try {
    profiles._configureForTests({ filePath: file });
    assert.ok(profiles.save({ id: 'strict-cx', name: 'Strict Codex', backendId: 'codex', env: {},
      options: { approvalMode: 'untrusted', model: 'gpt-5.5' } }).ok);
    assert.ok(profiles.save({ id: 'plain-cx', name: 'Plain Codex', backendId: 'codex', env: {},
      options: { approvalMode: 'never' } }).ok);

    const store = {};
    withStore(store);
    settings.migrateRetiredChoices();

    assert.equal(profiles.get('strict-cx').options.approvalMode, 'on-request');
    assert.equal(profiles.get('strict-cx').options.model, 'gpt-5.5', 'its other options are untouched');
    assert.equal(profiles.get('strict-cx').name, 'Strict Codex', 'and so is the rest of the record');
    assert.equal(profiles.get('plain-cx').options.approvalMode, 'never', 'a live value is left alone');

    const before = fs.readFileSync(file, 'utf8');
    settings.migrateRetiredChoices();
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'and a second start writes nothing');
  } finally {
    profiles._configureForTests({});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('one bad scope does not take the other scopes or the templates with it (#617)', () => {
  // The scope loop reads blobs off disk. A single wrapper around it would let the first one that throws
  // abort every scope after it AND the template pass below — silently, since the whole thing is inside a
  // try that only logs. So each scope is guarded on its own.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-retired-'));
  try {
    profiles._configureForTests({ filePath: path.join(dir, 'profiles.json') });
    assert.ok(profiles.save({ id: 'cx', name: 'Codex template', backendId: 'codex', env: {},
      options: { approvalMode: 'untrusted' } }).ok);

    const store = { 'project:/b': { backendDefaults: { codex: { approvalMode: 'on-failure' } } } };
    const warned = [];
    settings.init({
      db: {
        getSetting: () => { throw new Error('the global blob will not read'); },
        setSetting: (key, value) => { store[key] = value; },
        listSettings: (prefix) => Object.keys(store).filter(k => k.startsWith(prefix)).map(k => ({ key: k, value: store[k] })),
      },
      log: { info() {}, warn(msg) { warned.push(String(msg)); }, error() {} },
      startBackendWatchers() {}, indexWorker: { postReconcile() {} }, notifyRendererProjectsChanged() {},
    });

    settings.migrateRetiredChoices();

    assert.equal(store['project:/b'].backendDefaults.codex.approvalMode, 'on-request',
      'the scope after the throwing one is still corrected');
    assert.equal(profiles.get('cx').options.approvalMode, 'on-request',
      'and so is the template store, which comes after the whole loop');
    assert.ok(warned.some(m => m.includes('global')), 'the scope that failed is named');
  } finally {
    profiles._configureForTests({});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the template pass DECLINES while profiles.json holds records this app could not load (#617)', () => {
  // `flush` rewrites the file from the loader's kept state, so a save erases whatever `ensureLoaded`
  // discarded. That is the user's own act when they press Save in the editor; doing it from a startup pass
  // would delete records nobody has been told about, as a side effect of fixing an unrelated field. The
  // pass declines and says so — the settings blobs are still corrected, and the editor is still a way in.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-retired-'));
  const file = path.join(dir, 'profiles.json');
  try {
    fs.writeFileSync(file, JSON.stringify({
      profiles: [
        { id: 'cx', name: 'Codex template', backendId: 'codex', env: {}, options: { approvalMode: 'untrusted' } },
        { id: '', name: 'unloadable', env: {} },      // an invalid id — the loader drops it
      ],
    }, null, 2), 'utf8');
    profiles._configureForTests({ filePath: file });
    assert.equal(profiles.list().length, 1, 'one record was kept');
    assert.equal(profiles.droppedAtLoad(), 1, 'and one was not');

    const store = { global: { backendDefaults: { codex: { approvalMode: 'untrusted' } } } };
    const warned = [];
    settings.init({
      db: {
        getSetting: (key) => store[key],
        setSetting: (key, value) => { store[key] = value; },
        listSettings: () => [],
      },
      log: { info() {}, warn(msg) { warned.push(String(msg)); }, error() {} },
      startBackendWatchers() {}, indexWorker: { postReconcile() {} }, notifyRendererProjectsChanged() {},
    });

    settings.migrateRetiredChoices();

    assert.equal(store.global.backendDefaults.codex.approvalMode, 'on-request', 'the blob is still corrected');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).profiles.length, 2,
      'and the file still holds both records — the unloadable one was not erased');
    assert.ok(warned.some(m => m.includes('could not load')), 'the decision is logged, not silent');
  } finally {
    profiles._configureForTests({});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the retired-choice migration is actually called at startup (#617)', () => {
  // A source check, and it says what it pins: `lifecycle.js` requires Electron, so there is no seam a test
  // can reach `app.whenReady` through — and a migration nothing calls is a rewrite that never happens, with
  // every unit test below still green. The same gap the Claude migration beside it has always had.
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'app', 'lifecycle.js'), 'utf8'));
  assert.match(src, /ctx\.migrateRetiredChoices\(\)/, 'lifecycle runs it');
  assert.ok(src.indexOf('ctx.migrateRetiredChoices()') < src.indexOf('ctx.createWindow()'),
    'and before the first window, so no settings form is ever open against a value it is about to change');
  const main = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8'));
  assert.match(main, /\bmigrateRetiredChoices\b/, 'and main.js puts it on the lifecycle ctx');
});

test('the rewrite asks the DESCRIPTOR and spells no backend of its own (#617)', () => {
  // A backend id nothing is registered under answers null, and its options are left alone rather than
  // guessed at — the same rule the rest of the core follows about a backend it does not know.
  const blob = { backendDefaults: { 'no-such-backend': { approvalMode: 'untrusted' } } };
  const { value, changed } = settings.rewriteRetiredChoices(blob);
  assert.equal(value, blob, 'the original object, untouched');
  assert.deepEqual(changed, []);

  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'settings.js'), 'utf8');
  assert.equal(/['"]untrusted['"]|['"]on-failure['"]/.test(stripComments(src)), false,
    "the value a CLI retired belongs in that CLI's folder — the core reads it off the descriptor");
});

// --- renderer half: the effective defaults become the session's launch options --------------------

function loadDialogs(effective, backends) {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  Object.defineProperty(window, 'api', {
    value: { getEffectiveSettings: async () => effective },
    writable: true, configurable: true,
  });
  Object.defineProperty(window, 'getBackend', {
    value: (id) => backends[id] || null,
    writable: true, configurable: true,
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'dialogs', 'dialogs.js'), 'utf8'),
    dom.getInternalVMContext(), { filename: 'dialogs.js' });
  return window;
}

const CLAUDE_DESC = { id: 'claude', label: 'Claude Code', axis: 'A', configFields: claude.configFields };
const CODEX_DESC = {
  id: 'codex', label: 'Codex', axis: 'B',
  configFields: [
    { id: 'model', type: 'text', default: '' },
    { id: 'sandbox', type: 'select', default: 'workspace-write' },
  ],
};

test('a saved backend default reaches the launch options', async () => {
  const window = loadDialogs(
    { backendDefaults: { codex: { model: 'gpt-5.4-codex', sandbox: 'read-only' } } },
    { codex: CODEX_DESC },
  );
  const options = await window.resolveLaunchOptionsFor({ projectPath: '/p' }, 'codex');
  assert.equal(options.model, 'gpt-5.4-codex', 'the stored default is what a plain launch uses');
  assert.equal(options.sandbox, 'read-only', 'and it overrides the descriptor default');
  assert.equal(options.backendId, 'codex');
});

test('Claude resolves from backendDefaults.claude like every other backend', async () => {
  const window = loadDialogs(
    { backendDefaults: { claude: { permissionMode: 'plan', addDirs: '/extra' } } },
    { claude: CLAUDE_DESC },
  );
  const options = await window.resolveLaunchOptionsFor({ projectPath: '/p' }, 'claude');
  assert.equal(options.permissionMode, 'plan');
  assert.equal(options.addDirs, '/extra');
  // ...and the descriptor turns that into the real argv.
  const argv = claude.buildLaunch({ cwd: '/p', sessionId: 's1', options }).args;
  assert.ok(argv.includes('--permission-mode') && argv.includes('plan'));
  assert.ok(argv.includes('--add-dir') && argv.includes('/extra'));
});

test("the 'dangerously-skip' choice becomes the flag, and never combines with --permission-mode", () => {
  const argv = claude.buildLaunch({
    cwd: '/p', sessionId: 's1', options: { permissionMode: 'dangerously-skip' },
  }).args;
  assert.ok(argv.includes('--dangerously-skip-permissions'));
  assert.ok(!argv.includes('--permission-mode'), 'the two are one decision, not two');
});

test("an option switched OFF stays off (a false is a value, not an absence)", async () => {
  // Claude's IDE emulation defaults to ON. Dropping the stored `false` would silently switch it back on.
  const window = loadDialogs(
    { backendDefaults: { claude: { mcpEmulation: false } } },
    { claude: CLAUDE_DESC },
  );
  const options = await window.resolveLaunchOptionsFor({ projectPath: '/p' }, 'claude');
  assert.equal(options.mcpEmulation, false);
});

test('an Axis-A profile inherits CLAUDE\'s options — it runs the claude binary', async () => {
  const profile = { id: 'deepseek', label: 'DeepSeek', axis: 'A', isProfile: true, configFields: [] };
  const window = loadDialogs(
    { backendDefaults: { claude: { permissionMode: 'plan' } } },
    { claude: CLAUDE_DESC, deepseek: profile },
  );
  const options = await window.resolveLaunchOptionsFor({ projectPath: '/p' }, 'deepseek');
  assert.equal(options.permissionMode, 'plan', "a profile must not lose the user's Claude defaults");
  assert.equal(options.backendId, 'deepseek', 'but it still launches as the profile (§5.7)');
  assert.equal(options.profileId, 'deepseek');
});

// --- #163: the global scope must not FREEZE the shipped defaults ----------------------------------
//
// The global page used to write every option of whatever backend page was open, so the first Save
// pinned the defaults the user never touched. A better default shipped later could never reach them,
// and nothing said so — the frozen value still looked right, because that day it WAS the default.
//
// The rule now: an option the user did not set is absent from the blob and resolves from the
// descriptor. These tests pin both halves — that an unset option follows a CHANGED default, and that a
// deliberately set one does not.

// An option nobody set is NOT SENT — so the CLI keeps its own.
//
// A `configFields` default describes what the CLI does anyway. It is what a control SHOWS when nobody
// has said otherwise; it is not a value to put on the command line. Seeding it did exactly that: a plain
// Codex launch carried `-a on-request -s workspace-write` although the user had never chosen either,
// silently overruling whatever they had configured in Codex' own config.toml. It went unnoticed because
// Claude has a sentinel its buildLaunch throws away ('default') and Codex and Hermes do not.
test('an option nobody set is not sent at all — the CLI keeps its own default', async () => {
  const codexDesc = { id: 'codex', label: 'Codex', axis: 'B', configFields: [
    { id: 'model', type: 'text', default: '' },
    { id: 'sandbox', type: 'select', default: 'workspace-write' },
  ] };
  // The user saved SOMETHING for codex, but never touched `sandbox`.
  const window = loadDialogs({ backendDefaults: { codex: { model: 'gpt-5.5' } } }, { codex: codexDesc });
  const options = await window.resolveLaunchOptionsFor({ projectPath: '/p' }, 'codex');

  assert.equal('sandbox' in options, false,
    'our descriptor default must not become a flag on a CLI the user configured themselves');
  assert.equal(options.model, 'gpt-5.5', 'and what they DID set is sent');
});

test('...so the bare launch is a bare command line', async () => {
  const codexDesc = { id: 'codex', label: 'Codex', axis: 'B', configFields: codex.configFields };
  const window = loadDialogs({ backendDefaults: {} }, { codex: codexDesc });
  const options = await window.resolveLaunchOptionsFor({ projectPath: '/p' }, 'codex');
  const argv = codex.buildLaunch({ cwd: '/p', sessionId: 's1', options }).args;
  assert.deepEqual(argv, [], 'nobody chose anything, so we tell Codex nothing');
});

test('an option the user set does NOT follow a changed backend default', async () => {
  const after = { id: 'codex', label: 'Codex', axis: 'B', configFields: [
    { id: 'sandbox', type: 'select', default: 'read-only' },   // we changed our mind
  ] };
  const window = loadDialogs(
    { backendDefaults: { codex: { sandbox: 'danger-full-access' } } },   // they chose this on purpose
    { codex: after },
  );
  const options = await window.resolveLaunchOptionsFor({ projectPath: '/p' }, 'codex');
  assert.equal(options.sandbox, 'danger-full-access', 'a deliberate choice is not overwritten by ours');
});

// The reason the marker has to exist at all: `false` is a value. Claude's IDE emulation defaults to ON,
// so the only way to turn it off is to STORE the false — a dropped one restores the default.
test('a stored `false` survives the cascade (an option with an ON default can be switched off)', async () => {
  const window = loadDialogs(
    { backendDefaults: { claude: { mcpEmulation: false } } },
    { claude: CLAUDE_DESC },
  );
  const options = await window.resolveLaunchOptionsFor({ projectPath: '/p' }, 'claude');
  assert.equal(options.mcpEmulation, false, 'stored false must not be read as "not set"');

  // With nothing stored, the option is ABSENT — and main.js reads an absent mcpEmulation as ON, which is
  // Claude's own default. The behaviour is the same; we simply stop asserting it on the command line.
  const plain = loadDialogs({ backendDefaults: {} }, { claude: CLAUDE_DESC });
  const untouched = await plain.resolveLaunchOptionsFor({ projectPath: '/p' }, 'claude');
  assert.equal('mcpEmulation' in untouched, false);
  assert.notEqual(untouched.mcpEmulation, false, 'and it must never read as "switched off"');
});

// --- the Configure dialog: a per-session override, ON TOP of the settings ---------------------------
//
// The dialog SHOWS the effective value, which it must — it may not lie about what is about to happen. But
// showing is not sending, and the two used to look the same: a select reading `workspace-write` was the
// same pixels whether it came from Codex' own default (not sent) or from the user's settings (sent).
//
// So every option carries the same per-option marker the settings pages have. Here it means:
//
//     ticked (ALWAYS the starting state) = use what already applies — your settings, or the CLI's own
//     unticked                           = override, for THIS session, with the value shown
//
// Two mistakes it exists to prevent, both of which a first cut made:
//   * calling it "use the backend's default" — the value on display may well be one the USER stored;
//   * starting it unticked for a stored value — it looked like the user had changed something they had not.
//
// And one wish that could not be expressed at all before: if your config.toml says `read-only` and our
// descriptor default says `workspace-write`, then choosing `workspace-write` here is a real instruction.
// A rule that compared the value to our default dropped it as "same as the default", and Codex stayed on
// read-only. The marker is the difference between what a value IS and what it MEANS.

function loadHelpers(effective, backends) {
  const window = loadDialogs(effective, backends);
  const first = backends[Object.keys(backends)[0]];
  return {
    override: window.isSessionOverride,
    displayValue: window.displayValueOf,
    stored: window.storedDefaultsFor(effective, first),
  };
}

const SANDBOX = { id: 'sandbox', type: 'select', default: 'workspace-write' };
const MODEL = { id: 'model', type: 'text', default: '' };
const IDE = { id: 'mcpEmulation', type: 'toggle', default: true };
const CODEX2 = { id: 'codex', label: 'Codex', axis: 'B', configFields: [MODEL, SANDBOX] };

test('the dialog shows the effective value, so it never lies about what will happen', () => {
  const { displayValue, stored } = loadHelpers(
    { backendDefaults: { codex: { sandbox: 'read-only' } } }, { codex: CODEX2 });
  assert.equal(displayValue(SANDBOX, stored), 'read-only', "the user's stored choice");
  assert.equal(displayValue(MODEL, stored), '', "and the CLI's own default where they chose nothing");
});

test('a field left alone is no override — opening the dialog and pressing Start changes nothing', () => {
  const { override } = loadHelpers({ backendDefaults: {} }, { codex: CODEX2 });
  assert.equal(override(SANDBOX, 'workspace-write', true), false);
  assert.equal(override(SANDBOX, 'read-only', true), false,
    'the marker wins over the value — ticked means "what already applies", whatever the control shows');
});

test('a field the user took over IS an override', () => {
  const { override } = loadHelpers({ backendDefaults: {} }, { codex: CODEX2 });
  assert.equal(override(SANDBOX, 'read-only', false), true);
  assert.equal(override(MODEL, 'gpt-5.5', false), true);
});

test('an override is sent even when its value equals our descriptor default', () => {
  const { override } = loadHelpers({ backendDefaults: {} }, { codex: CODEX2 });
  assert.equal(override(SANDBOX, 'workspace-write', false), true,
    'if their config.toml says read-only, this is the only way to say "workspace-write, just this once"');
});

test('an empty text field is still nothing — there is no such thing as an empty --model', () => {
  const { override } = loadHelpers({ backendDefaults: {} }, { codex: CODEX2 });
  assert.equal(override(MODEL, '', false), false);
});

test('switching an ON-by-default option off is an override', () => {
  const claudeDesc = { id: 'claude', label: 'Claude Code', axis: null, configFields: [IDE] };
  const { override } = loadHelpers({ backendDefaults: {} }, { claude: claudeDesc });
  assert.equal(override(IDE, false, false), true, 'the user turned it off — that has to reach main.js');
  assert.equal(override(IDE, true, true), false, 'left alone, it says nothing and Claude keeps its own');
});

// The dialog LAYERS on the cascade rather than replacing it: a stored setting the user did not touch must
// still be sent, or opening the dialog would quietly strip their own configuration.
test('a stored setting survives a dialog the user did not touch', async () => {
  const window = loadDialogs(
    { backendDefaults: { codex: { model: 'gpt-5.5', sandbox: 'read-only' } } },
    { codex: CODEX2 },
  );
  const base = await window.resolveLaunchOptionsFor({ projectPath: '/p' }, 'codex');
  assert.equal(base.model, 'gpt-5.5');
  assert.equal(base.sandbox, 'read-only',
    'the dialog starts from THIS and lays overrides on top — it does not start from nothing');
});
