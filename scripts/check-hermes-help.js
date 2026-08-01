#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { findOnPath } = require('../src/backends/file-store');

const MANAGED = new Set([
  '--model',
  '--provider',
  '--toolsets',
  '--resume',
  '--worktree',
  '--accept-hooks',
  '--skills',
  '--yolo',
  '--pass-session-id',
  '--ignore-user-config',
  '--ignore-rules',
  '--safe-mode',
]);

const AUDITED_EXCLUDED = new Set([
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

function extractOptions(help) {
  const found = new Set();
  let inOptions = false;
  for (const line of String(help || '').split(/\r?\n/)) {
    if (/^options:\s*$/i.test(line)) { inOptions = true; continue; }
    if (inOptions && /^(Examples:|For more help)/i.test(line)) break;
    if (!inOptions) continue;
    for (const match of line.matchAll(/--[a-z0-9][a-z0-9-]*/gi)) found.add(match[0]);
  }
  return [...found].sort();
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

  const options = extractOptions(help);
  const unknown = options.filter(opt => !MANAGED.has(opt) && !AUDITED_EXCLUDED.has(opt));
  if (unknown.length) {
    console.error('Hermes exposes unaudited top-level options:');
    for (const opt of unknown) console.error('  ' + opt);
    console.error('Update src/backends/hermes/index.js and this audit list, or document why the option stays excluded.');
    process.exit(1);
  }

  const missing = [...MANAGED].filter(opt => !options.includes(opt));
  if (missing.length) {
    console.error('Hermes no longer advertises managed options:');
    for (const opt of missing) console.error('  ' + opt);
    console.error('Update src/backends/hermes/index.js, docs, and tests for the installed Hermes CLI.');
    process.exit(1);
  }

  console.log(`Hermes help audit passed (${path.basename(exe)}; ${options.length} top-level options).`);
}

main();
