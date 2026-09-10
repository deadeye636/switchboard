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

// --- #617: the flag survives, its VALUES do not ----------------------------------------------------------
//
// `--ask-for-approval` never moved, so every check above stayed green while two of the four values the
// Codex Approval field offered were removed from the CLI. A session launched on either died at spawn with
// exit code 2. What the help checks compare now is the choices themselves against the values the CLI
// DECLARES it takes — and, as everywhere else here, the sending side is derived and the excluded side
// carries a reason.

const { optionBlocks, possibleValues, selectChoiceArgs, auditChoices } = require('../scripts/managed-flags');

/** The field ids in one backend's `CHOICES_NOT_ENUMERATED` — code, not prose, for the same reason as above. */
function choiceExclusions(backend) {
  const src = auditCode(backend);
  const start = src.indexOf('const CHOICES_NOT_ENUMERATED');
  assert.ok(start >= 0, `${backend} declares CHOICES_NOT_ENUMERATED`);
  const block = src.slice(start, src.indexOf(']);', start));
  return [...block.matchAll(/'([A-Za-z][A-Za-z0-9_-]*)'/g)].map(m => m[1]);
}

/**
 * A backend whose CLI retired a value, in the smallest shape that has the defect — the same role the
 * undeclared-option stub plays for #562. The real descriptors are fixed now, and a check nothing can fail
 * is not a check.
 */
const RETIRED_VALUE_BACKEND = {
  id: 'stub',
  configFields: [
    { id: 'approval', label: 'Approval', type: 'select', choices: ['gone', 'kept'], default: 'kept' },
    { id: 'mood', label: 'Mood', type: 'select', choices: ['sunny'], default: 'sunny' },
  ],
  buildLaunch({ options } = {}) {
    const opts = options || {};
    const args = [];
    if (opts.approval) args.push('-a', String(opts.approval));
    if (opts.mood) args.push('--mood', String(opts.mood));
    return { command: 'stub', args, env: {}, spawnMode: 'shell' };
  },
};

const STUB_HELP = [
  '  -a, --approval <POLICY>',
  '          When to ask',
  '',
  '          Possible values:',
  '          - kept:  the one that is left',
  '',
  '  --mood <MOOD>',
  '          How it feels about this',
];

test('a CLI that drops one of an enum value list is caught, where the flag audit cannot see it (#617)', () => {
  const blocks = optionBlocks(STUB_HELP);
  const result = auditChoices({ backend: RETIRED_VALUE_BACKEND, blocks, excluded: new Set(['mood']) });
  assert.deepEqual(result.dead, [{ field: 'approval', choice: 'gone', flag: '--approval', values: ['kept'] }],
    'the dead value is named with the flag it would have gone on and what that flag still takes');
  // …and the flag itself is present and correct throughout, which is why nothing else here noticed.
  assert.ok(blocks.some(b => b.flags.includes('-a') && b.flags.includes('--approval')));
});

test('a choice that becomes a BARE flag is not an enum value, and is not asked about (#617)', () => {
  // Claude's `dangerously-skip` emits `--dangerously-skip-permissions` and Pi's `approve` emits
  // `--approve`; an empty choice emits nothing at all. None of those is a value a CLI has to list, and the
  // flags they do emit are audited by `auditFlags`. Derived from the argv rather than listed, so a backend
  // that changes how a choice is spelled moves in and out of this set on its own.
  const sent = selectChoiceArgs(claude).filter(c => c.field === 'permissionMode').map(c => c.choice);
  assert.ok(sent.includes('plan'), 'a choice that rides on --permission-mode is asked about');
  assert.equal(sent.includes('dangerously-skip'), false, 'the one that becomes its own flag is not');
  assert.equal(selectChoiceArgs(pi).some(c => c.choice === 'approve'), false, 'and neither is the Pi one');
});

test('only a DECLARED list of values is read — prose is not parsed (#617)', () => {
  // Three parser idioms, because the CLIs this app drives use three. Each is the argument parser printing
  // its own enum, which is a fact; a description sentence is somebody's writing, and scraping one either
  // invents a dead value or hides a real one.
  assert.deepEqual([...possibleValues(['  -s, --sandbox <MODE>  [possible values: read-only, workspace-write]'])],
    ['read-only', 'workspace-write']);
  assert.deepEqual([...possibleValues(['  -a, --ask <P>', '      Possible values:', '      - on-request: it asks', '      - never:      it does not'])],
    ['on-request', 'never']);
  assert.deepEqual([...possibleValues(['  --permission-mode <mode>  Permission mode', '     (choices: "acceptEdits",', '     "plan")'])],
    ['acceptEdits', 'plan'], 'commander wraps its list over as many lines as it needs');
  // The three shapes that are NOT a declaration, each taken from a real help this repo audits.
  assert.equal(possibleValues(['  --thinking <level>   Set thinking level: off, minimal, low, medium, high']), null);
  assert.equal(possibleValues(['  --local-provider <P>  Specify which local provider to use (lmstudio or ollama)']), null);
  assert.equal(possibleValues(['  --effort   Reasoning effort for the current CLI session (low|medium|high)']), null);
});

test('a definition keeps the description lines that belong to it, and only those (#617)', () => {
  // The enum sits in the description, four lines below the definition for one CLI and on the same line for
  // another — so the blocks have to end where the next definition starts, or one option's values answer for
  // its neighbour.
  const blocks = optionBlocks(STUB_HELP);
  assert.equal(blocks.length, 2);
  assert.deepEqual([...possibleValues(blocks[0].lines)], ['kept']);
  assert.equal(possibleValues(blocks[1].lines), null, 'the next option block carries none of it');
});

test('an unenumerated field is REPORTED rather than quietly passed (#617)', () => {
  // The failure this guard could most easily have: a CLI that declares nothing, a check that finds nothing
  // to complain about, and an audit that reads as coverage. It says so instead, and the backend's own
  // script records the decision.
  const blocks = optionBlocks(STUB_HELP);
  const result = auditChoices({ backend: RETIRED_VALUE_BACKEND, blocks, excluded: new Set() });
  assert.deepEqual(result.unenumerated, [{ field: 'mood', flag: '--mood', why: '--mood declares no possible values' }]);
  assert.deepEqual(result.excluded, []);
});

test('a choice that reaches the argv spelled some OTHER way is reported too (#617)', () => {
  // The quietest way for this audit to lie: a choice that is translated into a different token, so no value
  // token matches it, so there is nothing to compare and nothing said. It is not the bare-flag case — the
  // argv gained a value — and it is not a value the CLI can be asked about either. No backend does it, which
  // is exactly why the branch is written and pinned now.
  const RESPELLED = {
    id: 'stub',
    configFields: [{ id: 'mode', label: 'Mode', type: 'select', choices: ['plan', 'go'], default: 'go' }],
    buildLaunch({ options } = {}) {
      const opts = options || {};
      return { command: 'stub', args: opts.mode ? ['--mode', `${opts.mode}Mode`] : [], env: {}, spawnMode: 'shell' };
    },
  };
  const blocks = optionBlocks(['  --mode <MODE>', '          How it runs']);
  const result = auditChoices({ backend: RESPELLED, blocks, excluded: new Set() });
  assert.deepEqual(result.unenumerated,
    [{ field: 'mode', flag: null, why: 'its choices change the argv without appearing in it, so nothing can be compared' }]);
  assert.deepEqual(result.checked, [],
    'and it is not ALSO counted as checked — one field gets one answer, or the pass line claims coverage ' +
    'for the very field the run is exiting over');
});

test('an excluded field whose FLAG the CLI dropped is left to the flag audit (#617)', () => {
  // The wrong-vocabulary failure. `--mood` is excluded because its CLI declares no values; if the CLI then
  // removes the flag entirely, that is `auditFlags`' `missing` — and answering it here as a stale exclusion
  // reported the wrong defect and, because the values block runs first, hid the right one behind it.
  const blocks = optionBlocks(['  -a, --approval <POLICY>', '          Possible values:', '          - kept:  the one that is left']);
  const result = auditChoices({ backend: RETIRED_VALUE_BACKEND, blocks, excluded: new Set(['mood']) });
  assert.deepEqual(result.stale, [], 'the exclusion is not stale — the field still sends a value, the CLI just lost the flag');
  assert.deepEqual(result.unenumerated, [], 'and it is not reported here either');
  assert.deepEqual(result.dead, [{ field: 'approval', choice: 'gone', flag: '--approval', values: ['kept'] }],
    'while the enum that IS still declared is checked as usual');
});

test('commander keeps writing after the choices, and none of it is a value (#617)', () => {
  // Both shapes are from the installed Claude CLI rather than invented, and the second is why the cut is a
  // pattern instead of the one keyword somebody had measured: `--permission-prompts` ends its list with
  // `default:`, `--prompt-suggestions` with `preset:`, and a cut at `default:` alone left the second one
  // producing a value spelled `preset: "true`. The list ends at the first `word:` after a comma.
  assert.deepEqual([...possibleValues(['  --permission-prompts <target>  Who answers (choices: "host", "none",', '     default: "host")'])],
    ['host', 'none']);
  assert.deepEqual([...possibleValues(['  --prompt-suggestions <mode>  (choices: "on", "off", preset: "true")'])],
    ['on', 'off']);
});

test('a value the CLI has taken BACK is reported, so retiredChoices cannot only grow (#617)', () => {
  // The exclusion lists are checked for staleness in both directions; a descriptor's own `retiredChoices` is
  // the third list this work added, and without this it could only accumulate. A rewrite that keeps moving a
  // value the CLI accepts again is a setting the user can no longer choose, and nothing else would say so.
  const REVIVED = {
    id: 'stub',
    configFields: [{
      id: 'approval', label: 'Approval', type: 'select', choices: ['kept'], default: 'kept',
      retiredChoices: { gone: 'kept' },
    }],
    buildLaunch({ options } = {}) {
      const opts = options || {};
      return { command: 'stub', args: opts.approval ? ['-a', String(opts.approval)] : [], env: {}, spawnMode: 'shell' };
    },
  };
  const back = optionBlocks(['  -a, --approval <POLICY>', '          Possible values:', '          - kept: still here', '          - gone: back again']);
  const result = auditChoices({ backend: REVIVED, blocks: back, excluded: new Set() });
  assert.deepEqual(result.stale.map(s => s.field), ['approval']);
  assert.match(result.stale[0].why, /takes "gone" again/);
  assert.deepEqual(result.dead, [], 'and the choice it still offers is fine');

  // While the CLI still refuses it, nothing is reported: the rewrite is doing its job.
  const still = optionBlocks(['  -a, --approval <POLICY>', '          Possible values:', '          - kept: still here']);
  assert.deepEqual(auditChoices({ backend: REVIVED, blocks: still, excluded: new Set() }).stale, []);
});

test('a stale choices exclusion fails, in both directions (#617)', () => {
  // An exclusion list that only ever grows is a place to silence a finding. So: an entry for a field that
  // no longer sends a value, and an entry for a field whose CLI has started declaring its values after all.
  const blocks = optionBlocks(STUB_HELP);
  const gone = auditChoices({ backend: RETIRED_VALUE_BACKEND, blocks, excluded: new Set(['nosuchfield']) });
  assert.deepEqual(gone.stale.map(s => s.field), ['nosuchfield']);

  const nowDeclared = auditChoices({ backend: RETIRED_VALUE_BACKEND, blocks, excluded: new Set(['approval']) });
  assert.deepEqual(nowDeclared.stale.map(s => s.field), ['approval']);
  assert.match(nowDeclared.stale[0].why, /declares its values now/);
});

test('every help check audits the values as well as the flags (#617)', () => {
  for (const name of Object.keys(BACKENDS)) {
    const src = auditCode(name);
    assert.match(src, /auditChoices\(/, `${name}: the help check compares choices against the CLI own list`);
    assert.match(src, /const CHOICES_NOT_ENUMERATED/, `${name}: and declares what it deliberately does not check`);
    assert.match(src, /optionBlocks\(/, `${name}: reading whole option blocks, because the enum is in the description`);
  }
});

test('every choices exclusion carries its reason (#617)', () => {
  // The same rule the flag exclusions live under, and the same reading: the entry itself is code, the
  // reason is prose. A field named only in a comment must not count as excluded.
  //
  // DERIVED over whatever each list actually holds, not over a list written here. The #537 guard above
  // names its flags by hand, and that is its weakness: an entry added later with no comment passes it. This
  // one asks every entry of every list, so a new exclusion is covered on the day it is written.
  let checked = 0;
  for (const backend of Object.keys(BACKENDS)) {
    const src = auditProse(backend);
    const listStart = src.indexOf('const CHOICES_NOT_ENUMERATED');
    for (const field of choiceExclusions(backend)) {
      const at = src.indexOf(`'${field}'`, listStart);
      assert.ok(at > 0, `${backend}: ${field} is listed`);
      // Back to the PREVIOUS entry, not a byte count — a fixed window reaches over a neighbour's comment
      // and lets a reason deleted from one entry be answered by the one above it.
      const prevEntry = src.lastIndexOf("',", at - 1);
      const from = prevEntry > listStart ? prevEntry : listStart;
      assert.match(src.slice(from, at), /\/\/[^\n]*#\d+/,
        `${backend}: ${field} says why its values are not compared, in a comment of its own`);
      checked++;
    }
  }
  // …and the derivation is only worth anything if it is looking at something. The four that exist today.
  assert.equal(checked, 4, 'the exclusions that exist are the ones that were reasoned about');
  assert.deepEqual(choiceExclusions('codex'), ['localProvider']);
  assert.deepEqual(choiceExclusions('pi'), ['thinking']);
  assert.deepEqual(choiceExclusions('agy'), ['mode', 'effort']);
  // Claude and Hermes exclude nothing, and an empty list is an answer: Claude's one select is compared
  // against commander's own `(choices: …)`, and Hermes declares no select at all.
  for (const backend of ['claude', 'hermes']) {
    assert.deepEqual(choiceExclusions(backend), [], `${backend} checks every enum it has`);
  }
});

test('a value the CLI retired is DECLARED by the backend, never spelled by the core (#617)', () => {
  // The rewrite lives in `src/app/settings.js` and reads `retiredChoices` off the descriptor, so the dead
  // value and its replacement are one CLI vocabulary in one CLI folder — the rule in
  // `.claude/rules/backends.md`, applied to a value rather than to an id.
  const approval = codex.configFields.find(f => f.id === 'approvalMode');
  assert.deepEqual(approval.retiredChoices, { 'untrusted': 'on-request', 'on-failure': 'on-request' });
  for (const backend of Object.values(BACKENDS)) {
    for (const f of backend.configFields) {
      for (const alive of Object.values(f.retiredChoices || {})) {
        assert.ok(f.choices.includes(alive), `${backend.id}.${f.id} rewrites onto a choice it does not offer`);
      }
    }
  }
});
