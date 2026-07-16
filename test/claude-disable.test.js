'use strict';
// #162 — Claude is a backend like any other, and can be switched off.
//
// The lock was ONE line of renderer code (`const locked = b.id === 'claude'`), with the tooltip
// "Built-in — always enabled". `isEnabled()` never had a carve-out — `id === 'claude'` is only the
// default when nothing is stored — so a hand-edited settings blob, or a settings IMPORT, could already
// set the flag, and the app would honour it and half-break:
//
//   * every session with no recorded backend (i.e. every row from before multi-LLM) fell back to
//     'claude' and was then refused, with no explanation;
//   * getDefaultLaunchTarget() kept returning 'claude' — a default the spawn gate rejects;
//   * while the claude BINARY kept running anyway, from the scheduler and via Claude's own scanner,
//     neither of which asked the gate at all.
//
// These tests pin the model's half. The renderer's lock is gone; the model is now the thing that decides.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backends = require('../backends');
const profiles = require('../profiles');

/** Run with a given backendEnabled map (and optional templates), then restore the real wiring. */
function withSettings(backendEnabled, templates, fn) {
  const store = {
    list: () => templates || [],
    get: (id) => (templates || []).find(p => p.id === id) || null,
  };
  backends.init({ getGlobalSettings: () => ({ backendEnabled }), profiles: store });
  try { return fn(); } finally { backends.init({ getGlobalSettings: () => ({}), profiles }); }
}

const enabledOf = (id) => backends.list().find(b => b.id === id)?.enabled;

// --- the gate -------------------------------------------------------------------------------------

test('Claude is enabled by default, like before', () => {
  withSettings({}, [], () => {
    assert.equal(enabledOf('claude'), true);
    assert.equal(backends.isLaunchable('claude'), true);
  });
});

test('Claude can be switched off — there is no carve-out for it', () => {
  withSettings({ claude: false }, [], () => {
    assert.equal(enabledOf('claude'), false);
    assert.equal(backends.isLaunchable('claude'), false, 'and it cannot spawn');
  });
});

test('switching Claude off does not switch anything else off', () => {
  withSettings({ claude: false, codex: true }, [], () => {
    assert.equal(backends.isLaunchable('codex'), true, 'a Codex-only user is a real user');
  });
});

// --- templates follow their base (the decided, deliberate consequence) ------------------------------

test('a disabled backend takes its templates with it', () => {
  const templates = [
    { id: 'ds', name: 'DeepSeek', backendId: 'claude', env: {} },
    { id: 'cx', name: 'Codex fast', backendId: 'codex', env: {} },
  ];
  withSettings({ claude: false, codex: true }, templates, () => {
    assert.equal(backends.isLaunchable('ds'), false,
      'a DeepSeek template runs the CLAUDE binary — with Claude off, it has nothing to launch');
    assert.equal(backends.isLaunchable('cx'), true, 'but a Codex template is untouched by it');
  });
});

test('a template is still enabled by default while its base is on', () => {
  withSettings({}, [{ id: 'ds', name: 'DeepSeek', backendId: 'claude', env: {} }], () => {
    assert.equal(backends.isLaunchable('ds'), true);
  });
});

// --- the default launch target ---------------------------------------------------------------------

test('the default target falls back to something LAUNCHABLE, not to a hardcoded claude', () => {
  withSettings({ claude: false, codex: true }, [], () => {
    const target = backends.getDefaultLaunchTarget();
    assert.notEqual(target, 'claude', 'a default that the spawn gate then refuses is not a default');
    assert.equal(backends.isLaunchable(target), true);
  });
});

test('a stored default that is no longer launchable is not honoured', () => {
  backends.init({
    getGlobalSettings: () => ({ backendEnabled: { claude: false, codex: true }, defaultLaunchTarget: 'claude' }),
    profiles: { list: () => [], get: () => null },
  });
  try {
    assert.equal(backends.isLaunchable(backends.getDefaultLaunchTarget()), true);
  } finally {
    backends.init({ getGlobalSettings: () => ({}), profiles });
  }
});

// Turning EVERY backend off is a legal state — it just means nothing can be launched. Inventing a target
// here would only move the failure somewhere harder to explain.
test('with nothing enabled, the default target is null rather than a lie', () => {
  withSettings({ claude: false, codex: false, hermes: false, pi: false }, [], () => {
    assert.equal(backends.getDefaultLaunchTarget(), null);
    assert.deepEqual(backends.launchable(), []);
  });
});

// --- the places that used to run Claude anyway ------------------------------------------------------

// The scheduler built `claude …` with no gate check at all, so a disabled Claude would still be spawned
// by a cron tick — silently, because nothing on that path ever asked.
test('the scheduler asks the gate before spawning the claude binary', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const fn = src.slice(src.indexOf('function runScheduleCommand('));
  const body = fn.slice(0, fn.indexOf('\n    }'));
  assert.match(body, /isLaunchable\(['"]claude['"]\)/,
    'a scheduled run must not spawn a disabled backend');
});

// Claude's store is walked by its own path (PROJECTS_DIR), NOT by the generic Axis-B store scan — which
// skips Claude deliberately. So the enable gate had to be added to that path, or "disabled" would have
// meant "still indexing".
// Since #199 step 4 Claude's store walk lives in backends/claude/store-indexer.js (session-cache.js is
// now a façade). The gate must still be there — the rule follows the CODE, not the file.
test('Claude\'s scanner asks the gate too', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'backends', 'claude', 'store-indexer.js'), 'utf8');
  assert.match(src, /function claudeEnabled\(\)/, 'the gate exists');
  const refresh = src.slice(src.indexOf('function refreshFolder('));
  const body = refresh.slice(0, refresh.indexOf('\nfunction '));
  assert.match(body, /if \(!claudeEnabled\(\)\) return;/,
    'refreshFolder must not walk Claude\'s store while Claude is disabled');
});

// "Disable is not delete" (§5.8). The rows stay; only the scan and the launch stop.
test('the scanner fails OPEN when the registry cannot answer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'backends', 'claude', 'store-indexer.js'), 'utf8');
  const fn = src.slice(src.indexOf('function claudeEnabled()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /catch\s*{\s*return true/,
    'a registry that cannot answer must not look like "the user has no sessions"');
});

// --- the renderer no longer pretends -----------------------------------------------------------------

test('the settings UI no longer locks the Claude toggle', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'panels', 'backends-panel.js'), 'utf8');
  assert.ok(!/const locked = b\.id === 'claude'/.test(src),
    'the "always enabled" lock lived in the renderer, where it could not be enforced anyway');
  assert.ok(!/Built-in — always enabled/.test(src));
});
