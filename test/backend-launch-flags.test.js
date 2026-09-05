'use strict';
// #537 — the launch flags the CLIs added, and the ones deliberately left out.
//
// The rule the issue sets: "a control that changes nothing is worse than no control". So a flag becomes an
// option only when it changes what an INTERACTIVE session does, which is the only kind Switchboard spawns.
// Everything else is recorded in the backend's `scripts/check-*-help.js` audit list WITH its reason, so the
// next flag a CLI adds shows up as a failing check rather than as silence.
//
// What is pinned here is both halves. `test/backend-config-fields.test.js` already refuses an option that
// reaches no argv; these assert the other direction — that the exclusions stay excluded, and stay
// explained. An audit entry with no reason beside it is how a decision turns into a list nobody can
// re-derive.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const claude = require('../src/backends/claude');
const hermes = require('../src/backends/hermes');
const pi = require('../src/backends/pi');
const codex = require('../src/backends/codex');
const agy = require('../src/backends/agy');
const { managedFlags, definitionFlags } = require('../scripts/managed-flags');

/** The backends that have a help check of their own — the audit lists live per backend. */
const BACKENDS = { claude, codex, hermes, pi, agy };

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const auditSource = (backend) => fs.readFileSync(path.join(SCRIPTS, `check-${backend}-help.js`), 'utf8');

/** The `AUDITED_EXCLUDED` set of one backend's help check, as a list of flags. */
function excludedFlags(backend) {
  const src = auditSource(backend);
  const start = src.indexOf('const AUDITED_EXCLUDED');
  assert.ok(start > 0, `${backend} has an audit list`);
  const block = src.slice(start, src.indexOf(']);', start));
  return [...block.matchAll(/'(--[a-z0-9-]+)'/g)].map(m => m[1]);
}

const launchArgs = (backend, options) => backend.buildLaunch({ cwd: '/project', options }).args;

// --- what became an option ------------------------------------------------------------------------------

test('Pi takes a per-run theme (#537)', () => {
  assert.ok(pi.configFields.some(f => f.id === 'useTheme'), 'the option is declared');
  assert.deepEqual(
    launchArgs(pi, { useTheme: 'dracula' }).slice(-2),
    ['--use-theme', 'dracula'],
  );
  assert.equal(launchArgs(pi, { useTheme: '' }).includes('--use-theme'), false, 'empty sends nothing');
});

test('Claude takes restricted mode and an auto-compact window (#537)', () => {
  // `--restricted` is the opposite direction from `--dangerously-skip-permissions`, which this backend
  // deliberately does not offer: it REMOVES the tools that run commands.
  assert.ok(launchArgs(claude, { restricted: true }).includes('--restricted'));
  assert.equal(launchArgs(claude, { restricted: false }).includes('--restricted'), false);

  assert.deepEqual(launchArgs(claude, { autocompact: '200k' }).slice(-2), ['--autocompact', '200k']);
  assert.equal(launchArgs(claude, { autocompact: '' }).includes('--autocompact'), false);
});

test('a flag the CLI parses and then DISCARDS is not offered (#537)', () => {
  // `hermes --reasoning` was very nearly an option here, and it is the sharpest case in this issue: the
  // flag exists, argparse accepts it, and the modern TUI then drops it — `_CHAT_PASSTHROUGH` in hermes'
  // own main.py does not carry `reasoning`, so `_launch_tui` never receives it.
  //
  // The tell reads backwards, which is why it nearly got through: `--model`, `--provider` and `--toolsets`
  // all say "Applies to -z/--oneshot and --tui" BECAUSE they are wired through that passthrough.
  // `--reasoning` omits the sentence because it is not. An absent restriction is not universality.
  assert.equal(hermes.configFields.some(f => f.id === 'reasoning'), false, 'not declared');
  assert.deepEqual(launchArgs(hermes, { reasoning: 'high' }), [], 'and it cannot reach the argv anyway');
  assert.ok(excludedFlags('hermes').includes('--reasoning'), 'audited out, with the measurement as the reason');
});

// --- what did not, and why ------------------------------------------------------------------------------

test('a flag that only means something under --print is not offered (#537)', () => {
  // The one this issue opened with. `claude --permission-prompts none` reads like a useful control and
  // does nothing in a TUI — its own help says "with --print".
  assert.ok(excludedFlags('claude').includes('--permission-prompts'));
  // `--permission-prompt-tool` used to be listed right beside it, and never because Claude defines it: the
  // old extractor scraped every `--word` out of every line, so the name appeared inside
  // `--permission-prompts`' own description and had to be silenced. The audit reads DEFINITIONS now (#548),
  // so an entry describing the extractor rather than the CLI has nothing left to silence.
  assert.equal(excludedFlags('claude').includes('--permission-prompt-tool'), false);
  assert.ok(excludedFlags('agy').includes('--input-format'));

  for (const backend of [claude, hermes, pi]) {
    const args = launchArgs(backend, {});
    assert.equal(args.includes('--print'), false, 'and nothing here runs print mode anyway');
  }
});

test('a flag that starts a session this app cannot follow is not offered (#537)', () => {
  // A cloud session writes no local transcript, so the scan cannot find, adopt or resume what it started.
  for (const flag of ['--cloud', '--environment', '--teleport']) {
    assert.ok(excludedFlags('claude').includes(flag), `${flag} is audited out`);
  }
});

test('a one-click "stop asking me" is not offered (#537)', () => {
  // Same stance as `--dangerously-bypass-approvals-and-sandbox`, which sits beside it in Codex' own help.
  const codexExcluded = excludedFlags('codex');
  assert.ok(codexExcluded.includes('--approve-for-me'));
  assert.ok(codexExcluded.includes('--dangerously-bypass-approvals-and-sandbox'),
    'the flag it is being compared to is audited out for the same reason');
  // And an option nobody declared cannot reach the argv by being passed in anyway.
  assert.equal(launchArgs(require('../src/backends/codex'), { approveForMe: true }).includes('--approve-for-me'), false);
});

test('an unmeasured flag stays out until somebody watches it (#537)', () => {
  assert.ok(excludedFlags('pi').includes('--tui-mode'));
  assert.ok(excludedFlags('claude').includes('--system-prompt-snapshot'));
});

test('every exclusion added for this issue carries its reason (#537)', () => {
  // An audit list is a record of decisions. Without the reason beside the entry it is a list nobody can
  // re-derive, and the next person either re-litigates it or adds the flag by accident.
  const NEEDS_REASON = {
    claude: ['--permission-prompts', '--cloud', '--system-prompt-snapshot'],
    codex: ['--approve-for-me'],
    agy: ['--input-format'],
    pi: ['--tui-mode'],
    hermes: ['--in', '--reasoning'],
  };
  for (const [backend, flags] of Object.entries(NEEDS_REASON)) {
    const src = auditSource(backend);
    for (const flag of flags) {
      const at = src.indexOf(`'${flag}'`);
      assert.ok(at > 0, `${backend}: ${flag} is listed`);
      // Back to the PREVIOUS entry, not a byte count. A fixed window reaches over a neighbour's comment,
      // so deleting the reason for one flag in a group left this green while the file then read as though
      // that flag were excluded for the reason above it — measured, and the whole point of the check.
      const listStart = src.indexOf('const AUDITED_EXCLUDED');
      const prevEntry = src.lastIndexOf("',", at - 1);
      const from = prevEntry > listStart ? prevEntry : listStart;
      assert.match(src.slice(from, at), /\/\/[^\n]*#537/,
        `${backend}: ${flag} says why it is excluded, in a comment of its own`);
    }
  }
});

test('a flag this app SENDS is never also on the audit-excluded list (#537, #548)', () => {
  // The two answer opposite questions, and a flag on both makes the check pass whichever way the code
  // goes. Asked of every flag the descriptors can emit rather than of a sample: Pi's `--extension` — put on
  // every Pi launch by `buildLiveBinding` — sat in that excluded list until the derivation asked.
  for (const [name, backend] of Object.entries(BACKENDS)) {
    const excluded = excludedFlags(name);
    for (const flag of managedFlags(backend)) {
      assert.equal(excluded.includes(flag), false,
        `${name}: ${flag} is sent on the command line, so it cannot also be audited away`);
    }
  }
});

// --- #548: the managed set is DERIVED, so a flag cannot be missing from the CLI and from the list at once

test('Hermes does not send a flag its CLI has no top-level spelling for (#548)', () => {
  // `--checkpoints` belongs to `hermes chat`; bare `hermes` — which is what this app spawns — answers
  // "unrecognized arguments: --checkpoints" and the session dies before the TUI starts. The toggle was in
  // the settings screen for months, so anyone who switched it on got a tab that closed on launch.
  assert.equal(hermes.configFields.some(f => f.id === 'checkpoints'), false, 'not declared');
  assert.equal(launchArgs(hermes, { checkpoints: true }).includes('--checkpoints'), false,
    'and a stored value from before this fix cannot reach the argv either');
  // Nor is it audited away: excluding it would claim a decision about a top-level flag that does not exist.
  assert.equal(excludedFlags('hermes').includes('--checkpoints'), false);
});

test('no help check writes down the flags this app sends (#548)', () => {
  // The structural half. A hand-typed MANAGED set can be missing a flag at the same time as the CLI is, so
  // the audit compares two things that agree with each other — which is exactly how `--checkpoints` stayed
  // green through every run of `npm run backends:help-check`.
  for (const name of Object.keys(BACKENDS)) {
    const src = auditSource(name);
    assert.equal(/const\s+MANAGED\s*=/.test(src), false,
      `${name}: the managed set is derived from the descriptor, not listed in the script`);
    assert.match(src, /require\('\.\/managed-flags'\)/, `${name}: it asks the shared deriver`);
    assert.match(src, /auditFlags\(/, `${name}: and audits both directions with it`);
  }
});

test('the derivation sees every flag a launch can carry, not only the declared options (#548)', () => {
  const hermesFlags = managedFlags(hermes);
  assert.ok(hermesFlags.includes('--yolo'), 'a plain toggle');
  assert.ok(hermesFlags.includes('-r'), 'the resume shape, which no configField declares');
  assert.equal(hermesFlags.includes('--checkpoints'), false, 'and nothing it no longer sends');

  const claudeFlags = managedFlags(claude);
  // Two that a set built from `configFields` alone would have called unmanaged: `--settings` comes from the
  // live-binding hook, and `--append-system-prompt` from an option `buildLaunch` reads but nothing declares.
  assert.ok(claudeFlags.includes('--settings'), 'the per-spawn binding file');
  assert.ok(claudeFlags.includes('--append-system-prompt'), 'an undeclared option buildLaunch still honours');
  // Both sides of a select, not whichever probe value came first.
  assert.ok(claudeFlags.includes('--permission-mode') && claudeFlags.includes('--dangerously-skip-permissions'));

  assert.ok(managedFlags(pi).includes('--extension'), 'Pi hands its CLI a generated extension per spawn');
});

test('a flag a help line only MENTIONS is not a flag the CLI advertises (#548)', () => {
  // The second hole this issue names. `--add-dir`, `--settings`, `--tools` and `--worktree` all appear
  // inside other Claude flags' description text; scraping every `--word` off every line meant the CLI could
  // have dropped any of them while the audit went on reporting them as advertised.
  assert.deepEqual(definitionFlags('  --permission-prompts <target>   Who answers, or --permission-prompt-tool'),
    ['--permission-prompts']);
  assert.deepEqual(definitionFlags('                                        --settings, --agents, --plugin-dir.'),
    [], 'a wrapped description line is not a definition, even when it starts with a flag');
  // And a definition keeps every spelling it lists, so a short flag can be answered through its long one.
  assert.deepEqual(definitionFlags('  --resume SESSION, -r SESSION'), ['--resume', '-r']);
  assert.deepEqual(definitionFlags('  -c, --config <key=value>'), ['-c', '--config']);
  assert.deepEqual(definitionFlags('  -c                              Short alias for --continue'), ['-c']);
});

test('a flag the CORE sends outside the descriptor is named where it is sent (#548)', () => {
  // `alsoSent` is the one hand-written door left, so it stays narrow: each entry must be a flag some file
  // in this repo really puts on that CLI's command line.
  const sentElsewhere = (backend) => {
    const src = auditSource(backend);
    const at = src.indexOf('const SENT_ELSEWHERE');
    if (at < 0) return [];
    return [...src.slice(at, src.indexOf(']);', at)).matchAll(/'(--[a-z0-9-]+)'/g)].map(m => m[1]);
  };
  const WHERE = {
    claude: ['src/app/terminal/spawn.js'],
    pi: ['src/backends/pi/index.js'],
  };
  for (const [backend, files] of Object.entries(WHERE)) {
    const flags = sentElsewhere(backend);
    assert.ok(flags.length, `${backend} declares what the core adds`);
    const sources = files.map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
    for (const flag of flags) {
      assert.ok(sources.includes(flag), `${backend}: ${flag} is declared as sent, but ${files.join(', ')} never sends it`);
    }
  }
});
