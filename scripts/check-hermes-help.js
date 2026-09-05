#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { findOnPath } = require('../src/backends/file-store');
const hermes = require('../src/backends/hermes');
const { definitionFlags, auditFlags } = require('./managed-flags');

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

/** The option DEFINITIONS in hermes' argparse help — its `options:` block, one group per definition line. */
function extractOptions(help) {
  const groups = [];
  let inOptions = false;
  for (const line of String(help || '').split(/\r?\n/)) {
    if (/^options:\s*$/i.test(line)) { inOptions = true; continue; }
    if (inOptions && /^(Examples:|For more help)/i.test(line)) break;
    if (!inOptions) continue;
    const flags = definitionFlags(line);
    if (flags.length) groups.push(flags);
  }
  return groups;
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

  const groups = extractOptions(help);
  const { advertised, unknown, missing } = auditFlags({ backend: hermes, groups, excluded: AUDITED_EXCLUDED });

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

  console.log(`Hermes help audit passed (${path.basename(exe)}; ${advertised.length} top-level options).`);
}

main();
