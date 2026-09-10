#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { findOnPath } = require('../src/backends/file-store');
const agy = require('../src/backends/agy');
const { optionBlocks, auditFlags, auditChoices } = require('./managed-flags');

// What this app SENDS is derived from the descriptor, never listed here (#548) — see managed-flags.js.

const REQUIRED_COMMANDS = new Set(['models', 'plugin']);
const AUDITED_EXCLUDED = new Set([
  // #537. Print mode only — its own help says so, and it requires `--output-format stream-json`.
  // Switchboard runs the TUI.
  '--input-format',
  '--agent',
  '--continue',
  '--dangerously-skip-permissions',
  '--disable-slash-commands',
  '--json-schema',
  '--log-file',
  '--new-project',
  '--output-format',
  '--print',
  '--print-timeout',
  '--project',
  '--prompt',
  '--prompt-interactive',
]);

// A select field whose CLI writes its accepted values in PROSE rather than declaring them, so there is
// nothing machine-readable to compare our choices against. Each entry says which field and why — a stale
// one (the field is gone, or the CLI has started declaring its values) is reported, so this cannot quietly
// become a place to silence a finding.
//
// Both entries are the same fact about agy: its help is Go's `flag` package, which prints a description
// and nothing else. There is no possible-values block to read anywhere in the file.
const CHOICES_NOT_ENUMERATED = new Set([
  // #617. "Set the agent execution mode for this session (accept-edits, plan)" — a sentence, not a
  // declaration. The two names are in it, and taking them out means guessing where a sentence's list ends.
  'mode',
  // #617. "Reasoning effort for the current CLI session (low|medium|high)" — the same, with a different
  // separator, which is the point: there is no format here to rely on.
  'effort',
]);

/** The option DEFINITIONS agy prints before its subcommand list, each with any lines that follow it.
 *  agy puts the description on the SAME line, so the signature cut is what keeps "Short alias for
 *  --continue" from advertising a flag that line does not define. */
function extractOptions(help) {
  const lines = [];
  for (const line of String(help || '').split(/\r?\n/)) {
    if (/^Available subcommands:/i.test(line)) break;
    lines.push(line);
  }
  return optionBlocks(lines);
}

function extractCommands(help) {
  const found = new Set();
  let inCommands = false;
  for (const line of String(help || '').split(/\r?\n/)) {
    if (/^Available subcommands:/i.test(line)) { inCommands = true; continue; }
    if (!inCommands) continue;
    const m = /^\s{2}([a-z][a-z0-9-]*)\s/.exec(line);
    if (m) found.add(m[1]);
  }
  return found;
}

function main() {
  const exe = findOnPath('agy');
  if (!exe) { console.error('agy executable not found on PATH.'); process.exit(2); }
  const res = spawnSync(exe, ['--help'], { encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true });
  if (res.error) { console.error('Could not run agy --help:', res.error.message || res.error); process.exit(2); }
  const help = `${res.stdout || ''}\n${res.stderr || ''}`;

  const commands = extractCommands(help);
  const missingCommands = [...REQUIRED_COMMANDS].filter(c => !commands.has(c));
  if (missingCommands.length) {
    console.error('agy no longer advertises required commands:');
    for (const c of missingCommands) console.error('  ' + c);
    process.exit(1);
  }

  const blocks = extractOptions(help);
  const groups = blocks.map(b => b.flags);
  const { advertised, unknown, missing } = auditFlags({ backend: agy, groups, excluded: AUDITED_EXCLUDED });

  // The VALUES audit runs BEFORE the unaudited-flag report, and the order is deliberate: a dead value kills
  // a session at spawn, while an unaudited flag is a decision somebody still owes. A CLI that grows one
  // flag would otherwise hide every dead value behind it until that decision is made.
  const choices = auditChoices({ backend: agy, blocks, excluded: CHOICES_NOT_ENUMERATED });

  if (choices.dead.length) {
    console.error('agy no longer accepts values this app offers:');
    for (const d of choices.dead) console.error(`  ${d.field} = "${d.choice}" (${d.flag} takes: ${d.values.join(', ')})`);
    console.error('Drop the choice in src/backends/agy/index.js and declare what a stored one becomes (retiredChoices).');
    process.exit(1);
  }

  if (choices.unenumerated.length) {
    console.error('agy declares no possible values for options this app offers a fixed list for:');
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
    console.error('agy exposes unaudited top-level options:');
    for (const opt of unknown) console.error('  ' + opt);
    console.error('Offer it in src/backends/agy/index.js, or add it to this audit list with the reason.');
    process.exit(1);
  }

  if (missing.length) {
    console.error('agy no longer takes options this app sends:');
    for (const opt of missing) console.error('  ' + opt);
    console.error('Fix src/backends/agy/index.js (buildLaunch / configFields), docs and tests for the installed agy CLI.');
    process.exit(1);
  }

  console.log(`agy help audit passed (${path.basename(exe)}; ${commands.size} commands, ${advertised.length} top-level options, ${choices.checked.length} enum field(s) checked).`);
}

main();
