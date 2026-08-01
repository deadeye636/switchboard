#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { findOnPath } = require('../src/backends/file-store');

const REQUIRED_COMMANDS = new Set(['install', 'remove', 'uninstall', 'update', 'list', 'config', 'auth']);
const MANAGED = new Set([
  '--provider',
  '--model',
  '--append-system-prompt',
  '--session',
  '--fork',
  '--name',
  '--models',
  '--no-tools',
  '--no-builtin-tools',
  '--tools',
  '--exclude-tools',
  '--thinking',
  '--no-context-files',
  '--list-models',
  '--approve',
  '--no-approve',
  '--offline',
]);
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
  '--extension',
  '--no-extensions',
  '--skill',
  '--no-skills',
  '--prompt-template',
  '--no-prompt-templates',
  '--theme',
  '--no-themes',
  '--export',
  '--verbose',
  '--help',
  '--version',
]);

function extractOptions(help) {
  const found = new Set();
  let inOptions = false;
  for (const raw of String(help || '').split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    if (/^Options:\s*$/i.test(line.trim())) { inOptions = true; continue; }
    if (inOptions && /^(Extensions can register|Extensions|Examples|Environment Variables|Built-in Tool Names)[:\s]/i.test(line.trim())) break;
    if (!inOptions) continue;
    for (const match of line.matchAll(/--[a-z0-9][a-z0-9-]*/gi)) found.add(match[0]);
  }
  return [...found].sort();
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

  const options = extractOptions(help);
  const unknown = options.filter(opt => !MANAGED.has(opt) && !AUDITED_EXCLUDED.has(opt));
  if (unknown.length) {
    console.error('Pi exposes unaudited top-level options:');
    for (const opt of unknown) console.error('  ' + opt);
    console.error('Update src/backends/pi/index.js and this audit list, or document why the option stays excluded.');
    process.exit(1);
  }

  const missing = [...MANAGED].filter(opt => !options.includes(opt));
  if (missing.length) {
    console.error('Pi no longer advertises managed options:');
    for (const opt of missing) console.error('  ' + opt);
    process.exit(1);
  }

  console.log(`Pi help audit passed (${path.basename(exe)}; ${commands.size} commands, ${options.length} top-level options).`);
}

main();
