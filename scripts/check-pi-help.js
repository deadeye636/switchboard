#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { findOnPath } = require('../src/backends/file-store');
const pi = require('../src/backends/pi');
const { optionBlocks, auditFlags, auditChoices } = require('./managed-flags');

// What this app SENDS is derived from the descriptor, never listed here (#548) — see managed-flags.js.
// The derivation found one Pi flag the hand-written list had on the wrong side: `--extension`, which
// `buildLiveBinding` puts on every Pi launch, sat in the EXCLUDED set below.

const REQUIRED_COMMANDS = new Set(['install', 'remove', 'uninstall', 'update', 'list', 'config', 'auth']);

// Not a launch flag: `listModels()` runs `pi --list-models` as a PROBE to fill the model picker
// (backends/pi/index.js). It is still a flag this app sends, so it is audited — it just cannot come from
// a launch the descriptor builds.
const SENT_ELSEWHERE = new Set(['--list-models']);

const AUDITED_EXCLUDED = new Set([
  '--api-key',
  '--system-prompt',
  '--mode',
  '--print',
  '--continue',
  '--resume',
  '--session-id',
  '--session-dir',
  '--no-session',
  '--no-extensions',
  '--skill',
  '--no-skills',
  '--prompt-template',
  '--no-prompt-templates',
  '--theme',
  '--no-themes',
  // #537. `--tui-mode fullscreen` changes how the TUI drives the PTY it is given, and Switchboard's
  // terminal owns that surface — scrollback, resize, the selection layer. Unmeasured in an embedded
  // terminal, so it is not offered: a control whose effect nobody has watched is worse than none.
  '--tui-mode',
  '--export',
  '--verbose',
  '--help',
  '--version',
]);

// A select field whose CLI writes its accepted values in PROSE rather than declaring them, so there is
// nothing machine-readable to compare our choices against. Each entry says which field and why — a stale
// one (the field is gone, or the CLI has started declaring its values) is reported, so this cannot quietly
// become a place to silence a finding.
const CHOICES_NOT_ENUMERATED = new Set([
  // #617. Pi's help writes the levels into the description sentence — "Set thinking level: off, minimal,
  // low, medium, high, xhigh, max" — and declares no enum of its own. The seven names happen to be the
  // seven this field offers, but taking them out of a sentence means guessing where the list ends, and a
  // guess here either invents a dead value or hides a real one. Revisit when Pi declares them.
  'thinking',
]);

/** The option DEFINITIONS in Pi's `Options:` block, each with the description lines that belong to it. */
function extractOptions(help) {
  const lines = [];
  let inOptions = false;
  for (const raw of String(help || '').split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    if (/^Options:\s*$/i.test(line.trim())) { inOptions = true; continue; }
    if (inOptions && /^(Extensions can register|Extensions|Examples|Environment Variables|Built-in Tool Names)[:\s]/i.test(line.trim())) break;
    if (!inOptions) continue;
    lines.push(line);
  }
  return optionBlocks(lines);
}

function extractCommands(help) {
  const found = new Set();
  let inCommands = false;
  for (const raw of String(help || '').split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    if (/^Commands:\s*$/i.test(line.trim())) { inCommands = true; continue; }
    if (inCommands && /^Options:\s*$/i.test(line.trim())) break;
    if (!inCommands) continue;
    const m = /^\s*pi\s+([a-z][a-z0-9-]*)\b/.exec(line);
    if (m) found.add(m[1]);
  }
  return found;
}

function piCommand(exe) {
  if (process.platform === 'win32' && /\.cmd$/i.test(exe)) {
    return { command: 'node', args: [path.join(path.dirname(exe), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')] };
  }
  return { command: exe, args: [] };
}

function main() {
  const exe = findOnPath('pi');
  if (!exe) { console.error('Pi executable not found on PATH.'); process.exit(2); }
  const launch = piCommand(exe);
  let help;
  try { help = execFileSync(launch.command, [...launch.args, '--help'], { encoding: 'utf8', maxBuffer: 1024 * 1024 }); }
  catch (err) { console.error('Could not run pi --help:', err?.message || err); process.exit(2); }

  const commands = extractCommands(help);
  const missingCommands = [...REQUIRED_COMMANDS].filter(c => !commands.has(c));
  if (missingCommands.length) {
    console.error('Pi no longer advertises expected resource commands:');
    for (const c of missingCommands) console.error('  ' + c);
    process.exit(1);
  }

  const blocks = extractOptions(help);
  const groups = blocks.map(b => b.flags);
  const { advertised, unknown, missing } = auditFlags({
    backend: pi, groups, excluded: AUDITED_EXCLUDED, alsoSent: SENT_ELSEWHERE,
  });

  // The VALUES audit runs BEFORE the unaudited-flag report, and the order is deliberate: a dead value kills
  // a session at spawn, while an unaudited flag is a decision somebody still owes. A CLI that grows one
  // flag would otherwise hide every dead value behind it until that decision is made.
  const choices = auditChoices({ backend: pi, blocks, excluded: CHOICES_NOT_ENUMERATED });

  if (choices.dead.length) {
    console.error('Pi no longer accepts values this app offers:');
    for (const d of choices.dead) console.error(`  ${d.field} = "${d.choice}" (${d.flag} takes: ${d.values.join(', ')})`);
    console.error('Drop the choice in src/backends/pi/index.js and declare what a stored one becomes (retiredChoices).');
    process.exit(1);
  }

  if (choices.unenumerated.length) {
    console.error('Pi declares no possible values for options this app offers a fixed list for:');
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
    console.error('Pi exposes unaudited top-level options:');
    for (const opt of unknown) console.error('  ' + opt);
    console.error('Offer it in src/backends/pi/index.js, or add it to this audit list with the reason.');
    process.exit(1);
  }

  if (missing.length) {
    console.error('Pi no longer takes options this app sends:');
    for (const opt of missing) console.error('  ' + opt);
    console.error('Fix src/backends/pi/index.js (buildLaunch / configFields), docs and tests for the installed Pi CLI.');
    process.exit(1);
  }

  console.log(`Pi help audit passed (${path.basename(exe)}; ${commands.size} commands, ${advertised.length} top-level options, ${choices.checked.length} enum field(s) checked).`);
}

main();
