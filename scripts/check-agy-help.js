#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { findOnPath } = require('../src/backends/file-store');

const REQUIRED_COMMANDS = new Set(['models', 'plugin']);
const MANAGED = new Set([
  '--add-dir',
  '--conversation',
  '--effort',
  '--mode',
  '--model',
  '--sandbox',
]);
const AUDITED_EXCLUDED = new Set([
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

function extractOptions(help) {
  const found = new Set();
  for (const line of String(help || '').split(/\r?\n/)) {
    if (/^Available subcommands:/i.test(line)) break;
    for (const match of line.matchAll(/--[a-z0-9][a-z0-9-]*/gi)) found.add(match[0]);
  }
  return [...found].sort();
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

  const options = extractOptions(help);
  const unknown = options.filter(opt => !MANAGED.has(opt) && !AUDITED_EXCLUDED.has(opt));
  if (unknown.length) {
    console.error('agy exposes unaudited top-level options:');
    for (const opt of unknown) console.error('  ' + opt);
    console.error('Update src/backends/agy/index.js and this audit list, or document why the option stays excluded.');
    process.exit(1);
  }

  const missing = [...MANAGED].filter(opt => !options.includes(opt));
  if (missing.length) {
    console.error('agy no longer advertises managed options:');
    for (const opt of missing) console.error('  ' + opt);
    process.exit(1);
  }

  console.log(`agy help audit passed (${path.basename(exe)}; ${commands.size} commands, ${options.length} top-level options).`);
}

main();
