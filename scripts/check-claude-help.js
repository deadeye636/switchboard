#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { findOnPath } = require('../src/backends/file-store');

const MANAGED = new Set([
  // #537: two flags that change an interactive session, so they are offered rather than audited away.
  '--restricted',
  '--autocompact',
  '--add-dir',
  '--append-system-prompt',
  '--chrome',
  '--dangerously-skip-permissions',
  '--fork-session',
  '--ide',
  '--model',
  '--permission-mode',
  '--resume',
  '--session-id',
  '--settings',
  '--worktree',
]);

const AUDITED_EXCLUDED = new Set([
  // #537, one decision each. The test every flag has to pass is whether it changes what an INTERACTIVE
  // session does — that is the only kind Switchboard spawns.
  //
  // Only meaningful with `--print`, which this app never runs. (`--permission-prompt-tool` is not a flag
  // of its own here — it appears inside `--permission-prompts`' description text and the extractor below
  // scrapes every `--word` it sees. It is listed so the audit passes; the entry describes the extractor,
  // not the CLI.)
  '--permission-prompts',
  '--permission-prompt-tool',
  // #537. A cloud session is not a session this app can follow: there is no local transcript for the scan
  // to find, adopt or resume, so offering it would produce a tab that goes nowhere.
  '--cloud',
  '--environment',
  '--teleport',
  // #537. This one DOES change an interactive session, so it passes the test the others fail — it is
  // excluded for the other reason: nobody here has watched what it does. And its default is not simply the
  // CLI's recommendation, which is what an earlier version of this comment claimed: the help recommends
  // `on` and says `--append-system-prompt` turns it off, which this backend sends whenever that option is
  // set. Measure the interaction before offering a switch for it.
  '--system-prompt-snapshot',
  '--agent',
  '--agents',
  '--allow-dangerously-skip-permissions',
  '--allowed-tools',
  '--allowedTools',
  '--ax-screen-reader',
  '--background',
  '--bare',
  '--betas',
  '--bg',
  '--brief',
  '--continue',
  '--debug',
  '--debug-file',
  '--disable-slash-commands',
  '--disallowed-tools',
  '--disallowedTools',
  '--effort',
  '--exclude-dynamic-system-prompt-sections',
  '--fallback-model',
  '--file',
  '--forward-subagent-text',
  '--from-pr',
  '--help',
  '--include-hook-events',
  '--include-partial-messages',
  '--input-format',
  '--json-schema',
  '--max-budget-usd',
  '--mcp-config',
  '--name',
  '--no-chrome',
  '--no-session-persistence',
  '--output-format',
  '--plugin-dir',
  '--plugin-url',
  '--print',
  '--prompt-suggestions',
  '--remote-control',
  '--remote-control-session-name-prefix',
  '--replay-user-messages',
  '--safe-mode',
  '--setting-sources',
  '--strict-mcp-config',
  '--system-prompt',
  '--tmux',
  '--tools',
  '--verbose',
  '--version',
]);

function extractOptions(help) {
  const found = new Set();
  let inOptions = false;
  for (const line of String(help || '').split(/\r?\n/)) {
    if (/^Options:\s*$/i.test(line)) { inOptions = true; continue; }
    if (inOptions && /^Commands:\s*$/i.test(line)) break;
    if (!inOptions) continue;
    for (const match of line.matchAll(/--[a-z0-9][a-z0-9-]*/gi)) found.add(match[0]);
  }
  return [...found].sort();
}

function main() {
  const exe = findOnPath('claude');
  if (!exe) {
    console.error('Claude executable not found on PATH.');
    process.exit(2);
  }

  let help;
  try {
    help = execFileSync(exe, ['--help'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  } catch (err) {
    console.error('Could not run claude --help:', err && err.message ? err.message : err);
    process.exit(2);
  }

  const options = extractOptions(help);
  const unknown = options.filter(opt => !MANAGED.has(opt) && !AUDITED_EXCLUDED.has(opt));
  if (unknown.length) {
    console.error('Claude exposes unaudited top-level options:');
    for (const opt of unknown) console.error('  ' + opt);
    console.error('Update src/backends/claude/index.js and this audit list, or document why the option stays excluded.');
    process.exit(1);
  }

  const missing = [...MANAGED].filter(opt => !options.includes(opt));
  if (missing.length) {
    console.error('Claude no longer advertises managed options:');
    for (const opt of missing) console.error('  ' + opt);
    console.error('Update src/backends/claude/index.js, docs, and tests for the installed Claude CLI.');
    process.exit(1);
  }

  console.log(`Claude help audit passed (${path.basename(exe)}; ${options.length} top-level options).`);
}

main();
