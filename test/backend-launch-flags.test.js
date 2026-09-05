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
//
// #570 — a help check is read here in TWO ways, and which one a question wants is not incidental. See
// `auditCode` / `auditProse` below: the flags are matched against the source with its prose removed, the
// reasons against the prose itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { stripComments } = require('./helpers/strip-comments');

const claude = require('../src/backends/claude');
const hermes = require('../src/backends/hermes');
const pi = require('../src/backends/pi');
const codex = require('../src/backends/codex');
const agy = require('../src/backends/agy');
const { managedFlags, declaredFlags, definitionFlags } = require('../scripts/managed-flags');

/** The backends that have a help check of their own — the audit lists live per backend. */
const BACKENDS = { claude, codex, hermes, pi, agy };

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const helpCheck = (backend) => path.join(SCRIPTS, `check-${backend}-help.js`);

// The two readings of a help check, and #570 is the difference between them.
//
// `auditCode` is the script with its prose dropped (`test/helpers/strip-comments.js`, CLAUDE.md reflex
// 14). Every question about what the script DECLARES asks it: is this flag on the audit list, does this
// file reach the shared deriver. A flag named only in a comment is not on any list, and letting one count
// would excuse it from the audit it exists to face — which is the whole direction of this guard's error.
//
// `auditProse` is the file as written, comments included, and exactly one question wants it: whether each
// exclusion carries the sentence saying why. There the comment IS the subject, so stripping would delete
// the thing being asserted. Anything else reaching for it is reading the wrong half.
const auditCode = (backend) => stripComments(fs.readFileSync(helpCheck(backend), 'utf8'));
const auditProse = (backend) => fs.readFileSync(helpCheck(backend), 'utf8');

/** The flags named in one `const <NAME> = new Set([...])` of a backend's help check — code, not prose. */
function flagSet(backend, name, { required = true } = {}) {
  const src = auditCode(backend);
  const start = src.indexOf(`const ${name}`);
  if (start < 0) {
    assert.ok(!required, `${backend} declares ${name}`);
    return [];
  }
  const block = src.slice(start, src.indexOf(']);', start));
  return [...block.matchAll(/'(--[a-z0-9-]+)'/g)].map(m => m[1]);
}

/** The `AUDITED_EXCLUDED` set of one backend's help check, as a list of flags. */
const excludedFlags = (backend) => flagSet(backend, 'AUDITED_EXCLUDED');

/** The one hand-written door: flags the CORE puts on that CLI's command line, outside the descriptor. */
const sentElsewhereFlags = (backend) => flagSet(backend, 'SENT_ELSEWHERE', { required: false });

/**
 * A descriptor whose `buildLaunch` honours an option no `configFields` entry declares — the defect #562
 * names, in the smallest shape that has it. Both the #548 derivation and the #562 guard are pinned against
 * it, because after the fix no real backend carries one and a check nothing can fail is not a check.
 */
const UNDECLARED_OPTION_BACKEND = {
  id: 'stub',
  configFields: [{ id: 'declared', label: 'Declared', type: 'toggle', default: false }],
  buildLaunch({ options } = {}) {
    const opts = options || {};
    const args = [];
    if (opts.declared) args.push('--declared');
    if (opts.undeclared) args.push('--undeclared', String(opts.undeclared));
    return { command: 'stub', args, env: {}, spawnMode: 'shell' };
  },
};

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
  //
  // The one test here that reads the PROSE, and #570 is why it says so out loud: the reason genuinely is a
  // comment, so this is the half of the file that has to survive. The flag's own presence is still a
  // question about code, and is asked of the stripped source through `excludedFlags` — otherwise a flag
  // written only in a comment would satisfy both halves of this check at once.
  const NEEDS_REASON = {
    claude: ['--permission-prompts', '--cloud', '--system-prompt-snapshot'],
    codex: ['--approve-for-me'],
    agy: ['--input-format'],
    pi: ['--tui-mode'],
    hermes: ['--in', '--reasoning'],
  };
  for (const [backend, flags] of Object.entries(NEEDS_REASON)) {
    const src = auditProse(backend);
    const listed = excludedFlags(backend);
    for (const flag of flags) {
      assert.ok(listed.includes(flag),
        `${backend}: ${flag} is on the audit list as code, not merely named in a comment`);
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
    const src = auditCode(name);
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
  // One a set built from `configFields` alone would have called unmanaged: `--settings` comes from the
  // live-binding hook, not from any declared option.
  assert.ok(claudeFlags.includes('--settings'), 'the per-spawn binding file');
  // The other kind was `--append-system-prompt` — an option `buildLaunch` read and nothing declared — until
  // #562 removed it. No real backend has one now, so the probe that finds them is pinned against a stub
  // instead: without it this derivation would go quiet the next time a branch like that appears.
  assert.ok(managedFlags(UNDECLARED_OPTION_BACKEND).includes('--undeclared'),
    'an option no field declares is still seen');
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
  // in this repo really puts on that CLI's command line. "Really puts" is a question about code, so the
  // named files are read with their prose dropped too (#570) — a flag a comment merely mentions would
  // otherwise stand in for the line that sends it, and that is the exact claim this entry is making.
  const WHERE = {
    claude: ['src/app/terminal/spawn.js'],
    pi: ['src/backends/pi/index.js'],
  };
  for (const [backend, files] of Object.entries(WHERE)) {
    const flags = sentElsewhereFlags(backend);
    assert.ok(flags.length, `${backend} declares what the core adds`);
    const sources = files
      .map(f => stripComments(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')))
      .join('\n');
    for (const flag of flags) {
      assert.ok(sources.includes(flag), `${backend}: ${flag} is declared as sent, but ${files.join(', ')} never sends it`);
    }
  }
});

// --- #562: the other direction — a flag on the argv that no field explains -------------------------------

test('every flag a launch can carry is explained by a declared option or a documented door (#562)', () => {
  // `test/backend-config-fields.test.js` refuses a declared option that reaches no argv — a control that
  // lies. This is the mirror: an option that reaches the argv and no control declares. Claude honoured
  // `appendSystemPrompt` that way for months, so no settings page offered it, no scope stored it and the
  // Configure dialog could not set it — the only way in was to build the options object by hand, which
  // stopped being possible when #246 removed the schedule creator that did.
  //
  // Both sets come from the same derivation (#548), so nothing is written down here: the launch shapes and
  // the per-spawn binding file are in both and cancel, and what survives the subtraction is exactly a flag
  // gated on an option key `configFields` never named. The one legitimate door is the core's own
  // `SENT_ELSEWHERE`, which is read out of the backend's help check rather than repeated here.
  for (const [name, backend] of Object.entries(BACKENDS)) {
    const explained = new Set([...declaredFlags(backend), ...sentElsewhereFlags(name)]);
    assert.deepEqual(
      managedFlags(backend).filter(flag => !explained.has(flag)),
      [],
      `${name}: buildLaunch can emit a flag no configFields entry declares — declare it, or stop sending it`,
    );
  }
});

test('the #562 guard can actually fail — a stub with an undeclared option trips it', () => {
  // A guard that passes because there is nothing left to catch is indistinguishable from one that is
  // broken. The stub is the defect in miniature: one declared toggle, one option key nothing declares.
  const explained = new Set(declaredFlags(UNDECLARED_OPTION_BACKEND));
  assert.ok(explained.has('--declared'), 'the declared field is accounted for');
  assert.deepEqual(
    managedFlags(UNDECLARED_OPTION_BACKEND).filter(flag => !explained.has(flag)),
    ['--undeclared'],
    'and the undeclared one is what the guard reports',
  );
});

test('Claude no longer honours the launch option nothing declared (#562)', () => {
  // Removed rather than declared, and the reason lives with the exclusion: passing
  // `--append-system-prompt` turns `--system-prompt-snapshot` off, and that flag is audited out precisely
  // because nobody here has watched what it does. A text field for it would ship that interaction sideways.
  assert.equal(claude.configFields.some(f => f.id === 'appendSystemPrompt'), false, 'not declared');
  assert.equal(launchArgs(claude, { appendSystemPrompt: 'be terse' }).includes('--append-system-prompt'), false,
    'and a value stored before this fix cannot reach the argv either');
  assert.ok(excludedFlags('claude').includes('--append-system-prompt'), 'audited out, with the reason beside it');
  // Pi's option of the same name is declared and reachable — a different backend, a different CLI, and not
  // this defect. Left alone on purpose (`fix a backend, check its siblings` cuts both ways).
  assert.ok(pi.configFields.some(f => f.id === 'appendSystemPrompt'), 'Pi declares its own');
  assert.ok(launchArgs(pi, { appendSystemPrompt: 'be terse' }).includes('--append-system-prompt'));
});
