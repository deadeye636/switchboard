#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { findOnPath } = require('../src/backends/file-store');

const REQUIRED_COMMANDS = new Set(['resume', 'fork']);
const MANAGED = new Set([
  '--config',
  '--model',
  '--oss',
  '--local-provider',
  '--profile',
  '--sandbox',
  '--add-dir',
  '--ask-for-approval',
  '--search',
]);
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

function extractOptions(help) {
  const found = new Set();
  let inOptions = false;
  for (const line of String(help || '').split(/\r?\n/)) {
    if (/^Options:\s*$/i.test(line)) { inOptions = true; continue; }
    if (!inOptions) continue;
    for (const match of line.matchAll(/--[a-z0-9][a-z0-9-]*/gi)) found.add(match[0]);
  }
  return [...found].sort();
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

  const options = extractOptions(help);
  const unknown = options.filter(opt => !MANAGED.has(opt) && !AUDITED_EXCLUDED.has(opt));
  if (unknown.length) {
    console.error('Codex exposes unaudited top-level options:');
    for (const opt of unknown) console.error('  ' + opt);
    console.error('Update src/backends/codex/index.js and this audit list, or document why the option stays excluded.');
    process.exit(1);
  }

  const missing = [...MANAGED].filter(opt => !options.includes(opt));
  if (missing.length) {
    console.error('Codex no longer advertises managed options:');
    for (const opt of missing) console.error('  ' + opt);
    process.exit(1);
  }

  console.log(`Codex help audit passed (${path.basename(exe)}; ${commands.size} commands, ${options.length} top-level options).`);
}

main();
