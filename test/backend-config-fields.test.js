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

const { stripComments } = require('./helpers/strip-comments');

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
      // #617 — a CLI can retire a value. `retiredChoices` is what a blob written before that becomes, and
      // it only makes sense on a list of values: the DEAD side must be gone from the choices (or the field
      // still offers the thing that kills a session), and the LIVE side must be one of them (or the rewrite
      // moves a stored value onto something the settings screen cannot show and the CLI may not take).
      if (f.retiredChoices !== undefined) {
        assert.equal(f.type, 'select', `${backend.id}.${f.id} retires choices but is not a select`);
        for (const [dead, alive] of Object.entries(f.retiredChoices)) {
          assert.equal(f.choices.includes(dead), false,
            `${backend.id}.${f.id} still offers "${dead}" while declaring it retired`);
          assert.ok(f.choices.includes(alive),
            `${backend.id}.${f.id} rewrites "${dead}" to "${alive}", which is not one of its own choices`);
        }
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

  // A spawn-applied option is not a free pass: something really has to read it, or it is still a dead
  // control — just one whose deadness we wrote down.
  //
  // There are TWO ways to be really applied, and the second exists because the first quietly rewarded a
  // rule violation (#569). Demanding the option id appear in `spawn.js` is satisfied by the core naming
  // the option — and the only way the core can name one backend's option is to know that backend, which
  // `.claude/rules/backends.md` spends a section forbidding. `src/app/terminal/spawn.js` still reads
  // `backendDefaults.claude` by hand for exactly this, and that is the shape a new option must NOT copy.
  //
  //   1. **Named in `spawn.js`** — the older shape. Still accepted; Claude's three options use it.
  //   2. **`appliedBy: '<hook>'`** — the core calls a descriptor hook and passes the resolved options
  //      through, naming neither the backend nor the key. Three things are then true or the control is
  //      dead anyway: the descriptor really declares that hook, `spawn.js` really calls it, and a file
  //      in the backend's own folder OTHER THAN the one declaring `configFields` really reads the
  //      option id. A hook that exists but ignores the option is the same dead control, and an option
  //      read in a folder with no hook to reach it never runs.
  //
  // **The exclusion is what makes the third one a check at all.** A field list is source like anything
  // else, so a scan of the whole folder finds the option id inside the very declaration it is
  // examining, and any field at all passes — measured with a `{ appliesAt: 'spawn', appliedBy: <a real
  // hook> }` entry nothing anywhere reads. The declaring file is found by its own `configFields = [` /
  // `configFields: [` rather than by name, so a backend that moves its fields into a module of their
  // own is still measured; when no file declares them the check says so and fails, because it can no
  // longer tell a reader of the option from the declaration of it.
  //
  // Both sides are read with their prose dropped (`test/helpers/strip-comments.js`, CLAUDE.md reflex
  // 14). `spawn.js` carries a comment block beside the call naming the hook, and a hook or an option id
  // that exists only in a comment is exactly the dead control this test is here to refuse (#570).
  test(`${backend.id}: a spawn-applied option is actually applied at the spawn site`, () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const spawnFields = backend.configFields.filter(f => f.appliesAt === 'spawn');
    if (!spawnFields.length) return;
    const spawnSrc = stripComments(fs.readFileSync(
      path.join(__dirname, '..', 'src', 'app', 'terminal', 'spawn.js'), 'utf8'));

    // A field list, however a backend spells it: `const configFields = [` or `configFields: [`.
    const DECLARES_FIELDS = /\bconfigFields\s*[:=]\s*\[/;

    // Every `.js` under this backend's own folder, so the check follows a split into a new module —
    // split into the file(s) that DECLARE the fields and the rest, which are the only ones that can
    // answer "something reads this option".
    const folderSource = (id) => {
      const dir = path.join(__dirname, '..', 'src', 'backends', id);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return { declaring: [], readers: '' }; }
      const declaring = [];
      const readers = [];
      for (const name of names.filter(n => n.endsWith('.js'))) {
        let src = '';
        try { src = stripComments(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
        if (DECLARES_FIELDS.test(src)) declaring.push(name);
        else readers.push(src);
      }
      return { declaring, readers: readers.join('\n') };
    };

    const folderId = backend.baseId || backend.id;
    const folder = folderSource(folderId);

    for (const f of spawnFields) {
      if (f.appliedBy) {
        assert.equal(typeof backend[f.appliedBy], 'function',
          `${backend.id}.${f.id} says it is applied by ${f.appliedBy}, but the descriptor declares no such hook`);
        assert.ok(spawnSrc.includes(f.appliedBy),
          `${backend.id}.${f.id} names ${f.appliedBy}, but app/terminal/spawn.js never calls that hook`);
        assert.ok(folder.declaring.length,
          `${backend.id}: no file in src/backends/${folderId}/ declares configFields, so this check cannot ` +
          `tell a file that READS ${f.id} from the one that declares it — name the declaring file so it ` +
          'can be left out of the scan again');
        assert.ok(folder.readers.includes(f.id),
          `${backend.id}.${f.id} is applied through ${f.appliedBy}, but no file in src/backends/${folderId}/ ` +
          `besides ${folder.declaring.join(', ')} reads the option — the hook would ignore it, which is the ` +
          'same dead control as a field that reaches no argv');
        continue;
      }
      assert.ok(spawnSrc.includes(f.id),
        `${backend.id}.${f.id} claims to be applied at the spawn site, but app/terminal/spawn.js never mentions it. ` +
        "If the core should not name it, declare appliedBy: '<descriptor hook>' instead.");
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
