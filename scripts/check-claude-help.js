#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { findOnPath } = require('../src/backends/file-store');
const claude = require('../src/backends/claude');
const claudeNative = require('../src/backends/claude-native');
const { optionBlocks, auditFlags, auditChoices, managedFlags } = require('./managed-flags');

// What this app SENDS is derived from the descriptor, never listed here (#548) — see managed-flags.js.
// It covers `buildLaunch` (every option, every launch shape) and `buildLiveBinding`'s `--settings`.
//
// TWO descriptors start this binary: the terminal backend and claude-native, which drives it in print mode
// over a pipe (#660). Both are audited against the one help text — a flag either of them sends is managed,
// and a flag either of them sends that the CLI stopped taking is reported — so this file keeps no list of
// what claude-native sends either.
//
// The audit also asks what a select field's VALUES are worth (#617): a flag that keeps its name while its
// enum loses an entry passes the flag half of this check and kills a session at spawn.

// The one flag the CORE puts on Claude's command line rather than the descriptor: app/terminal/spawn.js
// appends it after starting the MCP bridge, gated on the claude binary, because the bridge speaks Claude's
// own protocol. It cannot be derived from the descriptor, so it is named here — with its reason, like
// every other entry in this file.
const SENT_ELSEWHERE = new Set(['--ide']);

const AUDITED_EXCLUDED = new Set([
  // #537, one decision each. The test every flag has to pass is whether it changes what an INTERACTIVE
  // session does — that is the only kind Switchboard spawns.
  //
  // #537, revisited for #660. claude-native runs `--print`, and answers approvals over the pipe with
  // `--permission-prompt-tool stdio`. This flag is not that: measured on 2.1.283, `--permission-prompts host`
  // on its own refuses every approval on the spot.
  '--permission-prompts',
  // A signed configuration document is set up by whoever administers the Claude install, not chosen per
  // session: the CLI exits at start when it cannot load the document or the document does not cover the
  // model, so a per-session field would be a way to kill a launch with a typo. The help itself points to
  // CLAUDE_CODE_CLIENT_DATA_URL instead, which keeps the URL out of the process list, and a spawned CLI
  // inherits that variable from the environment without this app doing anything.
  '--client-data-url',
  // #537. A cloud session is not a session this app can follow: there is no local transcript for the scan
  // to find, adopt or resume, so offering it would produce a tab that goes nowhere.
  '--cloud',
  '--environment',
  '--teleport',
  // #537. This one DOES change an interactive session, so it passes the test the others fail — it is
  // excluded for the other reason: nobody here has watched what it does. And its default is not simply the
  // CLI's recommendation, which is what an earlier version of this comment claimed: the help recommends
  // `on` and says `--append-system-prompt` turns it off. Measure the interaction before offering a switch
  // for it — and see `--append-system-prompt` below, which is excluded because of this one.
  '--system-prompt-snapshot',
  '--agent',
  '--agents',
  '--allow-dangerously-skip-permissions',
  '--allowed-tools',
  '--allowedTools',
  // #562. `buildLaunch` honoured this one for months with nothing declaring it: the schedule creator set
  // it by hand, #246 removed that feature, and the branch stayed. Declaring it instead was the other way
  // out and this is why it was not taken — passing it turns `--system-prompt-snapshot` off, which is the
  // flag right above, excluded because nobody here has watched what it does. Offering a text field that
  // silently changes how the CLI records and reuses its system prompt is shipping that unmeasured
  // interaction through a different door. Pi declares an option of the same name; its CLI has no snapshot
  // to disturb, so that is not this decision.
  '--append-system-prompt',
  '--ax-screen-reader',
  '--background',
  '--bare',
  '--betas',
  '--bg',
  '--brief',
  '--continue',
  '--debug',
  '--debug-file',
  '--disable-slash-commands',
  '--disallowed-tools',
  '--disallowedTools',
  '--effort',
  '--exclude-dynamic-system-prompt-sections',
  '--fallback-model',
  '--file',
  '--forward-subagent-text',
  '--from-pr',
  '--help',
  '--include-hook-events',
  '--json-schema',
  '--max-budget-usd',
  '--mcp-config',
  '--name',
  '--no-chrome',
  '--no-session-persistence',
  '--plugin-dir',
  '--plugin-url',
  '--prompt-suggestions',
  '--remote-control',
  '--remote-control-session-name-prefix',
  '--safe-mode',
  '--setting-sources',
  '--strict-mcp-config',
  '--system-prompt',
  '--tmux',
  '--tools',
  '--version',
]);

// A select field whose CLI writes its accepted values in PROSE rather than declaring them, so there is
// nothing machine-readable to compare our choices against. Each entry says which field and why — a stale
// one (the field is gone, or the CLI has started declaring its values) is reported, so this cannot quietly
// become a place to silence a finding.
//
// Empty, and that is an answer rather than an omission: Claude's `--permission-mode` prints commander's own
// `(choices: …)` list, so every value the Permission mode field can send is compared against it.
const CHOICES_NOT_ENUMERATED = new Set([]);

// A flag the CLI takes and does not list in `--help`, so the flag half of the audit would call it gone. Each
// entry says where it is sent and how it was confirmed. Stale BOTH ways: one the help starts listing is
// reported, and so is one neither Claude backend sends any more (also held in `npm test`, by
// `test/backend-launch-flags.test.js`, which needs no CLI).
//
// What an entry CANNOT be is proven to exist. The help is the only list the CLI prints, and it leaves these
// out, so the audit has nothing to compare them against — the measurement named in the entry and claude-
// native's version floor (`src/backends/claude-native/version.js`) are what stand in for that check. A CLI
// that drops one of these fails at the launch, not here.
const HIDDEN_BUT_TAKEN = new Set([
  // claude-native's approvals (#660): with `stdio` the CLI asks each approval over the control channel.
  // The help names it only inside the description of `--permission-prompts`; measured working on 2.1.283.
  '--permission-prompt-tool',
]);

/** The option DEFINITIONS in Claude's `Options:` block, each with the description lines that belong to it. */
function extractOptions(help) {
  const lines = [];
  let inOptions = false;
  for (const line of String(help || '').split(/\r?\n/)) {
    if (/^Options:\s*$/i.test(line)) { inOptions = true; continue; }
    if (inOptions && /^Commands:\s*$/i.test(line)) break;
    if (!inOptions) continue;
    lines.push(line);
  }
  return optionBlocks(lines);
}

function main() {
  // Before the CLI is looked for: whether an exemption still exempts anything is a question about this app.
  const sentAtAll = new Set([...managedFlags(claude), ...managedFlags(claudeNative)]);
  const unsentHidden = [...HIDDEN_BUT_TAKEN].filter(f => !sentAtAll.has(f));
  if (unsentHidden.length) {
    console.error('HIDDEN_BUT_TAKEN names flags no Claude backend sends any more:');
    for (const f of unsentHidden) console.error('  ' + f);
    console.error('Take them out of HIDDEN_BUT_TAKEN in this file.');
    process.exit(1);
  }

  const exe = findOnPath('claude');
  if (!exe) {
    console.error('Claude executable not found on PATH.');
    process.exit(2);
  }

  let help;
  try {
    help = execFileSync(exe, ['--help'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  } catch (err) {
    console.error('Could not run claude --help:', err && err.message ? err.message : err);
    process.exit(2);
  }

  const blocks = extractOptions(help);
  const groups = blocks.map(b => b.flags);
  // claude-native first, so the terminal backend's audit counts what IT sends as managed too.
  const native = auditFlags({ backend: claudeNative, groups, excluded: AUDITED_EXCLUDED });
  const sentByNative = new Set([...native.managed, ...HIDDEN_BUT_TAKEN]);
  const terminal = auditFlags({
    backend: claude, groups, excluded: new Set([...AUDITED_EXCLUDED, ...sentByNative]), alsoSent: SENT_ELSEWHERE,
  });
  const advertised = terminal.advertised;
  const unknown = terminal.unknown;
  const missing = [...new Set([...terminal.missing, ...native.missing])].filter(f => !HIDDEN_BUT_TAKEN.has(f)).sort();
  const staleHidden = [...HIDDEN_BUT_TAKEN].filter(f => advertised.includes(f));

  // The VALUES audit runs BEFORE the unaudited-flag report, and the order is deliberate: a dead value kills
  // a session at spawn, while an unaudited flag is a decision somebody still owes. A CLI that grows one
  // flag would otherwise hide every dead value behind it until that decision is made.
  const terminalChoices = auditChoices({ backend: claude, blocks, excluded: CHOICES_NOT_ENUMERATED });
  const nativeChoices = auditChoices({ backend: claudeNative, blocks, excluded: CHOICES_NOT_ENUMERATED });
  const choices = {};
  for (const k of Object.keys(terminalChoices)) choices[k] = [...terminalChoices[k], ...(nativeChoices[k] || [])];

  if (choices.dead.length) {
    console.error('Claude no longer accepts values this app offers:');
    for (const d of choices.dead) console.error(`  ${d.field} = "${d.choice}" (${d.flag} takes: ${d.values.join(', ')})`);
    console.error('Drop the choice in src/backends/claude/index.js and declare what a stored one becomes (retiredChoices).');
    process.exit(1);
  }

  if (choices.unenumerated.length) {
    console.error('Claude declares no possible values for options this app offers a fixed list for:');
    for (const u of choices.unenumerated) console.error(`  ${u.field}: ${u.why}`);
    console.error('Add it to CHOICES_NOT_ENUMERATED in this file with the reason — the audit must not claim coverage it lacks.');
    process.exit(1);
  }

  if (choices.stale.length) {
    console.error('A declaration about this CLI’s values is out of date:');
    for (const s of choices.stale) console.error(`  ${s.field}: ${s.why}`);
    process.exit(1);
  }

  if (staleHidden.length) {
    console.error('The help now lists flags this audit treats as hidden:');
    for (const f of staleHidden) console.error('  ' + f);
    console.error('Take them out of HIDDEN_BUT_TAKEN in this file.');
    process.exit(1);
  }

  if (unknown.length) {
    console.error('Claude exposes unaudited top-level options:');
    for (const opt of unknown) console.error('  ' + opt);
    console.error('Offer it in src/backends/claude/index.js, or add it to this audit list with the reason.');
    process.exit(1);
  }

  if (missing.length) {
    console.error('Claude no longer takes options this app sends:');
    for (const opt of missing) console.error('  ' + opt);
    console.error('Fix src/backends/claude/index.js or src/backends/claude-native/index.js (buildLaunch / configFields), docs and tests for the installed Claude CLI.');
    process.exit(1);
  }

  console.log(`Claude help audit passed (${path.basename(exe)}; ${advertised.length} top-level options, ${choices.checked.length} enum field(s) checked).`);
}

main();
