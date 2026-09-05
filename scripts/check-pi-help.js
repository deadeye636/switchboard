#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { findOnPath } = require('../src/backends/file-store');
const pi = require('../src/backends/pi');
const { definitionFlags, auditFlags } = require('./managed-flags');

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

/** The option DEFINITIONS in Pi's `Options:` block — one group per definition line, prose ignored. */
function extractOptions(help) {
  const groups = [];
  let inOptions = false;
  for (const raw of String(help || '').split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    if (/^Options:\s*$/i.test(line.trim())) { inOptions = true; continue; }
    if (inOptions && /^(Extensions can register|Extensions|Examples|Environment Variables|Built-in Tool Names)[:\s]/i.test(line.trim())) break;
    if (!inOptions) continue;
    const flags = definitionFlags(line);
    if (flags.length) groups.push(flags);
  }
  return groups;
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

  const groups = extractOptions(help);
  const { advertised, unknown, missing } = auditFlags({
    backend: pi, groups, excluded: AUDITED_EXCLUDED, alsoSent: SENT_ELSEWHERE,
  });

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

  console.log(`Pi help audit passed (${path.basename(exe)}; ${commands.size} commands, ${advertised.length} top-level options).`);
}

main();
