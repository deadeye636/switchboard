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
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

/** Pull a top-level function's source out of main.js (it needs Electron, so it cannot be required). */
function fnSource(name) {
  const start = MAIN.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in main.js`);
  const rest = MAIN.slice(start);
  return rest.slice(0, rest.indexOf('\n}\n') + 2);
}

// The guard is a pure function of a settings blob, so it can be run for real.
function loadStripper() {
  const src = fnSource('stripBackendEnvSecrets');
  const profiles = require('../src/backends/profiles');
  // eslint-disable-next-line no-new-func
  const make = new Function('profiles', `${src}; return stripBackendEnvSecrets;`);
  return make(profiles);
}

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
test('the guard runs on the single write path, next to the launcher one', () => {
  const persist = fnSource('persistSettingsBlob');
  assert.match(persist, /stripLauncherSecrets\(/);
  assert.match(persist, /stripBackendEnvSecrets\(/,
    'a settings import must not be able to smuggle a raw key past this');
});

// --- the merge order at spawn ---------------------------------------------------------------------
//
// A template's descriptor merges its bundle OVER its base's, so `launch.env` already contains both. The
// user's per-backend variables have to land BETWEEN them: above the backend's own defaults, below the
// template that was chosen deliberately. Getting this backwards would let a global variable silently
// override the template the user picked by name.
test('the spawn merges backend env BETWEEN the backend and the template', () => {
  const spawn = MAIN.slice(MAIN.indexOf('const allEnv = (getSetting(\'global\') || {}).backendEnv || {};'));
  const block = spawn.slice(0, spawn.indexOf('\n      }'));

  // The template's own keys are lifted back out of launch.env first...
  assert.match(block, /for \(const key of Object\.keys\(templateEnv\)\) delete baseEnv\[key\];/,
    'or the user\'s backend variables would land on top of the template');
  // ...and then re-applied last, so the template still wins.
  const order = block.indexOf('...baseEnv') < block.indexOf('...(allEnv[baseId] || {})')
    && block.indexOf('...(allEnv[baseId] || {})') < block.indexOf('...templateEnv');
  assert.equal(order, true, 'backend -> user\'s backend env -> template');
});
