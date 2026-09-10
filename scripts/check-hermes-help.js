#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { findOnPath } = require('../src/backends/file-store');
const hermes = require('../src/backends/hermes');
const { optionBlocks, auditFlags, auditChoices } = require('./managed-flags');

// What this app SENDS is derived from the descriptor, never listed here (#548) — see managed-flags.js.
// `hermes --checkpoints` is why: the flag was missing from the CLI and missing from the hand-written list
// at the same time, so this audit compared two things that agreed and stayed green.

const AUDITED_EXCLUDED = new Set([
  // #537. Parsed and then discarded in the modern TUI: `_CHAT_PASSTHROUGH` in hermes' own main.py does not
  // carry `reasoning`, so `_launch_tui` never receives it and only the classic REPL branch reads it.
  // Switchboard passes neither --tui nor --cli, so which branch runs is the user's `display.interface`.
  // An option that does nothing for half the users is the control this issue exists to keep out.
  '--reasoning',
  // #537. Not offered, but the reason is narrower than it first looks and worth writing down: on a NEW
  // session the working directory is already the one Switchboard spawns in, so a second way to say it
  // could only disagree. On a RESUME hermes restores the session's own recorded cwd unless `--in` or
  // `--no-restore-cwd` says otherwise — so the CLI can leave the directory this app launched in, and
  // whether that deserves a control is a question nobody has measured the consequences of yet.
  '--in',
  '--help',
  '--version',
  '--oneshot',
  '--usage-file',
  '--no-restore-cwd',
  '--continue',
  '--tui',
  '--cli',
  '--dev',
]);

// A select field whose CLI writes its accepted values in PROSE rather than declaring them, so there is
// nothing machine-readable to compare our choices against. Each entry says which field and why — a stale
// one (the field is gone, or the CLI has started declaring its values) is reported, so this cannot quietly
// become a place to silence a finding.
//
// Empty because hermes' descriptor declares no select field at all — every option it offers is a text
// field or a toggle, so there is no fixed list of values to check. The audit is wired anyway, so the day
// this backend grows one it is covered without anybody remembering to come back here.
const CHOICES_NOT_ENUMERATED = new Set([]);

/** The option DEFINITIONS in hermes' argparse `options:` block, each with the lines that belong to it. */
function extractOptions(help) {
  const lines = [];
  let inOptions = false;
  for (const line of String(help || '').split(/\r?\n/)) {
    if (/^options:\s*$/i.test(line)) { inOptions = true; continue; }
    if (inOptions && /^(Examples:|For more help)/i.test(line)) break;
    if (!inOptions) continue;
    lines.push(line);
  }
  return optionBlocks(lines);
}

function main() {
  const exe = findOnPath('hermes');
  if (!exe) {
    console.error('Hermes executable not found on PATH.');
    process.exit(2);
  }

  let help;
  try {
    help = execFileSync(exe, ['--help'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  } catch (err) {
    console.error('Could not run hermes --help:', err && err.message ? err.message : err);
    process.exit(2);
  }

  const blocks = extractOptions(help);
  const groups = blocks.map(b => b.flags);
  const { advertised, unknown, missing } = auditFlags({ backend: hermes, groups, excluded: AUDITED_EXCLUDED });

  // The VALUES audit runs BEFORE the unaudited-flag report, and the order is deliberate: a dead value kills
  // a session at spawn, while an unaudited flag is a decision somebody still owes. A CLI that grows one
  // flag would otherwise hide every dead value behind it until that decision is made.
  const choices = auditChoices({ backend: hermes, blocks, excluded: CHOICES_NOT_ENUMERATED });

  if (choices.dead.length) {
    console.error('Hermes no longer accepts values this app offers:');
    for (const d of choices.dead) console.error(`  ${d.field} = "${d.choice}" (${d.flag} takes: ${d.values.join(', ')})`);
    console.error('Drop the choice in src/backends/hermes/index.js and declare what a stored one becomes (retiredChoices).');
    process.exit(1);
  }

  if (choices.unenumerated.length) {
    console.error('Hermes declares no possible values for options this app offers a fixed list for:');
    for (const u of choices.unenumerated) console.error(`  ${u.field}: ${u.why}`);
    console.error('Add it to CHOICES_NOT_ENUMERATED in this file with the reason — the audit must not claim coverage it lacks.');
    process.exit(1);
  }

  if (choices.stale.length) {
    console.error('A declaration about this CLI’s values is out of date:');
    for (const s of choices.stale) console.error(`  ${s.field}: ${s.why}`);
    process.exit(1);
  }

  if (unknown.length) {
    console.error('Hermes exposes unaudited top-level options:');
    for (const opt of unknown) console.error('  ' + opt);
    console.error('Offer it in src/backends/hermes/index.js, or add it to this audit list with the reason.');
    process.exit(1);
  }

  if (missing.length) {
    console.error('Hermes no longer takes options this app sends:');
    for (const opt of missing) console.error('  ' + opt);
    console.error('Fix src/backends/hermes/index.js (buildLaunch / configFields), docs and tests for the installed Hermes CLI.');
    process.exit(1);
  }

  console.log(`Hermes help audit passed (${path.basename(exe)}; ${advertised.length} top-level options, ${choices.checked.length} enum field(s) checked).`);
}

main();
