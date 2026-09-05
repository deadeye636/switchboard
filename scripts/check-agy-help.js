#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { findOnPath } = require('../src/backends/file-store');
const agy = require('../src/backends/agy');
const { definitionFlags, auditFlags } = require('./managed-flags');

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

/** The option DEFINITIONS agy prints before its subcommand list — one group per definition line.
 *  agy puts the description on the SAME line, so the signature cut is what keeps "Short alias for
 *  --continue" from advertising a flag that line does not define. */
function extractOptions(help) {
  const groups = [];
  for (const line of String(help || '').split(/\r?\n/)) {
    if (/^Available subcommands:/i.test(line)) break;
    const flags = definitionFlags(line);
    if (flags.length) groups.push(flags);
  }
  return groups;
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

  const groups = extractOptions(help);
  const { advertised, unknown, missing } = auditFlags({ backend: agy, groups, excluded: AUDITED_EXCLUDED });

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

  console.log(`agy help audit passed (${path.basename(exe)}; ${commands.size} commands, ${advertised.length} top-level options).`);
}

main();
