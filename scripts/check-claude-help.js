#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { findOnPath } = require('../src/backends/file-store');
const claude = require('../src/backends/claude');
const { definitionFlags, auditFlags } = require('./managed-flags');

// What this app SENDS is derived from the descriptor, never listed here (#548) — see managed-flags.js.
// It covers `buildLaunch` (every option, every launch shape) and `buildLiveBinding`'s `--settings`.

// The one flag the CORE puts on Claude's command line rather than the descriptor: app/terminal/spawn.js
// appends it after starting the MCP bridge, gated on the claude binary, because the bridge speaks Claude's
// own protocol. It cannot be derived from the descriptor, so it is named here — with its reason, like
// every other entry in this file.
const SENT_ELSEWHERE = new Set(['--ide']);

const AUDITED_EXCLUDED = new Set([
  // #537, one decision each. The test every flag has to pass is whether it changes what an INTERACTIVE
  // session does — that is the only kind Switchboard spawns.
  //
  // Only meaningful with `--print`, which this app never runs.
  '--permission-prompts',
  // #537. A cloud session is not a session this app can follow: there is no local transcript for the scan
  // to find, adopt or resume, so offering it would produce a tab that goes nowhere.
  '--cloud',
  '--environment',
  '--teleport',
  // #537. This one DOES change an interactive session, so it passes the test the others fail — it is
  // excluded for the other reason: nobody here has watched what it does. And its default is not simply the
  // CLI's recommendation, which is what an earlier version of this comment claimed: the help recommends
  // `on` and says `--append-system-prompt` turns it off. Measure the interaction before offering a switch
  // for it — and see `--append-system-prompt` below, which is excluded because of this one.
  '--system-prompt-snapshot',
  '--agent',
  '--agents',
  '--allow-dangerously-skip-permissions',
  '--allowed-tools',
  '--allowedTools',
  // #562. `buildLaunch` honoured this one for months with nothing declaring it: the schedule creator set
  // it by hand, #246 removed that feature, and the branch stayed. Declaring it instead was the other way
  // out and this is why it was not taken — passing it turns `--system-prompt-snapshot` off, which is the
  // flag right above, excluded because nobody here has watched what it does. Offering a text field that
  // silently changes how the CLI records and reuses its system prompt is shipping that unmeasured
  // interaction through a different door. Pi declares an option of the same name; its CLI has no snapshot
  // to disturb, so that is not this decision.
  '--append-system-prompt',
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

/** The option DEFINITIONS in Claude's `Options:` block — one group per definition line, prose ignored. */
function extractOptions(help) {
  const groups = [];
  let inOptions = false;
  for (const line of String(help || '').split(/\r?\n/)) {
    if (/^Options:\s*$/i.test(line)) { inOptions = true; continue; }
    if (inOptions && /^Commands:\s*$/i.test(line)) break;
    if (!inOptions) continue;
    const flags = definitionFlags(line);
    if (flags.length) groups.push(flags);
  }
  return groups;
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

  const groups = extractOptions(help);
  const { advertised, unknown, missing } = auditFlags({
    backend: claude, groups, excluded: AUDITED_EXCLUDED, alsoSent: SENT_ELSEWHERE,
  });

  if (unknown.length) {
    console.error('Claude exposes unaudited top-level options:');
    for (const opt of unknown) console.error('  ' + opt);
    console.error('Offer it in src/backends/claude/index.js, or add it to this audit list with the reason.');
    process.exit(1);
  }

  if (missing.length) {
    console.error('Claude no longer takes options this app sends:');
    for (const opt of missing) console.error('  ' + opt);
    console.error('Fix src/backends/claude/index.js (buildLaunch / configFields), docs and tests for the installed Claude CLI.');
    process.exit(1);
  }

  console.log(`Claude help audit passed (${path.basename(exe)}; ${advertised.length} top-level options).`);
}

main();
