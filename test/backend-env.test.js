'use strict';
// A backend's OWN environment variables (`backendEnv.<id>`).
//
// Only a template could carry an env bundle. So the only way to hand Codex a variable was to wrap it in
// a template — a whole extra entry in the launch menu, with its own name and badge, to set one var.
//
// The rules are the ones that already govern a template's bundle and a custom launcher's: a secret is a
// `$VAR` reference, resolved from the environment at spawn, never written to disk. Main enforces it at
// the trust boundary, because the renderer can be bypassed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// The spawn-side merge stays a static guard on its source: spawn.js can be required, but reaching this
// merge means spawning a real PTY. The settings-side half no longer has to be (see below).
const SPAWN = fs.readFileSync(path.join(ROOT, 'src', 'app', 'terminal', 'spawn.js'), 'utf8');

// This used to read main.js as TEXT, cut `stripBackendEnvSecrets` out of it with indexOf, and run it
// through `new Function` — the only way to reach it, because main.js needs Electron and can never be
// required. #213 moved the guard to app/settings.js, which takes Electron and the DB through ctx. So the
// test now runs the actual module the app loads, not a copy of its source.
const settings = require('../src/app/settings');
const loadStripper = () => settings.stripBackendEnvSecrets;

test('a $VAR reference is kept — that is the supported way to carry a secret', () => {
  const strip = loadStripper();
  const blob = { backendEnv: { codex: { OPENAI_API_KEY: '$MY_KEY', BASE_URL: 'https://x' } } };
  const res = strip(blob);
  assert.deepEqual(res.removed, []);
  assert.deepEqual(res.value.backendEnv.codex, { OPENAI_API_KEY: '$MY_KEY', BASE_URL: 'https://x' });
});

test('a pasted raw key is DROPPED before it can reach the disk', () => {
  const strip = loadStripper();
  const blob = { backendEnv: { codex: { OPENAI_API_KEY: 'sk-proj-abcdef0123456789abcdef0123456789' } } };
  const res = strip(blob);
  assert.deepEqual(res.removed, ['codex.OPENAI_API_KEY']);
  assert.deepEqual(res.value.backendEnv.codex, {}, 'the key is not written, not even masked');
});

test('one bad value does not take the other variables with it', () => {
  const strip = loadStripper();
  const blob = {
    backendEnv: {
      codex: { OPENAI_API_KEY: 'sk-proj-abcdef0123456789abcdef0123456789', HTTP_PROXY: 'http://p:8080' },
      pi: { PI_TOKEN: '$PI_TOKEN' },
    },
  };
  const res = strip(blob);
  assert.deepEqual(res.value.backendEnv.codex, { HTTP_PROXY: 'http://p:8080' });
  assert.deepEqual(res.value.backendEnv.pi, { PI_TOKEN: '$PI_TOKEN' });
});

test('a blob with no backendEnv passes through untouched', () => {
  const strip = loadStripper();
  const blob = { sidebarWidth: 400 };
  const res = strip(blob);
  assert.equal(res.value, blob, 'no needless copy, and nothing removed');
  assert.deepEqual(res.removed, []);
});

// The guard has to sit on the ONE path every settings write takes, or it is decorative — a settings
// IMPORT would walk straight around a renderer-side check.
//
// This used to assert that persistSettingsBlob's SOURCE mentions the two strippers, which is as close as
// you can get to the truth by reading text: it cannot tell you the call does anything. Now the write path
// runs for real against a fake DB, and the assertion is what actually reached it.
test('the guard runs on the single write path, next to the launcher one', () => {
  const written = [];
  settings.init({
    db: { setSetting: (key, value) => written.push({ key, value }) },
    log: { info() {}, warn() {}, error() {} },
    // key !== 'global' below, so the re-arm is not reached; give it nothing to call.
  });

  settings.persistSettingsBlob('project:/x', {
    backendEnv: { codex: { OPENAI_API_KEY: 'sk-abcdefghijklmnopqrstuvwxyz0123456789', BASE_URL: 'https://x' } },
    customLaunchers: [{ id: 'l1', name: 'l', env: { GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } }],
  });

  assert.equal(written.length, 1, 'it reached the disk exactly once');
  const blob = written[0].value;
  assert.deepEqual(blob.backendEnv.codex, { BASE_URL: 'https://x' },
    'a settings import must not be able to smuggle a raw key past this');
  assert.deepEqual(blob.customLaunchers[0].env, {}, 'and the launcher half of the same guard ran too');
});

// ...and the OTHER door (#221). `merge-setting` takes a renderer-supplied partial and used to write it
// straight through ctx.db.setSetting, so a caller sending customLaunchers or backendEnv through that
// channel bypassed the guard entirely. Its real callers only ever send sidebarWidth/tabOrder — which is
// exactly why nothing noticed, and exactly why the channel has to enforce it rather than trusting them.
//
// This drives the REGISTERED HANDLER, not the internal function: the point is that the door is guarded,
// and only the handler can prove that.
test('merge-setting scrubs the renderer-supplied partial too, and keeps the merge atomic (#221)', () => {
  const written = [];
  const stored = { global: { sidebarWidth: 340, backendEnv: { codex: { BASE_URL: 'https://keep' } } } };
  const handlers = new Map();
  settings.init({
    db: {
      getSetting: (key) => stored[key],
      setSetting: (key, value) => { written.push({ key, value }); stored[key] = value; },
    },
    log: { info() {}, warn() {}, error() {} },
  });
  settings.registerIpc({ on() {}, handle: (ch, fn) => handlers.set(ch, fn) });

  handlers.get('merge-setting')(null, 'global', {
    sidebarWidth: 420,
    backendEnv: { codex: { OPENAI_API_KEY: 'sk-abcdefghijklmnopqrstuvwxyz0123456789', BASE_URL: 'https://x' } },
    customLaunchers: [{ id: 'l1', name: 'l', env: { GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } }],
  });

  assert.equal(written.length, 1, 'one atomic read-merge-write (#75)');
  const blob = written[0].value;
  assert.deepEqual(blob.backendEnv.codex, { BASE_URL: 'https://x' }, 'a raw key must not reach the disk here either');
  assert.deepEqual(blob.customLaunchers[0].env, {}, 'and the launcher half of the guard ran too');
  assert.equal(blob.sidebarWidth, 420, 'the partial still applies');
});

// --- the merge order at spawn ---------------------------------------------------------------------
//
// A template's descriptor merges its bundle OVER its base's, so `launch.env` already contains both. The
// user's per-backend variables have to land BETWEEN them: above the backend's own defaults, below the
// template that was chosen deliberately. Getting this backwards would let a global variable silently
// override the template the user picked by name.
test('the spawn merges backend env BETWEEN the backend and the template', () => {
  const at = SPAWN.indexOf('const allEnv = (ctx.getSetting(\'global\') || {}).backendEnv || {};');
  assert.notEqual(at, -1, 'the merge must still be in spawn.js');
  const block = SPAWN.slice(at, SPAWN.indexOf('\n      }', at));

  // The template's own keys are lifted back out of launch.env first...
  assert.match(block, /for \(const key of Object\.keys\(templateEnv\)\) delete baseEnv\[key\];/,
    'or the user\'s backend variables would land on top of the template');
  // ...and then re-applied last, so the template still wins.
  const order = block.indexOf('...baseEnv') < block.indexOf('...(allEnv[baseId] || {})')
    && block.indexOf('...(allEnv[baseId] || {})') < block.indexOf('...templateEnv');
  assert.equal(order, true, 'backend -> user\'s backend env -> template');
});
