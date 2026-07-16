'use strict';
// #160 — a backend declares what its CLI can do, and every declared option reaches the command line.
//
// `configFields` is the whole contract: the Settings page and the Configure dialog are GENERATED from
// it. So an option that is declared but never translated in `buildLaunch` is a control that does
// nothing — the user sets it, the UI shows it, the CLI never hears about it. That is exactly the class
// of bug D18 was (every saved launch default silently dropped), and nothing structural prevented it
// from happening again per-field.
//
// These tests are the structural guard: for every backend, every declared field must be reachable, and
// an unset field must change nothing.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const claude = require('../src/backends/claude');
const codex = require('../src/backends/codex');
const agy = require('../src/backends/agy');
const hermes = require('../src/backends/hermes');
const pi = require('../src/backends/pi');

const BACKENDS = [claude, codex, agy, hermes, pi];

const CTX = { cwd: '/p', resume: false, sessionId: 's1' };

/** A value that will actually show up in the argv for a field of this type. */
function probeValue(field) {
  if (field.type === 'toggle') return true;
  if (field.type === 'select') {
    const choices = (field.choices || []).filter(Boolean);
    // Pick a choice that is NOT the default, so its presence proves it was carried.
    return choices.find(c => c !== field.default) || choices[0] || '';
  }
  if (field.type === 'number') return 42;
  return 'PROBE-VALUE';
}

for (const backend of BACKENDS) {
  test(`${backend.id}: every declared option is described and typed`, () => {
    for (const f of backend.configFields) {
      assert.ok(f.id, 'a field needs an id');
      assert.ok(f.label, `${backend.id}.${f.id} needs a label — it is rendered`);
      assert.ok(['text', 'toggle', 'select', 'number'].includes(f.type || 'text'),
        `${backend.id}.${f.id} has an unknown type "${f.type}"`);
      assert.ok('default' in f, `${backend.id}.${f.id} must state its default — the cascade resolves against it (#163)`);
      if (f.type === 'select') {
        assert.ok(Array.isArray(f.choices) && f.choices.length, `${backend.id}.${f.id} is a select with no choices`);
        assert.ok(f.choices.includes(f.default), `${backend.id}.${f.id}'s default is not one of its own choices`);
      }
    }
  });

  // The heart of it: a declared option that changes nothing is a lie told by the settings page.
  //
  // Two honest exceptions, and both must be DECLARED rather than discovered:
  //   `appliesAt: 'spawn'` — applied by main.js at the spawn site, not in the argv (Claude's MCP bridge,
  //     its pre-launch prefix, its AFK env var).
  //   `requires: '<other>'` — only meaningful while another option is on (a worktree's branch name).
  test(`${backend.id}: every declared option reaches the command line`, () => {
    const bare = backend.buildLaunch({ ...CTX, options: {} });

    for (const f of backend.configFields) {
      if (f.appliesAt === 'spawn') continue;

      const value = probeValue(f);
      const options = { [f.id]: value };
      if (f.requires) options[f.requires] = true;

      const baseline = f.requires
        ? backend.buildLaunch({ ...CTX, options: { [f.requires]: true } })
        : bare;

      const argv = backend.buildLaunch({ ...CTX, options }).args.join(' ');
      assert.notEqual(argv, baseline.args.join(' '),
        `${backend.id}.${f.id} is declared in configFields but changes nothing in the argv — ` +
        'the settings page would show a control that does nothing. If it is applied elsewhere, ' +
        "declare it: appliesAt: 'spawn'.");

      if (f.type !== 'toggle') {
        assert.ok(argv.includes(String(value)),
          `${backend.id}.${f.id}: the value never made it into the argv (${argv})`);
      }
    }
  });

  // A spawn-applied option is not a free pass: main.js really has to read it, or it is still a dead
  // control — just one whose deadness we wrote down.
  test(`${backend.id}: a spawn-applied option is actually applied at the spawn site`, () => {
    const spawnFields = backend.configFields.filter(f => f.appliesAt === 'spawn');
    if (!spawnFields.length) return;
    const mainSrc = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src', 'app', 'terminal', 'spawn.js'), 'utf8');
    for (const f of spawnFields) {
      assert.ok(mainSrc.includes(f.id),
        `${backend.id}.${f.id} claims to be applied at the spawn site, but app/terminal/spawn.js never mentions it`);
    }
  });

  test(`${backend.id}: an unset option adds nothing (the bare command line stays bare)`, () => {
    const bare = backend.buildLaunch({ ...CTX, options: {} });
    // Every field explicitly absent / empty must produce the same argv as no options at all — otherwise
    // a user who never touched a setting silently gets a flag they did not ask for.
    const empties = {};
    for (const f of backend.configFields) empties[f.id] = f.type === 'toggle' ? false : '';
    const withEmpties = backend.buildLaunch({ ...CTX, options: empties });
    assert.deepEqual(withEmpties.args, bare.args);
  });
}

// --- the specifics worth pinning ------------------------------------------------------------------

test('Codex: a comma-separated list becomes REPEATED flags, not one flag with a comma in it', () => {
  const launch = codex.buildLaunch({
    ...CTX,
    options: { configOverrides: 'reasoning.effort=high, model_verbosity=low', addDirs: '/a, /b' },
  });
  const args = launch.args;
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '-c'), ['reasoning.effort=high', 'model_verbosity=low']);
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '--add-dir'), ['/a', '/b']);
});

test('Hermes: the dangerous switches are opt-in and absent by default', () => {
  const bare = hermes.buildLaunch({ ...CTX, options: {} });
  assert.ok(!bare.args.includes('--yolo'));
  assert.ok(!bare.args.includes('--accept-hooks'));

  const armed = hermes.buildLaunch({ ...CTX, options: { yolo: true, acceptHooks: true } });
  assert.ok(armed.args.includes('--yolo'));
  assert.ok(armed.args.includes('--accept-hooks'));
});

test('Hermes still injects no auth — it authenticates itself', () => {
  const launch = hermes.buildLaunch({ ...CTX, options: { model: 'x', provider: 'y' } });
  assert.deepEqual(launch.env, {}, 'we never hand Hermes a credential; that was true before #160 and stays true');
});

// Pi reads its key from the environment. Putting it on the command line would expose it to every
// process listing on the machine — so `--api-key` is deliberately NOT a field, and must never become one.
test('Pi: there is no field that would put a raw API key on the command line', () => {
  const ids = pi.configFields.map(f => f.id.toLowerCase());
  for (const forbidden of ['apikey', 'api_key', 'key', 'token', 'secret']) {
    assert.ok(!ids.includes(forbidden), `pi declares "${forbidden}" — a secret must not travel in the argv`);
  }
});

// The reason this file exists at all: Pi and Hermes each declared exactly ONE option, so they were, in
// practice, not configurable from Switchboard while their CLIs took a dozen meaningful switches.
test('no backend is left with a token gesture of a config surface', () => {
  for (const backend of BACKENDS) {
    assert.ok(backend.configFields.length >= 3,
      `${backend.id} declares ${backend.configFields.length} option(s) — that is not a configuration surface`);
  }
});
