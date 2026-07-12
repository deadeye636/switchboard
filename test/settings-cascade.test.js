// The chain a launch default has to survive: settings blob -> effectiveSettings() -> get-effective-settings
// IPC -> renderer -> sessionOptions -> buildLaunch.
//
// This exists because that chain silently broke (D18): every layer worked, but `backendDefaults` was not
// in SETTING_DEFAULTS, so the cascade dropped it and EVERY saved launch default was ignored at spawn. The
// UI showed the value, the DB stored it, and nothing used it. No test followed the whole chain, so no test
// caught it.
//
// main.js needs Electron, so the main-process half is a static guard (the idiom this repo already uses for
// db.js-bound code); the renderer half runs for real in jsdom.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const claude = require('../backends/claude');

// --- main-process half: the cascade must carry backendDefaults ------------------------------------

test('effectiveSettings cascades backendDefaults (not just the SETTING_DEFAULTS keys)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const fn = src.slice(src.indexOf('function effectiveSettings('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /effective\.backendDefaults\s*=/,
    'the per-backend launch defaults must be part of the effective settings — without this, every ' +
    'saved default is silently dropped on the way to the launch (D18)');
  assert.match(body, /project\.backendDefaults/, 'and the project scope must be able to override them');
});

test("Claude's launch options are no longer top-level settings keys (one home: backendDefaults.claude)", () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const defaults = src.slice(src.indexOf('const SETTING_DEFAULTS = {'));
  const block = defaults.slice(0, defaults.indexOf('};'));
  for (const key of ['permissionMode', 'dangerouslySkipPermissions', 'worktree', 'chrome', 'addDirs', 'preLaunchCmd']) {
    assert.ok(!new RegExp('^\\s*' + key + ':', 'm').test(block),
      `${key} is a Claude launch option and belongs in backendDefaults.claude, not in the settings root`);
  }
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
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'dialogs.js'), 'utf8'),
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
