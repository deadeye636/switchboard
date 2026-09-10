#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { findOnPath } = require('../src/backends/file-store');
const codex = require('../src/backends/codex');
const { optionBlocks, auditFlags, auditChoices } = require('./managed-flags');

// What this app SENDS is derived from the descriptor, never listed here (#548) — see managed-flags.js.
// Codex is the backend that shows why the derivation reads the help's own spellings: buildLaunch sends the
// SHORT forms (`-m`, `-a`, `-s`, `-c`), and each is answered through the long one its definition line
// carries. A CLI that drops `-m` while keeping `--model` fails this check, which is the point.
//
// And Codex is why the audit also asks about VALUES (#617): `--ask-for-approval` never moved, so the flag
// half of this check stayed green while two of the four values the Approval field offered were removed from
// the CLI. Both of them killed the session at spawn.

const REQUIRED_COMMANDS = new Set(['resume', 'fork']);
const AUDITED_EXCLUDED = new Set([
  // #537. Unmeasured: "route approval requests through automatic review using the workspace-write sandbox"
  // describes a reviewer nobody here has watched decide anything, and an option is a promise about what it
  // does. Deliberately NOT excluded on a "we do not offer stop-asking-me" stance — this backend already
  // offers `approvalMode: never` and `sandbox: danger-full-access`, so that argument would be one this
  // file does not itself follow. Revisit with a measurement, not with a principle.
  '--approve-for-me',
  '--enable',
  '--disable',
  '--remote',
  '--remote-auth-token-env',
  '--strict-config',
  '--image',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--cd',
  '--no-alt-screen',
  '--help',
  '--version',
]);

// A select field whose CLI writes its accepted values in PROSE rather than declaring them, so there is
// nothing machine-readable to compare our choices against. Each entry says which field and why — a stale
// one (the field is gone, or the CLI has started declaring its values) is reported, so this cannot quietly
// become a place to silence a finding.
const CHOICES_NOT_ENUMERATED = new Set([
  // #617. `--local-provider`'s help is a sentence — "Specify which local provider to use (lmstudio or
  // ollama). If not specified with --oss, will use config default or show selection" — and clap prints no
  // `[possible values: …]` for it, because the option takes a free-form provider name. Parsing the two out
  // of that sentence would be a guess about prose, and a guess here either invents a dead value or hides a
  // real one.
  'localProvider',
]);

/** The option DEFINITIONS in Codex' `Options:` block, each with the description lines that belong to it. */
function extractOptions(help) {
  const lines = [];
  let inOptions = false;
  for (const line of String(help || '').split(/\r?\n/)) {
    if (/^Options:\s*$/i.test(line)) { inOptions = true; continue; }
    if (!inOptions) continue;
    lines.push(line);
  }
  return optionBlocks(lines);
}

function extractCommands(help) {
  const found = new Set();
  let inCommands = false;
  for (const line of String(help || '').split(/\r?\n/)) {
    if (/^Commands:\s*$/i.test(line)) { inCommands = true; continue; }
    if (inCommands && /^Arguments:\s*$/i.test(line)) break;
    if (!inCommands) continue;
    const m = /^\s{2}([a-z][a-z0-9-]*)\s/.exec(line);
    if (m) found.add(m[1]);
  }
  return found;
}

function codexCommand(exe) {
  if (process.platform === 'win32' && /\.cmd$/i.test(exe)) {
    return { command: 'node', args: [path.join(path.dirname(exe), 'node_modules', '@openai', 'codex', 'bin', 'codex.js')] };
  }
  return { command: exe, args: [] };
}

function main() {
  const exe = findOnPath('codex');
  if (!exe) { console.error('Codex executable not found on PATH.'); process.exit(2); }
  const launch = codexCommand(exe);
  let help;
  try { help = execFileSync(launch.command, [...launch.args, '--help'], { encoding: 'utf8', maxBuffer: 1024 * 1024 }); }
  catch (err) { console.error('Could not run codex --help:', err?.message || err); process.exit(2); }

  const commands = extractCommands(help);
  const missingCommands = [...REQUIRED_COMMANDS].filter(c => !commands.has(c));
  if (missingCommands.length) {
    console.error('Codex no longer advertises required commands:');
    for (const c of missingCommands) console.error('  ' + c);
    process.exit(1);
  }

  const blocks = extractOptions(help);
  const groups = blocks.map(b => b.flags);
  const { advertised, unknown, missing } = auditFlags({ backend: codex, groups, excluded: AUDITED_EXCLUDED });

  // The VALUES audit runs BEFORE the unaudited-flag report, and the order is deliberate: a dead value
  // kills a session at spawn, while an unaudited flag is a decision somebody still owes. This script
  // reports `--worktree` as unaudited today (its own decision, #617 left it alone), so a values check
  // placed after that report would never run at all.
  const choices = auditChoices({ backend: codex, blocks, excluded: CHOICES_NOT_ENUMERATED });

  if (choices.dead.length) {
    console.error('Codex no longer accepts values this app offers:');
    for (const d of choices.dead) console.error(`  ${d.field} = "${d.choice}" (${d.flag} takes: ${d.values.join(', ')})`);
    console.error('Drop the choice in src/backends/codex/index.js and declare what a stored one becomes (retiredChoices).');
    process.exit(1);
  }

  if (choices.unenumerated.length) {
    console.error('Codex declares no possible values for options this app offers a fixed list for:');
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
    console.error('Codex exposes unaudited top-level options:');
    for (const opt of unknown) console.error('  ' + opt);
    console.error('Offer it in src/backends/codex/index.js, or add it to this audit list with the reason.');
    process.exit(1);
  }

  if (missing.length) {
    console.error('Codex no longer takes options this app sends:');
    for (const opt of missing) console.error('  ' + opt);
    console.error('Fix src/backends/codex/index.js (buildLaunch / configFields), docs and tests for the installed Codex CLI.');
    process.exit(1);
  }

  console.log(`Codex help audit passed (${path.basename(exe)}; ${commands.size} commands, ${advertised.length} top-level options, ${choices.checked.length} enum field(s) checked).`);
}

main();
