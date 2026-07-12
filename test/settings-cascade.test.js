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

// #149 — the cascade is PER OPTION, not per blob.
//
// It used to take the project's whole `backendDefaults` object whenever it was non-empty. So a project
// that overrode one Codex option silently froze a copy of every backend's defaults as they were that
// day: later changes to the global defaults could never reach that project again. The merge lives in
// main.js (Electron), so it is exercised here through the same source the app runs.
function loadMergeBackendDefaults() {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const start = src.indexOf('function mergeBackendDefaults(');
  assert.ok(start > 0, 'main.js must expose the per-option merge');
  const rest = src.slice(start);
  const body = rest.slice(0, rest.indexOf('\n}') + 2);
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return mergeBackendDefaults;`)();
}

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

test('a project with no overrides at all sees exactly the global defaults', () => {
  const merge = loadMergeBackendDefaults();
  const global = { codex: { model: 'gpt-5.5' } };
  assert.deepEqual(merge(global, {}), global);
  assert.deepEqual(merge(global, undefined), global);
  assert.deepEqual(merge(undefined, undefined), {});
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

// --- #163: the global scope must not FREEZE the shipped defaults ----------------------------------
//
// The global page used to write every option of whatever backend page was open, so the first Save
// pinned the defaults the user never touched. A better default shipped later could never reach them,
// and nothing said so — the frozen value still looked right, because that day it WAS the default.
//
// The rule now: an option the user did not set is absent from the blob and resolves from the
// descriptor. These tests pin both halves — that an unset option follows a CHANGED default, and that a
// deliberately set one does not.

test('an option nobody set follows the backend default — including after we change it', async () => {
  const before = { id: 'codex', label: 'Codex', axis: 'B', configFields: [
    { id: 'sandbox', type: 'select', default: 'workspace-write' },
  ] };
  // The user saved SOMETHING for codex, but never touched `sandbox`.
  const effective = { backendDefaults: { codex: { model: 'gpt-5.5' } } };

  let window = loadDialogs(effective, { codex: { ...before, configFields: [
    { id: 'model', type: 'text', default: '' }, ...before.configFields,
  ] } });
  let options = await window.resolveLaunchOptionsFor({ projectPath: '/p' }, 'codex');
  assert.equal(options.sandbox, 'workspace-write', 'today it is the shipped default');

  // Ship a safer default. The user's blob is unchanged — and the new default must reach them.
  const after = { id: 'codex', label: 'Codex', axis: 'B', configFields: [
    { id: 'model', type: 'text', default: '' },
    { id: 'sandbox', type: 'select', default: 'read-only' },
  ] };
  window = loadDialogs(effective, { codex: after });
  options = await window.resolveLaunchOptionsFor({ projectPath: '/p' }, 'codex');
  assert.equal(options.sandbox, 'read-only', 'the improved default arrives, because nobody pinned it');
  assert.equal(options.model, 'gpt-5.5', 'and what they DID set still wins');
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

  // ...and with nothing stored, the ON default still applies.
  const plain = loadDialogs({ backendDefaults: {} }, { claude: CLAUDE_DESC });
  const untouched = await plain.resolveLaunchOptionsFor({ projectPath: '/p' }, 'claude');
  assert.equal(untouched.mcpEmulation, true);
});
